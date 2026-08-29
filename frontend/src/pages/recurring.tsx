import React, { useMemo, useState } from 'react'
import { getAccountName, sortAccountsByDisplayName } from '@/lib/account-utils'
import { useTranslation } from 'react-i18next'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { categories as categoriesApi, categoryGroups as categoryGroupsApi, recurring as recurringApi, accounts as accountsApi, currencies as currenciesApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { localDateString } from '@/lib/date-utils'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { Category, CategoryGroup, RecurringSuggestion, RecurringTransaction } from '@/types'
import { Pencil, Trash2, Plus, RefreshCw, Info, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/page-header'
import { CategorySelect } from '@/components/category-select'
import { DatePickerInput } from '@/components/ui/date-picker-input'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { formatCurrency } from '@/lib/format'

const TH = 'text-xs font-medium text-muted-foreground py-3'

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
      {children}
    </div>
  )
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {action}
    </div>
  )
}

export default function RecurringPage() {
  const { t } = useTranslation()

  return (
    <div>
      <PageHeader section={t('recurring.title')} title={t('recurring.title')} />
      <RecurringTab />
    </div>
  )
}

function RecurringTab() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { canWrite } = useWorkspace()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<RecurringTransaction | null>(null)
  // A suggestion opens the same dialog, but as a create with the fields filled
  // in. Kept apart from `editing` so the save path still tells the two cases
  // apart — a suggestion has no id to update.
  const [prefill, setPrefill] = useState<Partial<RecurringTransaction> | null>(null)
  const [deletingRecurring, setDeletingRecurring] = useState<RecurringTransaction | null>(null)
  const [summaryPeriod, setSummaryPeriod] = useState<SummaryPeriod>('monthly')

  const { data: recurringList } = useQuery({
    queryKey: ['recurring'],
    queryFn: recurringApi.list,
  })

  const { data: suggestionList } = useQuery({
    queryKey: ['recurring', 'suggestions'],
    queryFn: recurringApi.suggestions,
    enabled: canWrite,
  })

  const dismissMutation = useMutation({
    mutationFn: recurringApi.dismissSuggestion,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recurring', 'suggestions'] }),
    onError: () => toast.error(t('common.error')),
  })

  const { data: categoriesList } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  })

  const { data: allCategoriesList } = useQuery({
    queryKey: ['categories', 'management'],
    queryFn: categoriesApi.listIncludingHidden,
    enabled: Boolean(editing?.category_id),
  })

  const { data: categoryGroupsList } = useQuery({
    queryKey: ['categoryGroups'],
    queryFn: categoryGroupsApi.list,
  })

  const { data: accountsList } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  })

  const createMutation = useMutation({
    mutationFn: (data: Partial<RecurringTransaction>) => recurringApi.create(data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['recurring'] })
      setDialogOpen(false)
      setPrefill(null)
      toast.success(t('recurring.created'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<RecurringTransaction> & { id: string }) =>
      recurringApi.update(id, data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['recurring'] })
      setDialogOpen(false)
      setEditing(null)
      toast.success(t('recurring.updated'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => recurringApi.delete(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['recurring'] })
      setDeletingRecurring(null)
      toast.success(t('recurring.deleted'))
    },
    onError: (err: unknown) => {
      toast.error(extractApiError(err, t('common.error')))
    },
  })

  const generateMutation = useMutation({
    mutationFn: () => recurringApi.generate(),
    onSuccess: (data) => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['recurring'] })
      toast.success(t('recurring.generated', { count: data.generated }))
    },
    onError: () => toast.error(t('common.error')),
  })

  const frequencyLabel = (f: string) => {
    const map: Record<string, string> = { monthly: t('recurring.monthly'), quarterly: t('recurring.quarterly'), weekly: t('recurring.weekly'), yearly: t('recurring.yearly') }
    return map[f] ?? f
  }

  const acceptSuggestion = (suggestion: RecurringSuggestion) => {
    setEditing(null)
    setPrefill({
      description: suggestion.description,
      amount: suggestion.amount,
      currency: suggestion.currency,
      type: suggestion.type,
      frequency: suggestion.frequency,
      day_of_month: suggestion.day_of_month,
      // The schedule starts at the next expected charge, not at the first one
      // we found: back-dating would make generate_pending materialize a year
      // of occurrences that already exist as real transactions.
      start_date: suggestion.next_date,
      account_id: suggestion.account_id,
      category_id: suggestion.category_id,
    })
    setDialogOpen(true)
  }

  return (
    <>
      {canWrite && suggestionList && suggestionList.length > 0 && (
        <div className="mb-4">
          <SuggestionsCard
            suggestions={suggestionList}
            categories={categoriesList ?? []}
            accounts={accountsList ?? []}
            locale={locale}
            mask={mask}
            frequencyLabel={frequencyLabel}
            onAccept={acceptSuggestion}
            onDismiss={(payload) => dismissMutation.mutate(payload)}
            dismissing={dismissMutation.isPending}
          />
        </div>
      )}

      {recurringList && recurringList.length > 0 && (
        <div className="mb-4">
          <RecurringSummary
            recurring={recurringList}
            period={summaryPeriod}
            onPeriodChange={setSummaryPeriod}
            userCurrency={userCurrency}
            locale={locale}
            mask={mask}
          />
        </div>
      )}

      <SectionCard>
        <SectionHeader
          title={t('recurring.title')}
          action={
            canWrite ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-8"
                  onClick={() => generateMutation.mutate()}
                  disabled={generateMutation.isPending}
                >
                  <RefreshCw size={12} />
                  <span className="hidden sm:inline">{t('recurring.generatePending')}</span>
                </Button>
                <Button size="sm" className="gap-1.5 h-8" onClick={() => { setEditing(null); setDialogOpen(true) }}>
                  <Plus size={13} /> <span className="hidden sm:inline">{t('recurring.add')}</span>
                </Button>
              </div>
            ) : undefined
          }
        />
        {recurringList && recurringList.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className={`${TH} pl-4 sm:pl-5 text-left`}>{t('recurring.description')}</th>
                <th className={`${TH} text-left w-36`}>{t('recurring.amount')}</th>
                <th className={`${TH} text-left w-28 hidden md:table-cell`}>{t('recurring.frequency')}</th>
                <th className={`${TH} text-left w-32 hidden md:table-cell`}>{t('recurring.nextOccurrence')}</th>
                <th className={`${TH} text-left w-24 hidden sm:table-cell`}>{t('recurring.status')}</th>
                {canWrite && <th className={`${TH} pr-4 sm:pr-5 text-right w-24`}>{t('recurring.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {recurringList.map((rt) => (
                <tr key={rt.id} className="border-b border-border last:border-0 hover:bg-muted transition-colors">
                  <td className="py-3 pl-4 sm:pl-5 text-sm font-medium text-foreground">{rt.description}</td>
                  <td className={`py-3 text-xs sm:text-sm font-bold tabular-nums ${rt.type === 'credit' ? 'text-emerald-600' : 'text-rose-500'}`}>
                    {mask(`${rt.type === 'credit' ? '+' : '−'}${formatCurrency(rt.amount, rt.currency, locale)}`)}
                    {rt.currency !== userCurrency && rt.amount_primary != null && (
                      <div className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                        <span>{mask(formatCurrency(rt.amount_primary, userCurrency, locale))}</span>
                        <span title={t('recurring.fxEstimate', { rate: rt.fx_rate_used?.toFixed(4) ?? '–' })}>
                          <Info size={11} className="inline opacity-60" />
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="py-3 hidden md:table-cell">
                    <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-medium">
                      {frequencyLabel(rt.frequency)}
                    </span>
                  </td>
                  <td className="py-3 text-xs text-muted-foreground tabular-nums hidden md:table-cell">
                    {new Date(rt.next_occurrence + 'T00:00:00').toLocaleDateString(dateLocale)}
                  </td>
                  <td className="py-3 hidden sm:table-cell">
                    <span className={cn(
                      'text-[11px] font-semibold px-2 py-0.5 rounded-full border',
                      rt.is_active
                        ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                        : 'bg-muted text-muted-foreground border-border'
                    )}>
                      {rt.is_active ? t('recurring.active') : t('recurring.inactive')}
                    </span>
                  </td>
                  {canWrite && (
                    <td className="py-3 pr-4 sm:pr-5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                          onClick={() => { setEditing(rt); setDialogOpen(true) }}
                          aria-label={t('common.edit')}
                          title={t('common.edit')}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="p-1.5 rounded-md text-muted-foreground hover:text-rose-500 hover:bg-rose-50 transition-colors"
                          onClick={() => setDeletingRecurring(rt)}
                          disabled={deleteMutation.isPending}
                          aria-label={t('common.delete')}
                          title={t('common.delete')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-10">{t('recurring.empty')}</p>
        )}
      </SectionCard>

      <Dialog open={dialogOpen} onOpenChange={() => { setDialogOpen(false); setEditing(null); setPrefill(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t('recurring.edit') : t('recurring.add')}</DialogTitle>
          </DialogHeader>
          <RecurringForm
            key={editing?.id ?? (prefill ? 'suggestion' : 'new')}
            recurring={editing ?? prefill}
            categories={categoriesList ?? []}
            categoryGroups={categoryGroupsList ?? []}
            currentCategory={allCategoriesList?.find(
              (category) => category.id === editing?.category_id
            )}
            accounts={accountsList ?? []}
            onSave={(data) => {
              if (editing) {
                updateMutation.mutate({ id: editing.id, ...data })
              } else {
                createMutation.mutate(data)
              }
            }}
            onCancel={() => { setDialogOpen(false); setEditing(null); setPrefill(null) }}
            loading={createMutation.isPending || updateMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog
        open={!!deletingRecurring}
        title={t('recurring.confirmDeleteTitle')}
        description={t('recurring.confirmDeleteDescription', { description: deletingRecurring?.description })}
        isPending={deleteMutation.isPending}
        onClose={() => setDeletingRecurring(null)}
        onConfirm={() => deletingRecurring && deleteMutation.mutate(deletingRecurring.id)}
      />
    </>
  )
}

// Times a bill of each frequency is charged in a year. Used to restate every
// bill at one cadence so they can be added up: a quarterly water bill and a
// monthly subscription are not comparable as stored.
const CHARGES_PER_YEAR: Record<string, number> = {
  weekly: 52.1775,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
}

type SummaryPeriod = 'weekly' | 'monthly' | 'yearly'

const SUMMARY_PERIODS: readonly SummaryPeriod[] = ['weekly', 'monthly', 'yearly']

/** What the registered bills add up to, in and out, at one chosen cadence.
 *
 * The figures are derived, not charges that exist: a quarterly bill of 46.73
 * reads as 15.58 when the period is monthly. That is the point — the question
 * a summary answers is "how much do I commit per month", which no single row
 * can answer on its own. The period selector is there so the reader picks the
 * cadence the answer is stated in. */
function RecurringSummary({
  recurring,
  period,
  onPeriodChange,
  userCurrency,
  locale,
  mask,
}: {
  recurring: RecurringTransaction[]
  period: SummaryPeriod
  onPeriodChange: (period: SummaryPeriod) => void
  userCurrency: string
  locale: string
  mask: (value: string) => string
}) {
  const { t } = useTranslation()

  const totals = useMemo(() => {
    const divisor = CHARGES_PER_YEAR[period] ?? 12
    let incoming = 0
    let outgoing = 0
    let incomingCount = 0
    let outgoingCount = 0

    for (const bill of recurring) {
      if (!bill.is_active) continue
      const perYear = CHARGES_PER_YEAR[bill.frequency]
      if (!perYear) continue
      // A bill kept in another currency carries the converted figure; falling
      // back to the raw amount would add euros to reais.
      const amount =
        bill.currency !== userCurrency && bill.amount_primary != null
          ? Number(bill.amount_primary)
          : Number(bill.amount)
      const restated = (Math.abs(amount) * perYear) / divisor
      if (bill.type === 'credit') {
        incoming += restated
        incomingCount += 1
      } else {
        outgoing += restated
        outgoingCount += 1
      }
    }
    return { incoming, outgoing, net: incoming - outgoing, incomingCount, outgoingCount }
  }, [recurring, period, userCurrency])

  const money = (value: number) => mask(formatCurrency(value, userCurrency, locale))

  return (
    <SectionCard>
      <SectionHeader
        title={t('recurring.summaryTitle')}
        action={
          <div className="flex items-center rounded-lg border border-border bg-card overflow-hidden">
            {SUMMARY_PERIODS.map((option) => (
              <button
                key={option}
                onClick={() => onPeriodChange(option)}
                className={`px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  period === option
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {t(`recurring.${option}`)}
              </button>
            ))}
          </div>
        }
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
        {[
          {
            label: t('recurring.summaryIncoming'),
            value: totals.incoming,
            count: totals.incomingCount,
            className: 'text-emerald-600',
          },
          {
            label: t('recurring.summaryOutgoing'),
            value: totals.outgoing,
            count: totals.outgoingCount,
            className: 'text-rose-500',
          },
          {
            label: t('recurring.summaryNet'),
            value: totals.net,
            count: totals.incomingCount + totals.outgoingCount,
            className: totals.net >= 0 ? 'text-emerald-600' : 'text-rose-500',
          },
        ].map((stat) => (
          <div key={stat.label} className="px-4 sm:px-5 py-4">
            <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {stat.label}
            </p>
            <p className={`mt-1 text-lg font-bold tabular-nums ${stat.className}`}>
              {money(stat.value)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('recurring.summaryCount', { count: stat.count })}
            </p>
          </div>
        ))}
      </div>
      <p className="px-4 sm:px-5 pb-4 text-xs text-muted-foreground">
        {t('recurring.summaryNote')}
      </p>
    </SectionCard>
  )
}

/** Commitments the ledger shows that no bill covers yet.
 *
 * Ranked by amount, because what moves the budget is what deserves attention.
 * Confidence rides along on each row instead of gating the list: the detector
 * is deliberately permissive so a salary that lands anywhere between the 5th
 * and the 25th still shows up, and that same tolerance lets the odd weekly
 * supermarket run through. Showing the number lets the reader judge. */
function SuggestionsCard({
  suggestions,
  categories,
  accounts,
  locale,
  mask,
  frequencyLabel,
  onAccept,
  onDismiss,
  dismissing,
}: {
  suggestions: RecurringSuggestion[]
  categories: Category[]
  accounts: { id: string; name: string; display_name?: string | null }[]
  locale: string
  mask: (value: string) => string
  frequencyLabel: (f: string) => string
  onAccept: (suggestion: RecurringSuggestion) => void
  onDismiss: (payload: { fingerprint?: string; category_id?: string }) => void
  dismissing: boolean
}) {
  const { t } = useTranslation()
  const accountName = (id: string) => {
    const account = accounts.find((a) => a.id === id)
    return account ? getAccountName(account as Parameters<typeof getAccountName>[0]) : ''
  }

  return (
    <SectionCard>
      <SectionHeader
        title={t('recurring.suggestionsTitle')}
        action={
          <span className="text-xs text-muted-foreground">
            {t('recurring.suggestionsCount', { count: suggestions.length })}
          </span>
        }
      />
      <p className="px-4 sm:px-5 pt-3 text-xs text-muted-foreground">
        {t('recurring.suggestionsHelp')}
      </p>
      <div className="divide-y divide-border mt-3">
        {suggestions.map((suggestion) => {
          const category = categories.find((c) => c.id === suggestion.category_id)
          return (
            <div
              key={suggestion.fingerprint}
              className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="shrink-0 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground truncate">
                    {suggestion.description}
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {frequencyLabel(suggestion.frequency)}
                  {' · '}
                  {t('recurring.suggestionsSeen', { count: suggestion.occurrences })}
                  {' · '}
                  {t('recurring.suggestionsConfidence', {
                    percent: Math.round(suggestion.confidence * 100),
                  })}
                  {suggestion.account_ids.length > 1
                    ? ` · ${t('recurring.suggestionsAccounts', { count: suggestion.account_ids.length })}`
                    : ` · ${accountName(suggestion.account_id)}`}
                  {category ? ` · ${category.name}` : ''}
                </p>
              </div>
              <p className="text-sm font-semibold tabular-nums text-foreground shrink-0">
                {suggestion.type === 'debit' ? '-' : '+'}
                {mask(formatCurrency(Math.abs(suggestion.amount), suggestion.currency, locale))}
                {/* The charges differ month to month, so the prefilled value is
                    the median rather than a promise. */}
                {suggestion.amount_varies ? <span className="text-muted-foreground"> ~</span> : null}
              </p>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" className="h-8" onClick={() => onAccept(suggestion)}>
                  {t('recurring.suggestionsAdd')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  disabled={dismissing}
                  title={t('recurring.suggestionsDismiss')}
                  aria-label={t('recurring.suggestionsDismiss')}
                  onClick={() => onDismiss({ fingerprint: suggestion.fingerprint })}
                >
                  <X size={14} />
                </Button>
                {/* Retires a whole category at once — how bank fees and interest
                    go away without their category name living in the code. */}
                {suggestion.category_id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs text-muted-foreground"
                    disabled={dismissing}
                    onClick={() => onDismiss({ category_id: suggestion.category_id! })}
                  >
                    {t('recurring.suggestionsMuteCategory')}
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

function RecurringForm({
  recurring,
  categories,
  categoryGroups,
  currentCategory,
  accounts,
  onSave,
  onCancel,
  loading,
}: {
  recurring: RecurringTransaction | Partial<RecurringTransaction> | null
  categories: Category[]
  categoryGroups: CategoryGroup[]
  currentCategory?: Category
  accounts: { id: string; name: string; display_name?: string | null }[]
  onSave: (data: Partial<RecurringTransaction>) => void
  onCancel: () => void
  loading: boolean
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const sortedAccounts = useMemo(() => sortAccountsByDisplayName(accounts), [accounts])
  const { data: supportedCurrencies } = useQuery({
    queryKey: ['currencies'],
    queryFn: currenciesApi.list,
    staleTime: Infinity,
  })
  const [description, setDescription] = useState(recurring?.description ?? '')
  const [amount, setAmount] = useState(recurring?.amount?.toString() ?? '')
  const [currency, setCurrency] = useState(recurring?.currency ?? userCurrency)
  const [type, setType] = useState<'debit' | 'credit'>(recurring?.type ?? 'debit')
  const [frequency, setFrequency] = useState(recurring?.frequency ?? 'monthly')
  const [weekendAdjustment, setWeekendAdjustment] = useState<RecurringTransaction['weekend_adjustment']>(
    recurring?.weekend_adjustment ?? 'none'
  )
  const [dayOfMonth, setDayOfMonth] = useState(recurring?.day_of_month?.toString() ?? '')
  const [startDate, setStartDate] = useState(recurring?.start_date ?? localDateString())
  const [endDate, setEndDate] = useState(recurring?.end_date ?? '')
  const [categoryId, setCategoryId] = useState(recurring?.category_id ?? '')
  const [accountId, setAccountId] = useState(recurring?.account_id ?? sortedAccounts[0]?.id ?? '')
  const [isActive, setIsActive] = useState(recurring?.is_active ?? true)
  // Off by default on a new bill. Every account here is bank-synced or
  // file-imported, so the real charge always arrives on its own; generating a
  // placeholder too only writes a row the user did not make, which the matcher
  // then has to reconcile away. Editing keeps whatever the bill already stores.
  const [autoGenerate, setAutoGenerate] = useState(recurring?.auto_generate ?? false)

  const selectClass = 'w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary'

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          description,
          amount: parseFloat(amount),
          currency,
          type,
          frequency,
          weekend_adjustment: weekendAdjustment,
          day_of_month: dayOfMonth ? parseInt(dayOfMonth) : null,
          start_date: startDate,
          end_date: endDate || null,
          category_id: categoryId || null,
          account_id: accountId || null,
          is_active: isActive,
          auto_generate: autoGenerate,
        } as Partial<RecurringTransaction>)
      }}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label>{t('recurring.description')}</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} required />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.amount')}</Label>
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.currency')}</Label>
          <select className={selectClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {(supportedCurrencies ?? [{ code: userCurrency, symbol: userCurrency, name: userCurrency, flag: '' }]).map((c) => (
              <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.type')}</Label>
          <select className={selectClass} value={type} onChange={(e) => setType(e.target.value as 'debit' | 'credit')}>
            <option value="debit">{t('recurring.expense')}</option>
            <option value="credit">{t('recurring.income')}</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.frequency')}</Label>
          <select className={selectClass} value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringTransaction['frequency'])}>
            <option value="monthly">{t('recurring.monthly')}</option>
            <option value="quarterly">{t('recurring.quarterly')}</option>
            <option value="weekly">{t('recurring.weekly')}</option>
            <option value="yearly">{t('recurring.yearly')}</option>
          </select>
        </div>
        {(frequency === 'monthly' || frequency === 'quarterly') && (
          <div className="space-y-2">
            <Label>{t('recurring.dayOfMonth')}</Label>
            <Input type="number" min="1" max="31" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
          </div>
        )}
      </div>
      <div className="space-y-2">
        <Label>{t('recurring.weekendAdjustment')}</Label>
        <select
          className={selectClass}
          value={weekendAdjustment}
          onChange={(e) => setWeekendAdjustment(e.target.value as RecurringTransaction['weekend_adjustment'])}
        >
          <option value="none">{t('recurring.weekendAdjustmentNone')}</option>
          <option value="previous_friday">{t('recurring.weekendAdjustmentPreviousFriday')}</option>
          <option value="next_monday">{t('recurring.weekendAdjustmentNextMonday')}</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.startDate')}</Label>
          <DatePickerInput value={startDate} onChange={setStartDate} className="w-full justify-start" />
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.endDate')}</Label>
          <DatePickerInput value={endDate} onChange={setEndDate} placeholder={t('recurring.endDate')} className="w-full justify-start" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.category')}</Label>
          <CategorySelect
            value={categoryId}
            onChange={setCategoryId}
            categories={categories}
            groups={categoryGroups}
            currentCategory={currentCategory}
            allowNone={true}
            className={selectClass}
          />
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.account')}</Label>
          <select
            className={selectClass}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            {!accountId && <option value="" disabled>{t('recurring.noAccount')}</option>}
            {sortedAccounts.map((acc) => (
              <option key={acc.id} value={acc.id}>{getAccountName(acc)}</option>
            ))}
          </select>
        </div>
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={autoGenerate}
          onChange={(e) => setAutoGenerate(e.target.checked)}
          className="h-4 w-4 mt-0.5 rounded border-border"
        />
        <span className="text-sm text-foreground">
          {t('recurring.autoGenerate')}
          <span className="block text-xs text-muted-foreground">{t('recurring.autoGenerateHelp')}</span>
        </span>
      </label>
      {recurring && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-sm text-foreground">{t('recurring.active')}</span>
        </label>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" disabled={loading}>
          {loading ? t('common.loading') : t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}
