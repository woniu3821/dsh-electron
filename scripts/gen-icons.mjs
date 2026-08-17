#!/usr/bin/env node
/**
 * Generate application icons from an SVG source.
 *
 * Produces, under the output directory:
 *   - icon.png           1024x1024 master PNG (used by electron-builder for Linux / auto-conversion)
 *   - icon.icns          macOS icon set (via iconutil when available)
 *   - icon.ico           Windows multi-size ICO (PNG-compressed entries, no native deps)
 *   - icons/*.png        individual sizes (16, 24, 32, 48, 64, 128, 256, 512, 1024)
 *
 * Usage:
 *   node scripts/gen-icons.mjs --input build/favicon.svg [--out build] [--fit 0.80]
 *
 * The source SVG is rendered centered on a square canvas with `--fit` as the
 * fraction of the canvas occupied by the artwork (safe padding for macOS
 * rounded-corner masks and Windows taskbar). Defaults to 0.80.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

// --- argument parsing -----------------------------------------------------

function parseArgs(argv) {
  const args = { input: null, out: join(ROOT, 'build'), fit: 0.8 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input') args.input = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--fit') args.fit = Number(argv[++i])
    else if (a.startsWith('--input=')) args.input = a.slice(8)
    else if (a.startsWith('--out=')) args.out = a.slice(6)
    else if (a.startsWith('--fit=')) args.fit = Number(a.slice(6))
    else {
      console.error(`unknown argument: ${a}`)
      process.exit(2)
    }
  }
  if (!args.input) {
    console.error('usage: node scripts/gen-icons.mjs --input <svg> [--out build] [--fit 0.80]')
    process.exit(2)
  }
  return args
}

// --- sharp resolution ------------------------------------------------------

/**
 * Resolve the `sharp` module. Prefers a real dependency of the caller's
 * environment, then falls back to the sharp shipped inside the bundled dsh
 * runtime (resources/dsh-standalone/runtime, prepared by `pnpm run bundle
 * && pnpm run prepare:runtime`).
 */
function resolveSharp() {
  try {
    // eslint-disable-next-line import/no-unresolved
    return require('sharp')
  } catch {
    /* fall through to bundled copy */
  }
  const runtimeNm = join(ROOT, 'resources', 'dsh-standalone', 'runtime', 'node_modules')
  const flat = join(runtimeNm, 'sharp')
  if (existsSync(flat)) return require(flat)
  // Fall back to the legacy pnpm virtual-store layout
  // (`.pnpm/sharp@*/node_modules/sharp`) if a stale runtime is present.
  const pnpmDir = join(runtimeNm, '.pnpm')
  if (existsSync(pnpmDir)) {
    const fs = require('node:fs')
    const dirs = fs.readdirSync(pnpmDir).filter((d) => d.startsWith('sharp@'))
    if (dirs.length > 0) {
      const p = join(pnpmDir, dirs[0], 'node_modules', 'sharp')
      if (existsSync(p)) return require(p)
    }
  }
  throw new Error(
    'sharp is not available. Install it (pnpm add -D sharp) or run `pnpm run bundle && pnpm run prepare:runtime` to provide the bundled runtime.',
  )
}

// --- ICO writer ------------------------------------------------------------

/**
 * Write a Windows .ico containing PNG-compressed entries. Modern Windows
 * (Vista+) and electron-builder accept PNG entries for every size, including
 * 256x256, so no BMP encoding is needed.
 */
function writeIco(pngsBySize, filePath) {
  const entries = ICO_SIZES.filter((s) => pngsBySize[s])
  const headerSize = 6
  const dirEntrySize = 16
  let offset = headerSize + dirEntrySize * entries.length
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dirEntries = entries.map((size) => {
    const data = pngsBySize[size]
    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
    entry.writeUInt8(0, 2) // palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return writeFile(filePath, Buffer.concat([header, ...dirEntries, ...entries.map((s) => pngsBySize[s])]))
}

// --- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const sharp = resolveSharp()

  const svg = await readFile(args.input)
  const outDir = resolve(args.out)
  const iconsDir = join(outDir, 'icons')
  await mkdir(iconsDir, { recursive: true })

  // Render the SVG onto a square canvas with the artwork occupying `fit`
  // fraction, centered. Steps are buffered separately: chaining resize ->
  // extend -> resize on an SVG input in one pipeline mis-scales under sharp's
  // density handling, so each stage round-trips through a PNG buffer.
  const master = 1024
  const fitPx = Math.round(master * args.fit)
  const pad = Math.round((master - fitPx) / 2)
  const padBottom = master - pad - fitPx
  const stage1 = await sharp(svg, { density: 300 })
    .resize(fitPx, fitPx, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
  const stage2 = await sharp(stage1)
    .extend({
      top: pad,
      bottom: padBottom,
      left: pad,
      right: padBottom,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
  const masterPng = await sharp(stage2).resize(master, master).png().toBuffer()

  // Master icon.png plus per-size PNGs, all downsampled from the 1024 master.
  const pngsBySize = {}
  await Promise.all(
    SIZES.map(async (size) => {
      const buf = await sharp(masterPng).resize(size, size).png().toBuffer()
      pngsBySize[size] = buf
      await writeFile(join(iconsDir, `icon-${size}x${size}.png`), buf)
    }),
  )
  await writeFile(join(outDir, 'icon.png'), masterPng)
  await writeFile(join(iconsDir, 'icon-1024x1024.png'), masterPng)
  console.log(`icon.png (1024x1024) + ${SIZES.length} sizes -> ${iconsDir}`)

  // macOS .icns via iconutil (macOS only).
  const iconutil = spawnSync('which', ['iconutil'], { encoding: 'utf8' })
  if (iconutil.status === 0 && iconutil.stdout.trim()) {
    const iconset = join(outDir, 'icon.iconset')
    await mkdir(iconset, { recursive: true })
    const pairs = [
      ['icon_16x16.png', 16, false],
      ['icon_16x16@2x.png', 32, false],
      ['icon_32x32.png', 32, false],
      ['icon_32x32@2x.png', 64, false],
      ['icon_128x128.png', 128, false],
      ['icon_128x128@2x.png', 256, false],
      ['icon_256x256.png', 256, false],
      ['icon_256x256@2x.png', 512, false],
      ['icon_512x512.png', 512, false],
      ['icon_512x512@2x.png', 1024, false],
    ]
    await Promise.all(
      pairs.map(async ([name, size]) => {
        const buf = await sharp(masterPng).resize(size, size).png().toBuffer()
        await writeFile(join(iconset, name), buf)
      }),
    )
    const r = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')], {
      encoding: 'utf8',
    })
    if (r.status === 0) {
      console.log('icon.icns -> ' + join(outDir, 'icon.icns'))
    } else {
      console.warn(`iconutil failed: ${r.stderr || r.stdout}`)
    }
    spawnSync('rm', ['-rf', iconset])
  } else {
    console.warn('iconutil not found; skipping icon.icns (macOS only)')
  }

  // Windows .ico
  await writeIco(pngsBySize, join(outDir, 'icon.ico'))
  console.log('icon.ico -> ' + join(outDir, 'icon.ico'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
