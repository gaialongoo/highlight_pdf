/**
 * Testo sotto le annotazioni "Highlight" di un PDF (Fase 3). Nessun `vscode`.
 * Coordinate PDF: origine in basso a sinistra, in punti.
 */
import { EvidColor } from './colorsfile';

export interface TItem { str: string; x: number; y: number; w: number; h: number; }
export interface Quad { x0: number; y0: number; x1: number; y1: number; }

/** QuadPoints (8 numeri per riquadro, in qualunque ordine dei vertici) → riquadri. */
export function quadsFromPoints(qp: ArrayLike<number>): Quad[] {
  const out: Quad[] = [];
  for (let i = 0; i + 7 < qp.length; i += 8) {
    const xs = [qp[i], qp[i + 2], qp[i + 4], qp[i + 6]];
    const ys = [qp[i + 1], qp[i + 3], qp[i + 5], qp[i + 7]];
    out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  // ordine di lettura: dall'alto in basso, da sinistra a destra
  return out.sort((a, b) => (b.y1 - a.y1) || (a.x0 - b.x0));
}

/** Testo coperto dai riquadri (taglia i frammenti in proporzione alla larghezza). */
export function textInQuads(items: TItem[], quads: Quad[]): string {
  const parts: string[] = [];
  for (const q of quads) {
    const qh = q.y1 - q.y0;
    const line = items
      .filter(it => {
        const top = it.y + it.h * 0.8, bottom = it.y - it.h * 0.2;
        const overlap = Math.min(top, q.y1) - Math.max(bottom, q.y0);
        return it.str.length > 0 && overlap > 0.5 * Math.min(it.h, qh) && it.x < q.x1 && it.x + it.w > q.x0;
      })
      .sort((a, b) => a.x - b.x);
    let s = '';
    let lastEnd = -Infinity;
    for (const it of line) {
      const cw = it.w / it.str.length;
      const i0 = Math.max(0, Math.round((q.x0 - it.x) / cw));
      const i1 = Math.min(it.str.length, Math.round((q.x1 - it.x) / cw));
      if (i1 <= i0) { continue; }
      const piece = it.str.slice(i0, i1);
      const startX = it.x + i0 * cw;
      if (s && startX - lastEnd > cw * 0.3 && !s.endsWith(' ') && !piece.startsWith(' ')) { s += ' '; }
      s += piece;
      lastEnd = it.x + i1 * cw;
    }
    if (s.trim()) { parts.push(s.trim()); }
  }
  // "parola-" a fine riga + "continua" → "parola-continua": la normalizzazione toglie il trattino
  return parts.join(' ');
}

function hue(r: number, g: number, b: number): { h: number; s: number } {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d === 0) { return { h: 0, s: 0 }; }
  let h: number;
  if (mx === r) { h = ((g - b) / d) % 6; } else if (mx === g) { h = (b - r) / d + 2; } else { h = (r - g) / d + 4; }
  return { h: (h * 60 + 360) % 360, s: d / mx };
}

/** Colore della palette più vicino per tonalità (gli evidenziatori "fluo" diventano pastello). */
export function nearestColor(rgb: [number, number, number], palette: EvidColor[]): EvidColor {
  const a = hue(...rgb);
  let best = palette[0], bestD = Infinity;
  for (const c of palette) {
    const p = hue(parseInt(c.hex.slice(0, 2), 16), parseInt(c.hex.slice(2, 4), 16), parseInt(c.hex.slice(4, 6), 16));
    let d = Math.abs(a.h - p.h);
    d = Math.min(d, 360 - d);
    if (a.s < 0.1) { d = p.s; } // grigio → il colore meno saturo
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
