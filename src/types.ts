export interface ModelInfo {
  id: string;
  name: string;
  /** Prefix prepended to queries (not documents) for better retrieval quality */
  queryPrefix: string;
}

export const MODELS: ModelInfo[] = [
  {
    id: 'Snowflake/snowflake-arctic-embed-s',
    name: 'Snowflake Arctic Embed S (default, fast)',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  {
    id: 'Snowflake/snowflake-arctic-embed-m-v1.5',
    name: 'Snowflake Arctic Embed M (balanced)',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  {
    id: 'Snowflake/snowflake-arctic-embed-l',
    name: 'Snowflake Arctic Embed L (most accurate)',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  {
    id: 'BAAI/bge-small-en-v1.5',
    name: 'BGE Small EN v1.5',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  {
    id: 'BAAI/bge-base-en-v1.5',
    name: 'BGE Base EN v1.5',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  {
    id: 'sentence-transformers/all-MiniLM-L6-v2',
    name: 'all-MiniLM-L6-v2 (multilingual)',
    queryPrefix: '',
  },
  {
    id: 'Salesforce/SFR-Embedding-Code-400M_R',
    name: 'SFR Embedding Code 400M (code-focused)',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  {
    id: 'jinaai/jina-code-embeddings-1.5b',
    name: 'Jina Code Embeddings 1.5B (code-focused, large)',
    queryPrefix: '',
  },
];

export function getModelInfo(modelId: string): ModelInfo {
  return MODELS.find((m) => m.id === modelId) ?? MODELS[0];
}

export interface ChunkData {
  content: string;
  startLine: number;
  endLine: number;
}

export interface SearchResult {
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  content: string;
  /** 0–1 similarity score (higher = more relevant) */
  score: number;
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  model: string;
}

// Messages sent from webview → extension
export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'search'; query: string }
  | { type: 'indexAll' }
  | { type: 'clearIndex' }
  | { type: 'openFile'; filePath: string; line: number };

// Messages sent from extension → webview
export type ExtensionToWebview =
  | { type: 'searchResults'; results: SearchResult[] }
  | { type: 'indexProgress'; message: string; percent: number }
  | { type: 'indexComplete'; stats: IndexStats }
  | { type: 'stats'; stats: IndexStats }
  | { type: 'error'; message: string };
