import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildWrap, findEvids, evidAt, unwrapAll, analyzePreamble, findHeadings } from '../parser';
import { updateColorsFile, parseDefineColors, PASTELLI, normalizeHex } from '../colorsfile';

const wrap = (src: string, sel: string, color?: string, splitMath = true) => {
  const from = src.indexOf(sel);
  assert.ok(from >= 0, 'selezione non trovata');
  const r = buildWrap(src, from, from + sel.length, { cmd: 'evid', color, splitMath });
  if (!r) { return src; }
  return src.slice(0, r.start) + r.text + src.slice(r.end);
};

test('selezione semplice', () => {
  assert.equal(wrap('Un teorema importante.', 'teorema'), 'Un \\evid{teorema} importante.');
});

test('colore facoltativo', () => {
  assert.equal(wrap('abc def', 'def', 'evidRosa'), 'abc \\evid[evidRosa]{def}');
});

test('spazi ai bordi restano fuori', () => {
  assert.equal(wrap('a  bc  d', '  bc  '), 'a  \\evid{bc}  d');
});

test('trova evid con colore, nota e annidati, salta i commenti', () => {
  const t = 'x \\evid[evidRosa][una nota]{ab \\evid{cd}} % \\evid{no}\n\\evidenza{no}';
  const e = findEvids(t);
  assert.equal(e.length, 2);
  assert.equal(e[0].color, 'evidRosa');
  assert.equal(e[0].note, 'una nota');
  assert.equal(t.slice(e[0].contentStart, e[0].contentEnd), 'ab \\evid{cd}');
  assert.equal(evidAt(e, t.indexOf('cd'))!.start, e[1].start);
});

test('graffe sbilanciate: spezza invece di rompere', () => {
  const src = 'testo \\textbf{grassetto e} altro';
  const out = wrap(src, 'testo \\textbf{grassetto');
  assert.equal(out, '\\evid{testo} \\textbf{\\evid{grassetto} e} altro');
});

test('fine selezione dentro un gruppo chiuso dopo', () => {
  const src = '\\emph{abc def} ghi';
  assert.equal(wrap(src, 'def} ghi'), '\\emph{abc \\evid{def}} \\evid{ghi}');
});

test('non attraversa paragrafi e ambienti', () => {
  const src = 'uno due\n\ntre \\begin{itemize}\\item quattro\\end{itemize} cinque';
  const out = wrap(src, src);
  assert.equal(out, '\\evid{uno due}\n\n\\evid{tre} \\begin{itemize}\\item \\evid{quattro}\\end{itemize} \\evid{cinque}');
});

test('pdfLaTeX: la matematica resta fuori da \\hl (ma è evidenziata dentro)', () => {
  const src = 'sia $x^2$ positivo';
  assert.equal(wrap(src, src), '\\evid{sia} $\\evid{x^2}$ \\evid{positivo}');
});

test('LuaLaTeX: la matematica resta dentro', () => {
  const src = 'sia $x^2$ positivo';
  assert.equal(wrap(src, src, undefined, false), '\\evid{sia $x^2$ positivo}');
});

test('niente annidamenti: riassorbe evid sovrapposti', () => {
  const src = 'ab \\evid{cd ef} gh';
  const out = wrap(src, 'ef} gh');
  assert.equal(out, 'ab \\evid{cd ef gh}');
});

test('inizio a metà comando', () => {
  const src = 'a \\textit{b} c';
  assert.equal(wrap(src, 'extit{b} c'), 'a \\evid{\\textit{b} c}');
});

test('commenti esclusi', () => {
  const src = 'abc % commento\ndef';
  assert.equal(wrap(src, src), '\\evid{abc} % commento\n\\evid{def}');
});

test('footnote e label restano fuori con il loro argomento', () => {
  const src = 'testo\\footnote{nota} fine\\label{x}';
  assert.equal(wrap(src, src), '\\evid{testo}\\footnote{nota} \\evid{fine}\\label{x}');
});

test('tabelle: & e \\\\ separano', () => {
  const src = 'a & b \\\\ c';
  assert.equal(wrap(src, src), '\\evid{a} & \\evid{b} \\\\ \\evid{c}');
});

test('percento escapato non è un commento', () => {
  assert.equal(wrap('il 50\\% dei casi', 'il 50\\% dei casi'), '\\evid{il 50\\% dei casi}');
});

test('unwrapAll', () => {
  assert.equal(unwrapAll('a \\evid[x]{b \\evid{c}} d', 'evid'), 'a b c d');
});

test('preambolo', () => {
  const t = '\\documentclass{article}\n\\usepackage{soul}\n\\input{evid-colori}\n\\newcommand{\\evid}[2][evidGiallo]{x}\n\\begin{document}\n';
  const i = analyzePreamble(t, 'evid', 'evid-colori');
  assert.ok(i.hasDocumentclass && i.definesEvid && i.inputsColors);
  assert.equal(i.usesLuaPackages, false);
  const j = analyzePreamble('% !TEX program = lualatex\n\\documentclass{article}\n\\begin{document}', 'evid', 'evid-colori');
  assert.equal(j.magicProgram, 'lualatex');
  assert.equal(j.definesEvid, false);
});

test('titoli', () => {
  const h = findHeadings('\\chapter{Uno}\n% \\section{no}\n\\section*{Due \\emph{x}}');
  assert.deepEqual(h.map(x => x.title), ['Uno', 'Due \\emph{x}']);
});

test('file colori: crea, aggiunge, conserva, legenda', () => {
  const a = updateColorsFile(undefined, PASTELLI, 'evid', {});
  assert.equal(parseDefineColors(a).length, 7);
  const b = updateColorsFile(a + '\\definecolor{mio}{HTML}{123456}\n', [{ name: 'evidC8E6F5', hex: 'C8E6F5' }], 'evid',
    { evidRosa: 'Definizioni & teoremi' });
  const names = parseDefineColors(b).map(c => c.name);
  assert.ok(names.includes('mio') && names.includes('evidC8E6F5'));
  assert.match(b, /\\evid\[evidRosa\]\{Definizioni \\& teoremi\}/);
  // riscrivere non duplica la legenda
  const c = updateColorsFile(b, [], 'evid', { evidRosa: 'Definizioni & teoremi' });
  assert.equal(c, b);
});

test('hex', () => {
  assert.equal(normalizeHex('#abc'), 'AABBCC');
  assert.equal(normalizeHex('c8e6f5'), 'C8E6F5');
  assert.equal(normalizeHex('xyz'), undefined);
});

const R = String.raw;

test('dentro \\[ \\]: evid in modalità matematica, delimitatori intatti', () => {
  const src = R`Quindi \[ i = \Theta(\log n) \] fine.`;
  assert.equal(wrap(src, R`\Theta(\log n)`), R`Quindi \[ i = \evid{\Theta(\log n)} \] fine.`);
});

test('dentro $$ $$ e $ $', () => {
  assert.equal(wrap('a $$x + y$$ b', 'x + y'), R`a $$\evid{x + y}$$ b`);
  assert.equal(wrap('a $x + y$ b', 'y'), R`a $x + \evid{y}$ b`);
});

test('selezione che taglia una formula in linea → formula intera', () => {
  // pdfLaTeX: il testo con \hl, la formula col suo \evid dentro i $
  assert.equal(wrap(R`il costo è $\Theta(n)$ ok`, R`costo è $\Theta`), R`il \evid{costo è} $\evid{\Theta(n)}$ ok`);
  // LuaLaTeX: tutto insieme
  assert.equal(wrap(R`il costo è $\Theta(n)$ ok`, R`costo è $\Theta`, undefined, false), R`il \evid{costo è $\Theta(n)$} ok`);
});

test('selezione che entra in una formula display → display fuori da \\hl', () => {
  const src = R`Vale \[ a = b \] dunque`;
  assert.equal(wrap(src, R`Vale \[ a`, undefined, false), R`\evid{Vale} \[ \evid{a = b} \] dunque`);
});

test('ambienti matematici: si spezza su & e \\\\', () => {
  const src = R`\begin{align} a &= b \\ c &= d \end{align}`;
  assert.equal(wrap(src, 'a &= b'), R`\begin{align} \evid{a} &\evid{= b} \\ c &= d \end{align}`);
});

test('esponenti e \\left \\right', () => {
  assert.equal(wrap('$x^2$', '2'), R`$x^{\evid{2}}$`);
  assert.equal(wrap(R`$\left( a + b \right)$`, R`\left( a + b \right)`), R`$\left( \evid{a + b} \right)$`);
});

