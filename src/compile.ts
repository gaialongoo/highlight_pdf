import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { cfg } from './config';
import { detectEngine, readText } from './latex';
import { Tracked, parseLogErrors, culprits, lineAt } from './repair';

const LW_ID = 'james-yu.latex-workshop';

/**
 * Ricompila "ogni tanto": dopo N secondi di inattività, ogni N evidenziazioni
 * o solo a mano. Mostra nella barra di stato quante evidenziazioni aspettano.
 */
export class Recompiler implements vscode.Disposable {
  private pending = 0;
  private timer: NodeJS.Timeout | undefined;
  private roots = new Set<string>();
  private building = false;
  private readonly item: vscode.StatusBarItem;
  private readonly out = vscode.window.createOutputChannel('Evidenziatore LaTeX');
  private readonly pendingEmitter = new vscode.EventEmitter<number>();
  /** cambia il numero di evidenziazioni in attesa di compilazione */
  readonly onDidChangePending = this.pendingEmitter.event;
  get pendingCount() { return this.pending; }
  private readonly disposables: vscode.Disposable[] = [];
  /** evidenziazioni non ancora passate da una compilazione riuscita, per file principale */
  private journal = new Map<string, Tracked[]>();

  constructor() {
    this.item = vscode.window.createStatusBarItem('evid.pending', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Evidenziazioni da compilare';
    this.item.command = 'evid.compileNow';
    this.disposables.push(this.item, this.out, this.pendingEmitter,
      vscode.workspace.onDidSaveTextDocument(d => {
        // se LaTeX Workshop compila da solo al salvataggio, il conteggio riparte
        if (d.languageId === 'latex' && this.lwAutoBuilds() && !this.building) { this.reset(); }
      }));
  }

  /** Ricorda le evidenziazioni appena scritte: se rompono la compilazione si annullano. */
  track(rootFile: string, items: Tracked[]) {
    if (!items.length) { return; }
    const key = rootFile.toLowerCase();
    this.journal.set(key, [...(this.journal.get(key) ?? []), ...items]);
  }

  /**
   * Dopo una compilazione fallita: annulla le evidenziazioni nuove che stanno sulle
   * righe degli errori. Restituisce quante ne ha annullate.
   */
  private async repair(rootFile: string, logFile: string): Promise<number> {
    const key = rootFile.toLowerCase();
    const tracked = this.journal.get(key) ?? [];
    if (!tracked.length) { return 0; }
    let log = '';
    try { log = fs.readFileSync(logFile, 'latin1'); } catch { return 0; }
    const errors = parseLogErrors(log, path.dirname(rootFile));
    if (!errors.length) { return 0; }
    const docs = new Map<string, vscode.TextDocument>();
    const texts = new Map<string, string>();
    for (const t of tracked) {
      if (docs.has(t.file)) { continue; }
      try {
        const d = await vscode.workspace.openTextDocument(t.file);
        docs.set(t.file, d); texts.set(t.file, d.getText());
      } catch { /* file sparito */ }
    }
    const bad = culprits(tracked, errors, texts);
    if (!bad.length) { return 0; }
    const we = new vscode.WorkspaceEdit();
    for (const { item, at } of bad) {
      const d = docs.get(item.file)!;
      we.replace(d.uri, new vscode.Range(d.positionAt(at), d.positionAt(at + item.inserted.length)), item.original);
    }
    if (!await vscode.workspace.applyEdit(we)) { return 0; }
    for (const f of new Set(bad.map(b => b.item.file))) { await docs.get(f)!.save(); }
    this.journal.set(key, tracked.filter(t => !bad.some(b => b.item === t)));
    const where = [...new Set(bad.map(b => `${path.basename(b.item.file)}:${lineAt(texts.get(b.item.file)!, b.at)}`))].join(', ');
    this.out.appendLine(`Annullate ${bad.length} evidenziazioni che impedivano la compilazione (${where}).`);
    void vscode.window.showWarningMessage(
      `${bad.length === 1 ? "Un'evidenziazione impediva" : `${bad.length} evidenziazioni impedivano`} la compilazione (${where}): l'ho annullata e ricompilo.`);
    return bad.length;
  }

  /** Chiamato dopo ogni evidenziazione. */
  notify(rootFile: string, n = 1) {
    this.roots.add(rootFile);
    this.pending += n;
    this.render();
    const { modo, secondi, ogniN } = cfg();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (modo === 'inattivita') {
      this.timer = setTimeout(() => this.build(), secondi * 1000);
    } else if (modo === 'conteggio' && this.pending >= ogniN) {
      void this.build();
    }
  }

  private reset() {
    this.pending = 0;
    this.roots.clear();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.render();
  }

  private render() {
    this.pendingEmitter.fire(this.pending);
    if (this.pending <= 0) { this.item.hide(); return; }
    const { modo, secondi } = cfg();
    this.item.text = `$(sync) ${this.pending} ${this.pending === 1 ? 'evidenziazione' : 'evidenziazioni'} da compilare`;
    this.item.tooltip = (modo === 'inattivita' ? `Compilo dopo ${secondi} s senza nuove evidenziazioni.\n` : '')
      + 'Clic per compilare adesso.';
    this.item.show();
  }

  private lw() { return vscode.extensions.getExtension(LW_ID); }

  private lwAutoBuilds(): boolean {
    if (!this.lw()) { return false; }
    const run = vscode.workspace.getConfiguration('latex-workshop').get<string>('latex.autoBuild.run', 'onFileChange');
    return run !== 'never';
  }

  /** Salva e compila. Se c'è LaTeX Workshop usa il suo build. */
  private running: Promise<void> | undefined;
  private again: string[] | undefined;

  /**
   * Salva e compila. Una sola compilazione alla volta: se ne arriva un'altra
   * mentre una è in corso, viene eseguita subito dopo (una volta sola).
   */
  build(rootHint?: string): Promise<void> {
    if (this.running) {
      this.again = [...(this.again ?? []), ...(rootHint ? [rootHint] : [])];
      return this.running;
    }
    this.running = (async () => {
      try {
        await this.buildOnce(rootHint);
        while (this.again) {
          const hints = this.again;
          this.again = undefined;
          // ricompila solo se nel frattempo c'è davvero qualcosa di nuovo
          if (this.pending > 0) { await this.buildOnce(hints[0]); }
        }
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async buildOnce(rootHint?: string): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const roots = [...this.roots];
    if (rootHint && !roots.some(r => r.toLowerCase() === rootHint.toLowerCase())) { roots.push(rootHint); }
    if (roots.length === 0) {
      const ed = vscode.window.activeTextEditor;
      if (ed?.document.languageId === 'latex') { roots.push(ed.document.uri.fsPath); }
    }
    this.building = true;
    const snapshot = this.pending;
    try {
      // salva i .tex modificati (appunti + evid-colori.tex)
      const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && (d.languageId === 'latex' || /\.tex$/i.test(d.fileName)));
      const savedAt = Date.now();
      for (const d of dirty) { await d.save(); }

      // Il build di LaTeX Workshop parte SOLO se l'editor attivo è un .tex
      // (dal viewer PDF non fa niente). In quel caso usiamo LaTeX Workshop,
      // altrimenti compiliamo noi.
      const active = vscode.window.activeTextEditor;
      const activeIsRoot = !!active && active.document.languageId === 'latex'
        && roots.some(r => r.toLowerCase() === active.document.uri.fsPath.toLowerCase()
          || path.dirname(r).toLowerCase() === path.dirname(active.document.uri.fsPath).toLowerCase());
      if (this.lw() && activeIsRoot) {
        // con autoBuild attivo il salvataggio fa già partire la compilazione
        if (!this.lwAutoBuilds() || dirty.length === 0) {
          await vscode.commands.executeCommand('latex-workshop.build');
          for (const r of roots) {
            const log = r.replace(/\.tex$/i, '.log');
            let fresh = false;
            try { fresh = fs.statSync(log).mtimeMs >= savedAt - 200; } catch { /* niente log */ }
            if (fresh && await this.repair(r, log) > 0) { await vscode.commands.executeCommand('latex-workshop.build'); }
            else if (fresh && !parseLogErrors(fs.readFileSync(log, 'latin1'), path.dirname(r)).length) { this.journal.delete(r.toLowerCase()); }
          }
        }
      } else {
        for (const r of roots) {
          // se LaTeX Workshop è già partito da solo col salvataggio, non compiliamo
          // una seconda volta in parallelo (i due pdflatex si bloccherebbero il PDF)
          if (this.lw() && this.lwAutoBuilds() && dirty.length > 0 && await this.lwStarted(r, savedAt)) {
            this.out.appendLine(`LaTeX Workshop sta già compilando ${path.basename(r)}.`);
            continue;
          }
          await this.runEngine(r);
        }
      }
    } finally {
      this.building = false;
      // le evidenziazioni fatte DURANTE la compilazione restano da compilare
      const rest = Math.max(0, this.pending - snapshot);
      this.reset();
      if (rest > 0) {
        this.pending = rest;
        roots.forEach(r => this.roots.add(r));
        this.render();
        // il timer di notify() è già armato: ricompilerà dopo la pausa
        if (!this.timer && cfg().modo === 'inattivita') {
          this.timer = setTimeout(() => void this.build(), cfg().secondi * 1000);
        }
      }
    }
  }

  /** Aspetta un attimo e guarda se il .log è stato riscritto (= qualcuno sta compilando). */
  private async lwStarted(rootFile: string, since: number): Promise<boolean> {
    const log = rootFile.replace(/\.tex$/i, '.log');
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { if (fs.statSync(log).mtimeMs >= since - 200) { return true; } } catch { /* niente log */ }
    }
    return false;
  }

  private async runEngine(rootFile: string) {
    const key = rootFile.toLowerCase();
    const guarded = (this.journal.get(key)?.length ?? 0) > 0;
    // con evidenziazioni nuove in sospeso l'errore lo mostriamo solo se non si ripara
    if (await this.compileTex(rootFile, { synctex: true, quiet: guarded })) { this.journal.delete(key); return; }
    if (!guarded) { return; }
    const savedAt = Date.now();
    if (await this.repair(rootFile, rootFile.replace(/\.tex$/i, '.log')) > 0) {
      // il salvataggio della riparazione può far partire LaTeX Workshop da solo:
      // in quel caso non compiliamo una seconda volta in parallelo
      if (this.lw() && this.lwAutoBuilds() && await this.lwStarted(rootFile, savedAt)) {
        this.out.appendLine(`LaTeX Workshop ricompila ${path.basename(rootFile)} dopo la riparazione.`);
        return;
      }
      if (await this.compileTex(rootFile, { synctex: true })) { this.journal.delete(key); }
    } else {
      this.showErrors(rootFile, rootFile.replace(/\.tex$/i, ''));
    }
  }

  /**
   * Compila con pdflatex/lualatex (lo stesso eseguibile di LaTeX Workshop se
   * configurato). Ripete la compilazione quando il log chiede "Rerun"
   * (riferimenti, note a margine). Restituisce true se è andata bene.
   *
   * - jobname: nome del PDF prodotto (es. "appunti-pulito")
   * - prefix:  codice TeX da eseguire prima del file (es. "\def\evidpulito{}")
   * - texFile: file da compilare (default rootFile)
   */
  async compileTex(rootFile: string, opts: { synctex?: boolean; jobname?: string; prefix?: string; texFile?: string; title?: string; quiet?: boolean } = {}): Promise<boolean> {
    let engine: string = detectEngine(await readText(rootFile));
    const tools = vscode.workspace.getConfiguration('latex-workshop').get<{ command: string }[]>('latex.tools', []);
    const abs = tools.map(t => t.command).find(c => path.isAbsolute(c) && path.basename(c).toLowerCase().startsWith(engine));
    if (abs) { engine = abs; }
    const dir = path.dirname(rootFile);
    const file = path.basename(opts.texFile ?? rootFile);
    const base = file.replace(/\.tex$/i, '');
    const jobname = opts.jobname ?? base;
    const args = [
      ...(opts.synctex ? ['-synctex=1'] : []), '-interaction=nonstopmode', '-file-line-error',
      ...(opts.jobname ? [`-jobname=${opts.jobname}`] : []),
      opts.prefix ? `${opts.prefix}\\input{${base}}` : file,
    ];
    const runOnce = () => new Promise<number>(resolve => {
      this.out.appendLine(`> ${engine} ${args.join(' ')}`);
      const p = cp.spawn(engine, args, { cwd: dir, shell: false });
      p.stdout.on('data', b => this.out.append(b.toString()));
      p.stderr.on('data', b => this.out.append(b.toString()));
      p.on('error', err => {
        vscode.window.showErrorMessage(`Non riesco ad avviare ${engine}: ${err.message}. È nel PATH?`);
        resolve(-1);
      });
      p.on('close', code => resolve(code ?? -1));
    });
    let code = -1;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: opts.title ?? `Compilo ${file}…` }, async () => {
      for (let pass = 0; pass < 3; pass++) {
        code = await runOnce();
        if (code < 0) { return; }
        let log = '';
        try { log = fs.readFileSync(path.join(dir, jobname + '.log'), 'latin1'); } catch { /* niente */ }
        if (!/Rerun to get|Label\(s\) may have changed|Rerun LaTeX/.test(log)) { break; }
      }
    });
    this.lastEngine = path.basename(engine);
    if (code > 0 && !opts.quiet) { this.showErrors(rootFile, path.join(dir, jobname)); }
    return code === 0;
  }

  private lastEngine = 'pdflatex';

  /** Avviso col primo errore del log (`jobPath` = percorso senza estensione). */
  private showErrors(rootFile: string, jobPath: string) {
    const errs = this.errorsFromLog(jobPath + '.log');
    vscode.window.showWarningMessage(
      `${this.lastEngine}: errori nella compilazione di ${path.basename(jobPath)}${errs ? ` — ${errs}` : ''}`, 'Mostra log')
      .then(c => { if (c) { this.out.show(); } });
  }

  /** Primo errore del log, in breve ("appunti.tex:120: Undefined control sequence"). */
  private errorsFromLog(logFile: string): string {
    try {
      const log = fs.readFileSync(logFile, 'latin1');
      const m = /^(?:.*?([^\\/\n]+\.tex):(\d+): |! )(.+)$/m.exec(log);
      return m ? (m[1] ? `${m[1]}:${m[2]}: ` : '') + m[3].trim() : '';
    } catch { return ''; }
  }

  dispose() {
    if (this.timer) { clearTimeout(this.timer); }
    this.disposables.forEach(d => d.dispose());
  }
}
