package com.voltpilot.api.repo;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Lebenslauf jeder Box in EINER Liste (Lücke L7, Adminview-Konzept
 * Abschnitt 3.4/4.4): heute vereint die Registrierung nur Aufkleber und
 * Geräte, Anmeldungen und Werkstatt bleiben getrennt. Diese Abfrage bildet
 * jeden Lebensabschnitt - gedruckt, meldet sich (wartet auf Zuordnung), in der
 * Werkstatt, beim Kunden, ausgebaut - in EINER {@code UNION ALL} ab, mit einer
 * festen Rangfolge je {@code external_ref}: eine Box, die inzwischen beim
 * Kunden lief, taucht nicht zusätzlich noch als "gedruckt" auf.
 *
 * <p>Die RLS-Umgehung folgt demselben Muster wie {@link AdminFleetRepository}:
 * BYPASSRLS-Rolle {@code voltpilot_admin}, erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Read-only.
 */
@Repository
public class AdminGeraeteListeRepository {

    private final JdbcTemplate jdbc;

    public AdminGeraeteListeRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /**
     * Eine Box im Lebenslauf. {@code lebensabschnitt} ist eine der fünf Marken
     * ({@code gedruckt}, {@code meldet_sich}, {@code werkstatt}, {@code kunde},
     * {@code ausgebaut}); {@code seit} ist der Zeitpunkt DIESES Abschnitts.
     */
    public record GeraeteListeZeile(String externalRef, String lebensabschnitt, Instant seit,
            UUID deviceId, UUID siteId, UUID tenantId, String tenantName, String name) {
    }

    private static final String QUERY = """
            WITH rang AS (
                SELECT d.external_ref, 'kunde' AS lebensabschnitt, d.created_at AS seit,
                       d.id AS device_id, d.site_id, t.id AS tenant_id, t.name AS tenant_name,
                       d.name, 1 AS prioritaet
                  FROM device d JOIN site s ON s.id = d.site_id JOIN tenant t ON t.id = s.tenant_id
                 WHERE d.ausgebaut_am IS NULL
                UNION ALL
                SELECT d.external_ref, 'ausgebaut', d.ausgebaut_am,
                       d.id, d.site_id, t.id, t.name, d.name, 2
                  FROM device d JOIN site s ON s.id = d.site_id JOIN tenant t ON t.id = s.tenant_id
                 WHERE d.ausgebaut_am IS NOT NULL
                UNION ALL
                SELECT w.edge_ref, 'werkstatt', w.angelegt_am,
                       NULL, NULL, NULL, NULL, NULL, 3
                  FROM werkstatt_box w
                 WHERE NOT EXISTS (SELECT 1 FROM device d WHERE d.external_ref = w.edge_ref)
                UNION ALL
                SELECT e.external_ref, 'meldet_sich', e.csr_updated_at,
                       NULL, NULL, NULL, NULL, NULL, 4
                  FROM device_enrollment e
                 WHERE e.cert_pem IS NULL
                   AND NOT EXISTS (SELECT 1 FROM device d WHERE d.external_ref = e.external_ref)
                   AND NOT EXISTS (SELECT 1 FROM werkstatt_box w WHERE w.edge_ref = e.external_ref)
                UNION ALL
                SELECT p.external_ref, 'gedruckt', p.provisioned_at,
                       NULL, NULL, NULL, NULL, NULL, 5
                  FROM provisioned_device p
                 WHERE NOT EXISTS (SELECT 1 FROM device d WHERE d.external_ref = p.external_ref)
                   AND NOT EXISTS (SELECT 1 FROM werkstatt_box w WHERE w.edge_ref = p.external_ref)
                   AND NOT EXISTS (SELECT 1 FROM device_enrollment e WHERE e.external_ref = p.external_ref)
            )
            SELECT DISTINCT ON (external_ref) external_ref, lebensabschnitt, seit,
                   device_id, site_id, tenant_id, tenant_name, name
              FROM rang
             ORDER BY external_ref, prioritaet
            """;

    /** Jede Box in jedem Lebensabschnitt, nach Referenz sortiert. */
    public List<GeraeteListeZeile> alle() {
        return jdbc.query(QUERY, AdminGeraeteListeRepository::map);
    }

    /**
     * Genau eine Box im Lebenslauf (für die Geräteakte, Lücke L3) - dieselbe
     * Rangfolge wie {@link #alle()}, nur auf EINE Referenz eingeschränkt
     * statt die ganze Plattform zu lesen.
     */
    public Optional<GeraeteListeZeile> eineBox(String externalRef) {
        return jdbc.query("SELECT * FROM (" + QUERY + ") lebenslauf WHERE external_ref = ?",
                AdminGeraeteListeRepository::map, externalRef).stream().findFirst();
    }

    private static GeraeteListeZeile map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        java.sql.Timestamp seit = rs.getTimestamp("seit");
        return new GeraeteListeZeile(
                rs.getString("external_ref"),
                rs.getString("lebensabschnitt"),
                seit == null ? null : seit.toInstant(),
                (UUID) rs.getObject("device_id", UUID.class),
                (UUID) rs.getObject("site_id", UUID.class),
                (UUID) rs.getObject("tenant_id", UUID.class),
                rs.getString("tenant_name"),
                rs.getString("name"));
    }
}
