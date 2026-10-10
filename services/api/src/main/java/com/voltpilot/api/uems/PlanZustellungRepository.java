package com.voltpilot.api.uems;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Je Box und Plan „veröffentlicht“ und „angenommen“ (AP-15 IP-10, P3; Tabelle
 * {@code plan_zustellung}, Vertrag docs/contracts/v2/mqtt-plan-result.md). Die api schreibt
 * nur die Quittung; „veröffentlicht“ schreibt der Optimierer nach dem Senden. Beide per
 * Upsert auf (device_id, plan_id), alles unter RLS des aktuellen Mandanten.
 */
@Repository
public class PlanZustellungRepository {

    /** Eine Quittung der Box, wie sie die api annimmt. {@code grund} null bei Annahme. */
    public record Quittung(UUID deviceId, UUID siteId, UUID planId, Instant generatedAt,
            boolean angenommen, String grund, Instant quittiertUm, Instant empfangenUm) {}

    /** Ein Plan einer Box: wann erzeugt, wann veröffentlicht, wann quittiert. */
    public record Plan(UUID planId, Instant generatedAt, Instant veroeffentlichtUm, String urteil,
            String grund, Instant quittiertUm) {}

    /**
     * Veröffentlicht gegen angenommen (Fall R11): der zuletzt veröffentlichte und der zuletzt
     * angenommene Plan einer Box, beide über {@code generated_at} geordnet. Ein Teil ist null,
     * wenn es ihn nicht gibt - bei einer alten Box ohne Quittung ist {@code angenommen} leer.
     */
    public record Stand(Plan veroeffentlicht, Plan angenommen) {}

    private final JdbcTemplate jdbc;

    public PlanZustellungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die aktive, RLS-sichtbare Box; null = unbekannt, ausgebaut oder fremder Mandant. */
    public UUID standortDerAktivenBox(UUID deviceId) {
        List<UUID> rows = jdbc.query("SELECT site_id FROM device WHERE id = ? AND ausgebaut_am IS NULL",
                (rs, n) -> rs.getObject(1, UUID.class), deviceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Schreibt das Urteil. Eine ältere Quittung überschreibt kein jüngeres Urteil derselben
     * Zeile (retained Wiederzustellung, Reihenfolge auf dem Draht); {@code generated_at} und
     * „veröffentlicht“ des Optimierers bleiben stehen.
     */
    public boolean quittieren(UUID tenantId, Quittung q) {
        return jdbc.update("""
                INSERT INTO plan_zustellung (device_id, plan_id, tenant_id, site_id, generated_at,
                        urteil, grund, quittiert_um, empfangen_um)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (device_id, plan_id) DO UPDATE SET
                    generated_at = COALESCE(plan_zustellung.generated_at, EXCLUDED.generated_at),
                    urteil = EXCLUDED.urteil,
                    grund = EXCLUDED.grund,
                    quittiert_um = EXCLUDED.quittiert_um,
                    empfangen_um = EXCLUDED.empfangen_um
                WHERE plan_zustellung.quittiert_um IS NULL
                   OR plan_zustellung.quittiert_um <= EXCLUDED.quittiert_um
                """,
                q.deviceId(), q.planId(), tenantId, q.siteId(), ts(q.generatedAt()),
                q.angenommen() ? "angenommen" : "abgelehnt", q.grund(),
                ts(q.quittiertUm()), ts(q.empfangenUm())) > 0;
    }

    /** Veröffentlicht gegen angenommen für eine Box (Lesemodell für IP-11 und IP-24). */
    public Stand stand(UUID deviceId) {
        return new Stand(
                eins("veroeffentlicht_um IS NOT NULL", deviceId),
                eins("urteil = 'angenommen'", deviceId));
    }

    private Plan eins(String bedingung, UUID deviceId) {
        List<Plan> rows = jdbc.query("SELECT plan_id, generated_at, veroeffentlicht_um, urteil, grund, quittiert_um "
                + "FROM plan_zustellung WHERE device_id = ? AND " + bedingung
                + " ORDER BY generated_at DESC NULLS LAST, COALESCE(veroeffentlicht_um, quittiert_um) DESC LIMIT 1",
                (rs, n) -> new Plan(rs.getObject("plan_id", UUID.class), instant(rs.getTimestamp("generated_at")),
                        instant(rs.getTimestamp("veroeffentlicht_um")), rs.getString("urteil"),
                        rs.getString("grund"), instant(rs.getTimestamp("quittiert_um"))),
                deviceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
