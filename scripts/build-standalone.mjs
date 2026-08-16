#!/usr/bin/env node
/**
 * Build the standalone (no-Electron) dsh distribution.
 *
 * Assembles an official Node runtime next to the deployed dsh runtime
 * (resources/dsh-<arch>, built by `pnpm run bundle`) so the bundled `dsh` CLI
 * runs with zero system dependencies:
 *
 *   resources/dsh-standalone/         the assembled distribution (host platform)
 *     node/    official Node runtime, slimmed to the node binary itself
 *              (bin/node, or node.exe on Windows; npm/npx/corepack, headers
 *              and docs removed — dsh never spawns npm)
 *     runtime/ copy of the deployed dsh runtime (resources/dsh-<arch>)
 *     dsh      POSIX launcher
 *     dsh.cmd  Windows launcher
 *   release/dsh-standalone-<platform>-<arch>.zip
 *
 * The Electron app embeds this same directory (extraResources) and launches
 * the CLI in it, so both distributions share one runtime. The Node version is
 * resolved from the mirror's index (latest v24.x, inside dsh's engines range
 * `^22.19.0 || >=24.0.0`), falling back to v24.18.1 — the Node embedded in the
 * Electron 43 shell. Native addons are N-API based (node-pty, koffi), so the
 * same payload runs under both runtimes.
 *
 * The deployed payload is architecture-bound: native addons link for the
 * installing machine's arch (see bundle-dsh.mjs), so the payload must be
 * built on a machine of the target architecture. Assembly itself is
 * architecture-independent: `--arch arm64` on an x64 machine downloads the
 * arm64 official Node and embeds a payload previously bundled on an arm64
 * machine (resources/dsh-arm64), producing an arm64 standalone and, through
 * electron-builder, an arm64 mac package.
 *
 * Env:
 *   DSH_NODE_VERSION  exact Node version to bundle (default: latest v24.x)
 *   NODE_MIRROR       Node binary mirror (default: npmmirror)
 *
 * Usage:
 *   node scripts/build-standalone.mjs [--arch <x64|arm64>]
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(projectRoot, 'resources', 'dsh-standalone')
const releaseDir = join(projectRoot, 'release')
const cacheDir = join(projectRoot, 'resources', '.node-cache')

function payloadDirFor(arch) {
  return join(projectRoot, 'resources', `dsh-${arch}`)
}

const NODE_MAJOR = '24'
const FALLBACK_NODE_VERSION = 'v24.18.1' // matches Electron 43's embedded Node
const MIRROR = process.env.NODE_MIRROR ?? 'https://npmmirror.com/mirrors/node/'

const NODE_DISTS = {
  darwin: {
    x64: { name: 'darwin-x64', ext: 'tar.gz' },
    arm64: { name: 'darwin-arm64', ext: 'tar.gz' },
  },
  win32: {
    x64: { name: 'win-x64', ext: 'zip' },
    arm64: { name: 'win-arm64', ext: 'zip' },
  },
  linux: {
    x64: { name: 'linux-x64', ext: 'tar.gz' },
    arm64: { name: 'linux-arm64', ext: 'tar.gz' },
  },
}

function fail(message) {
  console.error(`build-standalone: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with status ${result.status}`)
  }
}

async function resolveNodeVersion() {
  const override = process.env.DSH_NODE_VERSION
  if (override !== undefined && override !== '') {
    return `v${override.replace(/^v/, '')}`
  }
  try {
    const response = await fetch(`${MIRROR}index.json`)
    if (response.ok) {
      const index = await response.json()
      const latest = index.find((entry) => entry.version.startsWith(`v${NODE_MAJOR}.`))
      if (latest !== undefined) return latest.version
    }
  } catch {
    // fall back to the pinned version
  }
  return FALLBACK_NODE_VERSION
}

function platformAndArch(targetArch) {
  const platform = process.platform
  const arch = targetArch ?? process.arch
  const dist = NODE_DISTS[platform]?.[arch]
  if (dist === undefined) {
    fail(`unsupported platform/arch: ${platform}/${arch} (supported: darwin, win32, linux × x64, arm64)`)
  }
  return { platform, arch, dist }
}

/**
 * Strip everything the runtime never needs from an extracted official Node
 * distribution: build headers, docs/man pages, and the npm/npx/corepack
 * install (dsh never spawns npm; `dsh plugin` forwards to pnpm on PATH).
 * Keeps bin/node (or node.exe) and the core modules baked into the binary.
 */
function slimNodeDist(nodeDir) {
  const removed = []
  for (const entry of ['include', 'share']) {
    const path = join(nodeDir, entry)
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true })
      removed.push(entry)
    }
  }
  // npm/corepack live in lib/node_modules (posix) or node_modules (win).
  for (const dir of [join(nodeDir, 'lib', 'node_modules'), join(nodeDir, 'node_modules')]) {
    if (!existsSync(dir)) continue
    for (const name of ['npm', 'corepack']) rmSync(join(dir, name), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
    removed.push(dir.slice(nodeDir.length + 1))
  }
  // Entry points: bin/npm etc. (posix) or flat-root npm/npm.cmd/... (win).
  // unlinkSync, not rmSync: Node 23's rmSync leaves symlinks behind on macOS.
  for (const dir of [join(nodeDir, 'bin'), nodeDir]) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!/^(npm|npx|corepack)(\.|$)/.test(entry)) continue
      const entryPath = join(dir, entry)
      try {
        unlinkSync(entryPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  console.log(`build-standalone: slimmed node dist (removed: ${removed.join(', ')})`)
}

async function main() {
  const args = process.argv.slice(2)
  let targetArch
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arch') {
      targetArch = args[i + 1]
      if (targetArch === undefined || targetArch.startsWith('--')) {
        fail('--arch requires a value (x64|arm64)')
      }
      i++
    } else {
      fail(`unknown argument: ${args[i]}`)
    }
  }

  const { platform, arch, dist } = platformAndArch(targetArch)
  const payload = payloadDirFor(arch)
  if (!existsSync(payload)) {
    const hint = arch === process.arch
      ? `run \`pnpm run bundle\` first`
      : `bundle the ${arch} payload on a ${arch} machine (\`pnpm run bundle\` -> resources/dsh-${arch}) and copy it here`
    fail(`deployed dsh runtime not found at ${payload}; ${hint}`)
  }
  console.log(`build-standalone: target ${platform}/${arch}`)

  const version = await resolveNodeVersion()
  const distName = `node-${version}-${dist.name}`
  const archiveName = `${distName}.${dist.ext}`

  const stageDir = mkdtempSync(join(tmpdir(), 'dsh-standalone-'))
  try {
    const cachedArchive = join(cacheDir, archiveName)
    if (existsSync(cachedArchive)) {
      console.log(`build-standalone: using cached ${archiveName}`)
    } else {
      const archiveUrl = `${MIRROR}${version}/${archiveName}`
      console.log(`build-standalone: downloading ${archiveUrl}`)
      mkdirSync(cacheDir, { recursive: true })
      run('curl', ['-fL', '--retry', '3', '-o', cachedArchive, archiveUrl])
    }

    const extractDir = join(stageDir, 'extracted')
    mkdirSync(extractDir)
    console.log(`build-standalone: extracting ${archiveName}`)
    run(dist.ext === 'zip' ? 'tar' : 'tar', dist.ext === 'zip'
      ? ['-xf', cachedArchive, '-C', extractDir]
      : ['-zxf', cachedArchive, '-C', extractDir])

    const extractedRoot = join(extractDir, distName)
    if (!existsSync(extractedRoot)) {
      fail(`unexpected archive layout: ${distName} not found under extract dir`)
    }
    slimNodeDist(extractedRoot)

    const outName = `dsh-standalone-${platform}-${arch}`
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })

    console.log(`build-standalone: assembling ${outDir}`)
    cpSync(extractedRoot, join(outDir, 'node'), { recursive: true })
    cpSync(payload, join(outDir, 'runtime'), { recursive: true })

    const binPath = join(outDir, 'dsh')
    writeFileSync(binPath, `#!/usr/bin/env sh
# Standalone DeepSeek Harness CLI: bundled Node + bundled dsh runtime.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$DIR/node/bin/node" --expose-internals "$DIR/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
`)
    chmodSync(binPath, 0o755)

    writeFileSync(join(outDir, 'dsh.cmd'), `@echo off
setlocal
set "DIR=%~dp0"
"%DIR%node\\node.exe" --expose-internals "%DIR%runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*
`)

    const zipPath = join(releaseDir, `${outName}.zip`)
    rmSync(zipPath, { force: true })
    if (platform === 'darwin') {
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', 'dsh-standalone', zipPath], { cwd: dirname(outDir) })
    } else {
      const zipped = spawnSync('tar', ['-a', '-cf', zipPath, 'dsh-standalone'], { cwd: dirname(outDir), stdio: 'inherit' })
      if (zipped.status !== 0) {
        console.warn(`build-standalone: zip via tar failed (status ${zipped.status}); dist left at ${outDir}`)
      }
    }

    console.log(`build-standalone: done -> ${outDir}`)
    if (existsSync(zipPath)) console.log(`build-standalone: zip -> ${zipPath}`)
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error.message))
