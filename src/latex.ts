import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { analyzePreamble } from './parser';
import { Engine, preambleBlock, upgradePreamble } from './colorsfile';
import { cfg } from './config';

/** Percorso del file principale: "% !TEX root" se c'è, altrimenti il file stesso. */
export function rootFileOf(doc: vscode.TextDocument): string {
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 30), 0));
  const m = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(head);
  if (m) {
    let p = path.resolve(path.dirname(doc.uri.fsPath), m[1]);
    if (!/\.tex$/i.test(p)) { p += '.tex'; }
    if (fs.existsSync(p)) { return p; }
  }
  return doc.uri.fsPath;
}

export async function readText(file: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === file.toLowerCase());
  if (open) { return open.getText(); }
  return fs.promises.readFile(file, 'utf8');
}

/** Il preambolo supporta \evid[colore][nota]{testo}? */
export function supportsNotes(rootText: string): boolean {
  return /\\NewDocumentCommand\s*\{?\\[A-Za-z]+\}?\s*\{\s*O\{[^}]*\}\s*o\s*m\s*\}/.test(rootText);
}

/** pdfLaTeX o LuaLaTeX? */
export function detectEngine(rootText: string): Engine {
  const set = cfg().compilatore;
  if (set !== 'auto') { return set; }
  const info = analyzePreamble(rootText, cfg().comando, cfg().fileColori);
  if (info.magicProgram) { return /lua/i.test(info.magicProgram) ? 'lualatex' : 'pdflatex'; }
  if (/\\highLight\b/.test(rootText.slice(0, info.beginDocument < 0 ? undefined : info.beginDocument))) { return 'lualatex'; }
  if (info.usesLuaPackages) { return 'lualatex'; }
  // ricetta predefinita di LaTeX Workshop
  const lw = vscode.workspace.getConfiguration('latex-workshop');
  const recipes = lw.get<{ name: string; tools: string[] }[]>('latex.recipes', []);
  const tools = lw.get<{ name: string; command: string; args?: string[] }[]>('latex.tools', []);
  const def = lw.get<string>('latex.recipe.default', 'first');
  const recipe = def === 'first' || def === 'lastUsed' ? recipes[0] : recipes.find(r => r.name === def);
  if (recipe) {
    const used = recipe.tools.map(n => tools.find(t => t.name === n)).filter(Boolean);
    const blob = used.map(t => `${t!.command} ${(t!.args ?? []).join(' ')}`).join(' ');
    if (/lualatex/i.test(blob)) { return 'lualatex'; }
  }
  return 'pdflatex';
}

const asked = new Set<string>();

/**
 * Se il preambolo non definisce \evid o non include evid-colori, propone di
 * aggiungerlo. Restituisce l'engine usato.
 */
export async function checkPreamble(ctx: vscode.ExtensionContext, rootFile: string, force = false): Promise<void> {
  const { comando, fileColori, colorePredefinito } = cfg();
  const text = await readText(rootFile);
  const info = analyzePreamble(text, comando, fileColori);
  // blocco dell'estensione di una versione vecchia → aggiornalo (serve per le note)
  const upgraded = upgradePreamble(text, detectEngine(text), comando, fileColori, colorePredefinito);
  if (upgraded !== undefined) {
    const doc = await vscode.workspace.openTextDocument(rootFile);
    const ed = new vscode.WorkspaceEdit();
    ed.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), upgraded);
    await vscode.workspace.applyEdit(ed);
    vscode.window.showInformationMessage(
      `Ho aggiornato la definizione di \\${comando} nel preambolo di ${path.basename(rootFile)}: ora funziona anche dentro le formule e supporta le note \\${comando}[colore][nota]{testo}.`);
    return;
  }
  if (info.definesEvid && info.inputsColors) {
    if (force) { vscode.window.showInformationMessage(`Il preambolo definisce già \\${comando} e include ${fileColori}.tex.`); }
    return;
  }
  if (!info.hasDocumentclass || info.beginDocument < 0) {
    if (force) { vscode.window.showWarningMessage('Non trovo \\documentclass … \\begin{document} nel file principale.'); }
    return;
  }
  const never = ctx.workspaceState.get<string[]>('evid.nonChiedere', []);
  if (!force && (asked.has(rootFile) || never.includes(rootFile))) { return; }
  asked.add(rootFile);

  const engine = detectEngine(text);
  const what = info.definesEvid
    ? `\\input{${fileColori}}`
    : `la definizione di \\${comando} (${engine === 'lualatex' ? 'LuaLaTeX, lua-ul' : 'pdfLaTeX, soul'})`;
  const choice = force ? 'Inserisci' : await vscode.window.showInformationMessage(
    `Il preambolo di ${path.basename(rootFile)} non contiene ${what}. La aggiungo prima di \\begin{document}?`,
    'Inserisci', 'Non ora', 'Non chiedere più');
  if (choice === 'Non chiedere più') {
    await ctx.workspaceState.update('evid.nonChiedere', [...never, rootFile]);
    return;
  }
  if (choice !== 'Inserisci') { return; }

  const block = info.definesEvid
    ? `\\input{${fileColori}}\n`
    : preambleBlock(engine, comando, fileColori, colorePredefinito);
  const doc = await vscode.workspace.openTextDocument(rootFile);
  const pos = doc.positionAt(info.beginDocument);
  const ed = new vscode.WorkspaceEdit();
  ed.insert(doc.uri, new vscode.Position(pos.line, 0), block + '\n');
  await vscode.workspace.applyEdit(ed);
}
