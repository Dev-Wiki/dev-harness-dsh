import { readFile } from 'node:fs/promises'

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const [statePath, writerId] = process.argv.slice(2)
if (statePath === undefined || writerId === undefined || typeof process.send !== 'function') {
  throw new Error('atomic writer requires a state path, writer id, and IPC channel')
}

process.once('message', async (message) => {
  if (message !== 'go') return
  try {
    await withFileLock(statePath, async () => {
      const current = JSON.parse(await readFile(statePath, 'utf8'))
      await new Promise(resolve => setTimeout(resolve, Number(writerId) % 4))
      await writeFileAtomic(statePath, JSON.stringify({
        revision: current.revision + 1,
        writers: [...current.writers, writerId],
      }), { mode: 0o600, dirMode: 0o700 })
    })
    process.send({ type: 'done' }, () => process.disconnect())
  } catch (error) {
    process.send({
      type: 'error',
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    }, () => process.disconnect())
  }
})

process.send('ready')
