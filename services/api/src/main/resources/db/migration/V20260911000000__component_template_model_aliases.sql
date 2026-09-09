-- =============================================================================
-- V20260911000000 - die TYPENSCHILD-VARIANTEN einer eingebauten Vorlage.
-- ADDITIV: EINE nullbare Spalte, keine bestehende Zeile wird angefasst.
-- -----------------------------------------------------------------------------
-- WOFÜR (Bauplan P8 „Stammdaten-Kosmetik", Diagnose data/vp-deye-diybms-luecke-l5
-- §2.6/§3.1): Deye liefert dieselbe HV-Hybrid-Reihe unter mehreren
-- Typenschild-Namen aus - „SUN-30K-SG01HP3-EU" im Katalog, „…-EU-BM3" bzw.
-- „…-EU-BM4" auf dem Gerät. Ein Kunde, der abtippt was er sieht, fand bisher
-- NICHTS und griff daneben (die Anlage aus der Diagnose steht seit dem
-- 21.08.2026 als „SUN-30K-SG02HP3-EU-AM3" im Portal, obwohl ihr Typenschild
-- SG01HP3-EU-BM3 sagt).
--
-- ⚠ EIN ALIAS IST NUR EIN NAME, NIE EINE ZWEITE KENNUNG. Die Varianten sind
-- KEINE eigenen Vorlagen und bekommen KEINEN eigenen `template_ref`:
--
--   1. Die Steuerungs-Freigabe ist auf brand+MODELL geschlüsselt
--      (`inverter_control_certification`, V20260814000000). Ein zweiter
--      Eintrag „…-BM3" wäre ein UNZERTIFIZIERTES Modell - wer sein Typenschild
--      wählt, verlöre die Freigabe, die sein Gerät längst hat.
--   2. Eine Bestandsanlage hält ihre gespeicherte Modell-Kennung. Ein Alias
--      dazuzuschreiben entwertet sie nicht (Alias-Kontinuität); ein zweiter
--      Eintrag daneben lüde dazu ein, sie „richtigzustellen".
--
-- Die Registerkarte bleibt unberührt `hybrid_3p` (ha-solarman deye_p3.yaml deckt
-- SG04LP3 LV und SG01HP3/SG02HP3 HV; der einzige Modell-Unterschied ist die
-- MPPT-Zahl, und die summiert der Decoder ohnehin). Es ist reine KOSMETIK am
-- Namen - kein Decoder-, Familien- oder Anbindungs-Wechsel.
--
-- ⚠ NULL heisst „dieses Modell hat nur seinen einen Namen", nicht „es hat keine
-- Varianten" - die Ehrlichkeitsregel der Nachbarspalten `channels`/`writes`.
-- Ein `[]` wäre die Behauptung „nachgesehen, es gibt keine"; der Katalog sagt
-- dazu aber gar nichts, also bleibt die Spalte leer. Der Export schreibt das
-- Feld deshalb `omitempty` (edge-app/core/internal/inverter/templates.go).
--
-- Die Spalte gehört dem Seeder wie jede andere Inhalts-Spalte: sie wandert in
-- ComponentTemplateRepository.CONTENT_COLUMNS und wird damit vom
-- Inhaltsvergleich des Upserts mitgetragen (ein Katalog-Edit frischt sie auf,
-- ein unveränderter Start schreibt nichts).
--
-- Datums-Version nach der AGENTS.md-Koordination (nach V20260910000000).
-- =============================================================================

ALTER TABLE component_template
    ADD COLUMN IF NOT EXISTS model_aliases JSONB;

COMMENT ON COLUMN component_template.model_aliases IS
    'Weitere Typenschild-Namen DESSELBEN Modells (JSON-Array aus Zeichenketten). '
    'Nur Anzeige + Suche - keine eigene Kennung, keine eigene Vorlage, kein '
    'Verhalten. NULL = dieses Modell hat nur seinen einen Namen.';

-- Rechte: keine. Die Spalte hängt an einer bestehenden Tabelle, deren Grants
-- (V20260815000000) tabellenweit gelten - ein ALTER TABLE ... ADD COLUMN ändert
-- daran nichts. Es entsteht auch keine Sequenz, also keine BIGSERIAL-Falle.
