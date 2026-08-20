import type { QaAdapter } from './adapter.js'

export function defineExternalSkillQaAdapter(
  adapter: Omit<QaAdapter, 'kind' | 'verified'>,
): QaAdapter {
  return Object.freeze({ ...adapter, kind: 'external-skill', verified: true })
}
