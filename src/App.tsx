import type { ComponentType, ReactNode, SVGProps } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  ChevronDown,
  CreditCard,
  Landmark,
  LoaderCircle,
  PiggyBank,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Wallet,
  X,
} from 'lucide-react'
import {
  formatCompactMoney,
  formatCurrency,
  formatDateLabel,
  formatDateInput,
  formatDateTime,
  formatMoney,
  getCurrentMonthRange,
  getDaysInMonth,
  getElapsedDays,
  getMonthName,
  type AnnualSnapshot,
  type CategorySummary,
  type FinanceAccount,
  type FinanceSnapshot,
  type FinanceTransaction,
} from './lib/finance'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

type Metric = {
  label: string
  value: string
  detail: string
  icon: IconComponent
  progress?: number
  progressTone?: 'good' | 'bad'
  support?: ReactNode
  tone: 'shield' | 'mint' | 'amber' | 'rose'
}

type SnapshotError = {
  error: string
  details?: string | null
}

type ConfigStatus = {
  apiPort: number
  hasClientId: boolean
  hasClientSecret: boolean
  hasItemId: boolean
  itemIdPreview: string | null
}

type DatePreset = 'current-month' | 'previous-month' | 'next-month' | 'custom'
type AppView = 'monthly' | 'annual'
type AnnualGoal = {
  expenseGoal: string
  investmentGoal: string
}
type AnnualGoals = Record<string, AnnualGoal>

const monthRange = getCurrentMonthRange()
const defaultMonthlyLimit = 5000
const monthlyLimitStorageKey = 'granaflow:monthly-limit'
const monthOptions = Array.from({ length: 12 }, (_, index) => ({
  label: new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(new Date(2026, index, 1)),
  value: index,
}))

function getPresetRange(preset: DatePreset) {
  const today = new Date()

  if (preset === 'previous-month') {
    return {
      dateFrom: formatDateInput(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      dateTo: formatDateInput(new Date(today.getFullYear(), today.getMonth(), 0)),
    }
  }

  if (preset === 'next-month') {
    return {
      dateFrom: formatDateInput(new Date(today.getFullYear(), today.getMonth() + 1, 1)),
      dateTo: formatDateInput(new Date(today.getFullYear(), today.getMonth() + 2, 0)),
    }
  }

  return getCurrentMonthRange()
}

function getMonthRange(year: number, monthIndex: number) {
  return {
    dateFrom: formatDateInput(new Date(year, monthIndex, 1)),
    dateTo: formatDateInput(new Date(year, monthIndex + 1, 0)),
  }
}

function getPreviousMonthRange(dateFrom: string) {
  const year = Number(dateFrom.slice(0, 4))
  const monthIndex = Number(dateFrom.slice(5, 7)) - 1

  return getMonthRange(year, monthIndex - 1)
}

function getDaysUntilMonthEnd(dateFrom: string) {
  const today = new Date()
  const year = Number(dateFrom.slice(0, 4))
  const monthIndex = Number(dateFrom.slice(5, 7)) - 1
  const monthEnd = new Date(year, monthIndex + 1, 0)
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  return Math.max(Math.ceil((monthEnd.getTime() - todayStart.getTime()) / 86_400_000), 0)
}

function getPeriodLabel(preset: DatePreset, dateFrom: string, dateTo: string) {
  if (preset === 'current-month') {
    return getMonthName(dateFrom)
  }

  if (preset === 'previous-month') {
    return getMonthName(dateFrom)
  }

  if (preset === 'next-month') {
    return getMonthName(dateFrom)
  }

  return getMonthName(dateFrom) || `${formatDateLabel(dateFrom)} - ${formatDateLabel(dateTo)}`
}

function getMetricComparison(current: number, previous?: number, mode: 'higher-is-bad' | 'higher-is-good' = 'higher-is-bad') {
  if (previous === undefined || previous === null) {
    return 'Sem comparativo'
  }

  const difference = current - previous
  if (Math.abs(difference) < 0.01) {
    return 'Igual ao mÃªs anterior'
  }

  const direction = difference > 0 ? 'acima' : 'abaixo'
  const absolute = formatCompactMoney(Math.abs(difference))

  if (mode === 'higher-is-good') {
    return `${absolute} ${difference > 0 ? 'acima' : 'abaixo'} do mÃªs anterior`
  }

  return `${absolute} ${direction} do mÃªs anterior`
}

function App() {
  const [activeView, setActiveView] = useState<AppView>(() => {
    const view = new URLSearchParams(window.location.search).get('view')
    return view === 'annual' ? 'annual' : 'monthly'
  })
  const [snapshot, setSnapshot] = useState<FinanceSnapshot | null>(null)
  const [previousSnapshot, setPreviousSnapshot] = useState<FinanceSnapshot | null>(null)
  const [dateFrom, setDateFrom] = useState(monthRange.dateFrom)
  const [dateTo, setDateTo] = useState(monthRange.dateTo)
  const [datePreset, setDatePreset] = useState<DatePreset>('current-month')
  const [customYear, setCustomYear] = useState(new Date().getFullYear())
  const [customMonth, setCustomMonth] = useState(new Date().getMonth())
  const [monthlyLimit, setMonthlyLimit] = useState(() => {
    const stored = window.localStorage.getItem(monthlyLimitStorageKey)
    const parsed = Number(stored)

    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMonthlyLimit
  })
  const [transactionSearch, setTransactionSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [accountFilter, setAccountFilter] = useState('all')
  const [budgetFilter, setBudgetFilter] = useState('all')
  const [flowFilter, setFlowFilter] = useState('all')
  const [transactionDisplayLimit, setTransactionDisplayLimit] = useState(24)
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null)
  const [isConfigOpen, setIsConfigOpen] = useState(false)
  const [isAccountsMenuOpen, setIsAccountsMenuOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadConfigStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/config')

      if (response.ok) {
        setConfigStatus((await response.json()) as ConfigStatus)
      }
    } catch {
      setConfigStatus(null)
    }
  }, [])

  const loadSnapshot = useCallback(async (showSkeleton = false) => {
    setError(null)
    setIsRefreshing(true)

    if (showSkeleton) {
      setIsLoading(true)
    }

    try {
      const params = new URLSearchParams({ dateFrom, dateTo })
      const previousRange = getPreviousMonthRange(dateFrom)
      const previousParams = new URLSearchParams(previousRange)
      const [response, previousResponse] = await Promise.all([
        fetch(`/api/pluggy/snapshot?${params.toString()}`),
        fetch(`/api/pluggy/snapshot?${previousParams.toString()}`),
      ])

      if (!response.ok) {
        const payload = (await response.json()) as SnapshotError
        throw new Error(payload.details ? `${payload.error} ${payload.details}` : payload.error)
      }

      setSnapshot((await response.json()) as FinanceSnapshot)
      setPreviousSnapshot(previousResponse.ok ? ((await previousResponse.json()) as FinanceSnapshot) : null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel carregar os dados.')
      setPreviousSnapshot(null)
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => {
    void loadSnapshot(true)
  }, [loadSnapshot])

  useEffect(() => {
    void loadConfigStatus()
  }, [loadConfigStatus])

  useEffect(() => {
    window.localStorage.setItem(monthlyLimitStorageKey, String(monthlyLimit))
  }, [monthlyLimit])

  useEffect(() => {
    setTransactionDisplayLimit(24)
  }, [accountFilter, budgetFilter, categoryFilter, dateFrom, dateTo, flowFilter, transactionSearch])

  const summary = snapshot?.summary
  const previousSummary = previousSnapshot?.summary
  const expenses = summary?.expenses ?? 0
  const investmentBalance = summary?.investmentBalance ?? 0
  const elapsedDays = getElapsedDays(dateFrom, dateTo)
  const daysInMonth = getDaysInMonth(dateTo)
  const monthProgress = Math.min((elapsedDays / daysInMonth) * 100, 100)
  const limitUsage = Math.min((expenses / monthlyLimit) * 100, 100)
  const remainingLimit = monthlyLimit - expenses
  const daysUntilMonthEnd = getDaysUntilMonthEnd(dateFrom)
  const categories = summary?.categories ?? []
  const periodLabel = getPeriodLabel(datePreset, dateFrom, dateTo)
  const maxCategory = Math.max(...categories.map((item) => item.total), 1)
  const tableCategories = useMemo(
    () => [...new Set((snapshot?.transactions ?? []).map((transaction) => transaction.category))].sort(),
    [snapshot],
  )
  const filteredTransactions = useMemo(() => {
    const search = transactionSearch.trim().toLowerCase()

    return (snapshot?.transactions ?? []).filter((transaction) => {
      const matchesSearch =
        !search ||
        transaction.description.toLowerCase().includes(search) ||
        transaction.source.toLowerCase().includes(search) ||
        transaction.category.toLowerCase().includes(search)
      const matchesCategory = categoryFilter === 'all' || transaction.category === categoryFilter
      const matchesAccount = accountFilter === 'all' || transaction.accountId === accountFilter
      const matchesBudget =
        budgetFilter === 'all' ||
        (budgetFilter === 'included' && transaction.isBudgetExpense) ||
        (budgetFilter === 'ignored' && transaction.ignoredForBudget)
      const matchesFlow =
        flowFilter === 'all' ||
        (flowFilter === 'outflow' && transaction.amount < 0) ||
        (flowFilter === 'inflow' && transaction.amount > 0)

      return matchesSearch && matchesCategory && matchesAccount && matchesBudget && matchesFlow
    })
  }, [accountFilter, budgetFilter, categoryFilter, flowFilter, snapshot, transactionSearch])
  const recentTransactions = filteredTransactions.slice(0, transactionDisplayLimit)
  const activeFilterCount = [
    transactionSearch.trim(),
    categoryFilter !== 'all',
    accountFilter !== 'all',
    budgetFilter !== 'all',
    flowFilter !== 'all',
  ].filter(Boolean).length
  const hasPluggyCredentials = Boolean(configStatus?.hasClientId && configStatus.hasClientSecret && configStatus.hasItemId)

  const metrics: Metric[] = [
    {
      label: 'Gastos em crÃ©dito',
      value: formatMoney(summary?.cardExpenses ?? 0),
      detail: getMetricComparison(summary?.cardExpenses ?? 0, previousSummary?.cardExpenses),
      icon: CreditCard,
      tone: 'rose',
    },
    {
      label: 'Gastos em dÃ©bito',
      value: formatMoney(summary?.bankExpenses ?? 0),
      detail: getMetricComparison(summary?.bankExpenses ?? 0, previousSummary?.bankExpenses),
      icon: Landmark,
      tone: 'mint',
    },
    {
      label: 'Teto de gasto',
      value: formatMoney(monthlyLimit),
      detail: getMetricComparison(expenses, previousSummary?.expenses),
      icon: Target,
      progress: limitUsage,
      progressTone: remainingLimit >= 0 ? 'good' : 'bad',
      support: (
        <div className="mt-4">
          <label htmlFor="monthly-limit" className="sr-only">
            Teto de gasto
          </label>
          <div className="flex h-10 items-center rounded-lg border border-[#263c34] bg-[#101a16] px-3">
            <span className="text-sm text-[#6f897c]">R$</span>
            <input
              id="monthly-limit"
              className="min-w-0 flex-1 bg-transparent px-2 text-sm font-semibold text-white outline-none"
              min={1}
              step={100}
              type="number"
              value={monthlyLimit}
              onChange={(event) => setMonthlyLimit(Math.max(Number(event.target.value) || defaultMonthlyLimit, 1))}
            />
          </div>
          <p className={`mt-2 text-sm font-semibold ${remainingLimit >= 0 ? 'text-[#42f08f]' : 'text-[#ff8d8d]'}`}>
            {Math.round(limitUsage)}% usado Â· {remainingLimit >= 0 ? 'restam ' : 'passou '}
            {formatCompactMoney(Math.abs(remainingLimit))}
          </p>
        </div>
      ),
      tone: 'shield',
    },
    {
      label: 'Investimentos',
      value: formatMoney(investmentBalance),
      detail: getMetricComparison(summary?.netInvestmentContribution ?? 0, previousSummary?.netInvestmentContribution, 'higher-is-good'),
      icon: PiggyBank,
      tone: 'amber',
    },
  ]

  function applyPreset(preset: DatePreset) {
    setDatePreset(preset)

    if (preset === 'custom') {
      const range = getMonthRange(customYear, customMonth)
      setDateFrom(range.dateFrom)
      setDateTo(range.dateTo)
      return
    }

    const range = getPresetRange(preset)
    setDateFrom(range.dateFrom)
    setDateTo(range.dateTo)
  }

  function updateCustomMonth(nextYear: number, nextMonth: number) {
    setDatePreset('custom')
    setCustomYear(nextYear)
    setCustomMonth(nextMonth)

    const range = getMonthRange(nextYear, nextMonth)
    setDateFrom(range.dateFrom)
    setDateTo(range.dateTo)
  }

  function clearTableFilters() {
    setTransactionSearch('')
    setCategoryFilter('all')
    setAccountFilter('all')
    setBudgetFilter('all')
    setFlowFilter('all')
  }

  function selectView(nextView: AppView) {
    setActiveView(nextView)

    const nextUrl = new URL(window.location.href)
    if (nextView === 'annual') {
      nextUrl.searchParams.set('view', 'annual')
    } else {
      nextUrl.searchParams.delete('view')
    }

    window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}`)
  }

  return (
    <main className={`${activeView === 'annual' ? 'flex h-screen flex-col overflow-hidden' : 'min-h-screen'} bg-[#070a09] text-[#edf7ef]`}>
      <header className="shrink-0 border-b border-[#17231f] bg-[#0a0f0d]">
        <div className="mx-auto flex max-w-[1560px] flex-col gap-5 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-lg border border-[#256c52] bg-[#103b2f] text-[#42f08f] shadow-[0_0_32px_rgba(33,181,112,0.25)]">
              <ShieldCheck className="size-7" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-white">GranaFlow</h1>
              <p className="text-base text-[#8ba397]">Open Finance no modo cabine de comando</p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => setIsConfigOpen(true)}
              className={`inline-flex h-11 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold transition ${
                hasPluggyCredentials
                  ? 'border-[#2f4c41] bg-[#10211b] text-[#d8ffe7] hover:border-[#39d681] hover:bg-[#123327]'
                  : 'border-[#5a3d1d] bg-[#2a1c0d] text-[#ffc46b] hover:border-[#ffc46b]'
              }`}
            >
              <Settings className="size-4" aria-hidden="true" />
              Credenciais
            </button>
            {activeView === 'monthly' ? (
              <>
                <AccountsMenu
                  accounts={snapshot?.accounts ?? []}
                  isLoading={isLoading}
                  isOpen={isAccountsMenuOpen}
                  onToggle={() => setIsAccountsMenuOpen((current) => !current)}
                />
                <DatePresetControl preset={datePreset} onPresetChange={applyPreset} />
                {datePreset === 'custom' ? (
                  <>
                    <MonthSelect value={customMonth} onChange={(value) => updateCustomMonth(customYear, value)} />
                    <YearSelect value={customYear} onChange={(value) => updateCustomMonth(value, customMonth)} />
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => void loadSnapshot(false)}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-[#2f4c41] bg-[#10211b] px-4 text-sm font-semibold text-[#d8ffe7] transition hover:border-[#39d681] hover:bg-[#123327]"
                >
                  <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                  Atualizar
                </button>
                <button
                  type="button"
                  onClick={() => selectView('annual')}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#1ebc70] px-4 text-sm font-semibold text-[#06100b] transition hover:bg-[#42f08f]"
                >
                  <BarChart3 className="size-4" aria-hidden="true" />
                  Ver ano
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => selectView('monthly')}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-[#2f4c41] bg-[#10211b] px-4 text-base font-semibold text-[#d8ffe7] transition hover:border-[#39d681] hover:bg-[#123327]"
              >
                <Wallet className="size-4 text-[#42f08f]" aria-hidden="true" />
                Voltar ao mensal
              </button>
            )}
          </div>
        </div>
      </header>

      {activeView === 'annual' ? (
        <AnnualView />
      ) : (
      <div className="mx-auto max-w-[1560px] px-4 py-6 sm:px-6 lg:px-8">
        <section className="space-y-6">
          {error ? <ErrorBanner message={error} /> : null}
          {!hasPluggyCredentials ? (
            <section className="rounded-lg border border-[#5a3d1d] bg-[#1b140d] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase text-[#ffc46b]">Pluggy pendente</p>
                  <p className="mt-1 text-base text-[#d8c3a0]">Configure as credenciais para carregar dados reais.</p>
                </div>
                <button
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#6b4a24] bg-[#2a1c0d] px-3 text-sm font-semibold text-[#ffc46b] transition hover:border-[#ffc46b]"
                  type="button"
                  onClick={() => setIsConfigOpen(true)}
                >
                  <Settings className="size-4" aria-hidden="true" />
                  Configurar
                </button>
              </div>
            </section>
          ) : null}

          <section className="relative overflow-hidden rounded-lg border border-[#214236] bg-[#080d0b] shadow-[0_30px_90px_rgba(0,0,0,0.28)]">
            <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(28,188,112,0.12),rgba(8,13,11,0)_36%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0)_22%)]" />
            <div className="relative p-5 sm:p-6">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label={snapshot?.item.executionStatus ?? 'SYNC'} />
                <span className="rounded-md border border-[#2d5144] bg-[#101a16]/90 px-2 py-1 text-xs font-semibold text-[#8ba397] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  {periodLabel}
                </span>
                <span className="rounded-md border border-[#2d5144] bg-[#101a16]/90 px-2 py-1 text-xs font-semibold text-[#6f897c] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  Sync {formatDateTime(snapshot?.item.updatedAt)}
                </span>
              </div>
              <div className="mt-8 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <p className="text-base font-medium text-[#8ba397]">Gasto total do mês</p>
                  <p className="mt-2 text-4xl font-semibold text-white sm:text-5xl">{formatMoney(expenses)}</p>
                </div>
                <div className="min-w-[260px]">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-[#8ba397]">Progresso do mês</span>
                    <span className="font-semibold text-[#42f08f]">{Math.round(monthProgress)}%</span>
                  </div>
                  <div className="mt-3 h-3 overflow-hidden rounded-full bg-[#17231f]">
                    <div className="h-full rounded-full bg-[#42f08f]" style={{ width: `${monthProgress}%` }} />
                  </div>
                  <p className="mt-2 text-sm font-medium text-[#6f897c]">
                    {daysUntilMonthEnd} {daysUntilMonthEnd === 1 ? 'dia' : 'dias'} até o fim do mês
                  </p>
                </div>
              </div>
            </div>
          </section>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {isLoading
              ? Array.from({ length: 4 }, (_, index) => <MetricSkeleton key={index} />)
              : metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}
          </div>

          <section className="rounded-lg border border-[#203a31] bg-[#09100d]/95 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-xl font-semibold text-white">Categorias do orçamento</h2>
            </div>

            <div className="mt-6 space-y-4">
              {categories.length ? (
                categories.map((category, index) => (
                  <CategoryBar key={category.name} category={category} index={index} max={maxCategory} />
                ))
              ) : (
                <EmptyState label={isLoading ? 'Carregando categorias' : 'Sem gastos nesse periodo'} />
              )}
            </div>
          </section>

          <section className="rounded-lg border border-[#203a31] bg-[#09100d]/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            <div className="flex flex-col gap-2 border-b border-[#203a31] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">MovimentaÃ§Ãµes</h2>
                <p className="text-base text-[#8ba397]">
                  Mostrando {recentTransactions.length} de {filteredTransactions.length}
                  {activeFilterCount ? ` Â· ${activeFilterCount} filtro${activeFilterCount > 1 ? 's' : ''}` : ''}
                </p>
              </div>
              <button
                onClick={clearTableFilters}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-sm font-semibold text-[#d8ffe7] hover:border-[#39d681]"
                type="button"
              >
                <X className="size-4" aria-hidden="true" />
                Limpar
              </button>
            </div>

            <div className="grid gap-3 border-b border-[#203a31] p-5 lg:grid-cols-[minmax(240px,1.4fr)_repeat(4,minmax(140px,1fr))]">
              <label className="flex h-12 items-center gap-2 rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-base text-[#8ba397]">
                <Search className="size-4 text-[#42f08f]" aria-hidden="true" />
                <span className="sr-only">Buscar transacao</span>
                <input
                  className="min-w-0 flex-1 bg-transparent font-semibold text-[#edf7ef] outline-none placeholder:text-[#5f766b]"
                  placeholder="Buscar descricao, origem..."
                  value={transactionSearch}
                  onChange={(event) => setTransactionSearch(event.target.value)}
                />
              </label>
              <FilterSelect label="Categoria" value={categoryFilter} onChange={setCategoryFilter}>
                <option value="all">Todas categorias</option>
                {tableCategories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect label="Conta" value={accountFilter} onChange={setAccountFilter}>
                <option value="all">Todas contas</option>
                {snapshot?.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.marketingName || account.name}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect label="Orcamento" value={budgetFilter} onChange={setBudgetFilter}>
                <option value="all">Orcamento: todos</option>
                <option value="included">Incluidos</option>
                <option value="ignored">Fora do orcamento</option>
              </FilterSelect>
              <FilterSelect label="Fluxo" value={flowFilter} onChange={setFlowFilter}>
                <option value="all">Entrada e saida</option>
                <option value="outflow">Saidas</option>
                <option value="inflow">Entradas</option>
              </FilterSelect>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-base">
                <thead className="bg-[#101a16] text-sm font-semibold uppercase text-[#6f897c]">
                  <tr>
                    <th className="px-4 py-3">Data</th>
                    <th className="px-4 py-3">Descricao</th>
                    <th className="px-4 py-3">Categoria</th>
                    <th className="px-4 py-3">Origem</th>
                    <th className="px-4 py-3">Orcamento</th>
                    <th className="px-4 py-3 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#16231e]">
                  {recentTransactions.length ? (
                    recentTransactions.map((transaction) => (
                      <TransactionRow key={transaction.id} transaction={transaction} />
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="px-4 py-12">
                        <EmptyState label={isLoading ? 'Carregando transacoes' : 'Nada encontrado nesse periodo'} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {filteredTransactions.length > recentTransactions.length ? (
              <div className="border-t border-[#203a31] p-4 text-center">
                <button
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-[#263c34] bg-[#101a16] px-4 text-sm font-semibold text-[#d8ffe7] transition hover:border-[#39d681] hover:bg-[#123327]"
                  type="button"
                  onClick={() => setTransactionDisplayLimit((current) => current + 24)}
                >
                  Mostrar mais {Math.min(24, filteredTransactions.length - recentTransactions.length)}
                </button>
              </div>
            ) : null}
          </section>
        </section>

      </div>
      )}

      {isConfigOpen ? (
        <CredentialsModal
          status={configStatus}
          onClose={() => setIsConfigOpen(false)}
          onSaved={(status) => {
            setConfigStatus(status)
            setIsConfigOpen(false)
            void loadSnapshot(false)
          }}
        />
      ) : null}
    </main>
  )
}

function AnnualView() {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [annual, setAnnual] = useState<AnnualSnapshot | null>(null)
  const [goals, setGoals] = useState<AnnualGoals>({})
  const [selectedMonthKey, setSelectedMonthKey] = useState<string | null>(null)
  const [isAnnualGoalsMenuOpen, setIsAnnualGoalsMenuOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const storageKey = `granaflow:annual-goals:${year}`

  const loadAnnual = useCallback(async () => {
    setError(null)
    setIsRefreshing(true)
    setIsLoading(true)

    try {
      const response = await fetch(`/api/pluggy/annual?year=${year}`)

      if (!response.ok) {
        const payload = (await response.json()) as SnapshotError
        throw new Error(payload.details ? `${payload.error} ${payload.details}` : payload.error)
      }

      setAnnual((await response.json()) as AnnualSnapshot)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel carregar a visao anual.')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [year])

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey)
    setGoals(stored ? (JSON.parse(stored) as AnnualGoals) : {})
    setIsDirty(false)
    setIsAnnualGoalsMenuOpen(false)
    setSavedAt(null)
  }, [storageKey])

  useEffect(() => {
    void loadAnnual()
  }, [loadAnnual])

  const annualPlan = useMemo(() => buildAnnualPlan(annual, goals), [annual, goals])
  const defaultSelectedMonthKey = useMemo(
    () =>
      annualPlan.months.find((month) => month.isCurrent)?.key ??
      annualPlan.months.find((month) => month.isFuture)?.key ??
      annualPlan.months[0]?.key ??
      null,
    [annualPlan.months],
  )
  const selectedMonth = annualPlan.months.find((month) => month.key === selectedMonthKey) ?? annualPlan.months.find((month) => month.key === defaultSelectedMonthKey) ?? null
  const currentGrossAmount = (annual?.current.accountBalance ?? 0) + (annual?.current.investmentBalance ?? 0)
  const projectedInvestmentDecember =
    (annual?.current.investmentBalance ?? 0) +
    annualPlan.months.reduce((sum, month) => sum + (month.isFuture ? month.projectedInvestment : 0), 0)

  useEffect(() => {
    if (!defaultSelectedMonthKey) {
      return
    }

    setSelectedMonthKey((current) => (
      current && annualPlan.months.some((month) => month.key === current) ? current : defaultSelectedMonthKey
    ))
  }, [annualPlan.months, defaultSelectedMonthKey])

  function updateGoal(monthKey: string, field: keyof AnnualGoal, value: string) {
    setGoals((current) => ({
      ...current,
      [monthKey]: {
        expenseGoal: current[monthKey]?.expenseGoal ?? '',
        investmentGoal: current[monthKey]?.investmentGoal ?? '',
        [field]: value,
      },
    }))
    setIsDirty(true)
  }

  function saveGoals() {
    window.localStorage.setItem(storageKey, JSON.stringify(goals))
    setIsDirty(false)
    setSavedAt(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3 py-3 sm:px-5">
      <section
        className="relative overflow-hidden rounded-lg border border-[#214236] bg-[#080d0b] shadow-[0_30px_90px_rgba(0,0,0,0.46)]"
        style={{
          aspectRatio: '16 / 9',
          width: 'min(calc(100vw - 1.5rem), calc((100vh - 8rem) * 16 / 9))',
        }}
      >
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(28,188,112,0.13),rgba(8,13,11,0)_34%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0)_18%)]" />

        <div className="relative grid h-full grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 sm:p-4 lg:gap-4 lg:p-5">
          <div className="flex min-h-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label={annual?.item.executionStatus ?? 'SYNC'} />
                <span className="rounded-md border border-[#2d5144] bg-[#101a16]/90 px-2 py-1 text-xs font-semibold text-[#8ba397] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  Planejamento anual
                </span>
              </div>
              <h2 className="mt-2 truncate text-2xl font-semibold text-white lg:text-3xl">Visao anual de {year}</h2>
              <p className="hidden max-w-2xl text-sm text-[#8ba397] md:block">
                Selecione um mes no grafico para editar metas e ver a projecao.
              </p>
            </div>

            <div className="hidden min-w-0 grid-cols-4 gap-2 xl:grid">
              <AnnualTopMetric label="Montante atual" value={formatCompactMoney(currentGrossAmount)} tone="mint" />
              <AnnualTopMetric label="Investimento atual" value={formatCompactMoney(annual?.current.investmentBalance ?? 0)} tone="shield" />
              <AnnualTopMetric label="Gasto atual" value={formatCompactMoney(annualPlan.actualExpenseTotal)} tone="rose" />
              <AnnualTopMetric label="Invest. proj. dez." value={formatCompactMoney(projectedInvestmentDecember)} tone="amber" />
            </div>

            <div className="relative flex shrink-0 items-start gap-2">
              <div className="relative hidden flex-col gap-2 sm:flex">
                <label className="flex h-10 items-center gap-2 rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-sm text-[#8ba397]">
                  <Calendar className="size-4 text-[#42f08f]" aria-hidden="true" />
                  <span className="sr-only">Ano</span>
                  <input
                    className="w-20 bg-transparent font-semibold text-[#edf7ef] outline-none"
                    min={2020}
                    max={currentYear + 5}
                    type="number"
                    value={year}
                    onChange={(event) => setYear(Number(event.target.value))}
                  />
                </label>
                <button
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-xs font-semibold text-[#8ba397] transition hover:border-[#39d681] hover:text-[#d8ffe7]"
                  type="button"
                  onClick={() => setIsAnnualGoalsMenuOpen((current) => !current)}
                >
                  <SlidersHorizontal className="size-4 text-[#42f08f]" aria-hidden="true" />
                  Metas
                </button>

                {isAnnualGoalsMenuOpen ? (
                  <AnnualGoalsMenu
                    isDirty={isDirty}
                    months={annualPlan.months}
                    savedAt={savedAt}
                    onGoalChange={updateGoal}
                    onSave={saveGoals}
                  />
                ) : null}
              </div>
              <button
                className="grid size-10 place-items-center rounded-lg border border-[#2f4c41] bg-[#10211b] text-[#d8ffe7] transition hover:border-[#39d681] hover:bg-[#123327]"
                type="button"
                title="Atualizar"
                onClick={() => void loadAnnual()}
              >
                <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span className="sr-only">Atualizar</span>
              </button>
              <button
                className="grid size-10 place-items-center rounded-lg bg-[#1ebc70] text-[#06100b] transition hover:bg-[#42f08f]"
                type="button"
                title="Salvar metas"
                onClick={saveGoals}
              >
                <Save className="size-4" aria-hidden="true" />
                <span className="sr-only">Salvar metas</span>
              </button>
            </div>
          </div>

          <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
            <AnnualInteractiveGraph
              isLoading={isLoading}
              maxValue={annualPlan.maxGraphValue}
              months={annualPlan.months}
              selectedMonthKey={selectedMonth?.key ?? null}
              onSelectMonth={setSelectedMonthKey}
            />

            <AnnualMonthFocus
              currentNetBalance={annual?.current.netBalance ?? 0}
              isLoading={isLoading}
              month={selectedMonth}
            />
          </div>

          {error ? (
            <div className="absolute inset-x-4 bottom-4">
              <ErrorBanner message={error} />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

type AnnualPlanMonth = AnnualSnapshot['months'][number] & {
  expenseGoal: string
  expenseGoalValue: number
  expenseGoalLineValue: number
  investmentGoal: string
  investmentGoalValue: number
  investmentGoalLineValue: number
  projectedExpense: number
  projectedInvestment: number
  projectedBalance: number | null
}

type AnnualChartTooltip = {
  detail: string
  title: string
  tone: 'amber' | 'blue' | 'green' | 'red'
  value: string
  x: number
  y: number
}

function CredentialsModal({
  onClose,
  onSaved,
  status,
}: {
  onClose: () => void
  onSaved: (status: ConfigStatus) => void
  status: ConfigStatus | null
}) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [itemId, setItemId] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function saveConfig() {
    setIsSaving(true)
    setMessage(null)

    try {
      const response = await fetch('/api/config', {
        body: JSON.stringify({ clientId, clientSecret, itemId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.details ? `${payload.error} ${payload.details}` : payload.error)
      }

      onSaved(payload as ConfigStatus)
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Nao foi possivel salvar as credenciais.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#030504]/75 p-4 backdrop-blur-sm">
      <section className="w-full max-w-xl rounded-lg border border-[#244438] bg-[#09100d] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-white">Credenciais Pluggy</h2>
            <p className="mt-1 text-sm text-[#8ba397]">Salva em `.env.local` nesta maquina.</p>
          </div>
          <button
            className="grid size-10 place-items-center rounded-lg border border-[#263c34] bg-[#101a16] text-[#8ba397] transition hover:border-[#39d681] hover:text-white"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Fechar</span>
          </button>
        </div>

        <div className="mt-5 grid gap-3">
          <CredentialField
            label="Client ID"
            placeholder={status?.hasClientId ? 'Ja configurado; deixe vazio para manter' : 'Pluggy Client ID'}
            value={clientId}
            onChange={setClientId}
          />
          <CredentialField
            label="Client Secret"
            placeholder={status?.hasClientSecret ? 'Ja configurado; deixe vazio para manter' : 'Pluggy Client Secret'}
            type="password"
            value={clientSecret}
            onChange={setClientSecret}
          />
          <CredentialField
            label="Item ID"
            placeholder={status?.itemIdPreview ?? 'Pluggy Item ID'}
            value={itemId}
            onChange={setItemId}
          />
        </div>

        {message ? (
          <div className="mt-4 rounded-lg border border-[#563032] bg-[#251113] px-3 py-2 text-sm text-[#ffb8b8]">
            {message}
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          <p className="text-xs text-[#6f897c]">
            O secret nao e exibido depois de salvo. Campos vazios mantem o valor atual.
          </p>
          <button
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#1ebc70] px-4 text-sm font-semibold text-[#06100b] transition hover:bg-[#42f08f] disabled:cursor-wait disabled:opacity-70"
            disabled={isSaving}
            type="button"
            onClick={() => void saveConfig()}
          >
            {isSaving ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            Salvar
          </button>
        </div>
      </section>
    </div>
  )
}

function CredentialField({
  label,
  onChange,
  placeholder,
  type = 'text',
  value,
}: {
  label: string
  onChange: (value: string) => void
  placeholder: string
  type?: 'number' | 'password' | 'text'
  value: string
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-[#8ba397]">{label}</span>
      <input
        className="mt-2 h-11 w-full rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-sm font-semibold text-[#edf7ef] outline-none transition placeholder:text-[#4f675b] focus:border-[#42f08f]"
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function buildAnnualPlan(annual: AnnualSnapshot | null, goals: AnnualGoals) {
  const months = annual?.months ?? []
  const actualMonths = months.filter((month) => !month.isFuture && month.summary.transactionCount > 0)
  const actualExpenseTotal = actualMonths.reduce((sum, month) => sum + month.summary.expenses, 0)
  const actualInvestmentTotal = actualMonths.reduce((sum, month) => sum + month.summary.netInvestmentContribution, 0)
  const averageExpense = actualMonths.length ? actualExpenseTotal / actualMonths.length : 0
  const averageInvestment = actualMonths.length ? actualInvestmentTotal / actualMonths.length : 0
  let projectedBalance = annual?.current.netBalance ?? 0
  let projectedExpenseTotal = 0
  let projectedInvestmentTotal = 0

  const plannedMonths: AnnualPlanMonth[] = months.map((month) => {
    const goal = goals[month.key] ?? { expenseGoal: '', investmentGoal: '' }
    const expenseGoalValue = parseGoal(goal.expenseGoal)
    const investmentGoalValue = parseGoal(goal.investmentGoal)
    const expenseBaseline = expenseGoalValue || averageExpense
    const investmentBaseline = investmentGoalValue || averageInvestment
    const projectedExpense = month.isFuture
      ? Math.max(month.summary.expenses, expenseBaseline)
      : month.summary.expenses
    const projectedInvestment = month.isFuture
      ? Math.max(month.summary.netInvestmentContribution, investmentBaseline)
      : month.summary.netInvestmentContribution

    projectedExpenseTotal += projectedExpense
    projectedInvestmentTotal += projectedInvestment

    if (month.isFuture) {
      projectedBalance += projectedInvestment - projectedExpense
    }

    return {
      ...month,
      expenseGoal: goal.expenseGoal,
      expenseGoalLineValue: expenseGoalValue || projectedExpense,
      expenseGoalValue,
      investmentGoal: goal.investmentGoal,
      investmentGoalLineValue: investmentGoalValue || Math.max(projectedInvestment, 0),
      investmentGoalValue,
      projectedBalance: month.isFuture ? projectedBalance : null,
      projectedExpense,
      projectedInvestment,
    }
  })
  const maxGraphValue = Math.max(
    ...plannedMonths.flatMap((month) => [
      month.projectedExpense,
      Math.abs(month.projectedInvestment),
      month.expenseGoalLineValue,
      month.investmentGoalLineValue,
    ]),
    1,
  )

  return {
    actualExpenseTotal,
    actualInvestmentTotal,
    maxGraphValue,
    months: plannedMonths,
    projectedEndingBalance: projectedBalance,
    projectedExpenseTotal,
    projectedInvestmentTotal,
  }
}

function parseGoal(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function AnnualTopMetric({
  label,
  tone,
  value,
}: {
  label: string
  tone: 'amber' | 'mint' | 'rose' | 'shield'
  value: string
}) {
  const toneClass = {
    amber: 'text-[#ffc46b]',
    mint: 'text-[#75f4dc]',
    rose: 'text-[#ff8d8d]',
    shield: 'text-[#42f08f]',
  }[tone]

  return (
    <div className="min-w-28 rounded-lg border border-[#244438] bg-[#0d1512]/92 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <p className="truncate text-xs font-semibold uppercase text-[#6f897c]">{label}</p>
      <p className={`mt-1 truncate text-lg font-semibold ${toneClass}`}>{value}</p>
    </div>
  )
}

function AnnualInteractiveGraph({
  isLoading,
  maxValue,
  months,
  selectedMonthKey,
  onSelectMonth,
}: {
  isLoading: boolean
  maxValue: number
  months: AnnualPlanMonth[]
  selectedMonthKey: string | null
  onSelectMonth: (monthKey: string) => void
}) {
  const selectedMonth = months.find((month) => month.key === selectedMonthKey)
  const [tooltip, setTooltip] = useState<AnnualChartTooltip | null>(null)

  return (
    <section className="relative min-h-0 overflow-hidden rounded-lg border border-[#203a31] bg-[#09100d]/95 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] lg:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold text-white lg:text-xl">Fluxo anual composto</h3>
          <p className="hidden text-sm text-[#6f897c] sm:block">Meses futuros mostram projecao; realizado aparece so ate o mes atual.</p>
        </div>
        <div className="hidden shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs font-semibold text-[#8ba397] md:flex">
          <span className="inline-flex items-center gap-1"><span className="size-2 bg-[#42f08f]" />Invest. real</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 bg-[#ff5f64]" />Gasto real</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[#4aa3ff]" />Meta inv.</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[#ffd166]" />Meta gasto</span>
        </div>
      </div>

      <div className="relative mt-3 h-[calc(100%-3.5rem)] min-h-0">
        {isLoading ? (
          <div className="absolute inset-0 z-10 grid place-items-center rounded-lg bg-[#09100d]/80">
            <div className="inline-flex items-center gap-2 rounded-lg border border-[#263c34] bg-[#101a16] px-4 py-3 text-sm font-semibold text-[#d8ffe7]">
              <LoaderCircle className="size-4 animate-spin text-[#42f08f]" aria-hidden="true" />
              Carregando
            </div>
          </div>
        ) : null}

        {!isLoading && !months.length ? (
          <div className="absolute inset-0 grid place-items-center">
            <EmptyState label="Nenhum mes carregado" />
          </div>
        ) : null}

        <AnnualCompositeChart
          maxValue={maxValue}
          months={months}
          selectedMonthKey={selectedMonthKey}
          tooltip={tooltip}
          onSelectMonth={onSelectMonth}
          onTooltipChange={setTooltip}
        />
      </div>

      {selectedMonth ? (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-lg border border-[#1a2b25] bg-[#0b1410]/90 px-3 py-2 text-xs text-[#8ba397] backdrop-blur md:hidden">
          <span className="font-semibold capitalize text-white">{selectedMonth.label}</span>
          <span className="ml-2 text-[#ff8d8d]">{formatCompactMoney(selectedMonth.projectedExpense)}</span>
          <span className="ml-2 text-[#42f08f]">{formatCompactMoney(selectedMonth.projectedInvestment)}</span>
        </div>
      ) : null}
    </section>
  )
}

function AnnualCompositeChart({
  maxValue,
  months,
  selectedMonthKey,
  tooltip,
  onSelectMonth,
  onTooltipChange,
}: {
  maxValue: number
  months: AnnualPlanMonth[]
  selectedMonthKey: string | null
  tooltip: AnnualChartTooltip | null
  onSelectMonth: (monthKey: string) => void
  onTooltipChange: (tooltip: AnnualChartTooltip | null) => void
}) {
  const width = 1000
  const height = 560
  const left = 56
  const right = 34
  const top = 28
  const bottom = 62
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const axisY = top + plotHeight / 2
  const halfHeight = plotHeight / 2 - 18
  const safeMax = Math.max(maxValue, 1) * 1.12
  const monthStep = months.length ? plotWidth / months.length : plotWidth
  const barWidth = Math.min(52, Math.max(34, monthStep * 0.62))
  const investmentPoints = months.map((month, index) => {
    const x = left + monthStep * (index + 0.5)
    return {
      month,
      x,
      y: axisY - (month.investmentGoalLineValue / safeMax) * halfHeight,
    }
  })
  const expensePoints = months.map((month, index) => {
    const x = left + monthStep * (index + 0.5)
    return {
      month,
      x,
      y: axisY + (month.expenseGoalLineValue / safeMax) * halfHeight,
    }
  })
  const investmentPath = investmentPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
  const expensePath = expensePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')

  function positiveY(value: number) {
    return axisY - (Math.max(value, 0) / safeMax) * halfHeight
  }

  function negativeY(value: number) {
    return axisY + (Math.max(value, 0) / safeMax) * halfHeight
  }

  function showTooltip(nextTooltip: AnnualChartTooltip) {
    onTooltipChange(nextTooltip)
  }

  function selectMonth(monthKey: string) {
    onSelectMonth(monthKey)
  }

  return (
    <svg
      className="h-full w-full rounded-lg bg-[#07100c]"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      onMouseLeave={() => onTooltipChange(null)}
    >
      <defs>
        <pattern id="annual-green-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="#08100d" />
          <line x1="0" x2="0" y1="0" y2="5" stroke="#42f08f" strokeOpacity="0.72" strokeWidth="0.85" />
        </pattern>
        <pattern id="annual-red-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="#08100d" />
          <line x1="0" x2="0" y1="0" y2="5" stroke="#ff5f64" strokeOpacity="0.74" strokeWidth="0.85" />
        </pattern>
        <filter id="annual-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <title>Grafico anual com investimentos positivos, gastos negativos e linhas de metas mensais</title>

      {[0.25, 0.5, 0.75].map((ratio) => (
        <g key={ratio}>
          <line x1={left} x2={width - right} y1={axisY - halfHeight * ratio} y2={axisY - halfHeight * ratio} stroke="#1b382f" strokeDasharray="4 12" strokeOpacity="0.86" />
          <line x1={left} x2={width - right} y1={axisY + halfHeight * ratio} y2={axisY + halfHeight * ratio} stroke="#1b382f" strokeDasharray="4 12" strokeOpacity="0.86" />
        </g>
      ))}

      <line x1={left} x2={width - right} y1={axisY} y2={axisY} stroke="#6b8b7b" strokeOpacity="0.72" strokeWidth="1.2" />
      <text x={left} y={axisY - halfHeight - 8} fill="#42f08f" fontSize="12" fontWeight="700">{formatCompactMoney(safeMax)}</text>
      <text x={left} y={axisY + halfHeight + 18} fill="#ff8d8d" fontSize="12" fontWeight="700">-{formatCompactMoney(safeMax)}</text>

      {months.map((month, index) => {
        const x = left + monthStep * (index + 0.5)
        const investmentValue = Math.max(month.projectedInvestment, 0)
        const investmentY = positiveY(investmentValue)
        const investmentHeight = axisY - investmentY
        const expenseY = axisY
        const expenseHeight = negativeY(month.projectedExpense) - axisY
        const isSelected = month.key === selectedMonthKey
        const expenseLabel = month.isFuture ? 'Gasto projetado' : 'Gasto realizado'
        const investmentLabel = month.isFuture ? 'Invest. projetado' : 'Investido realizado'
        const shouldRenderBars = !month.isFuture

        return (
          <g key={month.key}>
            {isSelected ? (
              <rect
                fill="#0e211a"
                height={plotHeight + 36}
                opacity="0.84"
                stroke="#42f08f"
                strokeOpacity="0.42"
                width={monthStep * 0.88}
                x={x - monthStep * 0.44}
                y={top - 4}
              />
            ) : null}

            {shouldRenderBars ? (
              <>
                <rect
                  className="cursor-pointer transition-opacity hover:opacity-90"
                  fill="url(#annual-green-hatch)"
                  height={Math.max(investmentHeight, investmentValue ? 2 : 0)}
                  stroke="#42f08f"
                  strokeOpacity="0.96"
                  strokeWidth="3.2"
                  width={barWidth}
                  x={x - barWidth / 2}
                  y={investmentY}
                  onClick={() => selectMonth(month.key)}
                  onMouseEnter={() => {
                    selectMonth(month.key)
                    showTooltip({
                      detail: month.label,
                      title: investmentLabel,
                      tone: 'green',
                      value: formatMoney(investmentValue),
                      x,
                      y: investmentY,
                    })
                  }}
                >
                  <title>{`${month.label} ${investmentLabel.toLowerCase()}: ${formatMoney(investmentValue)}`}</title>
                </rect>

                <rect
                  className="cursor-pointer transition-opacity hover:opacity-90"
                  fill="url(#annual-red-hatch)"
                  height={Math.max(expenseHeight, month.projectedExpense ? 2 : 0)}
                  stroke="#ff5f64"
                  strokeOpacity="0.96"
                  strokeWidth="3.2"
                  width={barWidth}
                  x={x - barWidth / 2}
                  y={expenseY}
                  onClick={() => selectMonth(month.key)}
                  onMouseEnter={() => {
                    selectMonth(month.key)
                    showTooltip({
                      detail: month.label,
                      title: expenseLabel,
                      tone: 'red',
                      value: `-${formatMoney(month.projectedExpense)}`,
                      x,
                      y: expenseY + expenseHeight,
                    })
                  }}
                >
                  <title>{`${month.label} ${expenseLabel.toLowerCase()}: -${formatMoney(month.projectedExpense)}`}</title>
                </rect>
              </>
            ) : null}

            <text x={x} y={height - 26} fill="#edf7ef" fontSize="13" fontWeight="700" textAnchor="middle">
              {month.label}
            </text>
            <circle cx={x} cy={height - 12} fill={month.isFuture ? '#ffd166' : month.isCurrent ? '#75f4dc' : '#42f08f'} r="3" />
          </g>
        )
      })}

      <path d={investmentPath} fill="none" filter="url(#annual-glow)" pointerEvents="none" stroke="#4aa3ff" strokeDasharray="2 9" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d={expensePath} fill="none" filter="url(#annual-glow)" pointerEvents="none" stroke="#ffd166" strokeDasharray="2 9" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />

      {investmentPoints.map((point) => (
        <circle
          key={`investment-goal-${point.month.key}`}
          className="cursor-pointer"
          cx={point.x}
          cy={point.y}
          fill="#08100d"
          r="6"
          stroke="#4aa3ff"
          strokeWidth="3"
          onClick={() => selectMonth(point.month.key)}
          onMouseEnter={() => {
            selectMonth(point.month.key)
            showTooltip({
              detail: point.month.label,
              title: 'Meta investimento',
              tone: 'blue',
              value: formatMoney(point.month.investmentGoalLineValue),
              x: point.x,
              y: point.y,
            })
          }}
        >
          <title>{`${point.month.label} meta investimento: ${formatMoney(point.month.investmentGoalLineValue)}`}</title>
        </circle>
      ))}

      {expensePoints.map((point) => (
        <circle
          key={`expense-goal-${point.month.key}`}
          className="cursor-pointer"
          cx={point.x}
          cy={point.y}
          fill="#08100d"
          r="6"
          stroke="#ffd166"
          strokeWidth="3"
          onClick={() => selectMonth(point.month.key)}
          onMouseEnter={() => {
            selectMonth(point.month.key)
            showTooltip({
              detail: point.month.label,
              title: 'Meta gasto',
              tone: 'amber',
              value: `-${formatMoney(point.month.expenseGoalLineValue)}`,
              x: point.x,
              y: point.y,
            })
          }}
        >
          <title>{`${point.month.label} meta gasto: -${formatMoney(point.month.expenseGoalLineValue)}`}</title>
        </circle>
      ))}

      <AnnualSvgTooltip tooltip={tooltip} />
    </svg>
  )
}

function AnnualSvgTooltip({ tooltip }: { tooltip: AnnualChartTooltip | null }) {
  if (!tooltip) {
    return null
  }

  const tooltipWidth = 176
  const tooltipHeight = 58
  const boxX = tooltip.x > 780 ? tooltip.x - tooltipWidth - 14 : tooltip.x + 14
  const boxY = tooltip.y < 92 ? tooltip.y + 18 : tooltip.y - tooltipHeight - 14
  const toneClass = {
    amber: '#ffd166',
    blue: '#4aa3ff',
    green: '#42f08f',
    red: '#ff8d8d',
  }[tooltip.tone]

  return (
    <g pointerEvents="none">
      <rect
        fill="#0b1410"
        height={tooltipHeight}
        opacity="0.96"
        stroke={toneClass}
        strokeOpacity="0.65"
        width={tooltipWidth}
        x={boxX}
        y={boxY}
      />
      <text fill="#8ba397" fontSize="12" fontWeight="700" x={boxX + 12} y={boxY + 19}>
        {tooltip.title.toUpperCase()} Â· {tooltip.detail}
      </text>
      <text fill={toneClass} fontSize="18" fontWeight="800" x={boxX + 12} y={boxY + 43}>
        {tooltip.value}
      </text>
    </g>
  )
}

function AnnualGoalsMenu({
  isDirty,
  months,
  savedAt,
  onGoalChange,
  onSave,
}: {
  isDirty: boolean
  months: AnnualPlanMonth[]
  savedAt: string | null
  onGoalChange: (monthKey: string, field: keyof AnnualGoal, value: string) => void
  onSave: () => void
}) {
  return (
    <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[620px] max-w-[calc(100vw-2rem)] rounded-lg border border-[#244438] bg-[#09100d]/98 p-3 shadow-[0_24px_70px_rgba(0,0,0,0.48)] backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Metas do ano</h3>
          <p className="text-xs text-[#6f897c]">Gasto e investimento por mes</p>
        </div>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#1ebc70] px-3 text-xs font-semibold text-[#06100b] transition hover:bg-[#42f08f]"
          type="button"
          onClick={onSave}
        >
          <Save className="size-4" aria-hidden="true" />
          Salvar
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {months.map((month) => (
          <article key={month.key} className="rounded-md border border-[#16231e] bg-[#0d1512] p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold capitalize text-white">{month.label}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${month.isFuture ? 'bg-[#241a0e] text-[#ffc46b]' : 'bg-[#103b2f] text-[#42f08f]'}`}>
                {month.isFuture ? 'Futuro' : month.isCurrent ? 'Atual' : 'Real'}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <AnnualGoalCompactInput
                label="Gasto"
                placeholder={String(Math.round(month.projectedExpense))}
                tone="rose"
                value={month.expenseGoal}
                onChange={(value) => onGoalChange(month.key, 'expenseGoal', value)}
              />
              <AnnualGoalCompactInput
                label="Invest."
                placeholder={String(Math.round(Math.max(month.projectedInvestment, 0)))}
                tone="shield"
                value={month.investmentGoal}
                onChange={(value) => onGoalChange(month.key, 'investmentGoal', value)}
              />
            </div>
          </article>
        ))}
      </div>

      <p className="mt-3 min-h-4 text-xs text-[#6f897c]">
        {isDirty ? 'Metas alteradas ainda nao salvas.' : savedAt ? `Metas salvas as ${savedAt}.` : 'Metas salvas neste navegador.'}
      </p>
    </div>
  )
}

function AnnualGoalCompactInput({
  label,
  onChange,
  placeholder,
  tone,
  value,
}: {
  label: string
  onChange: (value: string) => void
  placeholder: string
  tone: 'rose' | 'shield'
  value: string
}) {
  const toneClass = tone === 'rose' ? 'text-[#ff8d8d]' : 'text-[#42f08f]'

  return (
    <label className="block">
      <span className={`text-[10px] font-semibold uppercase ${toneClass}`}>{label}</span>
      <span className="mt-1 flex h-8 items-center rounded-md border border-[#263c34] bg-[#08100d] px-2 text-xs text-[#6f897c]">
        R$
        <input
          className="min-w-0 flex-1 bg-transparent px-1 font-semibold text-[#edf7ef] outline-none placeholder:text-[#3b5147]"
          min={0}
          placeholder={placeholder}
          step={100}
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </label>
  )
}

function AnnualMonthFocus({
  currentNetBalance,
  isLoading,
  month,
}: {
  currentNetBalance: number
  isLoading: boolean
  month: AnnualPlanMonth | null
}) {
  if (isLoading) {
    return (
      <aside className="hidden min-h-0 rounded-lg border border-[#182721] bg-[#0b1410]/95 p-4 lg:grid lg:place-items-center">
        <LoaderCircle className="size-6 animate-spin text-[#42f08f]" aria-hidden="true" />
      </aside>
    )
  }

  if (!month) {
    return (
      <aside className="hidden min-h-0 rounded-lg border border-[#182721] bg-[#0b1410]/95 p-4 lg:grid lg:place-items-center">
        <EmptyState label="Selecione um mes" />
      </aside>
    )
  }

  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-lg border border-[#182721] bg-[#0b1410]/95 p-4 lg:flex">
      <div className="min-h-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-[#6f897c]">{getAnnualMonthStatus(month)}</p>
            <h3 className="mt-1 text-3xl font-semibold capitalize text-white">{month.label}</h3>
          </div>
          <span className={`rounded-md px-2 py-1 text-xs font-semibold ${month.isFuture ? 'bg-[#241a0e] text-[#ffc46b]' : 'bg-[#103b2f] text-[#42f08f]'}`}>
            {month.isFuture ? 'Meta' : month.isCurrent ? 'Atual' : 'Real'}
          </span>
        </div>

        <div className="mt-5 grid gap-2">
          <AnnualFocusMetric
            label="Gasto realizado"
            value={month.isFuture ? '-' : formatMoney(month.summary.expenses)}
            tone="rose"
          />
          <AnnualFocusMetric
            label="Investido real"
            value={month.isFuture ? '-' : formatMoney(month.summary.netInvestmentContribution)}
            tone={month.summary.netInvestmentContribution >= 0 ? 'shield' : 'amber'}
          />
          <AnnualFocusMetric label="Gasto projetado" value={formatMoney(month.projectedExpense)} tone="light" />
          <AnnualFocusMetric label="Invest. projetado" value={formatMoney(month.projectedInvestment)} tone="mint" />
          <AnnualFocusMetric
            label={month.projectedBalance === null ? 'Saldo atual' : 'Saldo projetado'}
            value={formatMoney(month.projectedBalance ?? currentNetBalance)}
            tone="light"
          />
        </div>
      </div>
    </aside>
  )
}

function AnnualFocusMetric({
  label,
  tone,
  value,
}: {
  label: string
  tone: 'amber' | 'light' | 'mint' | 'rose' | 'shield'
  value: string
}) {
  const toneClass = {
    amber: 'text-[#ffc46b]',
    light: 'text-white',
    mint: 'text-[#75f4dc]',
    rose: 'text-[#ff8d8d]',
    shield: 'text-[#42f08f]',
  }[tone]

  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-[#101a16] px-3 py-2">
      <p className="text-xs font-semibold uppercase text-[#6f897c]">{label}</p>
      <p className={`truncate text-base font-semibold ${toneClass}`}>{value}</p>
    </div>
  )
}

function getAnnualMonthStatus(month: AnnualPlanMonth) {
  if (month.isFuture) {
    return 'Futuro'
  }

  return month.isCurrent ? 'Mes atual' : 'Realizado'
}

function DatePresetControl({
  preset,
  onPresetChange,
}: {
  preset: DatePreset
  onPresetChange: (value: DatePreset) => void
}) {
  return (
    <label className="flex h-11 items-center gap-2 rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-sm text-[#8ba397]">
      <Calendar className="size-4 text-[#42f08f]" aria-hidden="true" />
      <span className="sr-only">Período</span>
      <select
        aria-label="Período"
        className="bg-transparent font-semibold text-[#edf7ef] outline-none"
        value={preset}
        onChange={(event) => onPresetChange(event.target.value as DatePreset)}
      >
        <option value="current-month">Mês atual</option>
        <option value="previous-month">Mês anterior</option>
        <option value="next-month">Próximo mês</option>
        <option value="custom">Personalizado</option>
      </select>
    </label>
  )
}

function MonthSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex h-11 items-center rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-sm text-[#8ba397]">
      <span className="sr-only">Mês</span>
      <select
        className="bg-transparent font-semibold capitalize text-[#edf7ef] outline-none"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {monthOptions.map((month) => (
          <option key={month.value} value={month.value}>
            {month.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function YearSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: 7 }, (_, index) => currentYear - 3 + index)

  return (
    <label className="flex h-11 items-center rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-sm text-[#8ba397]">
      <span className="sr-only">Ano</span>
      <select
        className="bg-transparent font-semibold text-[#edf7ef] outline-none"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {years.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
    </label>
  )
}

function AccountsMenu({
  accounts,
  isLoading,
  isOpen,
  onToggle,
}: {
  accounts: FinanceAccount[]
  isLoading: boolean
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <div className="relative">
      <button
        className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-[#2f4c41] bg-[#10211b] px-4 text-sm font-semibold text-[#d8ffe7] transition hover:border-[#39d681] hover:bg-[#123327]"
        type="button"
        onClick={onToggle}
      >
        <Landmark className="size-4 text-[#42f08f]" aria-hidden="true" />
        Contas
        <ChevronDown className={`size-4 transition ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-[#244438] bg-[#09100d]/98 p-3 shadow-[0_24px_70px_rgba(0,0,0,0.48)] backdrop-blur">
          <div className="flex items-center justify-between gap-3 border-b border-[#16231e] pb-2">
            <h3 className="text-sm font-semibold text-white">Contas conectadas</h3>
            <span className="text-xs font-semibold text-[#6f897c]">{accounts.length}</span>
          </div>
          <div className="mt-2 max-h-[360px] divide-y divide-[#16231e] overflow-y-auto">
            {accounts.length ? (
              accounts.map((account) => <AccountRow key={account.id} account={account} />)
            ) : (
              <EmptyState label={isLoading ? 'Buscando contas' : 'Nenhuma conta carregada'} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FilterSelect({
  children,
  label,
  value,
  onChange,
}: {
  children: ReactNode
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex h-12 items-center rounded-lg border border-[#263c34] bg-[#101a16] px-3 text-base text-[#8ba397]">
      <span className="sr-only">{label}</span>
      <select
        className="min-w-0 flex-1 bg-transparent font-semibold text-[#edf7ef] outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  )
}

function MetricCard({ metric }: { metric: Metric }) {
  const Icon = metric.icon
  const tone = {
    amber: 'border-[#5a3d1d] bg-[#2a1c0d] text-[#ffc46b]',
    mint: 'border-[#24544b] bg-[#102824] text-[#75f4dc]',
    rose: 'border-[#563032] bg-[#251113] text-[#ff8d8d]',
    shield: 'border-[#256c52] bg-[#103b2f] text-[#42f08f]',
  }[metric.tone]

  return (
    <article className="min-h-[154px] rounded-lg border border-[#203a31] bg-[#09100d]/95 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-medium text-[#8ba397]">{metric.label}</p>
          <p className="mt-3 text-3xl font-semibold text-white">{metric.value}</p>
        </div>
        <div className={`grid size-12 place-items-center rounded-lg border ${tone}`}>
          <Icon className="size-6" aria-hidden="true" />
        </div>
      </div>
      {metric.progress !== undefined ? (
        <div className="mt-4">
          <div className="h-3 overflow-hidden rounded-full bg-[#17231f]">
            <div
              className={`h-full rounded-full ${metric.progressTone === 'bad' ? 'bg-[#ff6b6b]' : 'bg-[#42f08f]'}`}
              style={{ width: `${metric.progress}%` }}
            />
          </div>
        </div>
      ) : null}
      {metric.support}
      <div className="mt-5 flex items-center gap-1 text-base text-[#8ba397]">
        {metric.tone === 'rose' ? (
          <ArrowDownRight className="size-4 text-[#ff8d8d]" aria-hidden="true" />
        ) : (
          <ArrowUpRight className="size-4 text-[#42f08f]" aria-hidden="true" />
        )}
        {metric.detail}
      </div>
    </article>
  )
}

function MetricSkeleton() {
  return (
    <div className="min-h-[154px] animate-pulse rounded-lg border border-[#203a31] bg-[#09100d]/95 p-5">
      <div className="h-4 w-24 rounded bg-[#17231f]" />
      <div className="mt-5 h-8 w-36 rounded bg-[#17231f]" />
      <div className="mt-6 h-4 w-28 rounded bg-[#17231f]" />
    </div>
  )
}

function CategoryBar({ category, index, max }: { category: CategorySummary; index: number; max: number }) {
  const colors = ['bg-[#42f08f]', 'bg-[#75f4dc]', 'bg-[#ffc46b]', 'bg-[#ff8d8d]', 'bg-[#a9b7ff]']

  return (
    <div className="grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_130px] sm:items-center">
      <span className="text-base font-medium text-[#d8ffe7]">{category.name}</span>
      <div className="h-4 overflow-hidden bg-[#17231f]">
        <div
          className={`h-full ${colors[index % colors.length]}`}
          style={{ width: `${Math.max((category.total / max) * 100, 8)}%` }}
        />
      </div>
      <span className="text-base font-semibold text-white sm:text-right">{formatMoney(category.total)}</span>
    </div>
  )
}

function TransactionRow({ transaction }: { transaction: FinanceTransaction }) {
  const isPositive = transaction.amount > 0

  return (
    <tr className={`text-[#d7e6dd] ${transaction.ignoredForBudget ? 'bg-[#0a0f0d]/45' : ''}`}>
      <td className="whitespace-nowrap px-4 py-4 text-[#8ba397]">{formatDateLabel(transaction.date)}</td>
      <td className="px-4 py-4">
        <div className="max-w-[300px] whitespace-normal font-medium leading-snug text-white">
          {transaction.description}
        </div>
        <div className="mt-1 text-sm text-[#6f897c]">{transaction.status}</div>
      </td>
      <td className="px-4 py-4">
        <span className="inline-flex rounded-md border border-[#263c34] bg-[#101a16] px-2 py-1 text-sm font-semibold text-[#d8ffe7]">
          {transaction.category}
        </span>
      </td>
      <td className="px-4 py-4">
        <div className="max-w-[210px] whitespace-normal leading-snug">{transaction.source}</div>
        <div className="mt-1 text-sm text-[#6f897c]">{transaction.method}</div>
      </td>
      <td className="px-4 py-4">
        {transaction.ignoredForBudget ? (
          <span className="inline-flex rounded-md border border-[#4a3923] bg-[#241a0e] px-2 py-1 text-sm font-semibold text-[#ffc46b]">
            {transaction.ignoreReason ?? 'Fora'}
          </span>
        ) : (
          <span className="inline-flex rounded-md border border-[#256c52] bg-[#103b2f] px-2 py-1 text-sm font-semibold text-[#42f08f]">
            Incluido
          </span>
        )}
      </td>
      <td className={`whitespace-nowrap px-4 py-4 text-right font-semibold ${isPositive ? 'text-[#42f08f]' : 'text-[#ff8d8d]'}`}>
        {formatMoney(transaction.amount)}
        {transaction.originalCurrencyCode !== transaction.currencyCode ? (
          <div className="mt-1 text-xs font-medium text-[#8ba397]">
            {formatCurrency(transaction.originalAmount, transaction.originalCurrencyCode)}
            {transaction.fxRate ? ` @ ${transaction.fxRate.toFixed(4)}` : ''}
            {transaction.fxSource ? ` ${transaction.fxSource}` : ''}
          </div>
        ) : null}
      </td>
    </tr>
  )
}

function AccountRow({ account }: { account: FinanceAccount }) {
  const Icon = account.type === 'CREDIT' ? CreditCard : Landmark

  return (
    <div className="flex min-h-20 items-center justify-between gap-4 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-lg border border-[#263c34] bg-[#101a16] text-[#42f08f]">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="whitespace-normal text-base font-semibold leading-snug text-white">
            {account.marketingName || account.name}
          </p>
          <p className="mt-1 text-sm text-[#6f897c]">{account.subtype}</p>
        </div>
      </div>
      <p className="shrink-0 text-base font-semibold text-[#d8ffe7]">{formatCompactMoney(account.balance)}</p>
    </div>
  )
}

function StatusPill({ label }: { label: string }) {
  const ok = label === 'SUCCESS'

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs font-semibold ${
        ok
          ? 'border-[#256c52] bg-[#103b2f] text-[#42f08f]'
          : 'border-[#5a3d1d] bg-[#2a1c0d] text-[#ffc46b]'
      }`}
    >
      {ok ? <ShieldCheck className="size-3.5" aria-hidden="true" /> : <LoaderCircle className="size-3.5" aria-hidden="true" />}
      {label}
    </span>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[#613437] bg-[#241113] p-4 text-sm text-[#ffd9d9]">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[#ff8d8d]" aria-hidden="true" />
      <div>
        <p className="font-semibold text-white">A Pluggy nao respondeu redondinho</p>
        <p className="mt-1 text-[#ffb9b9]">{message}</p>
      </div>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-[#263c34] bg-[#0a0f0d] px-4 text-base font-medium text-[#6f897c]">
      {label}
    </div>
  )
}

export default App
