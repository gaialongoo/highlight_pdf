import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Highlighter } from './highlighter';
import { scanProject } from './project';
import { summaryTex, summaryMarkdown, Order } from './summary';
import { readText } from './latex';
import { cfg } from './config';

async function saveTex() {
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty && /\.tex$/i.test(d.fileName)) { await d.save(); }
  }
}

function titleOf(rootText: string, rootFile: string): string {
  const m = /\\title\s*\{([^{}]*)\}/.exec(rootText);
  return m ? m[1].trim() : path.basename(rootFile, '.tex');
}

async function openPdf(file: string, viewType: string) {
  const c = await vscode.window.showInformationMessage(`Creato ${path.basename(file)}.`, 'Apri qui', 'Apri con il lettore PDF');
  if (c === 'Apri qui') {
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), viewType, vscode.ViewColumn.Beside);
  } else if (c === 'Apri con il lettore PDF') {
    await vscode.env.openExternal(vscode.Uri.file(file));
  }
}

/** C. Riassunto di tutte le evidenziazioni, in PDF (stesso preambolo) o Markdown. */
export async function generateSummary(hl: Highlighter, rootFile: string, viewType: string) {
  const pick = await vscode.window.showQuickPick([
    { label: '$(file-pdf) PDF, per sezione', description: 'come negli appunti', fmt: 'pdf', order: 'sezione' as Order },
    { label: '$(file-pdf) PDF, per colore', description: 'raggruppato per categoria', fmt: 'pdf', order: 'colore' as Order },
    { label: '$(markdown) Markdown, per sezione', fmt: 'md', order: 'sezione' as Order },
    { label: '$(markdown) Markdown, per colore', fmt: 'md', order: 'colore' as Order },
  ], { title: 'Genera riassunto delle evidenziazioni' });
  if (!pick) { return; }
  await saveTex();
  const rootText = await readText(rootFile);
  const items = await scanProject(rootFile);
  if (!items.length) { vscode.window.showInformationMessage('Non ci sono evidenziazioni da riassumere.'); return; }
  const opts = {
    order: pick.order, cmd: cfg().comando, title: titleOf(rootText, rootFile),
    colors: hl.store.all(rootFile), legend: hl.store.legend(),
  };
  const base = path.join(path.dirname(rootFile), path.basename(rootFile, '.tex') + '-riassunto');
  if (pick.fmt === 'md') {
    fs.writeFileSync(base + '.md', summaryMarkdown(items, opts), 'utf8');
    const doc = await vscode.workspace.openTextDocument(base + '.md');
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    return;
  }
  // il riassunto deve vedere le \definecolor e la legenda
  await hl.store.writeColorsFile(rootFile, []);
  fs.writeFileSync(base + '.tex', summaryTex(rootText, items, opts), 'utf8');
  const ok = await hl.recompiler.compileTex(rootFile, { texFile: base + '.tex', title: 'Compilo il riassunto…' });
  if (ok || fs.existsSync(base + '.pdf')) { await openPdf(base + '.pdf', viewType); }
}

/** E. Copia del PDF senza evidenziazioni né note (i sorgenti non cambiano). */
export async function compileClean(hl: Highlighter, rootFile: string, viewType: string) {
  await saveTex();
  const job = path.basename(rootFile, '.tex') + '-pulito';
  const ok = await hl.recompiler.compileTex(rootFile, {
    jobname: job, prefix: '\\def\\evidpulito{}', title: 'Compilo il PDF pulito…',
  });
  const pdf = path.join(path.dirname(rootFile), job + '.pdf');
  if (ok || fs.existsSync(pdf)) { await openPdf(pdf, viewType); }
}
