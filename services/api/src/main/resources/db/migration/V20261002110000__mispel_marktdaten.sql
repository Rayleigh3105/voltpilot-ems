-- =============================================================================
-- V20261002110000 - MiSpeL-Marktdaten: AW>0-Zeiten der
-- Uebertragungsnetzbetreiber und Jahresmarktwert. MiSpeL MP-7.
-- -----------------------------------------------------------------------------
-- Rechengrundlage der Festlegung MiSpeL (BNetzA, Beschluss 01.10.2026):
--
--   * Anlage 1 Abschn. 2.1.7 (S. 16-17) und Formel (24) (S. 38):
--       (24)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ]
--     Anlage 2 Abschn. 2.1.7 (S. 15) und Formel (P12) (S. 31): dieselbe Regel.
--     "In welchen Viertelstunden sich der anzulegende Wert ... auf null
--     verringert, veroeffentlichen die Uebertragungsnetzbetreiber auf ihrer
--     gemeinsamen Webseite zur Netztransparenz: Netztransparenz > Erneuerbare
--     Energien und Umlagen > EEG > Transparenzanforderungen > Marktpraemie >
--     Negativer Spotmarktpreis - Uebersichtstabellen." (A1 S. 17 Fn. 8,
--     A2 S. 15 Fn. 11)
--   * Anlage 1 S. 21 Vor. 5 / Anlage 2 S. 20: die Marktpraemie ist "anhand des
--     energietraegerspezifischen Jahresmarktwerts zu berechnen".
--
-- Der Spotmarktpreis SP¼ (§ 3 Nr. 42a EEG, A2 S. 27, Formel (P5)) braucht
-- KEINE neue Tabelle: er ist der DE-LU-Day-Ahead-Preis in day_ahead_prices.
--
-- Versionskoordination:
-- Kanonischer Eigentuemer ist die market-data-Migration V20261002110000;
-- diese DDL ist ihr idempotenter Zwilling (Muster V20260707020000), damit die
-- api auf frischer DB selbststaendig ist. Die App-Rolle liest (Rechenwerk
-- MP-8, Erloese MP-12); schreiben darf nur der vertrauenswuerdige Sammler.
--
-- Entwurf:
--   * Marktweite Daten wie day_ahead_prices: KEIN tenant_id, KEIN RLS.
--   * eeg_aw_zeit haelt jede veroeffentlichte (Viertel-)Stunde in ihrer
--     NATIVEN Aufloesung, "Ja" = Verguetungsanspruch (AW > 0), "Nein" = AW auf
--     null verringert. Stundentabellen werden NICHT vorab auf Viertelstunden
--     ausgerollt; das tut der Leser (eine Stunde gilt fuer ihre vier
--     Viertelstunden). Eine nicht veroeffentlichte (Viertel-)Stunde hat KEINE
--     Zeile - unbekannt ist keine Null und kein "Ja".
--   * regel = die Differenzierung der Uebersichtstabellen (Veroeffentlichung):
--       'viertelstunde'      "1 Viertelstunde" (§ 51 EEG ab 25.02.2025)
--       'viertelstunde_2ct'  "2ct Logik" (§ 51b EEG, Biogas; A1 S. 17 Fn. 7)
--       'stunden_1' .. 'stunden_6'  "1/2/3/4/6 Stunden" (§ 51 EEG fruehere
--                            Fassungen; ab 01.10.2025 gilt eine Stunde als
--                            negativ, wenn das Mittel ihrer Viertelstunden-
--                            Spotpreise negativ ist, § 100 Abs. 45 EEG)
--     Welche Regel fuer eine Anlage gilt, ist ein Stammdatum der Anlage
--     (Foerderweg, MP-5) - nicht dieser Tabelle.
--   * annual_market_value ist der Jahres-Zwilling von monthly_market_value:
--     PK (technology, year), dieselbe Regel "veroeffentlicht schlaegt
--     vorlaeufig" beim Upsert.
-- =============================================================================

CREATE TABLE IF NOT EXISTS eeg_aw_zeit (
    regel             TEXT         NOT NULL CHECK (regel IN (
                          'viertelstunde', 'viertelstunde_2ct',
                          'stunden_1', 'stunden_2', 'stunden_3', 'stunden_4', 'stunden_6')),
    ts                TIMESTAMPTZ  NOT NULL,  -- Beginn der (Viertel-)Stunde
    aufloesung        TEXT         NOT NULL CHECK (aufloesung IN ('PT15M', 'PT60M')),
    aw_groesser_null  BOOLEAN      NOT NULL,  -- "Ja" = TRUE, "Nein" = FALSE
    source            TEXT         NOT NULL DEFAULT 'netztransparenz',
    fetched_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (regel, ts)
);

CREATE TABLE IF NOT EXISTS annual_market_value (
    year          INTEGER        NOT NULL CHECK (year BETWEEN 2000 AND 2100),
    technology    TEXT           NOT NULL,  -- 'solar', 'wind_an_land', 'wind_auf_see', 'allgemein'
    value_ct_kwh  NUMERIC(8, 3)  NOT NULL,  -- the TSOs' native unit
    provisional   BOOLEAN        NOT NULL DEFAULT FALSE,
    source        TEXT           NOT NULL DEFAULT 'netztransparenz',
    fetched_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (technology, year)
);

GRANT SELECT ON eeg_aw_zeit TO voltpilot_app;
GRANT SELECT ON annual_market_value TO voltpilot_app;
