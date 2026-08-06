// The dashboard's own version, from the package it ships in — so `pnpm
// version:set` moves it and nothing has to remember to. A named JSON import so
// the bundler keeps the one field rather than the whole manifest.
import { version } from '../../package.json'

export const APP_VERSION: string = version
