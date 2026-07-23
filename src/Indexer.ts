import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
    workspaceRoot: string,
    modelId: string,
    config: { maxFileSizeKb: number; chunkLines: number; overlapLines: number; batchSize?: number },
    onProgress: ProgressCallback,
    token: vscode.CancellationToken,
  ): Promise<void> {
    onProgress('Discovering files…', 0);

    const ignoreFilter = await buildIgnoreFilter(workspaceRoot);
    const allFiles = await gatherFiles(workspaceRoot, ignoreFilter, config.maxFileSizeKb * 1024);

    if (allFiles.length === 0) {
      onProgress('No indexable files found.', 100);
      return;
    }

    // Determine which files actually need re-indexing
    const toIndex = allFiles.filter((f) => {
      const stored = this.db.getFileHash(f);
      if (!stored) return true;
      if (this.db.getFileModel(f) !== modelId) return true;
      const current = hashFile(f);
      return current !== stored;
    });

    onProgress(`${toIndex.length} of ${allFiles.length} files need indexing…`, 2);

    const batchSize = config.batchSize ?? 4;
    let done = 0;

    for (let i = 0; i < toIndex.length; i += batchSize) {
      if (token.isCancellationRequested) break;

      const batch = toIndex.slice(i, i + batchSize);
      await this.indexFileBatch(batch, workspaceRoot, modelId, config);

      done += batch.length;
      const pct = Math.round(2 + (98 * done) / toIndex.length);
      onProgress(
        `Indexed ${done} / ${toIndex.length} files…`,
        pct,
      );
    }
  }

  private async indexFileBatch(
    files: string[],
    workspaceRoot: string,
    modelId: string,
    config: { chunkLines: number; overlapLines: number },
  ): Promise<void> {
    // Build all chunks across the batch first, then embed together
    const entries: Array<{ filePath: string; hash: string; chunks: ChunkData[] }> = [];

    for (const filePath of files) {
      try {
        const text = fs.readFileSync(filePath, 'utf-8');
        const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
        const chunks = splitIntoChunks(text, config.chunkLines, config.overlapLines);
        if (chunks.length > 0) {
          entries.push({ filePath, hash, chunks });
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (entries.length === 0) return;

    const allTexts = entries.flatMap((e) => e.chunks.map((c) => c.content));
    const allVectors = await this.embedder.embedBatch(allTexts);

    let offset = 0;
    for (const { filePath, hash, chunks } of entries) {
      const vectors = allVectors.slice(offset, offset + chunks.length);
      offset += chunks.length;
      await this.db.upsertFile(filePath, hash, modelId, chunks, vectors);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
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

async function buildIgnoreFilter(root: string): Promise<(filePath: string) => boolean> {
  const { default: ignore } = await import('ignore');

  const ig = ignore();

  // Always ignore these
  ig.add([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    'out',
    '.DS_Store',
    'Thumbs.db',
  ]);

  for (const name of ['.gitignore', '.semanticignore']) {
    const ignoreFile = path.join(root, name);
    if (fs.existsSync(ignoreFile)) {
      try {
        ig.add(fs.readFileSync(ignoreFile, 'utf-8'));
      } catch {
        // ignore parse errors
      }
    }
  }

  return (absPath: string) => {
    const rel = path.relative(root, absPath).replace(/\\/g, '/');
    return ig.ignores(rel);
  };
}

async function gatherFiles(
  root: string,
  shouldIgnore: (p: string) => boolean,
  maxSize: number,
): Promise<string[]> {
  const result: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (shouldIgnore(absPath)) continue;

      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > maxSize) continue;
          if (isTextFile(absPath)) {
            result.push(absPath);
          }
        } catch {
          // skip
        }
      }
    }
  }

  walk(root);
  return result;
}

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(base)) return true;

  // Heuristic: check first 512 bytes for null bytes (binary indicator)
  try {
    const buf = Buffer.alloc(512);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return false;
    }
    return bytesRead > 0;
  } catch {
    return false;
  }
}
