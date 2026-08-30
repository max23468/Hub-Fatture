# Chiusura della transizione API Aruba

## Esito

Le API Aruba sono l’unica autorità automatica del ciclo attivo. Il percorso browser è ritirato sia
in entrata sia in uscita; il fallback manuale resta disponibile, presidiato e fail-closed. Questa
chiusura non autorizza `dryRun=false`, invii SdI, modifiche del pannello, deploy o release.

## Matrice delle prove

| Requisito                                  | Prova collegata                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parità inbound senza divergenze inspiegate | Il [dossier inbound](aruba-api-inbound.md) registra la popolazione comune, gli hash dei file, gli stati e zero divergenze residue sul cutover.                                                         |
| Outbound qualificato senza invio           | Il [dossier outbound](aruba-api-outbound.md) copre modalità, manifest, dry-run sullo stesso hash, arresti, stato incerto e risultati per documento.                                                    |
| Nessuna doppia autorità                    | `connections.automatic_authority` ammette soltanto `API`; la migrazione di ritiro revoca le sessioni e i token browser ancora attivi.                                                                  |
| Fallback manuale end-to-end                | La [procedura manuale](../runbooks/aruba-manual.md) copre export, operazione presidiata, readback e import dei file ufficiali senza diventare una seconda automazione.                                 |
| Ritiro fisico del runtime browser          | Il commit `43a2c0f66d4bf3f9910d1f5f4928c45302068a99` rimuove rotte, script, workflow, UI, dipendenze e test sintetici specifici; il treno applicativo corrente formalizza la transizione come `0.5.x`. |
| Audit e provenienza preservati             | File canonici, audit storici, stati e trasporti `HELPER` già registrati restano leggibili; i nuovi readback manuali usano origine `MANUAL` e non creano identità dispositivo o token fittizi.          |
| Ratchet contro la reintroduzione           | `scripts/architecture-ratchet.node-test.mjs` controlla nomi e simboli runtime, script del manifest, documentazione operativa corrente, origine dei readback e treno di versione.                       |

## Limiti intenzionali

Il codice continua a interpretare valori storici `HELPER`, stati già registrati e azioni di audit:
sono dati di provenienza, non capacità eseguibili. L’evidenza storica del percorso browser resta in
`docs/evidence/aruba-helper.md` e nella cronologia Git; non è un contratto o un runbook operativo.

La ricertificazione del candidato esatto, il canary TD01 e l’abilitazione dell’uso ordinario sono
gate successivi e separati.
