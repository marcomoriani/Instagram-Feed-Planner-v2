# Rebecca • Instagram Feed Planner v7

Versione v5 invariata nelle funzioni di foto, memoria, backup e caroselli. La v7 modifica in modo mirato il solo riordino su iPhone/Safari.

## Correzione v7: riordino libero

- In modalità **Modifica feed**, tieni premuto un post e continua a tenere il dito sullo schermo.
- Puoi trascinarlo da una riga a qualsiasi altra riga, non soltanto nella casella vicina.
- Safari non prende più il gesto come scroll verticale durante il trascinamento (`touch-action: none` solo in modalità modifica).
- Se arrivi vicino al bordo alto o basso dello schermo, la pagina scorre automaticamente mentre continui a trascinare.
- L'ordine viene salvato soltanto quando rilasci il dito.
- La barra inferiore è più compatta e mostra chiaramente quando il trascinamento è attivo.

**Compatibilità dati:** database e formato dei post restano quelli della v5 (`DB_VERSION = 5`, `DATA_VERSION = 5`), quindi l'aggiornamento non resetta né migra di nuovo i post già salvati.

---

Versione ottimizzata per iPhone/Safari e GitHub Pages.

## Correzioni principali della v5

- I 14 post iniziali non dipendono più dal caricamento di 14 file separati: sono incorporati in `initial-posts.js`, quindi non compaiono più riquadri con immagine rotta quando Safari sospende/riprende la pagina o la rete è instabile.
- Le foto aggiunte dall'iPhone vengono salvate in IndexedDB come byte (`ArrayBuffer`) e non come `Blob` persistenti. Al riavvio vengono ricostruite in modo affidabile.
- La copertina di ogni nuovo post viene salvata anche come Data URL indipendente: la griglia può quindi ricaricarla senza dipendere da un vecchio `blob:` URL.
- Quando Safari riapre una scheda sospesa o ripristina una pagina dalla cache, il planner rilegge l'archivio e ricrea gli URL temporanei.
- Eliminare un post ora resta davvero memorizzato. La v4 poteva reinserire automaticamente alcuni post iniziali eliminati al caricamento successivo.
- Il service worker non fallisce più completamente se un singolo asset non è raggiungibile; la cache v5 viene aggiornata file per file.
- I nuovi post vengono inseriti e rinumerati in un'unica transazione IndexedDB.
- Backup/importazione restano compatibili; i dati v4 presenti sullo stesso URL vengono migrati automaticamente alla v5 senza cancellare i post utente validi.

## File da pubblicare

Caricare nella root del repository GitHub Pages tutti questi file/cartelle:

- `index.html`
- `styles.css`
- `initial-posts.js`
- `app.js`
- `sw.js`
- `manifest.webmanifest`
- `assets/` completa

Non caricare lo ZIP come file singolo.

## Aggiornamento dalla v4

Sostituire i file del repository con quelli della v5 mantenendo lo stesso repository e lo stesso URL GitHub Pages. Non è necessario cancellare i dati del sito sull'iPhone: alla prima apertura la v5 aggiorna il database locale esistente.

Nel menu del planner compare `Versione 5 · iPhone/Safari`: serve per verificare che Safari abbia ricevuto davvero la nuova versione.

## Persistenza

Il planner salva sul browser/dispositivo tramite IndexedDB. Questa v5 rende il salvataggio locale più robusto, ma GitHub Pages resta un hosting statico: la cancellazione manuale dei dati di Safari, il ripristino dell'iPhone o la cancellazione dei dati del sito possono eliminare l'archivio locale. Per questo rimane disponibile `Esporta backup`.

Per sincronizzare automaticamente gli stessi post tra dispositivi diversi sarebbe necessario un backend/cloud esterno.


## Riordino v7
Su iPhone il trascinamento usa Touch Events seguiti a livello di documento: tieni premuto un post finché si solleva, trascinalo liberamente anche di più righe e rilascialo nella posizione desiderata. L’ordine viene salvato solo al rilascio.
