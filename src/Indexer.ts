import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import type { VectorDatabase } from './Database';
import type { EmbeddingService } from './EmbeddingService';
import type { ChunkData } from './types';

/** Extensions always treated as text regardless of heuristics. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.php', '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.erl', '.hs', '.clj',
  '.html', '.htm', '.vue', '.svelte', '.astro',
  '.css', '.scss', '.less', '.sass',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env',
  '.xml', '.svg', '.graphql', '.gql',
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.prisma', '.proto',
  '.tf', '.hcl',
  '.makefile', '.dockerfile', 'dockerfile',
]);

type ProgressCallback = (message: string, percent: number) => void;

export class Indexer {
  constructor(
    private readonly db: VectorDatabase,
    private readonly embedder: EmbeddingService,
  ) {}

  async indexWorkspace(
    workspaceUri: vscode.Uri,
    modelId: string,
    config: { maxFileSizeKb: number; chunkLines: number; overlapLines: number; batchSize?: number },
    onProgress: ProgressCallback,
    token: vscode.CancellationToken,
  ): Promise<void> {
    onProgress('Discovering files…', 0);

    const ignoreFilter = await buildIgnoreFilter(workspaceUri);
    const allFiles = await gatherFiles(workspaceUri, ignoreFilter, config.maxFileSizeKb * 1024);

    if (allFiles.length === 0) {
      onProgress('No indexable files found.', 100);
      return;
    }

    // Determine which files need re-indexing by comparing stored hash
    const toIndex: vscode.Uri[] = [];
    for (const uri of allFiles) {
      const key = uri.toString();
      const storedHash = this.db.getFileHash(key);
      if (!storedHash || this.db.getFileModel(key) !== modelId) {
        toIndex.push(uri);
        continue;
      }
      const currentHash = await hashFileUri(uri);
      if (currentHash !== storedHash) toIndex.push(uri);
    }

    onProgress(`${toIndex.length} of ${allFiles.length} files need indexing…`, 2);

    const batchSize = config.batchSize ?? 4;
    let done = 0;

    for (let i = 0; i < toIndex.length; i += batchSize) {
      if (token.isCancellationRequested) break;

      const batch = toIndex.slice(i, i + batchSize);
      await this.indexFileBatch(batch, modelId, config);

      done += batch.length;
      onProgress(
        `Indexed ${done} / ${toIndex.length} files…`,
        Math.round(2 + (98 * done) / toIndex.length),
      );
    }
  }

  private async indexFileBatch(
    uris: vscode.Uri[],
    modelId: string,
    config: { chunkLines: number; overlapLines: number },
  ): Promise<void> {
    const entries: Array<{ key: string; hash: string; chunks: ChunkData[] }> = [];

    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf-8');
        const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
        const chunks = splitIntoChunks(text, config.chunkLines, config.overlapLines);
        if (chunks.length > 0) {
          entries.push({ key: uri.toString(), hash, chunks });
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (entries.length === 0) return;

    const allTexts = entries.flatMap((e) => e.chunks.map((c) => c.content));
    const allVectors = await this.embedder.embedBatch(allTexts);

    let offset = 0;
    for (const { key, hash, chunks } of entries) {
      const vectors = allVectors.slice(offset, offset + chunks.length);
      offset += chunks.length;
      await this.db.upsertFile(key, hash, modelId, chunks, vectors);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashFileUri(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function splitIntoChunks(text: string, chunkLines: number, overlapLines: number): ChunkData[] {
  const lines = text.split('\n');
  const chunks: ChunkData[] = [];
  const step = Math.max(1, chunkLines - overlapLines);

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + chunkLines, lines.length);
    const content = lines.slice(start, end).join('\n').trim();
    if (content.length > 0) {
      chunks.push({ content, startLine: start, endLine: end - 1 });
    }
    if (end >= lines.length) break;
  }

  return chunks;
}

async function buildIgnoreFilter(
  rootUri: vscode.Uri,
): Promise<(uri: vscode.Uri) => boolean> {
  const { default: ignore } = await import('ignore');
  const ig = ignore();

  ig.add([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out',
    '.DS_Store', 'Thumbs.db',
  ]);

  for (const name of ['.gitignore', '.semanticignore']) {
    const ignoreUri = vscode.Uri.joinPath(rootUri, name);
    try {
      const bytes = await vscode.workspace.fs.readFile(ignoreUri);
      ig.add(Buffer.from(bytes).toString('utf-8'));
    } catch {
      // File doesn't exist — skip
    }
  }

  const rootPath = rootUri.path.replace(/\/$/, '');

  return (uri: vscode.Uri) => {
    const rel = uri.path.slice(rootPath.length).replace(/^\//, '');
    if (!rel) return false;
    return ig.ignores(rel);
  };
}

async function gatherFiles(
  rootUri: vscode.Uri,
  shouldIgnore: (uri: vscode.Uri) => boolean,
  maxSize: number,
): Promise<vscode.Uri[]> {
  const result: vscode.Uri[] = [];

  async function walk(dirUri: vscode.Uri): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      const entryUri = vscode.Uri.joinPath(dirUri, name);
      if (shouldIgnore(entryUri)) continue;

      if (type === vscode.FileType.Directory) {
        await walk(entryUri);
      } else if (type === vscode.FileType.File) {
        try {
          const stat = await vscode.workspace.fs.stat(entryUri);
          if (stat.size > maxSize) continue;
          if (await isTextFile(entryUri, name)) {
            result.push(entryUri);
          }
        } catch {
          // Skip inaccessible files
        }
      }
    }
  }

  await walk(rootUri);
  return result;
}

async function isTextFile(uri: vscode.Uri, filename: string): Promise<boolean> {
  const ext = path.extname(filename).toLowerCase();
  const base = filename.toLowerCase();

  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(base)) return true;

  // Check first 512 bytes for null bytes (binary heuristic)
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const limit = Math.min(512, bytes.length);
    for (let i = 0; i < limit; i++) {
      if (bytes[i] === 0) return false;
    }
    return bytes.length > 0;
  } catch {
    return false;
  }
}
