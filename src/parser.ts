/**
 * Analisi del sorgente LaTeX: trova i \evid{...} e prepara selezioni "sicure"
 * da avvolgere senza rompere il documento.
 *
 * Questo modulo NON importa `vscode`, così si può testare con Node puro.
 * Tutte le posizioni sono offset nel testo (0-based).
 */

export interface EvidMatch {
  /** inizio di "\evid" */
  start: number;
  /** subito dopo la "}" finale */
  end: number;
  /** nome del colore (primo argomento facoltativo), undefined = predefinito */
  color?: string;
  /** secondo argomento facoltativo (nota, Fase D) */
  note?: string;
  /** inizio del contenuto (dopo "{") */
  contentStart: number;
  /** fine del contenuto (posizione della "}" finale) */
  contentEnd: number;
  /** fine dell'intestazione "\evid[..]{" — = contentStart */
  headerEnd: number;
}

export interface Segment {
  start: number;
  end: number;
}

const isLetter = (c: string) => /[A-Za-z@]/.test(c);

/** Restituisce true se il carattere in `pos` è preceduto da un numero dispari di "\" */
export function isEscaped(text: string, pos: number): boolean {
  let n = 0;
  for (let i = pos - 1; i >= 0 && text[i] === '\\'; i--) { n++; }
  return n % 2 === 1;
}

/**
 * Trova la fine di un gruppo bilanciato che inizia con `open` in `pos`.
 * Restituisce la posizione del carattere di chiusura, oppure -1.
 * Ignora le parentesi precedute da "\" e i commenti.
 */
export function findClosing(text: string, pos: number, open = '{', close = '}'): number {
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === '%' && !isEscaped(text, i)) {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { return -1; }
      i = nl;
      continue;
    }
    if (isEscaped(text, i)) { continue; }
    if (c === open) { depth++; }
    else if (c === close) {
      depth--;
      if (depth === 0) { return i; }
    }
  }
  return -1;
}

/** Argomento facoltativo [..] che inizia in `pos` (dopo eventuali spazi). */
function readOptional(text: string, pos: number): { value: string; end: number } | undefined {
  let i = pos;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) { i++; }
  if (text[i] !== '[') { return undefined; }
  // le [] possono contenere {} (es. una nota con comandi): rispettiamo le graffe
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (isEscaped(text, j)) { continue; }
    if (c === '{') { depth++; }
    else if (c === '}') { depth--; }
    else if (c === ']' && depth === 0) {
      return { value: text.slice(i + 1, j), end: j + 1 };
    }
    else if (c === '\n' && text[j + 1] === '\n') { return undefined; }
  }
  return undefined;
}

/** Trova tutti i \<cmd>[..][..]{...} del testo, saltando i commenti. */
export function findEvids(text: string, cmd = 'evid'): EvidMatch[] {
  const out: EvidMatch[] = [];
  const needle = '\\' + cmd;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '%' && !isEscaped(text, i)) {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { break; }
      i = nl + 1;
      continue;
    }
    if (c === '\\' && text.startsWith(needle, i) && !isEscaped(text, i)
        && !isLetter(text[i + needle.length] ?? '')) {
      const m = parseEvidAt(text, i, needle.length);
      if (m) {
        out.push(m);
        // continuiamo DENTRO il contenuto, così troviamo anche eventuali annidati
        i = m.contentStart;
        continue;
      }
    }
    i++;
  }
  return out;
}

function parseEvidAt(text: string, start: number, nameLen: number): EvidMatch | undefined {
  let p = start + nameLen;
  let color: string | undefined;
  let note: string | undefined;
  const o1 = readOptional(text, p);
  if (o1) {
    color = o1.value.trim() || undefined;
    p = o1.end;
    const o2 = readOptional(text, p);
    if (o2) { note = o2.value; p = o2.end; }
  }
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) { p++; }
  if (text[p] !== '{') { return undefined; }
  const close = findClosing(text, p);
  if (close < 0) { return undefined; }
  return { start, end: close + 1, color, note, contentStart: p + 1, contentEnd: close, headerEnd: p + 1 };
}

/** L'evidenziazione più interna che contiene l'intervallo [from, to]. */
export function evidAt(evids: EvidMatch[], from: number, to = from): EvidMatch | undefined {
  let best: EvidMatch | undefined;
  for (const e of evids) {
    if (e.start <= from && to <= e.end) {
      if (!best || e.end - e.start < best.end - best.start) { best = e; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Preparazione di una selezione da evidenziare
// ---------------------------------------------------------------------------

export interface WrapOptions {
  cmd: string;
  /** colore da scrivere come argomento; undefined = colore predefinito (nessun [..]) */
  color?: string;
  /** con pdfLaTeX (soul) la matematica va lasciata fuori da \hl */
  splitMath: boolean;
}

export interface WrapResult {
  /** intervallo del testo originale da sostituire */
  start: number;
  end: number;
  /** nuovo testo */
  text: string;
  /** quanti \evid sono stati creati */
  count: number;
}

/**
 * Allarga la selezione in modo che:
 * - non inizi a metà di un nome di comando (es. "extbf");
 * - includa per intero ogni \evid che tocca parzialmente.
 */
export function expandSelection(text: string, from: number, to: number, evids: EvidMatch[]): Segment {
  let s = from, e = to;
  // inizio a metà di \comando → torna al backslash
  let k = s;
  while (k > 0 && isLetter(text[k - 1])) { k--; }
  if (k > 0 && text[k - 1] === '\\' && k < s) { s = k - 1; }
  // fine a metà di \comando → vai alla fine del nome
  k = e;
  let j = e;
  while (j > 0 && isLetter(text[j - 1])) { j--; }
  if (j > 0 && text[j - 1] === '\\' && j < e) {
    while (k < text.length && isLetter(text[k])) { k++; }
    e = k;
  }
  // include evid sovrapposti (ripeti finché stabile)
  let changed = true;
  while (changed) {
    changed = false;
    for (const ev of evids) {
      const overlaps = ev.start < e && s < ev.end;
      if (overlaps && (ev.start < s || ev.end > e)) {
        s = Math.min(s, ev.start);
        e = Math.max(e, ev.end);
        changed = true;
      }
    }
  }
  return { start: s, end: e };
}

/** Sostituisce ogni \evid[..]{x} con x (anche annidati). */
export function unwrapAll(text: string, cmd: string): string {
  for (;;) {
    const evs = findEvids(text, cmd);
    if (evs.length === 0) { return text; }
    // togli dall'ultimo per non spostare gli offset
    evs.sort((a, b) => b.start - a.start);
    // basta togliere quelli più esterni a ogni giro
    let out = text;
    for (const e of evs) {
      out = out.slice(0, e.start) + out.slice(e.contentStart, e.contentEnd) + out.slice(e.end);
      break;
    }
    text = out;
  }
}

/**
 * Divide `text` in pezzi che si possono avvolgere in \evid{} da soli.
 * Separatori: righe vuote, \begin{..}/\end{..}, \item, \par, \\, commenti,
 * parentesi graffe sbilanciate e (se richiesto) la matematica.
 */
export function safeSegments(text: string, splitMath: boolean): Segment[] {
  // 1. Separatori espliciti: intervalli da escludere
  const cuts: Segment[] = [];
  const addCut = (s: number, e: number) => cuts.push({ start: s, end: e });

  const reSep = /\n[ \t]*\n|\\(?:begin|end)\s*\{[^}]*\}(?:\s*\[[^\]]*\])?|\\item\b(?:\s*\[[^\]]*\])?|\\(?:par|hline|newline|newpage|clearpage|noindent|indent|centering|raggedright|raggedleft|smallskip|medskip|bigskip|hfill|vfill)\b|\\[vh]space\*?\s*\{[^}]*\}|\\\\(?:\s*\[[^\]]*\])?|&/g;
  for (let m: RegExpExecArray | null; (m = reSep.exec(text));) {
    if ((m[0].startsWith('\\') || m[0] === '&') && isEscaped(text, m.index)) { continue; }
    addCut(m.index, m.index + m[0].length);
  }
  // comandi che non devono MAI finire dentro \evid: escludi comando + argomento
  const reArg = /\\(?:part|chapter|section|subsection|subsubsection|paragraph|label|caption|footnote|marginpar|index|includegraphics|input|include|vspace|hspace)\*?\s*(?:\[[^\]]*\])*\s*\{/g;
  for (let m: RegExpExecArray | null; (m = reArg.exec(text));) {
    if (isEscaped(text, m.index)) { continue; }
    const close = findClosing(text, m.index + m[0].length - 1);
    addCut(m.index, close < 0 ? text.length : close + 1);
  }
  // commenti
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && !isEscaped(text, i)) {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      addCut(i, end);
      i = end;
    }
  }
  // argomenti di \begin{..}[..]{..} e ambienti di codice/disegno (tikz, verbatim…)
  for (const f of forbiddenRegions(text)) { addCut(f.start, f.end); }
  // matematica: quella in display non può mai stare dentro \hl; quella in linea
  // solo se richiesto (pdfLaTeX). Il contenuto lo evidenzia buildWrap a parte.
  for (const m of mathRegions(text)) {
    if (splitMath || m.display) { addCut(m.start, m.end); }
  }
  // \left … \right vanno in coppia: non separarli
  const reLR = /\\(?:left|right|middle)\b\s*(?:\\[A-Za-z]+|\\.|[^\s])/g;
  for (let m: RegExpExecArray | null; (m = reLR.exec(text));) {
    if (!isEscaped(text, m.index)) { addCut(m.index, m.index + m[0].length); }
  }

  // 2. Pezzi tra i separatori
  cuts.sort((a, b) => a.start - b.start);
  let pieces: Segment[] = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.start > pos) { pieces.push({ start: pos, end: c.start }); }
    pos = Math.max(pos, c.end);
  }
  if (pos < text.length) { pieces.push({ start: pos, end: text.length }); }

  // 3. Graffe sbilanciate: spezza in corrispondenza di ogni graffa senza compagna
  pieces = pieces.flatMap(p => splitUnbalanced(text, p));

  // 4. Pulizia: niente spazi ai bordi, niente pezzi vuoti o fatti solo di punteggiatura
  const out: Segment[] = [];
  for (const p of pieces) {
    let s = p.start, e = p.end;
    while (s < e && /\s/.test(text[s])) { s++; }
    while (e > s && /\s/.test(text[e - 1])) { e--; }
    // non lasciare un "\comando" orfano alla fine (il suo argomento è stato tagliato
    // via: il pezzo finisce proprio su una graffa aperta). "\Theta" da solo va bene.
    const tail = /\\[A-Za-z@]+\*?\s*(\[[^\]]*\])?\s*$/.exec(text.slice(s, e));
    if (tail && !isEscaped(text, s + tail.index) && text[p.end] === '{') {
      e = s + tail.index;
      while (e > s && /\s/.test(text[e - 1])) { e--; }
    }
    const body = text.slice(s, e);
    if (body.length === 0 || /^[\s.,;:!?()\[\]~&-]*$/.test(body)) { continue; }
    out.push({ start: s, end: e });
  }
  return out;
}

/** Spezza un pezzo dove le graffe non sono bilanciate. */
function splitUnbalanced(text: string, p: Segment): Segment[] {
  const stack: number[] = [];
  const unmatched: number[] = [];
  for (let i = p.start; i < p.end; i++) {
    const c = text[i];
    if ((c === '{' || c === '}') && isEscaped(text, i)) { continue; }
    if (c === '{') { stack.push(i); }
    else if (c === '}') {
      if (stack.length) { stack.pop(); } else { unmatched.push(i); }
    }
  }
  unmatched.push(...stack);
  if (unmatched.length === 0) { return [p]; }
  unmatched.sort((a, b) => a - b);
  const res: Segment[] = [];
  let pos = p.start;
  for (const u of unmatched) {
    if (u > pos) { res.push({ start: pos, end: u }); }
    pos = u + 1;
  }
  if (pos < p.end) { res.push({ start: pos, end: p.end }); }
  return res;
}

/** Intervalli di matematica in linea/display: $..$, $$..$$, \(..\), \[..\] */
export function findMath(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '%' && !isEscaped(text, i)) {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { break; }
      i = nl + 1; continue;
    }
    if (c === '$' && !isEscaped(text, i)) {
      const dbl = text[i + 1] === '$';
      const delim = dbl ? '$$' : '$';
      let j = i + delim.length;
      while (j < text.length) {
        if (text.startsWith(delim, j) && !isEscaped(text, j)) { break; }
        j++;
      }
      const end = Math.min(text.length, j + delim.length);
      out.push({ start: i, end });
      i = end; continue;
    }
    if (c === '\\' && !isEscaped(text, i) && (text[i + 1] === '(' || text[i + 1] === '[')) {
      const closer = text[i + 1] === '(' ? '\\)' : '\\]';
      let j = text.indexOf(closer, i + 2);
      if (j < 0) { j = text.length; } else { j += 2; }
      out.push({ start: i, end: j });
      i = j; continue;
    }
    i++;
  }
  return out;
}

export interface MathRegion extends Segment {
  /** contenuto della formula, senza delimitatori */
  inStart: number;
  inEnd: number;
  /** formula in display ($$, \[, equation, align…): non può stare dentro \hl */
  display: boolean;
}

const MATH_ENVS = 'equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math';

/** Formule del testo, con i limiti del contenuto. Include gli ambienti matematici. */
export function mathRegions(text: string): MathRegion[] {
  const out: MathRegion[] = findMath(text).map(m => {
    const t = text.slice(m.start, m.start + 2);
    const d = t === '$$' || t === '\\[' || t === '\\(' ? 2 : 1;
    const closed = text.slice(m.end - d, m.end) === (t === '\\(' ? '\\)' : t === '\\[' ? '\\]' : t.slice(0, d));
    return { ...m, inStart: m.start + d, inEnd: closed ? m.end - d : m.end, display: t === '$$' || t === '\\[' };
  });
  const re = new RegExp(`\\\\begin\\s*\\{(${MATH_ENVS})(\\*?)\\}(\\s*\\{[^}]*\\})?`, 'g');
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    if (isEscaped(text, m.index) || inComment(text, m.index)) { continue; }
    const endTag = `\\end{${m[1]}${m[2]}}`;
    const e = text.indexOf(endTag, m.index + m[0].length);
    const inEnd = e < 0 ? text.length : e;
    out.push({
      start: m.index, end: e < 0 ? text.length : e + endTag.length,
      inStart: m.index + m[0].length, inEnd, display: m[1] !== 'math',
    });
    re.lastIndex = inEnd;
  }
  return out.sort((a, b) => a.start - b.start);
}

function inComment(text: string, pos: number): boolean {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  for (let i = ls; i < pos; i++) { if (text[i] === '%' && !isEscaped(text, i)) { return true; } }
  return false;
}

/**
 * Una selezione non deve mai tagliare a metà una formula: se ne prende solo un
 * pezzo (e non sta tutta dentro) la allarga alla formula intera.
 */
export function expandToMath(text: string, from: number, to: number, regions = mathRegions(text)): Segment {
  let s = from, e = to;
  if (regions.some(r => s >= r.inStart && e <= r.inEnd)) { return { start: s, end: e }; } // tutta dentro
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of regions) {
      if (r.start < e && s < r.end && (r.start < s || r.end > e)) {
        s = Math.min(s, r.start); e = Math.max(e, r.end); changed = true;
      }
    }
  }
  return { start: s, end: e };
}

/** "\begin{nome}[..]{..}": intervallo dal \begin alla fine dei suoi argomenti. */
export function beginArgs(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\\begin\s*\{[^}]*\}/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    if (isEscaped(text, m.index)) { continue; }
    let k = m.index + m[0].length;
    let end = k;
    for (;;) {
      let j = k;
      while (text[j] === ' ' || text[j] === '\t') { j++; }
      if (text[j] === '[') {
        let depth = 0, q = j;
        for (; q < text.length; q++) {
          if (text[q] === '{' && !isEscaped(text, q)) { depth++; }
          else if (text[q] === '}' && !isEscaped(text, q)) { depth--; }
          else if (text[q] === ']' && depth === 0) { break; }
        }
        k = end = q + 1;
      } else if (text[j] === '{') {
        const c = findClosing(text, j);
        if (c < 0) { break; }
        k = end = c + 1;
      } else { break; }
    }
    if (end > m.index + m[0].length) { out.push({ start: m.index, end }); }
  }
  return out;
}

/** Ambienti il cui contenuto è codice o disegno, non testo. */
const CODE_ENVS = 'tikzpicture|pgfpicture|axis|forest|circuitikz|verbatim|Verbatim|lstlisting|minted|comment|filecontents';

/** Zone dove \evid non deve mai finire: argomenti di \begin e ambienti di codice/disegno. */
export function forbiddenRegions(text: string): Segment[] {
  const out = beginArgs(text);
  const re = new RegExp(`\\\\begin\\s*\\{(${CODE_ENVS})(\\*?)\\}`, 'g');
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    if (isEscaped(text, m.index) || inComment(text, m.index)) { continue; }
    const endTag = `\\end{${m[1]}${m[2]}}`;
    const e = text.indexOf(endTag, m.index + m[0].length);
    const end = e < 0 ? text.length : e + endTag.length;
    out.push({ start: m.index, end });
    re.lastIndex = end;
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Posizione della '{' che apre la graffa chiusa in `close` (cercando all'indietro). */
function findOpening(text: string, close: number, lo: number): number {
  let depth = 0;
  for (let k = close; k >= lo; k--) {
    if ((text[k] === '{' || text[k] === '}') && isEscaped(text, k)) { continue; }
    if (text[k] === '}') { depth++; }
    else if (text[k] === '{') { depth--; if (depth === 0) { return k; } }
  }
  return lo;
}

/** Partendo da una '{', include ciò che la regge: gruppi precedenti, \comando, x^ / x_. */
function groupHead(text: string, s: number, lo: number): number {
  for (let guard = 0; guard < 20; guard++) {
    let k = s;
    while (k > lo && /\s/.test(text[k - 1])) { k--; }
    const p = text[k - 1];
    if (k <= lo) { return s; }
    if (p === '}' && !isEscaped(text, k - 1)) { s = findOpening(text, k - 1, lo); continue; } // \frac{a}{b}
    if (/[A-Za-z]/.test(p)) {
      let j = k;
      while (j > lo && /[A-Za-z]/.test(text[j - 1])) { j--; }
      return text[j - 1] === '\\' ? j - 1 : s;
    }
    if ((p === '^' || p === '_') && !isEscaped(text, k - 1)) {
      // includi anche la base: x^{..}, \alpha_{..}, {..}^{..}
      let b = k - 1;
      while (b > lo && /\s/.test(text[b - 1])) { b--; }
      const q = text[b - 1];
      if (q === '}') { s = findOpening(text, b - 1, lo); continue; }
      if (/[A-Za-z]/.test(q)) {
        let j = b;
        while (j > lo && /[A-Za-z]/.test(text[j - 1])) { j--; }
        return text[j - 1] === '\\' ? j - 1 : b - 1;
      }
      return b > lo ? b - 1 : b;
    }
    return s;
  }
  return s;
}

/**
 * Dentro una formula non si può spezzare: allarga la selezione finché le graffe
 * sono bilanciate e non finisce con un ^ o _ senza il suo argomento.
 */
export function balanceInMath(text: string, from: number, to: number, lo: number, hi: number): Segment {
  let s = from, e = to;
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    const open: number[] = [];
    let strayClose = -1;
    for (let i = s; i < e; i++) {
      const c = text[i];
      if ((c === '{' || c === '}') && isEscaped(text, i)) { continue; }
      if (c === '{') { open.push(i); }
      else if (c === '}') { if (open.length) { open.pop(); } else if (strayClose < 0) { strayClose = i; } }
    }
    if (open.length) {
      const c = findClosing(text, open[0]);
      e = Math.min(hi, c < 0 ? hi : c + 1); changed = true;
    }
    if (strayClose >= 0) {
      s = groupHead(text, findOpening(text, strayClose, lo), lo); changed = true;
    }
    let t = e;
    while (t > s && /\s/.test(text[t - 1])) { t--; }
    if ((text[t - 1] === '^' || text[t - 1] === '_') && !isEscaped(text, t - 1)) {
      let k = t;
      while (k < hi && /\s/.test(text[k])) { k++; }
      if (text[k] === '{') { const c = findClosing(text, k); e = c < 0 ? hi : c + 1; }
      else if (text[k] === '\\') { k++; while (k < hi && /[A-Za-z]/.test(text[k])) { k++; } e = Math.max(k, t + 1); }
      else { e = Math.min(hi, k + 1); }
      changed = true;
    }
    if (!changed) { break; }
  }
  return { start: Math.max(lo, s), end: Math.min(hi, e) };
}

export function evidOpen(opts: { cmd: string; color?: string; note?: string }): string {
  let s = '\\' + opts.cmd;
  if (opts.color || opts.note !== undefined) { s += `[${opts.color ?? ''}]`; }
  if (opts.note !== undefined) { s += `[${opts.note}]`; }
  return s + '{';
}

/**
 * Calcola la sostituzione per evidenziare [from, to) di `text`.
 * Restituisce undefined se non c'è niente di evidenziabile.
 */
export function buildWrap(text: string, from: number, to: number, opts: WrapOptions): WrapResult | undefined {
  const evids = findEvids(text, opts.cmd);
  const regions = mathRegions(text);
  let sel = expandSelection(text, from, to, evids);
  for (let k = 0; k < 3; k++) { // formule ed evid possono allargarsi a vicenda
    const m = expandToMath(text, sel.start, sel.end, regions);
    const n = expandSelection(text, m.start, m.end, evids);
    const same = n.start === sel.start && n.end === sel.end;
    sel = n;
    if (same) { break; }
  }
  // mai dentro gli argomenti di \begin{..}[..]{..} (titoli dei box, colonne…) né
  // dentro disegni e codice (tikzpicture, verbatim…): lì \hl rompe la compilazione.
  // Se la selezione comincia o finisce lì dentro, si accorcia per restarne fuori;
  // quelli interamente dentro la selezione li salta safeSegments.
  for (const f of forbiddenRegions(text)) {
    if (sel.start >= f.start && sel.end <= f.end) { return undefined; }
    if (sel.start > f.start && sel.start < f.end) { sel = { start: f.end, end: sel.end }; }
    if (sel.end > f.start && sel.end < f.end) { sel = { start: sel.start, end: f.start }; }
    if (sel.end <= sel.start) { return undefined; }
  }
  // tutta dentro una formula: niente graffe tagliate né ^ / _ orfani
  const host = regions.find(r => sel.start >= r.inStart && sel.end <= r.inEnd);
  if (host) { sel = balanceInMath(text, sel.start, sel.end, host.inStart, host.inEnd); }
  const original = text.slice(sel.start, sel.end);
  const clean = unwrapAll(original, opts.cmd);
  const segs = safeSegments(clean, opts.splitMath);
  // le formule tolte dal testo (display, o tutte con pdfLaTeX) si evidenziano dentro
  for (const r of mathRegions(clean)) {
    if (!(r.display || opts.splitMath)) { continue; }
    const inner = clean.slice(r.inStart, r.inEnd);
    for (const p of safeSegments(inner, false)) { segs.push({ start: r.inStart + p.start, end: r.inStart + p.end }); }
  }
  segs.sort((a, b) => a.start - b.start);
  if (segs.length === 0) { return undefined; }
  const open = evidOpen({ cmd: opts.cmd, color: opts.color });
  const full = text.slice(0, sel.start) + clean;
  const base = sel.start;
  let out = '';
  let pos = 0;
  for (const s of segs) {
    // dopo ^ o _ serve un gruppo: x^{\evid{2}}
    let k = base + s.start - 1;
    while (k >= 0 && /\s/.test(full[k])) { k--; }
    const script = k >= 0 && (full[k] === '^' || full[k] === '_') && !isEscaped(full, k);
    const body = open + clean.slice(s.start, s.end) + '}';
    out += clean.slice(pos, s.start) + (script ? `{${body}}` : body);
    pos = s.end;
  }
  out += clean.slice(pos);
  return { start: sel.start, end: sel.end, text: out, count: segs.length };
}

// ---------------------------------------------------------------------------
// Struttura del documento
// ---------------------------------------------------------------------------

export interface PreambleInfo {
  hasDocumentclass: boolean;
  /** offset di \begin{document}, -1 se assente */
  beginDocument: number;
  definesEvid: boolean;
  inputsColors: boolean;
  /** "% !TEX program = lualatex" ecc. */
  magicProgram?: string;
  /** "% !TEX root = ..." */
  magicRoot?: string;
  usesLuaPackages: boolean;
}

export function analyzePreamble(text: string, cmd: string, colorsFileBase: string): PreambleInfo {
  const bd = /\\begin\s*\{document\}/.exec(text);
  const pre = bd ? text.slice(0, bd.index) : text;
  const preNoComments = pre.replace(/(^|[^\\])%.*$/gm, '$1');
  const escCmd = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escBase = colorsFileBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const magic = (key: string) => new RegExp(`^\\s*%\\s*!\\s*TEX\\s+${key}\\s*=\\s*(.+?)\\s*$`, 'im').exec(text)?.[1];
  return {
    hasDocumentclass: /\\documentclass/.test(preNoComments),
    beginDocument: bd ? bd.index : -1,
    definesEvid: new RegExp(`\\\\(?:[Nn]ew|[Rr]enew|[Pp]rovide|Declare)(?:command|DocumentCommand)\\*?\\s*\\{?\\\\${escCmd}\\b`).test(preNoComments)
      || new RegExp(`\\\\def\\\\${escCmd}\\b`).test(preNoComments),
    inputsColors: new RegExp(`\\\\(?:input|include)\\s*\\{\\s*(?:\\./)?${escBase}(?:\\.tex)?\\s*\\}`).test(preNoComments),
    magicProgram: magic('(?:TS-)?program'),
    magicRoot: magic('root'),
    usesLuaPackages: /\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|lua-ul|luacode|luatexja|unicode-math|luacolor)\b/.test(preNoComments),
  };
}

export interface Heading { offset: number; level: number; title: string; }

/** \part, \chapter, \section, \subsection, \subsubsection (fuori dai commenti) */
export function findHeadings(text: string): Heading[] {
  const levels: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };
  const out: Heading[] = [];
  const re = /\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const before = text.slice(lineStart, m.index);
    if (/(^|[^\\])%/.test(before)) { continue; }
    const open = m.index + m[0].length - 1;
    const close = findClosing(text, open);
    if (close < 0) { continue; }
    out.push({ offset: m.index, level: levels[m[1]], title: text.slice(open + 1, close).replace(/\s+/g, ' ').trim() });
  }
  return out;
}
