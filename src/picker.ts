import * as vscode from 'vscode';
import { ColorStore } from './colors';
import {
  EvidColor, PASTELLI, autoName, displayName, isValidColorName, normalizeHex,
} from './colorsfile';

interface ColorItem extends vscode.QuickPickItem { color?: EvidColor; action?: 'altro' | 'legenda'; }

const BTN_STAR: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-empty'), tooltip: 'Aggiungi ai preferiti' };
const BTN_UNSTAR: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-full'), tooltip: 'Togli dai preferiti' };
const BTN_LABEL: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('tag'), tooltip: 'Modifica etichetta (legenda)' };

/**
 * QuickPick dei colori: pastelli, preferiti, recenti, colori del progetto,
 * "Altro colore…". Restituisce il colore scelto (undefined = annullato).
 */
export async function pickColor(ctx: vscode.ExtensionContext, store: ColorStore, rootFile: string | undefined,
  title = 'Scegli il colore'): Promise<EvidColor | undefined> {
  const qp = vscode.window.createQuickPick<ColorItem>();
  qp.title = title;
  qp.placeholder = 'Colore (★ = preferito, 🏷 = etichetta della legenda)';
  qp.matchOnDescription = true;

  const build = () => {
    const active = store.active;
    const used = new Set<string>();
    const item = (c: EvidColor): ColorItem => {
      used.add(c.name);
      const label = store.label(c);
      return {
        label: displayName(c) + (c.name === active.name ? '  $(check)' : ''),
        description: `#${c.hex}${label ? '  ·  ' + label : ''}`,
        detail: undefined,
        iconPath: store.swatchUri(c),
        color: c,
        buttons: [store.isFavorite(c) ? BTN_UNSTAR : BTN_STAR, BTN_LABEL],
      };
    };
    const sep = (label: string): ColorItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: ColorItem[] = [];
    const section = (name: string, list: EvidColor[]) => {
      const fresh = list.filter(c => !used.has(c.name));
      if (fresh.length) { items.push(sep(name), ...fresh.map(item)); }
    };
    section('Preferiti', store.preferiti);
    section('Pastello', PASTELLI);
    section('Recenti', store.recenti);
    if (rootFile) { section('Definiti nel progetto', store.projectOnly(rootFile)); }
    items.push(sep(''),
      { label: '$(add) Altro colore…', description: 'palette completa, HEX, nome', action: 'altro', alwaysShow: true },
      { label: '$(tag) Modifica legenda…', description: 'significato dei colori', action: 'legenda', alwaysShow: true });
    const prevActive = qp.activeItems[0]?.color?.name;
    qp.items = items;
    const keep = items.find(i => i.color && i.color.name === (prevActive ?? active.name));
    if (keep) { qp.activeItems = [keep]; }
  };
  build();

  return new Promise<EvidColor | undefined>(resolve => {
    let done = false;
    const finish = (c: EvidColor | undefined) => { if (!done) { done = true; resolve(c); qp.dispose(); } };
    qp.onDidTriggerItemButton(async e => {
      const c = e.item.color!;
      if (e.button === BTN_LABEL) {
        qp.hide(); // InputBox e QuickPick non possono stare aperti insieme
        await editLabel(store, c);
        finish(undefined);
        return;
      }
      await store.toggleFavorite(c);
      build();
    });
    qp.onDidAccept(async () => {
      const sel = qp.selectedItems[0];
      if (!sel) { return; }
      if (sel.color) { finish(sel.color); return; }
      qp.hide();
      if (sel.action === 'altro') { finish(await openPalette(ctx, store)); }
      else if (sel.action === 'legenda') { await editLegend(ctx, store, rootFile); finish(undefined); }
    });
    qp.onDidHide(() => { if (!done && !qp.selectedItems.length) { finish(undefined); } });
    qp.show();
  });
}

export async function editLabel(store: ColorStore, c: EvidColor) {
  const v = await vscode.window.showInputBox({
    title: `Etichetta per ${displayName(c)} (#${c.hex})`,
    prompt: 'Es. Definizioni, Teoremi, Da ripassare. Vuoto = nessuna etichetta.',
    value: store.label(c) ?? '',
  });
  if (v !== undefined) { await store.setLabel(c, v); }
}

export async function editLegend(ctx: vscode.ExtensionContext, store: ColorStore, rootFile?: string) {
  for (;;) {
    const items = store.all(rootFile).map(c => ({
      label: displayName(c),
      description: store.label(c) ?? '— nessuna etichetta —',
      iconPath: store.swatchUri(c),
      color: c,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Legenda: scegli un colore a cui dare un significato (Esc per finire)',
    });
    if (!pick) { return; }
    await editLabel(store, pick.color);
  }
}

// ---------------------------------------------------------------------------
// Palette completa (webview)
// ---------------------------------------------------------------------------

export async function openPalette(ctx: vscode.ExtensionContext, store: ColorStore): Promise<EvidColor | undefined> {
  const panel = vscode.window.createWebviewPanel('evid.palette', 'Altro colore…',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: false });
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const start = store.active.hex;
  const swatches = [...PASTELLI, ...store.preferiti, ...store.recenti]
    .filter((c, i, a) => a.findIndex(x => x.hex === c.hex) === i)
    .map(c => `<button class="sw" title="${displayName(c)} #${c.hex}" data-hex="${c.hex}" style="background:#${c.hex}"></button>`)
    .join('');

  panel.webview.html = /* html */`<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; max-width: 420px; }
  h2 { font-weight: 600; font-size: 1.2em; margin: 0 0 12px; }
  .row { display: flex; gap: 10px; align-items: center; margin: 10px 0; }
  label { min-width: 110px; }
  input[type=text] { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; border-radius: 2px; }
  input[type=color] { width: 64px; height: 40px; border: none; padding: 0; background: none; cursor: pointer; }
  .sw { width: 22px; height: 22px; border-radius: 50%; border: 1px solid #8888; cursor: pointer; padding: 0; }
  .sws { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; }
  #preview { padding: 6px 10px; border-radius: 3px; color: #1f1f1f; }
  .err { color: var(--vscode-errorForeground); min-height: 1.2em; }
  button.main { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; }
  button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; }
</style></head><body>
<h2>Scegli un colore</h2>
<div class="sws">${swatches}</div>
<div class="row"><label for="pick">Palette</label><input type="color" id="pick" value="#${start}">
  <span id="preview">testo evidenziato</span></div>
<div class="row"><label for="hex">HEX</label><input type="text" id="hex" value="#${start}" maxlength="7"></div>
<div class="row"><label for="name">Nome LaTeX</label><input type="text" id="name" placeholder="automatico, es. evid${start}"></div>
<div class="row"><label for="label">Etichetta</label><input type="text" id="label" placeholder="es. Definizioni (facoltativa)"></div>
<div class="row"><label></label><span><input type="checkbox" id="fav"> <label for="fav">Salva tra i preferiti</label></span></div>
<div class="err" id="err"></div>
<div class="row"><button class="main" id="ok">Usa questo colore</button><button class="sec" id="cancel">Annulla</button></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const norm = s => { s = s.trim().replace(/^#/, '').toUpperCase();
    if (/^[0-9A-F]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
    return /^[0-9A-F]{6}$/.test(s) ? s : null; };
  const set = hex => { $('pick').value = '#' + hex; $('hex').value = '#' + hex;
    $('preview').style.background = '#' + hex; $('name').placeholder = 'automatico, es. evid' + hex; };
  set('${start}');
  $('pick').addEventListener('input', e => set(e.target.value.slice(1).toUpperCase()));
  $('hex').addEventListener('input', e => { const h = norm(e.target.value); if (h) { $('pick').value = '#' + h; $('preview').style.background = '#' + h; } });
  document.querySelectorAll('.sw').forEach(b => b.addEventListener('click', () => set(b.dataset.hex)));
  $('ok').addEventListener('click', () => {
    const hex = norm($('hex').value);
    const name = $('name').value.trim();
    if (!hex) { $('err').textContent = 'HEX non valido (es. #C8E6F5)'; return; }
    if (name && !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) { $('err').textContent = 'Il nome può contenere solo lettere e cifre, e deve iniziare con una lettera.'; return; }
    vscode.postMessage({ type: 'ok', hex, name, label: $('label').value, fav: $('fav').checked });
  });
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.addEventListener('keydown', e => { if (e.key === 'Enter') $('ok').click(); if (e.key === 'Escape') $('cancel').click(); });
  $('hex').focus(); $('hex').select();
</script></body></html>`;

  return new Promise<EvidColor | undefined>(resolve => {
    let done = false;
    const finish = (c?: EvidColor) => { if (!done) { done = true; resolve(c); panel.dispose(); } };
    panel.onDidDispose(() => finish(undefined));
    panel.webview.onDidReceiveMessage(async (m: { type: string; hex: string; name: string; label: string; fav: boolean }) => {
      if (m.type !== 'ok') { finish(undefined); return; }
      const hex = normalizeHex(m.hex);
      if (!hex) { return; }
      let name = m.name && isValidColorName(m.name) ? m.name : autoName(hex);
      // stesso nome di un colore esistente ma HEX diverso → usa il nome automatico
      const clash = store.byName(name);
      if (clash && clash.hex !== hex) {
        vscode.window.showWarningMessage(`Il nome ${name} è già usato per #${clash.hex}: uso ${autoName(hex)}.`);
        name = autoName(hex);
      }
      const c: EvidColor = { name, hex };
      if (m.fav && !store.isFavorite(c)) { await store.toggleFavorite(c); }
      if (m.label?.trim()) { await store.setLabel(c, m.label); }
      finish(c);
    });
  });
}
