import { getModelInfo } from './types';

type ProgressCallback = (message: string, percent?: number) => void;

export class EmbeddingService {
  private extractor: any = null;
  private currentModelId = '';
  private cachePath = '';

  async init(modelId: string, cachePath: string, onProgress?: ProgressCallback): Promise<void> {
    if (this.extractor && this.currentModelId === modelId) return;

    this.cachePath = cachePath;

    // Dynamically import to defer heavy ONNX runtime load
    const { pipeline, env } = await import('@huggingface/transformers');

    env.cacheDir = cachePath;
    env.allowLocalModels = false;

    onProgress?.(`Loading model: ${modelId}`, 0);

    let lastPct = -1;
    this.extractor = await pipeline('feature-extraction', modelId, {
      dtype: 'q8',
      progress_callback: (progress: any) => {
        if (progress.status === 'downloading' || progress.status === 'progress') {
          const pct = progress.total
            ? Math.round((100 * progress.loaded) / progress.total)
            : 0;
          if (pct !== lastPct) {
            lastPct = pct;
            const name = (progress.file as string | undefined)?.split('/').pop() ?? '';
            onProgress?.(
              `Downloading ${name} (${pct}%)`,
              pct,
            );
          }
        } else if (progress.status === 'loading') {
          onProgress?.('Loading model into memory…', 99);
        }
      },
    } as any);

    this.currentModelId = modelId;
    onProgress?.('Model ready', 100);
  }

  get queryPrefix(): string {
    return getModelInfo(this.currentModelId).queryPrefix;
  }

  /** Embed a single query string (prepends query prefix when needed). */
  async embedQuery(query: string): Promise<Float32Array> {
    const text = this.queryPrefix + query;
    return this.embedBatch([text]).then((r) => r[0]);
  }

  /** Embed a batch of document strings. Returns one Float32Array per input. */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) throw new Error('Model not loaded. Call init() first.');
    if (texts.length === 0) return [];

    const output = await this.extractor(texts, { pooling: 'mean', normalize: true });

    // output.dims = [batchSize, hiddenSize]
    const [batchSize, hiddenSize] = output.dims as [number, number];
    const result: Float32Array[] = [];

    for (let i = 0; i < batchSize; i++) {
      // Slice the flat data buffer into per-item embeddings
      const slice = (output.data as Float32Array).slice(
        i * hiddenSize,
        (i + 1) * hiddenSize,
      );
      result.push(slice);
    }

    return result;
  }
}
