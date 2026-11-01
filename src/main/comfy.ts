import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { GenerateRequest, Settings } from '../shared/types'
import { localUrl } from './validation'

type Prompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>
export function buildPrompt(request: GenerateRequest, prefix: string, constraintsPath = '', textEncoder: Settings['textEncoder'] = 'llm2vec'): Prompt {
  return {
    '1': { class_type: textEncoder === 'lfm' ? 'Studio_Kimodo_LoadLFM' : 'Kimodo_LoadModel', inputs: { model: 'Kimodo-SOMA-RP-v1' } },
    '2': { class_type: 'Kimodo_TextEncode', inputs: { model: ['1', 0], prompt: request.prompt } },
    '3': { class_type: 'Kimodo_Sampler', inputs: { model: ['1', 0], conditioning: ['2', 0], duration: request.seconds, seed: request.seed, num_samples: 1, diffusion_steps: request.steps, constraints_json: constraintsPath } },
    '4': { class_type: 'Kimodo_SaveNPZ', inputs: { motion: ['3', 0], filename_prefix: prefix } },
    '5': { class_type: 'Kimodo_ExportBVH', inputs: { motion: ['3', 0], filename_prefix: prefix, sample_index: 0 } },
    '6': { class_type: 'Kimodo_Preview3D', inputs: { motion: ['3', 0], sample_index: 0 } }
  }
}

export async function api<T>(base: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(localUrl(base) + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error'
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`ComfyUI ${path}: HTTP ${response.status}. ${text.slice(0, 1500)}`)
  return (text ? JSON.parse(text) : {}) as T
}

interface HistoryEntry {
  status: { completed: boolean; status_str: string; messages: [string, Record<string, unknown>][] }
  outputs: Record<string, { motion_json?: string[] }>
}

export async function generateMotion(options: {
  base: string
  request: GenerateRequest
  prefix: string
  signal: AbortSignal
  progress: (message: string, progress: number) => void
  submitted: (promptId: string) => void
  constraintsPath?: string
  textEncoder?: Settings['textEncoder']
}): Promise<{ promptId: string; fps: number; frames: number }> {
  const { base, request, signal, progress } = options
  const clientId = randomUUID()
  // A client-supplied id makes an interrupted POST recoverable without submitting twice.
  const promptId = randomUUID()
  options.submitted(promptId)
  let socket: WebSocket | undefined
  let wsError: Error | undefined
  const labels: Record<string, string> = {
    '1': 'Loading Kimodo model and text encoder; first use may download weights',
    '2': 'Encoding motion instructions', '3': 'Generating motion',
    '4': 'Saving original motion data', '5': 'Exporting SOMA BVH', '6': 'Finalizing motion metadata'
  }
  try {
    socket = new WebSocket(localUrl(base).replace('http:', 'ws:') + '/ws?clientId=' + clientId)
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      try {
        const message = JSON.parse(event.data)
        const data = message.data
        if (data?.prompt_id !== promptId) return
        if (message.type === 'executing' && data.node) progress(labels[data.node] ?? `Executing node ${data.node}`, 35)
        if (message.type === 'progress' && data.max > 0) progress(`Denoising ${data.value}/${data.max}`, 35 + 35 * data.value / data.max)
        if (message.type === 'execution_error') wsError = new Error(`${data.node_type}: ${data.exception_message}`)
      } catch (error) {
        wsError = new Error(`Invalid ComfyUI progress response: ${String(error)}`)
      }
    })
    // History polling is authoritative, so generation also works if WebSocket progress disconnects.
    socket.addEventListener('error', () => progress('Live progress unavailable; checking ComfyUI job history', 30))
    const submitted = await api<{ prompt_id: string }>(base, '/prompt', {
      prompt: buildPrompt(request, options.prefix, options.constraintsPath, options.textEncoder), client_id: clientId, prompt_id: promptId
    })
    if (submitted.prompt_id !== promptId) throw new Error('ComfyUI did not preserve the submitted job ID. Update ComfyUI before retrying.')
    progress('Motion queued. Waiting for ComfyUI.', 28)
    const deadline = Date.now() + 60 * 60 * 1000
    let failures = 0
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (wsError) throw wsError
      let history: Record<string, HistoryEntry>
      try {
        history = await api<Record<string, HistoryEntry>>(base, `/history/${promptId}`, undefined, signal)
        failures = 0
      } catch (error) {
        signal.throwIfAborted()
        if (++failures >= 4) throw error
        progress(`ComfyUI connection interrupted; retrying history (${failures}/4)`, 30)
        await delay(2000, undefined, { signal })
        continue
      }
      const item = history[promptId]
      if (item?.status?.status_str === 'error') {
        const failure = item.status.messages.find(([type]) => type === 'execution_error' || type === 'execution_interrupted')
        throw new Error(failure ? `${failure[1].node_type ?? 'ComfyUI'}: ${failure[1].exception_message ?? 'Generation interrupted'}` : 'ComfyUI generation failed. Open the ComfyUI log for details.')
      }
      if (item?.status?.completed) {
        const metadata = item.outputs['6']?.motion_json?.[0]
        if (!metadata) throw new Error('ComfyUI completed without required motion metadata. Check the Kimodo Preview3D node.')
        const motion = JSON.parse(metadata)
        if (motion.num_joints !== 77 || !Number.isInteger(motion.num_frames) || motion.num_frames < 2 ||
            !Number.isFinite(motion.fps) || motion.fps < 1 || motion.fps > 120)
          throw new Error('ComfyUI returned an incompatible motion. The app requires SOMA-77 character motion.')
        const expected = Math.floor(request.seconds * motion.fps) * request.prompt.split('.').filter(p => p.trim()).length
        if (motion.num_frames !== expected)
          throw new Error(`ComfyUI returned ${motion.num_frames} frames; expected ${expected}. Refusing a clip with incorrect duration or endpoint indices.`)
        return { promptId, fps: motion.fps, frames: motion.num_frames }
      }
      await delay(1500, undefined, { signal })
    }
    throw new Error('Generation exceeded one hour. Inspect ComfyUI downloads/logs and retry after setup is complete.')
  } finally {
    socket?.close()
  }
}

export async function cancelMotion(base: string, promptId: string): Promise<void> {
  // Do not use the global /interrupt endpoint: other local ComfyUI users may have jobs.
  await api(base, `/api/jobs/${promptId}/cancel`, {})
}
