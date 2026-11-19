import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  EvidColor, PASTELLI, parseDefineColors, updateColorsFile, displayName,
} from './colorsfile';
import { cfg } from './config';

const MAX_RECENTI = 8;

/**
 * Sa quali colori esistono (palette, preferiti, recenti, file del progetto)
 * e tiene aggiornato evid-colori.tex.
 */
export class ColorStore implements vscode.Disposable {
  /** nome → hex, per le decorazioni (sincrono) */
  private projectColors = new Map<string, EvidColor[]>(); // dir → colori dal file
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.tex');
    const reload = (u: vscode.Uri) => {
      if (path.basename(u.fsPath).toLowerCase() === (cfg().fileColori + '.tex').toLowerCase()) {
        this.loadDir(path.dirname(u.fsPath));
      }
    };
    w.onDidChange(reload, null, this.disposables);
    w.onDidCreate(reload, null, this.disposables);
    w.onDidDelete(reload, null, this.disposables);
    this.disposables.push(w, this.emitter);
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }

  colorsFilePath(rootFile: string): string {
    return path.join(path.dirname(rootFile), cfg().fileColori + '.tex');
  }

  /** Legge (una volta) i colori definiti accanto al file principale. */
  ensureLoaded(rootFile: string) {
    const dir = path.dirname(rootFile);
    if (!this.projectColors.has(dir)) { this.loadDir(dir); }
  }

  private loadDir(dir: string) {
    const file = path.join(dir, cfg().fileColori + '.tex');
    let colors: EvidColor[] = [];
    try { colors = parseDefineColors(fs.readFileSync(file, 'utf8')); } catch { /* non esiste */ }
    this.projectColors.set(dir, colors);
    this.emitter.fire();
  }

  // ---- preferiti / recenti / attivo -------------------------------------

  get recenti(): EvidColor[] { return this.ctx.globalState.get<EvidColor[]>('evid.recenti', []); }
  get preferiti(): EvidColor[] { return this.ctx.globalState.get<EvidColor[]>('evid.preferiti', []); }

  async addRecent(c: EvidColor) {
    const list = [c, ...this.recenti.filter(r => r.name !== c.name)].slice(0, MAX_RECENTI);
    await this.ctx.globalState.update('evid.recenti', list);
  }

  isFavorite(c: EvidColor) { return this.preferiti.some(p => p.name === c.name); }

  async toggleFavorite(c: EvidColor) {
    const list = this.isFavorite(c)
      ? this.preferiti.filter(p => p.name !== c.name)
      : [...this.preferiti, c];
    await this.ctx.globalState.update('evid.preferiti', list);
    this.emitter.fire();
  }

  get active(): EvidColor {
    const saved = this.ctx.workspaceState.get<EvidColor>('evid.attivo');
    return saved ?? this.byName(cfg().colorePredefinito) ?? PASTELLI[0];
  }

  async setActive(c: EvidColor) {
    await this.ctx.workspaceState.update('evid.attivo', c);
    this.emitter.fire();
  }

  // ---- ricerca -------------------------------------------------------------

  /** Tutti i colori conosciuti, senza duplicati (vince il primo). */
  all(rootFile?: string): EvidColor[] {
    const seen = new Map<string, EvidColor>();
    const add = (list: EvidColor[]) => list.forEach(c => { if (!seen.has(c.name)) { seen.set(c.name, c); } });
    if (rootFile) { add(this.projectColors.get(path.dirname(rootFile)) ?? []); }
    for (const l of this.projectColors.values()) { add(l); }
    add(PASTELLI);
    add(this.preferiti);
    add(this.recenti);
    return [...seen.values()];
  }

  byName(name: string, rootFile?: string): EvidColor | undefined {
    return this.all(rootFile).find(c => c.name === name);
  }

  /** Colori definiti nel file del progetto (per il QuickPick) */
  projectOnly(rootFile: string): EvidColor[] {
    return this.projectColors.get(path.dirname(rootFile)) ?? [];
  }

  // ---- legenda ---------------------------------------------------------------

  legend(): Record<string, string> { return cfg().legenda; }

  label(c: EvidColor | string): string | undefined {
    const name = typeof c === 'string' ? c : c.name;
    return this.legend()[name] || undefined;
  }

  /** "Rosa — Definizioni" */
  describe(c: EvidColor): string {
    const l = this.label(c);
    return l ? `${displayName(c)} — ${l}` : displayName(c);
  }

  async setLabel(c: EvidColor, label: string) {
    const conf = vscode.workspace.getConfiguration('evid');
    const legend = { ...this.legend() };
    if (label.trim()) { legend[c.name] = label.trim(); } else { delete legend[c.name]; }
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await conf.update('legenda', legend, target);
    this.emitter.fire();
  }

  // ---- file evid-colori.tex -----------------------------------------------------

  /**
   * Si assicura che `colors` siano definiti in evid-colori.tex (lo crea con la
   * palette pastello se manca) e riscrive la legenda. Restituisce true se ha scritto.
   */
  async writeColorsFile(rootFile: string, colors: EvidColor[]): Promise<boolean> {
    const file = this.colorsFilePath(rootFile);
    let existing: string | undefined;
    try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = undefined; }
    const required = existing === undefined ? [...PASTELLI, ...colors] : colors;
    // anche i colori della legenda devono esistere, se no \legendaevid non compila
    for (const name of Object.keys(this.legend())) {
      const c = this.byName(name, rootFile);
      if (c && !required.some(r => r.name === c.name)) { required.push(c); }
    }
    const next = updateColorsFile(existing, required, cfg().comando, this.legend());
    if (next === existing) { return false; }
    // se il file è aperto e modificato nell'editor, scriviamo lì per non creare conflitti
    const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === file.toLowerCase());
    if (open && open.isDirty) {
      const ed = new vscode.WorkspaceEdit();
      ed.replace(open.uri, new vscode.Range(0, 0, open.lineCount, 0), next);
      await vscode.workspace.applyEdit(ed);
      await open.save();
    } else {
      fs.writeFileSync(file, next, 'utf8');
    }
    this.loadDir(path.dirname(rootFile));
    return true;
  }

  // ---- icone per il QuickPick ------------------------------------------------------

  swatchUri(c: EvidColor): vscode.Uri {
    const dir = path.join(this.ctx.globalStorageUri.fsPath, 'swatch');
    const file = path.join(dir, c.hex + '.svg');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file,
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
        `<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="#${c.hex}" stroke="#808080" stroke-opacity="0.6"/></svg>`);
    }
    return vscode.Uri.file(file);
  }
}
