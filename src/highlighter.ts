import * as vscode from 'vscode';
import { ColorStore } from './colors';
import { Recompiler } from './compile';
import { rootFileOf, checkPreamble, detectEngine, readText, supportsNotes } from './latex';
import { buildWrap, evidAt, evidOpen, findEvids, unwrapAll, EvidMatch } from './parser';
import { EvidColor, displayName, noteArg } from './colorsfile';
import { cfg } from './config';
import { Tracked } from './repair';

export type Mode = 'toggle' | 'color' | 'remove';

export interface Target { from: number; to: number; }

export interface ApplyResult { added: number; removed: number; recolored: number; emptyMiss: boolean; }

export class Highlighter {
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
    for (const e of edits) {
      if (e.start < lastEnd) { continue; }
      we.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
      // ricorda le nuove evidenziazioni: se rompono la compilazione si annullano
      if (e.wrap) { tracked.push({ file: doc.uri.fsPath, inserted: e.text, original: text.slice(e.start, e.end), offset: e.start + delta }); }
      delta += e.text.length - (e.end - e.start);
      lastEnd = e.end;
    }
    if (!await vscode.workspace.applyEdit(we)) { return { added: 0, removed: 0, recolored: 0, emptyMiss: false }; }
    this.recompiler.track(root, tracked);

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
    return vscode.workspace.applyEdit(we);
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
