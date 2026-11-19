/**
 * Rete di sicurezza: se dopo nuove evidenziazioni la compilazione fallisce su
 * una riga toccata da una di esse, quell'evidenziazione va annullata.
 *
 * Nessun import di `vscode`: testabile con Node.
 */
import * as path from 'path';

/** Un'evidenziazione fatta dopo l'ultima compilazione riuscita. */
export interface Tracked {
  /** file .tex modificato */
  file: string;
  /** testo scritto al posto di `original` (es. "\evid{parola}") */
  inserted: string;
  original: string;
  /** offset in cui è stato scritto (può essersi spostato con modifiche successive) */
  offset: number;
}

export interface LogError { file: string; line: number; message: string; }

/** Errori "file.tex:123: messaggio" di un log compilato con -file-line-error. */
export function parseLogErrors(log: string, dir: string): LogError[] {
  const out: LogError[] = [];
  const re = /^(?:\.[\\/])?(.*?\.tex):(\d+): (.*)$/gm;
  for (let m: RegExpExecArray | null; (m = re.exec(log));) {
    out.push({ file: path.resolve(dir, m[1]), line: Number(m[2]), message: m[3].trim() });
  }
  return out;
}

/** Posizione attuale di `inserted` nel testo: l'occorrenza più vicina a `hint`, o -1. */
export function findInserted(text: string, inserted: string, hint: number): number {
  let best = -1;
  for (let i = text.indexOf(inserted); i >= 0; i = text.indexOf(inserted, i + 1)) {
    if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) { best = i; }
  }
  return best;
}

/** Riga (1-based, come nel log) dell'offset. */
export function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) { if (text[i] === '\n') { n++; } }
  return n;
}

/**
 * Quali evidenziazioni sono colpevoli: quelle che occupano la riga di un errore
 * dello stesso file (LaTeX a volte segnala l'errore qualche riga dopo, a fine
 * paragrafo o alla chiusura di un gruppo: si tollerano `slack` righe).
 * `texts` dà il contenuto attuale di ogni file.
 */
export function culprits(tracked: Tracked[], errors: LogError[], texts: Map<string, string>, slack = 3): { item: Tracked; at: number }[] {
  const out: { item: Tracked; at: number }[] = [];
  const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const t of tracked) {
    const text = texts.get(t.file);
    if (text === undefined) { continue; }
    const at = findInserted(text, t.inserted, t.offset);
    if (at < 0) { continue; } // modificata o già tolta a mano
    const first = lineAt(text, at);
    const last = first + (t.inserted.match(/\n/g)?.length ?? 0);
    if (errors.some(e => same(e.file, t.file) && e.line >= first && e.line <= last + slack)) {
      out.push({ item: t, at });
    }
  }
  return out;
}
