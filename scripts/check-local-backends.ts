import { Studio } from '../src/main/studio'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

const studio = new Studio(resolve('artifacts', 'validation-state'), resolve('.'))
try {
  await studio.startComfy()
  const checks = await studio.check()
  console.log(JSON.stringify(checks, null, 2))
  await writeFile(resolve('artifacts', 'backend-readiness.json'), JSON.stringify(checks, null, 2))
  const character = studio.snapshot().characters[0]
  if (character) {
    try {
      await studio.generate({ characterId: character.id, prompt: 'A person stands and waves hello with their right hand.', seconds: 2, seed: 42, steps: 25, inPlace: true })
      console.log('Real ComfyUI text generation completed.')
    } catch (error) {
      console.log('ACTUAL TEXT-GENERATION STATUS:', error instanceof Error ? error.message : error)
      if (!checks.some(c => c.status === 'blocked')) throw error
    }
  }
} finally { await studio.dispose() }
