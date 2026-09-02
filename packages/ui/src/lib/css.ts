// Pass a colour through only if this engine can actually parse it. Category colours arrive
// from the CLI as untrusted strings, and an unparseable one must fall back to the token
// colour rather than reaching the DOM.
export function cssColor(color: string): string | undefined {
  return typeof CSS !== 'undefined' && CSS.supports('color', color) ? color : undefined
}
