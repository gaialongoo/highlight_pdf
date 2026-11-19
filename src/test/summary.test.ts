import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { itemsOf, plainText, summaryBody, summaryMarkdown, findInputs, sectionChain } from '../summary';
import { findHeadings } from '../parser';
import { PASTELLI, noteArg, upgradePreamble, preambleBlock } from '../colorsfile';

const src = String.raw`\section{Uno}\label{s1}
Testo \evid{prima cosa} e \evid[evidRosa][una nota]{definizione \textbf{importante}}.
\subsection{Uno punto uno}
\evid[evidMenta]{in sottosezione con $x^2$}
\section{Due}
% \evid{commentato}
\evid{seconda sezione}
`;

test('sezioni e voci', () => {
  const items = itemsOf('a.tex', src, 'evid', 'evidGiallo');
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(i => i.sections.map(h => h.title).join(' > ')),
    ['Uno', 'Uno', 'Uno > Uno punto uno', 'Due']);
  assert.equal(items[1].note, 'una nota');
  assert.equal(items[1].color, 'evidRosa');
  assert.equal(items[0].color, 'evidGiallo');
  assert.equal(items[2].line, 3);
});

test('sectionChain chiude i livelli', () => {
  const h = findHeadings(src);
  assert.deepEqual(sectionChain(h, src.length).map(x => x.title), ['Due']);
});

test('plainText', () => {
  assert.equal(plainText(String.raw`definizione \textbf{importante} e citt\`a $\alpha+1$ al 50\%`),
    'definizione importante e città $\\alpha+1$ al 50%');
});

test('riassunto LaTeX per sezione', () => {
  const items = itemsOf('a.tex', src, 'evid', 'evidGiallo');
  const body = summaryBody(items, { order: 'sezione', cmd: 'evid', title: 'Appunti', colors: PASTELLI, legend: {} });
  assert.match(body, /\\section\*\{Uno\}\n\\begin\{itemize\}\n  \\item \\evid\[evidGiallo\]\{prima cosa\}/);
  assert.match(body, /\\subsection\*\{Uno punto uno\}/);
  assert.match(body, /\\textit\{Nota:\} una nota/);
  assert.equal((body.match(/\\section\*\{Uno\}/g) ?? []).length, 1);
});

test('riassunto per colore e Markdown', () => {
  const items = itemsOf('a.tex', src, 'evid', 'evidGiallo');
  const o = { order: 'colore' as const, cmd: 'evid', title: 'Appunti', colors: PASTELLI, legend: { evidRosa: 'Definizioni' } };
  const body = summaryBody(items, o);
  assert.match(body, /\\section\*\{\\colorbox\{evidGiallo\}\{Giallo\}\}/);
  assert.match(body, /\\colorbox\{evidRosa\}\{Rosa — Definizioni\}/);
  const md = summaryMarkdown(items, o);
  assert.match(md, /<mark style="background:#FFD6E0;color:#1f1f1f">definizione \*\*importante\*\*<\/mark>/);
  assert.match(md, /_Nota:_ una nota/);
});

test('input e include', () => {
  assert.deepEqual(findInputs('\\input{evid-colori}\n% \\input{no}\n\\include{cap1}').map(i => i.name), ['evid-colori', 'cap1']);
});

test('nota: caratteri speciali e parentesi', () => {
  assert.equal(noteArg('50% & [x]'), '{50\\% \\& [x]}');
  assert.equal(noteArg('semplice'), 'semplice');
});

test('aggiornamento del blocco nel preambolo', () => {
  const v1 = '% --- Evidenziatore LaTeX (pdfLaTeX) ---\n\\newcommand{\\evid}[2][evidGiallo]{x}\n% --- fine Evidenziatore LaTeX ---\n';
  const doc = '\\documentclass{article}\n' + v1 + '\\begin{document}\n';
  const up = upgradePreamble(doc, 'pdflatex', 'evid', 'evid-colori', 'evidGiallo')!;
  assert.match(up, /NewDocumentCommand\{\\evid\}\{O\{evidGiallo\} o m\}/);
  assert.ok(up.endsWith('\\begin{document}\n'));
  assert.equal(upgradePreamble(up, 'pdflatex', 'evid', 'evid-colori', 'evidGiallo'), undefined);
  assert.ok(preambleBlock('lualatex', 'evid', 'c', 'evidGiallo').includes('\\highLight[#1]{#3}'));
});
