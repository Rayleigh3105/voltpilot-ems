-- =============================================================================
-- V20260803020000 - edge_release: das minimale RELEASE-REGISTER (OTA Stufe 0,
-- Scout vp-ota-rollout-h4 §9 + Captain-Entscheid D5). ADDITIV.
-- -----------------------------------------------------------------------------
-- WOFÜR es da ist: „veraltet" war bisher NICHT wohldefiniert. Der Puls
-- verglich den gemeldeten Stand gegen das FLOTTEN-MAXIMUM („alle gleich alt"
-- las sich als „alle aktuell", §2.3 Loch 2), und die Ordnung selbst verglich
-- 12-stellige Hex-SHAs als Zahlenblöcke (`parseInt("665d59b8…")` = 665 gegen
-- `parseInt("3bf8c038…")` = 3) - auf SHAs ist das eine Zufallsordnung
-- (Loch 3). Beides verschwindet mit diesem Register:
--
--   release_seq   DIE Ordnung: eine monotone Ganzzahl, nie ein
--                 String-/SHA-Vergleich (D5). Sie ist der Primärschlüssel,
--                 weil „welches Release ist neuer" die einzige Frage ist, die
--                 dieses Register beantworten muss.
--   version       das menschenlesbare Tag `edge-JJJJ.MM.N` (edge-images
--                 stempelt bereits `<tag>-<sha>`), eindeutig.
--   target_commit der Commit, aus dem gebaut wurde - die Papier-Spur ins
--                 voltpilot-ems-Repo.
--
-- GLOBALE Betriebsdaten wie provisioned_device: ein Release entsteht lange
-- bevor irgendein Mandant es fährt, also bewusst KEIN tenant_id und KEINE RLS.
-- Die App-Rolle darf nur LESEN; geschrieben wird ausschließlich über die
-- BYPASSRLS-Rolle voltpilot_admin aus einem platform-admin-Endpunkt.
--
-- BEWUSST NOCH NICHT DA (Stufe 1): Signatur-Felder (signing_key_id, signature,
-- die Artefakt-Referenzen, min_from_seq, allow_downgrade). Sie kommen als
-- reines ALTER TABLE ADD COLUMN dazu - die Ordnung (release_seq) und die
-- Identität (version) sind genau die Teile, die ein Signatur-Manifest später
-- unverändert übernimmt, also verbaut diese Tabelle nichts.
--
-- In Stufe 0 wird das Register HAND-gepflegt (Portal-Admin, kein Schreibpfad
-- zum Gerät); der Release-Job der Stufe 1 füllt es später automatisch.
--
-- Datums-Version nach der AGENTS.md-Koordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS edge_release (
    release_seq   BIGINT      PRIMARY KEY,
    version       TEXT        NOT NULL UNIQUE,
    target_commit TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    TEXT
);

-- Nur lesen: das Register ist Plattform-Betriebsdatum, kein Kundendatum.
-- (Die V2-Default-Privilegien würden der App-Rolle sonst auch Schreibrechte
-- geben - dieselbe Behandlung wie provisioned_device.)
GRANT SELECT ON edge_release TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON edge_release FROM ${appDbUser};
