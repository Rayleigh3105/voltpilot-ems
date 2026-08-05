-- =============================================================================
-- V20260807000000 - Admin-UX-Umbau P0/P1 (Scout vp-admin-geraete-ux-k2 §6):
-- die Wellen-Historie behält ihre NAMEN, und der Blocker des Geräts wird
-- maschinenlesbar. ADDITIV: drei nullable Spalten, keine bestehende Zeile
-- ändert ihre Bedeutung; ein älterer Edge-Stand und ein älteres Portal
-- verhalten sich zeichengleich wie vorher.
-- -----------------------------------------------------------------------------
-- 1. rollout_device.{device_ref, site_name} - der NAMENS-SCHNAPPSCHUSS.
--
-- Die Wellen-Definition eines Rollouts wird beim Start EINGEFROREN (sie ist die
-- Papier-Spur: „wer war in Welle 1"). Die NAMEN dazu wurden bisher aber bei
-- jeder Anzeige frisch aus `device`/`site` gejoint - und fällt das Gerät dort
-- weg, bleibt nur seine UUID. Genau das passiert real: ein Unclaim + Re-Claim
-- prägt eine NEUE device_id (dokumentierter Identitäts-Drift), die alte Zeile
-- verschwindet aus `device`, und die Wellen-Liste rendert eine nackte
-- `cdba2ee8-91f3-4c…` mitten zwischen Klarnamen (Reibung R2 vom 04.08.2026).
--
-- Ein FK auf `device` wäre die falsche Antwort: er würde die Historie beim
-- Unclaim löschen (ON DELETE CASCADE) oder den Unclaim blockieren. Die Historie
-- soll den Unclaim ÜBERLEBEN - also wird der Name bei der Zuweisung KOPIERT.
-- Das ist bewusst Denormalisierung mit Zweck: die Frage lautet „wie hieß dieses
-- Gerät, ALS es in die Welle kam", nicht „wie heißt es heute".
--
-- Beide bleiben nullable: ein Rollout, der vor dieser Migration gestartet
-- wurde, hat keinen Schnappschuss - dann greift der Live-Join wie bisher, und
-- erst wenn AUCH der leer ist, sagt die Oberfläche „Entferntes Gerät". Eine
-- erfundene Bezeichnung entsteht an keiner Stelle.
--
-- 2. device_update_status.blocker - der SPERR-NAME, maschinenlesbar.
--
-- Seit PR #331 meldet die Box eine stehende Sperre ehrlich im deutschen
-- `reason` („Autonomie blockiert: …"). Der maschinenlesbare NAME dazu
-- (`otaapply.Blocker*`: neutralzeit, platte, interlock, kern_still, politik,
-- kette, …) blieb bewusst auf dem Gerät („kein Schema, kein DTO") - mit der
-- Folge, dass ein T-Wächter-Halt cloud-seitig nicht von „die Zuweisung ist
-- unterwegs" zu unterscheiden war und im BUSY-Ton „ausstehend" landete: ein
-- stehender Blocker sah aus wie Fortschritt (Reibung R4).
--
-- Er wird hier persistiert, damit die Ableitung ihn LESEN kann, statt einen
-- deutschen Satz nach Stichworten zu durchsuchen - die Haus-Regel „keine
-- Oberfläche durchsucht deutsche Sätze" (dieselbe, aus der `target_verdict`
-- NEBEN `state` steht). Der Ingest verwirft ein Wort, das nicht im Vokabular
-- steht, statt es zu speichern.
--
-- NULL heißt „keine stehende Sperre gemeldet" - und das ist NICHT dasselbe wie
-- „nicht blockiert": ein älterer Edge-Stand meldet das Feld gar nicht. Deshalb
-- darf keine Oberfläche aus NULL „läuft" ableiten; sie leitet aus einem
-- VORHANDENEN Blocker „blockiert" ab und lässt alles andere, wie es war.
--
-- Datums-Version nach der AGENTS.md-Koordination: sie sortiert NACH dem
-- höchsten schon ausgelieferten Stand (V20260806010000), sonst wäre sie für
-- Flyway „out of order" und würde auf einer langlebigen DB nie angewandt.
-- =============================================================================

ALTER TABLE rollout_device
    ADD COLUMN IF NOT EXISTS device_ref TEXT,
    ADD COLUMN IF NOT EXISTS site_name  TEXT;

ALTER TABLE device_update_status
    ADD COLUMN IF NOT EXISTS blocker TEXT;
