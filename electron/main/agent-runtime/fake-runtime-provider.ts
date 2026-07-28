import type {
  IAgentProvider,
  ModelInfo,
  ProviderCredential,
  StreamChunk,
  StreamParams,
} from '../../shared/providers/types'

const FAKE_MODEL_ID = 'brightcode-runtime-v2'
const CHUNK_DELAY_MS = 180

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function lastUserText(params: StreamParams): string {
  const message = [...params.messages].reverse().find((item) => item.role === 'user')
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export const fakeRuntimeProvider: IAgentProvider = {
  id: 'brightcode-runtime-v2-fake',
  name: 'BrightCode Runtime V2',
  baseURL: 'local://agent-runtime-v2',
  authMethod: 'api_key',
  apiFormat: 'custom',

  listModels(): ModelInfo[] {
    return [{
      id: FAKE_MODEL_ID,
      displayName: 'Runtime V2 local',
      provider: this.id,
      supportsThinking: true,
      requiresAuth: false,
    }]
  },

  async *stream(params: StreamParams): AsyncIterable<StreamChunk> {
    const prompt = lastUserText(params)
    const response = `Runtime V2 recebeu: ${prompt}. A resposta continuou no processo principal e pode ser restaurada sem duplicar eventos.`

    yield { type: 'message_start' }
    await wait(CHUNK_DELAY_MS, params.signal)
    if (params.signal?.aborted) return
    yield { type: 'thinking_delta', text: 'Validando a thread persistida e a sequência dos eventos.' }

    for (const text of response.match(/.{1,18}/g) ?? []) {
      await wait(CHUNK_DELAY_MS, params.signal)
      if (params.signal?.aborted) return
      yield { type: 'text_delta', text }
    }

    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      model: FAKE_MODEL_ID,
    }
  },

  async validateCredential(_credential: ProviderCredential): Promise<boolean> {
    return true
  },
}

export const FAKE_RUNTIME_MODEL_ID = FAKE_MODEL_ID
