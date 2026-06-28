import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { URL } from 'node:url'
import { loadLocalEnv } from './env.mjs'

loadLocalEnv()

const apiBase = process.env.PLUGGY_API_BASE ?? 'https://api.pluggy.ai'
const port = Number(process.env.API_PORT ?? 8787)
const distDir = resolve(process.cwd(), 'dist')

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

const categoryLabels = {
  Automotive: 'Automotivo',
  BankFees: 'Tarifas',
  'Bank fees': 'Tarifas',
  Bars: 'Bares',
  Business: 'Trabalho',
  Clothing: 'Roupas',
  CreditCard: 'Cartao',
  'Credit card payment': 'Pagamento de cartao',
  'Digital services': 'Servicos digitais',
  Donations: 'Doacoes',
  Education: 'Educacao',
  Electricity: 'Energia',
  Electronics: 'Eletronicos',
  Entertainment: 'Lazer',
  'Eating out': 'Restaurantes',
  Food: 'Alimentacao',
  'Food delivery': 'Delivery',
  Gambling: 'Apostas',
  Groceries: 'Mercado',
  Health: 'Saude',
  'Health insurance': 'Plano de saude',
  Home: 'Casa',
  'Hospital clinics and labs': 'Saude',
  Income: 'Entradas',
  Investments: 'Investimentos',
  Loan: 'Emprestimos',
  Other: 'Outros',
  Payment: 'Pagamentos',
  Pharmacy: 'Farmacia',
  Restaurant: 'Restaurantes',
  Restaurants: 'Restaurantes',
  'Same person transfer': 'Transferencia propria',
  School: 'Educacao',
  Services: 'Servicos',
  Shopping: 'Compras',
  'Sports practice': 'Esporte',
  'Tax on financial operations': 'IOF',
  Taxes: 'Impostos',
  Telecommunications: 'Telefone e internet',
  'Taxi and ride-hailing': 'Transporte',
  Transport: 'Transporte',
  Transfers: 'Transferencias',
  Travel: 'Viagens',
  University: 'Educacao',
  Utilities: 'Contas',
}

const budgetIgnoredCategories = new Set(['Credit card payment', 'Investments', 'Payment'])
const incomeIgnoredCategories = new Set(['Investments', 'Same person transfer', 'Transfers'])
const exchangeRateCache = new Map()

function json(response, status, data) {
  const body = JSON.stringify(data)
  response.writeHead(status, {
    'Access-Control-Allow-Origin': 'http://127.0.0.1:5173',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-KEY',
    'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function serveStatic(request, response, requestUrl) {
  if (!['GET', 'HEAD'].includes(request.method ?? '') || requestUrl.pathname.startsWith('/api/')) {
    return false
  }

  const pathname = decodeURIComponent(requestUrl.pathname)
  const candidatePath = pathname === '/' ? resolve(distDir, 'index.html') : resolve(distDir, `.${pathname}`)
  const relativePath = relative(distDir, candidatePath)

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Acesso negado.')
    return true
  }

  const filePath = await findStaticFile(candidatePath, pathname)

  if (!filePath) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Build do frontend nao encontrado. Rode npm run build.')
    return true
  }

  const content = await readFile(filePath)
  const extension = extname(filePath).toLowerCase()
  const isIndex = filePath.endsWith('index.html')

  response.writeHead(200, {
    'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Content-Type': mimeTypes[extension] ?? 'application/octet-stream',
  })

  response.end(request.method === 'HEAD' ? undefined : content)
  return true
}

async function findStaticFile(candidatePath, pathname) {
  try {
    await readFile(candidatePath)
    return candidatePath
  } catch {
    if (extname(pathname)) {
      return null
    }
  }

  const indexPath = resolve(distDir, 'index.html')

  try {
    await readFile(indexPath)
    return indexPath
  } catch {
    return null
  }
}

function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = ''

    request.on('data', (chunk) => {
      body += chunk

      if (body.length > 20_000) {
        request.destroy()
        const error = new Error('Payload muito grande.')
        error.statusCode = 413
        reject(error)
      }
    })

    request.on('end', () => {
      if (!body.trim()) {
        resolveBody({})
        return
      }

      try {
        resolveBody(JSON.parse(body))
      } catch {
        const error = new Error('JSON invalido.')
        error.statusCode = 400
        reject(error)
      }
    })

    request.on('error', reject)
  })
}

function getConfigStatus() {
  return {
    apiPort: port,
    hasClientId: Boolean(process.env.PLUGGY_CLIENT_ID),
    hasClientSecret: Boolean(process.env.PLUGGY_CLIENT_SECRET),
    hasItemId: Boolean(process.env.PLUGGY_ITEM_ID),
    itemIdPreview: maskValue(process.env.PLUGGY_ITEM_ID),
  }
}

function maskValue(value) {
  if (!value) {
    return null
  }

  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`
}

function normalizeCredential(value, currentValue, field) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  if (currentValue) {
    return currentValue
  }

  {
    const error = new Error(`Informe ${field}.`)
    error.statusCode = 400
    throw error
  }
}

function escapeEnvValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '').replace(/"/g, '\\"')
}

async function savePluggyConfig(request) {
  const body = await readJsonBody(request)
  const clientId = normalizeCredential(body.clientId, process.env.PLUGGY_CLIENT_ID, 'Client ID')
  const clientSecret = normalizeCredential(body.clientSecret, process.env.PLUGGY_CLIENT_SECRET, 'Client Secret')
  const itemId = normalizeCredential(body.itemId, process.env.PLUGGY_ITEM_ID, 'Item ID')
  const apiPort = String(Number(body.apiPort) || port)
  const envPath = resolve(process.cwd(), '.env.local')
  const envContent = [
    `PLUGGY_CLIENT_ID="${escapeEnvValue(clientId)}"`,
    `PLUGGY_CLIENT_SECRET="${escapeEnvValue(clientSecret)}"`,
    `PLUGGY_ITEM_ID="${escapeEnvValue(itemId)}"`,
    `API_PORT=${apiPort}`,
    '',
  ].join('\n')

  await writeFile(envPath, envContent, 'utf8')

  process.env.PLUGGY_CLIENT_ID = clientId
  process.env.PLUGGY_CLIENT_SECRET = clientSecret
  process.env.PLUGGY_ITEM_ID = itemId
  process.env.API_PORT = apiPort

  return getConfigStatus()
}

function getConfig() {
  const missing = ['PLUGGY_CLIENT_ID', 'PLUGGY_CLIENT_SECRET', 'PLUGGY_ITEM_ID'].filter((key) => !process.env[key])

  if (missing.length) {
    const error = new Error(`Variaveis ausentes: ${missing.join(', ')}`)
    error.statusCode = 500
    throw error
  }

  return {
    clientId: process.env.PLUGGY_CLIENT_ID,
    clientSecret: process.env.PLUGGY_CLIENT_SECRET,
    itemId: process.env.PLUGGY_ITEM_ID,
  }
}

function assertDate(value, fallback) {
  if (!value) {
    return fallback
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error('Use datas no formato YYYY-MM-DD.')
    error.statusCode = 400
    throw error
  }

  return value
}

async function pluggyFetch(path, apiKey, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'X-API-KEY': apiKey,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    const error = new Error(`Pluggy respondeu ${response.status}`)
    error.statusCode = response.status
    error.details = safeErrorDetails(text)
    throw error
  }

  return response.json()
}

async function authenticate({ clientId, clientSecret }) {
  const response = await fetch(`${apiBase}/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientId, clientSecret }),
  })

  if (!response.ok) {
    const error = new Error(`Falha ao autenticar na Pluggy: ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const payload = await response.json()
  return payload.apiKey
}

async function fetchTransactions(apiKey, accountId, dateFrom, dateTo) {
  const transactions = []
  let cursor

  do {
    const search = new URLSearchParams({
      accountId,
      dateFrom,
      dateTo,
    })

    if (cursor) {
      search.set('cursor', cursor)
    }

    const page = await pluggyFetch(`/v2/transactions?${search.toString()}`, apiKey)
    transactions.push(...(page.results ?? []))
    cursor = page.next
  } while (cursor)

  return transactions
}

async function fetchInvestments(apiKey, itemId) {
  const investments = []
  let page = 1
  let totalPages = 1

  do {
    const search = new URLSearchParams({
      itemId,
      page: String(page),
      pageSize: '500',
    })
    const payload = await pluggyFetch(`/investments?${search.toString()}`, apiKey)
    investments.push(...(payload.results ?? []))
    totalPages = Number(payload.totalPages ?? 1)
    page += 1
  } while (page <= totalPages)

  return investments
}

async function fetchBills(apiKey, accountId) {
  const bills = []
  let page = 1
  let totalPages = 1

  do {
    const search = new URLSearchParams({
      accountId,
      page: String(page),
      pageSize: '100',
    })
    const payload = await pluggyFetch(`/bills?${search.toString()}`, apiKey)
    bills.push(...(payload.results ?? []))
    totalPages = Number(payload.totalPages ?? 1)
    page += 1
  } while (page <= totalPages)

  return bills
}

function normalizeCategory(category) {
  if (!category) {
    return 'Outros'
  }

  return categoryLabels[category] ?? category
}

async function normalizeTransaction(transaction, account) {
  const rawAmount = Number(transaction.amount ?? 0)
  const description =
    transaction.description ||
    transaction.descriptionRaw ||
    transaction.merchant?.name ||
    transaction.paymentData?.payer?.name ||
    'Movimentacao'
  const rawCategory = isCreditCardPaymentDescription(description) ? 'Credit card payment' : transaction.category ?? null
  const currency = await resolveTransactionCurrency(transaction, account, rawAmount)
  const signedAmount = getDisplayAmount(account, transaction, currency.accountAmount)
  const budgetAmount = getBudgetAmount(account, transaction, currency.accountAmount, rawCategory, description)

  return {
    id: transaction.id,
    accountId: account.id,
    accountType: account.type,
    accountSubtype: account.subtype,
    source: account.marketingName || account.name || account.type,
    date: transaction.date,
    description,
    category: normalizeCategory(rawCategory),
    rawCategory,
    method: account.type === 'CREDIT' ? 'Credito' : 'Conta',
    status: transaction.status,
    type: transaction.type,
    amount: signedAmount,
    budgetAmount,
    isBudgetExpense: budgetAmount < 0,
    ignoredForBudget: budgetAmount === 0,
    ignoreReason: getIgnoreReason(account, transaction, rawCategory, description),
    originalAmount: rawAmount,
    originalCurrencyCode: currency.originalCurrencyCode,
    convertedAmount: currency.convertedAmount,
    currencyCode: currency.accountCurrencyCode,
    fxRate: currency.fxRate,
    fxSource: currency.fxSource,
    fxDate: currency.fxDate,
  }
}

async function resolveTransactionCurrency(transaction, account, rawAmount) {
  const originalCurrencyCode = transaction.currencyCode || account.currencyCode || 'BRL'
  const accountCurrencyCode = account.currencyCode || 'BRL'

  if (originalCurrencyCode === accountCurrencyCode) {
    return {
      accountAmount: Math.abs(rawAmount),
      accountCurrencyCode,
      convertedAmount: null,
      fxDate: null,
      fxRate: null,
      fxSource: null,
      originalCurrencyCode,
    }
  }

  const pluggyAmount = Number(transaction.amountInAccountCurrency ?? 0)

  if (pluggyAmount > 0) {
    return {
      accountAmount: Math.abs(pluggyAmount),
      accountCurrencyCode,
      convertedAmount: roundMoney(Math.abs(pluggyAmount)),
      fxDate: transaction.date?.slice(0, 10) ?? null,
      fxRate: roundRate(Math.abs(pluggyAmount) / Math.max(Math.abs(rawAmount), 0.01)),
      fxSource: 'Pluggy',
      originalCurrencyCode,
    }
  }

  const exchangeRate = await getExchangeRate(originalCurrencyCode, accountCurrencyCode, transaction.date)

  if (exchangeRate) {
    const convertedAmount = Math.abs(rawAmount) * exchangeRate.rate

    return {
      accountAmount: convertedAmount,
      accountCurrencyCode,
      convertedAmount: roundMoney(convertedAmount),
      fxDate: exchangeRate.date,
      fxRate: exchangeRate.rate,
      fxSource: exchangeRate.source,
      originalCurrencyCode,
    }
  }

  return {
    accountAmount: Math.abs(rawAmount),
    accountCurrencyCode: originalCurrencyCode,
    convertedAmount: null,
    fxDate: null,
    fxRate: null,
    fxSource: null,
    originalCurrencyCode,
  }
}

async function getExchangeRate(fromCurrency, toCurrency, transactionDate) {
  if (toCurrency !== 'BRL' || !transactionDate) {
    return null
  }

  const day = new Date(transactionDate)

  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(day)
    date.setUTCDate(day.getUTCDate() - offset)
    const dateKey = formatDate(date)
    const cacheKey = `${fromCurrency}-${toCurrency}-${dateKey}`

    if (exchangeRateCache.has(cacheKey)) {
      return exchangeRateCache.get(cacheKey)
    }

    const bcbDate = `${dateKey.slice(5, 7)}-${dateKey.slice(8, 10)}-${dateKey.slice(0, 4)}`
    const search = `@moeda='${fromCurrency}'&@dataInicial='${bcbDate}'&@dataFinalCotacao='${bcbDate}'&$format=json`
    const endpoint = `/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?${search}`

    try {
      const response = await fetch(`https://olinda.bcb.gov.br${endpoint}`)
      const payload = await response.json()
      const quotes = payload.value ?? []
      const closingQuote = quotes.find((quote) => quote.tipoBoletim === 'Fechamento') ?? quotes.at(-1)

      if (closingQuote?.cotacaoVenda) {
        const result = {
          date: dateKey,
          rate: roundRate(Number(closingQuote.cotacaoVenda)),
          source: 'BCB PTAX',
        }
        exchangeRateCache.set(cacheKey, result)
        return result
      }
    } catch {
      return null
    }
  }

  return null
}

function getDisplayAmount(account, transaction, accountAmount) {
  if (account.type === 'CREDIT') {
    return transaction.type === 'DEBIT' ? -Math.abs(accountAmount) : Math.abs(accountAmount)
  }

  return transaction.amount < 0 ? -Math.abs(accountAmount) : Math.abs(accountAmount)
}

function getBudgetAmount(account, transaction, accountAmount, rawCategory, description) {
  if (budgetIgnoredCategories.has(rawCategory) || isCreditCardPaymentDescription(description)) {
    return 0
  }

  if (account.type === 'CREDIT') {
    return transaction.type === 'DEBIT' ? -Math.abs(accountAmount) : 0
  }

  return transaction.amount < 0 ? -Math.abs(accountAmount) : 0
}

function getIgnoreReason(account, transaction, rawCategory, description) {
  if (rawCategory === 'Investments') {
    return 'Aporte/resgate'
  }

  if (rawCategory === 'Credit card payment' || rawCategory === 'Payment' || isCreditCardPaymentDescription(description)) {
    return 'Pagamento de fatura'
  }

  if (account.type === 'CREDIT' && transaction.type !== 'DEBIT') {
    return 'Credito/estorno'
  }

  return null
}

function normalizeInvestment(investment) {
  return {
    id: investment.id,
    type: investment.type,
    subtype: investment.subtype ?? null,
    status: investment.status ?? null,
    name: investment.name ?? investment.code ?? 'Investimento',
    code: investment.code ?? null,
    balance: roundMoney(Number(investment.balance ?? 0)),
    amount: roundMoney(Number(investment.amount ?? 0)),
    quantity: Number(investment.quantity ?? 0),
    currencyCode: investment.currencyCode ?? 'BRL',
  }
}

function normalizeBill(bill, account) {
  return {
    id: bill.id,
    accountId: account.id,
    dueDate: bill.dueDate,
    closingDate: bill.closingDate ?? null,
    status: bill.status ?? null,
    totalAmount: roundMoney(Number(bill.totalAmount ?? 0)),
    minimumPaymentAmount: roundMoney(Number(bill.minimumPaymentAmount ?? 0)),
  }
}

function markCreditCardPaymentCounterparts(transactions) {
  const cardPayments = transactions.filter(
    (item) =>
      item.accountType === 'CREDIT' &&
      item.rawCategory === 'Credit card payment' &&
      item.amount > 0,
  )

  for (const payment of cardPayments) {
    const paymentDay = payment.date.slice(0, 10)
    const counterpart = transactions.find(
      (item) =>
        item.accountType !== 'CREDIT' &&
        item.amount < 0 &&
        item.budgetAmount < 0 &&
        item.date.slice(0, 10) === paymentDay &&
        Math.abs(Math.abs(item.amount) - payment.amount) < 0.02,
    )

    if (counterpart) {
      counterpart.budgetAmount = 0
      counterpart.isBudgetExpense = false
      counterpart.ignoredForBudget = true
      counterpart.ignoreReason = 'Pagamento de fatura'
      counterpart.category = 'Pagamento de cartao'
      counterpart.rawCategory = 'Credit card payment'
    }
  }
}

function buildSummary(accounts, transactions, investments, bills, dateFrom, dateTo) {
  const budgetExpenses = transactions.filter((item) => item.budgetAmount < 0)
  const expenses = budgetExpenses.reduce((sum, item) => sum + Math.abs(item.budgetAmount), 0)
  const income = transactions
    .filter((item) => item.accountType !== 'CREDIT' && item.amount > 0 && !incomeIgnoredCategories.has(item.rawCategory))
    .reduce((sum, item) => sum + item.amount, 0)
  const cardExpenses = transactions
    .filter((item) => item.accountType === 'CREDIT' && item.budgetAmount < 0)
    .reduce((sum, item) => sum + Math.abs(item.budgetAmount), 0)
  const bankExpenses = transactions
    .filter((item) => item.accountType !== 'CREDIT' && item.budgetAmount < 0)
    .reduce((sum, item) => sum + Math.abs(item.budgetAmount), 0)
  const investmentFlow = transactions
    .filter((item) => item.rawCategory === 'Investments')
    .reduce((sum, item) => sum + item.amount, 0)
  const investmentContributions = transactions
    .filter((item) => item.rawCategory === 'Investments' && item.amount < 0)
    .reduce((sum, item) => sum + Math.abs(item.amount), 0)
  const investmentRedemptions = transactions
    .filter((item) => item.rawCategory === 'Investments' && item.amount > 0)
    .reduce((sum, item) => sum + item.amount, 0)
  const ignoredOutflow = transactions
    .filter((item) => item.budgetAmount === 0 && item.amount < 0)
    .reduce((sum, item) => sum + Math.abs(item.amount), 0)
  const transferOutflow = transactions
    .filter(
      (item) =>
        item.amount < 0 &&
        !isCreditCardPaymentDescription(item.description) &&
        (item.rawCategory === 'Transfers' || item.rawCategory === 'Same person transfer' || isTransferDescription(item.description)),
    )
    .reduce((sum, item) => sum + Math.abs(item.amount), 0)
  const accountBalance = accounts
    .filter((account) => account.type !== 'CREDIT')
    .reduce((sum, account) => sum + Number(account.balance ?? 0), 0)
  const creditBalance = accounts
    .filter((account) => account.type === 'CREDIT')
    .reduce((sum, account) => sum + Number(account.balance ?? 0), 0)
  const investmentBalance = investments.reduce((sum, investment) => sum + Number(investment.balance ?? 0), 0)
  const investmentAmount = investments.reduce((sum, investment) => sum + Number(investment.amount ?? 0), 0)
  const activeInvestmentCount = investments.filter((investment) => investment.status !== 'TOTAL_WITHDRAWAL').length
  const currentBill = pickCurrentBill(bills, dateTo)

  const categories = [...groupExpensesBy(transactions, 'category').entries()]
    .map(([name, total]) => ({ name, total: roundMoney(total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)

  const byDay = [...groupExpensesBy(transactions, (item) => item.date.slice(0, 10)).entries()]
    .map(([date, total]) => ({ date, total: roundMoney(total) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const daysInRange = Math.max(daysBetween(dateFrom, dateTo), 1)
  const monthDays = new Date(Number(dateTo.slice(0, 4)), Number(dateTo.slice(5, 7)), 0).getDate()
  const monthlyProjection = (expenses / daysInRange) * monthDays

  return {
    accountBalance: roundMoney(accountBalance),
    activeInvestmentCount,
    bankExpenses: roundMoney(bankExpenses),
    cardExpenses: roundMoney(cardExpenses),
    creditBalance: roundMoney(creditBalance),
    currentBill,
    expenses: roundMoney(expenses),
    ignoredOutflow: roundMoney(ignoredOutflow),
    income: roundMoney(income),
    investmentAmount: roundMoney(investmentAmount),
    investmentBalance: roundMoney(investmentBalance),
    investmentContributions: roundMoney(investmentContributions),
    investmentFlow: roundMoney(investmentFlow),
    investmentRedemptions: roundMoney(investmentRedemptions),
    monthlyProjection: roundMoney(monthlyProjection),
    netCashflow: roundMoney(income - expenses),
    netInvestmentContribution: roundMoney(investmentContributions - investmentRedemptions),
    transferOutflow: roundMoney(transferOutflow),
    transactionCount: transactions.length,
    budgetTransactionCount: budgetExpenses.length,
    categories,
    byDay,
  }
}

function pickCurrentBill(bills, dateTo) {
  const datedBills = bills
    .filter((bill) => bill.dueDate)
    .sort((a, b) => Math.abs(new Date(a.dueDate) - new Date(`${dateTo}T12:00:00Z`)) - Math.abs(new Date(b.dueDate) - new Date(`${dateTo}T12:00:00Z`)))

  return datedBills[0] ?? null
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function roundRate(value) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000
}

function isTransferDescription(description) {
  return /^transfer[eê]ncia\s+(enviada|recebida)/i.test(description ?? '')
}

function isCreditCardPaymentDescription(description) {
  return /pagamento\s+de\s+fatura|fatura\s+do\s+cart[aã]o|pagamento\s+.*cart[aã]o/i.test(description ?? '')
}

function groupExpensesBy(transactions, keyOrGetter) {
  const group = new Map()
  const getKey = typeof keyOrGetter === 'function' ? keyOrGetter : (item) => item[keyOrGetter]

  for (const item of transactions) {
    if (item.budgetAmount >= 0) {
      continue
    }

    const key = getKey(item) || 'Outros'
    group.set(key, (group.get(key) ?? 0) + Math.abs(item.budgetAmount))
  }

  return group
}

function daysBetween(dateFrom, dateTo) {
  const start = new Date(`${dateFrom}T12:00:00Z`)
  const end = new Date(`${dateTo}T12:00:00Z`)
  const diff = end.getTime() - start.getTime()

  return Math.floor(diff / 86_400_000) + 1
}

function safeErrorDetails(text) {
  if (!text) {
    return null
  }

  return text.replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]').slice(0, 500)
}

async function getSnapshot(requestUrl) {
  const config = getConfig()
  const today = new Date()
  const defaultTo = formatDate(today)
  const defaultFrom = formatDate(new Date(today.getFullYear(), today.getMonth(), 1))
  const dateFrom = assertDate(requestUrl.searchParams.get('dateFrom'), defaultFrom)
  const dateTo = assertDate(requestUrl.searchParams.get('dateTo'), defaultTo)
  const apiKey = await authenticate(config)
  const [item, accountsPayload] = await Promise.all([
    pluggyFetch(`/items/${config.itemId}`, apiKey),
    pluggyFetch(`/accounts?itemId=${config.itemId}`, apiKey),
  ])
  const accounts = (accountsPayload.results ?? []).map((account) => ({
    id: account.id,
    type: account.type,
    subtype: account.subtype,
    name: account.name,
    marketingName: account.marketingName,
    balance: Number(account.balance ?? 0),
    currencyCode: account.currencyCode ?? 'BRL',
  }))
  const transactionPages = await Promise.all(
    accounts.map(async (account) => {
      const results = await fetchTransactions(apiKey, account.id, dateFrom, dateTo)
      return Promise.all(results.map((transaction) => normalizeTransaction(transaction, account)))
    }),
  )
  const transactions = transactionPages.flat().sort((a, b) => b.date.localeCompare(a.date))
  markCreditCardPaymentCounterparts(transactions)
  const [investmentPayload, billPages] = await Promise.all([
    fetchInvestments(apiKey, config.itemId),
    Promise.all(accounts.filter((account) => account.type === 'CREDIT').map((account) => fetchBills(apiKey, account.id).then((bills) => bills.map((bill) => normalizeBill(bill, account))))),
  ])
  const investments = investmentPayload.map(normalizeInvestment)
  const bills = billPages.flat().sort((a, b) => (b.dueDate ?? '').localeCompare(a.dueDate ?? ''))

  return {
    generatedAt: new Date().toISOString(),
    dateFrom,
    dateTo,
    item: {
      id: item.id,
      status: item.status,
      executionStatus: item.executionStatus,
      updatedAt: item.updatedAt,
      connector: item.connector?.name ?? 'Pluggy',
      products: item.products ?? [],
    },
    accounts,
    investments,
    bills,
    transactions,
    summary: buildSummary(accounts, transactions, investments, bills, dateFrom, dateTo),
  }
}

async function getAnnualSnapshot(requestUrl) {
  const config = getConfig()
  const today = new Date()
  const requestedYear = requestUrl.searchParams.get('year') ?? String(today.getFullYear())

  if (!/^\d{4}$/.test(requestedYear)) {
    const error = new Error('Use ano no formato YYYY.')
    error.statusCode = 400
    throw error
  }

  const year = Number(requestedYear)
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  const apiKey = await authenticate(config)
  const [item, accountsPayload] = await Promise.all([
    pluggyFetch(`/items/${config.itemId}`, apiKey),
    pluggyFetch(`/accounts?itemId=${config.itemId}`, apiKey),
  ])
  const accounts = (accountsPayload.results ?? []).map((account) => ({
    id: account.id,
    type: account.type,
    subtype: account.subtype,
    name: account.name,
    marketingName: account.marketingName,
    balance: Number(account.balance ?? 0),
    currencyCode: account.currencyCode ?? 'BRL',
  }))
  const transactionPages = await Promise.all(
    accounts.map(async (account) => {
      const results = await fetchTransactions(apiKey, account.id, yearStart, yearEnd)
      return Promise.all(results.map((transaction) => normalizeTransaction(transaction, account)))
    }),
  )
  const transactions = transactionPages.flat().sort((a, b) => b.date.localeCompare(a.date))
  markCreditCardPaymentCounterparts(transactions)
  const [investmentPayload, billPages] = await Promise.all([
    fetchInvestments(apiKey, config.itemId),
    Promise.all(accounts.filter((account) => account.type === 'CREDIT').map((account) => fetchBills(apiKey, account.id).then((bills) => bills.map((bill) => normalizeBill(bill, account))))),
  ])
  const investments = investmentPayload.map(normalizeInvestment)
  const bills = billPages.flat().sort((a, b) => (b.dueDate ?? '').localeCompare(a.dueDate ?? ''))
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
    const monthEnd = formatDate(new Date(year, month, 0))
    const monthTransactions = transactions.filter((transaction) => {
      const date = transaction.date.slice(0, 10)
      return date >= monthStart && date <= monthEnd
    })
    const summary = buildSummary(accounts, monthTransactions, investments, bills, monthStart, monthEnd)
    const isFuture = new Date(`${monthStart}T12:00:00`) > new Date(`${formatDate(today)}T12:00:00`)
    const isCurrent = today.getFullYear() === year && today.getMonth() + 1 === month

    return {
      key: monthStart.slice(0, 7),
      month,
      label: new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(new Date(`${monthStart}T12:00:00`)),
      dateFrom: monthStart,
      dateTo: monthEnd,
      isCurrent,
      isFuture,
      summary: {
        expenses: summary.expenses,
        investmentContributions: summary.investmentContributions,
        investmentRedemptions: summary.investmentRedemptions,
        netInvestmentContribution: summary.netInvestmentContribution,
        transactionCount: summary.transactionCount,
        budgetTransactionCount: summary.budgetTransactionCount,
      },
    }
  })
  const currentSummary = buildSummary(accounts, transactions, investments, bills, yearStart, yearEnd)
  const accountBalance = currentSummary.accountBalance
  const investmentBalance = currentSummary.investmentBalance
  const creditBalance = currentSummary.creditBalance

  return {
    generatedAt: new Date().toISOString(),
    year,
    item: {
      id: item.id,
      status: item.status,
      executionStatus: item.executionStatus,
      updatedAt: item.updatedAt,
      connector: item.connector?.name ?? 'Pluggy',
      products: item.products ?? [],
    },
    current: {
      accountBalance,
      creditBalance,
      investmentBalance,
      netBalance: roundMoney(accountBalance + investmentBalance - creditBalance),
    },
    months,
  }
}

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    json(response, 204, {})
    return
  }

  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host}`)

  try {
    if (requestUrl.pathname === '/api/health') {
      json(response, 200, { ok: true })
      return
    }

    if (requestUrl.pathname === '/api/config' && request.method === 'GET') {
      json(response, 200, getConfigStatus())
      return
    }

    if (requestUrl.pathname === '/api/config' && request.method === 'POST') {
      json(response, 200, await savePluggyConfig(request))
      return
    }

    if (requestUrl.pathname === '/api/pluggy/snapshot') {
      json(response, 200, await getSnapshot(requestUrl))
      return
    }

    if (requestUrl.pathname === '/api/pluggy/annual') {
      json(response, 200, await getAnnualSnapshot(requestUrl))
      return
    }

    if (await serveStatic(request, response, requestUrl)) {
      return
    }

    json(response, 404, { error: 'Endpoint nao encontrado.' })
  } catch (error) {
    json(response, error.statusCode ?? 500, {
      error: error.message || 'Erro inesperado.',
      details: error.details ?? null,
    })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`GranaFlow API em http://127.0.0.1:${port}`)
})
