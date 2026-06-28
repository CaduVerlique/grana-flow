import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const releaseDir = resolve('release/win-x64')

run('npm', ['run', 'build'])
run('dotnet', [
  'publish',
  'launcher/GranaFlow.Launcher/GranaFlow.Launcher.csproj',
  '-c',
  'Release',
  '-r',
  'win-x64',
  '--self-contained',
  'true',
  '-p:PublishSingleFile=true',
  '-p:PublishTrimmed=false',
  '-o',
  releaseDir,
])

mkdirSync(releaseDir, { recursive: true })
writeFileSync(
  resolve(releaseDir, 'README-RELEASE.txt'),
  [
    'GranaFlow Windows release',
    '',
    'Abra GranaFlow.exe.',
    '',
    'Requisitos para esta versao:',
    '- Git instalado para clonar/sincronizar o app na tag da release.',
    '- Node.js e npm instalados para instalar dependencias e rodar o servidor local.',
    '',
    'No primeiro uso, o launcher pergunta a porta, credenciais Pluggy e se deve iniciar com o Windows.',
    'As credenciais podem ficar em branco e serem preenchidas depois pela UI.',
    '',
    'O launcher consulta GitHub Releases para atualizar o proprio executavel.',
    'O app fica em %LOCALAPPDATA%\\GranaFlow\\app e e sincronizado com a mesma tag da release.',
    'Logs do servidor ficam em %APPDATA%\\GranaFlow\\logs.',
    '',
  ].join('\r\n'),
  'utf8',
)

console.log(`Release gerada em ${releaseDir}`)

function run(command, args) {
  const { executable, executableArgs } = getExecutable(command, args)
  const result = spawnSync(executable, executableArgs, {
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function getExecutable(command, args) {
  if (process.platform === 'win32' && command === 'npm') {
    return {
      executable: 'cmd.exe',
      executableArgs: ['/d', '/s', '/c', ['npm', ...args].join(' ')],
    }
  }

  return { executable: command, executableArgs: args }
}
