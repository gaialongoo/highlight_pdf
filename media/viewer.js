// Viewer PDF dell'Evidenziatore LaTeX (gira dentro il webview).
// Rendering con pdf.js; la selezione viene mandata all'estensione, che con
// SyncTeX trova il punto nel .tex e lo avvolge in \evid{...}.

const vscode = acquireVsCodeApi();
const pdfjsLib = await import(window.EVID.pdfjs);

// Worker di pdf.js: il webview non può avviare worker da un'altra origine,
// quindi lo carichiamo come blob.
try {
  const code = await (await fetch(window.EVID.worker)).text();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
} catch (e) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = window.EVID.worker;
}

const $ = id => document.getElementById(id);
const viewer = $('viewer');
const floating = $('floating');
const menu = $('menu');
const saved = vscode.getState() || {};

const state = {
  doc: null,
  pages: [],          // { num, w, h, div, canvas, overlay, tl, renderedScale, task }
  scaleMode: saved.scaleMode || 'width',
  scale: 1,
  highlighterMode: !!saved.highlighterMode,
  colors: { active: null, quick: [], known: [] },
  knownRgb: [],
  pending: 0,
  overlays: [],       // { id, rects: [{page,x0,y0,x1,y1}], hex, kind }
  nextId: 1,
  lastSelection: null,
  synctex: true,
};

const persist = () => vscode.setState({
  scaleMode: state.scaleMode, highlighterMode: state.highlighterMode, pos: currentPos(),
});

// ---------------------------------------------------------------------------
// Caricamento e layout
// ---------------------------------------------------------------------------

async function load(data, keepPosition) {
  const pos = keepPosition ? currentPos() : (saved.pos || null);
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    toast('PDF non leggibile (compilazione in corso?)', 'error');
    return;
  }
  const old = state.doc;
  const oldPages = state.pages;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  state.doc = doc;
  state.pages = sizes.map((s, i) => ({ num: i + 1, w: s.w, h: s.h }));
  if (!keepPosition || state.pending === 0) { state.overlays = state.overlays.filter(o => o.kind === 'pending' && state.pending > 0); }
  buildPages(oldPages);
  restorePos(pos);
  observeAll();
  if (old) { setTimeout(() => old.destroy(), 2000); }
  updatePageInfo();
}

function computeScale() {
  if (typeof state.scaleMode === 'number') { return state.scaleMode; }
  const maxW = Math.max(...state.pages.map(p => p.w), 1);
  const fitW = (viewer.clientWidth - 32) / maxW;
  if (state.scaleMode === 'page') {
    const maxH = Math.max(...state.pages.map(p => p.h), 1);
    return Math.min(fitW, (viewer.clientHeight - 24) / maxH);
  }
  return fitW;
}

function buildPages(oldPages = []) {
  state.scale = Math.max(0.2, Math.min(6, computeScale()));
  const frag = document.createDocumentFragment();
  for (const p of state.pages) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = String(p.num);
    div.style.width = `${p.w * state.scale}px`;
    div.style.height = `${p.h * state.scale}px`;
    div.style.setProperty('--scale-factor', String(state.scale));
    // il vecchio disegno resta visibile finché la pagina nuova non è pronta
    const prev = oldPages[p.num - 1];
    if (prev && prev.canvas) {
      prev.canvas.classList.add('stale');
      div.appendChild(prev.canvas);
    }
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    div.appendChild(overlay);
    p.div = div; p.overlay = overlay; p.canvas = null; p.tl = null; p.renderedScale = 0;
    frag.appendChild(div);
  }
  oldPages.forEach(p => p.task && p.task.cancel && p.task.cancel());
  viewer.replaceChildren(frag);
  drawOverlays();
  syncZoomSelect();
}

let observer;
function observeAll() {
  if (observer) { observer.disconnect(); }
  observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) { renderPage(state.pages[Number(e.target.dataset.page) - 1]); }
    }
  }, { root: viewer, rootMargin: '150% 0px' });
  state.pages.forEach(p => observer.observe(p.div));
}

async function renderPage(p) {
  const dpr = window.devicePixelRatio || 1;
  if (!p || !state.doc || (p.renderedScale === state.scale && p.renderedDpr === dpr) || p.rendering) { return; }
  p.rendering = true;
  const scale = state.scale;
  const doc = state.doc;
  try {
    const page = await doc.getPage(p.num);
    const vp = page.getViewport({ scale });
    // un pixel del canvas = un pixel dello schermo (nitido anche col ridimensionamento
    // di Windows al 125%/150%): dimensioni CSS ricavate da quelle intere del canvas
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width * dpr);
    canvas.height = Math.round(vp.height * dpr);
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    const sx = canvas.width / vp.width, sy = canvas.height / vp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    p.task = page.render({ canvasContext: ctx, viewport: vp, transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : null });
    await p.task.promise;
    if (doc !== state.doc || scale !== state.scale) { return; }
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    const layer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
    await layer.render();
    if (doc !== state.doc || scale !== state.scale) { return; }
    // come nel visualizzatore di pdf.js: un blocco "fine contenuto" che, durante la
    // selezione, copre i vuoti tra le righe e impedisce che la selezione salti
    // fino alla fine del documento quando il mouse passa su uno spazio vuoto
    const eoc = document.createElement('div');
    eoc.className = 'endOfContent';
    tl.appendChild(eoc);
    p.div.querySelectorAll('canvas, .textLayer').forEach(el => el.remove());
    p.div.insertBefore(canvas, p.overlay);
    p.div.appendChild(tl);
    p.canvas = canvas; p.tl = tl; p.renderedScale = scale; p.renderedDpr = dpr;
  } catch (e) {
    if (!(e && e.name === 'RenderingCancelledException')) { console.error(e); }
  } finally {
    p.rendering = false;
  }
}

function relayout() {
  const pos = currentPos();
  const old = state.pages.map(p => ({ ...p }));
  buildPages(old);
  restorePos(pos);
  observeAll();
  persist();
}

// zoom di VS Code (Ctrl +/-) o schermo diverso: ridisegna alla nuova risoluzione,
// altrimenti le pagine restano ingrandite dalla vecchia e si vedono sfocate
function watchDpr() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  mq.addEventListener('change', () => { if (state.doc) { relayout(); } watchDpr(); }, { once: true });
}
watchDpr();

// posizione = pagina + frazione verticale, così sopravvive a zoom e ricompilazioni
function currentPos() {
  if (!state.pages.length) { return null; }
  const top = viewer.scrollTop;
  for (const p of state.pages) {
    if (!p.div) { continue; }
    if (p.div.offsetTop + p.div.offsetHeight > top) {
      return { page: p.num, frac: (top - p.div.offsetTop) / p.div.offsetHeight, left: viewer.scrollLeft };
    }
  }
  return null;
}

function restorePos(pos) {
  if (!pos) { return; }
  const p = state.pages[Math.min(pos.page, state.pages.length) - 1];
  if (!p) { return; }
  viewer.scrollTop = p.div.offsetTop + pos.frac * p.div.offsetHeight;
  viewer.scrollLeft = pos.left || 0;
}

function updatePageInfo() {
  const pos = currentPos();
  $('pageInfo').textContent = state.pages.length ? `${pos ? pos.page : 1} / ${state.pages.length}` : '';
}

// ---------------------------------------------------------------------------
// Coordinate: client (px) ↔ pagina (punti tipografici, origine in alto a sinistra)
// ---------------------------------------------------------------------------

function pageAt(clientX, clientY) {
  for (const p of state.pages) {
    const r = p.div.getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom && clientX >= r.left - 20 && clientX <= r.right + 20) { return { p, r }; }
  }
  return null;
}

function toPt(p, r, clientX, clientY) {
  return { x: (clientX - r.left) / state.scale, y: (clientY - r.top) / state.scale };
}

function selectionRects(range) {
  const out = [];
  const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 2);
  if (!rects.length) { return out; }
  const hs = rects.map(r => r.height).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)];
  for (const r of rects) {
    if (r.height > med * 2.5) { continue; } // rettangoli spuri (fine contenuto)
    const hit = pageAt(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) { continue; }
    const a = toPt(hit.p, hit.r, r.left, r.top), b = toPt(hit.p, hit.r, r.right, r.bottom);
    out.push({ page: hit.p.num, x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }
  return mergeLines(out);
}

/**
 * pdf.js spezza ogni riga in tanti frammenti: li uniamo in una sola striscia
 * per riga (niente buchi né zone più scure), un po' più alta del testo,
 * come il tratto di un evidenziatore.
 */
function mergeLines(rects) {
  const sorted = [...rects].sort((a, b) => a.page - b.page || a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const r of sorted) {
    const h = r.y1 - r.y0;
    const line = lines.find(l => l.page === r.page
      && Math.min(l.y1, r.y1) - Math.max(l.y0, r.y0) > 0.5 * Math.min(h, l.y1 - l.y0)
      && r.x0 <= l.x1 + 4 && r.x1 >= l.x0 - 4);
    if (line) {
      line.x0 = Math.min(line.x0, r.x0); line.x1 = Math.max(line.x1, r.x1);
      line.y0 = Math.min(line.y0, r.y0); line.y1 = Math.max(line.y1, r.y1);
    } else {
      lines.push({ ...r });
    }
  }
  for (const l of lines) {
    const pad = (l.y1 - l.y0) * 0.1;
    l.y0 -= pad; l.y1 += pad; l.x0 -= 0.6; l.x1 += 0.6;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Sovrapposizioni temporanee (evidenziazioni in attesa di compilazione)
// ---------------------------------------------------------------------------

function drawOverlays() {
  state.pages.forEach(p => p.overlay && p.overlay.replaceChildren());
  for (const o of [...state.overlays, ...searchOverlays()]) {
    for (const r of o.rects) {
      const p = state.pages[r.page - 1];
      if (!p || !p.overlay) { continue; }
      const d = document.createElement('div');
      d.className = 'mark ' + o.kind;
      d.dataset.id = String(o.id);
      d.style.left = `${(r.x0 / p.w) * 100}%`;
      d.style.top = `${(r.y0 / p.h) * 100}%`;
      d.style.width = `${((r.x1 - r.x0) / p.w) * 100}%`;
      d.style.height = `${((r.y1 - r.y0) / p.h) * 100}%`;
      if (o.hex) { d.style.background = '#' + o.hex; }
      d.title = o.kind === 'pending' ? 'In attesa di compilazione' : '';
      if (o.kind.startsWith('search')) { d.style.background = ''; }
      p.overlay.appendChild(d);
    }
  }
}

// ---------------------------------------------------------------------------
// Evidenziare
// ---------------------------------------------------------------------------

function captureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { return null; }
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || !el.closest('#viewer')) { return null; }
  const text = sel.toString();
  if (!text.trim()) { return null; }
  const rects = selectionRects(range);
  if (!rects.length) { return null; }
  const first = rects[0], last = rects[rects.length - 1];
  const yMid = r => (r.y0 + r.y1) / 2;
  return {
    text,
    rects,
    page: first.page,
    start: { page: first.page, x: first.x0 + 1, y: yMid(first) },
    end: { page: last.page, x: Math.max(last.x0, last.x1 - 1), y: yMid(last) },
    clientRect: range.getBoundingClientRect(),
  };
}

/** Animazione d'ingresso, solo sui riquadri dell'evidenziazione appena creata.
 *  Avviata da JS (non da CSS) così i ridisegni successivi non la ripetono. */
function animateIn(id) {
  viewer.querySelectorAll(`.mark[data-id="${id}"]`).forEach(d => {
    if (d.animate) {
      d.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 180, easing: 'ease-out' });
    }
  });
}

function doHighlight(s, colorName, withNote = false) {
  if (!s) { return; }
  const c = colorName ? state.colors.quick.find(q => q.name === colorName) || state.colors.active : state.colors.active;
  const id = state.nextId++;
  state.overlays.push({ id, rects: s.rects, hex: c ? c.hex : 'FFF3B0', kind: 'pending' });
  drawOverlays();
  animateIn(id);
  vscode.postMessage({ type: 'highlight', id, page: s.page, text: s.text, start: s.start, end: s.end, color: colorName, withNote });
  window.getSelection().removeAllRanges();
  hide(floating);
}

function showFloating(s) {
  floating.replaceChildren();
  const btn = document.createElement('button');
  btn.className = 'hl';
  btn.innerHTML = '🖍 Evidenzia';
  btn.title = 'Evidenzia col colore attivo';
  btn.onclick = () => doHighlight(s);
  floating.appendChild(btn);
  const noteBtn = document.createElement('button');
  noteBtn.className = 'more';
  noteBtn.textContent = '✎';
  noteBtn.title = 'Evidenzia e aggiungi una nota';
  noteBtn.onclick = () => doHighlight(s, undefined, true);
  floating.appendChild(noteBtn);
  for (const c of state.colors.quick) {
    floating.appendChild(dot(c, () => { doHighlight(s, c.name); }));
  }
  const more = document.createElement('button');
  more.className = 'more';
  more.textContent = '+';
  more.title = 'Altro colore…';
  more.onclick = () => {
    vscode.postMessage({ type: 'pickMore', then: { id: state.nextId++, page: s.page, text: s.text, start: s.start, end: s.end } });
    state.overlays.push({ id: state.nextId - 1, rects: s.rects, hex: 'CCCCCC', kind: 'pending' });
    drawOverlays();
    animateIn(state.nextId - 1);
    window.getSelection().removeAllRanges();
    hide(floating);
  };
  floating.appendChild(more);
  placePopup(floating, s.clientRect.left + s.clientRect.width / 2, s.clientRect.top, s.clientRect.bottom);
}

function dot(c, onclick) {
  const b = document.createElement('button');
  b.className = 'dot' + (state.colors.active && state.colors.active.name === c.name ? ' active' : '');
  b.style.background = '#' + c.hex;
  b.title = `${c.display}${c.label ? ' — ' + c.label : ''} (#${c.hex})`;
  b.onclick = e => { e.stopPropagation(); onclick(); };
  return b;
}

function placePopup(el, cx, top, bottom) {
  el.classList.remove('hidden');
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = Math.max(6, Math.min(window.innerWidth - w - 6, cx - w / 2));
  let y = top - h - 8;
  if (y < 44) { y = bottom + 8; }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function hide(el) { el.classList.add('hidden'); }
function show(el) { el.classList.remove('hidden'); }

// ---------------------------------------------------------------------------
// Clic su un'evidenziazione già compilata: riconosciuta dal colore dei pixel
// ---------------------------------------------------------------------------

function hexToRgb(h) { return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

function highlightColorAt(p, clientX, clientY) {
  if (!p.canvas) { return null; }
  const r = p.canvas.getBoundingClientRect();
  const sx = p.canvas.width / r.width, sy = p.canvas.height / r.height;
  const ctx = p.canvas.getContext('2d', { willReadFrequently: true });
  const R = 6;
  const x0 = Math.max(0, Math.round((clientX - r.left - R) * sx)), y0 = Math.max(0, Math.round((clientY - r.top - R) * sy));
  const w = Math.max(1, Math.round(2 * R * sx)), h = Math.max(1, Math.round(2 * R * sy));
  let data;
  try { data = ctx.getImageData(x0, y0, w, h).data; } catch { return null; }
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4 * 3) {
    for (let k = 0; k < state.knownRgb.length; k++) {
      const [rr, gg, bb] = state.knownRgb[k].rgb;
      if (Math.abs(data[i] - rr) <= 6 && Math.abs(data[i + 1] - gg) <= 6 && Math.abs(data[i + 2] - bb) <= 6) {
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  let best = -1, bestN = 0;
  counts.forEach((n, k) => { if (n > bestN) { best = k; bestN = n; } });
  return bestN >= 3 ? state.knownRgb[best].hex : null;
}

function wordAt(clientX, clientY) {
  const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(clientX, clientY) : null;
  if (!range || range.startContainer.nodeType !== 3) { return ''; }
  const t = range.startContainer.textContent || '';
  let a = range.startOffset, b = range.startOffset;
  while (a > 0 && /[\p{L}\p{N}]/u.test(t[a - 1])) { a--; }
  while (b < t.length && /[\p{L}\p{N}]/u.test(t[b])) { b++; }
  // con una parola troppo corta usiamo tutta la riga del frammento
  const w = t.slice(a, b);
  return w.length >= 3 ? w : t.trim().slice(0, 40);
}

function showHighlightMenu(hit, clientX, clientY, hex) {
  const pt = toPt(hit.p, hit.r, clientX, clientY);
  const word = wordAt(clientX, clientY);
  const send = (action, color) => {
    vscode.postMessage({ type: 'onHighlight', action, page: hit.p.num, pt, word, color });
    hide(menu);
  };
  menu.replaceChildren();
  const title = document.createElement('div');
  title.className = 'title';
  const known = state.colors.quick.find(q => q.hex === hex);
  title.textContent = known ? `${known.display}${known.label ? ' — ' + known.label : ''}` : `#${hex}`;
  menu.appendChild(title);
  const rm = document.createElement('button');
  rm.className = 'item';
  rm.textContent = '✕ Rimuovi evidenziazione';
  rm.onclick = () => {
    state.overlays.push({ id: state.nextId++, rects: [{ page: hit.p.num, x0: pt.x - 2, y0: pt.y - 6, x1: pt.x + 2, y1: pt.y + 6 }], kind: 'removing' });
    drawOverlays();
    send('remove');
  };
  menu.appendChild(rm);
  const nt = document.createElement('button');
  nt.className = 'item';
  nt.textContent = '✎ Nota…';
  nt.onclick = () => send('note');
  menu.appendChild(nt);
  const row = document.createElement('div');
  row.className = 'row';
  for (const c of state.colors.quick) { row.appendChild(dot(c, () => send('recolor', c.name))); }
  const more = document.createElement('button');
  more.className = 'more';
  more.textContent = '+';
  more.title = 'Altro colore…';
  more.onclick = () => send('pick');
  row.appendChild(more);
  menu.appendChild(row);
  const jump = document.createElement('button');
  jump.className = 'item';
  jump.textContent = '↪ Mostra nel sorgente';
  jump.onclick = () => { vscode.postMessage({ type: 'jump', page: hit.p.num, pt }); hide(menu); };
  menu.appendChild(jump);
  placePopup(menu, clientX, clientY - 4, clientY + 4);
}

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------

// --- selezione stabile (stessa tecnica del visualizzatore ufficiale di pdf.js) ---
let prevRange = null;
function resetEndOfContent() {
  document.querySelectorAll('.textLayer.selecting').forEach(t => t.classList.remove('selecting'));
  document.querySelectorAll('.textLayer').forEach(t => {
    const eoc = t.querySelector('.endOfContent');
    if (eoc && eoc !== t.lastElementChild) { eoc.style.width = ''; eoc.style.height = ''; t.appendChild(eoc); }
  });
  prevRange = null;
}
document.addEventListener('pointerdown', e => {
  const tl = e.target instanceof Element ? e.target.closest('.textLayer') : null;
  if (tl) { tl.classList.add('selecting'); }
});
document.addEventListener('pointerup', resetEndOfContent);
window.addEventListener('blur', resetEndOfContent);
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) { if (!document.querySelector('.textLayer.selecting')) { prevRange = null; } return; }
  const range = sel.getRangeAt(0);
  // si sta muovendo l'inizio o la fine della selezione?
  const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
    || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
  let anchor = modifyStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === Node.TEXT_NODE) { anchor = anchor.parentNode; }
  const tl = anchor instanceof Element ? anchor.closest('.textLayer') : null;
  if (tl) {
    tl.classList.add('selecting');
    const eoc = tl.querySelector('.endOfContent');
    // il blocco va subito dopo il punto che si sta trascinando: i vuoti oltre
    // quel punto "appartengono" lì e la selezione non scappa in avanti
    if (eoc && anchor !== tl && anchor.parentElement) {
      eoc.style.width = tl.style.width; eoc.style.height = tl.style.height;
      anchor.parentElement.insertBefore(eoc, modifyStart ? anchor : anchor.nextSibling);
    }
  }
  prevRange = range.cloneRange();
});

/**
 * Selezione "scappata": comprende pagine fuori da quelle dove hai premuto e
 * rilasciato il mouse, o è enorme. Non va evidenziata.
 */
function runawaySelection(s, downPt, upPt) {
  if (s.text.length > 4000) { return true; }
  const pd = downPt && pageAt(downPt.x, downPt.y)?.p.num;
  const pu = upPt && pageAt(upPt.x, upPt.y)?.p.num;
  if (!pd || !pu) { return false; }
  const lo = Math.min(pd, pu), hi = Math.max(pd, pu);
  return s.rects.some(r => r.page < lo || r.page > hi);
}

let downAt = null;
viewer.addEventListener('mousedown', e => {
  downAt = { x: e.clientX, y: e.clientY };
  if (!floating.contains(e.target)) { hide(floating); }
  if (!menu.contains(e.target)) { hide(menu); }
});

viewer.addEventListener('mouseup', e => {
  if (e.button !== 0) { return; }
  // meno sensibile: un clic con una piccola sbavatura non è una selezione
  const moved = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6;
  const down = downAt, up = { x: e.clientX, y: e.clientY };
  setTimeout(() => {
    const s = captureSelection();
    if (s && (moved || e.detail >= 2) && runawaySelection(s, down, up)) {
      window.getSelection().removeAllRanges();
      toast('Selezione scappata oltre il punto dove hai lasciato il mouse: non la evidenzio. Riprova.');
      return;
    }
    if (s && (moved || e.detail >= 2)) {
      state.lastSelection = s;
      if (state.highlighterMode) { doHighlight(s); } else { showFloating(s); }
      return;
    }
    if (moved) { return; }
    const hit = pageAt(e.clientX, e.clientY);
    if (!hit) { return; }
    if (e.ctrlKey || e.metaKey) {
      vscode.postMessage({ type: 'jump', page: hit.p.num, pt: toPt(hit.p, hit.r, e.clientX, e.clientY) });
      return;
    }
    const hex = highlightColorAt(hit.p, e.clientX, e.clientY);
    if (hex) { showHighlightMenu(hit, e.clientX, e.clientY, hex); }
  }, 10);
});

let scrollTimer;
viewer.addEventListener('scroll', () => {
  hide(floating); hide(menu);
  updatePageInfo();
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(persist, 300);
});

viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey) { return; }
  e.preventDefault();
  setZoom(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ---------------------------------------------------------------------------
// Annulla / ripeti
// ---------------------------------------------------------------------------

$('undoBtn').onclick = () => vscode.postMessage({ type: 'undo' });
$('redoBtn').onclick = () => vscode.postMessage({ type: 'redo' });

function renderHistory(h) {
  $('undoBtn').disabled = !h.canUndo;
  $('redoBtn').disabled = !h.canRedo;
  $('undoBtn').title = h.canUndo ? `Annulla ${h.undoLabel} (Ctrl+Z)` : 'Niente da annullare';
  $('redoBtn').title = h.canRedo ? `Ripeti ${h.redoLabel} (Ctrl+Y)` : 'Niente da ripetere';
}

// ---------------------------------------------------------------------------
// Cerca nel PDF
// ---------------------------------------------------------------------------

const search = { query: '', matches: [], cur: -1, index: null, indexDoc: null, timer: 0 };

/** minuscole, senza accenti né legature; restituisce anche la mappa verso l'originale */
function foldWithMap(s) {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const ch of f) { out += ch; map.push(i); }
  }
  return { out, map };
}

/** Testo di ogni pagina, con per ogni carattere l'elemento pdf.js da cui viene. */
async function buildIndex() {
  if (search.index && search.indexDoc === state.doc) { return search.index; }
  const doc = state.doc;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    let text = '';
    const owner = []; // per carattere: [indice elemento, posizione nell'elemento] o null (spazio aggiunto)
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string') { continue; }
      const k = items.length;
      items.push(it);
      for (let j = 0; j < it.str.length; j++) {
        const c = /\s/.test(it.str[j]) ? ' ' : it.str[j];
        if (c === ' ' && text.endsWith(' ')) { continue; }
        text += c; owner.push([k, j]);
      }
      if ((it.hasEOL || it.str) && !text.endsWith(' ')) {
        // a fine riga una parola sillabata ("funzio-") si unisce alla successiva
        if (it.hasEOL && text.endsWith('-')) { text = text.slice(0, -1); owner.pop(); }
        else { text += ' '; owner.push(null); }
      }
    }
    const { out, map } = foldWithMap(text);
    pages.push({ n, vp, items, text, owner, folded: out, fmap: map });
  }
  if (doc !== state.doc) { return buildIndex(); }
  search.index = pages; search.indexDoc = doc;
  return pages;
}

/** Rettangoli (unità pagina, scala 1) dei caratteri [a, b) del testo di una pagina. */
function rectsFor(pg, a, b) {
  const byItem = new Map();
  for (let i = a; i < b; i++) {
    const o = pg.owner[i];
    if (!o) { continue; }
    const [k, j] = o;
    const r = byItem.get(k) ?? { k, from: j, to: j + 1 };
    r.from = Math.min(r.from, j); r.to = Math.max(r.to, j + 1);
    byItem.set(k, r);
  }
  const rects = [];
  for (const { k, from, to } of byItem.values()) {
    const it = pg.items[k];
    const tx = pdfjsLib.Util.transform(pg.vp.transform, it.transform);
    const h = Math.hypot(tx[2], tx[3]) || 10;
    const len = it.str.length || 1;
    const w = it.width; // a scala 1 le unità coincidono
    const x = tx[4];
    rects.push({ page: pg.n, x0: x + w * from / len, x1: x + w * to / len, y0: tx[5] - h * 0.85, y1: tx[5] + h * 0.2 });
  }
  return mergeLines(rects);
}

async function runSearch(keepPosition = false) {
  const q = foldWithMap($('searchInput').value.trim().replace(/\s+/g, ' ')).out;
  search.query = q;
  const prevPage = search.matches[search.cur]?.page;
  search.matches = []; search.cur = -1;
  if (!q || !state.doc) { renderSearch(); drawOverlays(); return; }
  const pages = await buildIndex();
  if (q !== search.query) { return; } // nel frattempo l'utente ha scritto altro
  for (const pg of pages) {
    for (let i = pg.folded.indexOf(q); i >= 0; i = pg.folded.indexOf(q, i + 1)) {
      const a = pg.fmap[i], b = pg.fmap[i + q.length - 1] + 1;
      search.matches.push({ page: pg.n, rects: rectsFor(pg, a, b) });
    }
  }
  if (search.matches.length) {
    // parti dal primo risultato dalla pagina che stai guardando in poi
    const from = keepPosition && prevPage ? prevPage : (currentPos()?.page ?? 1);
    const k = search.matches.findIndex(m => m.page >= from);
    search.cur = k < 0 ? 0 : k;
  }
  renderSearch();
  drawOverlays();
  if (!keepPosition) { revealMatch(); }
}

function searchOverlays() {
  return search.matches.map((m, i) => ({ id: -1 - i, rects: m.rects, kind: i === search.cur ? 'search cur' : 'search' }));
}

function renderSearch() {
  const n = search.matches.length;
  $('searchCount').textContent = !search.query ? '' : n ? `${search.cur + 1}/${n}` : 'nessun risultato';
  $('searchInput').classList.toggle('none', !!search.query && !n);
}

function revealMatch() {
  const m = search.matches[search.cur];
  if (!m) { return; }
  const p = state.pages[m.page - 1];
  const r = m.rects[0];
  if (!p || !p.div || !r) { return; }
  const y = p.div.offsetTop + r.y0 * state.scale;
  if (y < viewer.scrollTop + 40 || y > viewer.scrollTop + viewer.clientHeight - 60) {
    viewer.scrollTop = y - viewer.clientHeight / 3;
  }
  const x = p.div.offsetLeft + r.x0 * state.scale;
  if (x < viewer.scrollLeft || x > viewer.scrollLeft + viewer.clientWidth - 40) {
    viewer.scrollLeft = x - viewer.clientWidth / 3;
  }
}

function moveSearch(dir) {
  const n = search.matches.length;
  if (!n) { return; }
  search.cur = (search.cur + dir + n) % n;
  renderSearch(); drawOverlays(); revealMatch();
}

function openSearch() {
  show($('searchBar'));
  const inp = $('searchInput');
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) { inp.value = sel; void runSearch(); }
  inp.focus(); inp.select();
}

function closeSearch() {
  hide($('searchBar'));
  search.matches = []; search.cur = -1; search.query = '';
  drawOverlays();
}

$('searchBtn').onclick = () => ($('searchBar').classList.contains('hidden') ? openSearch() : closeSearch());
$('searchClose').onclick = closeSearch;
$('searchNext').onclick = () => moveSearch(1);
$('searchPrev').onclick = () => moveSearch(-1);
$('searchInput').addEventListener('input', () => {
  clearTimeout(search.timer);
  search.timer = setTimeout(() => void runSearch(), 200);
});
$('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(search.timer);
    const q = foldWithMap($('searchInput').value.trim().replace(/\s+/g, ' ')).out;
    if (q !== search.query) { void runSearch(); } else { moveSearch(e.shiftKey ? -1 : 1); }
  }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
});

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
  if (mod && e.key === 'F3') { e.preventDefault(); moveSearch(e.shiftKey ? -1 : 1); return; }
  if (e.key === 'F3') { e.preventDefault(); moveSearch(e.shiftKey ? -1 : 1); return; }
  // nella casella di ricerca Ctrl+Z annulla il testo scritto, non le evidenziazioni
  if (e.target instanceof HTMLInputElement) { return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); vscode.postMessage({ type: 'undo' }); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); vscode.postMessage({ type: 'redo' }); return; }
});

document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) { return; }
  if (e.key === 'Escape') { hide(floating); hide(menu); }
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(state.scale * 1.1); }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(state.scale / 1.1); }
  if (e.key === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey) { toggleMode(); }
  if (e.key === 'u' && !e.ctrlKey && !e.metaKey && !e.altKey) { vscode.postMessage({ type: 'last' }); }
  if (e.key === 'Enter' && !floating.classList.contains('hidden') && state.lastSelection) { doHighlight(state.lastSelection); }
});

new ResizeObserver(() => {
  if (typeof state.scaleMode === 'number' || !state.pages.length) { return; }
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => { if (Math.abs(computeScale() - state.scale) > 0.01) { relayout(); } }, 150);
}).observe(viewer);

function setZoom(v) {
  state.scaleMode = Math.max(0.25, Math.min(5, v));
  relayout();
}

function syncZoomSelect() {
  const sel = $('zoomSel');
  const val = typeof state.scaleMode === 'number' ? String(state.scaleMode) : state.scaleMode;
  let opt = [...sel.options].find(o => o.value === val);
  [...sel.options].filter(o => o.dataset.custom).forEach(o => o.remove());
  if (!opt) {
    opt = new Option(`${Math.round(state.scale * 100)}%`, val);
    opt.dataset.custom = '1';
    sel.add(opt);
  }
  sel.value = val;
}

$('zoomSel').onchange = e => {
  const v = e.target.value;
  state.scaleMode = v === 'width' || v === 'page' ? v : Number(v);
  relayout();
};
$('zoomIn').onclick = () => setZoom(state.scale * 1.15);
$('zoomOut').onclick = () => setZoom(state.scale / 1.15);
$('moreBtn').onclick = () => vscode.postMessage({ type: 'pickMore' });
$('compileBtn').onclick = () => vscode.postMessage({ type: 'compile' });
$('summaryBtn').onclick = () => vscode.postMessage({ type: 'summary' });
$('cleanBtn').onclick = () => vscode.postMessage({ type: 'clean' });
$('importBtn').onclick = () => vscode.postMessage({ type: 'import' });
$('lastBtn').onclick = () => vscode.postMessage({ type: 'last' });

/** Mostra un punto (da SyncTeX in avanti) e lo fa lampeggiare. */
function scrollToPoint(page, x, y) {
  const p = state.pages[page - 1];
  if (!p || !p.div) { return; }
  viewer.scrollTop = p.div.offsetTop + y * state.scale - viewer.clientHeight / 3;
  const m = document.createElement('div');
  m.className = 'flash';
  m.style.top = `${(y / p.h) * 100}%`;
  p.div.appendChild(m);
  setTimeout(() => m.remove(), 1600);
}
$('modeBtn').onclick = () => toggleMode();

function toggleMode() {
  state.highlighterMode = !state.highlighterMode;
  renderToolbar();
  persist();
  toast(state.highlighterMode
    ? 'Modalità evidenziatore: ogni selezione viene evidenziata subito'
    : 'Modalità evidenziatore disattivata');
}

function renderToolbar() {
  $('modeBtn').classList.toggle('on', state.highlighterMode);
  const a = state.colors.active;
  if (a) { $('modeBtn').style.setProperty('--active', '#' + a.hex); }
  const dots = $('dots');
  dots.replaceChildren(...state.colors.quick.map(c => dot(c, () => vscode.postMessage({ type: 'setActive', color: c.name }))));
  $('pendingTxt').textContent = state.pending > 0
    ? `${state.pending} da compilare` : 'Compila';
  $('compileBtn').classList.toggle('pending', state.pending > 0);
}

let toastTimer;
function toast(text, kind = 'info') {
  const t = $('toast');
  t.textContent = text;
  t.className = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 6000 : 3500);
}

// ---------------------------------------------------------------------------
// Messaggi dall'estensione
// ---------------------------------------------------------------------------

window.addEventListener('message', async ev => {
  const m = ev.data;
  switch (m.type) {
    case 'load':
      state.pending = m.pending || 0;
      state.synctex = m.synctex;
      await load(m.data, m.keepPosition);
      // PDF ricompilato: la ricerca aperta si rifà sul testo nuovo
      search.index = null;
      if (search.query) { void runSearch(true); }
      if (!m.synctex) { toast('Manca il file .synctex.gz: compila con -synctex=1 per evidenziare con precisione.', 'error'); }
      renderToolbar();
      break;
    case 'colors':
      state.colors = { active: m.active, quick: m.quick, known: m.known };
      state.knownRgb = m.known.map(hex => ({ hex, rgb: hexToRgb(hex) }));
      renderToolbar();
      break;
    case 'pending':
      state.pending = m.count;
      renderToolbar();
      break;
    case 'history':
      renderHistory(m);
      break;
    case 'applied':
      if (!m.ok) {
        state.overlays = state.overlays.filter(o => o.id !== m.id);
        drawOverlays();
      }
      break;
    case 'toast':
      toast(m.text, m.kind);
      break;
    case 'scrollTo':
      scrollToPoint(m.page, m.x, m.y);
      break;
  }
});

renderToolbar();
vscode.postMessage({ type: 'ready' });
