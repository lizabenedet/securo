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
