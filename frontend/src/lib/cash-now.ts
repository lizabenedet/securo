import type { Asset } from '@/types'

/** The assets the dashboard counts as cash: investments that are still held.
 *
 *  "Cash now" is what could be spent without waiting on anything: the
 *  checking and savings accounts plus money parked in an investment, like a
 *  Mercado Pago cofrinho, which comes back the same day. A house or a car is
 *  worth something but is not cash, so only `investment` counts. Card debt is
 *  deliberately left out: net worth already subtracts it, and this number
 *  exists to answer the question net worth does not.
 *
 *  `walletIds` is the active Collection's wallets, as on the Assets page:
 *  null means every asset, a list means only the assets in those wallets. */
export function cashNowAssets(
  assets: Asset[] | undefined,
  walletIds: string[] | null | undefined,
): Asset[] {
  const allowed = walletIds ? new Set(walletIds) : null
  return (assets ?? []).filter((a) =>
    a.type === 'investment'
    && !a.is_archived
    && !a.sell_date
    && (allowed === null || (a.group_id !== null && allowed.has(a.group_id)))
    && assetValue(a) > 0,
  )
}

/** The asset's value in the primary currency when the API converted it,
 *  otherwise in its own. */
export function assetValue(asset: Asset): number {
  return Number(asset.current_value_primary ?? asset.current_value ?? 0)
}
