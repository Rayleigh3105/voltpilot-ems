-- =============================================================================
-- V20260805000000 - der SOLL-Zustand der Edge-Flotte und seine Orchestrierung
-- (OTA Stufe 2 „Verteilen", Scout vp-ota-rollout-h4 §5/§7/§9, Captain-Entscheid
-- D4). ADDITIV: vier neue Tabellen, keine bestehende wird angefasst.
-- -----------------------------------------------------------------------------
-- WOFÜR: Stufe 0 hat das IST sichtbar gemacht (device_update_status), Stufe 1
-- den Maßstab signierbar (edge_release.manifest/signature). Was fehlte, war das
-- SOLL - und damit jede Antwort auf „welches Gerät soll welchen Stand fahren,
-- wer hat das wann entschieden, und was ist daraus geworden".
--
--   device_update_target  je Gerät genau EINE Zuweisung (der Soll-Stand).
--   rollout               eine Verteilung in Wellen: Zustand + Wellen-Zeiger.
--   rollout_device        je Rollout und Gerät: Welle, Zustand, seit, Grund.
--   rollout_event         das append-only Audit-Journal (wer/wann/was).
--
-- ⚠ GLOBAL, ohne tenant_id und ohne RLS - wie edge_release und
-- provisioned_device, und aus demselben Grund: das sind PLATTFORM-Betriebsdaten,
-- keine Kundendaten. Der Scout ist an dieser Stelle eindeutig („Kunden-Flächen:
-- bewusst NICHTS in V1"), es gibt also keinen Kunden-Lesepfad, den eine Policy
-- fencen müsste. Eine tenant_id hier würde einen Kunden-Pfad SUGGERIEREN, den
-- es nie geben darf. Der Zugriff ist stattdessen an der EINEN Stelle gefenced,
-- an der er entsteht: die Endpunkte liegen unter /api/v1/admin/** mit
-- @PreAuthorize("hasRole('platform-admin')"), und die Repositories hängen an der
-- dedizierten BYPASSRLS-Rolle voltpilot_admin - dieselbe Disziplin wie
-- /admin/fleet. Die App-Rolle bekommt hier NICHTS, auch kein SELECT.
--
-- Der Mandant eines Geräts bleibt jederzeit über device -> site -> tenant
-- ermittelbar; er wird für die Anzeige gejoint, nie hier dupliziert.
--
-- Datums-Version nach der AGENTS.md-Koordination.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- device_update_status.target_verdict - das URTEIL des Geräts über sein Ziel.
-- -----------------------------------------------------------------------------
-- Der `update`-Block trägt seit Stufe 2 ein zusätzliches Feld: ok | deferred |
-- rejected, das Ergebnis der GERÄTE-EIGENEN Signaturprüfung.
--
-- Es steht NEBEN `state`, weil beide verschiedene Fragen beantworten: `state`
-- ist der Zustand der ANWENDUNG, `target_verdict` der der PRÜFUNG. In dieser
-- Stufe ist „verifiziert, wartet auf den Menschen" und „gültig signiert, gilt
-- hier aber nicht" BEIDES state=deferred - nur dieses Feld trennt sie
-- maschinenlesbar. Ohne es müsste die Oberfläche den deutschen Grund nach
-- Stichworten durchsuchen, und genau daraus entstehen falsche Behauptungen.
--
-- NULL = ein Gerät ohne Zuweisung (oder ein älterer Stand) - die Oberfläche
-- sagt dann „unbekannt", nie „veraltet".
ALTER TABLE device_update_status ADD COLUMN IF NOT EXISTS target_verdict TEXT;

-- -----------------------------------------------------------------------------
-- device_update_target - der Soll-Stand EINES Geräts.
-- -----------------------------------------------------------------------------
-- Genau eine Zeile je Gerät (Upsert): ein Gerät hat immer höchstens EIN Ziel.
-- Zwei gleichzeitige Ziele wären die Mehrdeutigkeit, gegen die die ganze
-- Ordnung gebaut ist.
--
--   release_seq   die Ordnung (FK auf edge_release) - nie ein SHA-Vergleich.
--   channel       canary | stable: aus welchem Ring die Zuweisung stammt.
--   pinned        TRUE = von Hand festgenagelt; ein Rollout überschreibt eine
--                 gepinnte Zuweisung NICHT (das ist der ganze Zweck eines Pins).
--   rollout_id    NULL bei einer Einzelgerät-Zuweisung.
--   published_at  wann die retained Nachricht zuletzt hinausging. NULL = noch
--                 nie veröffentlicht (der Drift-Wächter holt das nach). Es ist
--                 bewusst KEIN „zugestellt": MQTT-retained sagt nichts darüber,
--                 ob das Gerät je verbunden war - das beantwortet allein der
--                 gemeldete Ist in device_update_status.
CREATE TABLE IF NOT EXISTS device_update_target (
    device_id       UUID        PRIMARY KEY,
    release_seq     BIGINT      NOT NULL REFERENCES edge_release (release_seq),
    release_version TEXT        NOT NULL,
    channel         TEXT        NOT NULL DEFAULT 'stable'
                                CHECK (channel IN ('canary', 'stable')),
    pinned          BOOLEAN     NOT NULL DEFAULT FALSE,
    rollout_id      UUID,
    assigned_by     TEXT,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ
);

-- -----------------------------------------------------------------------------
-- rollout - EINE Verteilung eines Releases in Wellen.
-- -----------------------------------------------------------------------------
--   state         active | paused | halted | done.
--                 halted ist der Not-Aus (und das Ziel des Auto-Halts): er ist
--                 bewusst ENDGÜLTIG - ein „weiter" nach einem Fehlschlag ist
--                 ein neuer, bewusst gestarteter Rollout, keine Fortsetzung.
--                 paused ist die reversible Denkpause.
--   waves         die Wellen-Definition als JSON-Feld: [{"name": "...",
--                 "devices": ["uuid", ...]}]. Bewusst jsonb (anders als
--                 edge_release.manifest, das text SEIN MUSS): hier geht keine
--                 Signatur über die Bytes, und die Normalisierung ist erwünscht.
--   current_wave  0 = noch keine Welle freigegeben; N = Wellen 1..N sind
--                 zugewiesen. Wellen sind hand-advanced (D4).
CREATE TABLE IF NOT EXISTS rollout (
    id              UUID        PRIMARY KEY,
    release_seq     BIGINT      NOT NULL REFERENCES edge_release (release_seq),
    release_version TEXT        NOT NULL,
    channel         TEXT        NOT NULL DEFAULT 'stable'
                                CHECK (channel IN ('canary', 'stable')),
    state           TEXT        NOT NULL DEFAULT 'active'
                                CHECK (state IN ('active', 'paused', 'halted', 'done')),
    waves           JSONB       NOT NULL,
    current_wave    INT         NOT NULL DEFAULT 0,
    halted_reason   TEXT,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Höchstens EIN Rollout, der die Flotte gerade bewegt. Zwei gleichzeitig
-- laufende Verteilungen könnten demselben Gerät verschiedene Ziele zuweisen -
-- und das Auto-Halt-Signal wäre nicht mehr zuzuordnen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rollout_one_live
    ON rollout ((state IN ('active', 'paused')))
    WHERE state IN ('active', 'paused');

-- -----------------------------------------------------------------------------
-- rollout_device - je Rollout und Gerät: wo steht es?
-- -----------------------------------------------------------------------------
-- state ist das PORTAL-Vokabular (§7.2), NICHT das Vertrags-Vokabular des
-- Geräts: es ist die abgeleitete Sicht (Ist gegen Soll gegen Frische), und es
-- wird vom Wächter fortgeschrieben. „unbekannt" ist ein vollwertiger Zustand
-- und heißt nie „veraltet"; „offline" heißt nie „fehlgeschlagen".
CREATE TABLE IF NOT EXISTS rollout_device (
    rollout_id UUID        NOT NULL REFERENCES rollout (id) ON DELETE CASCADE,
    device_id  UUID        NOT NULL,
    wave       INT         NOT NULL,
    state      TEXT        NOT NULL DEFAULT 'ausstehend',
    reason     TEXT,
    since      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rollout_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_rollout_device_rollout
    ON rollout_device (rollout_id, wave);

-- -----------------------------------------------------------------------------
-- rollout_event - das append-only Audit-Journal.
-- -----------------------------------------------------------------------------
-- Es beantwortet „wer hat wann welches Release wohin ausgerollt, und was ist
-- daraus geworden" (§7.1 Punkt 4). Append-only ist hier nicht Zierde: die
-- Papier-Spur des Solls ist neben dem signierten Git-Tag der zweite Beleg (§6),
-- und ein nachträglich änderbares Journal wäre keiner.
--
-- actor ist das JWT-Subject des Portal-Admins - oder 'system' für das, was der
-- Wächter selbst entscheidet (Auto-Halt, Drift-Republish). Ein Automatismus,
-- der sich als Mensch ausgibt, macht das Journal wertlos.
CREATE TABLE IF NOT EXISTS rollout_event (
    id         BIGSERIAL   PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor      TEXT        NOT NULL,
    event      TEXT        NOT NULL,
    rollout_id UUID,
    device_id  UUID,
    detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_rollout_event_at ON rollout_event (at DESC);
CREATE INDEX IF NOT EXISTS idx_rollout_event_rollout ON rollout_event (rollout_id, at DESC);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- Die vier Tabellen deckt V4s ALTER DEFAULT PRIVILEGES bereits ab (sie
-- entstehen NACH V4 und der Flyway-Superuser ist derselbe Erzeuger). Die
-- SEQUENZ hinter dem BIGSERIAL aber NICHT: Default-Privilegien für Sequenzen
-- sind eine eigene Objektklasse, und ohne dieses GRANT scheitert jedes
-- Journal-Insert mit „permission denied for sequence" - also genau der
-- Schreibpfad, der die Papier-Spur trägt.
GRANT USAGE, SELECT ON SEQUENCE rollout_event_id_seq TO ${adminDbUser};

-- Die App-Rolle bekommt hier BEWUSST NICHTS - auch kein SELECT. Es gibt keinen
-- Kunden-Lesepfad auf den Soll-Zustand der Flotte (§7.1: „Kunden-Flächen:
-- bewusst NICHTS in V1"), und ein Recht ohne Aufrufer ist eine offene Tür, die
-- irgendwann jemand benutzt.
