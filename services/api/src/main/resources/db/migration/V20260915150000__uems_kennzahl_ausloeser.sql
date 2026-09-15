-- =============================================================================
-- UEMS AP-11 IP-9 — die Auslöser aus Nenner und Definition (E8 = A, W1)
-- =============================================================================
--
-- Die Korrektur-Kaskade (AP-08 IP-17, V20260914120000) bekommt drei weitere
-- Anlässe. Sie berühren keine Messreihe und rufen darum NUR die Kennzahl- und die
-- Berichts-Naht — dieselbe Transaktion, derselbe Takt, dieselbe Wirkung:
--
--   1. `correction` mit Bezug `bezugsgroesse` (Erzeuger AP-09 IP-7, V20260915010000)
--      — Anlass die Berichtigung `BK-<Jahr>-<Nr.>`, Fassung = `fassung_neu` der Meldung;
--   2. eine rückwirkende Fassung der Berechnung einer Kennzahl (`kennzahl_fassung`,
--      `rueckwirkend`) — Anlass `kennzahl_fassung:<Kennzahl-ID>`, Fassung = ihre Nummer;
--   3. ein rückwirkend eingetragenes Stammdatum (`bezugsgroesse_aenderung`,
--      `stammdatum_eingetragen`, `rueckwirkend`) — Anlass
--      `bezugsgroesse_stammdatum:<Bezugsgrößen-ID>`, Fassung = der wievielte Eintrag.
--
-- Ihre Wirkung steht wie die von Korrektur und Ersatzwert in
-- `messreihe_kaskade_wirkung`. Diese Migration erweitert NUR den Kennungs-CHECK
-- dieser Tabelle — additiv, jede bisherige Zeile bleibt gültig, keine Zeile wird
-- geschrieben — und legt einen Teilindex für die Suche der Kaskade nach
-- Bezugsgrößen-Meldungen an. Die IDs stehen in der Kennung, nicht die Kennzeichen:
-- ein Kennzeichen kann wechseln (Kennzeichen-Verlauf) und hat die Form einer
-- Korrektur-Kennung.
-- =============================================================================

ALTER TABLE messreihe_kaskade_wirkung DROP CONSTRAINT IF EXISTS messreihe_kaskade_wirkung_kennung_chk;
ALTER TABLE messreihe_kaskade_wirkung ADD CONSTRAINT messreihe_kaskade_wirkung_kennung_chk CHECK (
    anlass_kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^K-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^BK-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^kennzahl_fassung:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR anlass_kennung ~ '^bezugsgroesse_stammdatum:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

-- Die Suche nach Arbeit läuft alle fünf Minuten über alle Kundenbereiche; eine
-- Bezugsgrößen-Meldung ist selten, die Ereignis-Tabelle groß.
CREATE INDEX IF NOT EXISTS idx_messreihe_ereignis_correction_bezugsgroesse
    ON messreihe_ereignis (tenant_id, eingang)
    WHERE art = 'correction' AND (kennungen ->> 'bezugsgroesse') IS NOT NULL;
