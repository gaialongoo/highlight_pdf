import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { History, plan, afterApply, applyTo, Entry } from '../history';

const R = String.raw;
const F = 'a.tex';

/** Simula: annulla o ripeti l'operazione in cima e restituisce il testo nuovo. */
function step(h: History, text: string, undo: boolean): string {
  const e = (undo ? h.peekUndo() : h.peekRedo())!;
  const reps = plan(e, new Map([[F, text]]), undo)!;
  const out = applyTo(text, reps);
  if (undo) { h.undone(afterApply(reps)); } else { h.redone(afterApply(reps)); }
  return out;
}

test('annulla e ripeti più evidenziazioni', () => {
  const h = new History();
  let t = 'uno due tre quattro';
  // evidenzio "due" e poi "quattro"
  t = 'uno \\evid{due} tre quattro';
  h.push({ label: 'evid', root: F, changes: [{ file: F, at: 4, before: 'due', after: R`\evid{due}` }] });
  t = R`uno \evid{due} tre \evid{quattro}`;
  h.push({ label: 'evid', root: F, changes: [{ file: F, at: 19, before: 'quattro', after: R`\evid{quattro}` }] });

  t = step(h, t, true);
  assert.equal(t, R`uno \evid{due} tre quattro`);
  t = step(h, t, true);
  assert.equal(t, 'uno due tre quattro');
  assert.equal(h.peekUndo(), undefined);
  t = step(h, t, false);
  assert.equal(t, R`uno \evid{due} tre quattro`);
  t = step(h, t, false);
  assert.equal(t, R`uno \evid{due} tre \evid{quattro}`);
});

test('una nuova modifica cancella i "ripeti"', () => {
  const h = new History();
  h.push({ label: 'x', root: F, changes: [{ file: F, at: 0, before: 'a', after: R`\evid{a}` }] });
  step(h, R`\evid{a} b`, true);
  assert.ok(h.peekRedo());
  h.push({ label: 'y', root: F, changes: [{ file: F, at: 2, before: 'b', after: R`\evid{b}` }] });
  assert.equal(h.peekRedo(), undefined);
});

test('più pezzi nella stessa operazione (es. testo + formula)', () => {
  const h = new History();
  const before = 'il costo $x$ ok';
  const after = R`il \evid{costo} $\evid{x}$ ok`;
  const e: Entry = { label: 'evid', root: F, changes: [
    { file: F, at: 3, before: 'costo', after: R`\evid{costo}` },
    { file: F, at: 17, before: 'x', after: R`\evid{x}` },
  ] };
  h.push(e);
  const t = step(h, after, true);
  assert.equal(t, before);
  assert.equal(step(h, t, false), after);
});

test('testo cambiato a mano: non si annulla', () => {
  const e: Entry = { label: 'x', root: F, changes: [{ file: F, at: 0, before: 'a', after: R`\evid{a}` }] };
  assert.equal(plan(e, new Map([[F, 'tutto diverso']]), true), undefined);
});

test('posizione spostata da modifiche altrove: si ritrova', () => {
  const e: Entry = { label: 'x', root: F, changes: [{ file: F, at: 5, before: 'b', after: R`\evid{b}` }] };
  const reps = plan(e, new Map([[F, R`testo aggiunto prima a \evid{b} c`]]), true)!;
  assert.equal(applyTo(R`testo aggiunto prima a \evid{b} c`, reps), 'testo aggiunto prima a b c');
});
