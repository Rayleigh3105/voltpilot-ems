package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ControlStatusDto;
import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die CROSS-TENANT Lesequellen des Flotten-Pulses (Admin-Umbau Stufe 2, der EINE
 * {@code GET /api/v1/admin/fleet}).
 *
 * <p><b>Die RLS-Umgehung folgt exakt dem Muster, das {@link TenantRepository} und
 * {@link AdminSiteRepository} vorgeben</b> und erfindet nichts Neues: dieselbe
 * dedizierte {@code adminJdbcTemplate}-Verbindung als BYPASSRLS-Rolle
 * {@code voltpilot_admin}, erreichbar AUSSCHLIESSLICH aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Der
 * {@code @Primary} mandantenbezogene Pfad bleibt unberührt - die beiden
 * Datenquellen vermischen sich nie.
 *
 * <p><b>Read-only, mit Absicht.</b> Diese Klasse hat keinen einzigen Schreibpfad;
 * jede Änderung an Kundendaten läuft weiter über die vorhandenen Wege (die
 * RLS-gefencten Kunden-Endpunkte bzw. die schmalen Admin-Schreibrouten).
 *
 * <p>Jede Abfrage ist ein GRUPPIERTES Aggregat über die ganze Plattform und
 * liefert eine Map je Anlagen-Id - genau die Form, die
 * {@link OverviewRepository} je Mandant liefert. Eine Anlage ohne Zeile ist
 * ABWESEND: „nicht gemessen" ist ein anderer Zustand als „null", und die
 * Oberfläche muss ihn anders zeigen.
 */
@Repository
public class AdminFleetRepository {

    /**
     * Das Lebendigkeits-Fenster der Geräte. MUSS mit
     * {@link OverviewRepository} und dem Portal ({@code ONLINE_WINDOW_MS} in
     * {@code api.ts}) synchron bleiben: 5 Minuten.
     */
    private static final String ONLINE_WINDOW = "5 minutes";

    private final JdbcTemplate jdbc;

    public AdminFleetRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Eine Anlage samt ihrem Mandanten - die Zeilenbasis des Pulses. */
    public record FleetSiteRow(UUID siteId, String siteName, UUID tenantId, String tenantName,
            String plantKind, boolean netzladenErlaubt, String tarifArt) {
    }

    /** Geräte-Zustand einer Anlage (identische Semantik wie im Overview). */
    public record DeviceStats(int deviceCount, int onlineCount, int waitingCount,
            Instant lastSeenAt) {
    }

    /** Der gemeldete Software-Stand des zuletzt meldenden Geräts einer Anlage. */
    public record EdgeVersionRow(String coreVersion, String paletteVersion, Instant reportedAt) {
    }

    /** Der gemeldete OTA-Stand des zuletzt meldenden Geräts einer Anlage. */
    public record UpdateStatusRow(String version, String backend, String currentVersion,
            String targetVersion, String state, String reason, String lastKnownGood,
            Instant reportedAt) {
    }

    /** Ein Eintrag des Release-Registers - {@code releaseSeq} ist DIE Ordnung. */
    public record EdgeReleaseRow(long releaseSeq, String version) {
    }

    /** Die vom Gerät gemeldete Quellen-Gesundheit, gezählt. */
    public record SourceCounts(int total, int ok, int stale, int never) {
    }

    /** Gemessene PV-Spitze einer Anlage im Nachschau-Fenster. */
    public record PvPeak(BigDecimal peakKw, long buckets) {
    }

    /** Ein Prognose-Messwert einer Anlage (je Prognoseart). */
    public record ForecastRow(UUID siteId, String kind, double nmaePct, int days) {
    }

    /** Alle Anlagen aller Mandanten, Mandant vor Anlage sortiert. */
    public List<FleetSiteRow> sites() {
        return jdbc.query(
                "SELECT s.id AS site_id, s.name AS site_name, s.plant_kind, s.netzladen_erlaubt, "
                        + "s.tarif_art, t.id AS tenant_id, t.name AS tenant_name "
                        + "FROM site s JOIN tenant t ON t.id = s.tenant_id "
                        + "ORDER BY t.name, s.name",
                (rs, i) -> new FleetSiteRow(
                        rs.getObject("site_id", UUID.class),
                        rs.getString("site_name"),
                        rs.getObject("tenant_id", UUID.class),
                        rs.getString("tenant_name"),
                        rs.getString("plant_kind"),
                        rs.getBoolean("netzladen_erlaubt"),
                        rs.getString("tarif_art")));
    }

    /**
     * Geräte-Zahlen je Anlage. Lebendigkeit hängt an {@code max(received_at)} -
     * der ANKUNFT, nie am Beobachtungszeitpunkt: eine Edge, die ihren Puffer
     * nachspielt, trägt stundenalte Beobachtungszeiten und ist trotzdem online
     * (Migration V20260703000000). Wortgleich mit
     * {@link OverviewRepository#deviceStatsPerSite()} - dieselbe Frage, dieselbe
     * Antwort, nur ohne Mandanten-Zaun.
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
     * Wann der Optimierer je Anlage zuletzt gerechnet hat. Das Fenster ist
     * BEWUSST begrenzt (die Aufrufer geben wenige Tage): ohne Untergrenze wäre
     * es ein Scan über die ganze Plan-Historie des Hypertables. Eine Anlage ohne
     * Lauf im Fenster ist abwesend - „kein aktueller Plan", nie ein erfundenes
     * Alter.
     */
    public Map<UUID, Instant> lastPlanPerSite(Instant from) {
        Map<UUID, Instant> runs = new HashMap<>();
        jdbc.query(
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
     * Der jüngste Steuerungs-Beleg je Anlage - dieselbe Zeile, die
     * {@link ControlStatusRepository#latestForSite} je Anlage liefert, nur
     * flottenweit in EINER Abfrage ({@code DISTINCT ON}).
     */
    public Map<UUID, ControlStatusDto> controlPerSite() {
        Map<UUID, ControlStatusDto> out = new HashMap<>();
        jdbc.query(
                "SELECT DISTINCT ON (site_id) site_id, device_id, commanded_kw, confirmed_kw, "
                        + "all_match, control_enabled, certified, mismatch_roles, slot_start, "
                        + "checked_at, control_source, execution_mode, execution_direction, "
                        + "execution_planned_kw, execution_target_kw, cert_source, platform_cert_verdict, "
                        + "platform_cert_model, platform_cert_reason "
                        + "FROM device_control_status ORDER BY site_id, checked_at DESC",
                rs -> {
                    Timestamp slotStart = rs.getTimestamp("slot_start");
                    out.put(rs.getObject("site_id", UUID.class), new ControlStatusDto(
                            rs.getObject("device_id", UUID.class),
                            (Double) rs.getObject("commanded_kw"),
                            (Double) rs.getObject("confirmed_kw"),
                            rs.getBoolean("all_match"),
                            rs.getBoolean("control_enabled"),
                            rs.getBoolean("certified"),
                            rs.getString("mismatch_roles"),
                            slotStart == null ? null : slotStart.toInstant(),
                            rs.getTimestamp("checked_at").toInstant(),
                            rs.getString("control_source"),
                            rs.getString("execution_mode"),
                            rs.getString("execution_direction"),
                            (Double) rs.getObject("execution_planned_kw"),
                            (Double) rs.getObject("execution_target_kw"),
                            rs.getString("cert_source"),
                            rs.getString("platform_cert_verdict"),
                            rs.getString("platform_cert_model"),
                            rs.getString("platform_cert_reason")));
                });
        return out;
    }

    /**
     * Der jüngste Abregel-Beleg je Anlage - inklusive des Einspeisewächters und
     * der geräte-eigenen Einspeisegrenze („Grenzen &amp; Wächter" Stufe 0).
     * {@code all_match} bleibt DREIWERTIG ({@code getObject(..., Boolean.class)}):
     * „nichts angewandt" darf nie als „das Rücklesen widersprach" gelesen werden.
     *
     * <p>Gelesen und abgebildet über {@link CurtailmentStatusRepository#COLUMNS}
     * / {@code map} (dasselbe Paket): die Flotten-Sicht und der Anlagen-Lesepfad
     * dürfen über DIESELBE Zeile nicht Verschiedenes behaupten.
     */
    public Map<UUID, CurtailmentStatusDto> curtailmentPerSite() {
        Map<UUID, CurtailmentStatusDto> out = new HashMap<>();
        jdbc.query(
                "SELECT DISTINCT ON (site_id) site_id, " + CurtailmentStatusRepository.COLUMNS
                        + " FROM device_curtailment_status ORDER BY site_id, checked_at DESC",
                rs -> {
                    out.put(rs.getObject("site_id", UUID.class),
                            CurtailmentStatusRepository.map(rs));
                });
        return out;
    }

    /**
     * Der zuletzt gemeldete Edge-Stand je Anlage. <b>Keine Zeile heißt
     * „unbekannt", nie „veraltet"</b>: die Edge baut den {@code flows}-Block des
     * Herzschlags erst nach ihrem ersten Deployment-Satz, ein Gerät ohne
     * ausgerollte Automation meldet also gar keine Version.
     */
    public Map<UUID, EdgeVersionRow> edgeVersionPerSite() {
        Map<UUID, EdgeVersionRow> out = new HashMap<>();
        jdbc.query(
                "SELECT DISTINCT ON (site_id) site_id, core_version, palette_version, reported_at "
                        + "FROM device_edge_version ORDER BY site_id, reported_at DESC",
                rs -> {
                    out.put(rs.getObject("site_id", UUID.class), new EdgeVersionRow(
                            rs.getString("core_version"),
                            rs.getString("palette_version"),
                            rs.getTimestamp("reported_at").toInstant()));
                });
        return out;
    }

    /**
     * Der zuletzt gemeldete OTA-Stand je Anlage (Stufe 0). Er steht NEBEN
     * {@link #edgeVersionPerSite()}, nicht darin: die Version reist hier
     * TOP-LEVEL im Herzschlag und damit unabhängig vom {@code flows}-Block -
     * genau deshalb sieht diese Abfrage auch die Geräte, auf denen nie eine
     * Automation ausgerollt wurde (das Loch, das Stufe 0 schließt). Beide
     * Blöcke haben ihren eigenen Frische-Anker, und keine Zeile heißt
     * weiterhin „unbekannt", nie „veraltet".
     */
    public Map<UUID, UpdateStatusRow> updateStatusPerSite() {
        Map<UUID, UpdateStatusRow> out = new HashMap<>();
        jdbc.query(
                "SELECT DISTINCT ON (site_id) site_id, version, backend, current_version, "
                        + "target_version, state, reason, last_known_good, reported_at "
                        + "FROM device_update_status ORDER BY site_id, reported_at DESC",
                rs -> {
                    out.put(rs.getObject("site_id", UUID.class), new UpdateStatusRow(
                            rs.getString("version"),
                            rs.getString("backend"),
                            rs.getString("current_version"),
                            rs.getString("target_version"),
                            rs.getString("state"),
                            rs.getString("reason"),
                            rs.getString("last_known_good"),
                            rs.getTimestamp("reported_at").toInstant()));
                });
        return out;
    }

    /**
     * Das Release-Register, NEUESTE zuerst - der Maßstab der ganzen Flotte.
     * Der ERSTE Eintrag ist der Soll-Stand; die Liste selbst wird gebraucht,
     * um einen gemeldeten Versionsstring überhaupt EINORDNEN zu können (ein
     * Stand, den das Register nicht kennt, ist „nicht registriert" und
     * ausdrücklich nicht „veraltet"). Leeres Register = kein Maßstab = es wird
     * nichts als veraltet behauptet.
     */
    public List<EdgeReleaseRow> releases() {
        return jdbc.query(
                "SELECT release_seq, version FROM edge_release ORDER BY release_seq DESC",
                (rs, i) -> new EdgeReleaseRow(rs.getLong("release_seq"), rs.getString("version")));
    }

    /**
     * Die vom Gerät gemeldeten Quellen je Anlage, nach Gesundheit gezählt -
     * dieselbe Grundlage wie {@code GET /api/v1/sites/{id}/sources}, nur
     * aggregiert. Eine Anlage ohne Meldung ist abwesend („keine Meldung"), nie
     * „0 gesund".
     */
    public Map<UUID, SourceCounts> sourceCountsPerSite() {
        Map<UUID, SourceCounts> out = new HashMap<>();
        jdbc.query(
                "SELECT site_id, count(*) AS total, "
                        + "count(*) FILTER (WHERE health = 'ok') AS ok_n, "
                        + "count(*) FILTER (WHERE health = 'stale') AS stale_n, "
                        + "count(*) FILTER (WHERE health NOT IN ('ok', 'stale')) AS never_n "
                        + "FROM device_source_status GROUP BY site_id",
                rs -> {
                    out.put(rs.getObject("site_id", UUID.class), new SourceCounts(
                            rs.getInt("total"), rs.getInt("ok_n"), rs.getInt("stale_n"),
                            rs.getInt("never_n")));
                });
        return out;
    }

    /**
     * Anlagen mit einem Speicher-Asset OHNE steuerndes Gerät. Ein solcher
     * Speicher bekommt einen Plan, der nie veröffentlicht wird - das Prädikat
     * ist wortgleich mit {@link OverviewRepository#sitesWithUnlinkedBattery()},
     * damit Puls und Kunden-Übersicht dasselbe behaupten.
     */
    public Set<UUID> sitesWithUnlinkedBattery() {
        Set<UUID> ids = new HashSet<>();
        jdbc.query("SELECT DISTINCT site_id FROM asset WHERE type = 'battery' AND device_id IS NULL",
                rs -> {
                    ids.add(rs.getObject("site_id", UUID.class));
                });
        return ids;
    }

    /** Anlagen mit einem Speicher-Asset (egal ob verknüpft). */
    public Set<UUID> sitesWithBattery() {
        Set<UUID> ids = new HashSet<>();
        jdbc.query("SELECT DISTINCT site_id FROM asset WHERE type = 'battery'", rs -> {
            ids.add(rs.getObject("site_id", UUID.class));
        });
        return ids;
    }

    /**
     * Die gepflegte PV-Nennleistung je Anlage. Gelesen wird das PRIMÄRE
     * PV-Asset ({@code is_primary}) - es IST die Anlagen-Summe (die kWp
     * zusätzlicher Erzeuger werden dort aufaddiert); die Lockstep-Regel für
     * v1-Asset-Leser gilt hier genauso.
     */
    public Map<UUID, BigDecimal> pvCapacityPerSite() {
        Map<UUID, BigDecimal> out = new HashMap<>();
        jdbc.query(
                "SELECT site_id, pv_capacity_kwp FROM asset "
                        + "WHERE type = 'pv' AND is_primary AND pv_capacity_kwp IS NOT NULL",
                rs -> {
                    out.put(rs.getObject("site_id", UUID.class), rs.getBigDecimal("pv_capacity_kwp"));
                });
        return out;
    }

    /**
     * Die gemessene PV-Spitze je Anlage aus den 15-Minuten-Rollups:
     * {@code max(pv_kwh) * 4} = die höchste Viertelstunden-MITTELLEISTUNG des
     * Fensters. Bewusst das Rollup und nicht die rohe Telemetrie - eine
     * Einzelspitze über wenige Sekunden ist kein Anlagen-Fakt, und der Rollup
     * kostet je Anlage 96 Zeilen am Tag statt Tausender.
     *
     * <p>{@code buckets} zählt die Viertelstunden MIT PV-Wert; ohne genug davon
     * darf niemand über Plausibilität urteilen (die Lücke wird benannt).
     */
    public Map<UUID, PvPeak> pvPeakPerSite(Instant from) {
        Map<UUID, PvPeak> out = new HashMap<>();
        jdbc.query(
                "SELECT site_id, max(pv_kwh) * 4 AS peak_kw, "
                        + "count(*) FILTER (WHERE pv_kwh IS NOT NULL) AS buckets "
                        + "FROM telemetry_rollup_15m WHERE bucket >= ? GROUP BY site_id",
                rs -> {
                    out.put(rs.getObject("site_id", UUID.class), new PvPeak(
                            rs.getBigDecimal("peak_kw"), rs.getLong("buckets")));
                },
                Timestamp.from(from));
        return out;
    }

    /**
     * Die Prognosequalität je Anlage und Prognoseart über das Fenster: der
     * Mittelwert des normierten Fehlers ({@code nmae_pct}) des Modells, das
     * DIESE Anlage wirklich plant.
     *
     * <p>Normiert, weil nur er über verschieden große Anlagen vergleichbar ist -
     * ein MAE in kW wächst mit der Anlage. {@code nmae_pct} ist an
     * Null-Tagen NULL (dokumentiert in der Auswertung) und wird deshalb
     * übersprungen statt als 0 gewertet; eine Anlage ohne einen einzigen
     * bewerteten Tag ist abwesend.
     *
     * <p><b>⚠ Das aktive Modell wird JE ANLAGE aufgelöst, in EINER Abfrage</b>
     * (Captain-Auftrag 19.08.2026): seit dem Anlagen-Schalter können zwei
     * Anlagen derselben Flotte legitim verschieden planen, und ein
     * flottenweiter Filter würde eine von ihnen mit dem Fehler ihres
     * SCHATTEN-Modells in den Ausreißer-Vergleich schicken. Die Präzedenz ist
     * dieselbe wie überall - Anlagen-Wahl &gt; Plattform-Vorgabe &gt;
     * Umgebungs-Vorgabe (die der Aufrufer als {@code envModels} übergibt) -,
     * nur hier als {@code COALESCE} über die zwei append-only Journale statt in
     * Java, damit es bei N Anlagen bei EINER Abfrage bleibt. Eine von Hand
     * eingetragene, unbekannte Id findet dann schlicht keine Zeilen: die Anlage
     * ist abwesend, nie mit einer fremden Zahl vertreten.
     */
    public List<ForecastRow> forecastAccuracy(LocalDate since, List<String> envModels) {
        if (envModels.size() != 2) {
            return List.of();
        }
        List<ForecastRow> out = new ArrayList<>();
        jdbc.query(
                "SELECT fa.site_id, fa.kind, avg(fa.nmae_pct) AS nmae, count(*) AS days "
                        + "FROM forecast_accuracy fa "
                        + "WHERE fa.day >= ? AND fa.nmae_pct IS NOT NULL AND fa.model = COALESCE("
                        + "(SELECT sc.model_id FROM site_forecast_model_choice sc "
                        + " WHERE sc.site_id = fa.site_id AND sc.model_kind = fa.kind "
                        + " ORDER BY sc.id DESC LIMIT 1), "
                        + "(SELECT pc.model_id FROM forecast_model_choice pc "
                        + " WHERE pc.model_kind = fa.kind ORDER BY pc.id DESC LIMIT 1), "
                        + "CASE fa.kind WHEN 'load' THEN ? ELSE ? END) "
                        + "GROUP BY fa.site_id, fa.kind",
                rs -> {
                    BigDecimal nmae = rs.getBigDecimal("nmae");
                    if (nmae != null) {
                        out.add(new ForecastRow(rs.getObject("site_id", UUID.class),
                                rs.getString("kind"), nmae.doubleValue(), rs.getInt("days")));
                    }
                },
                since, envModels.get(0), envModels.get(1));
        return out;
    }
}
