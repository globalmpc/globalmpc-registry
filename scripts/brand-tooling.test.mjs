import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8' })

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'registry-brand-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('favicon regeneration works in a checkout path containing spaces and URL-sensitive characters', async (t) => {
  const checkout = join(fixture(t), 'Registry Workspace #1')
  for (const dir of ['scripts', 'apps/web/public', 'design-system/assets/logo/svg']) mkdirSync(join(checkout, dir), { recursive: true })
  for (const file of ['brand-icon.mjs', 'sync-brand-icon.mjs']) cpSync(join(root, 'scripts', file), join(checkout, 'scripts', file))
  cpSync(join(root, 'apps/web/node_modules'), join(checkout, 'apps/web/node_modules'), { recursive: true, verbatimSymlinks: false })
  cpSync(join(root, 'design-system/assets/logo/svg/mpc-mark-on-dark.svg'), join(checkout, 'design-system/assets/logo/svg/mpc-mark-on-dark.svg'))
  run(['scripts/sync-brand-icon.mjs'], checkout)
  assert.deepEqual(readFileSync(join(checkout, 'apps/web/public/favicon.ico')), readFileSync(join(root, 'apps/web/public/favicon.ico')))
})

test('sync removes deleted canonical sources and generated files while preserving local infrastructure', (t) => {
  const dir = fixture(t)
  const checkout = join(dir, 'Registry Workspace')
  const source = join(dir, 'canonical')
  mkdirSync(join(checkout, 'scripts'), { recursive: true })
  mkdirSync(source)
  for (const folder of ['tokens', 'content', 'css', 'lib']) cpSync(join(root, 'design-system', folder), join(source, folder), { recursive: true })
  mkdirSync(join(source, 'scripts'))
  for (const file of ['build.mjs', 'docs.mjs']) cpSync(join(root, 'design-system/scripts', file), join(source, 'scripts', file))
  cpSync(join(root, 'design-system/package.json'), join(source, 'package.json'))
  renameSync(join(source, 'tokens/color.json'), join(source, 'tokens/colors.json'))
  execFileSync('git', ['init', '--quiet'], { cwd: source })
  execFileSync('git', ['add', '.'], { cwd: source })
  execFileSync('git', ['-c', 'user.name=Brand regression fixture', '-c', 'user.email=qa@example.invalid', 'commit', '--quiet', '-m', 'canonical fixture'], { cwd: source })
  const target = join(checkout, 'design-system')
  mkdirSync(target)
  cpSync(join(root, 'design-system/package.json'), join(target, 'package.json'))
  cpSync(join(root, 'scripts/sync-design-system.mjs'), join(checkout, 'scripts/sync-design-system.mjs'))
  cpSync(join(root, 'design-system/tokens'), join(target, 'tokens'), { recursive: true })
  for (const folder of ['tokens', 'content', 'css', 'lib', 'dist', 'docs', 'ai']) {
    mkdirSync(join(target, folder), { recursive: true })
    writeFileSync(join(target, folder, 'deleted-upstream.json'), folder === 'tokens' ? readFileSync(join(source, 'tokens/colors.json')) : '{}')
  }
  mkdirSync(join(target, 'scripts'))
  writeFileSync(join(target, 'README.md'), 'consumer instructions')
  writeFileSync(join(target, 'scripts/sync-assets.mjs'), '// consumer-owned artwork tool')
  run(['scripts/sync-design-system.mjs', source], checkout)
  for (const folder of ['tokens', 'content', 'css', 'lib', 'dist', 'docs', 'ai']) assert.equal(existsSync(join(target, folder, 'deleted-upstream.json')), false, folder)
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'consumer instructions')
  assert.equal(readFileSync(join(target, 'scripts/sync-assets.mjs'), 'utf8'), '// consumer-owned artwork tool')
  assert.equal(JSON.parse(readFileSync(join(target, 'dist/tokens.json'), 'utf8')).tokens.mark.hex, '#C2773F')
  const baseline = readFileSync(join(target, 'SOURCE.json'), 'utf8')
  run(['scripts/sync-design-system.mjs', source], checkout)
  assert.equal(readFileSync(join(target, 'SOURCE.json'), 'utf8'), baseline, 'repeat sync must be deterministic')
})
