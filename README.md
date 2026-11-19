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
- Barra in alto: **⟳ Compila**, **☰ Riassunto**, **◻ PDF pulito**, **⇩ Importa**.

Come funziona: SyncTeX (`synctex edit`, compila con `-synctex=1`) indica la riga del sorgente;
lì vicino il testo selezionato viene cercato in modo tollerante (accenti LaTeX, legature,
sillabazione, comandi, formule, `\cite`/`\ref`), allargato alle parole intere e avvolto in `\evid{...}`.

## Evidenziare nel .tex

| Dove | Cosa |
| --- | --- |
| Barra in alto a destra | 📄 Apri PDF · 🖍 **Evidenzia** · 🎨 **Evidenzia con colore…** |
| Tasto destro | Evidenzia, Evidenzia con colore…, Aggiungi/modifica nota, Rimuovi, Mostra nel PDF |
| Barra di stato | pallino del colore attivo (clic = cambia) · Evidenzia |
| Tastiera | `Ctrl+Shift+H` evidenzia/toglie · `Ctrl+Alt+H` evidenzia con colore |

Col cursore dentro un `\evid{}` il pulsante *Evidenzia* lo toglie, *Evidenzia con colore…* lo ricolora.
L'estensione non rompe il LaTeX: spezza la selezione su paragrafi, ambienti, `\item`, `&`, `\\`,
commenti e graffe sbilanciate; tiene fuori `\footnote`, `\label`, i titoli e (con pdfLaTeX) le formule.

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

## Preambolo

Alla prima evidenziazione l'estensione propone di inserire (prima di `\begin{document}`) il
blocco tra `% --- Evidenziatore LaTeX` e `% --- fine Evidenziatore LaTeX ---`, per pdfLaTeX
(`soul`) o LuaLaTeX (`lua-ul`). Quel blocco è gestito dall'estensione e viene aggiornato da solo.

## Sviluppo

```sh
npm install
npm run compile     # oppure F5 in VS Code → "Avvia estensione"
npm test            # test (parser, ricerca nel sorgente, riassunto, importazione)
npm run package     # crea il .vsix
```
