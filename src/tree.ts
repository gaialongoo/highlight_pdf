import * as vscode from 'vscode';
import * as path from 'path';
import { ColorStore } from './colors';
import { scanProject } from './project';
import { Item, plainText } from './summary';
import { displayName, EvidColor } from './colorsfile';
import { rootFileOf } from './latex';

type Group = 'sezione' | 'colore';

export interface GroupNode { kind: 'group'; id: string; label: string; description?: string; color?: EvidColor; children: Node[]; }
export interface ItemNode { kind: 'item'; id: string; item: Item; }
export type Node = GroupNode | ItemNode;

/** Pannello "Evidenziazioni" nella barra laterale. */
export class EvidTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private disposables: vscode.Disposable[] = [];
  private items: Item[] = [];
  private roots: Node[] = [];
  private timer: NodeJS.Timeout | undefined;
  root: string | undefined;
  filterColors: Set<string> | undefined;
  search = '';
  view!: vscode.TreeView<Node>;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly store: ColorStore) {
    const ed = vscode.window.activeTextEditor;
    if (ed?.document.languageId === 'latex') { this.root = rootFileOf(ed.document); }
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(e => {
        if (e?.document.languageId === 'latex') { this.setRoot(rootFileOf(e.document)); }
      }),
      vscode.workspace.onDidChangeTextDocument(e => { if (/\.tex$/i.test(e.document.fileName)) { this.schedule(); } }),
      vscode.workspace.onDidSaveTextDocument(d => { if (/\.tex$/i.test(d.fileName)) { this.schedule(50); } }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('evid')) { this.schedule(50); } }),
      store.onDidChange(() => this.schedule(50)),
      this.emitter,
    );
    void vscode.commands.executeCommand('setContext', 'evid.treeGroup', this.group);
    this.schedule(10);
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }

  get group(): Group { return this.ctx.workspaceState.get<Group>('evid.treeGroup', 'sezione'); }
  async setGroup(g: Group) {
    await this.ctx.workspaceState.update('evid.treeGroup', g);
    await vscode.commands.executeCommand('setContext', 'evid.treeGroup', g);
    this.rebuild();
  }

  setRoot(root: string) {
    if (root !== this.root) { this.root = root; this.schedule(10); }
  }

  schedule(ms = 500) {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => void this.refresh(), ms);
  }

  async refresh() {
    this.items = this.root ? await scanProject(this.root) : [];
    this.rebuild();
  }

  get allItems() { return this.items; }

  private rebuild() {
    const q = this.search.toLowerCase();
    const shown = this.items.filter(it =>
      (!this.filterColors || this.filterColors.has(it.color))
      && (!q || plainText(it.content).toLowerCase().includes(q) || (it.note ?? '').toLowerCase().includes(q)));
    this.roots = this.group === 'colore' ? this.byColor(shown) : this.bySection(shown);
    if (this.view) {
      const parts: string[] = [];
      if (this.root) { parts.push(path.basename(this.root)); }
      parts.push(`${shown.length}${shown.length !== this.items.length ? '/' + this.items.length : ''}`);
      if (this.filterColors) { parts.push('filtro colori'); }
      if (q) { parts.push(`"${this.search}"`); }
      this.view.description = parts.join(' · ');
      this.view.message = !this.root
        ? 'Apri un file .tex (o un PDF con l\'Evidenziatore) per vedere le evidenziazioni.'
        : this.items.length === 0 ? 'Nessuna evidenziazione: seleziona del testo e premi Evidenzia.' : undefined;
    }
    this.emitter.fire(undefined);
  }

  private itemNode(it: Item): ItemNode {
    return { kind: 'item', id: `${it.file}#${it.start}`, item: it };
  }

  private byColor(items: Item[]): Node[] {
    const order: string[] = [];
    const all = this.store.all(this.root);
    all.forEach(c => { if (items.some(i => i.color === c.name)) { order.push(c.name); } });
    items.forEach(i => { if (!order.includes(i.color)) { order.push(i.color); } });
    return order.map(name => {
      const c = this.store.byName(name, this.root);
      const children = items.filter(i => i.color === name).map(i => this.itemNode(i));
      return {
        kind: 'group', id: 'c:' + name, color: c, children,
        label: c ? displayName(c) : name,
        description: [this.store.label(name), `${children.length}`].filter(Boolean).join(' · '),
      } as GroupNode;
    });
  }

  private bySection(items: Item[]): Node[] {
    const top: Node[] = [];
    const index = new Map<string, GroupNode>();
    for (const it of items) {
      let siblings = top;
      let key = '';
      for (const h of it.sections) {
        key += `|${h.level}:${h.offset}:${h.title}`;
        let g = index.get(key);
        if (!g) {
          g = { kind: 'group', id: 's' + key, label: plainText(h.title), children: [] };
          index.set(key, g);
          siblings.push(g);
        }
        siblings = g.children;
      }
      siblings.push(this.itemNode(it));
    }
    const count = (n: Node): number => n.kind === 'item' ? 1 : n.children.reduce((s, c) => s + count(c), 0);
    index.forEach(g => { g.description = String(count(g)); });
    return top;
  }

  getChildren(n?: Node): Node[] { return n ? (n.kind === 'group' ? n.children : []) : this.roots; }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'group') {
      const t = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      t.id = n.id;
      t.description = n.description;
      t.iconPath = n.color ? this.store.swatchUri(n.color) : new vscode.ThemeIcon('symbol-namespace');
      t.contextValue = 'evidGroup';
      return t;
    }
    const it = n.item;
    const c = this.store.byName(it.color, this.root);
    const text = plainText(it.content);
    const t = new vscode.TreeItem(text.length > 80 ? text.slice(0, 78) + '…' : text || '(vuota)');
    t.id = n.id;
    const label = this.store.label(it.color);
    t.description = [it.note ? '✎' : '', label ?? (c ? displayName(c) : it.color)].filter(Boolean).join(' ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${c ? displayName(c) : it.color}**${label ? ` — *${label}*` : ''}\n\n`);
    md.appendText(text);
    if (it.note) { md.appendMarkdown('\n\n---\n\n$(note) '); md.appendText(it.note); }
    md.appendMarkdown(`\n\n_${path.basename(it.file)}:${it.line + 1}_`);
    md.supportThemeIcons = true;
    t.tooltip = md;
    t.iconPath = c ? this.store.swatchUri(c) : new vscode.ThemeIcon('circle-outline');
    t.contextValue = it.note ? 'evidItemNote' : 'evidItem';
    t.command = { command: 'evid.tree.open', title: 'Apri', arguments: [n] };
    return t;
  }

  getParent(): undefined { return undefined; }

  async pickFilter() {
    const present = [...new Set(this.items.map(i => i.color))];
    const picks = present.map(name => {
      const c = this.store.byName(name, this.root);
      return {
        label: c ? displayName(c) : name,
        description: this.store.label(name),
        iconPath: c ? this.store.swatchUri(c) : undefined,
        picked: !this.filterColors || this.filterColors.has(name),
        name,
      };
    });
    const sel = await vscode.window.showQuickPick(picks, { canPickMany: true, title: 'Mostra solo questi colori' });
    if (!sel) { return; }
    this.filterColors = sel.length === picks.length ? undefined : new Set(sel.map(s => s.name));
    this.rebuild();
  }

  async pickSearch() {
    const v = await vscode.window.showInputBox({ title: 'Cerca nelle evidenziazioni', value: this.search, prompt: 'Testo da cercare (anche nelle note). Vuoto = tutte.' });
    if (v === undefined) { return; }
    this.search = v.trim();
    this.rebuild();
  }

  clearFilter() {
    this.filterColors = undefined;
    this.search = '';
    this.rebuild();
  }
}
