import * as vscode from 'vscode';
import { ColorStore } from './colors';
import { Recompiler } from './compile';
import { rootFileOf, checkPreamble, detectEngine, readText, supportsNotes } from './latex';
import { buildWrap, evidAt, evidOpen, findEvids, unwrapAll, EvidMatch } from './parser';
import { EvidColor, displayName, noteArg } from './colorsfile';
import { cfg } from './config';
import { Tracked } from './repair';
import { History, Change, plan, afterApply } from './history';

export type Mode = 'toggle' | 'color' | 'remove';

export interface Target { from: number; to: number; }

export interface ApplyResult { added: number; removed: number; recolored: number; emptyMiss: boolean; }

export interface HistoryState { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string; }

export class Highlighter {
  /** annulla / ripeti delle modifiche fatte dall'estensione */
  readonly history = new History();
  private readonly historyEmitter = new vscode.EventEmitter<HistoryState>();
  readonly onDidChangeHistory = this.historyEmitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly store: ColorStore,
    readonly recompiler: Recompiler,
  ) { }

  /**
   * Applica l'evidenziazione agli intervalli (offset) del documento.
   * - toggle: intervallo libero → evidenzia; dentro un \evid → lo toglie
   * - color:  intervallo libero → evidenzia; dentro un \evid → cambia colore
   * - remove: dentro un \evid → lo toglie; intervallo che contiene \evid → li toglie
   */
  async apply(doc: vscode.TextDocument, targets: Target[], color: EvidColor, mode: Mode,
    opts: { quiet?: boolean } = {}): Promise<ApplyResult> {
    const text = doc.getText();
    const { comando, colorePredefinito } = cfg();
    const root = rootFileOf(doc);
    const splitMath = detectEngine(await readText(root)) === 'pdflatex';
    const evids = findEvids(text, comando);
    const colorArg = color.name === colorePredefinito ? undefined : color.name;

    interface Edit { start: number; end: number; text: string; wrap?: boolean; }
    const edits: Edit[] = [];
    const res: ApplyResult = { added: 0, removed: 0, recolored: 0, emptyMiss: false };

    for (const { from, to } of targets) {
      const inside = evidAt(evids, from, to);
      if (inside) {
        if (mode === 'color') {
          edits.push(this.recolorEdit(inside, comando, colorArg));
          res.recolored++;
        } else {
          edits.push({ start: inside.start, end: inside.end, text: text.slice(inside.contentStart, inside.contentEnd) });
          res.removed++;
        }
        continue;
      }
      if (from === to) { res.emptyMiss = true; continue; }
      if (mode === 'remove') {
        const strip = evids.filter(e => e.start >= from && e.end <= to);
        if (!strip.length) { continue; }
        edits.push({ start: from, end: to, text: unwrapAll(text.slice(from, to), comando) });
        res.removed += strip.length;
        continue;
      }
      const w = buildWrap(text, from, to, { cmd: comando, color: colorArg, splitMath });
      if (!w) { continue; }
      edits.push({ start: w.start, end: w.end, text: w.text, wrap: true });
      res.added += w.count;
    }

    if (edits.length === 0) {
      if (res.emptyMiss && !opts.quiet) {
        vscode.window.setStatusBarMessage(mode === 'remove'
          ? '$(info) Il cursore non è dentro un\'evidenziazione'
          : '$(info) Seleziona del testo da evidenziare', 3000);
      }
      return res;
    }

    // niente modifiche sovrapposte
    edits.sort((a, b) => a.start - b.start);
    const we = new vscode.WorkspaceEdit();
    let lastEnd = -1;
    let delta = 0;
    const tracked: Tracked[] = [];
    const changes: Change[] = [];
    for (const e of edits) {
      if (e.start < lastEnd) { continue; }
      we.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
      // ricorda le nuove evidenziazioni: se rompono la compilazione si annullano
      if (e.wrap) { tracked.push({ file: doc.uri.fsPath, inserted: e.text, original: text.slice(e.start, e.end), offset: e.start + delta }); }
      changes.push({ file: doc.uri.fsPath, at: e.start + delta, before: text.slice(e.start, e.end), after: e.text });
      delta += e.text.length - (e.end - e.start);
      lastEnd = e.end;
    }
    if (!await vscode.workspace.applyEdit(we)) { return { added: 0, removed: 0, recolored: 0, emptyMiss: false }; }
    this.recompiler.track(root, tracked);
    this.record(res.added ? 'evidenziazione' : res.recolored ? 'cambio colore' : 'rimozione', root, changes);

    if (res.added || res.recolored) {
      await this.store.addRecent(color);
      const needed = [color];
      const def = this.store.byName(colorePredefinito, root);
      if (def && def.name !== color.name) { needed.push(def); }
      await this.store.writeColorsFile(root, needed);
      void checkPreamble(this.ctx, root);
    }
    const msg = [
      res.added ? `${res.added} evidenziat${res.added === 1 ? 'a' : 'e'} in ${displayName(color)}` : '',
      res.recolored ? `${res.recolored} ricolorat${res.recolored === 1 ? 'a' : 'e'}` : '',
      res.removed ? `${res.removed} rimoss${res.removed === 1 ? 'a' : 'e'}` : '',
    ].filter(Boolean).join(', ');
    if (msg) { vscode.window.setStatusBarMessage(`$(check) ${msg}`, 2500); }
    this.recompiler.notify(root, res.added + res.recolored + res.removed);
    return res;
  }

  /** Cambia colore a uno specifico \evid. */
  async recolor(doc: vscode.TextDocument, e: EvidMatch, color: EvidColor) {
    return this.apply(doc, [{ from: e.contentStart, to: e.contentStart }], color, 'color');
  }

  /** Toglie uno specifico \evid. */
  async remove(doc: vscode.TextDocument, e: EvidMatch) {
    return this.apply(doc, [{ from: e.contentStart, to: e.contentStart }], this.store.active, 'remove');
  }

  /**
   * Chiede il testo della nota (precompilato) e la scrive nell'\evid:
   * \evid[colore][nota]{testo}. Vuoto = toglie la nota.
   */
  async editNote(doc: vscode.TextDocument, e: EvidMatch): Promise<boolean> {
    const { comando, colorePredefinito } = cfg();
    const root = rootFileOf(doc);
    // la definizione nel preambolo deve supportare il secondo argomento
    await checkPreamble(this.ctx, root);
    if (!supportsNotes(await readText(root))) {
      const c = await vscode.window.showWarningMessage(
        `Il preambolo definisce \\${comando} senza supporto per le note. Inserisco la definizione dell'estensione?`,
        'Inserisci', 'Annulla');
      if (c !== 'Inserisci') { return false; }
      await checkPreamble(this.ctx, root, true);
      if (!supportsNotes(await readText(root))) {
        vscode.window.showErrorMessage(`Non riesco ad aggiornare la definizione di \\${comando}: modificala a mano (vedi README).`);
        return false;
      }
    }
    const current = e.note?.replace(/^\{([\s\S]*)\}$/, '$1') ?? '';
    const v = await vscode.window.showInputBox({
      title: e.note ? 'Modifica nota' : 'Aggiungi nota',
      prompt: 'Testo della nota (puoi usare LaTeX, es. $x^2$). Vuoto = togli la nota.',
      value: current,
    });
    if (v === undefined) { return false; }
    const ok = await this.writeNote(doc, e, v);
    if (ok) {
      vscode.window.setStatusBarMessage(v.trim() ? '$(note) Nota salvata' : '$(note) Nota tolta', 2500);
      this.recompiler.notify(root, 1);
    }
    return ok;
  }

  /** Scrive (o toglie, se vuota) la nota di un \evid senza chiedere niente. */
  async writeNote(doc: vscode.TextDocument, e: EvidMatch, note: string): Promise<boolean> {
    const { comando, colorePredefinito } = cfg();
    // l'offset può essere cambiato nel frattempo: ritrova l'\evid
    const fresh = evidAt(findEvids(doc.getText(), comando), e.contentStart, e.contentStart) ?? e;
    const color = fresh.color || colorePredefinito;
    const header = note.trim()
      ? `\\${comando}[${color}][${noteArg(note)}]{`
      : evidOpen({ cmd: comando, color: color === colorePredefinito ? undefined : color });
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, new vscode.Range(doc.positionAt(fresh.start), doc.positionAt(fresh.headerEnd)), header);
    const before = doc.getText().slice(fresh.start, fresh.headerEnd);
    const ok = await vscode.workspace.applyEdit(we);
    if (ok) { this.record('nota', rootFileOf(doc), [{ file: doc.uri.fsPath, at: fresh.start, before, after: header }]); }
    return ok;
  }

  // -------------------------------------------------------------------------
  // Annulla / ripeti
  // -------------------------------------------------------------------------

  private record(label: string, root: string, changes: Change[]) {
    this.history.push({ label, root, changes: changes.filter(c => c.before !== c.after) });
    this.historyEmitter.fire(this.historyState());
  }

  historyState(): HistoryState {
    const u = this.history.peekUndo(), r = this.history.peekRedo();
    return { canUndo: !!u, canRedo: !!r, undoLabel: u?.label, redoLabel: r?.label };
  }

  /** Annulla (o ripete) l'ultima operazione. Restituisce un messaggio per l'utente. */
  async step(undo: boolean): Promise<string> {
    const e = undo ? this.history.peekUndo() : this.history.peekRedo();
    if (!e) { return undo ? 'Niente da annullare' : 'Niente da ripetere'; }
    const docs = new Map<string, vscode.TextDocument>();
    const texts = new Map<string, string>();
    for (const c of e.changes) {
      if (docs.has(c.file)) { continue; }
      try { const d = await vscode.workspace.openTextDocument(c.file); docs.set(c.file, d); texts.set(c.file, d.getText()); } catch { /* sparito */ }
    }
    const reps = plan(e, texts, undo);
    if (!reps) {
      if (undo) { this.history.dropUndo(); } else { this.history.dropRedo(); }
      this.historyEmitter.fire(this.historyState());
      return `Non posso ${undo ? 'annullare' : 'ripetere'} "${e.label}": quel punto del .tex è stato modificato a mano.`;
    }
    const we = new vscode.WorkspaceEdit();
    for (const r of reps) {
      const d = docs.get(r.change.file)!;
      we.replace(d.uri, new vscode.Range(d.positionAt(r.start), d.positionAt(r.end)), r.text);
    }
    if (!await vscode.workspace.applyEdit(we)) { return 'Modifica non riuscita'; }
    if (undo) { this.history.undone(afterApply(reps)); } else { this.history.redone(afterApply(reps)); }
    this.historyEmitter.fire(this.historyState());
    this.recompiler.notify(e.root, 1);
    return `${undo ? 'Annullato' : 'Ripetuto'}: ${e.label}`;
  }

  /** L'\evid che contiene l'offset (dopo una modifica). */
  evidAtOffset(doc: vscode.TextDocument, offset: number): EvidMatch | undefined {
    return evidAt(findEvids(doc.getText(), cfg().comando), offset, offset);
  }

  private recolorEdit(e: EvidMatch, cmd: string, colorArg: string | undefined) {
    // con la nota il colore va scritto sempre: \evid[][nota] darebbe un colore vuoto
    const color = colorArg ?? (e.note !== undefined ? cfg().colorePredefinito : undefined);
    return { start: e.start, end: e.headerEnd, text: evidOpen({ cmd, color, note: e.note }) };
  }
}
