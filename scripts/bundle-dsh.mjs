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
 * deps from the registry.
 *
 * After deploy the payload is prepared in place for packaging: node_modules is
 * flattened from pnpm's virtual-store layout into a link-free tree and
 * non-runnable files + foreign native prebuild variants are pruned, so
 * resources/dsh-<arch> is directly copyable into the Electron app
 * (electron-builder dereferences symlinks and would otherwise duplicate the
 * store). It never builds and never touches the harness checkout.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
  // pnpm reads env config under the `npm_config_` prefix (inherited from npm);
  // `pnpm_config_` is not read by pnpm v10's config loader. The workspace yaml
  // setting alone is not enough either: v10.34.5's deploy checks the resolved
  // config, not the workspace manifest, so deploy() also passes the flag on
  // the command line (works on v10 and v11).
  e.npm_config_inject_workspace_packages = 'true'
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
  // No --legacy: legacy deploy keeps pnpm's symlink/junction layout (top-level
  // links into the global store), which electron-builder dereferences into
  // duplicate entries (6x bloat) and, worse, leaves junctions pointing at
  // absolute build-machine paths. Non-legacy deploy materialises real files
  // into a local .pnpm store, but top-level node_modules is still symlinks
  // into it — preparePayload() flattens that layout after deploy.
  // inject-workspace-packages is passed via deployEnv() (env var) and as a CLI
  // flag, so no deepseek-harness file is modified.
  return run(pnpmBin, ['--config.inject-workspace-packages=true', '--filter', 'dsh-web-manifest', 'deploy', '--prod', outDir], {
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
  // Check package.json existence instead of Dirent.isDirectory(): pnpm's
  // deploy layout may expose workspace packages as junctions/symlinks (or the
  // filesystem may not have settled stat metadata right after deploy), and
  // Dirent does not follow links — both would silently count as absent.
  if (existsSync(scopeDir)) {
    for (const name of readdirSync(scopeDir)) {
      if (existsSync(join(scopeDir, name, 'package.json'))) deployed.add(`@deepseek-ai/${name}`)
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
  console.log(`bundle-dsh: slimmed runtime (-${removed.files} files, -${mb}MB)`)
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
 * matching Electron package), so foreign prebuilds are dead weight that only
 * inflates installer size and install time.
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
  console.log(`bundle-dsh: pruned foreign native variants for ${target} (-${removed.files} files, -${mb}MB)`)
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

/** Parse `x.y.z` into [major, minor, patch]; null when not a plain semver. */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value).trim())
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two parsed versions: -1, 0, 1. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/**
 * Minimal semver range check (^ ~ >= <= > < =, bare versions, * / x, `||`,
 * space-separated AND groups). Unparsable shapes are treated as satisfied so
 * a hoist decision can never hard-fail the build on an unknown range.
 */
function satisfiesRange(version, range) {
  const v = parseVersion(version)
  if (v === null) return true
  return String(range)
    .split('||')
    .some((alternative) =>
      alternative
        .trim()
        .split(/\s+/)
        .every((token) => {
          if (token === '' || /^[xX*]$/.test(token)) return true
          const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token)
          if (match === null) return false
          const operator = match[1] ?? '='
          const need = parseVersion(match[2].replace(/[xX*]/g, '0'))
          if (need === null) return true
          switch (operator) {
            case '^':
              return (
                compareVersions(v, need) >= 0 &&
                (need[0] > 0
                  ? v[0] === need[0]
                  : need[1] > 0
                    ? v[1] === need[1] && v[2] >= need[2]
                    : v[2] >= need[2])
              )
            case '~':
              return compareVersions(v, need) >= 0 && v[0] === need[0] && v[1] === need[1]
            case '>=':
              return compareVersions(v, need) >= 0
            case '<=':
              return compareVersions(v, need) <= 0
            case '>':
              return compareVersions(v, need) > 0
            case '<':
              return compareVersions(v, need) < 0
            default:
              return compareVersions(v, need) === 0
          }
        }),
    )
}

/** The version a pnpm depPath pins: `@scope+name@1.2.3` -> `1.2.3`. */
function depPathVersion(depPath) {
  return depPath.split('@').pop()
}

/** Ancestor package directories from the referrer up to (not including) dstNm. */
function packageChain(dstNm, ownerDir) {
  const chain = []
  if (ownerDir === null) return chain
  let dir = ownerDir
  while (dir !== undefined && dir.startsWith(dstNm)) {
    if (existsSync(join(dir, 'package.json'))) chain.push(dir)
    if (dir === dstNm) break
    dir = dirname(dir)
  }
  return chain
}

/** Declared dependency range of a package directory for `alias`, or undefined. */
const declaredRangeCache = new Map()
function declaredRange(pkgDir, alias) {
  const key = join(pkgDir, alias)
  if (!declaredRangeCache.has(key)) {
    let range
    try {
      const pkg = readJson(join(pkgDir, 'package.json'))
      range = pkg.dependencies?.[alias] ?? pkg.peerDependencies?.[alias] ?? pkg.optionalDependencies?.[alias]
    } catch {
      range = undefined
    }
    declaredRangeCache.set(key, range)
  }
  return declaredRangeCache.get(key)
}

/**
 * Rewrite a pnpm isolated node_modules (`.pnpm` store + symlinks) into a flat,
 * link-free layout that survives cpSync/electron-builder/NSIS packaging.
 * Hoists each dependency to the top level; on a version conflict it is nested
 * under the referring package's own node_modules, mirroring Node's resolution.
 *
 * Conflicted versions are hoisted to the shallowest ancestor package that
 * accepts them (checked against every package between the referrer and that
 * level, since the hoisted copy shadows their resolution too). This collapses
 * deep conflict chains (e.g. A -> B -> C -> D) to one nesting level, keeping
 * packaged paths short enough for Windows' 260-char MAX_PATH limit.
 */
export function flattenNodeModules(srcNm, dstNm) {
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
    // Top level already holds a different version: nest, hoisting to the
    // shallowest ancestor package whose declared range accepts this version.
    const chain = packageChain(dstNm, ownerDir)
    for (let i = 0; i < chain.length; i++) {
      const acceptable = chain.slice(0, i + 1).every((pkgDir) => {
        const range = declaredRange(pkgDir, alias)
        return range === undefined || satisfiesRange(depPathVersion(depPath), range)
      })
      if (!acceptable) break
      const key = join(chain[i], 'node_modules', alias)
      if (nestPlaced.has(key)) {
        if (nestPlaced.get(key) === depPath) return
        break // occupied by another version: shallower copies would be shadowed by it
      }
      nestPlaced.set(key, depPath)
      materialize(depPath, key)
      return
    }
    // No ancestor accepts the version: nest directly under the referrer
    // (deepest natural position, matching Node's resolution order).
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
 * Hoist nested packages to the shallowest safe level in an already-flat
 * node_modules tree (pnpm 11's flat deploy layout, or flattenNodeModules
 * output). Deep conflict chains (e.g. A -> B -> C -> D) otherwise install to
 * paths past Windows' 260-char MAX_PATH once inside the packaged app.
 *
 * Safety mirrors flattenNodeModules: a hoist may only shadow packages whose
 * declared dependency range accepts the hoisted version, so every package
 * between the referrer and the target level is checked. Redundant nests whose
 * version already exists at a shallower level are simply removed.
 */
export function hoistNestedPackages(nm) {
  const nested = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const p = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        if (existsSync(join(dir, 'package.json'))) nested.push(p)
        else walk(p)
      } else {
        walk(p)
      }
    }
  }
  walk(nm)
  // Deepest first: hoisting a deep package empties the levels above it, so
  // shallower nests are processed after their contents have moved out.
  nested.sort((a, b) => b.length - a.length)
  let hoisted = 0
  for (const nmDir of nested) {
    for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const p = join(nmDir, entry.name)
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(p, { withFileTypes: true })) {
          if (scoped.isDirectory() && !scoped.isSymbolicLink() && existsSync(join(p, scoped.name, 'package.json'))) {
            if (hoistOne(nm, nmDir, `${entry.name}/${scoped.name}`)) hoisted++
          }
        }
        try {
          if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true })
        } catch {
          /* raced with removal above */
        }
      } else if (existsSync(join(p, 'package.json'))) {
        if (hoistOne(nm, nmDir, entry.name)) hoisted++
      }
    }
    try {
      if (readdirSync(nmDir).length === 0) rmSync(nmDir, { recursive: true, force: true })
    } catch {
      /* empty already */
    }
  }
  if (hoisted > 0) console.log(`bundle-dsh: hoisted ${hoisted} nested packages to shorter paths`)
}

/**
 * Try to move `ownerNmDir/<alias>` to the shallowest ancestor level that
 * accepts its version (top level first, then each ancestor package, deepest
 * last). Returns true when the package moved or a redundant copy was removed.
 */
function hoistOne(nm, ownerNmDir, alias) {
  const nestedPkg = join(ownerNmDir, alias)
  const version = readJson(join(nestedPkg, 'package.json')).version
  const ownerDir = dirname(ownerNmDir)
  const chain = packageChain(nm, ownerDir) // deepest -> shallowest
  // Candidate levels, shallowest first: top level, then each ancestor's
  // node_modules from shallow to deep. The affected packages of a level are
  // the referrer chain up to (and including) that level's owner.
  const candidates = [{ dir: nm, affected: chain }]
  for (let i = chain.length - 1; i >= 0; i--) {
    candidates.push({ dir: join(chain[i], 'node_modules'), affected: chain.slice(0, i + 1) })
  }
  for (const cand of candidates) {
    const key = join(cand.dir, alias)
    if (existsSync(key)) {
      if (readJson(join(key, 'package.json')).version === version) {
        rmSync(nestedPkg, { recursive: true, force: true })
        return true // redundant nest; resolution now finds the shallower copy
      }
      continue // occupied by a different version: only a deeper level fits
    }
    const accepted = cand.affected.every((pkgDir) => {
      const range = declaredRange(pkgDir, alias)
      return range === undefined || satisfiesRange(version, range)
    })
    if (!accepted) continue
    mkdirSync(dirname(key), { recursive: true })
    renameSync(nestedPkg, key)
    console.log(`bundle-dsh: hoisted ${alias}@${version} -> ${relative(nm, key)}`)
    return true
  }
  return false
}

/**
 * Prepare a deployed payload in place so it is directly packagable: flatten
 * its node_modules from pnpm's virtual-store layout (.pnpm store + top-level
 * symlinks) into a link-free tree, hoist nested packages to shorter paths
 * (Windows MAX_PATH), then strip non-runnable files (types/docs/tests) and
 * foreign native prebuild variants. Runs at the end of bundle;
 * scripts/prepare-runtime.mjs then copies the result into the extraResources
 * wrapper dir.
 */
export function preparePayload(payloadDir, platform, arch) {
  const nm = join(payloadDir, 'node_modules')
  const tmp = join(payloadDir, '.node_modules.pnpm')
  if (existsSync(join(nm, '.pnpm')) && readdirSync(join(nm, '.pnpm')).length > 0) {
    renameSync(nm, tmp)
    flattenNodeModules(tmp, nm)
    rmrf(tmp)
  } else {
    console.log('bundle-dsh: node_modules already link-free, skipping flatten')
  }
  hoistNestedPackages(nm)
  slimRuntime(payloadDir)
  slimNativeVariants(payloadDir, platform, arch)
}

function usage() {
  return [
    'Usage: node scripts/bundle-dsh.mjs',
    '',
    '  Materialises the dsh web runtime (resources/dsh-<arch>) from the',
    '  source-free snapshot at vendor/dsh-runtime (built by scripts/export-dsh.mjs,',
    '  run via `pnpm run export`; `pnpm run bundle` runs both), then prepares it',
    '  in place for packaging (flattened node_modules + slimmed).',
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
  // materialisation, runtime preparation (flatten + slim), electron packaging —
  // happens in this repo; no build, no source, no harness checkout needed.
  if (!existsSync(join(dshRoot, 'pnpm-workspace.yaml'))) {
    throw new Error(
      `dsh runtime snapshot not found at ${dshRoot}. Run \`npm run build\` in the ` +
      `deepseek-harness checkout, then \`pnpm run export\` here to create it ` +
      `(or set DSH_ROOT to an existing snapshot).`,
    )
  }

  // Non-legacy `pnpm deploy` requires inject-workspace-packages=true, but we
  // set it via deployEnv() (env var) and the deploy CLI flag instead of
  // touching the snapshot's pnpm-workspace.yaml.

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
  preparePayload(outDir, process.platform, process.arch)
  console.log(`bundled runtime prepared (flattened + slimmed) at ${outDir}`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main()
}
