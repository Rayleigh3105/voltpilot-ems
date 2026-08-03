package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
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
            String channel, boolean pinned, UUID rolloutId, String assignedBy, Instant assignedAt,
            Instant publishedAt, String manifest, String signature) {
    }

    private static final String TARGET_SELECT = """
            SELECT t.device_id, t.release_seq, t.release_version, t.channel, t.pinned,
                   t.rollout_id, t.assigned_by, t.assigned_at, t.published_at,
                   d.external_ref, d.site_id, s.name AS site_name,
                   s.tenant_id, ten.name AS tenant_name,
                   r.manifest, r.signature
              FROM device_update_target t
              JOIN device d ON d.id = t.device_id
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
    public void upsertTarget(UUID deviceId, long releaseSeq, String releaseVersion, String channel,
            boolean pinned, UUID rolloutId, String assignedBy) {
        jdbc.update("""
                INSERT INTO device_update_target (device_id, release_seq, release_version, channel,
                        pinned, rollout_id, assigned_by, assigned_at, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, now(), NULL)
                ON CONFLICT (device_id) DO UPDATE SET release_seq = EXCLUDED.release_seq,
                        release_version = EXCLUDED.release_version, channel = EXCLUDED.channel,
                        pinned = EXCLUDED.pinned, rollout_id = EXCLUDED.rollout_id,
                        assigned_by = EXCLUDED.assigned_by, assigned_at = now(),
                        published_at = NULL
                """, deviceId, releaseSeq, releaseVersion, channel, pinned, rolloutId, assignedBy);
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

    public record RolloutRow(UUID id, long releaseSeq, String releaseVersion, String channel,
            String state, String wavesJson, int currentWave, String haltedReason, String createdBy,
            Instant createdAt, Instant updatedAt) {
    }

    private static final String ROLLOUT_SELECT = """
            SELECT id, release_seq, release_version, channel, state, waves::text AS waves,
                   current_wave, halted_reason, created_by, created_at, updated_at
              FROM rollout
            """;

    public List<RolloutRow> allRollouts() {
        return jdbc.query(ROLLOUT_SELECT + " ORDER BY created_at DESC",
                RolloutRepository::mapRollout);
    }

    /**
     * Der EINE laufende Rollout ({@code active} oder {@code paused}) - ein
     * partieller Unique-Index in der Migration garantiert, dass es höchstens
     * einen gibt.
     */
    public Optional<RolloutRow> liveRollout() {
        return jdbc.query(ROLLOUT_SELECT + " WHERE state IN ('active','paused')",
                RolloutRepository::mapRollout).stream().findFirst();
    }

    /**
     * Der JÜNGSTE Rollout, unabhängig von seinem Zustand - was die Seite
     * „Aktiver Rollout" zeigt.
     *
     * <p>Bewusst NICHT {@link #liveRollout()}: ein gerade AUTOMATISCH
     * angehaltener Rollout ist der Moment, in dem der Betreiber ihn am
     * dringendsten sieht - er dürfte nicht in dem Augenblick von der Seite
     * verschwinden, in dem etwas schiefgegangen ist. {@code liveRollout} bleibt
     * die Regel „höchstens einer bewegt die Flotte"; diese hier ist die Anzeige.
     */
    public Optional<RolloutRow> latestRollout() {
        return jdbc.query(ROLLOUT_SELECT + " ORDER BY created_at DESC LIMIT 1",
                RolloutRepository::mapRollout).stream().findFirst();
    }

    public Optional<RolloutRow> rollout(UUID id) {
        return jdbc.query(ROLLOUT_SELECT + " WHERE id = ?", RolloutRepository::mapRollout, id)
                .stream().findFirst();
    }

    public void insertRollout(UUID id, long releaseSeq, String releaseVersion, String channel,
            String wavesJson, String createdBy) {
        jdbc.update("""
                INSERT INTO rollout (id, release_seq, release_version, channel, state, waves,
                        current_wave, created_by)
                VALUES (?, ?, ?, ?, 'active', ?::jsonb, 0, ?)
                """, id, releaseSeq, releaseVersion, channel, wavesJson, createdBy);
    }

    public void setRolloutState(UUID id, String state, String haltedReason) {
        jdbc.update("UPDATE rollout SET state = ?, halted_reason = ?, updated_at = now() "
                + "WHERE id = ?", state, haltedReason, id);
    }

    public void setCurrentWave(UUID id, int wave) {
        jdbc.update("UPDATE rollout SET current_wave = ?, updated_at = now() WHERE id = ?",
                wave, id);
    }

    // ── Geräte eines Rollouts ────────────────────────────────────────────

    public record RolloutDeviceRow(UUID rolloutId, UUID deviceId, int wave, String state,
            String reason, Instant since) {
    }

    public List<RolloutDeviceRow> devicesOf(UUID rolloutId) {
        return jdbc.query("SELECT rollout_id, device_id, wave, state, reason, since "
                + "FROM rollout_device WHERE rollout_id = ? ORDER BY wave, device_id",
                RolloutRepository::mapRolloutDevice, rolloutId);
    }

    public void insertRolloutDevice(UUID rolloutId, UUID deviceId, int wave, String state,
            String reason) {
        jdbc.update("""
                INSERT INTO rollout_device (rollout_id, device_id, wave, state, reason, since)
                VALUES (?, ?, ?, ?, ?, now())
                ON CONFLICT (rollout_id, device_id) DO NOTHING
                """, rolloutId, deviceId, wave, state, reason);
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

    // ── Flottensicht: was meldet welches Gerät? ──────────────────────────

    /**
     * Ein Gerät der Flotte mit seinem gemeldeten IST.
     *
     * <p>Alles ab {@code reportedVersion} kann {@code null} sein - dann hat das
     * Gerät (noch) nichts gemeldet und heißt „unbekannt", NIE „veraltet".
     * {@code controlCheckedAt}/{@code controlConfirmed}/{@code controlCertified}
     * kommen aus {@code device_control_status} und tragen das zweite
     * Bake-Kriterium (≥1 echter Steuerzyklus).
     */
    public record FleetDeviceRow(UUID deviceId, String externalRef, String deviceName,
            UUID siteId, String siteName, UUID tenantId, String tenantName,
            String reportedVersion, String reportedCurrent, String reportedTarget,
            String reportedState, String reportedVerdict, String reportedReason,
            Instant reportedAt, Instant lastSeenAt, Instant controlCheckedAt,
            Boolean controlConfirmed, Boolean controlCertified) {
    }

    /**
     * Alle Geräte der Plattform mit ihrem gemeldeten Stand. Ein LEFT JOIN,
     * damit ein Gerät ohne jede Meldung sichtbar BLEIBT - genau das ist der
     * Zustand „unbekannt", und ihn wegzufiltern hieße, ihn zu verschweigen.
     */
    public List<FleetDeviceRow> fleetDevices() {
        return jdbc.query("""
                SELECT d.id AS device_id, d.external_ref, d.name AS device_name,
                       d.site_id, s.name AS site_name, s.tenant_id, t.name AS tenant_name,
                       u.version, u.current_version, u.target_version, u.state, u.target_verdict,
                       u.reason, u.reported_at,
                       ls.last_seen,
                       c.checked_at AS control_checked_at, c.all_match AS control_confirmed,
                       c.certified AS control_certified
                  FROM device d
                  JOIN site s ON s.id = d.site_id
                  JOIN tenant t ON t.id = s.tenant_id
                  LEFT JOIN device_update_status u ON u.device_id = d.id
                  LEFT JOIN device_control_status c ON c.device_id = d.id
                  LEFT JOIN LATERAL (SELECT max(received_at) AS last_seen
                                       FROM telemetry tm WHERE tm.device_id = d.id) ls ON true
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
                        rs.getString("current_version"),
                        rs.getString("target_version"),
                        rs.getString("state"),
                        rs.getString("target_verdict"),
                        rs.getString("reason"),
                        instant(rs, "reported_at"),
                        instant(rs, "last_seen"),
                        instant(rs, "control_checked_at"),
                        (Boolean) rs.getObject("control_confirmed"),
                        (Boolean) rs.getObject("control_certified")));
    }

    /** Prüft, ob eine Geräte-Id überhaupt existiert (bevor sie ein Ziel bekommt). */
    public Optional<FleetDeviceRow> fleetDevice(UUID deviceId) {
        return fleetDevices().stream().filter(d -> d.deviceId().equals(deviceId)).findFirst();
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
                rs.getString("channel"),
                rs.getBoolean("pinned"),
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
                rs.getString("channel"),
                rs.getString("state"),
                rs.getString("waves"),
                rs.getInt("current_wave"),
                rs.getString("halted_reason"),
                rs.getString("created_by"),
                instant(rs, "created_at"),
                instant(rs, "updated_at"));
    }

    private static RolloutDeviceRow mapRolloutDevice(ResultSet rs, int rowNum) throws SQLException {
        return new RolloutDeviceRow(
                rs.getObject("rollout_id", UUID.class),
                rs.getObject("device_id", UUID.class),
                rs.getInt("wave"),
                rs.getString("state"),
                rs.getString("reason"),
                instant(rs, "since"));
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
