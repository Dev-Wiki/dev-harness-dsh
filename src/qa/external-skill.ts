import { assertQaAdapterEvidenceRef, type QaAdapter } from './adapter.js'

export function defineExternalSkillQaAdapter(
  adapter: Omit<QaAdapter, 'kind' | 'verified' | 'verificationEvidenceRef'>,
  verificationEvidenceRef: string,
): QaAdapter {
  assertQaAdapterEvidenceRef(verificationEvidenceRef)
  return Object.freeze({
    ...adapter,
    kind: 'external-skill',
    verified: true,
    verificationEvidenceRef,
  })
}
