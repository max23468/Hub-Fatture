-- Gli hash ora dichiarano i parametri di costo. Invece di conservare un percorso di verifica
-- per il formato precedente, gli account vengono rimossi: `/setup` torna disponibile e li
-- ricrea nel formato corrente. Senza questo passaggio un'installazione già configurata
-- resterebbe esclusa, perché il bootstrap si rifiuta di ripetersi finché esistono utenti.
DELETE FROM users;
