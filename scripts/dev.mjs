import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { loadLocalEnv } from '../server/env.mjs'

loadLocalEnv()

const processes = [
  spawn(process.execPath, ['server/index.mjs'], {
    env: process.env,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173'], {
    env: process.env,
    stdio: 'inherit',
  }),
]

function shutdown(signal) {
  for (const child of processes) {
    if (!child.killed) {
      child.kill(signal)
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal)
    process.exit(0)
  })
}

for (const child of processes) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      shutdown('SIGTERM')
      process.exit(code)
    }
  })
}
