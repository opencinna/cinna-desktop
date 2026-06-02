/**
 * Type shim for the @scure/bip39 english wordlist subpath. The package ships
 * the export at runtime (vite/esbuild resolve it), but tsc's module resolution
 * doesn't pick up the subpath, so we declare its shape here.
 */
declare module '@scure/bip39/wordlists/english.js' {
  export const wordlist: string[]
}
