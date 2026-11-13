export declare function splitPemCertificates(text: string): string[]

export declare function extraCaFile(env: Record<string, string | undefined>): string | undefined

export declare function applyExtraCaCertificates(
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
  deps?: {
    fs?: { readFileSync(path: string, encoding: 'utf8'): string }
    tls?: { getCACertificates(type: 'default'): string[]; setDefaultCACertificates(certs: string[]): void }
    X509Certificate?: new (pem: string) => unknown
  }
): number
