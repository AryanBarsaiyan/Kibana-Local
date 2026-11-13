import * as vscode from 'vscode';
import { IndexSource } from './engine/types';
import { LogScopePanel } from './panel';
import { IndexesView } from './sidebar';

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('logscope.indexes', new IndexesView(ctx)),

    vscode.commands.registerCommand('logscope.open', () => LogScopePanel.show(ctx)),

    vscode.commands.registerCommand('logscope.showIndex', (name: string) => LogScopePanel.show(ctx).focusIndex(name)),

    // sidebar item actions (arg is the IndexSource tree element)
    vscode.commands.registerCommand('logscope.removeIndex', (s?: IndexSource) => {
      if (s?.name) void LogScopePanel.removeSaved(ctx, s.name);
    }),
    vscode.commands.registerCommand('logscope.reloadIndex', (s?: IndexSource) => {
      if (!s?.name) return;
      const p = LogScopePanel.show(ctx);
      p.reloadSource(s.name);
      p.focusIndex(s.name);
    }),
    vscode.commands.registerCommand('logscope.revealIndex', (s?: IndexSource) => {
      if (s?.path) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.path));
    }),
    vscode.commands.registerCommand('logscope.openIndexFile', (s?: IndexSource) => {
      if (s?.path && s.kind === 'file') void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(s.path));
    }),
    vscode.commands.registerCommand('logscope.settings', () => LogScopePanel.show(ctx).showSettings()),

    vscode.commands.registerCommand('logscope.addFile', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true, openLabel: 'Add as index' });
      if (!uris) return;
      const p = LogScopePanel.show(ctx);
      for (const u of uris) p.addSource(u.fsPath);
    }),

    vscode.commands.registerCommand('logscope.addFolder', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Add folder as index' });
      if (!uris) return;
      LogScopePanel.show(ctx).addSource(uris[0].fsPath);
    }),

    vscode.commands.registerCommand('logscope.openWith', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const p = LogScopePanel.show(ctx);
      if (target && target.scheme === 'file') p.addSource(target.fsPath);
    }),
  );
}

export function deactivate() {
  LogScopePanel.current?.dispose();
}
