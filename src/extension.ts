import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { SidebarProvider } from './SidebarProvider';
import { VectorDatabase } from './Database';
import { EmbeddingService } from './EmbeddingService';
import { Indexer } from './Indexer';

let db: VectorDatabase | null = null;
let embedder: EmbeddingService | null = null;
let indexer: Indexer | null = null;
let sidebar: SidebarProvider | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Derive a short stable hash for the workspace path so DB files don't collide
  const workspaceId = workspaceRoot
    ? crypto.createHash('md5').update(workspaceRoot).digest('hex').slice(0, 8)
    : 'no-workspace';

  // Store DB in global extension storage (persists across workspace opens)
  const storagePath = context.globalStorageUri.fsPath;

  db = new VectorDatabase(storagePath, workspaceId);
  embedder = new EmbeddingService();
  indexer = new Indexer(db, embedder);

  await db.init();

  sidebar = new SidebarProvider(context.extensionUri);

  // ---- sidebar handlers ----
  sidebar.onSearch = async (query) => {
    if (!workspaceRoot) {
      sidebar!.post({ type: 'error', message: 'No workspace folder open.' });
      return;
    }
    try {
      const cfg = getConfig();
      const modelId = cfg.get<string>('model')!;
      const dtype = cfg.get<string>('dtype') ?? 'q8';
      const modelCachePath = path.join(context.globalStorageUri.fsPath, 'model-cache');

      await embedder!.init(modelId, dtype, modelCachePath, (msg) => {
        sidebar!.post({ type: 'indexProgress', message: msg, percent: 0 });
      });

      const queryVec = await embedder!.embedQuery(query);

      const topK = cfg.get<number>('topK') ?? 10;
      const raw = await db!.search(queryVec, topK);

      const results = raw.map((r) => ({
        ...r,
        relativePath: path.relative(workspaceRoot, r.filePath).replace(/\\/g, '/'),
      }));

      sidebar!.post({ type: 'searchResults', results });
    } catch (err) {
      sidebar!.post({ type: 'error', message: String(err) });
    }
  };

  sidebar.onIndexAll = async () => {
    if (!workspaceRoot) {
      sidebar!.post({ type: 'error', message: 'No workspace folder open.' });
      return;
    }

    const cfg = getConfig();
    const modelId = cfg.get<string>('model')!;
    const dtype = cfg.get<string>('dtype') ?? 'q8';
    const modelCachePath = path.join(context.globalStorageUri.fsPath, 'model-cache');

    const tokenSource = new vscode.CancellationTokenSource();

    try {
      // Load model first with progress
      await embedder!.init(modelId, dtype, modelCachePath, (msg, pct) => {
        sidebar!.post({ type: 'indexProgress', message: msg, percent: pct ?? 0 });
      });

      await indexer!.indexWorkspace(
        workspaceRoot,
        modelId,
        {
          maxFileSizeKb: cfg.get<number>('maxFileSizeKb') ?? 512,
          chunkLines: cfg.get<number>('chunkLines') ?? 40,
          overlapLines: cfg.get<number>('chunkOverlapLines') ?? 8,
        },
        (message, percent) => {
          sidebar!.post({ type: 'indexProgress', message, percent });
        },
        tokenSource.token,
      );

      const stats = db!.getStats();
      sidebar!.post({ type: 'indexComplete', stats });
    } catch (err) {
      sidebar!.post({ type: 'error', message: String(err) });
    } finally {
      tokenSource.dispose();
    }
  };

  sidebar.onClearIndex = async () => {
    await db!.clear();
    sidebar!.post({ type: 'stats', stats: { totalFiles: 0, totalChunks: 0, model: '' } });
  };

  // ---- register sidebar ----
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ---- commands (also accessible from Command Palette) ----
  context.subscriptions.push(
    vscode.commands.registerCommand('semanticSearch.indexAll', () => {
      sidebar?.onIndexAll?.();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('semanticSearch.clearIndex', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Clear the semantic search index?',
        { modal: true },
        'Clear',
      );
      if (answer === 'Clear') {
        sidebar?.onClearIndex?.();
        vscode.window.showInformationMessage('Semantic search index cleared.');
      }
    }),
  );

  // Push initial stats to sidebar when it becomes visible
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      // Theme changed — no-op but can be used later for updates
    }),
  );
}

export function deactivate(): void {
  db = null;
  embedder = null;
  indexer = null;
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('semanticSearch');
}
