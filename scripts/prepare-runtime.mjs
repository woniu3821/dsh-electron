#!/usr/bin/env node
/**
 * Fill the extraResources wrapper dir with a bundled dsh runtime:
 *
 *   resources/dsh-<arch>              bundled + flattened + slimmed payload
 *     -> resources/dsh-standalone/runtime
 *
 * The wrapper dir exists because electron-builder's file filter hard-excludes
 * a copy source's root-level node_modules, so the runtime must live one level
 * down; the main process reads the same path in development
 * (src/main/index.ts). The copy itself is architecture-independent, so
 * `--arch arm64` can fill the wrapper from a payload bundled on an arm64
 * machine (see README's macOS dual-arch flow).
 *
 * Usage:
 *   node scripts/prepare-runtime.mjs [--arch <x64|arm64>]
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wrapperDir = join(projectRoot, 'resources', 'dsh-standalone', 'runtime')

function fail(message) {
  console.error(`prepare-runtime: ${message}`)
  process.exit(1)
}

function main() {
  const args = process.argv.slice(2)
  // Some pnpm versions forward the `--` separator to the script verbatim
  // (`pnpm run prepare:runtime -- --arch x64`); skip it like npm does.
  if (args[0] === '--') args.shift()
  let targetArch = process.arch
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arch') {
      targetArch = args[i + 1]
      if (targetArch === undefined || targetArch.startsWith('--')) {
        fail('--arch requires a value (x64|arm64)')
      }
      i++
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scripts/prepare-runtime.mjs [--arch <x64|arm64>]')
      return
    } else {
      fail(`unknown argument: ${args[i]}`)
    }
  }

  const payload = join(projectRoot, 'resources', `dsh-${targetArch}`)
  if (!existsSync(payload)) {
    const hint = targetArch === process.arch
      ? 'run `pnpm run bundle` first'
      : `bundle the ${targetArch} payload on a ${targetArch} machine (\`pnpm run bundle\` -> resources/dsh-${targetArch}) and copy it here`
    fail(`deployed dsh runtime not found at ${payload}; ${hint}`)
  }

  rmSync(wrapperDir, { recursive: true, force: true })
  cpSync(payload, wrapperDir, { recursive: true })

  const binJs = join(wrapperDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binJs)) {
    fail(`dsh entry not found at ${binJs}; is ${payload} a bundle-dsh.mjs payload?`)
  }
  console.log(`prepare-runtime: ${payload} -> ${wrapperDir}`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main()
}
