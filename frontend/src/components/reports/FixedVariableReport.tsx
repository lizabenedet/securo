import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChevronRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import type { CategoryTrendItem, ReportResponse } from '@/types'

export const FIXED_COLOR = '#6366F1'
export const VARIABLE_COLOR = '#F59E0B'
const INCOME_COLOR = '#10B981'

interface Props {
  data: ReportResponse | undefined
  isLoading: boolean
  currency: string
  locale: string
}

/** "2026-09" → "set/26"; other interval labels pass through untouched. */
function periodLabel(label: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(label)
  if (!match) return label
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1)
  return date.toLocaleDateString(locale, { month: 'short', year: '2-digit' })
}

/** First and last day covered by monthly or yearly labels, for the transactions link. */
export function labelRange(first: string, last: string): { from: string; to: string } | null {
  const month = /^(\d{4})-(\d{2})$/
  const year = /^(\d{4})$/
  const a = month.exec(first)
  const b = month.exec(last)
  if (a && b) {
    const lastDay = new Date(Number(b[1]), Number(b[2]), 0).getDate()
    return { from: `${a[1]}-${a[2]}-01`, to: `${b[1]}-${b[2]}-${String(lastDay).padStart(2, '0')}` }
  }
  if (year.test(first) && year.test(last)) return { from: `${first}-01-01`, to: `${last}-12-31` }
  return null
}

/** Average over the closed periods and the value of the last closed one. */
export function categoryStats(item: CategoryTrendItem, closed: number): { average: number; last: number } {
  const series = item.series.slice(0, Math.max(closed, 1))
  const sum = series.reduce((total, point) => total + point.value, 0)
  return {
    average: series.length ? sum / series.length : 0,
    last: series[series.length - 1]?.value ?? 0,
  }
}

export function FixedVariableReport({ data, isLoading, currency, locale }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { mask, privacyMode, MASK } = usePrivacyMode()

  const trend = data?.trend ?? []
  const breakdowns = Object.fromEntries((data?.summary.breakdowns ?? []).map((b) => [b.key, b.value]))
  const closed = breakdowns.closedPeriods ?? trend.length
  const hasRunningPeriod = closed < trend.length
  const categories = data?.category_trend ?? []
  const fixedItems = categories.filter((c) => c.group === 'fixed')
  const variableItems = categories.filter((c) => c.group === 'variable')
  const range = trend.length ? labelRange(trend[0].date, trend[trend.length - 1].date) : null

  const money = (value: number) => mask(formatCurrency(value, currency, locale))

  const chartData = trend.map((point) => ({
    date: point.date,
    fixed: point.breakdowns.fixed ?? 0,
    variable: point.breakdowns.variable ?? 0,
    income: point.breakdowns.income ?? 0,
  }))

  const openCategory = (key: string) => {
    if (key === 'uncategorized') return
    const params = new URLSearchParams({ category_id: key })
    if (range) {
      params.set('from', range.from)
      params.set('to', range.to)
    }
    navigate(`/transactions?${params.toString()}`)
  }

  const stats = [
    { key: 'fixedAverage', color: FIXED_COLOR, value: breakdowns.fixedAverage, format: money },
    { key: 'variableAverage', color: VARIABLE_COLOR, value: breakdowns.variableAverage, format: money },
    {
      key: 'fixedShareOfIncome',
      color: INCOME_COLOR,
      value: breakdowns.fixedShareOfIncome,
      format: (v: number) => (privacyMode ? MASK : `${v.toLocaleString(locale, { maximumFractionDigits: 1 })}%`),
    },
  ]

  // One card per block, side by side on wide screens and stacked on phones.
  const renderGroup = (title: string, color: string, items: CategoryTrendItem[]) => {
    const groupTotal = items.reduce((total, item) => total + categoryStats(item, closed).average, 0)
    const columns = 'grid grid-cols-[1fr_auto_auto_14px] items-center gap-3'
    return (
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border" style={{ borderTop: `3px solid ${color}` }}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="text-xs text-muted-foreground">{items.length}</span>
          </div>
          <span className="text-sm font-bold tabular-nums text-foreground">{money(groupTotal)}</span>
        </div>
        {items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">{t('reports.noData')}</p>
        ) : (
          <>
            <div className={`${columns} px-4 pt-2.5 pb-1.5`}>
              <span />
              <span className="text-[11px] text-muted-foreground text-right w-20 sm:w-24">{t('reports.fvMonthlyAverage')}</span>
              <span className="text-[11px] text-muted-foreground text-right w-20 sm:w-24">{t('reports.fvLastPeriod')}</span>
              <span />
            </div>
            {items.map((item) => {
              const { average, last } = categoryStats(item, closed)
              const clickable = item.key !== 'uncategorized'
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={!clickable}
                  onClick={() => openCategory(item.key)}
                  className={`${columns} w-full px-4 py-2 border-t border-border text-left hover:bg-muted/50 disabled:hover:bg-transparent transition-colors`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                    <span className="text-sm text-foreground truncate">
                      {item.key === 'uncategorized' ? t('reports.uncategorized') : item.label}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-foreground text-right w-20 sm:w-24">{money(average)}</span>
                  <span className="text-sm tabular-nums text-muted-foreground text-right w-20 sm:w-24">{money(last)}</span>
                  {clickable ? <ChevronRight size={14} className="text-muted-foreground" /> : <span />}
                </button>
              )
            })}
          </>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Hero numbers */}
      <div className="bg-card rounded-xl border border-border shadow-sm mb-5">
        <div className="px-5 py-4">
          {isLoading ? (
            <div className="flex gap-6">
              <Skeleton className="h-12 w-32" />
              <Skeleton className="h-12 w-32" />
              <Skeleton className="h-12 w-32" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-10 gap-y-4">
                {stats.map((stat) => (
                  <div key={stat.key}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: stat.color }} />
                      <p className="text-xs font-medium text-muted-foreground">{t(`reports.${stat.key}`)}</p>
                    </div>
                    <p className="text-2xl font-bold tabular-nums text-foreground">
                      {stat.value === undefined ? '—' : stat.format(stat.value)}
                    </p>
                  </div>
                ))}
              </div>
              {hasRunningPeriod && (
                <p className="text-xs text-muted-foreground mt-3">{t('reports.fvRunningNote')}</p>
              )}
              {fixedItems.length === 0 && variableItems.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">{t('reports.fvNoFixedHint')}</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Stacked bars per period, income as a line */}
      <div className="bg-card rounded-xl border border-border shadow-sm mb-5">
        <div className="px-5 pt-5 pb-2">
          <p className="text-sm font-semibold text-foreground">
            {t('reports.fixedVariable')} · {t('reports.trend')}
          </p>
        </div>
        <div className="h-[320px] px-2 pb-4">
          {isLoading ? (
            <div className="px-4 h-full"><Skeleton className="h-full w-full" /></div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => periodLabel(v, locale)}
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={(v) =>
                    privacyMode ? '' : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
                  }
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickCount={5}
                />
                <Tooltip
                  cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null
                    const row = payload[0].payload as (typeof chartData)[number]
                    const total = row.fixed + row.variable
                    return (
                      <div
                        className="px-3 py-2 text-xs"
                        style={{
                          background: 'var(--card)',
                          color: 'var(--foreground)',
                          border: '1px solid var(--border)',
                          borderRadius: '0.75rem',
                        }}
                      >
                        <p className="font-medium mb-1">{periodLabel(String(label), locale)}</p>
                        <p style={{ color: FIXED_COLOR }}>{t('reports.fixed')}: {money(row.fixed)}</p>
                        <p style={{ color: VARIABLE_COLOR }}>{t('reports.variable')}: {money(row.variable)}</p>
                        <p className="text-muted-foreground">{t('reports.expenses')}: {money(total)}</p>
                        <p style={{ color: INCOME_COLOR }}>{t('reports.income')}: {money(row.income)}</p>
                      </div>
                    )
                  }}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
                  formatter={(value: string) => t(`reports.${value}`)}
                />
                <Bar dataKey="fixed" name="fixed" stackId="spend" fill={FIXED_COLOR} isAnimationActive={false} />
                <Bar
                  dataKey="variable"
                  name="variable"
                  stackId="spend"
                  fill={VARIABLE_COLOR}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="income"
                  name="income"
                  stroke={INCOME_COLOR}
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: INCOME_COLOR }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-muted-foreground text-sm text-center py-16">{t('reports.noData')}</p>
          )}
        </div>
      </div>

      {/* Categories in each block: fixed and variable side by side */}
      {!isLoading && categories.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5 items-start">
          {renderGroup(t('reports.fixed'), FIXED_COLOR, fixedItems)}
          {renderGroup(t('reports.variable'), VARIABLE_COLOR, variableItems)}
        </div>
      )}
    </>
  )
}
