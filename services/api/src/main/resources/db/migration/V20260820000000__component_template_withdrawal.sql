-- =============================================================================
-- V20260820000000 - Einheitsmodell Stufe 6: „Vorlagen-Verwaltung".
-- ADDITIV: zwei nullbare Spalten an einer GLOBALEN Tabelle. Kein bestehender
-- Pfad aendert sein Verhalten; eine Flotte, die nie eine Vorlage zurueckzieht,
-- verhaelt sich zeichengleich wie vorher.
-- -----------------------------------------------------------------------------
-- WOFUER (Scout data/vp-komponenten-einheit-h2, Stufenplan Stufe 6):
--
-- Eine geprueft eingetragene Vorlage ist ein DATENSATZ, keine Software-
-- Auslieferung (Stufe 0a hat dafuer den Speicher gebaut). Damit fehlte genau
-- eine Handlung: eine Fassung wieder AUS DER AUSWAHL nehmen, ohne die
-- Komponenten zu brechen, die sie schon benutzen.
--
-- ⚠ ZURUECKZIEHEN IST KEIN LOESCHEN. Die Fassung bleibt stehen, weil
-- `measurement_point.template_ref`/`template_version` ein SCHNAPPSCHUSS ist -
-- bewusst ohne Fremdschluessel (V20260815000000:203-207, das
-- `rollout_device.device_ref`-Muster). Eine laufende Komponente behaelt also
-- ihre Fassung samt Historie; die Vorlage verschwindet nur aus der AUSWAHL des
-- Assistenten. Ein DELETE waere die einzige Handlung, die eine Kundenanlage
-- unerklaerbar machen koennte, und wird deshalb gar nicht erst angeboten.
--
-- ⚠ ZURUECKZIEHEN WIRKT JE FASSUNG, nicht je Schluessel. Die Lese-Route liefert
-- je Schluessel die HOECHSTE Fassung; filtert sie die zurueckgezogenen VOR der
-- Auswahl heraus, faellt eine zurueckgezogene Fassung 2 auf Fassung 1 zurueck -
-- genau die Handlung, die man nach einem Fehler braucht. Sind ALLE Fassungen
-- zurueckgezogen, ist die Vorlage nicht mehr waehlbar.
--
-- ⚠ Nullbar und OHNE Default: NULL heisst „steht zur Auswahl". Ein
-- `NOT NULL DEFAULT false` haette dieselbe Aussage in eine zweite Spalte
-- gegossen, waehrend der ZEITPUNKT und der URHEBER das sind, was der Betrieb
-- spaeter wissen will.
--
-- Der Seeder fasst diese Spalten NICHT an: sie stehen nicht in
-- `ComponentTemplateRepository.CONTENT_COLUMNS`, also weder in der Wertliste
-- noch in der SET-Klausel noch im Aenderungsvergleich des Upserts. Ein
-- Neustart kann eine Ruecknahme damit nicht aufheben.
--
-- Datums-Version oberhalb des hoechsten ausgelieferten Standes
-- (V20260819000000) - eine kleinere Version waere fuer Flyway „out of order"
-- und wuerde auf einer langlebigen DB nie angewandt (AGENTS.md).
-- =============================================================================

ALTER TABLE component_template
    ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS withdrawn_by TEXT;

-- Ein Urheber ohne Zeitpunkt waere ein Name ohne Ereignis, ein Zeitpunkt ohne
-- Urheber eine Handlung ohne Handelnden - dieselbe Beides-oder-keines-Regel wie
-- bei `measurement_point.template_ref`/`template_version`.
ALTER TABLE component_template
    DROP CONSTRAINT IF EXISTS component_template_withdrawn_pair;
ALTER TABLE component_template
    ADD CONSTRAINT component_template_withdrawn_pair
    CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL));

-- Die Auswahl-Abfrage des Assistenten filtert jetzt zusaetzlich auf
-- `withdrawn_at IS NULL`, bevor sie je Schluessel die hoechste Fassung waehlt.
CREATE INDEX IF NOT EXISTS idx_component_template_selectable
    ON component_template (template_ref, version DESC)
    WHERE withdrawn_at IS NULL;

-- Rechte bleiben wie in V20260815000000: die App-Rolle liest, geschrieben wird
-- ausschliesslich ueber die BYPASSRLS-Rolle voltpilot_admin (der Start-Abgleich
-- der eingebauten Vorlagen UND die Admin-Verwaltung). Ein GRANT waere hier die
-- offene Tuer, gegen die V20260815000000 ausdruecklich REVOKE gesagt hat.
