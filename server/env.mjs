import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadLocalEnv(filename = '.env.local') {
  const envPath = resolve(process.cwd(), filename)

  if (!existsSync(envPath)) {
    return
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)

    if (!match) {
      continue
    }

    const [, key, rawValue] = match
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')

    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}
