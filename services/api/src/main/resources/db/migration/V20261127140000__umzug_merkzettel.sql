-- =============================================================================
-- V20261127140000 - Umzug (vp-standort-konzept §7, E1 = B, Bericht 6.6 Punkt 7): der
-- Merkzettel "Neues Haus? Bitte prüfen: Solaranlage, Stromtarif, Einspeisevergütung" bleibt
-- stehen, bis die drei geprüft oder geändert sind oder der Kunde ihn wegklickt - je Anlage
-- gespeichert und auf jedem Gerät sichtbar (nicht nur auf dem, das den Umzug gespeichert hat).
--
-- Genau EINE Zeile je Anlage (`site_id` ist Primärschlüssel): ein neuer Umzug ERSETZT eine noch
-- offene Erinnerung vollständig (UPSERT, alle drei Haken wieder auf), statt eine zweite anzulegen.
-- "Geprüft" und "weggeklickt" sind dieselbe Handlung (ein Tipp auf den jeweiligen Chip) - es gibt
-- im Produkt keinen eigenen Unterschied zwischen beidem. "Geändert" für Stromtarif und
-- Einspeisevergütung liest die api zur Anzeige aus `anlage_preisfassung` (PR "Preise ab einem
-- Tag", #2043): eine neue Fassung seit `seit` gilt als "geändert", ohne dass ein eigener Schreibweg
-- diese Spalten je anfasst. Solaranlage hat keine entsprechende Fassungs-Historie - ihr Haken wird
-- NUR durch einen Tipp gesetzt (dokumentierte, bewusste Vereinfachung).
-- =============================================================================

CREATE TABLE IF NOT EXISTS anlage_umzug_merkzettel (
    site_id    UUID        PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    tenant_id  UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    seit       TIMESTAMPTZ NOT NULL DEFAULT now(),
    solaranlage_erledigt         BOOLEAN NOT NULL DEFAULT FALSE,
    stromtarif_erledigt          BOOLEAN NOT NULL DEFAULT FALSE,
    einspeiseverguetung_erledigt BOOLEAN NOT NULL DEFAULT FALSE
);

-- Führender, voller Index für die Fremdschlüssel-RI-Prüfung (tenant_id); site_id trägt ihn
-- schon über den Primärschlüssel (LoeschzugIndexdeckungTest).
CREATE INDEX IF NOT EXISTS idx_anlage_umzug_merkzettel_tenant ON anlage_umzug_merkzettel (tenant_id);

ALTER TABLE anlage_umzug_merkzettel ENABLE ROW LEVEL SECURITY;
ALTER TABLE anlage_umzug_merkzettel FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anlage_umzug_merkzettel_tenant_isolation ON anlage_umzug_merkzettel;
CREATE POLICY anlage_umzug_merkzettel_tenant_isolation ON anlage_umzug_merkzettel
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Anders als `ort_wetter_nachholung` (Outbox, nur die api trägt ein) gehört diese Zeile ZUR api
-- selbst - sie legt an (Umzug), ersetzt (ein weiterer Umzug) und setzt Haken (Dismiss). Kein
-- eigener Löschweg nötig: eine beendete Anlage oder ein beendeter Kundenbereich räumt per Kaskade.
GRANT SELECT, INSERT, UPDATE ON anlage_umzug_merkzettel TO ${appDbUser};
