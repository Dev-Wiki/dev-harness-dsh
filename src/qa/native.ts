import { assertQaAdapterEvidenceRef, type QaAdapter } from './adapter.js'

export function defineNativeQaAdapter(
  adapter: Omit<QaAdapter, 'kind' | 'verified' | 'verificationEvidenceRef'>,
  verificationEvidenceRef: string,
): QaAdapter {
  assertQaAdapterEvidenceRef(verificationEvidenceRef)
  return Object.freeze({
    ...adapter,
    kind: 'native-agent',
    verified: true,
    verificationEvidenceRef,
  })
}
