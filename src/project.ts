import * as path from 'path';
import * as fs from 'fs';
import { readText } from './latex';
import { cfg } from './config';
import { Item, itemsOf, findInputs, sectionChain } from './summary';
import { findHeadings, Heading } from './parser';

/** I file inclusi con \input / \include (ricorsivamente), nell'ordine in cui compaiono. */
export function includedFiles(rootFile: string): string[] {
  const seen = new Set<string>([rootFile.toLowerCase()]);
  const out: string[] = [];
  const visit = (file: string) => {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const inp of findInputs(text)) {
      let child = path.resolve(path.dirname(file), inp.name);
      if (!/\.tex$/i.test(child)) { child += '.tex'; }
      const key = child.toLowerCase();
      if (seen.has(key) || !fs.existsSync(child)) { continue; }
      seen.add(key);
      out.push(child);
      visit(child);
    }
  };
  visit(rootFile);
  return out;
}

/** L'evidenziazione più in fondo nel documento ("dove ero arrivato"), file inclusi compresi. */
export async function lastHighlight(rootFile: string): Promise<Item | undefined> {
  const items = await scanProject(rootFile);
  return items[items.length - 1];
}

/** Anteprima breve del testo di un'evidenziazione, per i messaggi. */
export function preview(it: Item, max = 50): string {
  const t = it.content.replace(/\\[a-zA-Z]+\*?|[{}$]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Tutte le evidenziazioni del progetto, nell'ordine in cui compaiono nel PDF:
 * il file principale più i file inclusi con \input / \include (ricorsivamente).
 */
export async function scanProject(rootFile: string): Promise<Item[]> {
  const { comando, colorePredefinito, fileColori } = cfg();
  const seen = new Set<string>();

  const visit = async (file: string, inherited: Heading[]): Promise<Item[]> => {
    const key = file.toLowerCase();
    if (seen.has(key) || !fs.existsSync(file)) { return []; }
    seen.add(key);
    let text: string;
    try { text = await readText(file); } catch { return []; }
    const own = itemsOf(file, text, comando, colorePredefinito, inherited);
    const headings = findHeadings(text);
    const result: Item[] = [...own];
    for (const inp of findInputs(text)) {
      if (path.basename(inp.name).replace(/\.tex$/i, '') === fileColori) { continue; }
      let child = path.resolve(path.dirname(file), inp.name);
      if (!/\.tex$/i.test(child)) { child += '.tex'; }
      const local = sectionChain(headings, inp.offset);
      const minLocal = local.length ? Math.min(...local.map(h => h.level)) : Infinity;
      const chain = [...inherited.filter(h => h.level < minLocal), ...local];
      const sub = await visit(child, chain);
      // inserisci le voci del file incluso nel punto in cui viene incluso
      const at = result.findIndex(it => it.file === file && it.start > inp.offset);
      result.splice(at < 0 ? result.length : at, 0, ...sub);
    }
    return result;
  };
  return visit(rootFile, []);
}
