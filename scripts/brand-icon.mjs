import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
// Next already ships sharp. This explicit asset-generation command adds no runtime dependency.
const sharp = createRequire(require.resolve('next/package.json', { paths: [fileURLToPath(new URL('../apps/web', import.meta.url))] }))('sharp')
export const iconSizes = [16, 24, 32, 48, 64, 128, 256]
export async function brandIcon() {
  // Pinned copy of https://globalmpc.tech/favicon.svg (2026-11-16).
  // Keep the homepage background, mark scale and spacing at every ICO size.
  const tile = readFileSync(new URL('../apps/web/public/favicon.svg', import.meta.url))
  const images = []
  for (const size of iconSizes) {
    images.push(await sharp(tile, { density: 384 }).resize(size, size).png().toBuffer())
  }
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((png, index) => {
    const entry = 6 + index * 16
    header[entry] = iconSizes[index] % 256
    header[entry + 1] = iconSizes[index] % 256
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images])
}
