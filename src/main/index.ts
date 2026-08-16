/**
 * Desktop shell for the DeepSeek Harness web app.
 *
 * The Harness ships as a separate project. This shell launches its packaged
 * `dsh web` child process (the standalone CLI distribution, official Node
 * included), waits for its readiness line, then loads the served URL in a
 * BrowserWindow. The child process owns all agent work; this process only
 * owns the window and the child's lifecycle.
 */

import { app, BrowserWindow, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

const DSH_HOST = '127.0.0.1'
const READY_LINE = 'dsh web: http://'
const START_TIMEOUT_MS = 60_000
const SHUTDOWN_GRACE_MS = 5_000

let dshProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null

/**
 * True once the user asked to quit (Cmd+Q / app.quit()). On macOS the window
 * close button hides the window instead of destroying it (so the running
 * session survives); only a real quit destroys windows and stops the server.
 */
let isQuitting = false

interface DshLaunch {
  /** The executable to spawn. */
  command: string
  /** Arguments placed before the `web` subcommand. */
  commandArgs: string[]
  /** Extra environment variables passed to the child process. */
  env: Record<string, string>
  /** Spawn through the shell (required for .cmd launchers on Windows). */
  shell?: boolean
}

/** The deployed dsh CLI entry (`lib/bin.js`) inside the bundled runtime. */
function bundledBinPath(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'dsh-standalone', 'runtime')
    : join(__dirname, '..', '..', 'resources', 'dsh-standalone', 'runtime')
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Resolve how to launch `dsh web`.
 *
 * The shell runs dsh with Electron's OWN embedded Node (Electron 43 embeds
 * Node 24, inside dsh's engines range `^22.19.0 || >=24.0.0`) instead of
 * bundling a separate Node runtime: it spawns `process.execPath` with
 * `ELECTRON_RUN_AS_NODE=1` and `--expose-internals` (dsh's plugin loader only
 * falls back to Node's internal ESM loader when that flag is present), pointing
 * at the deployed runtime's `lib/bin.js` under `resources/dsh-standalone/runtime`.
 * This drops the ~90MB standalone Node from the installer.
 *
 * Precedence: `DSH_EXE` (run an external binary as-is), `DSH_BIN` (run a
 * specific built `lib/bin.js`), then the bundled runtime's `lib/bin.js`.
 */
function resolveDshLaunch(): DshLaunch {
  const exeOverride = process.env.DSH_EXE
  if (exeOverride !== undefined && exeOverride !== '') {
    if (!existsSync(exeOverride)) throw new Error(`DSH_EXE does not exist: ${exeOverride}`)
    return { command: exeOverride, commandArgs: [], env: {} }
  }

  const binOverride = process.env.DSH_BIN
  const binPath = binOverride !== undefined && binOverride !== '' ? binOverride : bundledBinPath()
  if (!existsSync(binPath)) {
    throw new Error(
      `bundled dsh bin.js is missing at ${binPath}. Run \`pnpm run bundle && pnpm run standalone\` before building or launching.`,
    )
  }
  return {
    command: process.execPath,
    commandArgs: ['--expose-internals', binPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

/** Reserve one free loopback port, then release it for the child process. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, DSH_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('failed to resolve an ephemeral loopback port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

/**
 * Spawn `dsh web` and resolve once its readiness line appears.
 * @param port - the loopback port reserved for the child.
 * @returns the URL the Harness serves.
 */
function startDsh(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const launch = resolveDshLaunch()
    const webArgs = ['web', '--host', DSH_HOST, '--port', String(port)]
    const child = spawn(launch.command, [...launch.commandArgs, ...webArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env, FORCE_COLOR: '0' },
      shell: launch.shell === true,
    })
    dshProcess = child

    let settled = false
    let output = ''
    const url = `http://${DSH_HOST}:${port}`

    let timer: NodeJS.Timeout | undefined
    const settle = (ok: boolean, message: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (ok) resolve(url)
      else reject(new Error(message))
    }

    timer = setTimeout(() => {
      settle(false, `timed out after ${START_TIMEOUT_MS / 1000}s waiting for dsh web to become ready.\n${output}`)
    }, START_TIMEOUT_MS)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(`[dsh] ${text.replace(/\n$/, '')}\n`)
      if (text.includes(READY_LINE)) settle(true, '')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      process.stderr.write(`[dsh] ${text.replace(/\n$/, '')}\n`)
    })
    child.once('error', (error) => {
      settle(false, `failed to spawn dsh web: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      dshProcess = null
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      process.stderr.write(`[dsh-exit] ${cause}\n`)
      settle(false, `dsh web exited before becoming ready (${cause}).\n${output}`)
    })
  })
}

/** Stop the child process with a bounded graceful shutdown. */
function stopDsh(): void {
  const child = dshProcess
  if (child === null) return
  dshProcess = null
  if (process.platform === 'win32') {
    // The child runs under a cmd.exe wrapper (dsh.cmd); kill the whole tree.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, SHUTDOWN_GRACE_MS)
  killTimer.unref()
}

/** Open the Harness URL in the main window. */
function createMainWindow(url: string): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#101014',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  // macOS: the red close button hides the window instead of destroying it.
  // The page (current conversation, running replies, drafts) stays loaded and
  // the `dsh web` child keeps running, so clicking the dock icon re-shows the
  // exact same session. A real quit (Cmd+Q) still destroys and stops dsh.
  window.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) void shell.openExternal(target)
    return { action: 'deny' }
  })
  void window.loadURL(url)
}

/** Show the local bootstrap page with a startup failure. */
function showError(message: string): void {
  const window = mainWindow ?? new BrowserWindow({
    width: 800,
    height: 600,
    title: 'DeepSeek Harness',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl !== undefined) {
    void window.loadURL(`${rendererUrl}?error=${encodeURIComponent(message)}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { error: message } })
  }
}

/** Full startup: reserve a port, boot dsh web, then open the window. */
async function start(): Promise<void> {
  try {
    const port = await findFreePort()
    const url = await startDsh(port)
    createMainWindow(url)
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
  }
}

void app.whenReady().then(() => start())

app.on('activate', () => {
  // macOS dock click: re-show the hidden window (same server, same session)
  // instead of spawning a fresh `dsh web`; only boot a new one if none exists.
  if (mainWindow !== null) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    return
  }
  if (BrowserWindow.getAllWindows().length === 0) void start()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  stopDsh()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  stopDsh()
})
