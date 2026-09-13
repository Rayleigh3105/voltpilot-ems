package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Fleet-overview aggregates for the current tenant. Every query runs through
 * the RLS-scoped app datasource WITHOUT a tenant predicate - RLS (migration V2)
 * fences the tenant, so omitting the site filter aggregates exactly the
 * caller's fleet and never more.
 */
@Repository
public class OverviewRepository {

    /**
     * The device liveness window. MUST stay in sync with the portal's
     * {@code ONLINE_WINDOW_MS} (frontend/portal/src/api.ts): 5 minutes.
     */
    private static final String ONLINE_WINDOW = "5 minutes";

    /** Berlin days for the daily-savings buckets (HistoryRange.ZONE). */
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private final JdbcTemplate jdbc;

    public OverviewRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Per-site device stats, keyed by site id. Sites without devices are absent. */
    public record DeviceStats(int deviceCount, int onlineCount, int waitingCount, Instant lastSeenAt) {
    }

    /** Newest telemetry observation of a site. */
    public record LiveRow(Instant ts, BigDecimal pvKw, BigDecimal loadKw, BigDecimal gridKw,
            BigDecimal socPct) {
    }

    /** One Berlin day of fleet-wide ex-ante savings. */
    public record DailySavings(LocalDate day, BigDecimal savingsEur) {
    }

    /** Fleet-wide Σ battery capacity (kWh) + Σ discharge power (kW); nulls = no battery. */
    public record StorageTotals(BigDecimal capacityKwh, BigDecimal powerKw) {
    }

    /**
     * Per-site v2-entity counts BY entity_type (a measurement_point row with a
     * non-NULL entity_type IS a v2 entity - the EntityRegistryRepository rule).
     * ONE fleet-wide query, RLS-scoped like the rest; the controller maps each
     * entity_type onto its role via the EntityTypeCatalog (the Σ-per-role
     * badge). Sites without entities are absent.
     */
    public Map<UUID, Map<String, Integer>> entityTypeCountsPerSite() {
        Map<UUID, Map<String, Integer>> counts = new HashMap<>();
        jdbc.query(
                "SELECT site_id, entity_type, count(*) AS n FROM measurement_point "
                        + "WHERE entity_type IS NOT NULL GROUP BY site_id, entity_type",
                rs -> {
                    counts.computeIfAbsent(rs.getObject("site_id", UUID.class), k -> new HashMap<>())
                            .put(rs.getString("entity_type"), rs.getInt("n"));
                });
        return counts;
    }

    /**
     * Die Knotentypen der AKTIVEN Flows je Anlage, auf die es hier ankommt: alle
     * {@code vp.strategy.*} (die AE7-Nutzungsprofil-Ableitung) plus den
     * generierten Verbraucher-Executor {@code vp.consumer.reactive} — der EINE
     * Beleg, an dem {@link com.voltpilot.api.profile.AnwendungDerivation} die
     * Anwendung {@code verbraucher} erkennt (Stufe 4: die Flotten-Zeile trägt
     * ihre aktiven Anwendungen).
     *
     * <p>Extracted IN SQL (jsonb): the overview is the portal's landing page and
     * is polled every 30 s, so parsing every active document per request scaled
     * with the fleet size for a handful of node names. One fleet-wide query,
     * RLS-scoped; sites without a matching node are absent. A malformed
     * {@code nodes} (not an array) yields no types instead of an error.
     *
     * <p>Das zusätzliche Wort stört die Nutzungsprofil-Ableitung nicht: sie
     * fragt die Menge nach {@code vp.strategy.peakshaving}/{@code .market}, ein
     * unbeteiligter Typ daneben ist für sie unsichtbar.
     */
    public Map<UUID, Set<String>> activeNodeTypesPerSite() {
        Map<UUID, Set<String>> types = new HashMap<>();
        jdbc.query(
                "SELECT f.site_id, n.value->>'type' AS node_type FROM flow_definition f "
                        + "CROSS JOIN LATERAL jsonb_array_elements("
                        + "  CASE WHEN jsonb_typeof(f.document->'nodes') = 'array' "
                        + "       THEN f.document->'nodes' ELSE '[]'::jsonb END) AS n "
                        + "WHERE f.lifecycle = 'active' AND (n.value->>'type' LIKE 'vp.strategy.%' "
                        + "  OR n.value->>'type' = 'vp.consumer.reactive') "
                        + "ORDER BY f.site_id, node_type",
                rs -> {
                    types.computeIfAbsent(rs.getObject("site_id", UUID.class),
                            k -> new LinkedHashSet<>()).add(rs.getString("node_type"));
                });
        return types;
    }

    /**
     * Die Speicher-Kapazität JE ANLAGE (kWh) — die Gewichte des
     * Portfolio-Ladestands (Stufe 4). Ohne sie wäre „Ø Ladestand" das
     * ungewichtete Mittel über Anlagen, und ein 10-kWh-Haus zöge einen
     * 120-kWh-Betrieb gleich stark — genau das Prozent-Mittel, das die Stufe
     * verbietet. Anlagen ohne Batterie sind ABWESEND (nie eine 0).
     */
    public Map<UUID, BigDecimal> storageCapacityPerSite() {
        Map<UUID, BigDecimal> caps = new HashMap<>();
        jdbc.query(
                "SELECT site_id, sum(capacity_kwh) AS kwh FROM asset "
                        + "WHERE type = 'battery' AND capacity_kwh IS NOT NULL GROUP BY site_id",
                rs -> {
                    BigDecimal kwh = rs.getBigDecimal("kwh");
                    if (kwh != null) {
                        caps.put(rs.getObject("site_id", UUID.class), kwh);
                    }
                });
        return caps;
    }

    /** Die Tagesenergien einer Anlage; jedes Feld einzeln {@code null}-fähig. */
    public record EnergyRow(BigDecimal pvKwh, BigDecimal loadKwh, BigDecimal gridImportKwh,
            BigDecimal gridExportKwh) {
    }

    /**
     * Die Energie-Summen eines Fensters JE ANLAGE, aus {@code telemetry_rollup_15m}
     * (Stufe 4: „Erzeugung heute", „Verbrauch heute", „Netz heute" über die
     * ganze Flotte). Energie DARF man summieren — anders als einen Prozentsatz.
     *
     * <p><b>Die Ehrlichkeit steckt in Postgres' {@code sum()}</b>: es liefert
     * {@code NULL}, wenn nicht eine einzige Viertelstunde diesen Kanal getragen
     * hat — genau die Disziplin von {@code HistoryService.totals} („null, nicht
     * 0, wenn kein Eimer den Kanal trug"). Eine reine Erzeuger-Anlage ohne
     * Netz-Messung liefert deshalb kein erfundenes {@code grid = 0}.
     *
     * <p><b>⚠ Die Rollups hinken ihrem Auffrisch-Takt bis zu 15 Minuten
     * hinterher</b> (Hintergrund-Job, {@code V20260701030000}). Für eine
     * TAGESSUMME ist das richtig — sie soll nicht im Sekundentakt zappeln —,
     * für einen Momentanwert wäre es falsch; der kommt deshalb aus
     * {@link #latestLivePerSite()}.
     *
     * <p>Das Prädikat sitzt auf {@code bucket}, der PARTITIONSSPALTE des
     * Hypertables — ein Tagesfenster liest damit genau einen Chunk (die
     * dokumentierte Lehre „ein Prädikat auf einer Nicht-Partitionsspalte
     * begrenzt das Ergebnis, nicht die gelesenen Chunks").
     */
    public Map<UUID, EnergyRow> energyPerSite(Instant from, Instant to) {
        Map<UUID, EnergyRow> rows = new HashMap<>();
        jdbc.query(
                "SELECT site_id, sum(pv_kwh) AS pv, sum(load_kwh) AS load_, "
                        + "sum(grid_import_kwh) AS imp, sum(grid_export_kwh) AS exp "
                        + "FROM telemetry_rollup_15m WHERE bucket >= ? AND bucket < ? "
                        + "GROUP BY site_id",
                rs -> {
                    rows.put(rs.getObject("site_id", UUID.class),
                            new EnergyRow(rs.getBigDecimal("pv"), rs.getBigDecimal("load_"),
                                    rs.getBigDecimal("imp"), rs.getBigDecimal("exp")));
                },
                Timestamp.from(from), Timestamp.from(to));
        return rows;
    }

    /**
     * Die Anlagen mit einer gepflegten ANSCHLUSSGRENZE — die Voraussetzung des
     * Ladepark-Lastmanagements. Fleet-weit in EINER Abfrage, damit die
     * Ableitungs-Eingabe der Übersicht kein Feld raten muss (ein pauschales
     * {@code false} wäre eine Behauptung über jede Anlage mit Ladepark).
     */
    public Set<UUID> sitesWithGridLimit() {
        Set<UUID> ids = new java.util.HashSet<>();
        jdbc.query(
                "SELECT site_id FROM site_charging_config WHERE grid_limit_kw IS NOT NULL",
                rs -> {
                    ids.add(rs.getObject("site_id", UUID.class));
                });
        return ids;
    }

    /**
     * Fleet-wide Σ battery capacity (kWh) and Σ discharge power (kW) for the
     * portfolio KPI row - from the v1 {@code asset} rows (no new schema).
     * RLS-scoped; both null when the fleet has no battery (never a fake zero).
     */
    public StorageTotals storageTotals() {
        return jdbc.queryForObject(
                "SELECT sum(capacity_kwh) AS kwh, sum(max_discharge_kw) AS kw "
                        + "FROM asset WHERE type = 'battery'",
                (rs, n) -> new StorageTotals(rs.getBigDecimal("kwh"), rs.getBigDecimal("kw")));
    }

    /**
     * Site ids that own a battery asset with NO controlling device (device_id
     * NULL). Such a battery gets a plan but no publish, so the edge never
     * receives a Fahrplan - the portal warns and links to the fix. RLS-scoped,
     * so it only ever reports the caller's own sites.
     */
    public java.util.Set<UUID> sitesWithUnlinkedBattery() {
        java.util.Set<UUID> ids = new java.util.HashSet<>();
        jdbc.query(
                "SELECT DISTINCT site_id FROM asset WHERE type = 'battery' AND device_id IS NULL",
                rs -> {
                    ids.add(rs.getObject("site_id", UUID.class));
                });
        return ids;
    }

    /**
     * Device count / online count / never-seen count / newest arrival per site.
     * Liveness derives from {@code max(received_at)} per device - the ARRIVAL
     * time, never the observation time: a store-and-forward edge replays old
     * observation timestamps while being perfectly online (migration
     * V20260703000000).
     */
    public Map<UUID, DeviceStats> deviceStatsPerSite() {
        Map<UUID, DeviceStats> stats = new HashMap<>();
        jdbc.query(
                "SELECT d.site_id, count(*) AS device_count,"
                        + " count(*) FILTER (WHERE ls.last_seen >= now() - interval '" + ONLINE_WINDOW + "')"
                        + "   AS online_count,"
                        + " count(*) FILTER (WHERE ls.last_seen IS NULL) AS waiting_count,"
                        + " max(ls.last_seen) AS last_seen "
                        + "FROM device d "
                        + "LEFT JOIN LATERAL (SELECT max(received_at) AS last_seen"
                        + "  FROM telemetry t WHERE t.device_id = d.id) ls ON true "
                        + "WHERE d.ausgebaut_am IS NULL "
                        + "GROUP BY d.site_id",
                rs -> {
                    Timestamp lastSeen = rs.getTimestamp("last_seen");
                    stats.put(rs.getObject("site_id", UUID.class), new DeviceStats(
                            rs.getInt("device_count"),
                            rs.getInt("online_count"),
                            rs.getInt("waiting_count"),
                            lastSeen == null ? null : lastSeen.toInstant()));
                });
        return stats;
    }

    /**
     * The newest telemetry row per site (the fleet cards' live snapshot) - a
     * top-1 LATERAL per site so the (site_id, time DESC) index answers it
     * without scanning history. A row of an ausgebaut box (UEMS AP-07 IP-11) stays as history but
     * is no live snapshot - the card shows what the site's boxes report, as before the rows were
     * kept.
     */
    public Map<UUID, LiveRow> latestLivePerSite() {
        Map<UUID, LiveRow> live = new HashMap<>();
        jdbc.query(
                "SELECT s.id AS site_id, t.time, t.pv_power_kw, t.load_kw, t.power_kw, t.soc_pct "
                        + "FROM site s "
                        + "JOIN LATERAL (SELECT x.time, x.pv_power_kw, x.load_kw, x.power_kw, x.soc_pct"
                        + "  FROM telemetry x WHERE x.site_id = s.id AND NOT EXISTS (SELECT 1 FROM device d"
                        + "    WHERE d.id = x.device_id AND d.ausgebaut_am IS NOT NULL)"
                        + "  ORDER BY x.time DESC LIMIT 1) t ON true",
                rs -> {
                    live.put(rs.getObject("site_id", UUID.class), new LiveRow(
                            rs.getTimestamp("time").toInstant(),
                            rs.getBigDecimal("pv_power_kw"),
                            rs.getBigDecimal("load_kw"),
                            rs.getBigDecimal("power_kw"),
                            rs.getBigDecimal("soc_pct")));
                });
        return live;
    }

    /**
     * Wann der Optimierer zuletzt für jede Anlage GERECHNET hat
     * ({@code max(generated_at)} über die persistierten Läufe) - die Spalte
     * „Plan" der Plattform-Übersicht. Sie macht einen toten Optimierer
     * flottenweit sichtbar; der Optimierer plant alle 15 Minuten neu, ein Lauf
     * von vor Stunden ist also selbst die Aussage.
     *
     * <p>Das Fenster {@code generated_at >= from} (die Aufrufer geben wenige
     * Tage) begrenzt das ERGEBNIS - eine Anlage ohne Lauf im Fenster ist
     * ABWESEND, „kein aktueller Plan", nie ein erfundenes Alter.
     *
     * <p><b>⚠ Es begrenzt aber NICHT die gelesenen Chunks, und darauf hat sich
     * dieser Kommentar früher berufen (gemessener Defekt 2026-08-24):</b>
     * {@code schedule} ist auf {@code time} partitioniert, nicht auf
     * {@code generated_at}, ein Prädikat auf {@code generated_at} schliesst also
     * KEINEN Chunk aus - und einen Index auf {@code generated_at} allein gibt es
     * nicht ({@code idx_schedule_site_generated} führt mit {@code site_id}).
     * Fleet-weit ohne {@code site_id}-Bindung las die Form deshalb die GANZE
     * Plan-Historie: auf einem prod-förmigen Klon (1,68 Mio Zeilen, 28 Chunks)
     * <b>335 ms, 75.362 Buffer</b> - der grösste Einzelposten von
     * {@code /overview}. Die per-Anlage-LATERAL-Form gibt jeder Anlage ihre
     * {@code site_id}-Gleichheit, damit {@code idx_schedule_site_generated}
     * greift (B4-Muster, AGENTS.md „Portal-Performance-Welle"): <b>9,0 ms</b>,
     * PRÄDIKAT UNVERÄNDERT, Ergebnis bewiesen gleich (0 Differenzen gegen die
     * alte Form; {@code HotReadRewriteEqualityTest}). Die RLS-Fence wandert
     * dabei von {@code schedule} auf {@code site} - beide tragen dieselbe
     * Mandanten-Policy, also sieht der Aufrufer exakt dieselben Anlagen.
     */
    public Map<UUID, Instant> lastPlanPerSite(Instant from) {
        Map<UUID, Instant> runs = new HashMap<>();
        jdbc.query(
                "SELECT s.id AS site_id, x.last_run FROM site s "
                        + "JOIN LATERAL (SELECT max(sc.generated_at) AS last_run FROM schedule sc "
                        + "  WHERE sc.site_id = s.id AND sc.generated_at >= ?) x ON true",
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
     * Ex-ante battery savings per site over one window, from the persisted
     * optimizer plans: sum(baseline_cost - cost) taking per 15-min slot the
     * LATEST run that planned it (DISTINCT ON - the HistoryRepository.savings
     * semantics, grouped per site). Sites without any priced plan slot in the
     * window are absent (null = "no plan", never a fake zero).
     *
     * <p><b>Per-site LATERAL, not a fleet-wide DISTINCT ON (audit
     * vp-portal-perf-a4, finding B4).</b> A single {@code DISTINCT ON (site_id,
     * time)} with only a {@code time} filter cannot skip-scan
     * {@code idx_schedule_site_time_gen} (V20260809010000): the leading
     * {@code site_id} has no equality bound, so Postgres reads and sorts EVERY
     * candidate (387k rows / 22 MB disk-sort for the 14-day fleet window). Here
     * each site's LATERAL carries {@code site_id = s.id}, giving the equality
     * bound that triggers the per-chunk SkipScan (~1008 rows per site instead).
     * Measured 474 ms -> 17 ms. This is the SAME {@code FROM site s JOIN
     * LATERAL} shape {@link #latestLivePerSite()} and the v2 fanout already use.
     * The result is byte-identical: {@code DISTINCT ON (time)} per site picks
     * the same latest-run-per-slot; the outer NULL filter and {@code GROUP BY}
     * behave exactly as before (a site whose slots are all NULL sums to NULL and
     * is skipped; a site with no rows drops out of the inner join).
     */
    public Map<UUID, BigDecimal> savingsPerSite(Instant from, Instant to) {
        Map<UUID, BigDecimal> savings = new HashMap<>();
        jdbc.query(
                "SELECT s.id AS site_id, sum(x.baseline_cost_eur - x.cost_eur) AS savings "
                        + "FROM site s "
                        + "JOIN LATERAL (SELECT DISTINCT ON (time) baseline_cost_eur, cost_eur"
                        + "  FROM schedule WHERE site_id = s.id AND time >= ? AND time < ?"
                        + "  ORDER BY time, generated_at DESC) x ON true "
                        + "WHERE x.baseline_cost_eur IS NOT NULL AND x.cost_eur IS NOT NULL "
                        + "GROUP BY s.id",
                rs -> {
                    BigDecimal value = rs.getBigDecimal("savings");
                    if (value != null) {
                        savings.put(rs.getObject("site_id", UUID.class), value);
                    }
                },
                Timestamp.from(from), Timestamp.from(to));
        return savings;
    }

    /**
     * Fleet-wide ex-ante savings per Europe/Berlin day (the hero's 14-day mini
     * chart): the same latest-run-per-slot de-duplication, then day buckets.
     * Days without any plan are absent.
     *
     * <p>Per-site LATERAL for the same SkipScan reason as {@link
     * #savingsPerSite} (finding B4): each Anlage's newest run per slot is
     * skip-scanned, then all sites' slots are bucketed by Berlin day and summed
     * across the fleet - byte-identical to the previous fleet-wide DISTINCT ON.
     * Measured 474 ms -> 17 ms.
     */
    public List<DailySavings> dailySavings(Instant from, Instant to) {
        List<DailySavings> days = new ArrayList<>();
        jdbc.query(
                "SELECT time_bucket('1 day', x.time, 'Europe/Berlin') AS day,"
                        + " sum(x.baseline_cost_eur - x.cost_eur) AS savings "
                        + "FROM site s "
                        + "JOIN LATERAL (SELECT DISTINCT ON (time) time, baseline_cost_eur, cost_eur"
                        + "  FROM schedule WHERE site_id = s.id AND time >= ? AND time < ?"
                        + "  ORDER BY time, generated_at DESC) x ON true "
                        + "WHERE x.baseline_cost_eur IS NOT NULL AND x.cost_eur IS NOT NULL "
                        + "GROUP BY 1 ORDER BY 1",
                rs -> {
                    BigDecimal value = rs.getBigDecimal("savings");
                    if (value != null) {
                        days.add(new DailySavings(
                                rs.getTimestamp("day").toInstant().atZone(ZONE).toLocalDate(),
                                value));
                    }
                },
                Timestamp.from(from), Timestamp.from(to));
        return days;
    }
}
