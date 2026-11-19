import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { locate, normalizeSource, simplify } from '../match';

const src = String.raw`\section{Prova}\label{s}
Sia $f(x)=x^2$ una funzione \textbf{convessa e} continua.\footnote{nota a piè} Il 50\% dei casi.

Secondo paragrafo con \emph{enfasi}, citazione \cite{k} e riferimento \ref{s}.
Accenti: perch\'e citt\`a \evid[evidRosa]{gi\`a evidenziato} qui.
La definizione di spazio vettoriale è importante.
Un'altra definizione di spazio vettoriale, ripetuta.
`;

const pick = (pdf: string, lines: number[] = []) => {
  const r = locate(src, pdf, lines, 3);
  return r ? src.slice(r.start, r.end) : undefined;
};

test('simplify: legature, accenti, sillabazione', () => {
  assert.equal(simplify('ﬁne città funzio-\nne'), 'finecittafunzione');
});

test('selezione a metà parola → parole intere', () => {
  assert.equal(pick('ndo paragra'), 'Secondo paragrafo');
});

test('punteggiatura finale inclusa', () => {
  assert.equal(pick('continua.'), 'continua.');
});

test('testo semplice', () => {
  assert.equal(pick('una funzione convessa'), 'una funzione \\textbf{convessa');
});

test('formula come la estrae il PDF', () => {
  assert.equal(pick('Sia f(x) = x2 una'), 'Sia $f(x)=x^2$ una');
});

test('accenti LaTeX e % escapato', () => {
  assert.equal(pick('perché città'), "perch\\'e citt\\`a");
  assert.equal(pick('Il 50% dei casi.'), 'Il 50\\% dei casi.');
});

test('salta il nome del colore e trova dentro un evid', () => {
  assert.equal(pick('già evidenziato'), 'gi\\`a evidenziato');
});

test('citazioni rese come [1]: corrispondenza inizio/fine', () => {
  assert.equal(pick('citazione [1] e riferimento 1.'), 'citazione \\cite{k} e riferimento');
});

test('sceglie l’occorrenza più vicina alla riga di SyncTeX', () => {
  const a = locate(src, 'definizione di spazio vettoriale', [6], 0)!;
  assert.ok(src.slice(0, a.start).split('\n').length - 1 === 6);
  const b = locate(src, 'definizione di spazio vettoriale', [5], 0)!;
  assert.ok(src.slice(0, b.start).split('\n').length - 1 === 5);
});

test('la nota a piè non entra nel testo normalizzato', () => {
  assert.ok(!normalizeSource(src).norm.includes('notaapie'));
});
