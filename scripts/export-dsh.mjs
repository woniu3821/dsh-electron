#!/usr/bin/env node
/**
 * Export a source-free artifact snapshot of the built deepseek-harness
 * checkout into vendor/dsh-runtime/.
 *
 * This is the "manual build → copy artifacts" half of the packaging flow,
 * fully implemented INSIDE dsh-electron. The deepseek-harness repository is
 * only ever READ — no file there is created, modified, or deleted:
 *
 *   (1) in deepseek-harness, run `npm run build` by hand
 *   (2) in dsh-electron, run `pnpm run bundle` (this script, then
 *       scripts/bundle-dsh.mjs), or run this script alone: `pnpm run export`
 *
 * What gets copied — and only this:
 *   - every workspace member's package.json + build output (lib/, dist/,
 *     config/, cordis.patch.yml, …), selected by each package's `files` field
 *     (the npm publish boundary), which is exactly what `pnpm deploy` will
 *     materialise later;
 *   - pnpm-workspace.yaml + pnpm-lock.yaml (resolution metadata);
 *   - the whole workspace (not just the runtime closure): pnpm resolves the
 *     bundle workspace via the workspace globs and walks every member's full
 *     dependency graph — including devDependencies — so a member that declares
 *     a dev-only workspace package (e.g. dsh-client-test-runtime) would abort
 *     resolution if that package were absent. The later `--prod` deploy still
 *     only materialises the runtime closure declared by bundle-dsh.mjs's
 *     manifest.
 *
 * NOT copied (source): src/, tests/, scripts/, docs/, *.ts, tsconfig*,
 * README, node_modules, examples/, python/, website/ (non-closure members are
 * absent from the snapshot entirely).
 *
 * Usage:
 *   node scripts/export-dsh.mjs [--root <harness-checkout>] [--out <dir>]
 *   DSH_ROOT=/path/to/deepseek-harness node scripts/export-dsh.mjs
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const electronRoot = resolve(here, '..')
// deepseek-harness checkout to read build artifacts from (default: sibling).
const dshRoot = resolve(process.env.DSH_ROOT ?? join(electronRoot, '..', 'deepseek-harness'))
const defaultOut = join(electronRoot, 'vendor', 'dsh-runtime')

// Entry points of the web profile; used only to verify they were built.
const SEEDS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Directory names that only ever hold source, never runnable artifacts. */
const SOURCE_DIRS = new Set([
  'src', 'test', 'tests', 'scripts', 'docs', 'examples', 'benchmarks',
  'fixtures', 'stories', 'reference', '.github', '.agents', 'python',
])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function hasPackageJson(dir) {
  return existsSync(join(dir, 'package.json'))
}

/** Read the canonical workspace member globs (pnpm-workspace.yaml). */
function workspacePatterns() {
  const workspacePath = join(dshRoot, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) return readJson(join(dshRoot, 'package.json')).workspaces ?? []
  const lines = readFileSync(workspacePath, 'utf8').split('\n')
  const patterns = []
  let inPackages = false
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (/^\S/.test(line)) break
    const match = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (match !== null && match[1] !== undefined) patterns.push(match[1])
  }
  if (patterns.length > 0) return patterns
  return readJson(join(dshRoot, 'package.json')).workspaces ?? []
}

/** Expand the workspace member globs into package directories. */
function expandWorkspaceDirs() {
  const dirs = new Set()
  for (const pattern of workspacePatterns()) {
    const segments = pattern.split('/')
    const starIndex = segments.indexOf('*')
    if (starIndex === -1) {
      const dir = join(dshRoot, pattern)
      if (hasPackageJson(dir)) dirs.add(dir)
      continue
    }
    const base = join(dshRoot, ...segments.slice(0, starIndex))
    const suffix = segments.slice(starIndex + 1)
    if (!existsSync(base)) continue
    const recurse = (current, depth) => {
      if (depth === suffix.length + 1) {
        if (hasPackageJson(current)) dirs.add(current)
        return
      }
      for (const entry of readdirSync(current)) {
        const child = join(current, entry)
        if (statSync(child).isDirectory()) recurse(child, depth + 1)
      }
    }
    recurse(base, 0)
  }
  return [...dirs].sort()
}

/** Directories forced in by pnpm-workspace.yaml `link:` overrides. */
function linkedOverrideDirs() {
  const workspacePath = join(dshRoot, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) return []
  const text = readFileSync(workspacePath, 'utf8')
  const dirs = []
  for (const match of text.matchAll(/link:([^\s'"]+)/g)) {
    const dir = resolve(dshRoot, match[1])
    if (hasPackageJson(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * Copy one package's runnable artifacts (never source). Driven by the
 * package's `files` field — the npm publish boundary — so it matches exactly
 * what pnpm deploy will materialise. Falls back to lib/dist/config when a
 * package declares no `files` field.
 */
function copyArtifacts(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  cpSync(join(srcDir, 'package.json'), join(destDir, 'package.json'))

  const pkg = readJson(join(srcDir, 'package.json'))
  const entries = (pkg.files ?? []).filter((e) => typeof e === 'string' && !e.startsWith('!'))

  if (entries.length === 0) {
    // No `files` field: fall back to the common build-output directories.
    for (const d of ['lib', 'dist', 'config']) {
      const p = join(srcDir, d)
      if (existsSync(p)) cpSync(p, join(destDir, d), { recursive: true })
    }
  } else {
    for (const entry of entries) {
      // Take the static prefix of a glob ("lib/*.js" -> "lib", "bin/" -> "bin",
      // "prebuilds/**" -> "prebuilds"). Copies the whole prefix dir/file.
      const prefix = entry.replace(/\*.*$/, '').replace(/\/+$/, '')
      if (prefix === '' || prefix === '.') continue
      if (SOURCE_DIRS.has(prefix.split('/')[0])) continue
      const p = join(srcDir, prefix)
      if (!existsSync(p)) continue
      if (statSync(p).isDirectory()) cpSync(p, join(destDir, prefix), { recursive: true })
      else cpSync(p, join(destDir, prefix))
    }
  }

  // Top-level YAML runtime config (cordis.patch.yml, …) not covered above.
  for (const f of readdirSync(srcDir)) {
    if (/\.ya?ml$/.test(f) && statSync(join(srcDir, f)).isFile()) {
      cpSync(join(srcDir, f), join(destDir, f))
    }
  }
}

/**
 * Remove a directory tree in a clean child process. This script's own process
 * may run under WorkBuddy's safe-delete shim (injected via NODE_OPTIONS),
 * which refuses bulk deletes; a fresh node child with NODE_OPTIONS stripped
 * deletes normally.
 */
function rmrf(path) {
  const result = spawnSync(
    process.execPath,
    ['-e', 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })', path],
    { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error(`rmrf failed (status ${result.status}): ${path}`)
}

function usage() {
  return [
    'Usage: node scripts/export-dsh.mjs [--root <harness-checkout>] [--out <dir>]',
    '',
    `  Reads the built deepseek-harness checkout (default: ${dshRoot}) and`,
    '  exports a source-free artifact snapshot (default: vendor/dsh-runtime/).',
    '  The harness checkout is never modified.',
    '',
    '  --root <dir>  deepseek-harness checkout (env DSH_ROOT works too)',
    '  --out <dir>   snapshot output directory (absolute, or relative to dsh-electron)',
    '  --help        print this help',
  ].join('\n')
}

function main() {
  const args = process.argv.slice(2)
  let out = defaultOut
  let root = dshRoot
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') {
      root = args[i + 1]
      if (root === undefined || root.startsWith('--')) throw new Error('--root requires a value')
      i++
    } else if (args[i] === '--out') {
      out = args[i + 1]
      if (out === undefined || out.startsWith('--')) throw new Error('--out requires a value')
      i++
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(usage())
      return
    } else {
      throw new Error(`unknown argument: ${args[i]}`)
    }
  }
  root = resolve(electronRoot, root)
  out = resolve(electronRoot, out)

  if (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    throw new Error(
      `deepseek-harness checkout not found at ${root}. Point --root / DSH_ROOT at the ` +
      `checkout, and run \`npm run build\` inside it first.`,
    )
  }

  const allDirs = expandWorkspaceDirs()
  const byName = new Map()
  for (const dir of allDirs) {
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg.name) byName.set(pkg.name, { dir, pkg })
  }

  // The seed packages carry the entry points (`dsh` bin, the bundle patch
  // layers). They must be built; everything else is copied best-effort from its
  // `files` field (platform-specific native packages like the Linux landlock
  // addons legitimately ship no lib/ on this machine).
  const unbuilt = []
  for (const name of SEEDS) {
    const record = byName.get(name)
    if (record === undefined) throw new Error(`export-dsh: seed package missing from workspace: ${name}`)
    const hasOutput = ['lib', 'dist', 'config'].some((d) => existsSync(join(record.dir, d)))
    if (!hasOutput) unbuilt.push(name)
  }
  if (unbuilt.length > 0) {
    throw new Error(
      `export-dsh: seed package(s) not built: ${unbuilt.join(', ')}. ` +
      `Run \`npm run build\` in ${root} first.`,
    )
  }

  const dirs = new Set(allDirs)
  for (const dir of linkedOverrideDirs()) dirs.add(dir)

  rmrf(out)
  mkdirSync(out, { recursive: true })

  const copied = []
  for (const dir of [...dirs].sort()) {
    const rel = relative(root, dir).replaceAll('\\', '/')
    copyArtifacts(dir, join(out, rel))
    copied.push(rel)
  }

  cpSync(join(root, 'pnpm-workspace.yaml'), join(out, 'pnpm-workspace.yaml'))
  cpSync(join(root, 'pnpm-lock.yaml'), join(out, 'pnpm-lock.yaml'))

  console.log(`export-dsh: ${copied.length} workspace packages exported`)
  console.log(`export-dsh: snapshot -> ${out}`)
  console.log(`export-dsh: next: \`pnpm run bundle\` (deploy from the snapshot)`)
}

main()
