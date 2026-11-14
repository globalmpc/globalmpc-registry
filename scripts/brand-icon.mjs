import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
// Next already ships sharp. This explicit asset-generation command adds no runtime dependency.
const sharp = createRequire(require.resolve('next/package.json', { paths: [fileURLToPath(new URL('../apps/web', import.meta.url))] }))('sharp')
export const iconSizes = [16, 24, 32, 48, 64, 128, 256]
export async function brandIcon() {
  const mark = readFileSync(new URL('../design-system/assets/logo/svg/mpc-mark-on-dark.svg', import.meta.url))
  const images = []
  for (const size of iconSizes) {
    // Canonical icon-tile rule: half-height clear space >=48px, >=24px mark below48.
    // A tile smaller than24px cannot contain a24px mark; preserve all available height.
    const height = size >= 48 ? size / 2 : Math.min(size, 24)
    const artwork = await sharp(mark, { density: 384 }).resize({ height }).png().toBuffer()
    images.push(await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } }).composite([{ input: artwork, gravity: 'centre' }]).png().toBuffer())
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
