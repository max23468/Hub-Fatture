-- La soglia per solo username non può distinguere il titolare dall'attaccante: o esclude
-- entrambi, o non limita nessuno dei due. La dimensione per origine è la misura antiabuso
-- osservata che 17.4 richiede prima di raccogliere un `ip_hash`.
ALTER TABLE login_attempts ADD COLUMN ip_hash text NOT NULL DEFAULT '';

CREATE INDEX login_attempts_origin_idx ON login_attempts (ip_hash, attempted_at DESC);
