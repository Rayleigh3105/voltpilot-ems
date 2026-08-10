package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das PLATTFORM-Gedächtnis der Steuerungs-Freigabe: das Modell-Register
 * ({@code inverter_control_certification}) und die Scharfschaltung je Gerät
 * ({@code device_control_activation}), Migration V20260814000000.
 *
 * <p><b>Die RLS-Umgehung ist ÜBERNOMMEN, nicht neu erfunden</b>: dieselbe
 * dedizierte {@code adminJdbcTemplate}-Verbindung als BYPASSRLS-Rolle
 * {@code voltpilot_admin} wie {@link RolloutRepository} und
 * {@link AdminFleetRepository}, erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Beide Tabellen
 * sind mandantenfrei (Plattform-Betriebsdaten); die App-Rolle hat hier bewusst
 * gar kein Recht.
 *
 * <p>Marke/Modell/Familie werden KLEIN GESCHRIEBEN gespeichert und verglichen -
 * das Gerät vergleicht ohnehin ohne Rücksicht auf Groß-/Kleinschreibung, und so
 * ist der Unique-Index die echte Aussage „dieses Modell steht genau einmal
 * drin" statt einer, die sich mit einer Umschaltung aushebeln lässt.
 */
@Repository
public class ControlCertificationRepository {

    private final JdbcTemplate jdbc;

    public ControlCertificationRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Ein Register-Eintrag: „Modell X ist steuerungs-zertifiziert." */
    public record Certification(UUID id, String brand, String model, String family,
            String controlPath, Boolean invertControlSign, Instant certifiedAt,
            String firmwareNote, String note, Instant createdAt, String createdBy) {
    }

    /** Die Scharfschaltung eines Geräts, angereichert um seine Identität. */
    public record Activation(UUID deviceId, UUID tenantId, UUID siteId, String siteName,
            String tenantName, String externalRef, Instant activatedAt, String activatedBy,
            String note) {
    }

    private static final String CERT_SELECT = """
            SELECT id, brand, model, family, control_path, invert_control_sign,
                   certified_at, firmware_note, note, created_at, created_by
              FROM inverter_control_certification
            """;

    /** Das ganze Register, neueste Zertifizierung zuerst. */
    public List<Certification> listCertifications() {
        return jdbc.query(CERT_SELECT + " ORDER BY certified_at DESC, model ASC",
                ControlCertificationRepository::mapCert);
    }

    public Optional<Certification> findCertification(String brand, String model) {
        return jdbc.query(CERT_SELECT + " WHERE brand = ? AND model = ?",
                ControlCertificationRepository::mapCert, norm(brand), norm(model))
                .stream().findFirst();
    }

    /**
     * Trägt ein Modell ein. Ein bereits vorhandenes Modell wird NICHT still
     * überschrieben - der Aufrufer entscheidet (der Controller antwortet 409),
     * weil ein zweiter Eintrag zwei Wahrheiten über dasselbe Produkt wären.
     *
     * @return false, wenn das Modell schon im Register steht
     */
    public boolean insertCertification(Certification c) {
        int n = jdbc.update("""
                INSERT INTO inverter_control_certification
                    (id, brand, model, family, control_path, invert_control_sign,
                     certified_at, firmware_note, note, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT (brand, model) DO NOTHING
                """,
                ps -> {
                    ps.setObject(1, c.id());
                    ps.setString(2, norm(c.brand()));
                    ps.setString(3, norm(c.model()));
                    ps.setString(4, norm(c.family()));
                    ps.setString(5, c.controlPath());
                    if (c.invertControlSign() == null) {
                        ps.setNull(6, Types.BOOLEAN);
                    } else {
                        ps.setBoolean(6, c.invertControlSign());
                    }
                    ps.setTimestamp(7, Timestamp.from(c.certifiedAt()));
                    ps.setString(8, c.firmwareNote());
                    ps.setString(9, c.note());
                    ps.setString(10, c.createdBy());
                });
        return n > 0;
    }

    /** Nimmt ein Modell aus dem Register. */
    public boolean deleteCertification(String brand, String model) {
        return jdbc.update("DELETE FROM inverter_control_certification WHERE brand = ? AND model = ?",
                norm(brand), norm(model)) > 0;
    }

    // ── Scharfschaltung ───────────────────────────────────────────────────

    private static final String ACTIVATION_SELECT = """
            SELECT a.device_id, d.tenant_id, d.site_id, s.name AS site_name,
                   t.name AS tenant_name, d.external_ref,
                   a.activated_at, a.activated_by, a.note
              FROM device_control_activation a
              JOIN device d ON d.id = a.device_id
              JOIN site   s ON s.id = d.site_id
              JOIN tenant t ON t.id = d.tenant_id
            """;

    public List<Activation> listActivations() {
        return jdbc.query(ACTIVATION_SELECT + " ORDER BY a.activated_at DESC",
                ControlCertificationRepository::mapActivation);
    }

    public Optional<Activation> findActivation(UUID deviceId) {
        return jdbc.query(ACTIVATION_SELECT + " WHERE a.device_id = ?",
                ControlCertificationRepository::mapActivation, deviceId).stream().findFirst();
    }

    /** Schaltet ein Gerät scharf (idempotent - ein zweiter Klick ändert nichts). */
    public void activate(UUID deviceId, String actor, String note) {
        jdbc.update("""
                INSERT INTO device_control_activation (device_id, activated_by, note)
                VALUES (?,?,?)
                ON CONFLICT (device_id) DO NOTHING
                """, deviceId, actor, note);
    }

    /** Nimmt die Scharfschaltung zurück. */
    public boolean deactivate(UUID deviceId) {
        return jdbc.update("DELETE FROM device_control_activation WHERE device_id = ?", deviceId) > 0;
    }

    /** Die Identität JEDES beanspruchten Geräts - die Empfänger des Downlinks. */
    public record DeviceIdentity(UUID deviceId, UUID tenantId, UUID siteId, boolean activated) {
    }

    /**
     * Jedes beanspruchte Gerät mit der Frage „ist es scharfgeschaltet?".
     *
     * <p>Das Dokument geht bewusst an JEDES Gerät, nicht nur an die
     * scharfgeschalteten: nur so kann eine Box den Unterschied zwischen
     * „Modell nicht zertifiziert" und „zertifiziert, aber nicht scharf" selbst
     * berichten - und genau diese Unterscheidung ist es, die dem Portal bisher
     * gefehlt hat. Ein Dokument mit {@code activated:false} steuert nichts.
     */
    public List<DeviceIdentity> allClaimedDevices() {
        return jdbc.query("""
                SELECT d.id, d.tenant_id, d.site_id,
                       (a.device_id IS NOT NULL) AS activated
                  FROM device d
                  LEFT JOIN device_control_activation a ON a.device_id = d.id
                 ORDER BY d.id
                """, (rs, i) -> new DeviceIdentity(
                        rs.getObject("id", UUID.class),
                        rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getBoolean("activated")));
    }

    /** Die Identität EINES Geräts (oder leer, wenn es nicht existiert). */
    public Optional<DeviceIdentity> claimedDevice(UUID deviceId) {
        return jdbc.query("""
                SELECT d.id, d.tenant_id, d.site_id,
                       (a.device_id IS NOT NULL) AS activated
                  FROM device d
                  LEFT JOIN device_control_activation a ON a.device_id = d.id
                 WHERE d.id = ?
                """, (rs, i) -> new DeviceIdentity(
                        rs.getObject("id", UUID.class),
                        rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getBoolean("activated")), deviceId).stream().findFirst();
    }

    private static Certification mapCert(ResultSet rs, int rowNum) throws SQLException {
        Boolean sign = rs.getObject("invert_control_sign") == null ? null
                : rs.getBoolean("invert_control_sign");
        return new Certification(
                rs.getObject("id", UUID.class),
                rs.getString("brand"), rs.getString("model"), rs.getString("family"),
                rs.getString("control_path"), sign,
                rs.getTimestamp("certified_at").toInstant(),
                rs.getString("firmware_note"), rs.getString("note"),
                rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"));
    }

    private static Activation mapActivation(ResultSet rs, int rowNum) throws SQLException {
        return new Activation(
                rs.getObject("device_id", UUID.class),
                rs.getObject("tenant_id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getString("site_name"), rs.getString("tenant_name"),
                rs.getString("external_ref"),
                rs.getTimestamp("activated_at").toInstant(),
                rs.getString("activated_by"), rs.getString("note"));
    }

    /** Katalog-Bezeichner werden normalisiert gespeichert und verglichen. */
    public static String norm(String v) {
        return v == null ? null : v.trim().toLowerCase(Locale.ROOT);
    }
}
