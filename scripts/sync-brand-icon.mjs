import { writeFileSync } from 'node:fs'
import { brandIcon } from './brand-icon.mjs'
writeFileSync(new URL('../apps/web/public/favicon.ico', import.meta.url), await brandIcon())
