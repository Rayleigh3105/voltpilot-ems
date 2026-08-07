package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Rohzahlen hinter den Betriebs-Metriken ({@code com.voltpilot.api.metrics}):
 * je Anlage der jüngste Optimierer-Lauf und die jüngste Mess-ANKUNFT, je
 * Gebotszone die bepreiste Vorschau. <b>Nur Lesepfade</b> - hier gibt es keine
 * einzige schreibende Abfrage.
 *
 * <p><b>Warum die BYPASSRLS-Rolle, und warum das hier richtig ist.</b> Anders als
 * {@link OverviewRepository}, dessen Abfragen dieselbe Form haben, läuft diese
 * Sammlung NICHT in einer Anfrage: sie hängt an einem Zeitgeber, hat also keinen
 * {@code TenantContext} - unter der mandantenbezogenen Datenquelle wäre das
 * Ergebnis nach der RLS-Grundregel schlicht LEER (kein Mandant gesetzt =
 * default-deny), und die Metriken meldeten „keine Anlage", während die Flotte
 * läuft. Es ist ausserdem der Sache nach ein mandantenübergreifender
 * Plattform-Blick, genau wie {@code /admin/fleet}. Also dieselbe Disziplin wie
 * dort: {@code @Qualifier("adminJdbcTemplate")} an der dedizierten
 * {@code voltpilot_admin}-Rolle, der {@code @Primary}-Pfad der Kunden bleibt
 * unberührt. Neue Rechte braucht es nicht - {@code V4} und
 * {@code V20260702030000} haben dieser Rolle {@code SELECT} auf {@code site},
 * {@code device}, {@code telemetry}, {@code schedule} und
 * {@code day_ahead_prices} längst erteilt.
 */
@Repository
public class FleetMetricsRepository {

    private final JdbcTemplate admin;

    public FleetMetricsRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    /** Eine Anlage, wie die Metrik sie kennt: Kennung, Mandant, Gebotszone. */
    public record SiteRow(UUID siteId, UUID tenantId, String biddingZone) {
    }

    /**
     * Jede Anlage der Plattform. Auch die Zonen-Metrik hängt hieran: nur weil wir
     * die Gebotszonen AUS DER FLOTTE lesen, kann eine Zone ohne einen einzigen
     * Preis überhaupt eine Zeile bekommen - und genau diese Zeile ({@code 0})
     * ist der Vorfall vom 06./07.08.2026.
     */
    public List<SiteRow> sites() {
        List<SiteRow> sites = new ArrayList<>();
        admin.query(
                "SELECT id, tenant_id, bidding_zone FROM site ORDER BY id",
                rs -> {
                    sites.add(new SiteRow(
                            rs.getObject("id", UUID.class),
                            rs.getObject("tenant_id", UUID.class),
                            rs.getString("bidding_zone")));
                });
        return sites;
    }

    /**
     * Jüngster Optimierer-Lauf je Anlage INNERHALB des Fensters - die Form von
     * {@code OverviewRepository.lastPlanPerSite}, samt ihrer Begründung: ohne die
     * Untergrenze wäre es ein Scan über die ganze Plan-Historie. Eine Anlage ohne
     * Lauf im Fenster ist ABWESEND (nie ein erfundenes Alter); ob sie je einen
     * hatte, beantwortet {@link #sitesThatEverPlanned()}.
     */
    public Map<UUID, Instant> lastPlanPerSite(Instant from) {
        Map<UUID, Instant> runs = new HashMap<>();
        admin.query(
                "SELECT site_id, max(generated_at) AS last_run FROM schedule "
                        + "WHERE generated_at >= ? GROUP BY site_id",
                rs -> {
                    Timestamp last = rs.getTimestamp("last_run");
                    if (last != null) {
                        runs.put(rs.getObject("site_id", UUID.class), last.toInstant());
                    }
                },
                Timestamp.from(from));
        return runs;
    }

    /**
     * Anlagen, für die überhaupt je ein Plan gespeichert wurde - die eine
     * Auskunft, die das Fenster oben nicht geben kann, und ohne die „noch nie
     * geplant" und „seit über einer Woche nicht mehr geplant" ununterscheidbar
     * blieben.
     *
     * <p>Bewusst ein {@code EXISTS} und kein fensterloses {@code max(...) GROUP
     * BY}: das Prädikat greift {@code idx_schedule_site_generated (site_id,
     * generated_at DESC)}, und der Planer darf beim ERSTEN Treffer aufhören -
     * ein fensterloses Aggregat müsste dagegen jede Zeile jedes Chunks lesen.
     */
    public Set<UUID> sitesThatEverPlanned() {
        Set<UUID> ids = new HashSet<>();
        admin.query(
                "SELECT s.id FROM site s "
                        + "WHERE EXISTS (SELECT 1 FROM schedule sc WHERE sc.site_id = s.id)",
                rs -> {
                    ids.add(rs.getObject("id", UUID.class));
                });
        return ids;
    }

    /**
     * Jüngste ANKUNFT einer Messung je Anlage.
     *
     * <p><b>{@code max(received_at)}, niemals {@code max(time)}</b> - die
     * Hausregel der Lebendigkeit (Migration {@code V20260703000000}): eine Edge
     * mit Zwischenspeicher spielt nach einem Ausfall alte BEOBACHTUNGS-Zeitstempel
     * nach, während sie einwandfrei sendet; ein Alarm auf {@code time} hielte
     * genau das für „verstummt". Die Form ist die von {@code
     * OverviewRepository.deviceStatsPerSite}: je Gerät ein LATERAL auf
     * {@code idx_telemetry_device_received (device_id, received_at DESC)},
     * darüber das Maximum je Anlage. Eine Anlage ohne Gerät oder ohne je eine
     * Messung ist ABWESEND.
     */
    public Map<UUID, Instant> lastTelemetryPerSite() {
        Map<UUID, Instant> seen = new HashMap<>();
        admin.query(
                "SELECT d.site_id, max(ls.last_seen) AS last_seen FROM device d "
                        + "LEFT JOIN LATERAL (SELECT max(received_at) AS last_seen"
                        + "  FROM telemetry t WHERE t.device_id = d.id) ls ON true "
                        + "GROUP BY d.site_id",
                rs -> {
                    Timestamp last = rs.getTimestamp("last_seen");
                    if (last != null) {
                        seen.put(rs.getObject("site_id", UUID.class), last.toInstant());
                    }
                });
        return seen;
    }

    /**
     * Die bepreisten Viertelstunden-ANFÄNGE je Gebotszone im Fenster
     * {@code [from, to)} - die Zusammenhangs-Prüfung macht {@code
     * FleetMetrics.contiguousPricedSlots} daraus, damit sie ohne Datenbank
     * prüfbar bleibt.
     *
     * <p>Gebaut auf {@link PriceSlots} - der EINEN, index-freundlichen Preisreihe
     * dieses Pakets; eine zweite Preis-Abfrage würde genau den 1,2-s-LATERAL
     * wieder einführen, den sie abgelöst hat. Der Zonen-Filter dort ist
     * {@code IN (SELECT bidding_zone FROM site)} und damit RLS-RELATIV: unter der
     * Kundenquelle sind es die Zonen des Mandanten, unter der Admin-Rolle hier
     * die der ganzen Flotte - dieselbe Abfrage, die richtige Menge.
     *
     * <p>Das Fenster ist auf {@code FleetMetrics.HORIZON_SLOTS} begrenzt, es
     * kommen also höchstens 96 Zeilen je Zone zurück.
     */
    public Map<String, List<Instant>> pricedSlotsPerZone(Instant from, Instant to) {
        Map<String, List<Instant>> slots = new LinkedHashMap<>();
        admin.query(
                "WITH " + PriceSlots.forTenantZones()
                        + "SELECT bidding_zone, slot FROM price_slot "
                        + "WHERE slot >= ? AND slot < ? ORDER BY bidding_zone, slot",
                rs -> {
                    slots.computeIfAbsent(rs.getString("bidding_zone"), k -> new ArrayList<>())
                            .add(rs.getTimestamp("slot").toInstant());
                },
                Timestamp.from(from), Timestamp.from(to),
                Timestamp.from(from), Timestamp.from(to));
        return slots;
    }
}
