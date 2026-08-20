import type { QaAdapter } from './adapter.js'

export function defineNativeQaAdapter(
  adapter: Omit<QaAdapter, 'kind' | 'verified'>,
): QaAdapter {
  return Object.freeze({ ...adapter, kind: 'native-agent', verified: true })
}
