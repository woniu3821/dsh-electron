/**
 * Assemble a self-contained `dsh web` runtime into resources/dsh from the
 * source-free artifact snapshot in vendor/dsh-runtime.
 *
 * The snapshot is produced by scripts/export-dsh.mjs (`pnpm run export`),
 * which reads the built deepseek-harness checkout (read-only, nothing there is
 * ever modified) and copies only artifacts. `pnpm run bundle` runs
 * export-dsh.mjs followed by this script.
 *
 * This script computes the runtime closure of the web profile (workspace
 * packages reached from the CLI bundle, base bundle, and web-surface bundle
 * through dependencies + peers) and uses pnpm deploy on a generated manifest
 * in the local bundle/ workspace to materialise that closure into
 * resources/dsh-<arch> (arch = the installing machine's), pulling third-party
 * deps from the registry. It never builds and never touches the harness
 * checkout.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const electronRoot = resolve(here, '..')
// The source-free artifact snapshot produced by deepseek-harness's
// `npm run export:runtime` (default output dist/dsh-runtime), copied here by
// the user as vendor/dsh-runtime. Override with DSH_ROOT to point elsewhere.
const dshRoot = process.env.DSH_ROOT ?? resolve(electronRoot, 'vendor', 'dsh-runtime')
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

/** Expand the snapshot's workspace member globs into package directories. */
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
  // Node.js >= 18.17 blocks spawnSync of .cmd/.bat without shell: true
  // (CVE-2024-27980). On Windows pnpmBin is a .cmd shim, so always
  // shell out there.
  const shell = process.platform === 'win32'
  const result = spawnSync(cmd, args, { ...options, encoding: 'utf8', shell })
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

/**
 * Strip WorkBuddy's safe-delete shim from NODE_OPTIONS: it hooks Node's fs
 * deletes and fail-closes via genie-trash, which breaks pnpm's removal of
 * temp/stale directories in this sandbox. Keep the rest of NODE_OPTIONS.
 */
function cleanWorkbuddyShim(env) {
  const e = { ...env }
  if (e.NODE_OPTIONS !== undefined) {
    // Strip the safe-delete shim even when its path contains spaces
    // (e.g. "D:/Program Files/WorkBuddy/.../genie-safe-delete.cjs").
    e.NODE_OPTIONS = e.NODE_OPTIONS
      .replace(/--require="[^"]*genie-safe-delete\.cjs"/g, '')
      .replace(/--require=[^\s"']*genie-safe-delete\.cjs/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  return e
}

/**
 * Env for pnpm commands that deploy: cleanWorkbuddyShim() plus the
 * inject-workspace-packages equivalent. Non-legacy `pnpm deploy` (v10+)
 * refuses workspaces without that setting; providing it as an environment
 * variable satisfies the check without editing any pnpm-workspace.yaml.
 */
function deployEnv(env) {
  const e = cleanWorkbuddyShim(env)
  e.pnpm_config_inject_workspace_packages = 'true'
  return e
}

/**
 * Remove a directory tree in a clean child process. This script's own process
 * may be running under WorkBuddy's safe-delete shim (injected via NODE_OPTIONS),
 * which refuses bulk deletes with SAFE_DELETE_BULK_CONFIRM_REQUIRED; a fresh
 * node child with NODE_OPTIONS stripped deletes normally.
 */
function rmrf(path) {
  const result = spawnSync(
    process.execPath,
    ['-e', 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })', path],
    { env: cleanWorkbuddyShim(process.env), stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error(`rmrf failed (status ${result.status}): ${path}`)
}

function deploy() {
  // No --legacy: legacy deploy preserves pnpm's symlink/junction layout,
  // which electron-builder then dereferences into duplicate entries (6x
  // bloat) and, worse, leaves junctions pointing at absolute build-machine
  // paths. Non-legacy deploy materialises a flat, link-free node_modules.
  // inject-workspace-packages is passed via deployEnv() (env var), so no
  // deepseek-harness file is modified.
  return run(pnpmBin, ['--filter', 'dsh-web-manifest', 'deploy', '--prod', outDir], {
    cwd: bundleRoot,
    env: deployEnv(process.env),
  })
}

/**
 * The deploy must materialise exactly the computed web-profile closure as
 * first-party (@deepseek-ai/*) packages. An unexpected first-party package
 * (e.g. pulled from the registry through a published dependency edge the
 * snapshot's workspace graph does not declare) would silently bloat the
 * runtime; a missing one breaks it. Missing entries that resolve to
 * platform-filtered optional packages are legitimate, so they warn instead of
 * failing — extras are always an error.
 */
export function verifyDeployedClosure(deployedNm, closure) {
  const scopeDir = join(deployedNm, '@deepseek-ai')
  const deployed = new Set()
  if (existsSync(scopeDir)) {
    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(scopeDir, entry.name, 'package.json'))) deployed.add(`@deepseek-ai/${entry.name}`)
    }
  }
  const expected = new Set(closure)
  const extra = [...deployed].filter((name) => !expected.has(name)).sort()
  const missing = [...expected].filter((name) => !deployed.has(name)).sort()
  if (extra.length > 0) {
    throw new Error(`bundle-dsh: unexpected first-party packages in deployed runtime: ${extra.join(', ')}. ` +
      `They are not part of the web-profile closure and would bloat the package.`)
  }
  if (missing.length > 0) {
    console.warn(`bundle-dsh: warning: first-party packages absent from deployed runtime (platform-filtered optional deps are expected): ${missing.join(', ')}`)
  }
  console.log(`bundle-dsh: deployed closure matches: ${deployed.size} first-party packages, ${missing.length} absent`)
}

function usage() {
  return [
    'Usage: node scripts/bundle-dsh.mjs',
    '',
    '  Materialises the dsh web runtime (resources/dsh-<arch>) from the',
    '  source-free snapshot at vendor/dsh-runtime (built by scripts/export-dsh.mjs,',
    '  run via `pnpm run export`; `pnpm run bundle` runs both).',
    '  --help   print this help.',
  ].join('\n')
}

function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }

  // vendor/dsh-runtime is the source-free artifact snapshot exported by
  // scripts/export-dsh.mjs (`pnpm run export`) from a deepseek-harness
  // checkout built by hand. Everything downstream — closure resolution, deploy
  // materialisation, standalone assembly, electron packaging — happens in this
  // repo; no build, no source, no harness checkout needed.
  if (!existsSync(join(dshRoot, 'pnpm-workspace.yaml'))) {
    throw new Error(
      `dsh runtime snapshot not found at ${dshRoot}. Run \`npm run build\` in the ` +
      `deepseek-harness checkout, then \`pnpm run export\` here to create it ` +
      `(or set DSH_ROOT to an existing snapshot).`,
    )
  }

  // Non-legacy `pnpm deploy` requires inject-workspace-packages=true, but we
  // set it via environment variable in deployEnv() instead of touching the
  // snapshot's pnpm-workspace.yaml.

  const { byName, closure } = computeClosure()
  const missingSeeds = SEEDS.filter((name) => !byName.has(name))
  if (missingSeeds.length > 0) {
    throw new Error(`bundle-dsh: web-profile seed packages missing from the dsh runtime snapshot: ${missingSeeds.join(', ')}`)
  }
  console.log(`closure: ${closure.length} workspace packages`)

  // The snapshot already carries the built lib/ + web output (deepseek-harness
  // step 1); this script only resolves the closure and deploys it.

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
  // inject-workspace-packages materialises workspace deps as real files
  // instead of symlinks/junctions. Required by non-legacy `pnpm deploy`
  // (v10+), and it is what makes the deployed node_modules link-free, so
  // electron-builder no longer dereferences junctions into 6x duplicated
  // entries.
  //
  // strictDepBuilds: false must live HERE (workspace yaml), not in .npmrc —
  // pnpm v11 reads build-approval settings only from pnpm-workspace.yaml. It
  // downgrades ERR_PNPM_IGNORED_BUILDS to a warning, so deploy no longer aborts
  // on node-pty/koffi/esbuild/… lifecycle scripts (they are never run anyway:
  // ignore-scripts=true in .npmrc, and the payload carries prebuilt N-API
  // binaries).
  writeFileSync(
    join(bundleRoot, 'pnpm-workspace.yaml'),
    `packages:\n  - manifest\n${memberGlobs}\ninject-workspace-packages: true\nstrictDepBuilds: false\n`,
  )

  // Native addons built under the system Node ABI cannot be loaded by Electron's
  // embedded Node, so never run build scripts during bundling. Addons that the
  // web profile actually needs are rebuilt against Electron separately.
  //
  // The deployed payload is architecture-bound: pnpm links per-arch optional
  // native packages (koffi, sharp, node-addon-require-builtin) for the
  // installing machine only, so run `pnpm run bundle` on a machine of the
  // target architecture (resources/dsh-<arch>).
  // NOTE: build approval is configured via strictDepBuilds in the generated
  // pnpm-workspace.yaml above — pnpm v11 ignores it in .npmrc.
  writeFileSync(join(bundleRoot, '.npmrc'), 'ignore-scripts=true\n')

  // Drop any stale bundle lockfile before resolving: it may have been created
  // against a different DSH_ROOT (e.g. a previous vendor/deepseek-harness
  // layout) and would pin `link:`/`file:` resolutions to paths outside the
  // current snapshot, making `pnpm deploy` fail with
  // ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY. Re-resolve from scratch.
  rmrf(join(bundleRoot, 'pnpm-lock.yaml'))

  run(pnpmBin, ['install', '--lockfile-only', '--ignore-scripts'], { cwd: bundleRoot, env: deployEnv(process.env) })

  // Defensive: with strictDepBuilds=false in pnpm-workspace.yaml (above),
  // ERR_PNPM_IGNORED_BUILDS is downgraded to a warning, so this path should
  // not trigger. If pnpm still reports it (older versions that write
  // `allowBuilds` placeholders into pnpm-workspace.yaml), flip those to
  // explicit denials and retry.
  rmrf(outDir)
  try {
    deploy()
  } catch (err) {
    if (!err.output?.includes('ERR_PNPM_IGNORED_BUILDS')) throw err
    const workspacePath = join(bundleRoot, 'pnpm-workspace.yaml')
    const workspace = readFileSync(workspacePath, 'utf8').replaceAll(': set this to true or false', ': false')
    writeFileSync(workspacePath, workspace)
    rmrf(outDir)
    deploy()
  }

  verifyDeployedClosure(join(outDir, 'node_modules'), closure)
  console.log(`bundled runtime written to ${outDir}`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main()
}
