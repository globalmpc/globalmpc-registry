// Explicit maintainer operation; builds and deployments never read another checkout.
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error('Usage: node scripts/sync-design-system.mjs <canonical checkout>');
const target = resolve(root, 'design-system');
const version = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
// Country-neutral product wording already adopted by Registry is preserved explicitly.
const overrides = {
  'Mongolian asset context. The only green that is not a status.': 'Resource and asset context. The only green that is not a status.',
  'It converts the Mongolian mining value chain into a tokenizable asset structure and delivers it with a risk/return profile institutional investors can read. The first reference case is Tsagaan Tolgoi strategic minerals.': 'It standardises verification across the mining-asset lifecycle: every published record carries its source, its reviewer, that reviewer’s authority scope, and the limitations of the check. Reference cases are not named until the counterparty has agreed to be named.',
  'Infrastructure that standardises verification across the mining-asset lifecycle. Tsagaan Tolgoi is the first case, not the business.': 'Infrastructure that standardises verification across the mining-asset lifecycle. Any single project is a case, not the business.',
};
const folders = ['tokens', 'content', 'css', 'lib'];
// Validate before deleting any managed copy. Never sync a checkout onto itself.
if (realpathSync(source) === realpathSync(target)) throw new Error('Canonical checkout must differ from the consumer copy');
for (const folder of folders) {
  if (!statSync(resolve(source, folder)).isDirectory()) throw new Error(`Missing canonical directory: ${folder}`);
}
for (const folder of [...folders, 'dist', 'docs', 'ai']) rmSync(resolve(target, folder), { recursive: true, force: true });
for (const folder of folders) cpSync(resolve(source, folder), resolve(target, folder), { recursive: true });
for (const file of ['build.mjs', 'docs.mjs']) cpSync(resolve(source, 'scripts', file), resolve(target, 'scripts', file));
// Apply wording overrides independently of upstream JSON filenames.
for (const name of ['tokens', 'content'].flatMap(folder => files(resolve(target, folder), `${folder}/`)).filter(name => name.endsWith('.json'))) {
  const file = resolve(target, name);
  let text = readFileSync(file, 'utf8');
  for (const [original, replacement] of Object.entries(overrides)) text = text.replaceAll(original, replacement);
  writeFileSync(file, text);
}
const pkgPath = resolve(target, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
for (const file of ['build.mjs', 'docs.mjs']) execFileSync(process.execPath, [resolve(target, 'scripts', file)], { stdio: 'inherit' });
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory() ? files(resolve(dir, entry.name), `${name}/`) : [name];
  });
}
const paths = [...folders, 'dist', 'docs', 'ai'].flatMap(folder => files(resolve(target, folder), `${folder}/`));
paths.push('scripts/build.mjs', 'scripts/docs.mjs');
const hashes = Object.fromEntries(paths.sort().map(file => [file, { sha256: createHash('sha256').update(readFileSync(resolve(target, file))).digest('hex') }]));
writeFileSync(resolve(target, 'SOURCE.json'), JSON.stringify({
  repository: 'mustcompany/globalmpc-designsystem', commit, version,
  scope: 'Canonical token/rule sources and generated outputs; local package metadata and artwork infrastructure are preserved.',
  localOverride: 'Preserve Registry’s existing country-neutral reference-case and steppe-token wording; generated documentation retains those overrides.',
  files: hashes,
}, null, 2) + '\n');
