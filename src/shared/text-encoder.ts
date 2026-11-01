import type { Check } from './types'

export function recommendTextEncoder(gpu?: Check['gpu']): { encoder?: 'llm2vec' | 'lfm'; detail: string } {
  if (!gpu || !Number.isFinite(gpu.totalGB) || !Number.isFinite(gpu.freeGB) ||
      gpu.totalGB <= 0 || gpu.freeGB < 0 || gpu.freeGB > gpu.totalGB)
    return { detail: 'GPU memory could not be detected. Choose manually; CPU-only generation is slow. Refresh readiness after changing the backend.' }
  if (gpu.freeGB >= 24)
    return { encoder: 'llm2vec', detail: 'Memory guidance: Llama + LLM2Vec is the original conditioning and has more headroom with at least 24 GiB currently free. It still requires Meta approval. LFM remains available without approval.' }
  return { encoder: 'lfm', detail: 'Memory guidance: try the smaller LFM bridge with less than 24 GiB currently free. It avoids Meta approval but approximates conditioning.' +
    (gpu.freeGB < 4 ? ' Available memory is tight even for LFM; close other GPU workloads before generating.' : '') }
}
