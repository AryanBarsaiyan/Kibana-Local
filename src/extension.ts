import * as vscode from 'vscode';
import { IndexSource } from './engine/types';
import { KibanaLocalPanel } from './panel';
import { IndexesView } from './sidebar';

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('logscope.indexes', new IndexesView(ctx)),

    vscode.commands.registerCommand('logscope.open', () => KibanaLocalPanel.show(ctx)),

    vscode.commands.registerCommand('logscope.showIndex', (name: string) => KibanaLocalPanel.show(ctx).focusIndex(name)),

    // sidebar item actions (arg is the IndexSource tree element)
    vscode.commands.registerCommand('logscope.removeIndex', (s?: IndexSource) => {
      if (s?.name) void KibanaLocalPanel.removeSaved(ctx, s.name);
    }),
    vscode.commands.registerCommand('logscope.reloadIndex', (s?: IndexSource) => {
      if (!s?.name) return;
      const p = KibanaLocalPanel.show(ctx);
      p.reloadSource(s.name);
      p.focusIndex(s.name);
    }),
    vscode.commands.registerCommand('logscope.revealIndex', (s?: IndexSource) => {
      if (s?.path) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.path));
    }),
    vscode.commands.registerCommand('logscope.openIndexFile', (s?: IndexSource) => {
      if (s?.path && s.kind === 'file') void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(s.path));
    }),
    vscode.commands.registerCommand('logscope.settings', () => KibanaLocalPanel.show(ctx).showSettings()),

    vscode.commands.registerCommand('logscope.addFile', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true, openLabel: 'Add as index' });
      if (!uris) return;
      const p = KibanaLocalPanel.show(ctx);
      for (const u of uris) p.addSource(u.fsPath);
    }),

    vscode.commands.registerCommand('logscope.addFolder', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Add folder as index' });
      if (!uris) return;
      KibanaLocalPanel.show(ctx).addSource(uris[0].fsPath);
    }),

    vscode.commands.registerCommand('logscope.openWith', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const p = KibanaLocalPanel.show(ctx);
      if (target && target.scheme === 'file') p.addSource(target.fsPath);
    }),
  );
}

export function deactivate() {
  KibanaLocalPanel.current?.dispose();
}
