# Evidenziatore LaTeX

Evidenzia gli appunti LaTeX con un clic, **nel PDF** o nel `.tex`. Le evidenziazioni
finiscono nel sorgente come `\evid{...}` / `\evid[evidRosa]{...}` /
`\evid[evidRosa][nota]{...}`, quindi sopravvivono a ogni modifica e ricompilazione.

## Evidenziare nel PDF

Apri il PDF con **Evidenziatore: Apri PDF per evidenziare** (pulsante 📄 in alto a destra
nel `.tex`, nel viewer di LaTeX Workshop, tasto destro sul PDF, o dal pannello).
Alla prima apertura puoi sceglierlo come viewer predefinito dei PDF.

- **Seleziona del testo**: compare una barra con **🖍 Evidenzia**, **✎** (evidenzia e aggiungi
  una nota), i pallini dei colori e **+** (palette completa).
- **Modalità evidenziatore** (🖍 in alto, o tasto `H`): ogni selezione viene evidenziata subito.
- **Clic su un'evidenziazione**: *Rimuovi*, *Nota…*, cambio colore, *Mostra nel sorgente*.
- **Ctrl+clic**: salta alla riga del `.tex`.
- **↶ / ↷** (`Ctrl+Z` / `Ctrl+Y`): annulla e ripeti evidenziazioni, cambi di colore, rimozioni
  e note. Non annulla un punto del `.tex` modificato a mano nel frattempo; la cronologia si
  azzera chiudendo VS Code.
- **⌕ Cerca** (`Ctrl+F`): in tutto il PDF, senza badare ad accenti e maiuscole ("perche" trova
  "Perché"). `Invio` / `Maiusc+Invio` (o ▲▼, `F3`) per scorrere i risultati, `Esc` per chiudere.
- Barra in alto: **⟳ Compila**, **☰ Riassunto**, **◻ PDF pulito**, **⇩ Importa**.

Una selezione che "scappa" oltre le pagine dove hai premuto e lasciato il mouse (o supera i
4000 caratteri) non viene evidenziata.

Come funziona: SyncTeX (`synctex edit`, compila con `-synctex=1`) indica la riga del sorgente;
lì vicino il testo selezionato viene cercato in modo tollerante (accenti LaTeX, legature,
sillabazione, comandi, `\cite`/`\ref`, lettere greche e simboli come `\Theta`, `\leq`, `\sum`,
pezzi di formula che il PDF non restituisce), allargato alle parole intere e avvolto in `\evid{...}`.
Senza SyncTeX si cerca nel file principale e nei file `\input`/`\include`, ma una selezione corta
può finire su un'altra occorrenza della stessa parola.

## Evidenziare nel .tex

| Dove | Cosa |
| --- | --- |
| Barra in alto a destra | 📄 Apri PDF · 🖍 **Evidenzia** · 🎨 **Evidenzia con colore…** |
| Tasto destro | Evidenzia, Evidenzia con colore…, Aggiungi/modifica nota, Rimuovi, Mostra nel PDF |
| Barra di stato | pallino del colore attivo (clic = cambia) · Evidenzia |
| Tastiera | `Ctrl+Shift+H` evidenzia/toglie · `Ctrl+Alt+H` evidenzia con colore |

Col cursore dentro un `\evid{}` il pulsante *Evidenzia* lo toglie, *Evidenzia con colore…* lo ricolora.
Per non rompere il LaTeX la selezione viene spezzata su paragrafi, ambienti, `\item`, `&`, `\\`,
commenti, graffe sbilanciate e comandi come `\noindent`, `\centering`, `\vspace`. Restano sempre fuori:
il preambolo, `\section` e titoli, `\label`, `\footnote`, `\caption`, `\includegraphics`, `\input`,
gli argomenti di `\begin{…}[…]{…}` (es. il titolo di un box) e gli ambienti di disegno e codice
(`tikzpicture`, `axis`, `forest`, `verbatim`, `lstlisting`, `minted`…).

**Formule.** Dentro una formula `\evid` disegna uno sfondo colorato al posto di `\hl`:
`$\evid{\Theta(n)}$`, `\[ \evid{a+b} = c \]`, anche in `$$…$$` e negli `align`. Una selezione non
taglia mai una formula a metà: viene allargata alla formula intera, o alle graffe complete se sta
tutta dentro. Con pdfLaTeX il testo intorno usa `\hl` e la formula il suo `\evid` interno.

## Pannello "Evidenziazioni"

Icona dell'evidenziatore nella barra laterale. Tutte le evidenziazioni del progetto
(anche nei file `\input`/`\include`), raggruppate **per sezione** o **per colore**,
con filtro per colore e ricerca. Clic: va al punto nel `.tex` e nel PDF.
Sulle voci: ✎ nota, 🎨 colore, 🗑 rimuovi.

## Colori e legenda

Pastelli predefiniti, preferiti ★, recenti e **Altro colore…** (palette completa, HEX, nome).
I colori nuovi vengono aggiunti da soli a `evid-colori.tex`. Con *Modifica legenda* dai un
significato a ogni colore (Rosa = Definizioni…); nel PDF lo stampi con `\legendaevid`.

## Note

`\evid[colore][nota]{testo}`: la nota va **a margine** se c'è spazio, altrimenti **a piè di
pagina**, nello stesso colore. Nell'editor si vede passando col mouse.

## Riassunto, PDF pulito, importazione

- **Genera riassunto**: tutte le evidenziazioni con la loro sezione (o per colore) e le note,
  in `…-riassunto.pdf` (stesso preambolo degli appunti) oppure in Markdown.
- **PDF pulito**: `…-pulito.pdf` senza evidenziazioni né note, senza toccare i sorgenti.
- **Importa da PDF annotato**: riporta nel `.tex` le evidenziazioni fatte con Edge/Acrobat su una
  copia del PDF (i colori fluo diventano il pastello più vicino, i commenti diventano note);
  un report elenca i passaggi non trovati.

## Ricompilazione

Non a ogni evidenziazione: dopo **20 s** senza nuove evidenziazioni (`evid.ricompilazione.modo`:
`inattivita` | `conteggio` | `manuale`). Se l'editor attivo è il `.tex` compila LaTeX Workshop,
altrimenti l'estensione stessa (stesso pdflatex), una compilazione alla volta. Il viewer resta
alla stessa posizione.

**Rete di sicurezza.** Le evidenziazioni nuove restano "sotto osservazione" finché una compilazione
non va a buon fine. Se la compilazione fallisce su una riga occupata da una di esse (o fino a 3
righe dopo), quell'evidenziazione viene annullata, il file salvato e si ricompila, con un avviso
che dice dove. Le evidenziazioni già compilate non vengono mai toccate.

## Preambolo

Alla prima evidenziazione l'estensione propone di inserire (prima di `\begin{document}`) il
blocco tra `% --- Evidenziatore LaTeX` e `% --- fine Evidenziatore LaTeX ---`, per pdfLaTeX
(`soul`) o LuaLaTeX (`lua-ul`). Quel blocco è gestito dall'estensione e viene aggiornato da solo
(versione attuale: v3, con il supporto alle formule) alla prima evidenziazione riuscita.

## Limiti: cosa può ancora andare storto

L'estensione scrive nel `.tex`, quindi non è mai sicura al 100%. Conviene usare git e fare un
commit prima di una sessione di evidenziazione: qualunque danno si annulla con `git diff` /
`git checkout`.

- **Comandi che `\hl` (soul) non digerisce**: `\url`, `\verb`, `\href` o macro proprie dentro
  un'evidenziazione possono non compilare. La rete di sicurezza ripara solo se l'errore cade
  vicino all'evidenziazione e se compila l'estensione (non LaTeX Workshop da solo al salvataggio).
- **Punto sbagliato**: con selezioni molto corte o senza SyncTeX può essere colpita un'altra
  occorrenza della stessa parola. Il file compila, ma il colore va altrove.
- **Errori silenziosi**: alcuni errori LaTeX non bloccano la compilazione e nessuno avvisa.
- **Impaginazione**: `\hl` e gli sfondi nelle formule possono spostare un po' a capo e salti
  pagina; negli `align` lo spazio attorno a `=` si stringe se evidenzi solo un pezzo di riga.
  Il *PDF pulito* torna identico all'originale.
- **Fuori da VS Code** (Overleaf, altre persone) il `.tex` compila solo insieme al blocco nel
  preambolo e a `evid-colori.tex`.

## Sviluppo

```sh
npm install
npm run compile     # oppure F5 in VS Code → "Avvia estensione"
npm test            # test (parser, ricerca nel sorgente, riassunto, importazione,
                    #       annulla/ripeti, rete di sicurezza)
npm run package     # crea il .vsix
```

Se l'estensione è installata dal `.vsix`, le modifiche al codice arrivano in VS Code solo dopo
`npm run package`, `code --install-extension evidenziatore-latex-<versione>.vsix --force` e
*Developer: Reload Window*.
