import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import {
  AGENT_RUNTIME_IPC_SCHEMAS,
  AGENT_RUNTIME_MAX_IMAGE_DATA_CHARS,
  AGENT_RUNTIME_MAX_IMAGES,
  isAgentRuntimeImagePayloadWithinLimit,
} from '../../electron/shared/agent-runtime-ipc'

const ajv = new Ajv({ allErrors: true })

describe('Agent Runtime IPC schemas', () => {
  it('accepts a complete turn start command', () => {
    const validate = ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.turnStart)
    expect(validate({
      threadId: 'runtime_task_1',
      text: 'hello',
      images: [{ data: 'base64data', mediaType: 'image/png' }],
    })).toBe(true)
  })

  it('caps individual, count, and aggregate image payload size', () => {
    const validate = ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.turnStart)
    const image = { data: 'base64data', mediaType: 'image/png' }
    expect(validate({
      threadId: 'runtime_task_1',
      text: 'hello',
      images: Array.from({ length: AGENT_RUNTIME_MAX_IMAGES + 1 }, () => image),
    })).toBe(false)
    expect(validate({
      threadId: 'runtime_task_1',
      text: 'hello',
      images: [{ ...image, data: 'x'.repeat(AGENT_RUNTIME_MAX_IMAGE_DATA_CHARS + 1) }],
    })).toBe(false)
    expect(isAgentRuntimeImagePayloadWithinLimit([
      { ...image, data: 'x'.repeat(7_000_000) },
      { ...image, data: 'x'.repeat(7_000_000) },
      { ...image, data: 'x'.repeat(7_000_001) },
    ])).toBe(false)
  })

  it('rejects traversal-like thread ids and unknown fields', () => {
    const validate = ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.turnStart)
    expect(validate({ threadId: '../auth', text: 'hello' })).toBe(false)
    expect(validate({ threadId: 'runtime_task_1', text: 'hello', provider: 'remote' })).toBe(false)
  })

  it('requires scoped subscription ids and non-regressing cursors', () => {
    const validate = ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.subscribe)
    expect(validate({
      threadId: 'runtime_task_1',
      subscriptionId: 'view_1',
      afterSequence: 12,
    })).toBe(true)
    expect(validate({
      threadId: 'runtime_task_1',
      subscriptionId: 'bad:id',
      afterSequence: -2,
    })).toBe(false)
  })
})
