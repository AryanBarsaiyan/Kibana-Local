import * as vscode from 'vscode';
import { IndexSource } from './engine/types';
import { KibanaLocalPanel, savedSources } from './panel';

/** Activity-bar view: lists saved indexes; welcome content shows when there are none. */
export class IndexesView implements vscode.TreeDataProvider<IndexSource> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(this.changed, KibanaLocalPanel.onDidChangeSources(() => this.changed.fire()));
  }

  getChildren(): IndexSource[] {
    return savedSources(this.ctx.workspaceState);
  }

  getTreeItem(s: IndexSource): vscode.TreeItem {
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.description = s.path;
    item.tooltip = `${s.kind === 'folder' ? 'Folder' : 'File'} index\n${s.path}`;
    item.iconPath = new vscode.ThemeIcon(s.kind === 'folder' ? 'folder' : 'file');
    item.command = { command: 'logscope.showIndex', title: 'Open Index', arguments: [s.name] };
    item.accessibilityInformation = { label: `${s.name}, ${s.kind} index, ${s.path}` };
    item.contextValue =s.kind === 'folder' ? 'logscopeIndexFolder' : 'logscopeIndexFile';
    return item;
  }
}
