/**
 * Riassunto delle evidenziazioni (LaTeX e Markdown) e utilità di testo.
 * Nessun import di `vscode`.
 */
import { EvidMatch, findEvids, findHeadings, Heading } from './parser';
import { escapeLatex, EvidColor, displayName } from './colorsfile';

export interface Item {
  file: string;
  line: number;          // 0-based
  start: number;         // offset nel file
  color: string;         // nome colore effettivo
  content: string;       // LaTeX dentro \evid{...}
  note?: string;
  /** titoli delle sezioni che contengono l'evidenziazione, dal più esterno */
  sections: Heading[];
}

/** Sezioni aperte (una per livello) nel punto `offset`. */
export function sectionChain(headings: Heading[], offset: number): Heading[] {
  const chain: Heading[] = [];
  for (const h of headings) {
    if (h.offset > offset) { break; }
    while (chain.length && chain[chain.length - 1].level >= h.level) { chain.pop(); }
    chain.push(h);
  }
  return chain;
}

/** Evidenziazioni di un testo con la loro sezione. Gli \evid annidati sono saltati. */
export function itemsOf(file: string, text: string, cmd: string, defaultColor: string,
  inherited: Heading[] = []): Item[] {
  const headings = findHeadings(text);
  const evids = findEvids(text, cmd);
  const top = evids.filter(e => !evids.some(o => o !== e && o.start <= e.start && o.end >= e.end));
  return top.map((e: EvidMatch) => {
    const local = sectionChain(headings, e.start);
    // le sezioni del file padre valgono finché il figlio non ne apre di sue
    const minLocal = local.length ? Math.min(...local.map(h => h.level)) : Infinity;
    const sections = [...inherited.filter(h => h.level < minLocal), ...local];
    return {
      file, start: e.start,
      line: text.slice(0, e.start).split('\n').length - 1,
      color: e.color || defaultColor,
      content: text.slice(e.contentStart, e.contentEnd),
      note: e.note?.replace(/^\{([\s\S]*)\}$/, '$1'),
      sections,
    };
  });
}

/** \input{..} / \include{..} fuori dai commenti, con offset. */
export function findInputs(text: string): { offset: number; name: string }[] {
  const out: { offset: number; name: string }[] = [];
  const re = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    const ls = text.lastIndexOf('\n', m.index) + 1;
    if (/(^|[^\\])%/.test(text.slice(ls, m.index))) { continue; }
    out.push({ offset: m.index, name: m[1].trim() });
  }
  return out;
}

/** Testo leggibile da un pezzo di LaTeX (per il pannello e il Markdown). */
export function plainText(latex: string): string {
  let s = latex;
  s = s.replace(/(^|[^\\])%.*$/gm, '$1');
  s = s.replace(/\\(?:label|ref|eqref|cite|footnote|index)\*?\s*(\[[^\]]*\])?\s*\{[^{}]*\}/g, '');
  s = s.replace(/\\(['`^"~=.])\{?([A-Za-z])\}?/g, (_, a: string, l: string) =>
    l.normalize('NFD') + ({ "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307' } as Record<string, string>)[a]);
  s = s.normalize('NFC');
  s = s.replace(/\\([%&#_$])/g, '$1');
  s = s.replace(/\\\\/g, ' ');
  s = s.replace(/~/g, ' ');
  // tieni la matematica com'è, togli i comandi di testo lasciando l'argomento
  s = s.replace(/\\[A-Za-z@]+\*?(\s*\[[^\]]*\])?/g, (m, _o, off: number, all: string) => inMath(all, off) ? m : '');
  s = s.replace(/(?<!\\)[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function inMath(s: string, off: number): boolean {
  let n = 0;
  for (let i = 0; i < off; i++) { if (s[i] === '$' && s[i - 1] !== '\\') { n++; } }
  return n % 2 === 1;
}

/** Converte (approssimativamente) LaTeX in Markdown, lasciando la matematica. */
export function latexToMarkdown(latex: string): string {
  let s = latex.replace(/(^|[^\\])%.*$/gm, '$1');
  s = s.replace(/\\textbf\{([^{}]*)\}/g, '**$1**');
  s = s.replace(/\\(?:emph|textit)\{([^{}]*)\}/g, '*$1*');
  s = s.replace(/\\texttt\{([^{}]*)\}/g, '`$1`');
  return plainText(s);
}

export type Order = 'sezione' | 'colore';

export interface SummaryOptions {
  order: Order;
  cmd: string;
  title: string;
  colors: EvidColor[];
  legend: Record<string, string>;
}

const SEC_CMD = ['section*', 'subsection*', 'subsubsection*', 'paragraph*'];

function stripLabels(s: string) {
  return s.replace(/\\label\s*\{[^{}]*\}/g, '');
}

function colorTitle(name: string, o: SummaryOptions): string {
  const c = o.colors.find(x => x.name === name);
  const label = o.legend[name];
  const disp = c ? displayName(c) : name;
  return label ? `${disp} — ${label}` : disp;
}

/** Ordina le voci in gruppi: [titoli di gruppo, voci]. */
function groups(items: Item[], o: SummaryOptions): { path: Heading[]; colorGroup?: string; items: Item[] }[] {
  if (o.order === 'colore') {
    const order: string[] = [];
    o.colors.forEach(c => { if (items.some(i => i.color === c.name)) { order.push(c.name); } });
    items.forEach(i => { if (!order.includes(i.color)) { order.push(i.color); } });
    return order.map(name => ({ path: [], colorGroup: name, items: items.filter(i => i.color === name) }));
  }
  const out: { path: Heading[]; items: Item[] }[] = [];
  for (const it of items) {
    const key = it.sections.map(h => h.offset + ':' + h.title).join('|');
    const last = out[out.length - 1];
    if (last && last.path.map(h => h.offset + ':' + h.title).join('|') === key) { last.items.push(it); }
    else { out.push({ path: it.sections, items: [it] }); }
  }
  return out;
}

/** Corpo LaTeX del riassunto (da mettere dopo il preambolo degli appunti). */
export function summaryBody(items: Item[], o: SummaryOptions): string {
  const lines: string[] = [];
  lines.push('\\begin{document}');
  lines.push(`\\begin{center}{\\Large\\bfseries ${escapeLatex(o.title)}}\\\\[2pt]{\\small Riassunto delle evidenziazioni}\\end{center}`);
  if (Object.keys(o.legend).length) { lines.push('\\ifdefined\\legendaevid\\legendaevid\\fi\\medskip'); }
  if (!items.length) { lines.push('Nessuna evidenziazione.'); }
  // il livello più alto usato negli appunti diventa \section*
  const minLevel = Math.min(...items.flatMap(i => i.sections.map(h => h.level)), 99);
  let prevPath: Heading[] = [];
  for (const g of groups(items, o)) {
    if (g.colorGroup) {
      lines.push(`\\section*{\\colorbox{${g.colorGroup}}{${escapeLatex(colorTitle(g.colorGroup, o))}}}`);
    } else {
      // stampa solo i titoli che cambiano rispetto al gruppo precedente
      let k = 0;
      while (k < g.path.length && k < prevPath.length && g.path[k].offset === prevPath[k].offset && g.path[k].title === prevPath[k].title) { k++; }
      for (let i = k; i < g.path.length; i++) {
        const h = g.path[i];
        lines.push(`\\${SEC_CMD[Math.min(h.level - minLevel, SEC_CMD.length - 1)]}{${stripLabels(h.title)}}`);
      }
      prevPath = g.path;
    }
    lines.push('\\begin{itemize}');
    for (const it of g.items) {
      lines.push(`  \\item \\${o.cmd}[${it.color}]{${stripLabels(it.content)}}`);
      if (it.note) { lines.push(`    \\par{\\footnotesize\\textit{Nota:} ${it.note}}`); }
    }
    lines.push('\\end{itemize}');
  }
  lines.push('\\end{document}');
  return lines.join('\n') + '\n';
}

/** Riassunto completo: preambolo degli appunti + corpo. */
export function summaryTex(rootText: string, items: Item[], o: SummaryOptions): string {
  const bd = /\\begin\s*\{document\}/.exec(rootText);
  const preamble = bd ? rootText.slice(0, bd.index) : '\\documentclass{article}\n';
  return `% Riassunto generato dall'Evidenziatore LaTeX — verrà riscritto, non modificarlo.\n${preamble}${summaryBody(items, o)}`;
}

/** Riassunto in Markdown (la matematica resta tra $…$). */
export function summaryMarkdown(items: Item[], o: SummaryOptions): string {
  const hex = (name: string) => o.colors.find(c => c.name === name)?.hex ?? 'FFF3B0';
  const out: string[] = [`# ${o.title}`, '', '_Riassunto delle evidenziazioni_', ''];
  const minLevel = Math.min(...items.flatMap(i => i.sections.map(h => h.level)), 99);
  let prevPath: Heading[] = [];
  for (const g of groups(items, o)) {
    if (g.colorGroup) {
      out.push(`## <span style="background:#${hex(g.colorGroup)};color:#1f1f1f;padding:0 4px">${colorTitle(g.colorGroup, o)}</span>`, '');
    } else {
      let k = 0;
      while (k < g.path.length && k < prevPath.length && g.path[k].offset === prevPath[k].offset) { k++; }
      for (let i = k; i < g.path.length; i++) {
        const h = g.path[i];
        out.push(`${'#'.repeat(Math.min(6, 2 + h.level - minLevel))} ${plainText(h.title)}`, '');
      }
      prevPath = g.path;
    }
    for (const it of g.items) {
      out.push(`- <mark style="background:#${hex(it.color)};color:#1f1f1f">${latexToMarkdown(it.content)}</mark>`);
      if (it.note) { out.push(`  - _Nota:_ ${latexToMarkdown(it.note)}`); }
    }
    out.push('');
  }
  return out.join('\n');
}
