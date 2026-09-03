/**
 * The cards page: one tab per card, a line per card, and a rename that
 * reaches the API.
 *
 * The page is the only place the card model is visible, so the things worth
 * pinning are the ones a user would notice going wrong: a tab bar that loses
 * the account's own card, a headline that reports the wrong card's spend, and
 * the fallback name for a card nobody has named.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import CardsPage from '@/pages/cards'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  cards: { summary: vi.fn(), list: vi.fn(), rename: vi.fn() },
  transactions: { list: vi.fn() },
}))
vi.mock('@/lib/api', () => ({ cards: api.cards, transactions: api.transactions }))

// The locale hook reaches for the signed-in user and the admin number-format
// setting; neither says anything about this page. Pinning it also keeps the
// formatted amounts below predictable.
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US' }))

// Recharts measures its container, which jsdom reports as 0×0 — every chart
// would render empty and warn. The page's own markup is what is under test.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 320 }}>{children}</div>
    ),
  }
})

const NAMED_CARD = {
  id: 'card-1',
  account_id: 'acct-1',
  account_name: 'PLATINUM',
  card_brand: 'MASTERCARD',
  last4: '2925',
  name: null,
  is_default: false,
  total: 20220.03,
  share: 0.39,
  transaction_count: 295,
  last_used: '2026-08-29',
}

const DEFAULT_CARD = {
  id: 'card-2',
  account_id: 'acct-2',
  account_name: 'Viacredi Cartão 1230',
  card_brand: null,
  last4: null,
  name: null,
  is_default: true,
  total: 8430.89,
  share: 0.16,
  transaction_count: 78,
  last_used: '2026-08-11',
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    currency: 'BRL',
    start: '2025-09-01',
    end: '2026-09-02',
    total: 28650.92,
    cards: [NAMED_CARD, DEFAULT_CARD],
    monthly: [
      { period: '2026-07', totals: { 'card-1': 1500, 'card-2': 700 } },
      { period: '2026-08', totals: { 'card-1': 2100, 'card-2': 300 } },
    ],
    categories: [
      { category_id: 'cat-1', name: 'Mercado', icon: null, color: '#10B981', total: 13224.86, share: 0.256 },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.cards.summary.mockResolvedValue(summary())
  api.transactions.list.mockResolvedValue({ items: [], total: 0, page: 1, limit: 60 })
})

describe('CardsPage', () => {
  it('gives every card a tab, behind an "all cards" one', async () => {
    renderWithProviders(<CardsPage />)

    // The "all cards" tab is there from the first paint — the card tabs only
    // once the summary lands, so wait on one of those.
    // A card nobody named falls back to its digits; the account's own card
    // falls back to the account name, because that is what it stands for.
    expect(await screen.findByRole('button', { name: '·2925' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All cards' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Viacredi Cartão 1230' })).toBeInTheDocument()
  })

  it('opens on the total across cards', async () => {
    renderWithProviders(<CardsPage />)

    await waitFor(() => expect(screen.getByText(/28[.,]650/)).toBeInTheDocument())
    // No card is selected, so the per-card breakdown stands in for the tabs.
    expect(screen.getByText(/20[.,]220/)).toBeInTheDocument()
    expect(api.cards.summary).toHaveBeenCalledWith(
      expect.objectContaining({ months: 12, card_id: undefined }),
    )
  })

  it('asks the API for one card when its tab is opened', async () => {
    const { user } = renderWithProviders(<CardsPage />)

    await user.click(await screen.findByRole('button', { name: '·2925' }))

    await waitFor(() =>
      expect(api.cards.summary).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'card-1' }),
      ),
    )
    await waitFor(() =>
      expect(api.transactions.list).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'card-1' }),
      ),
    )
    // The headline follows the tab rather than staying on the total.
    await waitFor(() => expect(screen.getByText('39%')).toBeInTheDocument())
  })

  it('renames the card the tab is on', async () => {
    api.cards.rename.mockResolvedValue({ ...NAMED_CARD, name: "Mum's card" })
    const { user } = renderWithProviders(<CardsPage />)

    await user.click(await screen.findByRole('button', { name: '·2925' }))
    await user.click(await screen.findByRole('button', { name: 'Rename' }))
    await user.type(screen.getByPlaceholderText(/mum's card/i), "Mum's card")
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.cards.rename).toHaveBeenCalledWith('card-1', "Mum's card"),
    )
  })

  it('offers naming and nothing else that writes', async () => {
    // Which cards exist, and which charge sits on which, comes from the bank.
    // A page that offered to add or move would only let someone make the
    // attribution less true than the feed it came from.
    const { user } = renderWithProviders(<CardsPage />)

    await user.click(await screen.findByRole('button', { name: '·2925' }))
    await screen.findByRole('button', { name: 'Rename' })

    expect(screen.queryByRole('button', { name: /add card/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /move/i })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('says so when there is no card account at all', async () => {
    api.cards.summary.mockResolvedValue(
      summary({ cards: [], monthly: [], categories: [], total: 0 }),
    )
    renderWithProviders(<CardsPage />)

    expect(await screen.findByText('No credit card accounts')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'All cards' })).not.toBeInTheDocument()
  })

  it('groups charges by month and names the card each one is on', async () => {
    api.transactions.list.mockResolvedValue({
      items: [
        {
          id: 'tx-1',
          date: '2026-08-29',
          description: 'SUPERMERCADOS KOCH',
          amount: 176.29,
          amount_primary: 176.29,
          account_id: 'acct-1',
          card_id: 'card-1',
          type: 'debit',
          currency: 'BRL',
          source: 'sync',
          status: 'posted',
          splits: [],
        },
        {
          id: 'tx-2',
          date: '2026-07-06',
          description: 'MERCEARIA ZENATTI',
          amount: 9,
          amount_primary: 9,
          account_id: 'acct-2',
          // Unattributed: the page has to resolve it to the account's own card.
          card_id: null,
          type: 'debit',
          currency: 'BRL',
          source: 'import',
          status: 'posted',
          splits: [],
        },
      ],
      total: 2,
      page: 1,
      limit: 60,
    })
    renderWithProviders(<CardsPage />)

    const koch = await screen.findByText('SUPERMERCADOS KOCH')
    const zenatti = screen.getByText('MERCEARIA ZENATTI')
    const kochRow = koch.closest('li') as HTMLElement
    const zenattiRow = zenatti.closest('li') as HTMLElement

    expect(within(kochRow).getByText('·2925')).toBeInTheDocument()
    expect(within(zenattiRow).getByText('Viacredi Cartão 1230')).toBeInTheDocument()
  })
})
