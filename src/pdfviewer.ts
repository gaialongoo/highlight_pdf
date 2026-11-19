import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Highlighter } from './highlighter';
import { syncEdit, syncView, synctexAvailable, SyncResult } from './synctex';
import { locate, simplify, normalizeSource, lineOffset } from './match';
import { findEvids, EvidMatch } from './parser';
import { openPalette, pickColor } from './picker';
import { displayName, EvidColor, PASTELLI } from './colorsfile';
import { cfg } from './config';
import { includedFiles } from './project';

interface Pt { x: number; y: number; page?: number; }
type FromWebview =
  | { type: 'ready' }
  | { type: 'highlight'; id: number; page: number; text: string; start: Pt; end: Pt; color?: string; withNote?: boolean }
  | { type: 'pickMore'; then?: Omit<Extract<FromWebview, { type: 'highlight' }>, 'type'> }
  | { type: 'setActive'; color: string }
  | { type: 'onHighlight'; action: 'remove' | 'recolor' | 'pick' | 'note'; page: number; pt: Pt; word: string; color?: string }
  | { type: 'jump'; page: number; pt: Pt }
  | { type: 'compile' }
  | { type: 'clean' }
  | { type: 'summary' }
  | { type: 'import' }
  | { type: 'state'; page: number; scale: string };

/** PDF che LaTeX Workshop produce per un .tex (rispetta latex-workshop.latex.outDir). */
export function pdfForTex(texFile: string): vscode.Uri | undefined {
  const dir = path.dirname(texFile);
  const base = path.basename(texFile, path.extname(texFile));
  const outDir = vscode.workspace.getConfiguration('latex-workshop').get<string>('latex.outDir', '%DIR%');
  const resolved = path.resolve(dir, outDir.replace(/%DIR%|%DIR_W32%/g, dir).replace(/%DOCFILE%/g, base)
    .replace(/%WORKSPACE_FOLDER%/g, vscode.workspace.getWorkspaceFolder(vscode.Uri.file(texFile))?.uri.fsPath ?? dir));
  for (const p of [path.join(resolved, base + '.pdf'), path.join(dir, base + '.pdf')]) {
    if (fs.existsSync(p)) { return vscode.Uri.file(p); }
  }
  vscode.window.showWarningMessage(`Non trovo ${base}.pdf: compila prima il documento.`);
  return undefined;
}

/** Il .tex che ha prodotto il PDF (stesso nome, stessa cartella o cartella superiore). */
function texForPdf(pdfFile: string): string | undefined {
  const base = path.basename(pdfFile, path.extname(pdfFile));
  const dir = path.dirname(pdfFile);
  for (const p of [path.join(dir, base + '.tex'), path.join(dir, '..', base + '.tex')]) {
    if (fs.existsSync(p)) { return path.resolve(p); }
  }
  return undefined;
}

class Session implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private lastMtime = 0;

  constructor(
    private readonly provider: PdfViewerProvider,
    private readonly pdf: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
  ) {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(pdf.fsPath)), path.basename(pdf.fsPath)));
    const changed = () => this.scheduleReload();
    w.onDidChange(changed, null, this.disposables);
    w.onDidCreate(changed, null, this.disposables);
    this.disposables.push(w,
      provider.hl.store.onDidChange(() => this.sendColors()),
      provider.hl.recompiler.onDidChangePending(n => this.post({ type: 'pending', count: n })),
      panel.webview.onDidReceiveMessage(m => this.onMessage(m)),
    );
  }

  dispose() {
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    this.disposables.forEach(d => d.dispose());
  }

  private post(m: unknown) { void this.panel.webview.postMessage(m); }

  private toast(text: string, kind: 'info' | 'error' = 'info') { this.post({ type: 'toast', text, kind }); }

  // ---- PDF -------------------------------------------------------------------

  private scheduleReload() {
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    // LaTeX scrive il PDF a pezzi: aspettiamo che smetta
    this.reloadTimer = setTimeout(() => void this.load(true), 700);
  }

  async load(keepPosition: boolean) {
    let data: Uint8Array;
    try {
      const st = fs.statSync(this.pdf.fsPath);
      if (keepPosition && st.mtimeMs === this.lastMtime) { return; }
      data = await fs.promises.readFile(this.pdf.fsPath);
      // file incompleto (compilazione in corso)? riprova tra poco
      const tail = Buffer.from(data.subarray(Math.max(0, data.length - 1024))).toString('latin1');
      if (!tail.includes('%%EOF')) { this.scheduleReload(); return; }
      this.lastMtime = st.mtimeMs;
    } catch {
      if (keepPosition) { this.scheduleReload(); }
      else { this.toast('Impossibile leggere il PDF.', 'error'); }
      return;
    }
    this.post({ type: 'load', data: new Uint8Array(data), keepPosition, pending: this.provider.hl.recompiler.pendingCount,
      synctex: synctexAvailable(this.pdf.fsPath) });
  }

  sendColors() {
    const s = this.provider.hl.store;
    const tex = texForPdf(this.pdf.fsPath);
    const all = s.all(tex);
    const quick: EvidColor[] = [];
    const add = (c: EvidColor) => { if (!quick.some(q => q.name === c.name)) { quick.push(c); } };
    PASTELLI.forEach(add);
    s.preferiti.forEach(add);
    s.recenti.slice(0, 4).forEach(add);
    const info = (c: EvidColor) => ({ name: c.name, hex: c.hex, label: s.label(c) ?? '', display: displayName(c) });
    this.post({
      type: 'colors',
      active: info(s.active),
      quick: quick.map(info),
      known: all.map(c => c.hex),
    });
  }

  // ---- messaggi ----------------------------------------------------------------

  private async onMessage(m: FromWebview) {
    try {
      switch (m.type) {
        case 'ready':
          this.sendColors();
          await this.load(false);
          break;
        case 'setActive': {
          const c = this.provider.hl.store.byName(m.color, texForPdf(this.pdf.fsPath));
          if (c) { await this.provider.hl.store.setActive(c); }
          break;
        }
        case 'pickMore': {
          const c = await openPalette(this.provider.ctx, this.provider.hl.store);
          this.panel.reveal(undefined, false);
          if (!c) {
            if (m.then) { this.post({ type: 'applied', id: m.then.id, ok: false }); }
            break;
          }
          await this.provider.hl.store.setActive(c);
          await this.provider.hl.store.addRecent(c);
          if (m.then) { await this.highlight({ ...m.then, type: 'highlight', color: c.name }); }
          break;
        }
        case 'highlight':
          await this.highlight(m);
          break;
        case 'onHighlight':
          await this.onExisting(m);
          break;
        case 'jump':
          await this.jump(m.page, m.pt);
          break;
        case 'compile':
          await this.provider.hl.recompiler.build(texForPdf(this.pdf.fsPath));
          break;
        case 'clean':
        case 'summary':
        case 'import': {
          const tex = texForPdf(this.pdf.fsPath);
          if (!tex && m.type !== 'import') { this.toast('Non trovo il .tex di questo PDF.', 'error'); break; }
          await this.provider.actions[m.type](tex);
          break;
        }
      }
    } catch (e) {
      this.toast(`Errore: ${(e as Error).message}`, 'error');
    }
  }

  private async sourceFor(page: number, pts: Pt[]): Promise<{ doc: vscode.TextDocument; lines: number[] } | undefined> {
    const results: SyncResult[] = [];
    for (const p of pts) {
      const r = await syncEdit(this.pdf.fsPath, p.page ?? page, p.x, p.y);
      if (r) { results.push(r); }
    }
    const file = results[0]?.file ?? texForPdf(this.pdf.fsPath);
    if (!file || !fs.existsSync(file)) {
      this.toast('Non trovo il file .tex: compila con -synctex=1 oppure tieni il .tex accanto al PDF.', 'error');
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(file);
    const lines = results.filter(r => path.resolve(r.file) === path.resolve(file)).map(r => r.line);
    return { doc, lines };
  }

  private async highlight(m: Extract<FromWebview, { type: 'highlight' }>) {
    const src = await this.sourceFor(m.page, [m.start, m.end]);
    if (!src) { this.post({ type: 'applied', id: m.id, ok: false }); return; }
    const { lines } = src;
    let doc = src.doc;
    const win = vscode.workspace.getConfiguration('evid').get<number>('pdf.finestraRighe', 8);
    let found = locate(doc.getText(), m.text, lines, win);
    // senza SyncTeX si conosce solo il file principale: cerca anche nei file inclusi
    if (!found && !lines.length) {
      for (const f of includedFiles(doc.uri.fsPath)) {
        const d = await vscode.workspace.openTextDocument(f);
        const r = locate(d.getText(), m.text, [], win);
        if (r) { doc = d; found = r; break; }
      }
    }
    if (!found) {
      this.post({ type: 'applied', id: m.id, ok: false });
      const choice = await vscode.window.showWarningMessage(
        `Non trovo "${m.text.slice(0, 60).replace(/\s+/g, ' ')}" nel sorgente.`, 'Apri il punto nel .tex');
      if (choice && lines.length) { await this.reveal(doc, lines[0]); }
      return;
    }
    const store = this.provider.hl.store;
    const color = (m.color && store.byName(m.color, doc.uri.fsPath)) || store.active;
    if (m.color) { await store.setActive(color); }
    const res = await this.provider.hl.apply(doc, [{ from: found.start, to: found.end }], color, 'color', { quiet: true });
    const ok = res.added + res.recolored > 0;
    this.post({ type: 'applied', id: m.id, ok, approx: !found.exact });
    if (ok && m.withNote) {
      const e = this.provider.hl.evidAtOffset(doc, found.start);
      if (e) { await this.provider.hl.editNote(doc, e); this.panel.reveal(undefined, false); }
    }
    if (ok && !found.exact) {
      this.toast('Evidenziato con corrispondenza approssimata: controlla il risultato dopo la compilazione.');
    }
  }

  /** Clic su un'evidenziazione già presente nel PDF. */
  private async onExisting(m: Extract<FromWebview, { type: 'onHighlight' }>) {
    const src = await this.sourceFor(m.page, [m.pt]);
    if (!src) { return; }
    const { doc, lines } = src;
    const text = doc.getText();
    const evids = findEvids(text, cfg().comando);
    const line = lines[0] ?? 0;
    const win = vscode.workspace.getConfiguration('evid').get<number>('pdf.finestraRighe', 8);
    const lo = lineOffset(text, Math.max(0, line - win)), hi = lineOffset(text, line + win + 1);
    const near = lineOffset(text, line);
    const word = simplify(m.word);
    const contains = (e: EvidMatch) => !word || normalizeSource(text, e.contentStart, e.contentEnd).norm.includes(word);
    const pool = evids.filter(e => e.end >= lo && e.start <= hi && contains(e));
    const best = (pool.length ? pool : evids.filter(contains))
      .sort((a, b) => Math.abs(a.start - near) - Math.abs(b.start - near))[0];
    if (!best) { this.toast('Non trovo questa evidenziazione nel sorgente.', 'error'); return; }

    const store = this.provider.hl.store;
    if (m.action === 'remove') {
      await this.provider.hl.remove(doc, best);
    } else if (m.action === 'note') {
      await this.provider.hl.editNote(doc, best);
      this.panel.reveal(undefined, false);
    } else {
      let c = m.color ? store.byName(m.color, doc.uri.fsPath) : undefined;
      if (m.action === 'pick' || !c) {
        c = await pickColor(this.provider.ctx, store, doc.uri.fsPath, 'Nuovo colore per l\'evidenziazione');
        this.panel.reveal(undefined, false);
      }
      if (c) { await this.provider.hl.recolor(doc, best, c); }
    }
  }

  get pdfPath() { return this.pdf.fsPath; }

  /** Porta il viewer a un punto della pagina e lo fa lampeggiare. */
  scrollTo(page: number, x: number, y: number) {
    this.panel.reveal(undefined, true);
    this.post({ type: 'scrollTo', page, x, y });
  }

  private async jump(page: number, pt: Pt) {
    const src = await this.sourceFor(page, [pt]);
    if (src) { await this.reveal(src.doc, src.lines[0] ?? 0); }
  }

  private async reveal(doc: vscode.TextDocument, line: number) {
    const col = this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: col, preserveFocus: false });
    const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

export class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  static readonly viewType = 'evid.pdfViewer';
  private sessions = new Set<Session>();

  constructor(
    readonly ctx: vscode.ExtensionContext,
    readonly hl: Highlighter,
    readonly actions: Record<'clean' | 'summary' | 'import', (tex: string | undefined) => Promise<void>>,
    private readonly onOpen: (tex: string | undefined) => void,
  ) { }

  /** SyncTeX in avanti: mostra nel viewer (se aperto) il punto del .tex. */
  async revealSource(texFile: string, line: number): Promise<boolean> {
    for (const s of this.sessions) {
      const tex = texForPdf(s.pdfPath);
      if (!tex || path.dirname(tex).toLowerCase() !== path.dirname(texFile).toLowerCase()) { continue; }
      const r = await syncView(s.pdfPath, texFile, line);
      if (r) { s.scrollTo(r.page, r.x, r.y); return true; }
    }
    return false;
  }

  hasViewerFor(texFile: string): boolean {
    return [...this.sessions].some(s => texForPdf(s.pdfPath)?.toLowerCase() === texFile.toLowerCase());
  }

  dispose() { this.sessions.forEach(s => s.dispose()); }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => { /* niente */ } };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview);
    const s = new Session(this, document.uri, panel);
    this.sessions.add(s);
    panel.onDidDispose(() => { s.dispose(); this.sessions.delete(s); });
    this.onOpen(texForPdf(document.uri.fsPath));
    void this.offerDefault();
  }

  /** Alla prima apertura propone di usare questo viewer per tutti i PDF. */
  private async offerDefault() {
    if (this.ctx.globalState.get('evid.offertoPredefinito')) { return; }
    await this.ctx.globalState.update('evid.offertoPredefinito', true);
    const assoc = vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('editorAssociations', {});
    if (assoc['*.pdf'] === PdfViewerProvider.viewType) { return; }
    const c = await vscode.window.showInformationMessage(
      'Vuoi aprire sempre i PDF con l\'Evidenziatore (invece del viewer di LaTeX Workshop)?',
      'Sì, sempre', 'No');
    if (c === 'Sì, sempre') {
      await vscode.workspace.getConfiguration('workbench').update('editorAssociations',
        { ...assoc, '*.pdf': PdfViewerProvider.viewType }, vscode.ConfigurationTarget.Global);
    }
  }

  private html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const u = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data: blob:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource} data: blob:`,
      `worker-src blob:`,
    ].join('; ');
    return /* html */`<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${u('viewer.css')}">
</head><body>
<div id="toolbar">
  <button id="modeBtn" class="tb" title="Modalità evidenziatore: ogni selezione viene evidenziata subito col colore attivo">🖍 <span>Evidenziatore</span></button>
  <div id="dots"></div>
  <button id="moreBtn" class="tb icon" title="Altro colore… (palette completa)">＋</button>
  <span class="sep"></span>
  <button id="compileBtn" class="tb" title="Compila adesso">⟳ <span id="pendingTxt">Compila</span></button>
  <button id="summaryBtn" class="tb" title="Genera il riassunto delle evidenziazioni (PDF o Markdown)">☰ Riassunto</button>
  <button id="cleanBtn" class="tb" title="Compila una copia senza evidenziazioni né note (…-pulito.pdf)">◻ PDF pulito</button>
  <button id="importBtn" class="tb" title="Importa le evidenziazioni da un PDF annotato con Edge/Acrobat">⇩ Importa</button>
  <span class="grow"></span>
  <button id="zoomOut" class="tb icon" title="Riduci (Ctrl+rotellina)">−</button>
  <select id="zoomSel" title="Zoom">
    <option value="width">Larghezza</option><option value="page">Pagina</option>
    <option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option>
    <option value="1.5">150%</option><option value="2">200%</option>
  </select>
  <button id="zoomIn" class="tb icon" title="Ingrandisci (Ctrl+rotellina)">+</button>
  <span id="pageInfo"></span>
</div>
<div id="viewer"></div>
<div id="floating" class="pop hidden"></div>
<div id="menu" class="pop hidden"></div>
<div id="toast" class="hidden"></div>
<script nonce="${nonce}">window.EVID = { pdfjs: "${u('pdfjs', 'pdf.min.mjs')}", worker: "${u('pdfjs', 'pdf.worker.min.mjs')}" };</script>
<script nonce="${nonce}" type="module" src="${u('viewer.js')}"></script>
</body></html>`;
  }
}
