-- =============================================================================
-- AP-18 IP-15: die Auffälligkeits-Naht (A1, E4 = A) schreibt ihren Vermerk in
-- der Transaktion des endgültigen Monatswerts — im Endgültigkeits-Takt
-- (KennzahlLauf) und in der Korrekturkaskade (KennzahlKaskade). Beide Wege
-- laufen mit der Verwaltungsrolle (adminJdbcTemplate, ohne RLS, jede Abfrage
-- nennt den Mandanten); sie darf den Vermerk darum ANHÄNGEN — nie ändern. Die
-- App-Rolle bekommt nichts dazu (V20260924235130 bleibt unberührt).
-- =============================================================================

-- Späte Ankunft (out-of-order): läuft diese Migration vor V20260924235130, gibt es die
-- Tabelle noch nicht — dann ohne GRANT. Auf `uems` ist IP-14 vor diesem Paket gemergt.
DO $$
BEGIN
    IF to_regclass('auffaelligkeit') IS NOT NULL THEN
        EXECUTE 'GRANT INSERT ON auffaelligkeit TO ${adminDbUser}';
    END IF;
END $$;
