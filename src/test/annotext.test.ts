import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { quadsFromPoints, textInQuads, nearestColor } from '../annotext';
import { PASTELLI } from '../colorsfile';

// due righe: ogni carattere largo 5pt, altezza 10pt
const items = [
  { str: 'Il machine learning si occupa', x: 100, y: 700, w: 29 * 5, h: 10 },
  { str: 'dei problemi difficili.', x: 100, y: 686, w: 23 * 5, h: 10 },
];

test('testo sotto un riquadro parziale', () => {
  // "machine learning" = caratteri 3..19
  const q = quadsFromPoints([115, 709, 195, 709, 115, 698, 195, 698]);
  assert.equal(textInQuads(items, q), 'machine learning');
});

test('due righe, in ordine di lettura anche se i quad sono invertiti', () => {
  const qp = [100, 695, 160, 695, 100, 684, 160, 684, /* riga 1, "occupa" */ 215, 709, 245, 709, 215, 698, 245, 698];
  assert.equal(textInQuads(items, quadsFromPoints(qp)), 'occupa dei problemi');
});

test('colore fluo → pastello più vicino', () => {
  assert.equal(nearestColor([255, 255, 0], PASTELLI).name, 'evidGiallo');
  assert.equal(nearestColor([0, 255, 0], PASTELLI).name, 'evidMenta');
  assert.equal(nearestColor([255, 105, 180], PASTELLI).name, 'evidRosa');
  assert.equal(nearestColor([0, 176, 255], PASTELLI).name, 'evidAzzurro');
});
