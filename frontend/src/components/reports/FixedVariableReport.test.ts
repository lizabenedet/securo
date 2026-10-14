import { describe, expect, it } from 'vitest'
import { categoryStats, labelRange } from './FixedVariableReport'
import type { CategoryTrendItem } from '@/types'

function item(values: number[]): CategoryTrendItem {
  return {
    key: 'rent',
    label: 'Aluguel',
    color: '#000000',
    total: values.reduce((a, b) => a + b, 0),
    group: 'fixed',
    series: values.map((value, i) => ({ date: `2026-0${i + 1}`, value, breakdowns: {}, change: null })),
  }
}

describe('categoryStats', () => {
  it('averages only the closed periods and reports the last closed one', () => {
    // Third period is still running: its 100 stays out of both numbers.
    expect(categoryStats(item([1000, 2000, 100]), 2)).toEqual({ average: 1500, last: 2000 })
  })

  it('counts a month without spending as zero in the average', () => {
    expect(categoryStats(item([600, 0, 300]), 3)).toEqual({ average: 300, last: 300 })
  })
})

describe('labelRange', () => {
  it('spans monthly labels from the first day to the last day of the month', () => {
    expect(labelRange('2026-02', '2026-09')).toEqual({ from: '2026-02-01', to: '2026-09-30' })
  })

  it('spans yearly labels as whole years', () => {
    expect(labelRange('2025', '2026')).toEqual({ from: '2025-01-01', to: '2026-12-31' })
  })

  it('gives up on weekly labels rather than guess', () => {
    expect(labelRange('2026-W10', '2026-W20')).toBeNull()
  })
})
