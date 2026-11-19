/**
 * Corrispondenza tollerante fra il testo selezionato nel PDF e il sorgente LaTeX.
 *
 * Idea: si "normalizza" il sorgente in una stringa di sole lettere/cifre minuscole
 * senza accenti (togliendo comandi, graffe, commenti, spazi…), tenendo per ogni
 * carattere la posizione nel testo originale. Lo stesso si fa col testo del PDF
 * (legature, sillabazione e spazi spariscono). Poi si cerca l'uno nell'altro.
 *
 * Nessun import di `vscode`: testabile con Node.
 */

export interface Normalized {
  norm: string;
  /** per ogni carattere di norm: offset originale da cui iniziare un intervallo */
  startMap: number[];
  /** per ogni carattere di norm: offset originale subito dopo il carattere */
  endMap: number[];
}

/** Comandi il cui argomento obbligatorio NON compare come testo nel PDF (o compare altrove). */
const SKIP_ARG = new Set([
  'label', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'cite', 'citep', 'citet', 'nocite',
  'begin', 'end', 'footnote', 'footnotetext', 'marginpar', 'marginnote', 'usepackage', 'documentclass',
  'input', 'include', 'includegraphics', 'hspace', 'vspace', 'definecolor', 'color', 'sethlcolor',
  'evidnota', 'index', 'bibliography', 'bibliographystyle', 'newcommand', 'renewcommand', 'hypersetup',
  'setlength', 'addtolength', 'pagestyle', 'thispagestyle',
]);

const SYMBOL_TEXT: Record<string, string> = { ss: 'ss', i: 'i', j: 'j', o: 'o', O: 'o', l: 'l', L: 'l', ae: 'ae', AE: 'ae', oe: 'oe', OE: 'oe', aa: 'a', AA: 'a' };
/** Lettere greche: nel PDF compaiono come caratteri Unicode (Θ, α…). Le varianti
 *  (ϑ, ϵ, ϕ…) diventano comunque la lettera base con la normalizzazione NFKD. */
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', varkappa: 'ϰ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς',
  tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  varGamma: 'Γ', varDelta: 'Δ', varTheta: 'Θ', varLambda: 'Λ', varXi: 'Ξ', varPi: 'Π',
  varSigma: 'Σ', varUpsilon: 'Υ', varPhi: 'Φ', varPsi: 'Ψ', varOmega: 'Ω',
  ell: 'ℓ', aleph: 'ℵ', hbar: 'ℏ', imath: 'ı', jmath: 'ȷ',
};

/** Simboli matematici: contano solo nella ricerca "con simboli" (vedi `locate`). */
const MATH_SYMBOLS: Record<string, string> = {
  leq: '≤', le: '≤', leqslant: '≤', geq: '≥', ge: '≥', geqslant: '≥', neq: '≠', ne: '≠',
  ll: '≪', gg: '≫', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  infty: '∞', sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  partial: '∂', nabla: '∇', pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', circ: '∘',
  bullet: '∙', ast: '∗', star: '⋆', oplus: '⊕', otimes: '⊗', sqrt: '√', surd: '√',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', mapsto: '↦',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', impliedby: '⟸', iff: '⟺',
  longrightarrow: '⟶', longleftarrow: '⟵', longmapsto: '⟼', uparrow: '↑', downarrow: '↓',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  subsetneq: '⊊', supsetneq: '⊋', cup: '∪', cap: '∩', bigcup: '⋃', bigcap: '⋂', setminus: '∖',
  emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', bigwedge: '⋀', bigvee: '⋁',
  perp: '⊥', parallel: '∥', mid: '∣', angle: '∠', langle: '⟨', rangle: '⟩',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  top: '⊤', bot: '⊥', vdash: '⊢', models: '⊨', prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰',
  triangle: '△', square: '□', Box: '□', Diamond: '◇', dagger: '†', ddagger: '‡', S: '§', P: '¶',
  checkmark: '✓', degree: '°',
};

/** Varianti dello stesso simbolo che il PDF può restituire in modi diversi. */
const SAME_SYMBOL: Record<string, string> = {
  '·': '⋅', '∙': '⋅', '•': '⋅', '∣': '|', '*': '∗', '-': '−', '‐': '−', '–': '−', '⩽': '≤', '⩾': '≥',
};

/** Operatori matematici che nel PDF compaiono scritti per esteso ("sin", "log"…). */
const MATH_WORDS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth',
  'log', 'ln', 'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker',
  'deg', 'arg', 'gcd', 'hom', 'Pr',
]);

const ACCENTS =new Set(["'", '`', '^', '"', '~', '=', '.', 'u', 'v', 'H', 'c', 'k', 'r', 'b', 'd', 't']);

/**
 * Riduce una stringa qualsiasi alle sole lettere/cifre minuscole senza accenti.
 * Con `symbols` tiene anche i simboli matematici (≤, ∞, ∑…).
 */
export function simplify(s: string, symbols = false): string {
  let t = s.normalize('NFKD');
  // la barra di negazione (≠ → "=" + U+0338) non va persa coi simboli
  if (symbols) { t = t.replace(/̸/g, '¬'); }
  t = t.replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!symbols) { return t.replace(/[^\p{L}\p{N}]/gu, ''); }
  return [...t].map(ch => SAME_SYMBOL[ch] ?? ch).join('').replace(/[^\p{L}\p{N}\p{Sm}\p{So}]/gu, '');
}

function skipSpaces(t: string, i: number, end: number) {
  while (i < end && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) { i++; }
  return i;
}

/** Fine del gruppo bilanciato che inizia con `open` in `i` (posizione dopo la chiusura). */
function skipGroup(t: string, i: number, end: number, open: string, close: string): number {
  let depth = 0;
  for (let k = i; k < end; k++) {
    if (t[k] === '\\') { k++; continue; }
    if (t[k] === open) { depth++; }
    else if (t[k] === close) { depth--; if (depth === 0) { return k + 1; } }
  }
  return end;
}

export function normalizeSource(t: string, from = 0, to = t.length, symbols = false): Normalized {
  const norm: string[] = [];
  const startMap: number[] = [];
  const endMap: number[] = [];
  const emit = (s: string, start: number, endPos: number) => {
    for (const ch of simplify(s, symbols)) { norm.push(ch); startMap.push(start); endMap.push(endPos); }
  };
  let i = from;
  while (i < to) {
    const c = t[i];
    if (c === '%') { // commento
      const nl = t.indexOf('\n', i);
      i = nl < 0 || nl > to ? to : nl + 1;
      continue;
    }
    if (c === '\\') {
      const n = t[i + 1];
      if (n === undefined) { i++; continue; }
      if (/[A-Za-z@]/.test(n)) {
        let j = i + 1;
        while (j < to && /[A-Za-z@]/.test(t[j])) { j++; }
        const name = t.slice(i + 1, j);
        if (ACCENTS.has(name) && name.length === 1) {
          // \c{c}, \v s, \u{a} …
          const k = skipSpaces(t, j, to);
          if (t[k] === '{') { const e = skipGroup(t, k, to, '{', '}'); emit(t.slice(k + 1, e - 1), i, e); i = e; }
          else if (k < to) { emit(t[k], i, k + 1); i = k + 1; }
          else { i = k; }
          continue;
        }
        if (SYMBOL_TEXT[name]) { emit(SYMBOL_TEXT[name], i, j); i = j; continue; }
        if (GREEK[name]) { emit(GREEK[name], i, j); i = j; continue; }
        if (MATH_WORDS.has(name)) { emit(name, i, j); i = j; continue; }
        if (MATH_SYMBOLS[name]) { emit(MATH_SYMBOLS[name], i, j); i = j; continue; }
        i = j;
        // argomenti facoltativi [..] (tranne \item, dove l'etichetta si vede)
        if (name !== 'item') {
          let k = skipSpaces(t, i, to);
          while (t[k] === '[') { i = skipGroup(t, k, to, '[', ']'); k = skipSpaces(t, i, to); }
        }
        if (SKIP_ARG.has(name)) {
          const k = skipSpaces(t, i, to);
          if (t[k] === '*') { i = k + 1; }
          const k2 = skipSpaces(t, i, to);
          if (t[k2] === '{') {
            i = skipGroup(t, k2, to, '{', '}');
            if (name === 'begin') { // eventuale \begin{tabular}{ll}
              const k3 = skipSpaces(t, i, to);
              if (/^\{[lcrp|@{}\s\d.]*\}/.test(t.slice(k3, k3 + 40))) { i = skipGroup(t, k3, to, '{', '}'); }
            }
          }
        }
        continue;
      }
      // simbolo di controllo
      if (ACCENTS.has(n)) {
        const k = skipSpaces(t, i + 2, to);
        if (t[k] === '{') { const e = skipGroup(t, k, to, '{', '}'); emit(t.slice(k + 1, e - 1), i, e); i = e; }
        else if (k < to) { emit(t[k], i, k + 1); i = k + 1; }
        else { i = k; }
        continue;
      }
      if ('%&$#_{}'.includes(n)) { emit(n, i, i + 2); }
      else if (n === '|') { emit('∥', i, i + 2); }
      i += 2;
      continue;
    }
    if (c === '~') { i++; continue; } // spazio non separabile, non un simbolo
    emit(c, i, i + 1);
    i++;
  }
  return { norm: norm.join(''), startMap, endMap };
}

/** Normalizza il testo selezionato nel PDF. */
export function normalizePdf(s: string): string {
  // sillabazione a fine riga: "funzio-\nne" → "funzione" (simplify toglie comunque "-")
  return simplify(s);
}

export interface FoundRange { start: number; end: number; exact: boolean; }

/**
 * Cerca `needle` (già normalizzato) in `hay`. Se ci sono più occorrenze sceglie
 * quella più vicina a `nearOffset` (offset ORIGINALE). Se non trova la frase
 * intera prova inizio + fine separatamente.
 */
export function findInNormalized(n: Normalized, needle: string, nearOffset: number): FoundRange | undefined {
  if (!needle) { return undefined; }
  const hay = n.norm;
  const dist = (i: number) => Math.abs(n.startMap[i] - nearOffset);

  // 1. esatta
  let best = -1;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (best < 0 || dist(i) < dist(best)) { best = i; }
  }
  if (best >= 0) {
    return { start: n.startMap[best], end: n.endMap[best + needle.length - 1], exact: true };
  }

  // 2. inizio e fine separati (formule, riferimenti, citazioni rese diversamente)
  //    (tollerando fino a 3 caratteri "estranei" ai bordi, es. "[1]" di \cite)
  const L = needle.length;
  const maxLen = Math.ceil(L * 1.5) + 20;
  for (let k = Math.min(16, Math.floor(L / 2)); k >= 4; k -= 2) {
    let cand: { s: number; e: number; cost: number } | undefined;
    for (let ds = 0; ds <= 3; ds++) {
      for (let de = 0; de <= 3; de++) {
        if (ds + de + 2 * k > L + k) { continue; }
        const pre = needle.slice(ds, ds + k), suf = needle.slice(L - de - k, L - de);
        for (let i = hay.indexOf(pre); i >= 0; i = hay.indexOf(pre, i + 1)) {
          const j = hay.indexOf(suf, i + k);
          if (j < 0) { break; }
          const jEnd = j + k;
          if (jEnd - i > maxLen || jEnd - i < L * 0.5) { continue; }
          const cost = ds + de;
          if (!cand || cost < cand.cost || (cost === cand.cost && dist(i) < dist(cand.s))) { cand = { s: i, e: jEnd, cost }; }
        }
      }
    }
    if (cand) { return { start: n.startMap[cand.s], end: n.endMap[cand.e - 1], exact: false }; }
  }
  return undefined;
}

/** Offset di inizio della riga `line` (0-based). */
export function lineOffset(text: string, line: number): number {
  let off = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) { return text.length; }
    off = nl + 1;
  }
  return off;
}

/**
 * Trova nel sorgente il testo selezionato nel PDF, cercando prima nelle righe
 * indicate da SyncTeX (± finestra) e poi in tutto il file.
 */
export function locate(text: string, pdfText: string, lines: number[], window: number): FoundRange | undefined {
  const near = lines.length ? lineOffset(text, Math.min(...lines)) : 0;
  const search = (symbols: boolean) => {
    const needle = symbols ? simplify(pdfText, true) : normalizePdf(pdfText);
    if (needle.length < 1) { return undefined; }
    let r: FoundRange | undefined;
    if (lines.length) {
      const from = lineOffset(text, Math.max(0, Math.min(...lines) - window));
      const to = lineOffset(text, Math.max(...lines) + window + 1);
      r = findInNormalized(normalizeSource(text, from, to, symbols), needle, near);
    }
    return r ?? findInNormalized(normalizeSource(text, 0, text.length, symbols), needle, near);
  };
  // prima solo lettere e cifre (la più tollerante); i simboli servono quando la
  // selezione è fatta solo di simboli (≤, ∞…) o le lettere da sole non bastano.
  const r = search(false) ?? search(true);
  return r && extendPunctuation(text, pdfText, snapToWords(text, r));
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Come Word: se la selezione inizia o finisce a metà parola, la allarga alla
 * parola intera ("Sceg[liamo un mo]do" → "[Scegliamo un modo]").
 */
export function snapToWords(text: string, r: FoundRange): FoundRange {
  let { start, end } = r;
  while (start > 0 && isWordChar(text[start - 1]) && isWordChar(text[start])) {
    // non entrare nel nome di un comando (\textbf…)
    let k = start - 1;
    while (k > 0 && /[A-Za-z@]/.test(text[k - 1])) { k--; }
    if (text[k - 1] === '\\') { break; }
    start--;
  }
  while (end < text.length && isWordChar(text[end - 1]) && isWordChar(text[end])) { end++; }
  return { ...r, start, end };
}

/** Include la punteggiatura selezionata ai bordi ("continua." → anche il punto). */
function extendPunctuation(text: string, pdfText: string, r: FoundRange): FoundRange {
  const t = pdfText.trim();
  const tail = /[.,;:!?)\]»"'’”]+$/u.exec(t)?.[0] ?? '';
  const head = /^[(\[«"'‘“]+/u.exec(t)?.[0] ?? '';
  let { start, end } = r;
  for (const ch of tail) {
    let k = end;
    while (k < text.length && (text[k] === ' ' || text[k] === '}')) { k++; }
    if (text[k] === ch && text[k - 1] !== '\\') { end = k + 1; } else { break; }
  }
  for (const ch of [...head].reverse()) {
    if (text[start - 1] === ch) { start--; } else { break; }
  }
  return { ...r, start, end };
}
