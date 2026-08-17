-- =============================================================================
-- V20260823000000 - der KOMMANDO-VERLAUF (Kommando-Transparenz V1, Konzept
-- `vp-kommando-transparenz-k3` §4.2/§6.2, Captain-Entscheide F1-F5 vom
-- 17.08.2026). ADDITIV (zwei neue Tabellen, kein bestehender Pfad berührt).
-- -----------------------------------------------------------------------------
-- Der Anlass, wörtlich: ein Kunde fragte „drosselt IHR meine Anlage?" - und die
-- belastbare Antwort war NUR über den Wartungstunnel und rohes Register-Lesen
-- zu gewinnen. Was die Box an ein Gerät schickt, war nirgends kundensichtbar.
-- Die Kette Executor -> Snapshot -> Herzschlag existiert seit dem Bau; es fehlt
-- ausschliesslich der SPEICHER - exakt der `rule_event`-Befund eine Stufe
-- höher, weshalb diese Tabelle dessen Muster wörtlich übernimmt.
--
-- V1 (hier) schreibt AUSSCHLIESSLICH aus den BESTEHENDEN Herzschlag-Strömen:
-- die drei Momentaufnahmen-Zuhörer (control/curtailment/consumers) vergleichen
-- ALT gegen NEU und schreiben HALTEPERIODEN fort. KEINE Edge-Änderung, kein
-- neues Flag - der Schreiber reitet auf den Flags der Zuhörer, die in beiden
-- Composes gesetzt sind (die dokumentierte OTA-Listener-Falle wird so
-- vermieden). Der Präzisions-Uplink (Stufe 2, `source = 'geraet'`) verfeinert
-- diese Tabelle später, ohne sie umzubauen.
--
-- WARUM PERIODEN UND NICHT EIN ROHES EREIGNIS-LOG (§4.1, gerechnet):
-- der Deye-Fernsteuerpfad re-assertiert im 10-s-Takt = ~26.500 Schreibbefehle
-- und ~52.000 Rücklese-Register pro Tag und Gerät (~2,35 Mio Zeilen/Monat).
-- Darin wäre die EINE interessante Zeile („Register hielt, Leistung folgte
-- nicht") unauffindbar. Verdichtet auf Halteperioden + Punkt-Ereignisse sind es
-- ~100-200 Zeilen/Tag - und die Fläche SAGT die Verdichtung, statt sie zu
-- verstecken.
--
--   kind          'periode' = eine Zeitspanne, in der der SCHLÜSSEL konstant
--                 war; 'ereignis' = ein Punkt-Ereignis, das keine Periode ist.
--   stream        WELCHER Schreibpfad: 'batterie' (Wechselrichter-Sollwert),
--                 'abregelung' (Einspeise-Begrenzung), 'verbraucher'
--                 (Wallbox/Heizstab/Schalter). 'waechter' ist für den
--                 Einspeisewächter RESERVIERT - V1 schreibt ihn nicht (seine
--                 Wahrheit ist eine STEHENDE Aussage und lebt live in
--                 `device_curtailment_status`).
--   entity_id     die KOMPONENTE, wo zuordenbar. NULL heisst „diesem Gerät
--                 zugeordnet, aber keiner einzelnen Komponente" - die Seite
--                 zeigt solche Zeilen an JEDER Komponente dieses Geräts.
--   started_at /  die Spanne. ended_at NULL = OFFENE Periode (sie läuft noch).
--   ended_at
--   last_seen_at  der letzte Herzschlag, der diese Periode getragen hat. Er ist
--                 der MECHANISMUS hinter zwei Ehrlichkeiten: eine offene
--                 Periode altert sichtbar, und eine LÜCKE (kein Herzschlag über
--                 längere Zeit) wird an genau dieser Stelle geschlossen statt
--                 bis „jetzt" behauptet.
--   mode/path/    das WARUM als SCHNAPPSCHUSS (das `rollout_device.device_ref`-
--   why_kind/ref  Muster, NIE ein Fremdschlüssel): wer den Fahrplan morgen neu
--                 rechnet, schreibt die Vergangenheit nicht um.
--   verdict       das RÜCKLESE-Urteil in der `readback-verify`-Semantik.
--                 ⚠ `keine_antwort` ist NICHT `abweichend` - Schweigen ist eine
--                 Lücke, kein bewiesener Defekt (die PR-280-Lehre). V1 kann aus
--                 dem 15-s-Herzschlag nur 'bestaetigt' | 'abweichend' |
--                 'unbestaetigt' ableiten; 'keine_antwort'/'prueft' sind für
--                 den Präzisions-Uplink reserviert und werden in V1 NIE
--                 geschrieben. NULL = nicht bewertbar.
--   cycles*       die Schreibzyklen der Periode. ⚠ In V1 IMMER NULL, und das
--                 ist die Ehrlichkeit: aus einem 15-s-Herzschlag lässt sich die
--                 Zahl der 10-s-Schreibvorgänge nicht ableiten. Die Fläche sagt
--                 „—" und nennt den Grund; sie erfindet nie eine Zahl.
--   detail        der Roh-Blick (§2.4). V1: Rollen + kW + Pfad. `jsonb` ist
--                 hier ERLAUBT (eigene Betriebsdaten, keine Signatur - die
--                 `edge_release.manifest`-text-Regel gilt hier nicht).
--   source        WOHER die Zeile stammt: 'cloud_abgeleitet' (V1, aus dem
--                 Herzschlag-Diffing) oder 'geraet' (Stufe 2). Die Herkunft
--                 steht AN der Zeile, damit die Fläche nie mehr behauptet, als
--                 ihre Quelle hergibt.
--
-- ⚠ ASCII-VOKABULAR: die Zustandswörter tragen keine Umlaute
-- ('bestaetigt', nicht 'bestätigt') - dieselbe Haus-Konvention wie
-- `guard_state` ('ueberwacht'/'haelt') und `rule_event.kind`.
--
-- ⚠ ZWEI SPALTEN ÜBER DIE KONZEPT-LISTE HINAUS: `control_enabled` und
-- `released` sind SCHLÜSSEL-Mitglieder (§4.2 „Gates [Not-Aus, Freigabe]") und
-- gehören deshalb in die Zeile, nicht ins `detail` - der Vergleich ALT/NEU
-- läuft über sie, und die Fläche liest sie direkt.
--
-- AUFBEWAHRUNG: 90 Tage (Captain-Entscheid F3), wörtlich die
-- `rule_event`-Retention. Gelöscht wird opportunistisch im Schreibpfad
-- (höchstens einmal je Stunde je api-Instanz, gedeckelte DELETE) - kein neuer
-- `@Scheduled`-Job (die dokumentierte Testcontainers-Falle) und kein neues Flag
-- im gitops-Repo. Der 24-h-ROH-Ring auf der Box (Stufe 3) ist davon unberührt.
--
-- Mandantengebunden + RLS/FORCE wie `rule_event` - das sind KUNDENDATEN,
-- ausdrücklich NICHT global wie `rollout_event`; deshalb wohnt die Leseroute
-- unter `/sites/**` und nicht unter `/admin/**`.
--
-- Datums-Version ÜBER dem höchsten ausgelieferten Stand (V20260822000000) per
-- der AGENTS.md-Regel „out of order wird nie angewandt".
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_command_log (
    id                 BIGSERIAL     PRIMARY KEY,
    tenant_id          UUID          NOT NULL,
    site_id            UUID          NOT NULL,
    device_id          UUID          NOT NULL,
    entity_id          UUID,
    stream             TEXT          NOT NULL,
    kind               TEXT          NOT NULL,
    event_kind         TEXT,
    started_at         TIMESTAMPTZ   NOT NULL,
    ended_at           TIMESTAMPTZ,
    last_seen_at       TIMESTAMPTZ   NOT NULL,
    mode               TEXT,
    path               TEXT,
    why_kind           TEXT,
    why_ref            TEXT,
    commanded_kw_first DOUBLE PRECISION,
    commanded_kw_last  DOUBLE PRECISION,
    commanded_kw_min   DOUBLE PRECISION,
    commanded_kw_max   DOUBLE PRECISION,
    verdict            TEXT,
    cycles             INT,
    cycles_confirmed   INT,
    cycles_no_answer   INT,
    cycles_mismatch    INT,
    control_enabled    BOOLEAN,
    released           BOOLEAN,
    foreign_influence  BOOLEAN,
    detail             JSONB,
    source             TEXT          NOT NULL,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT device_command_log_kind_chk
        CHECK (kind IN ('periode', 'ereignis')),
    CONSTRAINT device_command_log_stream_chk
        CHECK (stream IN ('batterie', 'abregelung', 'verbraucher', 'waechter')),
    CONSTRAINT device_command_log_source_chk
        CHECK (source IN ('cloud_abgeleitet', 'geraet')),
    -- Ein Ereignis trägt seine Art, eine Periode nie: sonst könnte eine Zeile
    -- gleichzeitig eine Spanne und ein Punkt sein.
    CONSTRAINT device_command_log_event_kind_chk
        CHECK ((kind = 'ereignis') = (event_kind IS NOT NULL))
);

-- Der Verlauf einer Anlage (neueste zuerst) und das Aufräumen.
CREATE INDEX IF NOT EXISTS idx_device_command_log_site
    ON device_command_log (site_id, started_at DESC);
-- Der Ausschnitt EINER Komponente - der Normalfall der Seite.
CREATE INDEX IF NOT EXISTS idx_device_command_log_entity
    ON device_command_log (entity_id, started_at DESC)
    WHERE entity_id IS NOT NULL;
-- Der heisse Pfad des Schreibers: „gibt es zu (Gerät, Strom, Komponente) eine
-- offene Periode?". Er ist zugleich der STRUKTURELLE Schutz davor, dass ein
-- Fehler zwei offene Perioden derselben Sache erzeugt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_command_log_open
    ON device_command_log (device_id, stream,
        coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE kind = 'periode' AND ended_at IS NULL;

-- Ab wann für diese Anlage überhaupt aufgezeichnet wird. OHNE diese Zeile wäre
-- ein leerer Verlauf die Behauptung „es wurde nie etwas geschickt" über eine
-- Zeit, in der niemand hingesehen hat; mit ihr sagt die Fläche „Aufzeichnung
-- seit <Datum>" (§4.3, das `rule_event_recording`-Muster). Genau EINE Zeile je
-- Anlage, der erste Eintrag gewinnt.
CREATE TABLE IF NOT EXISTS device_command_recording (
    site_id    UUID        PRIMARY KEY,
    tenant_id  UUID        NOT NULL,
    started_at TIMESTAMPTZ NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_command_log TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON device_command_recording TO ${appDbUser};

-- ⚠ Ein BIGSERIAL braucht sein EIGENES Sequenz-Recht: V4s
-- `ALTER DEFAULT PRIVILEGES` deckt TABELLEN ab, Sequenzen sind eine andere
-- Objektklasse (sonst „permission denied for sequence" auf genau dem
-- Schreibpfad, der die Papier-Spur trägt - die dokumentierte
-- rollout_event/rule_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE device_command_log_id_seq TO ${appDbUser};

ALTER TABLE device_command_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_command_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_command_log_isolation ON device_command_log;
CREATE POLICY device_command_log_isolation ON device_command_log
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device_command_recording ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_command_recording FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_command_recording_isolation ON device_command_recording;
CREATE POLICY device_command_recording_isolation ON device_command_recording
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
