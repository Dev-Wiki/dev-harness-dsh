import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'

export const name = 'dev-harness-dsh-v0-fixture'
export const inject = ['commands']

export const Config = z.object({
  probe: z.boolean().default(true),
})

export interface Config {
  probe?: boolean
}

/**
 * Minimal external DSH plugin used only by Task V0.
 *
 * The registration is attached to the plugin fiber through ctx.effect(), so
 * disposing the fiber must also remove the command.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.commands.register({
    name: 'harness-status',
    description: 'Report whether the V0 fixture is mounted.',
    handler: () => ({
      kind: 'success',
      text: `dev-harness-dsh fixture: probe=${config.probe ?? true}`,
    }),
  }), 'dev-harness-dsh-v0-fixture: command')
}
