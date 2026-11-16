package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der SOLL-Zustand der Edge-Flotte und seine Orchestrierung (Tabellen
 * {@code device_update_target}, {@code rollout}, {@code rollout_device},
 * {@code rollout_event}; Migration V20260805000000, OTA Stufe 2).
 *
 * <p><b>Die RLS-Umgehung ist ÜBERNOMMEN, nicht neu erfunden</b>: dieselbe
 * dedizierte {@code adminJdbcTemplate}-Verbindung als BYPASSRLS-Rolle
 * {@code voltpilot_admin} wie {@link AdminFleetRepository} und
 * {@link EdgeReleaseRepository}, erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Die vier
 * Tabellen sind mandantenfrei (Plattform-Betriebsdaten wie das Register); die
 * Rolle liefert hier die Berechtigung, die die App-Rolle bewusst nicht hat.
 *
 * <p>Der Mandant eines Geräts wird für die Anzeige über
 * {@code device -> site -> tenant} GEJOINT, nie in diesen Tabellen dupliziert -
 * eine zweite Kopie könnte auseinanderlaufen.
 */
@Repository
public class RolloutRepository {

    private final JdbcTemplate jdbc;

    public RolloutRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    // ── Zuweisungen (device_update_target) ────────────────────────────────

    /** Die Zuweisung eines Geräts, angereichert um seine Identität. */
    public record TargetRow(UUID deviceId, UUID tenantId, UUID siteId, String siteName,
            String tenantName, String externalRef, long releaseSeq, String releaseVersion,
            UUID rolloutId, String assignedBy, Instant assignedAt,
            Instant publishedAt, String manifest, String signature) {
    }

    private static final String TARGET_SELECT = """
            SELECT t.device_id, t.release_seq, t.release_version,
                   t.rollout_id, t.assigned_by, t.assigned_at, t.published_at,
                   d.external_ref, d.site_id, s.name AS site_name,
                   s.tenant_id, ten.name AS tenant_name,
                   r.manifest, r.signature
              FROM device_update_target t
              JOIN device d ON d.id = t.device_id AND d.ausgebaut_am IS NULL
              JOIN site s ON s.id = d.site_id
              JOIN tenant ten ON ten.id = s.tenant_id
              JOIN edge_release r ON r.release_seq = t.release_seq
            """;

    public List<TargetRow> allTargets() {
        return jdbc.query(TARGET_SELECT + " ORDER BY ten.name, s.name", RolloutRepository::mapTarget);
    }

    public Optional<TargetRow> targetOf(UUID deviceId) {
        return jdbc.query(TARGET_SELECT + " WHERE t.device_id = ?", RolloutRepository::mapTarget,
                deviceId).stream().findFirst();
    }

    /**
     * Eine Zuweisung setzen (genau EINE Zeile je Gerät - zwei gleichzeitige
     * Ziele wären die Mehrdeutigkeit, gegen die die Ordnung gebaut ist).
     * {@code published_at} wird bewusst zurückgesetzt: das neue Ziel ist noch
     * nicht hinausgegangen, und der Drift-Wächter soll es aufgreifen, falls der
     * unmittelbare Publish scheitert.
     */
    public void upsertTarget(UUID deviceId, long releaseSeq, String releaseVersion,
            UUID rolloutId, String assignedBy) {
        jdbc.update("""
                INSERT INTO device_update_target (device_id, release_seq, release_version,
                        rollout_id, assigned_by, assigned_at, published_at)
                VALUES (?, ?, ?, ?, ?, now(), NULL)
                ON CONFLICT (device_id) DO UPDATE SET release_seq = EXCLUDED.release_seq,
                        release_version = EXCLUDED.release_version,
                        rollout_id = EXCLUDED.rollout_id,
                        assigned_by = EXCLUDED.assigned_by, assigned_at = now(),
                        published_at = NULL
                """, deviceId, releaseSeq, releaseVersion, rolloutId, assignedBy);
    }

    public void markPublished(UUID deviceId) {
        jdbc.update("UPDATE device_update_target SET published_at = now() WHERE device_id = ?",
                deviceId);
    }

    /** Eine Zuweisung zurücknehmen; {@code true} wenn es eine gab. */
    public boolean deleteTarget(UUID deviceId) {
        return jdbc.update("DELETE FROM device_update_target WHERE device_id = ?", deviceId) > 0;
    }

    // ── Rollouts ─────────────────────────────────────────────────────────

    public record RolloutRow(UUID id, long releaseSeq, String releaseVersion,
            String state,
            String createdBy, Instant createdAt, Instant updatedAt) {
    }

    private static final String ROLLOUT_SELECT = """
            SELECT id, release_seq, release_version, state,
                   created_by, created_at, updated_at
              FROM rollout
            """;

    public List<RolloutRow> allRollouts() {
        return jdbc.query(ROLLOUT_SELECT + " ORDER BY created_at DESC",
                RolloutRepository::mapRollout);
    }

    /** Die noch laufenden Verteilungen (der Wächter schreibt ihre Zustände fort). */
    public java.util.List<RolloutRow> activeRollouts() {
        return jdbc.query(ROLLOUT_SELECT + " WHERE state = 'active' ORDER BY created_at",
                RolloutRepository::mapRollout);
    }

    /**
     * Die JÜNGSTEN Verteilungen, unabhängig von ihrem Zustand - was die Seite
     * „Edge-Updates" zeigt.
     *
     * <p>Eine LISTE, seit die Ein-Schritt-Vereinfachung die Sperre
     * „höchstens ein lebender Rollout" entfernt hat: mehrere Aktualisierungen
     * dürfen nebeneinander laufen, und die Seite muss sie alle zeigen können.
     * Eine gerade abgeschlossene bleibt bewusst sichtbar - sie darf nicht in
     * dem Augenblick verschwinden, in dem sie fertig wird.
     */
    public List<RolloutRow> recentRollouts(int limit) {
        return jdbc.query(ROLLOUT_SELECT + " ORDER BY created_at DESC LIMIT " + limit,
                RolloutRepository::mapRollout);
    }

    /**
     * Der JÜNGSTE Rollout, unabhängig von seinem Zustand - was die Seite
     * „Aktiver Rollout" zeigt.
     *
     * <p>Bewusst NICHT nur die laufenden: eine gerade abgeschlossene
     * Aktualisierung ist der Moment, in dem der Betreiber sie am dringendsten
     * sieht - sie darf nicht in dem Augenblick von der Seite verschwinden, in
     * dem sie fertig wird (oder ein Gerät gemeldet hat, dass es nicht ging).
     */
    public Optional<RolloutRow> latestRollout() {
        return jdbc.query(ROLLOUT_SELECT + " ORDER BY created_at DESC LIMIT 1",
                RolloutRepository::mapRollout).stream().findFirst();
    }

    public Optional<RolloutRow> rollout(UUID id) {
        return jdbc.query(ROLLOUT_SELECT + " WHERE id = ?", RolloutRepository::mapRollout, id)
                .stream().findFirst();
    }

    public void insertRollout(UUID id, long releaseSeq, String releaseVersion,
            String createdBy) {
        jdbc.update("""
                INSERT INTO rollout (id, release_seq, release_version, state, created_by)
                VALUES (?, ?, ?, 'active', ?)
                """, id, releaseSeq, releaseVersion, createdBy);
    }


    public void setRolloutState(UUID id, String state) {
        jdbc.update("UPDATE rollout SET state = ?, updated_at = now() WHERE id = ?", state, id);
    }


    // ── Geräte eines Rollouts ────────────────────────────────────────────

    /**
     * Ein Gerät innerhalb eines Rollouts.
     *
     * <p>{@code deviceRef}/{@code siteName} sind der NAMENS-SCHNAPPSCHUSS vom
     * Zeitpunkt der Zuweisung (Migration V20260807000000): die Wellen-Definition
     * ist eingefroren, also muss auch ihre Beschriftung einen Unclaim
     * überleben - sonst fällt die Zeile auf eine nackte UUID zurück. Beide sind
     * {@code null} für Rollouts, die vor dieser Migration gestartet wurden;
     * dann greift der Live-Join wie bisher.
     */
    public record RolloutDeviceRow(UUID rolloutId, UUID deviceId, String state,
            String reason, Instant since, String deviceRef, String siteName) {
    }

    public List<RolloutDeviceRow> devicesOf(UUID rolloutId) {
        return jdbc.query("SELECT rollout_id, device_id, state, reason, since, "
                + "device_ref, site_name "
                + "FROM rollout_device WHERE rollout_id = ? ORDER BY device_id",
                RolloutRepository::mapRolloutDevice, rolloutId);
    }

    /**
     * Ein Gerät in eine Welle aufnehmen - mit seinem Namen, wie er JETZT ist.
     *
     * <p>Der Schnappschuss ist bewusst Denormalisierung: die Frage der Historie
     * lautet „wie hieß dieses Gerät, ALS es in die Welle kam", und ein FK auf
     * {@code device} würde die Antwort beim Unclaim löschen.
     */
    public void insertRolloutDevice(UUID rolloutId, UUID deviceId, String state,
            String reason, String deviceRef, String siteName) {
        jdbc.update("""
                INSERT INTO rollout_device (rollout_id, device_id, state, reason, since,
                                            device_ref, site_name)
                VALUES (?, ?, ?, ?, now(), ?, ?)
                ON CONFLICT (rollout_id, device_id) DO NOTHING
                """, rolloutId, deviceId, state, reason, deviceRef, siteName);
    }

    /**
     * Den abgeleiteten Zustand eines Geräts fortschreiben.
     *
     * <p>{@code since} wird NUR bei einem echten Zustandswechsel neu gesetzt -
     * „seit" beantwortet „wie lange steht es SO", und ein Zeitstempel, der bei
     * jedem Wächter-Lauf springt, beantwortet gar nichts (und das Bake-Fenster
     * hinge daran).
     */
    public void updateRolloutDeviceState(UUID rolloutId, UUID deviceId, String state,
            String reason) {
        jdbc.update("""
                UPDATE rollout_device
                   SET since = CASE WHEN state IS DISTINCT FROM ? THEN now() ELSE since END,
                       state = ?, reason = ?
                 WHERE rollout_id = ? AND device_id = ?
                """, state, state, reason, rolloutId, deviceId);
    }

    // ── Journal ──────────────────────────────────────────────────────────

    public record EventRow(long id, Instant at, String actor, String event, UUID rolloutId,
            UUID deviceId, String detail) {
    }

    /**
     * Einen Eintrag anhängen. {@code actor} ist das JWT-Subject des
     * Portal-Admins oder {@code system} für das, was der Wächter selbst
     * entscheidet - ein Automatismus, der sich als Mensch ausgibt, macht das
     * Journal wertlos.
     */
    public void appendEvent(String actor, String event, UUID rolloutId, UUID deviceId,
            String detail) {
        jdbc.update("INSERT INTO rollout_event (actor, event, rollout_id, device_id, detail) "
                + "VALUES (?, ?, ?, ?, ?)", actor, event, rolloutId, deviceId, detail);
    }

    public List<EventRow> recentEvents(int limit) {
        return jdbc.query("SELECT id, at, actor, event, rollout_id, device_id, detail "
                + "FROM rollout_event ORDER BY at DESC, id DESC LIMIT ?",
                RolloutRepository::mapEvent, limit);
    }

    // ── Erstverbindung: die Automatik beim ersten Verbinden ──────────────

    /**
     * Eine Box, die sich seit {@code seit} zum ersten Mal gemeldet hat
     * ({@code device_update_status.erste_meldung_am}), mit dem, was die Regel
     * {@code ota.Erstverbindung} über ihre Vorgeschichte wissen muss.
     *
     * @param hatteZuweisung sie hat eine Zuweisung oder hatte je eine (Journal)
     * @param entschieden    die Regel hat für sie schon etwas ins Journal geschrieben
     */
    public record ErstmeldungRow(UUID deviceId, Instant ersteMeldungAm, boolean hatteZuweisung,
            boolean entschieden) {
    }

    public List<ErstmeldungRow> erstmeldungenSeit(Instant seit, String urheber) {
        return jdbc.query("""
                SELECT u.device_id, u.erste_meldung_am,
                       EXISTS (SELECT 1 FROM device_update_target t WHERE t.device_id = u.device_id)
                       OR EXISTS (SELECT 1 FROM rollout_event e WHERE e.device_id = u.device_id
                                     AND e.event = 'target_assigned') AS hatte_zuweisung,
                       EXISTS (SELECT 1 FROM rollout_event e WHERE e.device_id = u.device_id
                                 AND e.actor = ?) AS entschieden
                  FROM device_update_status u
                  JOIN device d ON d.id = u.device_id AND d.ausgebaut_am IS NULL
                 WHERE u.erste_meldung_am >= ?
                 ORDER BY u.erste_meldung_am
                """, (rs, i) -> new ErstmeldungRow(rs.getObject("device_id", UUID.class),
                        instant(rs, "erste_meldung_am"), rs.getBoolean("hatte_zuweisung"),
                        rs.getBoolean("entschieden")),
                urheber, Timestamp.from(seit));
    }

    /** Ein Eintrag des Schalters ({@code bereich} = alle, docker, light). */
    public record SchalterRow(String bereich, boolean an, String geaendertVon, Instant geaendertAm) {
    }

    public List<SchalterRow> erstverbindungSchalter() {
        return jdbc.query("SELECT bereich, an, geaendert_von, geaendert_am "
                        + "FROM ota_erstverbindung_schalter ORDER BY bereich",
                (rs, i) -> new SchalterRow(rs.getString("bereich"), rs.getBoolean("an"),
                        rs.getString("geaendert_von"), instant(rs, "geaendert_am")));
    }

    /** Den Schalter eines Bereichs setzen; {@code true}, wenn er sich dadurch änderte. */
    public boolean setzeErstverbindungSchalter(String bereich, boolean an, String von) {
        return jdbc.update("""
                INSERT INTO ota_erstverbindung_schalter (bereich, an, geaendert_von, geaendert_am)
                VALUES (?, ?, ?, now())
                ON CONFLICT (bereich) DO UPDATE SET an = EXCLUDED.an,
                        geaendert_von = EXCLUDED.geaendert_von, geaendert_am = now()
                 WHERE ota_erstverbindung_schalter.an IS DISTINCT FROM EXCLUDED.an
                """, bereich, an, von) > 0;
    }

    // ── Portal-Apply: die erteilte Einmal-Freigabe ───────────────────────







    // ── Flottensicht: was meldet welches Gerät? ──────────────────────────

    /**
     * Ein Gerät der Flotte mit seinem gemeldeten IST.
     *
     * <p>Alles ab {@code reportedVersion} kann {@code null} sein - dann hat das
     * Gerät (noch) nichts gemeldet und heißt „unbekannt", NIE „veraltet".
     * {@code reportedBackend} ist {@code update.backend} verbatim; daraus und aus
     * dem Stempel leitet {@code ota.BoxArt} die Box-Art ab.
     * {@code controlCheckedAt}/{@code controlConfirmed}/{@code controlCertified}
     * kommen aus {@code device_control_status} - reine Diagnose.
     * {@code lastSeenAt} ist die EINE Uhr für „online" (Serverzeit des letzten
     * Herzschlags, sonst der letzten Telemetrie); {@code targetVerdictAt} und
     * {@code currentSince} sind die Zeitpunkte „angenommen" und „läuft seit"
     * (Geräte &amp; Updates G2, {@code null} = unbekannt).
     */
    public record FleetDeviceRow(UUID deviceId, String externalRef, String deviceName,
            UUID siteId, String siteName, UUID tenantId, String tenantName,
            String reportedVersion, String reportedBackend, String reportedCurrent,
            String reportedTarget,
            String reportedState, String reportedVerdict, String reportedReason,
            String reportedBlocker, Instant reportedAt, Instant lastSeenAt,
            Instant controlCheckedAt, Boolean controlConfirmed, Boolean controlCertified,
            String rootKeyIds, String trustSetKeyIds, String trustSetGeneratedAt,
            String trustSetError, Instant targetVerdictAt, Instant currentSince,
            String geraetModell, String geraetArch, String loader, Integer loaderStand,
            // Herkunft (vp-geraete-herkunft): die Werkstatt-Abnahme dieser Referenz, über denselben
            // edge_ref/external_ref-Stringabgleich wie in WerkstattRepository (keine FK zwischen den
            // Domänen); null = die Box hat sich ohne Werkstatt-Abnahme selbst angemeldet.
            Instant werkstattAbnahmeAm) {
    }

    /**
     * Alle Geräte der Plattform mit ihrem gemeldeten Stand. Ein LEFT JOIN,
     * damit ein Gerät ohne jede Meldung sichtbar BLEIBT - genau das ist der
     * Zustand „unbekannt", und ihn wegzufiltern hieße, ihn zu verschweigen.
     *
     * <p>„Zuletzt gesehen" ist der Herzschlag, nur ohne ihn die jüngste
     * Telemetrie-Ankunft. Die Ankunft steht darum als Unterabfrage IM
     * {@code coalesce} und läuft nur für Boxen ohne Herzschlag; vorher lief
     * sie als {@code LEFT JOIN LATERAL} für JEDE Box - je Gerät ein Abstieg in
     * jeden Telemetrie-Chunk, alle 60 s im Rollout-Wächter und bei jedem
     * Abruf der Seiten Edge-Updates und Geräte (Lasttest vp-lasttest, Befund
     * B6, Rang 5). Ergebnis unverändert.
     */
    public List<FleetDeviceRow> fleetDevices() {
        return jdbc.query("""
                SELECT d.id AS device_id, d.external_ref, d.name AS device_name,
                       d.site_id, s.name AS site_name, s.tenant_id, t.name AS tenant_name,
                       u.version, u.backend, u.current_version, u.target_version, u.state,
                       u.target_verdict,
                       u.reason, u.blocker, u.reported_at,
                       u.root_key_ids, u.trust_set_key_ids, u.trust_set_generated_at,
                       u.trust_set_error, u.target_verdict_at, u.current_since,
                       u.geraet_modell, u.geraet_arch, u.loader, u.loader_stand,
                       coalesce(d.device_status_seen_at,
                                (SELECT max(tm.received_at) FROM telemetry tm
                                  WHERE tm.device_id = d.id)) AS last_seen,
                       c.checked_at AS control_checked_at, c.all_match AS control_confirmed,
                       c.certified AS control_certified,
                       wa.werkstatt_abnahme_am
                  FROM device d
                  JOIN site s ON s.id = d.site_id
                  JOIN tenant t ON t.id = s.tenant_id
                  LEFT JOIN device_update_status u ON u.device_id = d.id
                  LEFT JOIN device_control_status c ON c.device_id = d.id
                  LEFT JOIN (SELECT edge_ref, min(erfasst_am) AS werkstatt_abnahme_am
                               FROM werkstatt_abnahme GROUP BY edge_ref) wa ON wa.edge_ref = d.external_ref
                 WHERE d.ausgebaut_am IS NULL
                 ORDER BY t.name, s.name, d.external_ref
                """, (rs, i) -> new FleetDeviceRow(
                        rs.getObject("device_id", UUID.class),
                        rs.getString("external_ref"),
                        rs.getString("device_name"),
                        rs.getObject("site_id", UUID.class),
                        rs.getString("site_name"),
                        rs.getObject("tenant_id", UUID.class),
                        rs.getString("tenant_name"),
                        rs.getString("version"),
                        rs.getString("backend"),
                        rs.getString("current_version"),
                        rs.getString("target_version"),
                        rs.getString("state"),
                        rs.getString("target_verdict"),
                        rs.getString("reason"),
                        // Der maschinenlesbare Sperr-Name. null = keine
                        // gemeldet - ausdrücklich NICHT „nicht blockiert".
                        rs.getString("blocker"),
                        instant(rs, "reported_at"),
                        instant(rs, "last_seen"),
                        instant(rs, "control_checked_at"),
                        (Boolean) rs.getObject("control_confirmed"),
                        (Boolean) rs.getObject("control_certified"),
                        // ⚠ getString, NICHT getObject-mit-Default: die Spalte
                        // ist DREIWERTIG (null = nie gemeldet, "" = Image ohne
                        // Wurzel, sonst die Liste), und ein Default machte aus
                        // „unbekannt" ein behauptetes „kein Schlüssel".
                        rs.getString("root_key_ids"),
                        rs.getString("trust_set_key_ids"),
                        rs.getString("trust_set_generated_at"),
                        rs.getString("trust_set_error"),
                        // Geräte & Updates G2: „angenommen" und „läuft seit" -
                        // null = unbekannt (kein beobachteter Wechsel).
                        instant(rs, "target_verdict_at"),
                        instant(rs, "current_since"),
                        // Geräte & Updates G8: das Gerät (null = nicht gemeldet).
                        rs.getString("geraet_modell"),
                        rs.getString("geraet_arch"),
                        rs.getString("loader"),
                        // Loader-Selbstupdate: die LOADER_STAND-Marke im Flash
                        // (null = nicht gemeldet, nie 0 erfinden).
                        (Integer) rs.getObject("loader_stand"),
                        instant(rs, "werkstatt_abnahme_am")));
    }

    /** Prüft, ob eine Geräte-Id überhaupt existiert (bevor sie ein Ziel bekommt). */
    public Optional<FleetDeviceRow> fleetDevice(UUID deviceId) {
        return fleetDevices().stream().filter(d -> d.deviceId().equals(deviceId)).findFirst();
    }

    /**
     * Werkstatt-Abnahmedatum je Referenz (vp-geraete-herkunft), für gedruckte Aufkleber-IDs, die
     * noch kein Gerät sind - {@link #fleetDevices} trägt dasselbe für die verbundene Flotte schon
     * über den JOIN. Derselbe String-Abgleich wie überall sonst zwischen den beiden Domänen, keine
     * FK; leer = keine der Referenzen war je in der Werkstatt.
     */
    public Map<String, Instant> werkstattAbnahmeAm(Collection<String> refs) {
        if (refs.isEmpty()) {
            return Map.of();
        }
        String platzhalter = refs.stream().map(r -> "?").collect(Collectors.joining(","));
        Map<String, Instant> ergebnis = new HashMap<>();
        jdbc.query("SELECT edge_ref, min(erfasst_am) AS abnahme_am FROM werkstatt_abnahme "
                        + "WHERE edge_ref IN (" + platzhalter + ") GROUP BY edge_ref",
                rs -> {
                    ergebnis.put(rs.getString("edge_ref"), rs.getTimestamp("abnahme_am").toInstant());
                },
                refs.toArray());
        return ergebnis;
    }

    private static TargetRow mapTarget(ResultSet rs, int rowNum) throws SQLException {
        return new TargetRow(
                rs.getObject("device_id", UUID.class),
                rs.getObject("tenant_id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getString("site_name"),
                rs.getString("tenant_name"),
                rs.getString("external_ref"),
                rs.getLong("release_seq"),
                rs.getString("release_version"),
                rs.getObject("rollout_id", UUID.class),
                rs.getString("assigned_by"),
                instant(rs, "assigned_at"),
                instant(rs, "published_at"),
                rs.getString("manifest"),
                rs.getString("signature"));
    }

    private static RolloutRow mapRollout(ResultSet rs, int rowNum) throws SQLException {
        return new RolloutRow(
                rs.getObject("id", UUID.class),
                rs.getLong("release_seq"),
                rs.getString("release_version"),
                rs.getString("state"),
                rs.getString("created_by"),
                instant(rs, "created_at"),
                instant(rs, "updated_at"));
    }

    private static RolloutDeviceRow mapRolloutDevice(ResultSet rs, int rowNum) throws SQLException {
        return new RolloutDeviceRow(
                rs.getObject("rollout_id", UUID.class),
                rs.getObject("device_id", UUID.class),
                rs.getString("state"),
                rs.getString("reason"),
                instant(rs, "since"),
                rs.getString("device_ref"),
                rs.getString("site_name"));
    }

    private static EventRow mapEvent(ResultSet rs, int rowNum) throws SQLException {
        return new EventRow(
                rs.getLong("id"),
                instant(rs, "at"),
                rs.getString("actor"),
                rs.getString("event"),
                rs.getObject("rollout_id", UUID.class),
                rs.getObject("device_id", UUID.class),
                rs.getString("detail"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }
}
