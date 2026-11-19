/**
 * Palette e file evid-colori.tex (logica pura, senza `vscode`).
 */

export interface EvidColor {
  name: string;
  /** RRGGBB maiuscolo, senza # */
  hex: string;
}

export const PASTELLI: EvidColor[] = [
  { name: 'evidGiallo', hex: 'FFF3B0' },
  { name: 'evidPesca', hex: 'FFD8BE' },
  { name: 'evidRosa', hex: 'FFD6E0' },
  { name: 'evidLilla', hex: 'E0D4F7' },
  { name: 'evidAzzurro', hex: 'CDE7F9' },
  { name: 'evidMenta', hex: 'CFF0D8' },
  { name: 'evidSalvia', hex: 'DDE8C9' },
];

export function normalizeHex(h: string): string | undefined {
  let s = h.trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{3}$/.test(s)) { s = s.split('').map(c => c + c).join(''); }
  return /^[0-9A-F]{6}$/.test(s) ? s : undefined;
}

/** Nome leggibile automatico: "evidC8E6F5" */
export function autoName(hex: string): string {
  return 'evid' + hex.toUpperCase();
}

/** Nome valido per \definecolor (solo lettere e cifre, niente spazi). */
export function isValidColorName(n: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(n);
}

/** Nome "umano" per l'interfaccia: evidRosa → Rosa, evidC8E6F5 → #C8E6F5 */
export function displayName(c: EvidColor): string {
  if (c.name === autoName(c.hex)) { return '#' + c.hex; }
  return c.name.replace(/^evid/, '') || c.name;
}

/** Tutte le \definecolor{nome}{HTML}{RRGGBB} del testo. */
export function parseDefineColors(text: string): EvidColor[] {
  const out: EvidColor[] = [];
  const re = /^[^%\n]*?\\definecolor\s*\{([^}]+)\}\s*\{\s*HTML\s*\}\s*\{\s*([0-9A-Fa-f]{6})\s*\}/gm;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    out.push({ name: m[1].trim(), hex: m[2].toUpperCase() });
  }
  return out;
}

const HEADER = `% --- evid-colori.tex ---------------------------------------------------
% File gestito dall'estensione "Evidenziatore LaTeX".
% Puoi aggiungere colori a mano con \\definecolor{nome}{HTML}{RRGGBB}:
% l'estensione li riconosce. Il blocco \\legendaevid viene riscritto.
`;

const LEG_BEGIN = '% >>> legenda (generata automaticamente, non modificare) >>>';
const LEG_END = '% <<< legenda <<<';

export function escapeLatex(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, c => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&',
    '#': '\\#', '^': '\\^{}', '_': '\\_', '%': '\\%', '~': '\\~{}',
  } as Record<string, string>)[c]);
}

export function legendBlock(cmd: string, colors: EvidColor[], legend: Record<string, string>): string {
  const items = colors
    .filter(c => legend[c.name])
    .map(c => `  \\${cmd}[${c.name}]{${escapeLatex(legend[c.name])}}`);
  const body = items.length
    ? `\\par\\noindent\\textbf{Legenda evidenziazioni}\\par\\noindent\n${items.join('\\quad\n')}\\par`
    : '';
  return `${LEG_BEGIN}\n\\providecommand{\\legendaevid}{}\n\\renewcommand{\\legendaevid}{${body}}\n${LEG_END}\n`;
}

/**
 * Restituisce il nuovo contenuto del file colori:
 * - mantiene tutto quello che c'era (anche righe scritte a mano);
 * - aggiunge le \definecolor mancanti;
 * - riscrive il blocco della legenda.
 */
export function updateColorsFile(
  existing: string | undefined,
  required: EvidColor[],
  cmd: string,
  legend: Record<string, string>,
): string {
  let text = existing ?? HEADER;
  // togli la vecchia legenda
  const b = text.indexOf(LEG_BEGIN);
  const e = text.indexOf(LEG_END);
  if (b >= 0 && e > b) {
    text = text.slice(0, b) + text.slice(e + LEG_END.length).replace(/^\r?\n/, '');
  }
  const defined = new Set(parseDefineColors(text).map(c => c.name));
  const missing = required.filter((c, i) => !defined.has(c.name) && required.findIndex(r => r.name === c.name) === i);
  if (!text.endsWith('\n')) { text += '\n'; }
  for (const c of missing) {
    text += `\\definecolor{${c.name}}{HTML}{${c.hex}}\n`;
  }
  const all = parseDefineColors(text);
  text += legendBlock(cmd, all, legend);
  return text;
}

export type Engine = 'pdflatex' | 'lualatex';

export const BLOCK_BEGIN = '% --- Evidenziatore LaTeX';
export const BLOCK_END = '% --- fine Evidenziatore LaTeX ---';
export const BLOCK_VERSION = 'v3';

/** Blocco da inserire nel preambolo: \evid[colore][nota]{testo}, \evidnota, PDF pulito. */
export function preambleBlock(engine: Engine, cmd: string, colorsBase: string, defaultColor: string): string {
  const hl = engine === 'lualatex' ? `\\highLight[#1]{#3}` : `{\\sethlcolor{#1}\\hl{#3}}`;
  const pkgs = engine === 'lualatex' ? `\\usepackage{luacolor,lua-ul}` : `\\usepackage{soul}`;
  const soulReg = engine === 'lualatex' ? '' : `% riferimenti che soul deve lasciar passare dentro \\hl
\\AtBeginDocument{\\soulregister\\cite7\\soulregister\\ref7\\soulregister\\pageref7
  \\ifdefined\\eqref\\soulregister\\eqref7\\fi
  \\ifdefined\\autoref\\soulregister\\autoref7\\fi
  \\ifdefined\\cref\\soulregister\\cref7\\fi}
`;
  return `${BLOCK_BEGIN} ${BLOCK_VERSION} (${engine === 'lualatex' ? 'LuaLaTeX' : 'pdfLaTeX'}) ---
\\usepackage{xcolor}
${pkgs}
\\usepackage{marginnote}
\\input{${colorsBase}}
% \\${cmd}[colore][nota]{testo}  (anche dentro le formule)
\\NewDocumentCommand{\\${cmd}}{O{${defaultColor}} o m}{%
  \\ifmmode\\evidmath{#1}{#3}\\else${hl}\\fi\\IfValueT{#2}{\\evidnota[#1]{#2}}}
% in matematica \\hl non funziona: sfondo colorato che rispetta lo stile (display, indici…)
\\newcommand{\\evidmath}[2]{\\mathchoice
  {\\evidmbox{#1}{\\displaystyle#2}}{\\evidmbox{#1}{\\textstyle#2}}%
  {\\evidmbox{#1}{\\scriptstyle#2}}{\\evidmbox{#1}{\\scriptscriptstyle#2}}}
\\newcommand{\\evidmbox}[2]{{\\setlength{\\fboxsep}{0.5pt}\\colorbox{#1}{$#2$}}}
% nota: a margine se c'è spazio, altrimenti a piè di pagina
\\newlength{\\evidmargine}
\\AtBeginDocument{\\setlength{\\evidmargine}{\\dimexpr\\paperwidth-1in-\\oddsidemargin-\\hoffset-\\textwidth-\\marginparsep-5mm\\relax}}
\\NewDocumentCommand{\\evidnota}{O{${defaultColor}} m}{%
  \\ifdim\\evidmargine>2cm
    \\marginnote{\\colorbox{#1}{\\parbox[t]{\\dimexpr\\evidmargine-2\\fboxsep\\relax}{\\raggedright\\footnotesize #2}}}%
  \\else
    \\footnote{\\colorbox{#1}{\\strut\\footnotesize\\textbf{Nota}}\\ #2}%
  \\fi}
${soulReg}\\ifdefined\\evidpulito
  \\RenewDocumentCommand{\\${cmd}}{O{} o m}{#3}
  \\RenewDocumentCommand{\\evidnota}{O{} m}{}
\\fi
${BLOCK_END}
`;
}

/**
 * Se il preambolo contiene un blocco dell'estensione di una versione vecchia,
 * restituisce il testo con il blocco aggiornato; altrimenti undefined.
 */
export function upgradePreamble(text: string, engine: Engine, cmd: string, colorsBase: string, defaultColor: string): string | undefined {
  const b = text.indexOf(BLOCK_BEGIN + ' ');
  const bv = text.indexOf(BLOCK_BEGIN + ' (');
  const start = b >= 0 ? b : bv;
  if (start < 0) { return undefined; }
  const header = text.slice(start, text.indexOf('\n', start));
  if (header.includes(` ${BLOCK_VERSION} `)) { return undefined; }
  const e = text.indexOf(BLOCK_END, start);
  if (e < 0) { return undefined; }
  let end = e + BLOCK_END.length;
  if (text[end] === '\r') { end++; }
  if (text[end] === '\n') { end++; }
  return text.slice(0, start) + preambleBlock(engine, cmd, colorsBase, defaultColor) + text.slice(end);
}

/** Prepara il testo di una nota per l'argomento facoltativo [..]. */
export function noteArg(note: string): string {
  let s = note.replace(/\r?\n/g, ' ').trim().replace(/(^|[^\\])([%&#])/g, '$1\\$2');
  if (/[\][]/.test(s)) { s = `{${s}}`; }
  return s;
}
