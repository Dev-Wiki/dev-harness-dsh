import type { AuditObservation, AuditHandoffTarget } from './audit.js'
import type { FindingRouteRef } from './state.js'

const HANDOFF_ROUTES: Readonly<Record<AuditHandoffTarget, string>> = Object.freeze({
  'dev-harness-auto-fix': 'auto-fix',
  'dev-harness-planning': 'planning',
  'dev-harness-docs': 'docs',
  'dev-harness-commands': 'verification',
  'dev-harness-git-workflow': 'git',
  manual: 'manual',
})

export class FindingRouterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FindingRouterError'
  }
}

export interface FindingRoutingResult {
  readonly findings: readonly FindingRouteRef[]
  readonly confirmedDefects: readonly FindingRouteRef[]
}

export function routeAuditFindings(observation: AuditObservation): FindingRoutingResult {
  if (observation.status !== 'COMPLETED' || observation.needsReverification) {
    throw new FindingRouterError('Audit must be current and completed before Findings can be routed')
  }
  if (observation.crossModuleStatus !== 'completed') {
    throw new FindingRouterError('Audit cross-module reconciliation is incomplete')
  }
  const findings = observation.findings.map(finding => {
    let route: string
    let handoffRef: string | undefined
    if (finding.status === 'confirmed') {
      if (finding.handoff === undefined) {
        throw new FindingRouterError(`confirmed finding ${finding.id} has no handoff`)
      }
      route = HANDOFF_ROUTES[finding.handoff.target]
      handoffRef = finding.handoff.ref
    } else if (finding.status === 'candidate' || finding.status === 'needs-verification') {
      route = 'unresolved'
    } else if (finding.status === 'stale') {
      route = 'stale'
    } else {
      route = 'closed'
    }
    return Object.freeze({
      findingId: finding.id,
      status: finding.status,
      route,
      ...(handoffRef === undefined ? {} : { handoffRef }),
    })
  })
  const confirmedDefects = findings.filter(finding => finding.status === 'confirmed' && finding.route === 'auto-fix')
  return Object.freeze({
    findings: Object.freeze(findings),
    confirmedDefects: Object.freeze(confirmedDefects),
  })
}
