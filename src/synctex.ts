import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface SyncResult { file: string; line: number; /** 0-based */ }

let resolvedExe: string | undefined;

/** Trova synctex: impostazione, PATH, oppure accanto al pdflatex di LaTeX Workshop. */
function candidates(): string[] {
  const set = vscode.workspace.getConfiguration('evid').get<string>('pdf.synctex', '').trim();
  const out: string[] = [];
  if (set) { out.push(set); }
  out.push('synctex');
  const tools = vscode.workspace.getConfiguration('latex-workshop').get<{ command: string }[]>('latex.tools', []);
  for (const t of tools) {
    if (path.isAbsolute(t.command)) {
      out.push(path.join(path.dirname(t.command), process.platform === 'win32' ? 'synctex.exe' : 'synctex'));
    }
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64', 'synctex.exe'));
  }
  if (process.platform !== 'win32') {
    // TeX Live installato a mano (non nel PATH di VS Code) e MacTeX
    const tl = '/usr/local/texlive';
    try {
      for (const year of fs.readdirSync(tl).filter(d => /^\d{4}$/.test(d)).sort().reverse()) {
        const bin = path.join(tl, year, 'bin');
        try { for (const arch of fs.readdirSync(bin)) { out.push(path.join(bin, arch, 'synctex')); } } catch { /* niente */ }
      }
    } catch { /* niente TeX Live in /usr/local */ }
    out.push('/Library/TeX/texbin/synctex', '/usr/bin/synctex');
  }
  return out;
}

function run(exe: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(exe, args, { cwd, timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { reject(err); return; }
      resolve(stdout ?? '');
    });
  });
}

/**
 * SyncTeX inverso: punto della pagina (in punti tipografici, origine in alto a
 * sinistra) → file e riga del sorgente. undefined se non disponibile.
 */
export async function syncEdit(pdfPath: string, page: number, x: number, y: number): Promise<SyncResult | undefined> {
  const dir = path.dirname(pdfPath);
  const args = ['edit', '-o', `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${pdfPath}`];
  const list = resolvedExe ? [resolvedExe] : candidates();
  for (const exe of list) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) { continue; }
    let out: string;
    try { out = await run(exe, args, dir); } catch { continue; }
    resolvedExe = exe;
    const input = /^Input:(.+)$/m.exec(out)?.[1]?.trim();
    const line = Number(/^Line:(-?\d+)$/m.exec(out)?.[1]);
    if (!input || !(line > 0)) { return undefined; }
    const file = path.resolve(dir, input);
    return { file: fs.existsSync(file) ? file : input, line: line - 1 };
  }
  return undefined;
}

/** SyncTeX in avanti: riga del sorgente (0-based) → pagina e punto nel PDF (punti, origine in alto a sinistra). */
export async function syncView(pdfPath: string, texFile: string, line: number, column = 0): Promise<{ page: number; x: number; y: number } | undefined> {
  const dir = path.dirname(pdfPath);
  const args = ['view', '-i', `${line + 1}:${column}:${texFile}`, '-o', pdfPath];
  const list = resolvedExe ? [resolvedExe] : candidates();
  for (const exe of list) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) { continue; }
    let out: string;
    try { out = await run(exe, args, dir); } catch { continue; }
    resolvedExe = exe;
    const page = Number(/^Page:(\d+)/m.exec(out)?.[1]);
    const x = Number(/^x:([\d.]+)/m.exec(out)?.[1]);
    const y = Number(/^y:([\d.]+)/m.exec(out)?.[1]);
    if (!(page > 0)) { return undefined; }
    return { page, x: x || 0, y: y || 0 };
  }
  return undefined;
}

export function synctexAvailable(pdfPath: string): boolean {
  const base = pdfPath.replace(/\.pdf$/i, '');
  return fs.existsSync(base + '.synctex.gz') || fs.existsSync(base + '.synctex');
}
