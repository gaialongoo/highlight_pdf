import * as vscode from 'vscode';
import { ColorStore } from './colors';
import { Decorator } from './decorations';
import { Recompiler } from './compile';
import { Highlighter } from './highlighter';
import { PdfViewerProvider, pdfForTex } from './pdfviewer';
import { pickColor, openPalette, editLegend } from './picker';
import { rootFileOf, checkPreamble, detectEngine, readText } from './latex';
import { evidAt, findEvids } from './parser';
import { EvidTree, Node } from './tree';
import { generateSummary, compileClean } from './outputs';
import { importAnnotations } from './importer';
import { cfg } from './config';
import { lastHighlight, preview } from './project';

export function activate(ctx: vscode.ExtensionContext) {
  const store = new ColorStore(ctx);
  const decorator = new Decorator(store);
  const recompiler = new Recompiler();
  const hl = new Highlighter(ctx, store, recompiler);

  // ---- A. pannello "Evidenziazioni" -----------------------------------------------
  const tree = new EvidTree(ctx, store);
  tree.view = vscode.window.createTreeView('evid.lista', { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(tree, tree.view);

  /** File principale su cui lavorare: editor .tex attivo, poi pannello, poi chiede. */
  const currentRoot = async (hint?: string): Promise<string | undefined> => {
    if (hint) { return hint; }
    const ed = vscode.window.activeTextEditor;
    if (ed?.document.languageId === 'latex') { return rootFileOf(ed.document); }
    if (tree.root) { return tree.root; }
    const t = await vscode.window.showOpenDialog({ title: 'File .tex degli appunti', filters: { LaTeX: ['tex'] }, canSelectMany: false });
    return t?.[0]?.fsPath;
  };

  const actions = {
    clean: async (tex?: string) => { const r = await currentRoot(tex); if (r) { await compileClean(hl, r, PdfViewerProvider.viewType); } },
    summary: async (tex?: string) => { const r = await currentRoot(tex); if (r) { await generateSummary(hl, r, PdfViewerProvider.viewType); } },
    import: async (tex?: string) => { await importAnnotations(ctx, hl, tex); tree.schedule(50); },
  };
  const viewer = new PdfViewerProvider(ctx, hl, actions, tex => { if (tex) { tree.setRoot(tex); } });
  ctx.subscriptions.push(store, decorator, recompiler, viewer,
    vscode.window.registerCustomEditorProvider(PdfViewerProvider.viewType, viewer, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }));

  // ---- barra di stato: pallino del colore attivo + "Evidenzia" -----------------
  const colorItem = vscode.window.createStatusBarItem('evid.color', vscode.StatusBarAlignment.Right, 101);
  colorItem.name = 'Colore evidenziatore';
  colorItem.command = 'evid.pickColor';
  const hlItem = vscode.window.createStatusBarItem('evid.highlight', vscode.StatusBarAlignment.Right, 100);
  hlItem.name = 'Evidenzia';
  hlItem.command = 'evid.highlight';
  hlItem.text = '$(edit) Evidenzia';
  ctx.subscriptions.push(colorItem, hlItem);

  const renderStatus = () => {
    const ed = vscode.window.activeTextEditor;
    if (ed?.document.languageId !== 'latex') { colorItem.hide(); hlItem.hide(); return; }
    const c = store.active;
    colorItem.text = '$(circle-large-filled)';
    colorItem.color = '#' + c.hex;
    colorItem.tooltip = `Colore attivo: ${store.describe(c)} (#${c.hex})\nClic per cambiarlo`;
    hlItem.tooltip = `Evidenzia la selezione in ${store.describe(c)} (Ctrl+Shift+H)`;
    colorItem.show(); hlItem.show();
  };

  // ---- contesto "cursore dentro un \evid" per i menu ----------------------------
  const updateContext = (ed = vscode.window.activeTextEditor) => {
    let inside = false;
    if (ed?.document.languageId === 'latex') {
      const doc = ed.document;
      const evids = findEvids(doc.getText(), cfg().comando);
      inside = ed.selections.some(s => !!evidAt(evids, doc.offsetAt(s.start), doc.offsetAt(s.end)));
    }
    void vscode.commands.executeCommand('setContext', 'evid.inEvid', inside);
  };

  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(ed => { renderStatus(); updateContext(ed); }),
    vscode.window.onDidChangeTextEditorSelection(e => updateContext(e.textEditor)),
    store.onDidChange(renderStatus),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('evid')) { renderStatus(); } }),
  );
  renderStatus();
  updateContext();

  // ---- comandi ---------------------------------------------------------------------
  const latexEditor = (): vscode.TextEditor | undefined => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'latex') {
      vscode.window.showWarningMessage('Apri un file .tex per evidenziare.');
      return undefined;
    }
    return ed;
  };
  const targetsOf = (ed: vscode.TextEditor) =>
    ed.selections.map(s => ({ from: ed.document.offsetAt(s.start), to: ed.document.offsetAt(s.end) }));

  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('evid.highlight', async () => {
    const ed = latexEditor();
    if (ed) { await hl.apply(ed.document, targetsOf(ed), store.active, 'toggle'); }
  });

  reg('evid.highlightWithColor', async () => {
    const ed = latexEditor();
    if (!ed) { return; }
    const c = await pickColor(ctx, store, rootFileOf(ed.document), 'Evidenzia con…');
    if (!c) { return; }
    await store.setActive(c);
    await hl.apply(ed.document, targetsOf(ed), c, 'color');
  });

  reg('evid.remove', async () => {
    const ed = latexEditor();
    if (ed) { await hl.apply(ed.document, targetsOf(ed), store.active, 'remove'); }
  });

  reg('evid.pickColor', async () => {
    const ed = vscode.window.activeTextEditor;
    const c = await pickColor(ctx, store, ed?.document.languageId === 'latex' ? rootFileOf(ed.document) : undefined,
      'Colore attivo dell\'evidenziatore');
    if (c) { await store.setActive(c); await store.addRecent(c); }
  });

  reg('evid.moreColors', async () => {
    const c = await openPalette(ctx, store);
    if (!c) { return; }
    await store.setActive(c);
    await store.addRecent(c);
  });

  reg('evid.editLegend', async () => {
    const ed = vscode.window.activeTextEditor;
    const root = ed?.document.languageId === 'latex' ? rootFileOf(ed.document) : undefined;
    await editLegend(ctx, store, root);
    if (root) { await store.writeColorsFile(root, []); }
  });

  reg('evid.insertPreamble', async () => {
    const ed = latexEditor();
    if (!ed) { return; }
    const root = rootFileOf(ed.document);
    await store.writeColorsFile(root, []);
    await checkPreamble(ctx, root, true);
  });

  reg('evid.compileNow', () => recompiler.build());

  reg('evid.showEngine', async () => {
    const ed = latexEditor();
    if (!ed) { return; }
    const e = detectEngine(await readText(rootFileOf(ed.document)));
    vscode.window.showInformationMessage(`Compilatore rilevato: ${e === 'lualatex' ? 'LuaLaTeX (lua-ul)' : 'pdfLaTeX (soul)'}.`);
  });

  /** Apre il PDF nel viewer che permette di evidenziare. */
  reg('evid.openPdf', async (arg?: vscode.Uri) => {
    let pdf: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri && /\.pdf$/i.test(arg.fsPath)) { pdf = arg; }
    else {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (tab instanceof vscode.TabInputCustom && /\.pdf$/i.test(tab.uri.fsPath)) { pdf = tab.uri; }
    }
    if (!pdf) {
      const ed = vscode.window.activeTextEditor;
      if (ed?.document.languageId === 'latex') { pdf = pdfForTex(rootFileOf(ed.document)); }
    }
    if (!pdf) {
      const picked = await vscode.window.showOpenDialog({ filters: { PDF: ['pdf'] }, canSelectMany: false });
      pdf = picked?.[0];
    }
    if (!pdf) { return; }
    const fromTex = vscode.window.activeTextEditor?.document.languageId === 'latex';
    await vscode.commands.executeCommand('vscode.openWith', pdf, PdfViewerProvider.viewType,
      fromTex ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
  });

  // ---- D. note ----------------------------------------------------------------------
  reg('evid.addNote', async () => {
    const ed = latexEditor();
    if (!ed) { return; }
    const e = hl.evidAtOffset(ed.document, ed.document.offsetAt(ed.selection.active));
    if (!e) { vscode.window.setStatusBarMessage('$(info) Metti il cursore dentro un\'evidenziazione', 3000); return; }
    await hl.editNote(ed.document, e);
  });

  // ---- C, E, Fase 3 -------------------------------------------------------------
  reg('evid.summary', () => actions.summary());
  reg('evid.compileClean', () => actions.clean());
  reg('evid.importAnnotations', async () => {
    const ed = vscode.window.activeTextEditor;
    await actions.import(ed?.document.languageId === 'latex' ? rootFileOf(ed.document) : tree.root);
  });

  // ---- SyncTeX in avanti: dal .tex al viewer ------------------------------------------
  reg('evid.showInPdf', async () => {
    const ed = latexEditor();
    if (!ed) { return; }
    const root = rootFileOf(ed.document);
    if (!viewer.hasViewerFor(root)) {
      await vscode.commands.executeCommand('evid.openPdf');
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!await viewer.revealSource(ed.document.uri.fsPath, ed.selection.active.line)) {
      vscode.window.setStatusBarMessage('$(info) SyncTeX non ha trovato questo punto nel PDF (ricompila?)', 3000);
    }
  });

  // ---- "dove ero arrivato": l'evidenziazione più in fondo ----------------------------
  reg('evid.lastHighlight', async () => {
    if (await viewer.lastInActiveViewer()) { return; }
    const ed = vscode.window.activeTextEditor;
    const root = ed?.document.languageId === 'latex' ? rootFileOf(ed.document) : tree.root;
    if (!root) { vscode.window.showWarningMessage('Apri il file .tex degli appunti (o il suo PDF).'); return; }
    const it = await lastHighlight(root);
    if (!it) { vscode.window.setStatusBarMessage('$(info) Non ci sono ancora evidenziazioni', 3000); return; }
    const doc = await vscode.workspace.openTextDocument(it.file);
    const e = hl.evidAtOffset(doc, it.start + 1);
    const range = e
      ? new vscode.Range(doc.positionAt(e.contentStart), doc.positionAt(e.contentEnd))
      : new vscode.Range(it.line, 0, it.line, 0);
    const shown = await vscode.window.showTextDocument(doc, { preserveFocus: false, viewColumn: ed?.viewColumn ?? vscode.ViewColumn.One });
    shown.selection = new vscode.Selection(range.start, range.end);
    shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
    void viewer.revealSource(doc.uri.fsPath, range.start.line);
    vscode.window.setStatusBarMessage(`$(bookmark) Eri arrivato qui: «${preview(it)}»`, 4000);
  });

  // ---- comandi del pannello ---------------------------------------------------------
  const itemEvid = async (n: Node) => {
    if (n?.kind !== 'item') { return undefined; }
    const doc = await vscode.workspace.openTextDocument(n.item.file);
    const e = hl.evidAtOffset(doc, n.item.start + 1);
    if (!e) { tree.schedule(10); vscode.window.showWarningMessage('Evidenziazione non più presente: aggiorno il pannello.'); }
    return e && { doc, e };
  };
  reg('evid.tree.open', async (n: Node) => {
    const r = await itemEvid(n);
    if (!r) { return; }
    const ed = await vscode.window.showTextDocument(r.doc, { preserveFocus: false, viewColumn: vscode.ViewColumn.One });
    const range = new vscode.Range(r.doc.positionAt(r.e.contentStart), r.doc.positionAt(r.e.contentEnd));
    ed.selection = new vscode.Selection(range.start, range.end);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
    void viewer.revealSource(r.doc.uri.fsPath, range.start.line);
  });
  reg('evid.tree.remove', async (n: Node) => { const r = await itemEvid(n); if (r) { await hl.remove(r.doc, r.e); } });
  reg('evid.tree.recolor', async (n: Node) => {
    const r = await itemEvid(n);
    if (!r) { return; }
    const c = await pickColor(ctx, store, rootFileOf(r.doc), 'Nuovo colore');
    if (c) { await hl.recolor(r.doc, r.e, c); }
  });
  reg('evid.tree.note', async (n: Node) => { const r = await itemEvid(n); if (r) { await hl.editNote(r.doc, r.e); } });
  reg('evid.tree.groupBySection', () => tree.setGroup('sezione'));
  reg('evid.tree.groupByColor', () => tree.setGroup('colore'));
  reg('evid.tree.filter', () => tree.pickFilter());
  reg('evid.tree.search', () => tree.pickSearch());
  reg('evid.tree.clearFilter', () => tree.clearFilter());
  reg('evid.tree.refresh', () => tree.refresh());

  // la legenda cambia nelle impostazioni → aggiorna \legendaevid
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
    if (!e.affectsConfiguration('evid.legenda')) { return; }
    const ed = vscode.window.visibleTextEditors.find(x => x.document.languageId === 'latex');
    if (ed) { await store.writeColorsFile(rootFileOf(ed.document), []); }
  }));
}

export function deactivate() { /* niente */ }
