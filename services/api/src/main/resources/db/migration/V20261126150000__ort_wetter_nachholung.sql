-- =============================================================================
-- V20261126150000 - Wetter-Nachholung nach einer Ort-Berichtigung (vp-standort-konzept §6.6,
-- B3): weicht die Adresse > 2 km vom alten Punkt ab, ist das gespeicherte Wetter der Anlage
-- am ALTEN Ort gelernt - die Prognose soll nicht damit weiterlernen. Der Schreibweg "Ort
-- berichtigen" (AnlageOrtService) trägt hier EINE Zeile je betroffener Anlage ein; der
-- Wetter-Collector (services/forecast, voltpilot_forecast.weather_collect) liest offene
-- Zeilen als Mandanten-Backend (bypasst RLS wie beim Schreiben von weather_forecast), holt das
-- Wetter der letzten 28 Tage am NEUEN Punkt nach (Open-Meteo `past_days`) und markiert die
-- Zeile erledigt. Reines Handover: die api liest `erledigt_am` nie zurück (keine Anzeige im
-- Portal), ein schlichter Transaktions-Outbox-Eintrag.
--
-- Anders als `weather_forecast` (Hypertable, ohne Fremdschlüssel, eigene Zeilen in
-- TenantRepository.offboard und SeriesRepository.deleteForSite) ist dies eine gewöhnliche kleine
-- Tabelle: echte Fremdschlüssel auf tenant und site mit ON DELETE CASCADE (Loeschzug-Wächter
-- LoeschzugIndexdeckungTest) räumen beim Löschen einer Anlage oder eines Kundenbereichs ohne
-- eigenen Code auf; der generische Katalog-Löschzug (TenantRepository.katalogRestLoeschen)
-- griffe sonst ohnehin, aber die Fremdschlüssel machen die Aufräumung sofort und unabhängig
-- vom Löschzug. Jeder Fremdschlüssel braucht einen EIGENEN, nicht-partiellen Index, der mit
-- seiner Spalte beginnt (derselbe Wächter: die RI-Prüfung scannt sonst vollständig).
-- =============================================================================

CREATE TABLE IF NOT EXISTS ort_wetter_nachholung (
    id             BIGSERIAL   PRIMARY KEY,
    tenant_id      UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id        UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    angefordert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    erledigt_am    TIMESTAMPTZ
);

-- Je ein führender, voller Index für den Löschzug (tenant_id) und die Fremdschlüssel-RI-Prüfung
-- beim Löschen einer Anlage (site_id) - keiner davon partiell (LoeschzugIndexdeckungTest).
CREATE INDEX IF NOT EXISTS idx_ort_wetter_nachholung_tenant ON ort_wetter_nachholung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ort_wetter_nachholung_site ON ort_wetter_nachholung (site_id);

ALTER TABLE ort_wetter_nachholung ENABLE ROW LEVEL SECURITY;
ALTER TABLE ort_wetter_nachholung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ort_wetter_nachholung_tenant_isolation ON ort_wetter_nachholung;
CREATE POLICY ort_wetter_nachholung_tenant_isolation ON ort_wetter_nachholung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Die api trägt nur ein - der Collector (Mandanten-Backend-Rolle, bypasst RLS wie bei
-- weather_forecast) liest, markiert erledigt und löscht nie. Kein Zweck für ein UPDATE/DELETE
-- der App-Rolle; ein CASCADE-Löschen über site/tenant braucht diese Rechte ohnehin nicht (die
-- Fremdschlüssel-Kaskade läuft unabhängig von den Rechten der löschenden Rolle auf dem Kind).
GRANT SELECT, INSERT ON ort_wetter_nachholung TO ${appDbUser};
REVOKE UPDATE, DELETE ON ort_wetter_nachholung FROM ${appDbUser};
-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Grant (die rollout_event-Falle):
-- ALTER DEFAULT PRIVILEGES deckt Tabellen ab, Sequenzen nicht.
GRANT USAGE, SELECT ON SEQUENCE ort_wetter_nachholung_id_seq TO ${appDbUser};
