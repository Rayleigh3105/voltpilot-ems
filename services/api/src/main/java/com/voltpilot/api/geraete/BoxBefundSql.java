package com.voltpilot.api.geraete;

import com.voltpilot.api.geraete.BoxLoesenRegel.BoxBefund;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

/**
 * Die EINE Abfrage des Befunds, geteilt von {@link AdminBoxLoesenRepository} (Admin-Weg, über die
 * Referenz, vor dem Sperren) und {@link BoxLoesenRepository} (unter {@code lockReference}, über die
 * Geräte-ID). {@code JOIN site s}/{@code JOIN tenant t} stehen auch dort, wo nur Telemetrie-Tabellen
 * geprüft werden - derselbe Standort-Zaun-Nachweis wie {@code AdminGeraeteAkteRepository#box}.
 *
 * <p>{@code messwert_am} und {@code meldung_am} sind die SCHNELLEN, erklärbaren Signale für die UI -
 * nicht die einzige Sicherung: {@link BoxLoesenRegel} dokumentiert, warum der ON-DELETE-RESTRICT-
 * Fremdschlüssel auf {@code device} (V20260913150000) die eigentliche Rückversicherung ist.
 */
public final class BoxBefundSql {

    private BoxBefundSql() {
    }

    static final String FELDER = """
            d.id AS device_id, d.tenant_id, d.site_id, t.name AS tenant_name, s.name AS site_name,
            d.external_ref, d.created_at AS verbunden_am,
            d.device_status_seen_at AS herzschlag_am,
            greatest(
                (SELECT max(tl.received_at) FROM telemetry tl WHERE tl.device_id = d.id),
                (SELECT max(tv.received_at) FROM telemetry_v2 tv WHERE tv.device_id = d.id),
                (SELECT max(dm.received_at) FROM device_measurement_sample dm WHERE dm.device_id = d.id)
            ) AS messwert_am,
            greatest(
                (SELECT max(e.reported_at) FROM device_edge_version e WHERE e.device_id = d.id),
                (SELECT max(u.reported_at) FROM device_update_status u WHERE u.device_id = d.id)
            ) AS meldung_am,
            EXISTS (
                SELECT 1 FROM data_source_assignment dsa WHERE dsa.device_id = d.id
                  AND dsa.zurueckgenommen_am IS NULL AND (dsa.effective_to IS NULL OR dsa.effective_to > now())
            ) AS hat_zustaendigkeiten,
            (
                SELECT en.issued_at FROM device_enrollment en
                 WHERE en.external_ref = d.external_ref AND en.device_id = d.id
            ) AS schluessel_abgeholt_am,
            (
                SELECT en.csr_updated_at FROM device_enrollment en WHERE en.external_ref = d.external_ref
            ) AS zuletzt_angefragt_am
            """;

    static final String VON = """
            FROM device d
            JOIN site s ON s.id = d.site_id
            JOIN tenant t ON t.id = s.tenant_id
            """;

    /**
     * Eine Zeile des Befunds, mit den Stammdaten der Box daneben (für die Akte/das Protokoll).
     * {@code zuletztAngefragtAm} (Anmeldung, {@code csr_updated_at}) ist rein informativ - sie fließt
     * NICHT in {@link BoxLoesenRegel}, dieselben Feldnamen wie Box verbinden E2.
     */
    public record Zeile(UUID deviceId, UUID tenantId, UUID siteId, String tenantName, String siteName,
            String externalRef, Instant verbundenAm, Instant zuletztAngefragtAm, BoxBefund befund) {
    }

    public static Zeile zeile(ResultSet rs, int rowNum) throws SQLException {
        return new Zeile(
                rs.getObject("device_id", UUID.class),
                rs.getObject("tenant_id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getString("tenant_name"),
                rs.getString("site_name"),
                rs.getString("external_ref"),
                instant(rs, "verbunden_am"),
                instant(rs, "zuletzt_angefragt_am"),
                new BoxBefund(true, instant(rs, "herzschlag_am"), instant(rs, "messwert_am"),
                        instant(rs, "meldung_am"), rs.getBoolean("hat_zustaendigkeiten"),
                        instant(rs, "schluessel_abgeholt_am")));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
