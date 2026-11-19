import * as vscode from 'vscode';

export type ModoRicompilazione = 'inattivita' | 'conteggio' | 'manuale';

export function cfg() {
  const c = vscode.workspace.getConfiguration('evid');
  return {
    comando: c.get<string>('comando', 'evid').replace(/^\\/, ''),
    colorePredefinito: c.get<string>('colorePredefinito', 'evidGiallo'),
    compilatore: c.get<'auto' | 'pdflatex' | 'lualatex'>('compilatore', 'auto'),
    fileColori: c.get<string>('fileColori', 'evid-colori').replace(/\.tex$/i, ''),
    legenda: c.get<Record<string, string>>('legenda', {}),
    modo: c.get<ModoRicompilazione>('ricompilazione.modo', 'inattivita'),
    secondi: Math.max(1, c.get<number>('ricompilazione.secondi', 20)),
    ogniN: Math.max(1, c.get<number>('ricompilazione.ogniN', 5)),
    testoScuro: c.get<boolean>('decorazioni.testoScuro', true),
  };
}
