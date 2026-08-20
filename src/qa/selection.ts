import { QA_ADAPTER_KINDS, type QaAdapter, type QaAdapterKind } from './adapter.js'

const AUTO_PRIORITY: readonly QaAdapterKind[] = ['external-skill', 'native-agent', 'cli-api']

export interface QaSelection {
  readonly adapter?: QaAdapter
  readonly source: 'user-specified' | 'automatic' | 'manual-fallback'
  readonly reason: string
}

export function selectQaAdapter(adapters: readonly QaAdapter[], preferredName?: string): QaSelection {
  const names = new Set<string>()
  for (const adapter of adapters) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(adapter.name)) throw new TypeError(`invalid QA Adapter name: ${adapter.name}`)
    if (!(QA_ADAPTER_KINDS as readonly string[]).includes(adapter.kind)) throw new TypeError(`invalid QA Adapter kind: ${adapter.kind}`)
    if (adapter.verified !== true) throw new TypeError(`QA Adapter ${adapter.name} is not verified`)
    if (names.has(adapter.name)) throw new TypeError(`duplicate QA Adapter name: ${adapter.name}`)
    names.add(adapter.name)
  }
  if (preferredName !== undefined) {
    const adapter = adapters.find(candidate => candidate.name === preferredName)
    return adapter === undefined
      ? Object.freeze({ source: 'manual-fallback', reason: `preferred QA Adapter is unavailable: ${preferredName}` })
      : Object.freeze({ adapter, source: 'user-specified', reason: `selected explicit QA Adapter: ${preferredName}` })
  }
  for (const kind of AUTO_PRIORITY) {
    const adapter = adapters.find(candidate => candidate.kind === kind)
    if (adapter !== undefined) {
      return Object.freeze({ adapter, source: 'automatic', reason: `selected verified ${kind} QA Adapter` })
    }
  }
  return Object.freeze({ source: 'manual-fallback', reason: 'no verified automatic QA Adapter is available' })
}
