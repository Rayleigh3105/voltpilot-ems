-- =============================================================================
-- V20260814000000 - das PLATTFORM-GEDÄCHTNIS der Steuerungs-Freigabe.
-- ADDITIV: zwei neue Tabellen, keine bestehende wird angefasst.
-- -----------------------------------------------------------------------------
-- WOFÜR (Captain-Order 10.08.2026, wörtlich: „der Kunde hat auch einen Deye und
-- da muss ich die Steuerung freigeben, obwohl ich das schon mit einem anderen
-- Kunden gemacht hab - ich hätte gedacht das merken wir uns"):
--
-- Die Freigabe eines Wechselrichter-Modells für die Batterie-Steuerung landete
-- bis hier an genau ZWEI Orten, und keiner davon war die Plattform:
--
--   1. VP_CONTROL_CERTIFIED_FAMILIES - eine env-Datei auf dem Gerät bzw. in der
--      Compose, geschlüsselt auf die REGISTERFAMILIE. Übergriffig (eine Familie
--      deckt mehrere Baureihen ab) und nirgends nachlesbar.
--   2. calibration-certified.json - die First-Light-Freigabe, gültig auf GENAU
--      DER EINEN Box, auf der der Betreiber sie erteilt hat.
--
-- Also musste dasselbe Modell bei jedem neuen Kunden erneut freigegeben werden.
-- Diese Migration schafft den dritten, dauerhaften Ort.
--
--   inverter_control_certification  „Modell X ist steuerungs-zertifiziert."
--                                   Einmal eintragen, gilt flottenweit.
--   device_control_activation       „Anlage Y ist scharfgeschaltet."
--                                   Die ausdrückliche Entscheidung je Anlage.
--
-- ⚠ ES BRAUCHT BEIDE. Das Register allein steuert nie etwas: eine Freigabe
-- entsteht erst aus (Modell im Register) UND (Anlage scharfgeschaltet). Genau
-- deshalb sind es ZWEI Tabellen und kein Flag - die eine Frage ist eine Aussage
-- über ein PRODUKT, die andere eine Entscheidung über eine KUNDENANLAGE.
--
-- ⚠ DER SCHLÜSSEL IST brand+MODELL, NICHT DIE FAMILIE. Eine Registerfamilie
-- deckt mehrere Baureihen ab (hybrid_3p meint die LV-SG04LP3 UND die
-- HV-SG01HP3, mit verschiedener Leistungsskala), ein Pruefstandslauf deckt aber
-- genau EIN Modell. Ein Familien-Schlüssel würde von einem geprüften Gerät auf
-- ungeprüfte Geschwister schließen - genau die Überdehnung, die die
-- env-Allowlist hat und die dieses Register ablöst.
--
-- ⚠ FIRMWARE IST KLARTEXT, KEIN MASCHINEN-TOR (firmware_note). Die Box liest
-- heute keine Firmware-Version aus dem Wechselrichter, ein Firmware-Fenster wäre
-- also eine Zusage, die niemand prüfen kann - und das Haus behauptet nichts,
-- was es nicht prüft. Die zwei firmware-abhängigen Dinge sind anderweitig
-- abgesichert: das SCHREIB-VORZEICHEN über invert_control_sign (unten, und das
-- GERÄT prüft es gegen seine eigene Einstellung), die Verfügbarkeit des
-- Deye-Remote-Modus über die laufende Fähigkeitsprüfung von Layer 1 (erkannt,
-- nie angenommen).
--
-- ⚠ GLOBAL, ohne tenant_id und ohne RLS - wie edge_release, provisioned_device
-- und die Rollout-Tabellen, und aus demselben Grund: das sind
-- PLATTFORM-Betriebsdaten, keine Kundendaten. Eine tenant_id würde einen
-- Kunden-Schreibpfad suggerieren, den es hier nicht geben soll. Gefenced ist
-- stattdessen der Endpunkt: /api/v1/admin/** mit
-- @PreAuthorize("hasRole('platform-admin')") plus die dedizierte
-- BYPASSRLS-Rolle voltpilot_admin - dieselbe Disziplin wie /admin/fleet.
--
-- Datums-Version nach der AGENTS.md-Koordination.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Das Register: welche Modelle sind steuerungs-zertifiziert?
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inverter_control_certification (
    id                  UUID PRIMARY KEY,
    -- Katalog-Marke/-Modell/-Registerfamilie, klein geschrieben gespeichert.
    -- Die Box vergleicht ohnehin ohne Rücksicht auf Gross-/Kleinschreibung;
    -- normalisiert zu speichern macht den Unique-Index zur echten Aussage
    -- „dieses Modell steht genau einmal drin".
    brand               TEXT NOT NULL,
    model               TEXT NOT NULL,
    family              TEXT NOT NULL,
    -- Die Steuerflaeche, auf der der Pruefstandslauf lief ('remote'/'tou'), oder
    -- NULL = der Lauf sagt dazu nichts. Sie setzt den durablen Pfad-Entscheid
    -- von Layer 1 vor, sonst nichts.
    control_path        TEXT,
    -- Die am Pruefstand belegte SCHREIB-Vorzeichenkonvention, oder NULL.
    -- ⚠ NULL und FALSE sind VERSCHIEDENE Aussagen: NULL heisst „der Pruefstand
    -- hat die Frage nicht beantwortet" (das Geraet prueft dann nichts), FALSE
    -- heisst „er hat sie beantwortet, und die Antwort ist nicht-invertiert".
    invert_control_sign BOOLEAN,
    -- Wann der Pruefstandslauf stattfand (die fachliche Wahrheit), getrennt von
    -- created_at (wann es jemand eingetragen hat).
    certified_at        TIMESTAMPTZ NOT NULL,
    firmware_note       TEXT,
    note                TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          TEXT NOT NULL,
    CONSTRAINT inverter_control_cert_path_word
        CHECK (control_path IS NULL OR control_path IN ('remote', 'tou'))
);

-- Ein Modell steht genau EINMAL im Register. Ein zweiter Eintrag waere zwei
-- Wahrheiten ueber dasselbe Produkt - und die Box muesste raten, welche gilt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inverter_control_cert_model
    ON inverter_control_certification (brand, model);

-- -----------------------------------------------------------------------------
-- Die Scharfschaltung: welche Anlage darf die Freigabe des Registers nutzen?
-- -----------------------------------------------------------------------------
-- Eine Zeile JE GERÄT, und die Anwesenheit der Zeile IST die Scharfschaltung -
-- kein `activated BOOLEAN`, das auf false stehen und trotzdem eine Historie
-- vortaeuschen koennte. Zuruecknehmen heisst loeschen.
--
-- Geschluesselt auf das GERÄT (nicht auf die Anlage), weil das Geraet die
-- Adresse des retained Downlinks ist und weil genau es den Wechselrichter
-- schreibt. Das Portal zeigt es je Anlage; die Zuordnung ist der bestehende
-- Weg device -> site.
CREATE TABLE IF NOT EXISTS device_control_activation (
    device_id    UUID PRIMARY KEY REFERENCES device (id) ON DELETE CASCADE,
    activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_by TEXT        NOT NULL,
    note         TEXT
);

-- -----------------------------------------------------------------------------
-- Erstbestand: die Freigabe, die der Captain am Pruefstand schon erteilt HAT.
-- -----------------------------------------------------------------------------
-- Sie existiert bereits - als First-Light-Grant auf der Pilsting-Box (siehe
-- edge-app calibration-certified.json, Pfad 'remote'). Sie hier nachzutragen
-- ist genau das „merken", das die Order verlangt; ohne sie waere das Register
-- am Deploy-Tag leer und der naechste Kunde muesste wieder von vorn anfangen.
--
-- ⚠ Es aendert an KEINER laufenden Anlage etwas: ohne einen Eintrag in
-- device_control_activation steuert dieser Datensatz nichts. Die Pilsting-Box
-- behaelt ihren lokalen Grant unabhaengig davon (die drei Quellen sind
-- ODER-verknuepft), und Mienbach & Co. warten auf den ausdruecklichen Klick.
--
-- ON CONFLICT DO NOTHING: eine bereits von Hand eingetragene Zeile gewinnt.
INSERT INTO inverter_control_certification
    (id, brand, model, family, control_path, invert_control_sign, certified_at,
     firmware_note, note, created_by)
VALUES (
    '9f2c1d64-7d18-4d2b-9a2e-2f0b1c5a4e10',
    'deye',
    'sun-30k-sg01hp3',
    'hybrid_3p',
    'remote',
    NULL,  -- der Lauf hat die Vorzeichenfrage nicht als Register-Aussage
           -- festgehalten; NULL heisst genau das, und das Geraet prueft dann
           -- nichts, statt eine Konvention zu behaupten.
    TIMESTAMPTZ '2026-07-27 00:00:00+00',
    'Deye-Protokoll V105.1+ (Remote-Register 1100-1121 vorhanden); die '
        || 'Verfuegbarkeit wird von Layer 1 laufend geprueft, nie angenommen.',
    'Erstbestand: First-Light am Pruefstand Pilsting (SUN-30K-SG01HP3-EU), '
        || 'Vorzeichen und Skala bestaetigt, Remote-Pfad belegt.',
    'migration:V20260814000000'
)
ON CONFLICT (brand, model) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- Beide Tabellen deckt V4s ALTER DEFAULT PRIVILEGES ab (sie entstehen NACH V4
-- durch denselben Flyway-Superuser); Sequenzen gibt es hier keine (die
-- Register-Id kommt aus der Anwendung, die Aktivierung ist auf device_id
-- geschluesselt), also entfaellt die rollout_event_id_seq-Falle.
--
-- Die App-Rolle bekommt BEWUSST NICHTS - auch kein SELECT. Es gibt keinen
-- Kunden-Schreibpfad auf eine Steuerungs-Freigabe, und ein Recht ohne Aufrufer
-- ist eine offene Tuer, die irgendwann jemand benutzt. Der KUNDEN-Lesepfad
-- („Modell zertifiziert - Aktivierung ausstehend") laeuft ueber das, was das
-- GERÄT im Herzschlag berichtet (device_control_status), nicht ueber diese
-- Tabellen.

-- -----------------------------------------------------------------------------
-- Der RÜCKKANAL: was das Gerät über seine Freigabe berichtet.
-- -----------------------------------------------------------------------------
-- Additive Spalten auf device_control_status (RLS-Tabelle, Policies unberuehrt).
-- Sie beantworten die Frage, die „Steuerung: wird vorbereitet" bisher
-- verschluckt hat: liegt es am MODELL (Pruefstand noetig) oder an der
-- SCHARFSCHALTUNG (ein Klick)?
--
-- ⚠ Die Werte kommen aus dem KERN des Geraets, nie aus einem Layer-1-Stempel -
-- die Hausregel, an der schon zwei Live-Defekte hingen (certified und
-- control_enabled wurden vom Flow gestempelt und logen dauerhaft).
--
-- ⚠ NULL heisst „das Geraet sagt dazu nichts" (aelterer Stand, oder es hat nie
-- ein Cloud-Dokument gesehen) - NIEMALS „nicht zertifiziert". Deshalb sind es
-- nullable TEXT-Spalten ohne Default: eine Vorgabe waere eine Behauptung.
ALTER TABLE device_control_status
    ADD COLUMN IF NOT EXISTS cert_source            TEXT,
    ADD COLUMN IF NOT EXISTS platform_cert_verdict  TEXT,
    ADD COLUMN IF NOT EXISTS platform_cert_model    TEXT,
    ADD COLUMN IF NOT EXISTS platform_cert_reason   TEXT;
