import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { parseLogErrors, culprits, findInserted, lineAt, Tracked } from '../repair';

const R = String.raw;
const dir = path.resolve('/tmp/appunti');
const file = path.join(dir, 'appunti_ml.tex');

const log = R`(./appunti_ml.tex
! Undefined control sequence.
./appunti_ml.tex:3: Undefined control sequence.
<argument> \evid
appunti_ml.tex:685: Package tikz Error: Giving up on this path. Did you forget a semicolon?.
l.685 ...`;

test('errori del log con -file-line-error', () => {
  const e = parseLogErrors(log, dir);
  assert.deepEqual(e.map(x => [path.basename(x.file), x.line]), [['appunti_ml.tex', 3], ['appunti_ml.tex', 685]]);
});

test('colpevole: l’evidenziazione nuova sulla riga dell’errore', () => {
  const lines = Array.from({ length: 700 }, (_, i) => `riga ${i + 1}`);
  lines[684] = R`  \node (ea) at (7.3,2.8) {Event A}\evid[evidAzzurro]{;`;
  lines[685] = R`  \draw[->, thick] (ea) -- (4,1.75);}`;
  lines[99] = R`Testo \evid[evidAzzurro]{buono} qui`;
  const text = lines.join('\n');
  const bad: Tracked = { file, inserted: R`\evid[evidAzzurro]{;` + '\n' + R`  \draw[->, thick] (ea) -- (4,1.75);}`, original: ';\n' + R`  \draw[->, thick] (ea) -- (4,1.75);`, offset: 0 };
  const good: Tracked = { file, inserted: R`\evid[evidAzzurro]{buono}`, original: 'buono', offset: 0 };
  const res = culprits([bad, good], parseLogErrors(log, dir), new Map([[file, text]]));
  assert.equal(res.length, 1);
  assert.equal(res[0].item, bad);
  assert.equal(lineAt(text, res[0].at), 685);
});

test('errore qualche riga dopo (fine paragrafo): ancora colpevole; lontano no', () => {
  const text = 'a\n' + R`\evid{x}` + '\nb\nc\nd\ne\nf\ng\n';
  const t: Tracked = { file, inserted: R`\evid{x}`, original: 'x', offset: 2 };
  const err = (line: number) => [{ file, line, message: '' }];
  assert.equal(culprits([t], err(4), new Map([[file, text]])).length, 1);
  assert.equal(culprits([t], err(9), new Map([[file, text]])).length, 0);
});

test('modificata a mano dopo: non si tocca', () => {
  const t: Tracked = { file, inserted: R`\evid{x}`, original: 'x', offset: 0 };
  assert.equal(culprits([t], [{ file, line: 1, message: '' }], new Map([[file, 'altro testo']])).length, 0);
});

test('occorrenza più vicina alla posizione originale', () => {
  const text = R`\evid{a} ... \evid{a}`;
  assert.equal(findInserted(text, R`\evid{a}`, 15), 13);
});
