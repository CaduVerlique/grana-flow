import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const releaseDir = resolve('release/win-x64')
const launcherResourcesDir = resolve('launcher/GranaFlow.Launcher/Resources')
const appBundlePath = resolve(launcherResourcesDir, 'app.zip')
const embeddedNodePath = resolve(launcherResourcesDir, 'node.exe')

run('npm', ['run', 'build'])

prepareLauncherResources()

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
    'Requisitos:',
    '- Windows x64.',
    '- Internet para sincronizar dados da Pluggy e baixar updates automaticos.',
    '',
    'No primeiro uso, o launcher pergunta a porta, credenciais Pluggy e se deve iniciar com o Windows.',
    'As credenciais podem ficar em branco e serem preenchidas depois pela UI.',
    '',
    'Nao e necessario instalar Git, Node.js, npm ou .NET.',
    'O launcher consulta GitHub Releases para atualizar o proprio executavel.',
    'O app e o Node portatil ficam em %LOCALAPPDATA%\\GranaFlow.',
    'Logs do servidor ficam em %APPDATA%\\GranaFlow\\logs.',
    '',
  ].join('\r\n'),
  'utf8',
)

console.log(`Release gerada em ${releaseDir}`)

function prepareLauncherResources() {
  rmSync(launcherResourcesDir, { recursive: true, force: true })
  mkdirSync(launcherResourcesDir, { recursive: true })

  copyFileSync(process.execPath, embeddedNodePath)
  createAppBundle()
}

function createAppBundle() {
  if (!existsSync(resolve('dist/index.html'))) {
    console.error('dist/index.html nao encontrado. O build do frontend falhou?')
    process.exit(1)
  }

  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      '$ErrorActionPreference = "Stop"',
      `Compress-Archive -Path @(${quotePowerShellPath(resolve('server'))}, ${quotePowerShellPath(resolve('dist'))}) -DestinationPath ${quotePowerShellPath(appBundlePath)} -Force`,
    ].join('; '),
  ])
}

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

function quotePowerShellPath(value) {
  return `'${value.replaceAll("'", "''")}'`
}
