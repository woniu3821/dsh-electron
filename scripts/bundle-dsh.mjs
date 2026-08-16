/**
 * Assemble a self-contained `dsh web` runtime into resources/dsh without
 * modifying the deepseek-harness checkout.
 *
 * deepseek-harness is treated as a read-only sibling workspace: this script
 * reconciles its node_modules and runs its build (gitignored artifacts only),
 * computes the runtime closure of the web profile (workspace packages reached
 * from the CLI bundle, base bundle, and web-surface bundle through
 * dependencies + peers), then uses pnpm deploy on a generated manifest in the
 * local bundle/ workspace to materialise that closure into
 * resources/dsh-<arch> (arch = the installing machine's). Nothing tracked in
 * deepseek-harness is written.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const electronRoot = resolve(here, '..')
// deepseek-harness 项目对应目录
const dshRoot = process.env.DSH_ROOT ?? resolve(electronRoot, '..', 'deepseek-harness')
const bundleRoot = join(electronRoot, 'bundle')
// Per-arch payload dir: native addons link for the installing machine's arch,
// so the bundle must be built on a machine of the target architecture.
const outDir = join(electronRoot, 'resources', `dsh-${process.arch}`)

const SEEDS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const EXTRA_DEPS = {
  commander: '^15.0.0',
  'js-yaml': '^4.2.0',
  'node-addon-require-builtin': '^0.1.4',
}
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function hasPackageJson(dir) {
  return existsSync(join(dir, 'package.json'))
}

/** Read the canonical workspace member globs (pnpm-workspace.yaml, falling back to package.json workspaces). */
function workspacePatterns() {
  try {
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
  } catch {
    // fall through to package.json workspaces
  }
  return readJson(join(dshRoot, 'package.json')).workspaces ?? []
}

/** Expand the deepseek-harness workspace member globs into package directories. */
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

function computeClosure() {
  const byName = new Map()
  for (const dir of expandWorkspaceDirs()) {
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg.name) byName.set(pkg.name, { dir, pkg })
  }

  const seen = new Set()
  const queue = [...SEEDS]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const record = byName.get(name)
    if (!record) continue
    const sections = [record.pkg.dependencies, record.pkg.peerDependencies, record.pkg.optionalDependencies]
    if (SEEDS.includes(name)) sections.push(record.pkg.devDependencies)
    for (const deps of sections) {
      if (!deps) continue
      for (const depName of Object.keys(deps)) {
        if (byName.has(depName)) queue.push(depName)
      }
    }
  }
  return { byName, closure: [...seen].sort() }
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { ...options, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)
  if (result.status !== 0) {
    const err = new Error(`Command failed: ${cmd} ${args.join(' ')}`)
    err.output = output
    err.status = result.status
    throw err
  }
  return output
}

/** Reconcile deepseek-harness node_modules (gitignored) after a git pull. */
function syncDshDependencies() {
  const env = { ...process.env, CI: 'true' }
  try {
    run(pnpmBin, ['install', '--frozen-lockfile'], { cwd: dshRoot, env })
  } catch {
    console.log('bundle-dsh: deepseek-harness lockfile was stale; running pnpm install (may update its pnpm-lock.yaml)')
    run(pnpmBin, ['install'], { cwd: dshRoot, env })
  }
}

/** Build the deepseek-harness web profile in place (gitignored artifacts only). */
function buildDsh() {
  run(npmBin, ['run', 'build'], { cwd: dshRoot })
}

function deploy() {
  return run(pnpmBin, ['--filter', 'dsh-web-manifest', 'deploy', '--legacy', '--prod', outDir], {
    cwd: bundleRoot,
  })
}

function usage() {
  return [
    'Usage: node scripts/bundle-dsh.mjs [--skip-build]',
    '',
    '  --skip-build   skip `npm run build` in the deepseek-harness checkout.',
    '  --help         print this help.',
  ].join('\n')
}

function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const skipBuild = args.includes('--skip-build')

  if (!existsSync(dshRoot)) {
    throw new Error(`deepseek-harness not found at ${dshRoot}; set DSH_ROOT to its checkout.`)
  }

  syncDshDependencies()

  const { byName, closure } = computeClosure()
  const missingSeeds = SEEDS.filter((name) => !byName.has(name))
  if (missingSeeds.length > 0) {
    throw new Error(`bundle-dsh: web-profile seed packages missing from deepseek-harness workspace: ${missingSeeds.join(', ')}`)
  }
  console.log(`closure: ${closure.length} workspace packages`)

  if (!skipBuild) buildDsh()

  mkdirSync(join(bundleRoot, 'manifest'), { recursive: true })

  const dependencies = {}
  for (const name of closure) dependencies[name] = 'workspace:^'
  Object.assign(dependencies, EXTRA_DEPS)

  writeFileSync(
    join(bundleRoot, 'manifest', 'package.json'),
    `${JSON.stringify({ name: 'dsh-web-manifest', version: '0.0.0', private: true, type: 'module', dependencies }, null, 2)}\n`,
  )

  const relDsh = relative(bundleRoot, dshRoot).replaceAll('\\', '/')
  const memberGlobs = workspacePatterns()
    .map((glob) => `  - ${relDsh}/${glob}`)
    .join('\n')
  writeFileSync(join(bundleRoot, 'pnpm-workspace.yaml'), `packages:\n  - manifest\n${memberGlobs}\n`)

  // Native addons built under the system Node ABI cannot be loaded by Electron's
  // embedded Node, so never run build scripts during bundling. Addons that the
  // web profile actually needs are rebuilt against Electron separately.
  //
  // The deployed payload is architecture-bound: pnpm links per-arch optional
  // native packages (koffi, sharp, node-addon-require-builtin) for the
  // installing machine only, so run `pnpm run bundle` on a machine of the
  // target architecture (resources/dsh-<arch>).
  writeFileSync(join(bundleRoot, '.npmrc'), 'ignore-scripts=true\n')

  run(pnpmBin, ['install', '--lockfile-only', '--ignore-scripts'], { cwd: bundleRoot })

  // pnpm v11 fails deploy on unapproved build scripts but first rewrites
  // pnpm-workspace.yaml with exact `allowBuilds` keys. Flip those to false and
  // deploy again so the deny list always matches the resolved closure.
  rmSync(outDir, { recursive: true, force: true })
  try {
    deploy()
  } catch (err) {
    if (!err.output?.includes('ERR_PNPM_IGNORED_BUILDS')) throw err
    const workspacePath = join(bundleRoot, 'pnpm-workspace.yaml')
    const workspace = readFileSync(workspacePath, 'utf8').replaceAll(': set this to true or false', ': false')
    writeFileSync(workspacePath, workspace)
    rmSync(outDir, { recursive: true, force: true })
    deploy()
  }

  console.log(`bundled runtime written to ${outDir}`)
}

main()
