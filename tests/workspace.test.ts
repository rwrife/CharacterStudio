import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSettingsDraft, processStepStatus } from '../src/shared/workspace'

test('process navigation distinguishes current selection from actual output and job state', () => {
  const step = { id: 'scene', label: 'Character & scene' }
  assert.equal(processStepStatus(step, true), 'Current step')
  assert.equal(processStepStatus(step, false), 'Pending')
  assert.equal(processStepStatus({ ...step, complete: true }, true), 'Current step · Complete')
  assert.equal(processStepStatus({ ...step, complete: true, state: 'failed' }, false), 'Failed')
  assert.equal(processStepStatus({ ...step, state: 'running' }, false), 'Running')
  assert.equal(processStepStatus({ ...step, state: 'imported' }, false), 'Imported')
})

test('settings drafts merge only edited fields and reject concurrent edits to the same field', () => {
  const base = { model: 'a', encoder: 'original', optional: 'remove' }
  const draft = { ...base, model: 'b' }
  assert.deepEqual(mergeSettingsDraft(base, draft, { ...base, encoder: 'new' }), { ...draft, encoder: 'new' })
  assert.throws(() => mergeSettingsDraft(base, draft, { ...base, model: 'c' }), /Settings changed elsewhere \(model\)/)
  assert.deepEqual(mergeSettingsDraft(base, draft, draft), draft)
  assert.deepEqual(mergeSettingsDraft<{ value?: string }>({ value: 'a' }, {}, { value: 'a' }), {})
})
