import { getModelInfo } from './types';

type ProgressCallback = (message: string, percent?: number) => void;

export class EmbeddingService {
  private extractor: any = null;
  private currentModelId = '';
  private currentDtype = '';
  // In-flight init promise — concurrent callers for the same model+dtype share one load
  private loadingPromise: Promise<void> | null = null;
  private loadingKey = '';

  async init(
    modelId: string,
    dtype: string,
    cachePath: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const key = `${modelId}::${dtype}`;

    // Already loaded with the same model and dtype — fast path
    if (this.extractor && this.currentModelId === modelId && this.currentDtype === dtype) return;

    // Another caller is already loading the same combination — join that work
    if (this.loadingPromise && this.loadingKey === key) {
      return this.loadingPromise;
    }

    this.loadingKey = key;
    console.log(`Loading embedding model: ${modelId} (${dtype})`);
    this.loadingPromise = this._load(modelId, dtype, cachePath, onProgress).finally(() => {
      this.loadingPromise = null;
      this.loadingKey = '';
    });

    return this.loadingPromise;
  }

  private async _load(
    modelId: string,
    dtype: string,
    cachePath: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const { pipeline, env } = await import('@huggingface/transformers');

    env.cacheDir = cachePath;
    env.allowLocalModels = false;

    onProgress?.(`Loading model: ${modelId} (${dtype})`, 0);

    // Release the previous model's ONNX session before allocating a new one
    if (this.extractor) {
      try { await this.extractor.dispose(); } catch { /* ignore if not supported */ }
      this.extractor = null;
    }

    let lastPct = -1;
    this.extractor = await pipeline('feature-extraction', modelId, {
      dtype,
      progress_callback: (progress: any) => {
        if (progress.status === 'downloading' || progress.status === 'progress') {
          const pct = progress.total
            ? Math.round((100 * progress.loaded) / progress.total)
            : 0;
          if (pct !== lastPct) {
            lastPct = pct;
            const name = (progress.file as string | undefined)?.split('/').pop() ?? '';
            onProgress?.(`Downloading ${name} (${pct}%)`, pct);
          }
        } else if (progress.status === 'loading') {
          onProgress?.('Loading model into memory…', 99);
        }
      },
    } as any);

    this.currentModelId = modelId;
    this.currentDtype = dtype;
    onProgress?.('Model ready', 100);
  }

  get queryPrefix(): string {
    return getModelInfo(this.currentModelId).queryPrefix;
  }

  /** Embed a single query string (prepends query prefix when needed). */
  async embedQuery(query: string): Promise<Float32Array> {
    return this.embedBatch([this.queryPrefix + query]).then((r) => r[0]);
  }

  /** Embed a batch of document strings. Returns one Float32Array per input. */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) throw new Error('Model not loaded. Call init() first.');
    if (texts.length === 0) return [];

    const output = await this.extractor(texts, { pooling: 'mean', normalize: true });

    const [batchSize, hiddenSize] = output.dims as [number, number];
    const result: Float32Array[] = [];

    for (let i = 0; i < batchSize; i++) {
      result.push(
        (output.data as Float32Array).slice(i * hiddenSize, (i + 1) * hiddenSize),
      );
    }

    return result;
  }
}
