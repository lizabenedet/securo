export function getAccountName(account: { name: string; display_name?: string | null }): string {
  return account.display_name ?? account.name
}

/**
 * Return a presentation-only copy ordered by the name users see.
 * The input is never mutated, which keeps React Query's cached account list intact.
 */
export function sortAccountsByDisplayName<
  T extends { name: string; display_name?: string | null },
>(accounts: readonly T[]): T[] {
  return [...accounts].sort((left, right) =>
    getAccountName(left).localeCompare(getAccountName(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )
}

/**
 * The number to show on an account row.
 *
 * For a credit card that is the invoice currently building, not the balance:
 * a connected card's `current_balance` is the provider's used credit limit, so
 * it carries installments no invoice has charged yet and reads several hundred
 * above what the bank app shows. Aggregations (net worth, the sidebar total)
 * deliberately keep using `current_balance` — the full liability is the right
 * number to subtract from what you own.
 *
 * Falls back to `current_balance` when there is no bill figure: a card whose
 * cycle days are unknown, or whose current cycle has no activity yet and whose
 * debt is therefore a closed bill still unpaid.
 *
 * Both are signed the same way (negative is owed), so callers need no sign
 * handling of their own.
 */
export function getAccountRowAmount(account: {
  type: string
  current_balance: number
  current_bill_amount?: number | null
}): number {
  if (account.type === 'credit_card' && account.current_bill_amount != null) {
    return Number(account.current_bill_amount)
  }
  return Number(account.current_balance)
}

/**
 * The bank's identifier for an account, masked to its last 4 chars, e.g. "•••• 1234".
 *
 * Banks commonly report every account under the same label (often the holder's
 * name), so this is what tells two of them apart. Null when the provider gave us
 * no identifier, so callers render nothing rather than an empty mask. Locale-neutral
 * by construction: dots and the bank's own digits, nothing to translate.
 */
export function formatAccountMask(account: { masked_number?: string | null }): string | null {
  return account.masked_number ? `•••• ${account.masked_number}` : null
}

/**
 * Account name with its mask appended, e.g. "Checking •••• 1234", for compact
 * single-line surfaces such as the account <select> options, where there is no
 * room for a secondary line. When the account has an explicit display_name, the
 * mask is omitted since the user-chosen label already distinguishes it.
 */
export function getAccountLabel(account: {
  name: string
  display_name?: string | null
  masked_number?: string | null
}): string {
  const name = getAccountName(account)
  // When the account has an explicit display_name the user set, it already
  // distinguishes this account from others so the mask suffix is redundant.
  if (account.display_name) return name
  const mask = formatAccountMask(account)
  return mask ? `${name} ${mask}` : name
}
