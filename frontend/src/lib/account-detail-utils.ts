import { format } from 'date-fns'

import type { ProjectedTransaction, Transaction } from '../types'

type BalanceTransaction = Pick<
  Transaction,
  'amount' | 'amount_primary' | 'currency' | 'is_ignored' | 'source' | 'type'
>

type MaterializedTransaction = Pick<Transaction, 'date' | 'recurring_transaction_id'>

/** Return the usable amount in the selected currency, or null if FX is unknown. */
export function transactionAmountForBalance(
  transaction: BalanceTransaction,
  usePrimary: boolean,
  displayCurrency: string,
): number | null {
  if (
    usePrimary
    && transaction.amount_primary == null
    && transaction.currency !== displayCurrency
  ) return null

  return usePrimary && transaction.amount_primary != null
    ? Number(transaction.amount_primary)
    : Number(transaction.amount)
}

/** Apply one transaction to a running balance using Account Detail semantics. */
export function applyTransactionToBalance(
  balance: number,
  transaction: BalanceTransaction,
  usePrimary: boolean,
  displayCurrency: string,
): number {
  if (transaction.is_ignored) return balance

  // A missing cross-currency conversion is unknown, not a 1:1 rate. Keep the
  // running balance unchanged until the transaction has a real FX stamp.
  const amount = transactionAmountForBalance(transaction, usePrimary, displayCurrency)
  if (amount == null) return balance
  return balance + (transaction.type === 'credit' ? amount : -amount)
}

/**
 * Hide virtual occurrences that already have a materialized transaction.
 * The recurring link plus the effective occurrence date is authoritative;
 * description and amount can legitimately change after materialization.
 */
export function excludeMaterializedProjections<
  T extends Pick<ProjectedTransaction, 'date' | 'recurring_id'>,
>(
  projections: T[],
  transactions: MaterializedTransaction[],
): T[] {
  const materialized = new Set(
    transactions
      .filter((transaction) => transaction.recurring_transaction_id != null)
      .map((transaction) => `${transaction.recurring_transaction_id}:${transaction.date}`),
  )

  return projections.filter(
    (projection) => !materialized.has(`${projection.recurring_id}:${projection.date}`),
  )
}

/**
 * The day to anchor the first cycle the provider has not billed yet.
 *
 * Stepping forward past the newest known bill used to jump to the cycle
 * containing today, which is only the same thing while the bills feed is
 * caught up. A card closing on the 5th and billed on the 12th spends that
 * week with a closed cycle the provider has not published: anchoring on today
 * lands on the cycle that opened on the 5th and steps clean over the closed
 * one, so a month of charges sits behind an arrow that skips it.
 *
 * Anchoring on the day after the newest bill instead makes every forward step
 * advance exactly one cycle. When the feed is caught up, the day after the
 * newest bill is inside the cycle holding today and nothing changes.
 */
export function unbilledCycleAnchor(newestBillDueDate: string): Date {
  const anchor = new Date(newestBillDueDate + 'T00:00:00')
  anchor.setDate(anchor.getDate() + 1)
  return anchor
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

export function creditCardCycleBoundaries(
  closeDay: number | null | undefined,
  reference: Date,
): { start: string; end: string } {
  if (!closeDay) {
    const y = reference.getFullYear()
    const m = reference.getMonth()
    return {
      start: format(new Date(y, m - 1, 1), 'yyyy-MM-dd'),
      end: format(reference, 'yyyy-MM-dd'),
    }
  }
  const ref0 = new Date(reference)
  ref0.setHours(0, 0, 0, 0)
  const y = ref0.getFullYear()
  const m = ref0.getMonth()
  const clamp = (yy: number, mm: number) => Math.min(closeDay, daysInMonth(yy, mm))
  // The cycle containing `reference` ends the day before the next close date
  // strictly after `reference`.
  const thisMonthClose = new Date(y, m, clamp(y, m))
  let nextClose: Date
  if (thisMonthClose.getTime() > ref0.getTime()) {
    nextClose = thisMonthClose
  } else {
    const nextY = m === 11 ? y + 1 : y
    const nextM = m === 11 ? 0 : m + 1
    nextClose = new Date(nextY, nextM, clamp(nextY, nextM))
  }
  const end = new Date(nextClose)
  end.setDate(end.getDate() - 1)
  // Start = the previous close day (the close day itself opens a new cycle).
  const prevY = nextClose.getMonth() === 0 ? nextClose.getFullYear() - 1 : nextClose.getFullYear()
  const prevM = nextClose.getMonth() === 0 ? 11 : nextClose.getMonth() - 1
  const start = new Date(prevY, prevM, clamp(prevY, prevM))
  return {
    start: format(start, 'yyyy-MM-dd'),
    end: format(end, 'yyyy-MM-dd'),
  }
}

/**
 * Every cycle after the provider's newest bill, up to and including the one
 * holding `today`.
 *
 * Usually one — the cycle in progress. Two while the bills feed lags: a card
 * closing on the 5th and billed on the 12th spends that week with a closed
 * cycle nobody has published, and the three places that used to ask for "the
 * cycle containing today" each stepped over it. The account page opened on
 * October, the strip drew August then October, and the forward arrow jumped
 * the same gap — a closed month of charges with no way to reach it.
 */
export function unbilledCyclesAfter(
  closeDay: number,
  newestBillDueDate: string,
  today: string,
): { start: string; end: string }[] {
  const cycles: { start: string; end: string }[] = []
  let reference = unbilledCycleAnchor(newestBillDueDate)
  // Bounded: a feed a year behind is a sync problem, not a strip to draw.
  for (let guard = 0; guard < 12; guard++) {
    const cycle = creditCardCycleBoundaries(closeDay, reference)
    cycles.push(cycle)
    if (cycle.end >= today) break
    reference = new Date(cycle.end + 'T00:00:00')
    reference.setDate(reference.getDate() + 1)
  }
  return cycles
}
