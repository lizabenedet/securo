import { describe, expect, it } from 'vitest'
import { assetValue, cashNowAssets } from './cash-now'
import type { Asset } from '@/types'

function asset(overrides: Partial<Asset>): Asset {
  return {
    id: 'a1', user_id: 'u', name: 'Cofrinho MP', type: 'investment', currency: 'BRL',
    units: null, valuation_method: 'manual', purchase_date: null, purchase_price: null,
    sell_date: null, sell_price: null, growth_type: null, growth_rate: null,
    growth_frequency: null, growth_start_date: null, is_archived: false, position: 0,
    current_value: 10196.27, current_value_primary: 10196.27, gain_loss: null,
    gain_loss_primary: null, value_count: 1, source: 'manual', connection_id: null,
    isin: null, maturity_date: null, group_id: null,
    ...overrides,
  } as Asset
}

describe('cashNowAssets', () => {
  it('counts an investment that is still held', () => {
    expect(cashNowAssets([asset({})], null).map((a) => a.name)).toEqual(['Cofrinho MP'])
  })

  it('leaves out a house or a car: worth something, but not cash', () => {
    const house = asset({ id: 'h', name: 'Casa', type: 'real_estate' })
    const car = asset({ id: 'c', name: 'Carro', type: 'vehicle' })
    expect(cashNowAssets([house, car], null)).toEqual([])
  })

  it('leaves out what was sold, archived or is worth nothing', () => {
    const sold = asset({ id: 's', sell_date: '2026-08-01' })
    const archived = asset({ id: 'r', is_archived: true })
    const empty = asset({ id: 'e', current_value: 0, current_value_primary: 0 })
    expect(cashNowAssets([sold, archived, empty], null)).toEqual([])
  })

  it('keeps to the active collection wallets', () => {
    const inWallet = asset({ id: 'in', group_id: 'w1' })
    const elsewhere = asset({ id: 'out', group_id: 'w2' })
    const loose = asset({ id: 'loose', group_id: null })
    expect(cashNowAssets([inWallet, elsewhere, loose], ['w1']).map((a) => a.id)).toEqual(['in'])
  })

  it('handles no assets at all', () => {
    expect(cashNowAssets(undefined, null)).toEqual([])
  })
})

describe('assetValue', () => {
  it('prefers the converted value and falls back to the asset currency', () => {
    expect(assetValue(asset({ current_value: 100, current_value_primary: 540 }))).toBe(540)
    expect(assetValue(asset({ current_value: 100, current_value_primary: null }))).toBe(100)
  })
})
