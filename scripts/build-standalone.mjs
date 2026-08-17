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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
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

/**
 * Files that ship in npm packages but are never needed at runtime. Dropping
 * them from the deployed dsh runtime cuts ~17k small files and ~120MB
 * (.d.ts/.map/.md + Windows .pdb debug symbols + shipped test folders), which
 * dramatically speeds up both installer creation and installation (NSIS
 * creates every file one by one; small-file count dominates install time).
 * LICENSE files are kept for legal compliance.
 */
const RUNTIME_DROP_PATTERN =
  /(?:\.d\.(?:m|c)?ts$|\.d\.(?:m|c)?ts\.map$|\.map$|\.tsbuildinfo$|\.md$|\.pdb$|^readme(?:\.|$)|^changelog(?:\.|$))/i
/** Directories that only ever hold tests, never runtime code. */
const RUNTIME_DROP_DIRS = new Set(['test', 'tests'])

/** Total bytes under a directory tree (follows no symlinks). */
function dirSize(d) {
  let s = 0
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) s += dirSize(p)
    else s += statSync(p).size
  }
  return s
}

/** Total files under a directory tree (follows no symlinks). */
function countFiles(d) {
  let n = 0
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(d, e.name))
    else n += 1
  }
  return n
}

/** Recursively strip non-runnable files from a deployed runtime tree. */
function slimRuntime(runtimeDir) {
  const removed = { files: 0, bytes: 0 }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (RUNTIME_DROP_DIRS.has(entry.name)) {
          removed.bytes += dirSize(p)
          removed.files += countFiles(p)
          rmSync(p, { recursive: true, force: true })
          continue
        }
        walk(p)
        try {
          if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true })
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        continue
      }
      if (!RUNTIME_DROP_PATTERN.test(entry.name)) continue
      removed.files += 1
      try {
        removed.bytes += statSync(p).size
        rmSync(p, { force: true })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  walk(runtimeDir)
  const mb = Math.round(removed.bytes / 1024 / 1024)
  console.log(`build-standalone: slimmed runtime (-${removed.files} files, -${mb}MB)`)
}

/**
 * Directory-name pattern for node-style platform/arch variants as used by
 * packages that ship every target's binaries inside one package tree
 * (node-pty keeps prebuilds/{darwin,linux,win32}-{x64,arm64,...} in-place).
 * pnpm already filters *optional platform packages* (sharp, koffi 3.x,
 * ripgrep) by os/cpu, but these single-package multi-target trees survive
 * `pnpm deploy` whole.
 */
const NATIVE_VARIANT_DIR =
  /^(darwin|linux|win32|freebsd|openbsd|sunos|android)-(x64|arm64|ia32|arm|armv7|armv8|loong64|ppc64|s390x|riscv64|x86)$/

/**
 * Drop every native prebuild variant that is not the target platform/arch.
 * The deployed runtime is platform-bound (resources/dsh-<arch> feeds the
 * matching standalone zip and Electron package), so foreign prebuilds are
 * dead weight that only inflates installer size and install time.
 */
export function slimNativeVariants(runtimeDir, platform, arch) {
  const target = `${platform}-${arch}`
  const removed = { files: 0, bytes: 0 }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const p = join(dir, entry.name)
      if (entry.name === 'prebuilds') {
        for (const variant of readdirSync(p, { withFileTypes: true })) {
          if (!variant.isDirectory()) continue
          const v = join(p, variant.name)
          if (!NATIVE_VARIANT_DIR.test(variant.name) || variant.name === target) continue
          removed.bytes += dirSize(v)
          removed.files += countFiles(v)
          rmSync(v, { recursive: true, force: true })
        }
      } else {
        walk(p)
      }
    }
  }
  walk(runtimeDir)
  const mb = Math.round(removed.bytes / 1024 / 1024)
  console.log(`build-standalone: pruned foreign native variants for ${target} (-${removed.files} files, -${mb}MB)`)
}

/**
 * Extract the pnpm virtual-store directory name (depPath) from a symlink
 * target such as `..\\..\\commander@15.0.0\\node_modules\\commander` or
 * `..\\..\\..\\@aws-crypto+sha256-js@5.2.0\\node_modules\\@aws-crypto\\sha256-js`.
 * @returns the depPath (`commander@15.0.0`), or null when the target is not a
 *   `.pnpm/<depPath>/node_modules/<name>` link.
 */
function depPathFromLinkTarget(target) {
  const marker = `${sep}node_modules${sep}`
  const idx = target.lastIndexOf(marker)
  if (idx === -1) return null
  const head = target.slice(0, idx)
  const slash = head.lastIndexOf(sep)
  return slash === -1 ? null : head.slice(slash + 1)
}

/**
 * Index the deployed pnpm virtual store (`.pnpm/<depPath>/node_modules/`).
 * Each virtual directory holds exactly one package's real files plus its
 * direct dependencies as sibling symlinks, so one walk yields both the
 * package location and its dependency graph.
 * @returns Map<depPath, { realDir, deps: Array<{ alias, depPath }> }>
 */
function collectPackages(srcNm) {
  const pkgInfo = new Map()
  const pnpmDir = join(srcNm, '.pnpm')
  if (!existsSync(pnpmDir)) return pkgInfo
  for (const depPath of readdirSync(pnpmDir)) {
    const nmDir = join(pnpmDir, depPath, 'node_modules')
    if (!existsSync(nmDir)) continue
    const info = { realDir: null, deps: [] }
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isSymbolicLink()) {
          const dep = depPathFromLinkTarget(readlinkSync(p))
          if (dep !== null) {
            info.deps.push({ alias: relative(nmDir, p).replaceAll('\\', '/'), depPath: dep })
          }
        } else if (entry.isDirectory()) {
          if (existsSync(join(p, 'package.json'))) {
            if (info.realDir === null) info.realDir = p
          } else {
            walk(p)
          }
        }
      }
    }
    walk(nmDir)
    if (info.realDir !== null) pkgInfo.set(depPath, info)
  }
  return pkgInfo
}

/** Copy a package's real files, skipping its (`.bin`-only) nested node_modules. */
function copyPackageFiles(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const s = join(srcDir, entry.name)
    const d = join(dstDir, entry.name)
    if (entry.isDirectory()) copyPackageFiles(s, d)
    else if (entry.isFile()) copyFileSync(s, d)
    // Any symlink inside a package is a `.bin` shim already skipped above.
  }
}

/**
 * Rewrite a pnpm isolated node_modules (`.pnpm` store + symlinks) into a flat,
 * link-free layout that survives `cpSync`/electron-builder/NSIS packaging.
 * Hoists each dependency to the top level; on a version conflict it is nested
 * under the referring package's own node_modules, mirroring Node's resolution.
 */
function flattenNodeModules(srcNm, dstNm) {
  const pkgInfo = collectPackages(srcNm)
  mkdirSync(dstNm, { recursive: true })

  const topPlaced = new Map() // alias -> depPath
  const nestPlaced = new Map() // absolute dst dir -> depPath

  const materialize = (depPath, dstDir) => {
    const info = pkgInfo.get(depPath)
    if (info === undefined) return
    copyPackageFiles(info.realDir, dstDir)
    for (const dep of info.deps) place(dep.alias, dep.depPath, dstDir)
  }

  const place = (alias, depPath, ownerDir) => {
    if (!topPlaced.has(alias)) {
      topPlaced.set(alias, depPath)
      materialize(depPath, join(dstNm, alias))
      return
    }
    if (topPlaced.get(alias) === depPath) return
    // Top level already holds a different version: nest under the referrer.
    const nestNm = ownerDir === null ? dstNm : join(ownerDir, 'node_modules')
    const key = join(nestNm, alias)
    if (!nestPlaced.has(key)) {
      nestPlaced.set(key, depPath)
      materialize(depPath, key)
    }
  }

  // Top-level direct dependencies are symlinks (possibly inside @scope/ dirs).
  for (const entry of readdirSync(srcNm, { withFileTypes: true })) {
    const p = join(srcNm, entry.name)
    if (entry.isSymbolicLink()) {
      const dep = depPathFromLinkTarget(readlinkSync(p))
      if (dep !== null) place(entry.name, dep, null)
    } else if (entry.isDirectory() && entry.name.startsWith('@')) {
      for (const scoped of readdirSync(p, { withFileTypes: true })) {
        if (!scoped.isSymbolicLink()) continue
        const dep = depPathFromLinkTarget(readlinkSync(join(p, scoped.name)))
        if (dep !== null) place(`${entry.name}/${scoped.name}`, dep, null)
      }
    }
  }
}

/**
 * Copy the deployed dsh payload into the runtime dir, flattening its
 * node_modules into a link-free tree. Non-node_modules entries (package.json,
 * pnpm lockfile/workspace files) are copied verbatim.
 */
function copyPayloadFlat(payloadDir, runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true })
  for (const entry of readdirSync(payloadDir, { withFileTypes: true })) {
    const s = join(payloadDir, entry.name)
    if (entry.name === 'node_modules') {
      flattenNodeModules(s, join(runtimeDir, 'node_modules'))
    } else if (entry.isDirectory()) {
      cpSync(s, join(runtimeDir, entry.name), { recursive: true })
    } else if (entry.isFile()) {
      copyFileSync(s, join(runtimeDir, entry.name))
    }
  }
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
    copyPayloadFlat(payload, join(outDir, 'runtime'))
    slimRuntime(join(outDir, 'runtime'))
    slimNativeVariants(join(outDir, 'runtime'), platform, arch)

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

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.message))
}
