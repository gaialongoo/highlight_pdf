import * as vscode from 'vscode';
import { findEvids } from './parser';
import { ColorStore } from './colors';
import { cfg } from './config';
import { displayName } from './colorsfile';
import { rootFileOf } from './latex';

/** Colora nell'editor il testo dentro \evid{} con lo stesso colore del PDF. */
export class Decorator implements vscode.Disposable {
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private marker: vscode.TextEditorDecorationType;
  private unknown: vscode.TextEditorDecorationType;
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly colors: ColorStore) {
    this.marker = vscode.window.createTextEditorDecorationType({ opacity: '0.45' });
    this.unknown = vscode.window.createTextEditorDecorationType({
      border: '1px dashed #999', borderRadius: '2px',
    });
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'latex') { this.schedule(); }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('evid')) { this.resetTypes(); this.refreshAll(); }
      }),
      colors.onDidChange(() => this.refreshAll()),
    );
    this.refreshAll();
  }

  private typeFor(hex: string) {
    let t = this.types.get(hex);
    if (!t) {
      const dark = cfg().testoScuro ? { color: '#1f1f1f' } : {};
      t = vscode.window.createTextEditorDecorationType({
        backgroundColor: '#' + hex,
        borderRadius: '2px',
        dark,
        overviewRulerColor: '#' + hex,
        overviewRulerLane: vscode.OverviewRulerLane.Center,
      });
      this.types.set(hex, t);
    }
    return t;
  }

  private resetTypes() {
    this.types.forEach(t => t.dispose());
    this.types.clear();
  }

  private schedule() {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => this.refreshAll(), 120);
  }

  refreshAll() {
    for (const ed of vscode.window.visibleTextEditors) { this.refresh(ed); }
  }

  refresh(editor: vscode.TextEditor) {
    const doc = editor.document;
    if (doc.languageId !== 'latex') { return; }
    const { comando, colorePredefinito } = cfg();
    const root = rootFileOf(doc);
    this.colors.ensureLoaded(root);
    const evids = findEvids(doc.getText(), comando);

    const byHex = new Map<string, vscode.DecorationOptions[]>();
    const markers: vscode.Range[] = [];
    const unknown: vscode.DecorationOptions[] = [];

    for (const e of evids) {
      const name = e.color || colorePredefinito;
      const c = this.colors.byName(name, root);
      const range = new vscode.Range(doc.positionAt(e.contentStart), doc.positionAt(e.contentEnd));
      markers.push(
        new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.headerEnd)),
        new vscode.Range(doc.positionAt(e.contentEnd), doc.positionAt(e.end)),
      );
      if (!c) {
        const md = new vscode.MarkdownString(`**${name}**: colore non definito in \`${cfg().fileColori}.tex\``);
        unknown.push({ range, hoverMessage: md });
        continue;
      }
      const label = this.colors.label(c);
      const md = new vscode.MarkdownString(
        `$(symbol-color) **${displayName(c)}** · \`#${c.hex}\`` + (label ? ` — *${label}*` : ''), true);
      if (e.note) { md.appendMarkdown(`\n\n$(note) ${e.note}`); }
      const list = byHex.get(c.hex) ?? [];
      list.push({ range, hoverMessage: md });
      byHex.set(c.hex, list);
    }

    for (const hex of byHex.keys()) { this.typeFor(hex); }
    for (const [hex, t] of this.types) { editor.setDecorations(t, byHex.get(hex) ?? []); }
    editor.setDecorations(this.marker, markers);
    editor.setDecorations(this.unknown, unknown);
  }

  dispose() {
    this.resetTypes();
    this.marker.dispose();
    this.unknown.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
