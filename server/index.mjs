import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { URL } from 'node:url'
import { loadLocalEnv } from './env.mjs'

if (process.env.GRANAFLOW_CONFIG_ENV_PATH) {
  loadLocalEnv(process.env.GRANAFLOW_CONFIG_ENV_PATH)
}

loadLocalEnv()

const apiBase = process.env.PLUGGY_API_BASE ?? 'https://api.pluggy.ai'
const appName = 'GranaFlow'
const port = Number(process.env.API_PORT ?? 8787)
const distDir = resolve(process.cwd(), 'dist')
const runRegistryKey = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

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
const autoRecurringExcludedCategories = new Set(['Alimentacao', 'Compras', 'Delivery', 'Farmacia', 'Mercado', 'Restaurantes', 'Transporte'])
const exchangeRateCache = new Map()
const recurringStoreFileName = 'recurring-expenses.json'

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

async function getConfigStatus() {
  const autoStart = await getAutoStartStatus()

  return {
    apiPort: port,
    autoStart: autoStart.enabled,
    canManageAutoStart: autoStart.manageable,
    canResetApp: Boolean(process.env.GRANAFLOW_CONFIG_ROOT && process.env.GRANAFLOW_INSTALL_ROOT),
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

function normalizeCredential(value, currentValue) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  if (currentValue) {
    return currentValue
  }

  return ''
}

function escapeEnvValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '').replace(/"/g, '\\"')
}

async function writeEnvFile(envPath, envContent) {
  await mkdir(dirname(envPath), { recursive: true })
  await writeFile(envPath, envContent, 'utf8')
}

async function savePluggyConfig(request) {
  const body = await readJsonBody(request)
  const clientId = normalizeCredential(body.clientId, process.env.PLUGGY_CLIENT_ID)
  const clientSecret = normalizeCredential(body.clientSecret, process.env.PLUGGY_CLIENT_SECRET)
  const itemId = normalizeCredential(body.itemId, process.env.PLUGGY_ITEM_ID)
  const apiPort = String(Number(body.apiPort) || port)
  const envPath = resolve(process.cwd(), '.env.local')
  const envContent = [
    `PLUGGY_CLIENT_ID="${escapeEnvValue(clientId)}"`,
    `PLUGGY_CLIENT_SECRET="${escapeEnvValue(clientSecret)}"`,
    `PLUGGY_ITEM_ID="${escapeEnvValue(itemId)}"`,
    `API_PORT=${apiPort}`,
    '',
  ].join('\n')

  await writeEnvFile(envPath, envContent)

  if (process.env.GRANAFLOW_CONFIG_ENV_PATH) {
    await writeEnvFile(process.env.GRANAFLOW_CONFIG_ENV_PATH, envContent)
  }

  process.env.PLUGGY_CLIENT_ID = clientId
  process.env.PLUGGY_CLIENT_SECRET = clientSecret
  process.env.PLUGGY_ITEM_ID = itemId
  process.env.API_PORT = apiPort

  if (typeof body.autoStart === 'boolean' && process.env.GRANAFLOW_LAUNCHER_EXE_PATH) {
    await setAutoStart(body.autoStart)
  }

  return getConfigStatus()
}

function getUserDataRoot() {
  if (process.env.GRANAFLOW_CONFIG_ROOT) {
    return resolve(process.env.GRANAFLOW_CONFIG_ROOT)
  }

  if (process.env.APPDATA) {
    return resolve(process.env.APPDATA, appName)
  }

  return resolve(process.cwd(), '.granaflow')
}

function getRecurringStorePath() {
  return resolve(getUserDataRoot(), recurringStoreFileName)
}

async function readRecurringStore() {
  try {
    const content = await readFile(getRecurringStorePath(), 'utf8')
    const payload = JSON.parse(content)

    return {
      ignoredKeys: Array.isArray(payload.ignoredKeys) ? payload.ignoredKeys.filter((key) => typeof key === 'string') : [],
      rules: Array.isArray(payload.rules) ? payload.rules.map(normalizeStoredRecurringRule).filter(Boolean) : [],
      version: 1,
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ignoredKeys: [], rules: [], version: 1 }
    }

    throw error
  }
}

async function writeRecurringStore(store) {
  const storePath = getRecurringStorePath()

  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(
    storePath,
    JSON.stringify(
      {
        ignoredKeys: [...new Set(store.ignoredKeys ?? [])],
        rules: store.rules ?? [],
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    ),
    'utf8',
  )
}

function normalizeStoredRecurringRule(rule) {
  if (!rule || typeof rule !== 'object' || typeof rule.key !== 'string' || !rule.key) {
    return null
  }

  return {
    amount: Math.max(Number(rule.amount ?? 0), 0),
    category: String(rule.category ?? 'Outros'),
    createdAt: rule.createdAt ?? new Date().toISOString(),
    dayOfMonth: Math.min(Math.max(Number(rule.dayOfMonth ?? 1), 1), 31),
    firstSeen: rule.firstSeen ?? null,
    id: String(rule.id ?? randomUUID()),
    key: rule.key,
    label: String(rule.label ?? 'Recorrente'),
    lastSeen: rule.lastSeen ?? null,
    method: rule.method === 'Credito' ? 'Credito' : 'Conta',
    merchantSource: String(rule.merchantSource ?? ''),
    occurrences: Math.max(Number(rule.occurrences ?? 1), 1),
    origin: rule.origin === 'detected' ? 'detected' : 'manual',
    updatedAt: rule.updatedAt ?? new Date().toISOString(),
  }
}

function runCommand(file, args, { allowFailure = false } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolveCommand({ code, stderr, stdout })
        return
      }

      const error = new Error(stderr.trim() || `${file} saiu com codigo ${code}.`)
      error.statusCode = 500
      reject(error)
    })
  })
}

async function getAutoStartStatus() {
  const launcherPath = process.env.GRANAFLOW_LAUNCHER_EXE_PATH

  if (process.platform !== 'win32' || !launcherPath) {
    return { enabled: false, manageable: false }
  }

  const result = await runCommand('reg.exe', ['query', runRegistryKey, '/v', appName], { allowFailure: true })
  const normalizedOutput = result.stdout.toLowerCase()
  const normalizedLauncherPath = launcherPath.toLowerCase()

  return {
    enabled: result.code === 0 && normalizedOutput.includes(normalizedLauncherPath),
    manageable: true,
  }
}

async function setAutoStart(enabled) {
  const launcherPath = process.env.GRANAFLOW_LAUNCHER_EXE_PATH

  if (process.platform !== 'win32' || !launcherPath) {
    const error = new Error('Inicio automatico disponivel apenas pelo executavel do Windows.')
    error.statusCode = 400
    throw error
  }

  if (enabled) {
    await runCommand('reg.exe', ['add', runRegistryKey, '/v', appName, '/t', 'REG_SZ', '/d', `"${launcherPath}"`, '/f'])
    return
  }

  await runCommand('reg.exe', ['delete', runRegistryKey, '/v', appName, '/f'], { allowFailure: true })
}

function getManagedGranaFlowPath(envName, label) {
  const rawPath = process.env[envName]

  if (!rawPath) {
    const error = new Error(`${label} nao esta disponivel nesta execucao.`)
    error.statusCode = 400
    throw error
  }

  const managedPath = resolve(rawPath)

  if (basename(managedPath).toLowerCase() !== 'granaflow') {
    const error = new Error(`${label} nao parece ser uma pasta gerenciada do GranaFlow.`)
    error.statusCode = 400
    throw error
  }

  return managedPath
}

async function createResetScript() {
  const scriptPath = resolve(tmpdir(), `granaflow-reset-${process.pid}.ps1`)
  const script = [
    'param(',
    '  [int]$ParentPid,',
    '  [string]$ConfigRoot,',
    '  [string]$InstallRoot',
    ')',
    '$ErrorActionPreference = "SilentlyContinue"',
    'try { Wait-Process -Id $ParentPid -Timeout 20 } catch {}',
    'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "GranaFlow" /f | Out-Null',
    'if ($ConfigRoot) { Remove-Item -LiteralPath $ConfigRoot -Recurse -Force -ErrorAction SilentlyContinue }',
    'if ($InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue }',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
    '',
  ].join('\r\n')

  await writeFile(scriptPath, script, 'utf8')
  return scriptPath
}

async function resetUserData() {
  const configRoot = getManagedGranaFlowPath('GRANAFLOW_CONFIG_ROOT', 'Pasta de configuracao')
  const installRoot = getManagedGranaFlowPath('GRANAFLOW_INSTALL_ROOT', 'Pasta local')
  const scriptPath = await createResetScript()

  await setAutoStart(false).catch(() => undefined)
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-ParentPid',
    String(process.pid),
    '-ConfigRoot',
    configRoot,
    '-InstallRoot',
    installRoot,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })

  child.unref()
  closeServerSoon()

  return { ok: true }
}

function shutdownApp() {
  closeServerSoon()

  return { ok: true }
}

async function triggerPluggyHardUpdate() {
  const config = getConfig()
  const apiKey = await authenticate(config)

  let item

  try {
    item = await pluggyFetch(`/items/${config.itemId}`, apiKey, {
      body: '{}',
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
    })
  } catch (error) {
    const pluggyMessage = `${error.pluggyMessage ?? ''} ${error.details ?? ''}`.toLowerCase()

    if (pluggyMessage.includes('meupluggy item cant be updated')) {
      const manualOnlyError = new Error(
        'Este item do Meu Pluggy não aceita hard update pela API. Atualize pelo Meu Pluggy e depois use Atualizar no GranaFlow.',
      )
      manualOnlyError.statusCode = 409
      manualOnlyError.code = 'MEUPLUGGY_MANUAL_UPDATE_REQUIRED'
      manualOnlyError.details = 'A Pluggy bloqueou o update direto deste Item.'
      manualOnlyError.manualOnly = true
      throw manualOnlyError
    }

    throw error
  }

  return {
    item,
    ok: true,
    triggeredAt: new Date().toISOString(),
  }
}

function closeServerSoon() {
  setTimeout(() => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }, 250).unref()
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
    const payload = parseJsonObject(text)
    const error = new Error(`Pluggy respondeu ${response.status}`)
    error.statusCode = response.status
    error.details = safeErrorDetails(text)
    error.pluggyCode = payload?.code
    error.pluggyMessage = payload?.message
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
      search.set('after', cursor)
    }

    const page = await pluggyFetch(`/v2/transactions?${search.toString()}`, apiKey)
    transactions.push(...(page.results ?? []))
    cursor = getNextTransactionCursor(page.next)
  } while (cursor)

  return transactions
}

function getNextTransactionCursor(next) {
  if (!next || typeof next !== 'string') {
    return null
  }

  if (!next.includes('=')) {
    return next
  }

  const search = next.startsWith('?') ? next.slice(1) : next.split('?')[1]

  if (!search) {
    return next
  }

  return new URLSearchParams(search).get('after')
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
    createdAt: transaction.createdAt ?? null,
    isBudgetExpense: budgetAmount < 0,
    ignoredForBudget: budgetAmount === 0,
    ignoreReason: getIgnoreReason(account, transaction, rawCategory, description),
    installmentNumber: Number(transaction.creditCardMetadata?.installmentNumber ?? 0) || null,
    purchaseDate: transaction.creditCardMetadata?.purchaseDate ?? null,
    totalInstallments: Number(transaction.creditCardMetadata?.totalInstallments ?? 0) || null,
    originalAmount: rawAmount,
    originalCurrencyCode: currency.originalCurrencyCode,
    convertedAmount: currency.convertedAmount,
    currencyCode: currency.accountCurrencyCode,
    fxRate: currency.fxRate,
    fxSource: currency.fxSource,
    fxDate: currency.fxDate,
  }
}

function isInstallmentTransaction(transaction) {
  return Number(transaction.totalInstallments ?? 0) > 1 || Number(transaction.installmentNumber ?? 0) > 1
}

function isRecurringEligibleTransaction(transaction) {
  return transaction.budgetAmount < 0 && !isInstallmentTransaction(transaction)
}

function isAutoRecurringEligibleTransaction(transaction) {
  return isRecurringEligibleTransaction(transaction) && !autoRecurringExcludedCategories.has(transaction.category)
}

function normalizeRecurringDescription(description) {
  return String(description ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d+\s*x\s*\d+\b/g, ' ')
    .replace(/\b\d+\s*\/\s*\d+\b/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function getRecurringTransactionKey(transaction) {
  const normalizedDescription = normalizeRecurringDescription(transaction.description)

  if (normalizedDescription.length < 4) {
    return null
  }

  return `${transaction.method}|${transaction.category}|${normalizedDescription}`
}

function getDateOnly(value) {
  return typeof value === 'string' ? value.slice(0, 10) : ''
}

function getMonthKeyFromDate(value) {
  return getDateOnly(value).slice(0, 7)
}

function getMonthIndex(monthKey) {
  const year = Number(monthKey.slice(0, 4))
  const month = Number(monthKey.slice(5, 7))

  return year * 12 + month
}

function getRecentRecurringCutoff() {
  const today = new Date()

  return formatDate(new Date(today.getFullYear(), today.getMonth() - 4, 1))
}

function getDayOfMonth(value) {
  return Number(getDateOnly(value).slice(8, 10)) || 1
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)

  if (!sorted.length) {
    return 0
  }

  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function mostCommon(values, fallback = '') {
  const counts = new Map()

  for (const value of values) {
    if (!value) {
      continue
    }

    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback
}

function detectRecurringRules(transactions) {
  const groups = new Map()

  for (const transaction of transactions) {
    if (!isAutoRecurringEligibleTransaction(transaction)) {
      continue
    }

    const key = getRecurringTransactionKey(transaction)

    if (!key) {
      continue
    }

    if (!groups.has(key)) {
      groups.set(key, [])
    }

    groups.get(key).push(transaction)
  }

  return [...groups.entries()]
    .map(([key, group]) => buildDetectedRecurringRule(key, group))
    .filter(Boolean)
    .sort((a, b) => b.amount - a.amount)
}

function buildDetectedRecurringRule(key, group) {
  const sorted = [...group].sort((a, b) => getDateOnly(a.date).localeCompare(getDateOnly(b.date)))
  const monthIndexes = [...new Set(sorted.map((item) => getMonthIndex(getMonthKeyFromDate(item.date))))].sort((a, b) => a - b)
  const monthCount = monthIndexes.length

  if (monthCount < 3) {
    return null
  }

  const monthIntervals = monthIndexes.slice(1).map((monthIndex, index) => monthIndex - monthIndexes[index])
  const medianInterval = median(monthIntervals)
  const latestDate = getDateOnly(sorted.at(-1).date)
  const recentCutoff = getRecentRecurringCutoff()

  if (medianInterval > 1.25 || !monthIntervals.includes(1) || latestDate < recentCutoff) {
    return null
  }

  const amounts = sorted.map((item) => Math.abs(item.budgetAmount))
  const amount = roundMoney(median(amounts))
  const maxDeviation = amount > 0 ? Math.max(...amounts.map((value) => Math.abs(value - amount))) / amount : 1

  if (maxDeviation > 0.35) {
    return null
  }

  const latest = sorted.at(-1)

  return {
    amount,
    category: mostCommon(sorted.map((item) => item.category), latest.category),
    confidence: roundRate(Math.min(0.95, 0.48 + monthCount * 0.1 - Math.min(maxDeviation, 0.5) * 0.2)),
    createdAt: new Date().toISOString(),
    dayOfMonth: Math.round(median(sorted.map((item) => getDayOfMonth(item.date)))),
    firstSeen: getDateOnly(sorted[0].date),
    id: `detected:${key}`,
    key,
    label: latest.description,
    lastSeen: getDateOnly(latest.date),
    method: mostCommon(sorted.map((item) => item.method), latest.method),
    merchantSource: mostCommon(sorted.map((item) => item.source), latest.source),
    occurrences: sorted.length,
    origin: 'detected',
    updatedAt: new Date().toISOString(),
  }
}

function createManualRecurringRuleFromTransaction(transaction) {
  const normalizedTransaction = {
    ...transaction,
    budgetAmount: Number(transaction.budgetAmount ?? -Math.abs(Number(transaction.amount ?? 0))),
    category: transaction.category ?? 'Outros',
    date: transaction.date,
    description: transaction.description ?? 'Recorrente',
    method: transaction.method === 'Credito' ? 'Credito' : 'Conta',
    source: transaction.source ?? '',
  }
  const key = getRecurringTransactionKey(normalizedTransaction)

  if (!key || !isRecurringEligibleTransaction(normalizedTransaction)) {
    const error = new Error('Essa movimentacao nao parece elegivel para recorrencia.')
    error.statusCode = 400
    throw error
  }

  const now = new Date().toISOString()

  return {
    amount: roundMoney(Math.abs(Number(normalizedTransaction.budgetAmount))),
    category: normalizedTransaction.category,
    createdAt: now,
    dayOfMonth: getDayOfMonth(normalizedTransaction.date),
    firstSeen: getDateOnly(normalizedTransaction.date),
    id: randomUUID(),
    key,
    label: normalizedTransaction.description,
    lastSeen: getDateOnly(normalizedTransaction.date),
    method: normalizedTransaction.method,
    merchantSource: normalizedTransaction.source,
    occurrences: 1,
    origin: 'manual',
    updatedAt: now,
  }
}

function mergeRecurringRules(transactions, store) {
  const ignoredKeys = new Set(store.ignoredKeys ?? [])
  const manualRules = (store.rules ?? []).filter((rule) => rule.origin === 'manual')
  const manualKeys = new Set(manualRules.map((rule) => rule.key))
  const detectedRules = detectRecurringRules(transactions).filter(
    (rule) => !ignoredKeys.has(rule.key) && !manualKeys.has(rule.key),
  )

  return [...manualRules, ...detectedRules].sort((a, b) => b.amount - a.amount)
}

function serializeRecurringRule(rule, currentMonthItem = null) {
  return {
    amount: roundMoney(rule.amount),
    category: rule.category,
    confidence: rule.confidence ?? null,
    currentMonthExpectedDate: currentMonthItem?.expectedDate ?? null,
    currentMonthStatus: currentMonthItem?.status === 'paid' ? 'paid' : 'pending',
    dayOfMonth: rule.dayOfMonth,
    firstSeen: rule.firstSeen,
    id: rule.id,
    key: rule.key,
    label: rule.label,
    lastSeen: rule.lastSeen,
    method: rule.method,
    merchantSource: rule.merchantSource,
    occurrences: rule.occurrences,
    origin: rule.origin,
  }
}

function serializeRecurringCandidate(transaction) {
  return {
    amount: roundMoney(Math.abs(transaction.budgetAmount)),
    category: transaction.category,
    date: getDateOnly(transaction.date),
    description: transaction.description,
    id: transaction.id,
    key: getRecurringTransactionKey(transaction),
    method: transaction.method,
    source: transaction.source,
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
    date: investment.date ?? null,
    purchaseDate: investment.purchaseDate ?? null,
    updatedAt: investment.updatedAt ?? null,
    balance: roundMoney(Number(investment.balance ?? 0)),
    amount: roundMoney(Number(investment.amount ?? 0)),
    quantity: Number(investment.quantity ?? 0),
    currencyCode: investment.currencyCode ?? 'BRL',
  }
}

function getDateKey(value) {
  if (typeof value !== 'string') {
    return null
  }

  const date = value.slice(0, 10)

  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function getInvestmentPositionDate(investment) {
  return getDateKey(investment.purchaseDate) ?? getDateKey(investment.date)
}

function getLatestDate(dates) {
  return dates.filter(Boolean).sort((a, b) => a.localeCompare(b)).at(-1) ?? null
}

function getPendingInvestmentSyncAmount(transactions, investments, netInvestmentContribution) {
  if (netInvestmentContribution <= 0) {
    return 0
  }

  const latestContributionDate = getLatestDate(
    transactions
      .filter((item) => item.rawCategory === 'Investments' && item.amount < 0)
      .map((item) => getDateKey(item.date)),
  )

  if (!latestContributionDate) {
    return 0
  }

  const latestActivePositionDate = getLatestDate(
    investments
      .filter(
        (investment) =>
          investment.status !== 'TOTAL_WITHDRAWAL' &&
          (Number(investment.amount ?? 0) > 0 || Number(investment.balance ?? 0) > 0),
      )
      .map(getInvestmentPositionDate),
  )
  const pendingWindowTransactions = latestActivePositionDate
    ? transactions.filter((item) => {
        const date = getDateKey(item.date)

        return Boolean(date) && date > latestActivePositionDate
      })
    : transactions
  const pendingContributions = pendingWindowTransactions
    .filter((item) => item.rawCategory === 'Investments' && item.amount < 0)
    .reduce((sum, item) => sum + Math.abs(item.amount), 0)
  const pendingRedemptions = pendingWindowTransactions
    .filter((item) => item.rawCategory === 'Investments' && item.amount > 0)
    .reduce((sum, item) => sum + item.amount, 0)
  const pendingNetContribution = roundMoney(pendingContributions - pendingRedemptions)
  const hasZeroPositionAfterContribution = investments.some((investment) => {
    const positionDate = getInvestmentPositionDate(investment)

    return (
      investment.status === 'TOTAL_WITHDRAWAL' &&
      Number(investment.amount ?? 0) === 0 &&
      Number(investment.balance ?? 0) === 0 &&
      Boolean(positionDate) &&
      positionDate >= latestContributionDate
    )
  })
  const hasContributionAfterLatestPosition = !latestActivePositionDate || latestContributionDate > latestActivePositionDate

  return pendingNetContribution > 0 && (hasZeroPositionAfterContribution || hasContributionAfterLatestPosition)
    ? pendingNetContribution
    : 0
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

function getMonthsInRange(dateFrom, dateTo) {
  const months = []
  const start = new Date(Number(dateFrom.slice(0, 4)), Number(dateFrom.slice(5, 7)) - 1, 1)
  const end = new Date(Number(dateTo.slice(0, 4)), Number(dateTo.slice(5, 7)) - 1, 1)

  for (const cursor = new Date(start); cursor <= end; cursor.setMonth(cursor.getMonth() + 1)) {
    months.push({
      key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      month: cursor.getMonth(),
      year: cursor.getFullYear(),
    })
  }

  return months
}

function getExpectedRecurringDate(rule, month) {
  const lastDay = new Date(month.year, month.month + 1, 0).getDate()
  const day = Math.min(Math.max(Number(rule.dayOfMonth ?? 1), 1), lastDay)

  return formatDate(new Date(month.year, month.month, day))
}

function isClosedMonth(month) {
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const monthEnd = new Date(month.year, month.month + 1, 0)

  return monthEnd < todayStart
}

function hasRuleStarted(rule, monthKey) {
  if (!rule.firstSeen) {
    return true
  }

  return monthKey >= String(rule.firstSeen).slice(0, 7)
}

function findPaidRecurringTransaction(rule, transactions, expectedDate, usedTransactionIds) {
  const candidates = transactions
    .filter((transaction) => {
      if (usedTransactionIds.has(transaction.id) || !isRecurringEligibleTransaction(transaction)) {
        return false
      }

      return getRecurringTransactionKey(transaction) === rule.key
    })
    .map((transaction) => {
      const amount = Math.abs(transaction.budgetAmount)
      const amountDistance = Math.abs(amount - rule.amount)
      const dayDistance = Math.abs(new Date(`${getDateOnly(transaction.date)}T12:00:00Z`) - new Date(`${expectedDate}T12:00:00Z`))

      return { amount, amountDistance, dayDistance, transaction }
    })
    .sort((a, b) => a.dayDistance - b.dayDistance || a.amountDistance - b.amountDistance)

  if (!candidates.length) {
    return null
  }

  const tolerance = Math.max(10, rule.amount * 0.45)
  const match = candidates.find((candidate) => candidate.amountDistance <= tolerance) ?? (candidates.length === 1 ? candidates[0] : null)

  return match?.transaction ?? null
}

function buildPlannedExpenses(rules, transactions, dateFrom, dateTo) {
  const usedTransactionIds = new Set()
  const items = []

  for (const month of getMonthsInRange(dateFrom, dateTo)) {
    for (const rule of rules) {
      if (!hasRuleStarted(rule, month.key)) {
        continue
      }

      const expectedDate = getExpectedRecurringDate(rule, month)

      if (expectedDate < dateFrom || expectedDate > dateTo) {
        continue
      }

      const paidTransaction = findPaidRecurringTransaction(rule, transactions, expectedDate, usedTransactionIds)
      const paidAmount = paidTransaction ? Math.abs(paidTransaction.budgetAmount) : 0

      if (paidTransaction) {
        usedTransactionIds.add(paidTransaction.id)
      }

      if (!paidTransaction && isClosedMonth(month)) {
        continue
      }

      items.push({
        amount: roundMoney(rule.amount),
        category: rule.category,
        expectedDate,
        key: rule.key,
        label: rule.label,
        method: paidTransaction?.method ?? rule.method,
        paidAmount: roundMoney(paidAmount),
        paidTransactionId: paidTransaction?.id ?? null,
        remainingAmount: paidTransaction ? 0 : roundMoney(rule.amount),
        ruleId: rule.id,
        status: paidTransaction ? 'paid' : 'planned',
      })
    }
  }

  const plannedItems = items.filter((item) => item.status === 'planned')
  const paidItems = items.filter((item) => item.status === 'paid')

  return {
    bankExpenses: roundMoney(plannedItems.filter((item) => item.method !== 'Credito').reduce((sum, item) => sum + item.remainingAmount, 0)),
    cardExpenses: roundMoney(plannedItems.filter((item) => item.method === 'Credito').reduce((sum, item) => sum + item.remainingAmount, 0)),
    count: items.length,
    expenses: roundMoney(plannedItems.reduce((sum, item) => sum + item.remainingAmount, 0)),
    items,
    paidAmount: roundMoney(paidItems.reduce((sum, item) => sum + item.paidAmount, 0)),
    paidCount: paidItems.length,
    totalAmount: roundMoney(items.reduce((sum, item) => sum + item.amount, 0)),
  }
}

const emptyPlannedExpenses = {
  bankExpenses: 0,
  cardExpenses: 0,
  count: 0,
  expenses: 0,
  items: [],
  paidAmount: 0,
  paidCount: 0,
  totalAmount: 0,
}

function buildSummary(accounts, transactions, investments, bills, dateFrom, dateTo, plannedExpenses = emptyPlannedExpenses) {
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
  const netInvestmentContribution = investmentContributions - investmentRedemptions
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
  const investmentPendingSyncAmount = getPendingInvestmentSyncAmount(transactions, investments, netInvestmentContribution)
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
    investmentPendingSyncAmount,
    investmentRedemptions: roundMoney(investmentRedemptions),
    hasPendingInvestmentSync: investmentPendingSyncAmount > 0,
    monthlyProjection: roundMoney(monthlyProjection),
    netCashflow: roundMoney(income - expenses),
    netInvestmentContribution: roundMoney(netInvestmentContribution),
    plannedBankExpenses: plannedExpenses.bankExpenses,
    plannedCardExpenses: plannedExpenses.cardExpenses,
    plannedExpenseCount: plannedExpenses.count,
    plannedExpenseItems: plannedExpenses.items,
    plannedExpensePaidAmount: plannedExpenses.paidAmount,
    plannedExpensePaidCount: plannedExpenses.paidCount,
    plannedExpenseTotal: plannedExpenses.totalAmount,
    plannedExpenses: plannedExpenses.expenses,
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

function parseJsonObject(text) {
  try {
    const payload = JSON.parse(text)

    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
  } catch {
    return null
  }
}

function filterTransactionsByDate(transactions, dateFrom, dateTo) {
  return transactions.filter((transaction) => {
    const date = getDateOnly(transaction.date)

    return date >= dateFrom && date <= dateTo
  })
}

function getRecurringHistoryStart(dateFrom) {
  const year = Number(dateFrom.slice(0, 4))
  const monthIndex = Number(dateFrom.slice(5, 7)) - 1

  return formatDate(new Date(year - 1, monthIndex, 1))
}

async function fetchItemAccountsAndTransactions(config, dateFrom, dateTo) {
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

  return { accounts, apiKey, item, transactions }
}

async function fetchInvestmentsAndBills(apiKey, config, accounts) {
  const [investmentPayload, billPages] = await Promise.all([
    fetchInvestments(apiKey, config.itemId),
    Promise.all(accounts.filter((account) => account.type === 'CREDIT').map((account) => fetchBills(apiKey, account.id).then((bills) => bills.map((bill) => normalizeBill(bill, account))))),
  ])

  return {
    bills: billPages.flat().sort((a, b) => (b.dueDate ?? '').localeCompare(a.dueDate ?? '')),
    investments: investmentPayload.map(normalizeInvestment),
  }
}

async function getRecurringContext(transactions) {
  const store = await readRecurringStore()
  const rules = mergeRecurringRules(transactions, store)

  return { rules, store }
}

async function getRecurringOverview(requestUrl) {
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
  const historyFrom = getRecurringHistoryStart(yearStart)
  const { transactions } = await fetchItemAccountsAndTransactions(config, historyFrom, yearEnd)
  const { rules, store } = await getRecurringContext(transactions)
  const currentMonthStart = formatDate(new Date(today.getFullYear(), today.getMonth(), 1))
  const currentMonthEnd = formatDate(new Date(today.getFullYear(), today.getMonth() + 1, 0))
  const currentMonthTransactions = filterTransactionsByDate(transactions, currentMonthStart, currentMonthEnd)
  const currentMonthPlanned = buildPlannedExpenses(rules, currentMonthTransactions, currentMonthStart, currentMonthEnd)
  const currentMonthItemsByKey = new Map(currentMonthPlanned.items.map((item) => [item.key, item]))
  const activeKeys = new Set(rules.map((rule) => rule.key))
  const seenCandidateKeys = new Set()
  const candidates = []

  for (const transaction of transactions) {
    if (!isRecurringEligibleTransaction(transaction)) {
      continue
    }

    const key = getRecurringTransactionKey(transaction)

    if (!key || activeKeys.has(key) || seenCandidateKeys.has(key)) {
      continue
    }

    seenCandidateKeys.add(key)
    candidates.push(serializeRecurringCandidate(transaction))

    if (candidates.length >= 48) {
      break
    }
  }

  return {
    candidates,
    ignoredCount: store.ignoredKeys.length,
    rules: rules.map((rule) => serializeRecurringRule(rule, currentMonthItemsByKey.get(rule.key))),
  }
}

async function addRecurringRule(request) {
  const body = await readJsonBody(request)
  const transaction = body.transaction

  if (!transaction || typeof transaction !== 'object') {
    const error = new Error('Envie uma movimentacao para criar a recorrencia.')
    error.statusCode = 400
    throw error
  }

  const store = await readRecurringStore()
  const rule = createManualRecurringRuleFromTransaction(transaction)

  store.rules = [...(store.rules ?? []).filter((item) => item.key !== rule.key), rule]
  store.ignoredKeys = (store.ignoredKeys ?? []).filter((key) => key !== rule.key)
  await writeRecurringStore(store)

  return { rule: serializeRecurringRule(rule) }
}

async function removeRecurringRule(request) {
  const body = await readJsonBody(request)
  const key = typeof body.key === 'string' ? body.key : null
  const id = typeof body.id === 'string' ? body.id : null

  if (!key && !id) {
    const error = new Error('Informe a recorrencia que deve ser removida.')
    error.statusCode = 400
    throw error
  }

  const store = await readRecurringStore()
  const removedRule = (store.rules ?? []).find((rule) => rule.id === id || rule.key === key)
  const removedKey = key ?? removedRule?.key

  store.rules = (store.rules ?? []).filter((rule) => rule.id !== id && rule.key !== key)

  if (removedKey) {
    store.ignoredKeys = [...new Set([...(store.ignoredKeys ?? []), removedKey])]
  }

  await writeRecurringStore(store)

  return { ok: true }
}

async function getSnapshot(requestUrl) {
  const config = getConfig()
  const today = new Date()
  const defaultTo = formatDate(today)
  const defaultFrom = formatDate(new Date(today.getFullYear(), today.getMonth(), 1))
  const dateFrom = assertDate(requestUrl.searchParams.get('dateFrom'), defaultFrom)
  const dateTo = assertDate(requestUrl.searchParams.get('dateTo'), defaultTo)
  const historyFrom = getRecurringHistoryStart(dateFrom)
  const { accounts, apiKey, item, transactions: historyTransactions } = await fetchItemAccountsAndTransactions(config, historyFrom, dateTo)
  const transactions = filterTransactionsByDate(historyTransactions, dateFrom, dateTo)
  const { rules } = await getRecurringContext(historyTransactions)
  const plannedExpenses = buildPlannedExpenses(rules, transactions, dateFrom, dateTo)
  const { bills, investments } = await fetchInvestmentsAndBills(apiKey, config, accounts)

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
    recurring: {
      planned: plannedExpenses,
      rules: rules.map(serializeRecurringRule),
    },
    summary: buildSummary(accounts, transactions, investments, bills, dateFrom, dateTo, plannedExpenses),
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
  const historyFrom = getRecurringHistoryStart(yearStart)
  const { accounts, apiKey, item, transactions: historyTransactions } = await fetchItemAccountsAndTransactions(config, historyFrom, yearEnd)
  const transactions = filterTransactionsByDate(historyTransactions, yearStart, yearEnd)
  const { rules } = await getRecurringContext(historyTransactions)
  const { bills, investments } = await fetchInvestmentsAndBills(apiKey, config, accounts)
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
    const monthEnd = formatDate(new Date(year, month, 0))
    const monthTransactions = transactions.filter((transaction) => {
      const date = transaction.date.slice(0, 10)
      return date >= monthStart && date <= monthEnd
    })
    const plannedExpenses = buildPlannedExpenses(rules, monthTransactions, monthStart, monthEnd)
    const summary = buildSummary(accounts, monthTransactions, investments, bills, monthStart, monthEnd, plannedExpenses)
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
        plannedExpenses: summary.plannedExpenses,
        plannedExpenseCount: summary.plannedExpenseCount,
        plannedExpensePaidCount: summary.plannedExpensePaidCount,
      },
    }
  })
  const currentPlannedExpenses = buildPlannedExpenses(rules, transactions, yearStart, yearEnd)
  const currentSummary = buildSummary(accounts, transactions, investments, bills, yearStart, yearEnd, currentPlannedExpenses)
  const accountBalance = currentSummary.accountBalance
  const investmentAmount = currentSummary.investmentAmount
  const investmentBalance = currentSummary.investmentBalance
  const investmentPendingSyncAmount = currentSummary.investmentPendingSyncAmount
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
      investmentAmount,
      investmentBalance,
      investmentPendingSyncAmount,
      hasPendingInvestmentSync: currentSummary.hasPendingInvestmentSync,
      netBalance: roundMoney(accountBalance + investmentBalance - creditBalance),
      plannedExpenses: currentSummary.plannedExpenses,
    },
    months,
    recurring: {
      rules: rules.map(serializeRecurringRule),
    },
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
      json(response, 200, await getConfigStatus())
      return
    }

    if (requestUrl.pathname === '/api/config' && request.method === 'POST') {
      json(response, 200, await savePluggyConfig(request))
      return
    }

    if (requestUrl.pathname === '/api/app/reset' && request.method === 'POST') {
      json(response, 200, await resetUserData())
      return
    }

    if (requestUrl.pathname === '/api/app/shutdown' && request.method === 'POST') {
      json(response, 200, shutdownApp())
      return
    }

    if (requestUrl.pathname === '/api/recurring' && request.method === 'GET') {
      json(response, 200, await getRecurringOverview(requestUrl))
      return
    }

    if (requestUrl.pathname === '/api/recurring/rules' && request.method === 'POST') {
      json(response, 200, await addRecurringRule(request))
      return
    }

    if (requestUrl.pathname === '/api/recurring/remove' && request.method === 'POST') {
      json(response, 200, await removeRecurringRule(request))
      return
    }

    if (requestUrl.pathname === '/api/pluggy/hard-update' && request.method === 'POST') {
      json(response, 200, await triggerPluggyHardUpdate())
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
      code: error.code ?? null,
      error: error.message || 'Erro inesperado.',
      details: error.details ?? null,
      manualOnly: Boolean(error.manualOnly),
    })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`GranaFlow API em http://127.0.0.1:${port}`)
})
