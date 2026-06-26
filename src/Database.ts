import * as path from 'path';
import * as fs from 'fs';
import type { Connection, Table } from '@lancedb/lancedb';
import type { ChunkData, IndexStats, SearchResult } from './types';

type ChunkRecord = Record<string, unknown> & {
  vector: number[];
  file_path: string;
  chunk_index: number;
  content: string;
  start_line: number;
  end_line: number;
  file_hash: string;
  model: string;
  indexed_at: number;
};

interface FileMetadata {
  hash: string;
  model: string;
  indexedAt: number;
  chunkCount: number;
}

interface MetadataStore {
  files: Record<string, FileMetadata>;
}

export class VectorDatabase {
  private db: Connection | null = null;
  private table: Table | null = null;
  private readonly dbDir: string;
  private readonly metaPath: string;
  private meta: MetadataStore = { files: {} };

  constructor(storagePath: string, workspaceHash: string) {
    this.dbDir = path.join(storagePath, `vectors_${workspaceHash}`);
    this.metaPath = path.join(storagePath, `meta_${workspaceHash}.json`);
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.dbDir, { recursive: true });

    // Load metadata sidecar
    if (fs.existsSync(this.metaPath)) {
      try {
        this.meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf-8'));
      } catch {
        this.meta = { files: {} };
      }
    }

    // Connect to LanceDB
    const lancedb = await import('@lancedb/lancedb');
    this.db = await lancedb.connect(this.dbDir);

    const tables = await this.db.tableNames();
    if (tables.includes('chunks')) {
      this.table = await this.db.openTable('chunks');
    }
    // Table is created lazily on first upsert
  }

  getFileHash(filePath: string): string | null {
    return this.meta.files[filePath]?.hash ?? null;
  }

  getFileModel(filePath: string): string | null {
    return this.meta.files[filePath]?.model ?? null;
  }

  async upsertFile(
    filePath: string,
    hash: string,
    model: string,
    chunks: ChunkData[],
    vectors: Float32Array[],
  ): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const records: ChunkRecord[] = chunks.map((chunk, i) => ({
      vector: Array.from(vectors[i]),
      file_path: filePath,
      chunk_index: i,
      content: chunk.content,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      file_hash: hash,
      model,
      indexed_at: Date.now(),
    }));

    if (!this.table) {
      const lancedb = await import('@lancedb/lancedb');
      this.table = await lancedb.Table
        ? await (this.db as any).createTable('chunks', records)
        : await (this.db as any).createTable('chunks', records);
    } else {
      // Remove old chunks for this file before inserting new ones
      const escaped = filePath.replace(/'/g, "''");
      await this.table.delete(`file_path = '${escaped}'`);
      await this.table.add(records);
    }

    // Update metadata
    this.meta.files[filePath] = { hash, model, indexedAt: Date.now(), chunkCount: chunks.length };
    this.saveMetadata();
  }

  async removeFile(filePath: string): Promise<void> {
    if (this.table) {
      const escaped = filePath.replace(/'/g, "''");
      await this.table.delete(`file_path = '${escaped}'`);
    }
    delete this.meta.files[filePath];
    this.saveMetadata();
  }

  async search(queryVector: Float32Array, topK: number): Promise<SearchResult[]> {
    if (!this.table) return [];

    const rows = await (this.table as any)
      .search(Array.from(queryVector))
      .limit(topK)
      .toArray();

    return rows.map((row: any) => ({
      filePath: row.file_path as string,
      relativePath: row.file_path as string, // caller will make it relative
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      content: row.content as string,
      // LanceDB returns L2 distance; for unit vectors: cosine_sim = 1 - (l2² / 2)
      score: Math.max(0, 1 - (row._distance as number) / 2),
    }));
  }

  getStats(): IndexStats {
    const totalFiles = Object.keys(this.meta.files).length;
    const totalChunks = Object.values(this.meta.files).reduce((s, f) => s + f.chunkCount, 0);
    const models = [...new Set(Object.values(this.meta.files).map((f) => f.model))];
    return { totalFiles, totalChunks, model: models[0] ?? '' };
  }

  getIndexedFiles(): Record<string, FileMetadata> {
    return this.meta.files;
  }

  async clear(): Promise<void> {
    if (this.table) {
      await this.table.delete('file_path != ""');
    }
    this.meta = { files: {} };
    this.saveMetadata();
  }

  private saveMetadata(): void {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2), 'utf-8');
  }
}
