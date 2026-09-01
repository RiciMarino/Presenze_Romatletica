# Romatletica · QR e presenze

Sistema per registrare due prove gratuite e le successive presenze agli allenamenti usando un QR personale.

## Sicurezza dei dati

- GitHub Pages contiene solo l’interfaccia e nessun elenco nominativo.
- Il QR espone soltanto un ID Romatletica casuale.
- Il codice fiscale rimane nell’archivio Google riservato e serve esclusivamente per riconciliare i report Golee.
- Lo stato `ISCRITTO` deriva dal secondo report Golee, non dalla semplice registrazione di due prove.

## Collegamento backend

Il file `config.js` contiene l’URL della web app Apps Script. Finché `demoMode` è `true`, il sito usa soltanto tre record dimostrativi e salva le prove nel browser locale.

Il codice Apps Script e la finestra di importazione sono conservati nella cartella `apps-script`.
