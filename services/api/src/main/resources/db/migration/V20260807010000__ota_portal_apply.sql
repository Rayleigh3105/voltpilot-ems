-- =============================================================================
-- V20260807010000 - Admin-UX-Umbau P3 „Portal-Apply" (Konzept
-- vp-admin-geraete-ux-k2 §6 / E3, Captain-Go 05.08.2026).
--
-- Bis hierher war das ANWENDEN der einzige Schritt des Flusses, der einen
-- Tunnel und das Geräte-Passwort je Box brauchte: entschieden und verteilt im
-- Portal, angewandt per SSH. Diese Migration trägt die zwei Dinge, die dafür
-- gespeichert werden müssen - und NUR die.
--
-- ADDITIV: eine nullable Spalte und eine neue Tabelle. Kein bestehender Wert
-- ändert seine Bedeutung; eine ältere Box und ein älteres Portal verhalten sich
-- zeichengleich wie vorher.
--
-- -----------------------------------------------------------------------------
-- 1. device_update_status.can_apply - die FÄHIGKEIT der Box.
-- -----------------------------------------------------------------------------
-- Ob eine Freigabe überhaupt aufgegriffen würde, weiß nur das Gerät: läuft dort
-- ein Stufe-3-Aktualisierer (Compose-Profil `ota`), und ist die Zuweisung
-- geprüft? Genau das meldet es seit dieser Stufe additiv im `update`-Block.
--
-- Es wird gespeichert, damit das Portal keinen Knopf anbietet, der strukturell
-- nichts bewirken kann. Die ehrliche Alternative - immer anbieten und die Box
-- still verweigern lassen - ist exakt das „eine Verweigerung wird zum Rätsel",
-- gegen das der Blocker-Name eingeführt wurde.
--
-- DREI Zustände, und das ist der ganze Punkt (dieselbe Disziplin wie bei der
-- Vertrauens-Identität): NULL = ein älterer Edge-Stand meldet es nicht, also
-- „unbekannt" - NIE „geht nicht"; false = die Box sagt selbst, dass hier gerade
-- nichts angewandt werden kann; true = sie würde eine Freigabe aufgreifen.
--
-- Es ist eine FÄHIGKEIT, nie eine Erlaubnis: ein `true` gestattet nichts, und
-- jedes Tor der Anwendung (Signaturkette, Anti-Rollback-Boden, Neutral-Zeit,
-- Interlock, Selbsttest, Rücknahme) gilt unverändert.
--
-- -----------------------------------------------------------------------------
-- 2. device_apply_request - die erteilte EINMAL-Freigabe.
-- -----------------------------------------------------------------------------
-- Genau EINE Zeile je Gerät, bei jeder neuen Freigabe ERSETZT: die Frage lautet
-- „ist für dieses Gerät gerade eine Freigabe unterwegs", nicht „welche gab es
-- je" - der VERLAUF liegt vollständig im append-only `rollout_event`-Journal
-- (`apply_requested`, mit dem JWT-Subject als Urheber). Eine zweite Historie
-- hätte keinen Leser.
--
-- Sie ist AUSDRÜCKLICH keine Autorisierung, die hier verwahrt wird: die
-- Autorisierung ist die NICHT-retained MQTT-Nachricht, die schon draußen ist,
-- wenn diese Zeile entsteht. Diese Tabelle ist der BELEG darüber - damit die
-- Oberfläche sagen kann „erteilt, wartet" und, nach Ablauf des
-- 15-Minuten-Fensters ohne Wirkung, „Freigabe nicht abgeholt" statt still
-- weiterzuwarten. Ein Gerät, das offline war, bekommt die Freigabe bewusst
-- NICHT nachgeliefert (eine Zustimmung von vor drei Stunden ist keine
-- Zustimmung für jetzt), und genau dieser Fall muss SICHTBAR sein.
--
-- GLOBAL, ohne tenant_id und ohne RLS - wie `rollout`/`edge_release`: das sind
-- Plattform-Betriebsdaten, es gibt per §7.1 KEINE Kunden-Fläche, und eine
-- tenant_id würde einen Kunden-Pfad suggerieren, den es nie geben darf.
-- Gefenced ist stattdessen der Endpunkt (`/admin/**` + `@PreAuthorize` +
-- BYPASSRLS-Repository).
--
-- Kein FK auf `device`: dieselbe Begründung wie beim Namens-Schnappschuss - ein
-- Unclaim darf weder an dieser Zeile scheitern noch sie stillschweigend
-- löschen. Der Unclaim-Pfad räumt sie ausdrücklich selbst ab.
--
-- Datums-Version nach der AGENTS.md-Koordination: sie sortiert NACH dem
-- höchsten schon ausgelieferten Stand (V20260807000000), sonst wäre sie für
-- Flyway „out of order" und würde auf einer langlebigen DB nie angewandt.
-- =============================================================================

ALTER TABLE device_update_status
    ADD COLUMN IF NOT EXISTS can_apply BOOLEAN;

CREATE TABLE IF NOT EXISTS device_apply_request (
    device_id       UUID        PRIMARY KEY,
    -- Der Token macht die Freigabe EINMALIG: der Sidecar quittiert genau ihn,
    -- dieselbe Freigabe kann also nie zweimal einen Tausch auslösen.
    token           TEXT        NOT NULL,
    -- Das Release, das der Betreiber GESEHEN hat. Eine Zustimmung gilt für das,
    -- was auf dem Schirm stand - eine inzwischen eingetroffene Zuweisung ist
    -- nicht mitfreigegeben, und das Gerät prüft das selbst noch einmal.
    release_version TEXT        NOT NULL,
    release_seq     BIGINT,
    requested_by    TEXT,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Die App-Rolle bekommt hier BEWUSST NICHTS - es gibt keinen Kunden-Lesepfad
-- auf Update-Betriebsdaten (§7.1), und ein Recht ohne Aufrufer ist eine offene
-- Tür, die irgendwann jemand benutzt. Die Tabelle entsteht NACH V4 und über
-- denselben Flyway-Superuser, also deckt V4s ALTER DEFAULT PRIVILEGES die
-- Admin-Rolle bereits ab (kein BIGSERIAL, also auch keine Sequenz).
