import * as vscode from 'vscode';
import * as path from 'path';
import type { ExtensionToWebview, SearchResult, IndexStats, WebviewToExtension } from './types';
import { MODELS } from './types';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'semanticSearch.sidebar';

  private view?: vscode.WebviewView;
  private readonly extensionUri: vscode.Uri;

  onSearch?: (query: string) => void;
  onIndexAll?: () => void;
  onClearIndex?: () => void;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.buildHtml();

    webviewView.webview.onDidReceiveMessage((raw: WebviewToExtension) => {
      switch (raw.type) {
        case 'search':
          this.onSearch?.(raw.query);
          break;
        case 'indexAll':
          this.onIndexAll?.();
          break;
        case 'clearIndex':
          this.onClearIndex?.();
          break;
        case 'openFile': {
          // filePath is stored as a URI string (works for file://, vscode-remote://, etc.)
          const uri = vscode.Uri.parse(raw.filePath);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(raw.line, 0, raw.line, 0),
            preview: true,
          });
          break;
        }
      }
    });
  }

  post(msg: ExtensionToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(): string {
    const modelOptions = MODELS.map(
      (m) => `<option value="${m.id}">${m.name}</option>`,
    ).join('\n          ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 100vh;
  }

  label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: block;
    margin-bottom: 3px;
  }

  select, input[type="text"] {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 4px 6px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }
  select:focus, input[type="text"]:focus {
    border-color: var(--vscode-focusBorder);
  }

  .search-row {
    display: flex;
    gap: 4px;
  }
  .search-row input { flex: 1; }

  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    padding: 4px 8px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }

  .action-row {
    display: flex;
    gap: 4px;
  }
  .action-row button { flex: 1; }

  .progress-wrap {
    display: none;
    flex-direction: column;
    gap: 4px;
  }
  .progress-wrap.visible { display: flex; }
  .progress-bar-track {
    height: 3px;
    background: var(--vscode-input-background, #007acc22);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    background: var(--vscode-progressBar-background, #007acc);
    transition: width 0.2s;
    border-radius: 2px;
  }
  .progress-text {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .stats {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 0;
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border, #ffffff11);
  }

  .results { display: flex; flex-direction: column; gap: 4px; }

  .result-item {
    background: var(--vscode-list-inactiveSelectionBackground, #ffffff0a);
    border-radius: 3px;
    padding: 7px 8px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 0.1s;
  }
  .result-item:hover {
    background: var(--vscode-list-hoverBackground);
    border-left-color: var(--vscode-focusBorder);
  }

  .result-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .result-file {
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 80%;
  }
  .result-score {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 1px 5px;
    border-radius: 10px;
    flex-shrink: 0;
  }
  .result-line {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 3px;
  }
  .result-excerpt {
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-editor-foreground);
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    max-height: 3.6em;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .empty-state {
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    padding: 24px 8px;
  }
</style>
</head>
<body>
<div>
  <label for="modelSelect">Embedding model</label>
  <select id="modelSelect">
    ${modelOptions}
  </select>
</div>

<div class="search-row">
  <input type="text" id="searchInput" placeholder="Search your codebase…" autocomplete="off" spellcheck="false">
  <button id="searchBtn">Search</button>
</div>

<div class="action-row">
  <button id="indexBtn" class="secondary">⚡ Index Workspace</button>
  <button id="clearBtn" class="secondary" title="Clear index">✕</button>
</div>

<div class="progress-wrap" id="progressWrap">
  <div class="progress-bar-track">
    <div class="progress-bar-fill" id="progressFill" style="width:0%"></div>
  </div>
  <div class="progress-text" id="progressText">Preparing…</div>
</div>

<div class="stats" id="stats" style="display:none"></div>

<div class="results" id="results">
  <div class="empty-state">Search or index your workspace to get started.</div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  const modelSelect = document.getElementById('modelSelect');
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const indexBtn = document.getElementById('indexBtn');
  const clearBtn = document.getElementById('clearBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const statsEl = document.getElementById('stats');
  const resultsEl = document.getElementById('results');

  function setProgress(visible, message, percent) {
    if (visible) {
      progressWrap.classList.add('visible');
      progressText.textContent = message || '';
      progressFill.style.width = (percent ?? 0) + '%';
    } else {
      progressWrap.classList.remove('visible');
    }
  }

  function setStats(stats) {
    if (stats) {
      statsEl.style.display = '';
      statsEl.textContent =
        stats.totalFiles + ' files · ' +
        stats.totalChunks + ' chunks · ' +
        (stats.model ? stats.model.split('/').pop() : 'no model');
    } else {
      statsEl.style.display = 'none';
    }
  }

  function renderResults(results) {
    if (!results || results.length === 0) {
      resultsEl.innerHTML = '<div class="empty-state">No results found.</div>';
      return;
    }

    resultsEl.innerHTML = results.map((r, i) => {
      const score = Math.round(r.score * 100);
      const excerpt = r.content
        .split('\\n')
        .slice(0, 4)
        .join('\\n')
        .slice(0, 300);
      return \`
        <div class="result-item" data-index="\${i}">
          <div class="result-header">
            <span class="result-file" title="\${escHtml(r.filePath)}">\${escHtml(r.relativePath)}</span>
            <span class="result-score">\${score}%</span>
          </div>
          <div class="result-line">line \${r.startLine + 1}–\${r.endLine + 1}</div>
          <div class="result-excerpt">\${escHtml(excerpt)}</div>
        </div>\`;
    }).join('');

    resultsEl.querySelectorAll('.result-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-index'));
        const r = results[idx];
        vscode.postMessage({ type: 'openFile', filePath: r.filePath, line: r.startLine });
      });
    });
  }

  function escHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Read persisted model selection
  const state = vscode.getState() || {};
  if (state.model) {
    modelSelect.value = state.model;
  }

  modelSelect.addEventListener('change', () => {
    vscode.setState({ ...vscode.getState(), model: modelSelect.value });
  });

  searchBtn.addEventListener('click', () => {
    const query = searchInput.value.trim();
    if (query) vscode.postMessage({ type: 'search', query });
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const query = searchInput.value.trim();
      if (query) vscode.postMessage({ type: 'search', query });
    }
  });

  indexBtn.addEventListener('click', () => {
    indexBtn.disabled = true;
    vscode.postMessage({ type: 'indexAll' });
  });

  clearBtn.addEventListener('click', () => {
    if (confirm('Clear the entire search index?')) {
      vscode.postMessage({ type: 'clearIndex' });
    }
  });

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'indexProgress':
        setProgress(true, data.message, data.percent);
        break;
      case 'indexComplete':
        setProgress(false);
        indexBtn.disabled = false;
        setStats(data.stats);
        break;
      case 'stats':
        setStats(data.stats);
        break;
      case 'searchResults':
        renderResults(data.results);
        break;
      case 'error':
        setProgress(false);
        indexBtn.disabled = false;
        resultsEl.innerHTML =
          '<div class="empty-state" style="color:var(--vscode-errorForeground)">' +
          escHtml(data.message) + '</div>';
        break;
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
