/**
 * Annulla / ripeti per le modifiche fatte dall'estensione ai .tex
 * (evidenziazioni, colori, rimozioni, note).
 *
 * Ogni operazione è una lista di sostituzioni: in `file`, alla posizione `at`,
 * c'è `after` dove prima c'era `before`. Annullare = rimettere `before` al posto
 * di `after`; ripetere = il contrario. Le posizioni si ritrovano cercando il
 * testo vicino a `at`, così sopravvivono a modifiche fatte altrove nel file.
 *
 * Nessun import di `vscode`: testabile con Node.
 */

export interface Change { file: string; at: number; before: string; after: string; }
export interface Entry { label: string; root: string; changes: Change[]; }

/** Una sostituzione concreta da applicare al testo attuale. */
export interface Replacement { change: Change; start: number; end: number; text: string; }

function nearest(text: string, needle: string, hint: number): number {
  if (needle === '') { return Math.max(0, Math.min(hint, text.length)); }
  let best = -1;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) { best = i; }
  }
  return best;
}

/**
 * Sostituzioni per annullare (`undo = true`) o ripetere un'operazione sul testo
 * attuale dei file. undefined se qualcosa non si ritrova più (testo cambiato a mano).
 */
export function plan(entry: Entry, texts: Map<string, string>, undo: boolean): Replacement[] | undefined {
  const out: Replacement[] = [];
  for (const c of entry.changes) {
    const text = texts.get(c.file);
    if (text === undefined) { return undefined; }
    const find = undo ? c.after : c.before;
    const start = nearest(text, find, c.at);
    if (start < 0) { return undefined; }
    out.push({ change: c, start, end: start + find.length, text: undo ? c.before : c.after });
  }
  // due sostituzioni dello stesso file non devono sovrapporsi
  const byFile = new Map<string, Replacement[]>();
  out.forEach(r => byFile.set(r.change.file, [...(byFile.get(r.change.file) ?? []), r]));
  for (const rs of byFile.values()) {
    rs.sort((a, b) => a.start - b.start);
    for (let i = 1; i < rs.length; i++) { if (rs[i].start < rs[i - 1].end) { return undefined; } }
  }
  return out;
}

/**
 * Dopo aver applicato `reps`, dove si trova ora ogni testo sostituito
 * (serve per l'operazione inversa).
 */
export function afterApply(reps: Replacement[]): Change[] {
  const byFile = new Map<string, Replacement[]>();
  reps.forEach(r => byFile.set(r.change.file, [...(byFile.get(r.change.file) ?? []), r]));
  const out: Change[] = [];
  for (const rs of byFile.values()) {
    rs.sort((a, b) => a.start - b.start);
    let delta = 0;
    for (const r of rs) {
      out.push({ ...r.change, at: r.start + delta });
      delta += r.text.length - (r.end - r.start);
    }
  }
  return out;
}

/** Applica le sostituzioni a un testo (per i test e per i file non aperti). */
export function applyTo(text: string, reps: Replacement[]): string {
  for (const r of [...reps].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, r.start) + r.text + text.slice(r.end);
  }
  return text;
}

/** Le due pile. */
export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  constructor(private readonly max = 200) { }

  push(e: Entry) {
    if (!e.changes.length) { return; }
    this.undoStack.push(e);
    if (this.undoStack.length > this.max) { this.undoStack.shift(); }
    this.redoStack = [];
  }
  peekUndo() { return this.undoStack[this.undoStack.length - 1]; }
  peekRedo() { return this.redoStack[this.redoStack.length - 1]; }
  /** Sposta in cima all'altra pila, con le posizioni aggiornate. */
  undone(changes: Change[]) { const e = this.undoStack.pop(); if (e) { this.redoStack.push({ ...e, changes }); } }
  redone(changes: Change[]) { const e = this.redoStack.pop(); if (e) { this.undoStack.push({ ...e, changes }); } }
  /** Toglie l'operazione in cima (non più applicabile). */
  dropUndo() { this.undoStack.pop(); }
  dropRedo() { this.redoStack.pop(); }
}
