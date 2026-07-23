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
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;

  // Stable short hash keyed on the workspace URI string (works for any scheme)
  const workspaceId = workspaceUri
    ? crypto.createHash('md5').update(workspaceUri.toString()).digest('hex').slice(0, 8)
    : 'no-workspace';

  // globalStorageUri is always local — fine for DB and model cache
  const storagePath = context.globalStorageUri.fsPath;

  db = new VectorDatabase(storagePath, workspaceId);
  embedder = new EmbeddingService();
  indexer = new Indexer(db, embedder);

  await db.init();

  sidebar = new SidebarProvider(context.extensionUri);

  // ---- sidebar handlers ----
  sidebar.onSearch = async (query) => {
    if (!workspaceUri) {
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

      const rootPath = workspaceUri.path.replace(/\/$/, '');
      const results = raw.map((r) => ({
        ...r,
        // Derive a display-friendly relative path from the stored URI string
        relativePath: (() => {
          try {
            const fileUri = vscode.Uri.parse(r.filePath);
            return fileUri.path.slice(rootPath.length).replace(/^\//, '') || r.filePath;
          } catch {
            return r.filePath;
          }
        })(),
      }));

      sidebar!.post({ type: 'searchResults', results });
    } catch (err) {
      sidebar!.post({ type: 'error', message: String(err) });
    }
  };

  sidebar.onIndexAll = async () => {
    if (!workspaceUri) {
      sidebar!.post({ type: 'error', message: 'No workspace folder open.' });
      return;
    }

    const cfg = getConfig();
    const modelId = cfg.get<string>('model')!;
    const dtype = cfg.get<string>('dtype') ?? 'q8';
    const modelCachePath = path.join(context.globalStorageUri.fsPath, 'model-cache');

    const tokenSource = new vscode.CancellationTokenSource();

    try {
      await embedder!.init(modelId, dtype, modelCachePath, (msg, pct) => {
        sidebar!.post({ type: 'indexProgress', message: msg, percent: pct ?? 0 });
      });

      await indexer!.indexWorkspace(
        workspaceUri,
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

      sidebar!.post({ type: 'indexComplete', stats: db!.getStats() });
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

  // ---- commands ----
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
}

export function deactivate(): void {
  db = null;
  embedder = null;
  indexer = null;
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('semanticSearch');
}
