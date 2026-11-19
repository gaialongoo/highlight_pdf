import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { Highlighter } from './highlighter';
import { quadsFromPoints, textInQuads, nearestColor, TItem } from './annotext';
import { locate } from './match';
import { syncEdit, synctexAvailable } from './synctex';
import { PASTELLI, displayName } from './colorsfile';
import { checkPreamble, rootFileOf } from './latex';

// import() vero anche se TypeScript compila in CommonJS
const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

interface Found { page: number; text: string; color: [number, number, number]; note?: string; quads: ReturnType<typeof quadsFromPoints>; pageH: number; }

/** Legge le annotazioni "Highlight" di un PDF con pdf.js (build per Node). */
async function readHighlights(ctx: vscode.ExtensionContext, pdfFile: string): Promise<Found[]> {
  const dir = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'pdfjs-node').fsPath;
  const pdfjs = await dynImport(pathToFileURL(path.join(dir, 'pdf.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, 'pdf.worker.mjs')).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfFile)), isEvalSupported: false, verbosity: 0 }).promise;
  const out: Found[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const anns = (await page.getAnnotations()).filter((a: any) => a.subtype === 'Highlight' && a.quadPoints);
    if (!anns.length) { continue; }
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: TItem[] = tc.items
      .filter((i: any) => typeof i.str === 'string')
      .map((i: any) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) }));
    for (const a of anns) {
      const quads = quadsFromPoints(a.quadPoints);
      const text = textInQuads(items, quads);
      if (!text) { continue; }
      const c = a.color ? [a.color[0], a.color[1], a.color[2]] as [number, number, number] : [255, 255, 0] as [number, number, number];
      const note = (a.contentsObj?.str || a.contents || '').trim() || undefined;
      out.push({ page: p, text, color: c, note, quads, pageH: vp.height });
    }
  }
  await doc.destroy();
  return out;
}

/**
 * Fase 3: riporta nel .tex le evidenziazioni fatte con altri programmi
 * (Edge, Acrobat…) su una copia del PDF.
 */
export async function importAnnotations(ctx: vscode.ExtensionContext, hl: Highlighter, rootHint?: string) {
  const picked = await vscode.window.showOpenDialog({
    title: 'PDF evidenziato con un altro programma (Edge, Acrobat…)',
    filters: { PDF: ['pdf'] }, canSelectMany: false,
  });
  if (!picked?.[0]) { return; }
  const annotated = picked[0].fsPath;

  let root = rootHint;
  const ed = vscode.window.activeTextEditor;
  if (!root && ed?.document.languageId === 'latex') { root = rootFileOf(ed.document); }
  if (!root) {
    const t = await vscode.window.showOpenDialog({ title: 'File .tex degli appunti', filters: { LaTeX: ['tex'] }, canSelectMany: false });
    root = t?.[0]?.fsPath;
  }
  if (!root) { return; }
  // per SyncTeX serve il PDF compilato dagli appunti (stessa impaginazione)
  const compiled = root.replace(/\.tex$/i, '.pdf');
  const useSync = fs.existsSync(compiled) && synctexAvailable(compiled);

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Importo le evidenziazioni', cancellable: true },
    async (progress, token) => {
      progress.report({ message: 'leggo il PDF…' });
      let found: Found[];
      try { found = await readHighlights(ctx, annotated); }
      catch (e) { vscode.window.showErrorMessage(`Non riesco a leggere il PDF: ${(e as Error).message}`); return; }
      if (!found.length) { vscode.window.showInformationMessage('Nel PDF non ci sono evidenziazioni (annotazioni "Highlight").'); return; }

      const doc = await vscode.workspace.openTextDocument(root!);
      const palette = [...PASTELLI, ...hl.store.preferiti];
      const missed: Found[] = [];
      let ok = 0, approx = 0;
      for (let i = 0; i < found.length; i++) {
        if (token.isCancellationRequested) { break; }
        const f = found[i];
        progress.report({ message: `${i + 1}/${found.length}`, increment: 100 / found.length });
        const lines: number[] = [];
        if (useSync) {
          const first = f.quads[0], last = f.quads[f.quads.length - 1];
          for (const [x, y] of [[first.x0 + 1, f.pageH - (first.y0 + first.y1) / 2], [last.x1 - 1, f.pageH - (last.y0 + last.y1) / 2]]) {
            const r = await syncEdit(compiled, f.page, x, y);
            if (r && path.resolve(r.file).toLowerCase() === path.resolve(root!).toLowerCase()) { lines.push(r.line); }
          }
        }
        const r = locate(doc.getText(), f.text, lines, 8);
        if (!r) { missed.push(f); continue; }
        const color = nearestColor(f.color, palette);
        const res = await hl.apply(doc, [{ from: r.start, to: r.end }], color, 'color', { quiet: true });
        if (res.added + res.recolored === 0) { missed.push(f); continue; }
        ok++;
        if (!r.exact) { approx++; }
        if (f.note) {
          const e = hl.evidAtOffset(doc, r.start);
          if (e) { await hl.writeNote(doc, e, f.note); }
        }
      }
      if (found.some(f => f.note)) { await checkPreamble(ctx, root!); }

      // report
      const lines = [
        `# Importazione evidenziazioni`, '',
        `- PDF annotato: \`${path.basename(annotated)}\``,
        `- Appunti: \`${path.basename(root!)}\`${useSync ? ' (con SyncTeX)' : ' (senza SyncTeX: ricerca in tutto il file)'}`,
        `- Importate: **${ok}** su ${found.length}${approx ? ` (${approx} con corrispondenza approssimata: controllale)` : ''}`,
        '',
      ];
      if (missed.length) {
        lines.push(`## Non trovate (${missed.length}) — da sistemare a mano`, '');
        for (const m of missed) {
          lines.push(`- pagina ${m.page}, ${displayName(nearestColor(m.color, palette))}: «${m.text}»${m.note ? ` — nota: ${m.note}` : ''}`);
        }
      }
      const rep = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') + '\n' });
      await vscode.window.showTextDocument(rep, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      vscode.window.showInformationMessage(`Importate ${ok} evidenziazioni su ${found.length}${missed.length ? `; ${missed.length} non trovate (vedi report)` : ''}.`);
    });
}
