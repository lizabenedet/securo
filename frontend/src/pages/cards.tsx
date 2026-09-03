import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Check, CreditCard, Pencil, X } from 'lucide-react'
import { cards as cardsApi, transactions as transactionsApi } from '@/lib/api'
import { CategoryIcon } from '@/components/category-icon'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Card as CardType, CardSummaryItem, Transaction } from '@/types'

// Reuses the report ranges — and their labels — so "12M" means here what it
// means there.
const RANGES: { key: string; months: number; period?: 'ytd'; labelKey: string }[] = [
  { key: '3m', months: 3, labelKey: 'reports.range3m' },
  { key: '6m', months: 6, labelKey: 'reports.range6m' },
  { key: '12m', months: 12, labelKey: 'reports.range12m' },
  { key: 'ytd', months: 12, period: 'ytd', labelKey: 'reports.rangeYtd' },
  { key: '2y', months: 24, labelKey: 'reports.range2y' },
]

// Well-separated hues so a card keeps the same colour in its tab, its line
// and the legend. Assigned by position in the (stable) card ordering.
const CARD_COLORS = [
  '#6366F1',
  '#F59E0B',
  '#10B981',
  '#EC4899',
  '#0EA5E9',
  '#8B5CF6',
  '#F97316',
  '#14B8A6',
  '#84CC16',
  '#D946EF',
]

const ALL_TAB = 'all'

/**
 * What to call a card on screen.
 *
 * The API stores a name only once someone types one, so the fallback chain
 * lives here: the digits the bank reports, and for the account's catch-all
 * card the account's own name — which is the truth for a Viacredi-style
 * account where no feed ever names a card.
 */
function cardLabel(card: CardType, unnamed: string): string {
  if (card.name) return card.name
  if (card.last4) return `·${card.last4}`
  return card.account_name || unnamed
}

// Axis ticks are compact for the same reason the reports' are: a full
// "R$ 20.220,03" on every gridline crowds the plot out of its own card.
function formatCompact(value: number, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function monthLabel(period: string, locale: string): string {
  const [year, month] = period.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString(locale, {
    month: 'short',
    year: '2-digit',
  })
}

export default function CardsPage() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const queryClient = useQueryClient()
  const { privacyMode, mask, MASK } = usePrivacyMode()

  const [rangeKey, setRangeKey] = useState('12m')
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  // The transactions endpoint caps a page at 500, so "show more" stops there
  // rather than asking for a page the API will reject.
  const MAX_VISIBLE = 500
  const [visibleCount, setVisibleCount] = useState(60)

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[2]
  const selectedCardId = activeTab === ALL_TAB ? null : activeTab

  const { data: summary, isLoading } = useQuery({
    queryKey: ['cards', 'summary', rangeKey, selectedCardId],
    queryFn: () =>
      cardsApi.summary({
        months: range.months,
        period: range.period,
        card_id: selectedCardId ?? undefined,
      }),
  })

  const cards = useMemo(() => summary?.cards ?? [], [summary])
  const currency = summary?.currency ?? 'USD'

  const colorByCard = useMemo(() => {
    const map: Record<string, string> = {}
    cards.forEach((card, index) => {
      map[card.id] = CARD_COLORS[index % CARD_COLORS.length]
    })
    return map
  }, [cards])

  const cardById = useMemo(() => {
    const map: Record<string, CardSummaryItem> = {}
    for (const card of cards) map[card.id] = card
    return map
  }, [cards])

  const activeCard = selectedCardId ? (cardById[selectedCardId] ?? null) : null
  // A card can go away between renders — deleted here, or its account closed
  // elsewhere. Deriving which tab reads as active (rather than correcting the
  // state afterwards) means the bar never underlines a tab that is gone.
  const activeKey = activeCard ? activeCard.id : ALL_TAB

  // The accounts to list charges from come out of the cards themselves, so
  // the page never has to ask which accounts are credit cards.
  const accountIds = useMemo(
    () => [...new Set(cards.map((card) => card.account_id))],
    [cards],
  )

  const { data: txPage, isLoading: txLoading } = useQuery({
    queryKey: ['cards', 'transactions', rangeKey, selectedCardId, visibleCount, accountIds],
    queryFn: () =>
      transactionsApi.list({
        account_ids: accountIds,
        card_id: selectedCardId ?? undefined,
        from: summary?.start,
        to: summary?.end,
        // Same definition of spend the totals above use: debits that count
        // as the user's own expense. A list that showed more than it summed
        // would make the chart look wrong.
        type: 'debit',
        user_pnl_only: true,
        limit: visibleCount,
        sort_by: 'date',
        sort_dir: 'desc',
      }),
    enabled: accountIds.length > 0 && !!summary,
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => cardsApi.rename(id, name),
    onSuccess: () => {
      setRenaming(false)
      queryClient.invalidateQueries({ queryKey: ['cards'] })
    },
  })

  const chartLines = useMemo(
    () => (activeCard ? [activeCard] : cards),
    [activeCard, cards],
  )

  // The month axis comes from the months the API actually returned, and every
  // line is filled to zero across it. A card that only exists since June then
  // reads as "spent nothing", which is true, instead of leaving a gap the eye
  // fills with a guess.
  const chartData = useMemo(() => {
    return (summary?.monthly ?? []).map((point) => {
      const row: Record<string, string | number> = {
        period: point.period,
        label: monthLabel(point.period, locale),
      }
      for (const card of chartLines) row[card.id] = point.totals[card.id] ?? 0
      return row
    })
  }, [summary, locale, chartLines])

  const transactionsByMonth = useMemo(() => {
    const groups: { month: string; items: Transaction[] }[] = []
    for (const tx of txPage?.items ?? []) {
      const month = tx.date.slice(0, 7)
      const last = groups[groups.length - 1]
      if (last && last.month === month) last.items.push(tx)
      else groups.push({ month, items: [tx] })
    }
    return groups
  }, [txPage])

  const defaultCardByAccount = useMemo(() => {
    const map: Record<string, string> = {}
    for (const card of cards) if (card.is_default) map[card.account_id] = card.id
    return map
  }, [cards])

  const money = (value: number) =>
    privacyMode ? MASK : formatCurrency(value, currency, locale)

  // The same object the reports page hands Recharts, so a tooltip here weighs
  // and rounds exactly like a tooltip there.
  const tooltipStyle = {
    background: 'var(--card)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '0.75rem',
    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
    fontSize: '12px',
  }

  const headline = activeCard ? activeCard.total : (summary?.total ?? 0)
  const windowLabel =
    summary && summary.monthly.length > 0
      ? `${monthLabel(summary.monthly[0].period, locale)} – ${monthLabel(
          summary.monthly[summary.monthly.length - 1].period,
          locale,
        )}`
      : ''

  const startRename = () => {
    if (!activeCard) return
    setRenameValue(activeCard.name ?? '')
    setRenaming(true)
  }

  const selectTab = (key: string) => {
    setActiveTab(key)
    setRenaming(false)
    setVisibleCount(60)
  }

  const noCards = !isLoading && cards.length === 0

  return (
    <div>
      <PageHeader
        section={t('nav.groupAccounts')}
        title={t('cards.title')}
        action={
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-border bg-card overflow-hidden">
              {RANGES.map((option) => (
                <button
                  key={option.key}
                  onClick={() => setRangeKey(option.key)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-semibold transition-colors',
                    rangeKey === option.key
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                  )}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {noCards ? (
        <div className="bg-card rounded-xl border border-dashed border-border shadow-sm px-5 py-10 text-center">
          <CreditCard className="h-8 w-8 mx-auto mb-3 text-muted-foreground/60" />
          <p className="text-sm font-semibold text-foreground">{t('cards.empty')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('cards.emptyHint')}</p>
        </div>
      ) : (
        <>
          {/* Tab bar — one tab per card, "all cards" first. */}
          <div className="flex items-center gap-1 mb-5 border-b border-border overflow-x-auto">
            <button
              onClick={() => selectTab(ALL_TAB)}
              className={cn(
                'relative px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap',
                activeKey === ALL_TAB
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('cards.allCards')}
              {activeKey === ALL_TAB && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
            {cards.map((card) => (
              <button
                key={card.id}
                onClick={() => selectTab(card.id)}
                className={cn(
                  'relative px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap',
                  activeKey === card.id
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: colorByCard[card.id] }}
                  />
                  {cardLabel(card, t('cards.unnamed'))}
                </span>
                {activeKey === card.id && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Headline */}
          <div className="bg-card rounded-xl border border-border shadow-sm mb-5">
            <div className="px-5 py-4">
              {isLoading ? (
                <div className="flex items-center gap-8">
                  <Skeleton className="h-16 w-48" />
                  <div className="flex gap-6">
                    <Skeleton className="h-12 w-28" />
                    <Skeleton className="h-12 w-28" />
                    <Skeleton className="h-12 w-28" />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
                        {activeCard
                          ? cardLabel(activeCard, t('cards.unnamed'))
                          : t('cards.allCards')}
                      </p>
                      {activeCard && !renaming && (
                        <button
                          type="button"
                          aria-label={t('cards.rename')}
                          onClick={startRename}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    {activeCard && renaming && (
                      <div className="flex items-center gap-1.5 mb-1">
                        <Input
                          autoFocus
                          value={renameValue}
                          placeholder={t('cards.namePlaceholder')}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter')
                              renameMutation.mutate({ id: activeCard.id, name: renameValue })
                            if (event.key === 'Escape') setRenaming(false)
                          }}
                          className="h-8 w-56 text-sm"
                        />
                        <button
                          type="button"
                          aria-label={t('common.save')}
                          onClick={() =>
                            renameMutation.mutate({ id: activeCard.id, name: renameValue })
                          }
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('common.cancel')}
                          onClick={() => setRenaming(false)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    )}

                    <div className="flex items-baseline gap-3">
                      <p className="text-3xl font-bold tabular-nums text-foreground">
                        {mask(formatCurrency(headline, currency, locale))}
                      </p>
                      {activeCard && (
                        <span className="text-sm font-semibold tabular-nums text-muted-foreground">
                          {Math.round(activeCard.share * 100)}%
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {activeCard
                        ? [
                            activeCard.account_name,
                            activeCard.last_used
                              ? t('cards.lastUsed', {
                                  date: new Date(
                                    `${activeCard.last_used}T00:00:00`,
                                  ).toLocaleDateString(locale),
                                })
                              : t('cards.neverUsed'),
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : windowLabel}
                    </p>
                  </div>

                  {!activeCard && (
                    <div className="flex flex-wrap gap-6">
                      {cards.slice(0, 4).map((card) => (
                        <div key={card.id} className="min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <div
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: colorByCard[card.id] }}
                            />
                            <p className="text-xs font-medium text-muted-foreground truncate">
                              {cardLabel(card, t('cards.unnamed'))}
                            </p>
                          </div>
                          <p className="text-lg font-bold tabular-nums text-foreground">
                            {mask(formatCurrency(card.total, currency, locale))}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Usage over time */}
          <div className="bg-card rounded-xl border border-border shadow-sm mb-5">
            <div className="px-5 pt-5 pb-2 flex items-center justify-between gap-4">
              <p className="text-sm font-semibold text-foreground">{t('cards.usageByMonth')}</p>
              <div className="flex items-center gap-3 flex-wrap justify-end">
                {chartLines.slice(0, 6).map((card) => (
                  <div key={card.id} className="flex items-center gap-1.5">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: colorByCard[card.id] }}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      {cardLabel(card, t('cards.unnamed'))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-1 pb-4" style={{ height: 320 }}>
              {isLoading ? (
                <div className="px-4">
                  <Skeleton className="h-full w-full" />
                </div>
              ) : chartData.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">{t('cards.noSpend')}</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={(value: number) => {
                        if (privacyMode) return ''
                        if (value === 0) return '0'
                        return formatCompact(value, currency, locale)
                      }}
                      tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                      axisLine={false}
                      tickLine={false}
                      width={privacyMode ? 24 : 64}
                      tickCount={5}
                    />
                    <Tooltip
                      formatter={(value, name) => [
                        money(Number(value ?? 0)),
                        cardById[String(name)]
                          ? cardLabel(cardById[String(name)], t('cards.unnamed'))
                          : String(name),
                      ]}
                      contentStyle={tooltipStyle}
                    />
                    {chartLines.map((card) => (
                      <Line
                        key={card.id}
                        type="monotone"
                        dataKey={card.id}
                        stroke={colorByCard[card.id]}
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
            {/* By category */}
            <div className="bg-card rounded-xl border border-border shadow-sm">
              <div className="px-5 pt-5 pb-2">
                <p className="text-sm font-semibold text-foreground">{t('cards.byCategory')}</p>
              </div>
              <div className="px-5 pb-5">
                {(summary?.categories.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    {t('cards.noSpend')}
                  </p>
                ) : (
                  <>
                    <div style={{ height: 180 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={summary?.categories ?? []}
                            dataKey="total"
                            nameKey="name"
                            innerRadius={46}
                            outerRadius={72}
                            paddingAngle={2}
                            stroke="var(--card)"
                            strokeWidth={2}
                          >
                            {(summary?.categories ?? []).map((item, index) => (
                              <Cell
                                key={item.category_id ?? `none-${index}`}
                                fill={item.color || CARD_COLORS[index % CARD_COLORS.length]}
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={(value) => money(Number(value ?? 0))}
                            contentStyle={tooltipStyle}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <ul className="mt-4 space-y-2.5">
                      {(summary?.categories ?? []).slice(0, 8).map((item) => (
                        <li
                          key={item.category_id ?? 'uncategorized'}
                          className="flex items-center gap-2"
                        >
                          <CategoryIcon icon={item.icon} color={item.color} size="xs" />
                          <span className="flex-1 truncate text-xs text-foreground">
                            {item.name ?? t('cards.uncategorized')}
                          </span>
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {Math.round(item.share * 100)}%
                          </span>
                          <span className="text-xs font-medium text-foreground tabular-nums">
                            {money(item.total)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>

            {/* Charges */}
            <div className="lg:col-span-2 bg-card rounded-xl border border-border shadow-sm">
              <div className="px-5 pt-5 pb-2">
                <p className="text-sm font-semibold text-foreground">{t('cards.charges')}</p>
              </div>
              <div className="px-5 pb-5">
                {txLoading && <Skeleton className="h-40 w-full" />}
                {!txLoading && transactionsByMonth.length === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    {t('cards.noSpend')}
                  </p>
                )}
                {!txLoading &&
                  transactionsByMonth.map((group) => (
                    <div key={group.month} className="mb-4 last:mb-0">
                      <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">
                        {monthLabel(group.month, locale)}
                      </p>
                      <ul className="divide-y divide-border">
                        {group.items.map((tx) => {
                          const cardId =
                            tx.card_id ??
                            (tx.account_id ? defaultCardByAccount[tx.account_id] : undefined)
                          const card = cardId ? cardById[cardId] : undefined
                          return (
                            <li key={tx.id} className="flex items-center gap-2.5 py-2">
                              <span className="w-11 shrink-0 text-xs text-muted-foreground tabular-nums">
                                {tx.date.slice(8, 10)}/{tx.date.slice(5, 7)}
                              </span>
                              <span className="flex-1 truncate text-sm text-foreground">
                                {tx.description}
                              </span>
                              {!activeCard && card && (
                                <span className="hidden sm:flex items-center gap-1.5 shrink-0">
                                  <span
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: colorByCard[card.id] }}
                                  />
                                  <span className="text-[11px] text-muted-foreground truncate max-w-[130px]">
                                    {cardLabel(card, t('cards.unnamed'))}
                                  </span>
                                </span>
                              )}
                              <span className="text-sm font-medium text-foreground tabular-nums">
                                {money(tx.amount_primary ?? tx.amount)}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ))}
                {!txLoading &&
                  (txPage?.total ?? 0) > (txPage?.items.length ?? 0) &&
                  visibleCount < MAX_VISIBLE && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full mt-3"
                      onClick={() =>
                        setVisibleCount((count) => Math.min(count + 60, MAX_VISIBLE))
                      }
                    >
                      {t('common.showMore', {
                        count: (txPage?.total ?? 0) - (txPage?.items.length ?? 0),
                      })}
                    </Button>
                  )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
