export type FinanceAccount = {
  id: string
  type: 'BANK' | 'CREDIT' | string
  subtype: string
  name: string
  marketingName: string | null
  balance: number
  currencyCode: string
}

export type FinanceTransaction = {
  id: string
  accountId: string
  accountType: 'BANK' | 'CREDIT' | string
  accountSubtype: string
  source: string
  date: string
  description: string
  category: string
  rawCategory: string | null
  method: 'Conta' | 'Credito'
  status: string
  type: 'DEBIT' | 'CREDIT' | string
  amount: number
  budgetAmount: number
  createdAt: string | null
  isBudgetExpense: boolean
  ignoredForBudget: boolean
  ignoreReason: string | null
  installmentNumber: number | null
  purchaseDate: string | null
  totalInstallments: number | null
  originalAmount: number
  originalCurrencyCode: string
  convertedAmount: number | null
  currencyCode: string
  fxRate: number | null
  fxSource: string | null
  fxDate: string | null
}

export type FinanceInvestment = {
  id: string
  type: string
  subtype: string | null
  status: string | null
  name: string
  code: string | null
  balance: number
  amount: number
  quantity: number
  currencyCode: string
}

export type FinanceBill = {
  id: string
  accountId: string
  dueDate: string
  closingDate: string | null
  status: string | null
  totalAmount: number
  minimumPaymentAmount: number
}

export type CategorySummary = {
  name: string
  total: number
}

export type DaySummary = {
  date: string
  total: number
}

export type FinanceSnapshot = {
  generatedAt: string
  dateFrom: string
  dateTo: string
  item: {
    id: string
    status: string
    executionStatus: string
    updatedAt: string
    connector: string
    products: string[]
  }
  accounts: FinanceAccount[]
  investments: FinanceInvestment[]
  bills: FinanceBill[]
  transactions: FinanceTransaction[]
  summary: {
    accountBalance: number
    activeInvestmentCount: number
    bankExpenses: number
    cardExpenses: number
    creditBalance: number
    currentBill: FinanceBill | null
    expenses: number
    ignoredOutflow: number
    income: number
    investmentAmount: number
    investmentBalance: number
    investmentContributions: number
    investmentFlow: number
    investmentRedemptions: number
    monthlyProjection: number
    netCashflow: number
    netInvestmentContribution: number
    transferOutflow: number
    transactionCount: number
    budgetTransactionCount: number
    categories: CategorySummary[]
    byDay: DaySummary[]
  }
}

export type AnnualMonthSummary = {
  key: string
  month: number
  label: string
  dateFrom: string
  dateTo: string
  isCurrent: boolean
  isFuture: boolean
  summary: {
    expenses: number
    investmentContributions: number
    investmentRedemptions: number
    netInvestmentContribution: number
    transactionCount: number
    budgetTransactionCount: number
  }
}

export type AnnualSnapshot = {
  generatedAt: string
  year: number
  item: FinanceSnapshot['item']
  current: {
    accountBalance: number
    creditBalance: number
    investmentBalance: number
    netBalance: number
  }
  months: AnnualMonthSummary[]
}

const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

const compactMoneyFormatter = new Intl.NumberFormat('pt-BR', {
  compactDisplay: 'short',
  currency: 'BRL',
  maximumFractionDigits: 1,
  notation: 'compact',
  style: 'currency',
})

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
})

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
})

export function formatMoney(value: number) {
  return moneyFormatter.format(value || 0)
}

export function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat('pt-BR', {
    currency,
    style: 'currency',
  }).format(value || 0)
}

export function formatCompactMoney(value: number) {
  return compactMoneyFormatter.format(value || 0)
}

export function formatDateLabel(value: string) {
  return dateFormatter.format(new Date(`${value.slice(0, 10)}T12:00:00`))
}

export function formatDateTime(value?: string) {
  if (!value) {
    return 'sem data'
  }

  return dateTimeFormatter.format(new Date(value))
}

export function formatDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

export function getCurrentMonthRange() {
  const today = new Date()

  return {
    dateFrom: formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1)),
    dateTo: formatDateInput(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  }
}

export function getMonthName(value: string) {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
  })

  return formatter.format(new Date(`${value}T12:00:00`))
}

export function getDaysInMonth(value: string) {
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))

  return new Date(year, month, 0).getDate()
}

export function getElapsedDays(dateFrom: string, dateTo: string) {
  const start = new Date(`${dateFrom}T12:00:00`)
  const end = new Date(`${dateTo}T12:00:00`)

  return Math.max(Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1, 1)
}
