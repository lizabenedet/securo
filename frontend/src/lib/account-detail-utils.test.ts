import { describe, expect, it } from 'vitest'

import {
  applyTransactionToBalance,
  excludeMaterializedProjections,
  mergeRunningBalances,
  runningBalanceChartFrom,
  unbilledCycleAnchor,
  unbilledCyclesAfter,
} from './account-detail-utils'

describe('applyTransactionToBalance', () => {
  it('does not change the balance for ignored transactions', () => {
    expect(applyTransactionToBalance(100, {
      amount: 30,
      amount_primary: null,
      currency: 'BRL',
      is_ignored: true,
      source: 'manual',
      type: 'debit',
    }, false, 'BRL')).toBe(100)
  })

  it('uses the selected currency amount for active transactions', () => {
    const transaction = {
      amount: 10,
      amount_primary: 50,
      currency: 'USD',
      is_ignored: false,
      source: 'manual',
      type: 'credit' as const,
    }

    expect(applyTransactionToBalance(100, transaction, false, 'USD')).toBe(110)
    expect(applyTransactionToBalance(100, transaction, true, 'BRL')).toBe(150)
  })

  it('does not treat a missing cross-currency conversion as 1:1', () => {
    const transaction = {
      amount: 13037.13,
      amount_primary: null,
      currency: 'USD',
      is_ignored: false,
      source: 'manual',
      type: 'credit' as const,
    }

    expect(applyTransactionToBalance(8925.76, transaction, true, 'BRL')).toBe(8925.76)
  })

  it('applies an opening balance row when it is inside the visible period', () => {
    expect(applyTransactionToBalance(100, {
      amount: 500,
      amount_primary: null,
      currency: 'BRL',
      is_ignored: false,
      source: 'opening_balance',
      type: 'credit',
    }, false, 'BRL')).toBe(600)
  })
})

describe('excludeMaterializedProjections', () => {
  it('removes only the occurrence already linked and materialized on that date', () => {
    const projections = [
      { recurring_id: 'rec-1', date: '2026-08-25' },
      { recurring_id: 'rec-1', date: '2026-09-25' },
      { recurring_id: 'rec-2', date: '2026-08-25' },
    ]

    const result = excludeMaterializedProjections(projections, [
      { recurring_transaction_id: 'rec-1', date: '2026-08-25' },
      { recurring_transaction_id: null, date: '2026-09-25' },
    ])

    expect(result).toEqual([projections[1], projections[2]])
  })
})

describe('mergeRunningBalances', () => {
  // Real rows as the API sends them: newest first, each with the balance
  // right after it.
  const row = (id: string, date: string, balance: number, balancePrimary: number | null = null) => ({
    id, date, running_balance: balance, running_balance_primary: balancePrimary,
  })
  const projection = (id: string, date: string, amount: number, type: 'debit' | 'credit' = 'debit') => ({
    id, date, amount, amount_primary: null, currency: 'BRL', is_ignored: false, source: 'projected', type,
  })
  const options = { openingBalance: 1000, hasMore: false, usePrimary: false, displayCurrency: 'BRL' }
  const balances = (merged: { id: string; runningBalance: number }[]) =>
    merged.map(({ id, runningBalance }) => [id, runningBalance])

  it('places a projection after the real rows of its date and adds it to later rows', () => {
    const rows = [row('c', '2026-09-20', 700), row('b', '2026-09-10', 900), row('a', '2026-09-10', 950)]

    const merged = mergeRunningBalances(rows, [projection('p', '2026-09-10', 100)], options)

    expect(balances(merged)).toEqual([
      ['c', 600],
      ['p', 800],
      ['b', 900],
      ['a', 950],
    ])
  })

  it('stacks projections dated after the newest row on top of it', () => {
    const rows = [row('a', '2026-09-05', 500)]

    const merged = mergeRunningBalances(rows, [
      projection('p2', '2026-09-28', 50),
      projection('p1', '2026-09-15', 200, 'credit'),
    ], options)

    expect(balances(merged)).toEqual([
      ['p2', 650],
      ['p1', 700],
      ['a', 500],
    ])
  })

  it('starts a projection dated before every row from the opening balance', () => {
    const rows = [row('a', '2026-09-10', 1200)]

    const merged = mergeRunningBalances(rows, [projection('p', '2026-09-02', 100)], options)

    expect(balances(merged)).toEqual([
      ['a', 1100],
      ['p', 900],
    ])
  })

  it('leaves out a projection whose starting row is on a page not loaded yet', () => {
    const rows = [row('b', '2026-09-20', 700), row('a', '2026-09-15', 800)]
    const projections = [projection('p', '2026-09-05', 100)]

    const merged = mergeRunningBalances(rows, projections, { ...options, hasMore: true })

    // The newer rows still count it: it sorts before them either way.
    expect(balances(merged)).toEqual([
      ['b', 600],
      ['a', 700],
    ])

    const older = [...rows, row('z', '2026-09-01', 950)]
    expect(balances(mergeRunningBalances(older, projections, { ...options, hasMore: true }))).toEqual([
      ['b', 600],
      ['a', 700],
      ['p', 850],
      ['z', 950],
    ])
  })

  it('shows projections from the opening balance when the range has no rows', () => {
    const merged = mergeRunningBalances([], [projection('p', '2026-09-10', 100)], options)

    expect(balances(merged)).toEqual([['p', 900]])
    expect(mergeRunningBalances([], [], options)).toEqual([])
  })

  it('reads the primary-currency balance only when the primary currency is shown', () => {
    const rows = [row('a', '2026-09-10', 100, 520)]

    expect(balances(mergeRunningBalances(rows, [], options))).toEqual([['a', 100]])
    expect(balances(mergeRunningBalances(rows, [], { ...options, usePrimary: true }))).toEqual([['a', 520]])
    // An account in the primary currency has no separate primary balance.
    const domestic = [row('a', '2026-09-10', 100)]
    expect(balances(mergeRunningBalances(domestic, [], { ...options, usePrimary: true }))).toEqual([['a', 100]])
  })
})

describe('runningBalanceChartFrom', () => {
  it('keeps a range the endpoint accepts', () => {
    expect(runningBalanceChartFrom('2025-08-01', '2026-10-31')).toBe('2025-08-01')
  })

  it('charts the latest ten years of a longer range', () => {
    expect(runningBalanceChartFrom('2000-01-01', '2026-10-31')).toBe('2016-10-31')
  })

  it('stays inside the cap when the range ends on Feb 29', () => {
    expect(runningBalanceChartFrom('2000-01-01', '2024-02-29')).toBe('2014-03-01')
  })
})

describe('unbilledCycleAnchor', () => {
  it('lands on the day after the newest bill', () => {
    expect(unbilledCycleAnchor('2026-08-12')).toEqual(new Date('2026-08-13T00:00:00'))
  })

  it('reaches the cycle a late bills feed leaves behind', () => {
    // PLATINUM closes on the 5th and is billed on the 12th. The newest bill
    // the provider had published was due 12/08 while the cycle that closed on
    // 04/09 — 94 charges — was still unpublished. Anchoring on the newest bill
    // points inside that closed cycle; anchoring on today (10/09) would point
    // at the one opened on 05/09 and step over it.
    const anchor = unbilledCycleAnchor('2026-08-12')
    expect(anchor >= new Date('2026-08-05T00:00:00')).toBe(true)
    expect(anchor < new Date('2026-09-05T00:00:00')).toBe(true)
  })

  it('crosses a month end', () => {
    expect(unbilledCycleAnchor('2026-01-31')).toEqual(new Date('2026-02-01T00:00:00'))
  })
})

describe('unbilledCyclesAfter', () => {
  // PLATINUM: closes on the 5th, billed on the 12th. On 2026-09-10 the newest
  // bill the provider had published was due 12/08, while the cycle that closed
  // on 04/09 — 94 charges — had no bill row yet.
  const CLOSE_DAY = 5

  it('reaches the closed cycle the bills feed has not published', () => {
    expect(unbilledCyclesAfter(CLOSE_DAY, '2026-08-12', '2026-09-10')).toEqual([
      { start: '2026-08-05', end: '2026-09-04' },
      { start: '2026-09-05', end: '2026-10-04' },
    ])
  })

  it('offers that cycle first, since it is the bill about to be paid', () => {
    const [first] = unbilledCyclesAfter(CLOSE_DAY, '2026-08-12', '2026-09-10')
    expect(first).toEqual({ start: '2026-08-05', end: '2026-09-04' })
  })

  it('is a single cycle while the feed is caught up', () => {
    expect(unbilledCyclesAfter(CLOSE_DAY, '2026-09-12', '2026-09-20')).toEqual([
      { start: '2026-09-05', end: '2026-10-04' },
    ])
  })

  it('never returns nothing, even with a bill due in the future', () => {
    expect(unbilledCyclesAfter(CLOSE_DAY, '2026-10-12', '2026-09-10')).toEqual([
      { start: '2026-10-05', end: '2026-11-04' },
    ])
  })

  it('walks month by month when the feed is far behind', () => {
    const cycles = unbilledCyclesAfter(CLOSE_DAY, '2026-05-12', '2026-09-10')
    expect(cycles.map(c => c.start)).toEqual([
      '2026-05-05', '2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05',
    ])
  })
})
