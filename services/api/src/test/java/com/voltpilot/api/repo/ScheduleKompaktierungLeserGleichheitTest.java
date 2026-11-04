package com.voltpilot.api.repo;

import static com.voltpilot.api.FahrplanVersionenBestand.ersterRegulaererSlot;
import static com.voltpilot.api.FahrplanVersionenBestand.laeufe;
import static com.voltpilot.api.FahrplanVersionenBestand.stammdaten;
import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.repo.HistoryRepository.ValueSlot;
import com.voltpilot.api.repo.HistoryRepository.VerkaufSlot;
import com.voltpilot.api.repo.OverviewRepository.DailySavings;
import com.voltpilot.api.web.dto.HistoryPlanPointDto;
import com.voltpilot.api.web.dto.SchedulePlanDto;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Gleichheitsbeweis zur Fahrplan-Kompaktierung (Migration
 * {@code V20261104133000}): jeder Leser, der {@code schedule} auf dem
 * Nutzerweg oder in den Diensten liest, liefert VOR und NACH der Verdichtung
 * dasselbe - auch für Fenster, die ganz im verdichteten Bestand liegen, und
 * für Fenster, die die 48-Stunden-Grenze überspannen. Die Leser werden
 * aufgerufen, nicht nachgebaut; wo der Leser nicht in dieser Codebasis liegt
 * (Forecast- und Optimierungs-Dienst, Python), läuft sein Statement wörtlich
 * als Zwilling und ein Wächter pinnt den Zwilling an die Quelldatei.
 *
 * <p><b>Warum der Job zwei Läufe je altem Slot behält und nicht einen</b>
 * (Bericht vp-anlagen-cockpit-perf §4 und d8 §3 sagen "jeder Leser nimmt den
 * jüngsten Lauf"; das hier zählt nach, statt es zu glauben): die Leser des
 * Nutzerwegs ({@link OverviewRepository#dailySavings}, {@link
 * OverviewRepository#savingsPerSite}, {@link HistoryRepository#savings},
 * {@link HistoryRepository#curtailSlots}, {@link EarningsRepository#planSlots},
 * {@link ScheduleRepository#latestForSite}) nehmen tatsächlich den jüngsten
 * Lauf je Slot. Zwei Leser aber nehmen den Lauf, der bei SLOTBEGINN galt: die
 * Plan-Bewertung des Forecast-Dienstes ({@code evaluate._planned_costs},
 * {@code generated_at <= time}, täglich für gestern UND vorgestern) und der
 * Tagesfilm ({@link ScheduleRepository#dayAsPlanned}, eine Sekunde Toleranz).
 * Ein Lauf wird Mikrosekunden NACH seiner Slotgrenze gestempelt, also ist der
 * bei Beginn gültige Lauf fast nie der jüngste - die Gegenprobe unten zeigt,
 * dass "nur der jüngste Lauf" der Plan-Bewertung jede verdichtete Viertelstunde
 * genommen hätte.
 *
 * <p><b>Die eine benannte Abweichung</b>, nach dem Muster von
 * {@code HotReadRewriteEqualityTest}: {@link HistoryRepository#nachtPrognoseKwh}
 * fragt nach EINEM beliebigen älteren Lauf ("der letzte Lauf vor 19 Uhr") und
 * findet ihn für Nächte älter als N nicht mehr - der Ereignistext des
 * Abendverkaufs nennt dann ehrlich keine Nachtprognose (seine Regel 1). Das
 * ist hier gepinnt, damit es nie unbemerkt breiter wird.
 *
 * <p>Ohne Docker übersprungen ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class ScheduleKompaktierungLeserGleichheitTest {

    private static final UUID TENANT_A = UUID.fromString("5c000000-0000-0000-0000-00000000001a");
    private static final UUID TENANT_B = UUID.fromString("5c000000-0000-0000-0000-00000000001b");
    private static final UUID SITE_A1 = UUID.fromString("5c000000-0000-0000-0000-0000000001a1");
    private static final UUID SITE_A2 = UUID.fromString("5c000000-0000-0000-0000-0000000001a2");
    private static final UUID SITE_B1 = UUID.fromString("5c000000-0000-0000-0000-0000000001b1");

    /** {@code services/forecast evaluate._planned_costs}, wörtlich ({@code %s} als {@code ?}). */
    private static final String PLAN_BEWERTUNG =
            "SELECT DISTINCT ON (time) time, cost_eur, baseline_cost_eur"
                    + " FROM schedule"
                    + " WHERE site_id = ? AND time >= ? AND time < ? AND generated_at <= time"
                    + " ORDER BY time, generated_at DESC";

    /**
     * {@code services/optimization inputs.py} "Speicher heute schon aktiv geplant?",
     * wörtlich; das Slot-Intervall steht als Literal statt als Parameter.
     */
    private static final String SPEICHER_HEUTE_AKTIV =
            "SELECT EXISTS ("
                    + " SELECT 1 FROM schedule"
                    + " WHERE site_id = ? AND time >= ? AND time < ?"
                    + " AND generated_at >= time AND generated_at < time + interval '15 minutes'"
                    + " AND battery_kw > ?)";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static Instant jetzt;
    private static Instant seedBeginn;

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"))
                .load()
                .migrate();
        jetzt = Instant.now();
        seedBeginn = jetzt.truncatedTo(ChronoUnit.HOURS).minus(Duration.ofDays(5));
        try (Connection c = superuser()) {
            stammdaten(c, TENANT_A, SITE_A1, "A1");
            stammdaten(c, TENANT_A, SITE_A2, "A2");
            stammdaten(c, TENANT_B, SITE_B1, "B1");
            laeufe(c, TENANT_A, SITE_A1, seedBeginn, jetzt);
            laeufe(c, TENANT_A, SITE_A2, seedBeginn, jetzt);
            laeufe(c, TENANT_B, SITE_B1, seedBeginn, jetzt);
            // Der Scheduler verdichtet nicht hinter dem Rücken des Tests.
            try (Statement s = c.createStatement()) {
                s.execute("SELECT alter_job(job_id, next_start => now() + interval '1 day') "
                        + "FROM timescaledb_information.jobs WHERE proc_name = 'schedule_compaction_job'");
            }
        }
    }

    // ---- Die Fenster -----------------------------------------------------------

    /** Ganz im verdichteten Bestand (älter als 72 h, Verdichtung ab 48 h, Luft zur Uhr). */
    private static Instant altVon() {
        return jetzt.minus(Duration.ofHours(96));
    }

    private static Instant altBis() {
        return jetzt.minus(Duration.ofHours(72));
    }

    /** Überspannt die 48-Stunden-Grenze. */
    private static Instant randVon() {
        return jetzt.minus(Duration.ofHours(60));
    }

    private static Instant randBis() {
        return jetzt.minus(Duration.ofHours(36));
    }

    /** Der ganze Bestand samt Zukunft des jüngsten Laufs. */
    private static Instant ganzBis() {
        return jetzt.plus(Duration.ofHours(48));
    }

    /** Ein ganzer Tag (UTC) tief im verdichteten Bestand. */
    private static Instant alterTag() {
        return jetzt.minus(Duration.ofHours(80)).truncatedTo(ChronoUnit.DAYS);
    }

    /** Ein Augenblick in einem alten Slot (fünf Minuten nach dessen Beginn). */
    private static Instant beobachtet() {
        return ersterRegulaererSlot(jetzt.minus(Duration.ofHours(80))).plus(Duration.ofMinutes(5));
    }

    // ---- Das Bild: jeder Leser einmal --------------------------------------------

    /** Alles, was die Leser über diesen Bestand sagen - als Feldliste, damit eine Abweichung ihren Namen trägt. */
    private static Map<String, Object> bild() throws Exception {
        Map<String, Object> felder = new LinkedHashMap<>();
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            JdbcTemplate jdbc = new JdbcTemplate(ds);
            OverviewRepository overview = new OverviewRepository(jdbc);
            HistoryRepository history = new HistoryRepository(jdbc,
                    new OptimizerProperties(4.0, 0.3, null, null, false));
            EarningsRepository earnings = new EarningsRepository(jdbc,
                    new OptimizerProperties(4.0, 0.3, null, null, false));
            ScheduleRepository schedule = new ScheduleRepository(jdbc);
            OptimizerDiagnosticsRepository diagnose = new OptimizerDiagnosticsRepository(jdbc);

            for (String name : List.of("alt", "rand", "ganz")) {
                Instant von = switch (name) {
                    case "alt" -> altVon();
                    case "rand" -> randVon();
                    default -> seedBeginn;
                };
                Instant bis = switch (name) {
                    case "alt" -> altBis();
                    case "rand" -> randBis();
                    default -> ganzBis();
                };
                // Übersicht ("Meine Anlagen"): Sparzeile und 14-Tage-Mini-Chart.
                Map<UUID, BigDecimal> savingsPerSite = overview.savingsPerSite(von, bis);
                List<DailySavings> daily = overview.dailySavings(von, bis);
                felder.put("overview.savingsPerSite/" + name, savingsPerSite);
                felder.put("overview.dailySavings/" + name, daily);
                // Verlauf: Ersparnis, Abregelung, Plan-Overlay, Verkaufsspur.
                felder.put("history.savings/" + name, history.savings(SITE_A1, von, bis));
                List<ValueSlot> curtail = history.curtailSlots(SITE_A1, von, bis);
                List<HistoryPlanPointDto> plan = history.planForWindow(SITE_A1, von, bis);
                List<VerkaufSlot> verkauf = history.verkaufSlots(SITE_A1, von, bis);
                felder.put("history.curtailSlots/" + name, curtail);
                felder.put("history.planForWindow/" + name, plan);
                felder.put("history.verkaufSlots/" + name, verkauf);
                // Erlöse: die Messlatte je Viertelstunde, je Anlage und flottenweit.
                Map<UUID, List<PlanMesslatte.Slot>> messlatte = earnings.planSlots(von, bis, SITE_A1);
                felder.put("earnings.planSlots(anlage)/" + name, messlatte);
                felder.put("earnings.planSlots(flotte)/" + name, earnings.planSlots(von, bis, null));
                assertThat(messlatte.get(SITE_A1)).isNotEmpty();
                // Forecast-Dienst: die Plan-Bewertung des Tages (Zwilling).
                felder.put("forecast._planned_costs/" + name, jdbc.queryForList(PLAN_BEWERTUNG,
                        SITE_A1, Timestamp.from(von), Timestamp.from(bis)));
                // Optimierer: "Speicher heute schon aktiv geplant?" (Zwilling).
                felder.put("optimization.speicherHeuteAktiv/" + name, jdbc.queryForObject(
                        SPEICHER_HEUTE_AKTIV, Boolean.class,
                        SITE_A1, Timestamp.from(von), Timestamp.from(bis), new BigDecimal("0.1")));
                // Jeder Anlage ihre Sparzeile, nie eine leere Übersicht.
                assertThat(savingsPerSite).containsKeys(SITE_A1, SITE_A2);
                assertThat(daily).isNotEmpty();
                assertThat(curtail).isNotEmpty();
                assertThat(plan).isNotEmpty();
                assertThat(verkauf).isNotEmpty();
            }
            // Fahrplan: DER Plan (jüngster Lauf) für beide Anlagen des Mandanten.
            SchedulePlanDto latest = schedule.latestForSite(SITE_A1);
            felder.put("schedule.latestForSite/A1", latest);
            felder.put("schedule.latestForSite/A2", schedule.latestForSite(SITE_A2));
            assertThat(latest).isNotNull();
            assertThat(latest.slots()).hasSize(192);
            // Tagesfilm: ein alter Tag (ex ante, Toleranz eine Sekunde) und gestern bis heute.
            SchedulePlanDto film = schedule.dayAsPlanned(SITE_A1, alterTag(), alterTag().plus(Duration.ofDays(1)));
            felder.put("schedule.dayAsPlanned/alterTag", film);
            felder.put("schedule.dayAsPlanned/gestern",
                    schedule.dayAsPlanned(SITE_A1, jetzt.minus(Duration.ofHours(24)).truncatedTo(ChronoUnit.DAYS)));
            assertThat(film).isNotNull();
            assertThat(film.slots()).hasSize(96);
            // Steuerstatus: die geplante Last im beobachteten Slot.
            felder.put("schedule.activePlannedLoadKw/alt", schedule.activePlannedLoadKw(SITE_A1, beobachtet()));
            // Plattform-Übersicht und Diagnose: wann zuletzt und zuerst gerechnet wurde.
            felder.put("overview.lastPlanPerSite", overview.lastPlanPerSite(seedBeginn));
            felder.put("diagnose.latest", diagnose.resolveRun(SITE_A1, null));
            felder.put("diagnose.first", diagnose.firstRun(SITE_A1));
        }
        return felder;
    }

    // ---- Der Beweis -------------------------------------------------------------

    @Test
    void jederLeserSagtVorUndNachDerVerdichtungDasselbe() throws Exception {
        Instant nachtVon = jetzt.minus(Duration.ofHours(80)).truncatedTo(ChronoUnit.HOURS);
        Instant nachtBis = nachtVon.plus(Duration.ofHours(8));
        Instant laufVor = nachtVon.minus(Duration.ofHours(3));

        Map<String, Object> vorher = bild();
        BigDecimal nachtVorher;
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            nachtVorher = new HistoryRepository(new JdbcTemplate(ds),
                    new OptimizerProperties(4.0, 0.3, null, null, false))
                    .nachtPrognoseKwh(SITE_A1, nachtVon, nachtBis, laufVor);
        }
        assertThat(nachtVorher).as("vor der Verdichtung trägt die Nacht eine Prognose").isNotNull();

        try (Connection c = superuser()) {
            // Gegenprobe VOR der Verdichtung: hätte der Job nur den jüngsten Lauf je
            // Slot behalten, fände die Plan-Bewertung im alten Fenster KEINE
            // Viertelstunde mehr - denn der jüngste Lauf ist nach Slotbeginn gestempelt.
            long slotsImFenster = zahl(c, "SELECT count(DISTINCT time) FROM schedule"
                    + " WHERE site_id = ? AND time >= ? AND time < ?",
                    SITE_A1, Timestamp.from(altVon()), Timestamp.from(altBis()));
            long bewertbarNurJuengster = zahl(c, "SELECT count(*) FROM ("
                    + "  SELECT DISTINCT ON (time) time, generated_at FROM schedule"
                    + "  WHERE site_id = ? AND time >= ? AND time < ?"
                    + "  ORDER BY time, generated_at DESC) j WHERE generated_at <= time",
                    SITE_A1, Timestamp.from(altVon()), Timestamp.from(altBis()));
            long bewertbarBeiBeginn = zahl(c, "SELECT count(*) FROM ("
                    + "  SELECT DISTINCT ON (time) time FROM schedule"
                    + "  WHERE site_id = ? AND time >= ? AND time < ? AND generated_at <= time"
                    + "  ORDER BY time, generated_at DESC) g",
                    SITE_A1, Timestamp.from(altVon()), Timestamp.from(altBis()));
            assertThat(slotsImFenster).isEqualTo(96);
            assertThat(bewertbarBeiBeginn).as("die Plan-Bewertung findet jede Viertelstunde").isEqualTo(96);
            assertThat(bewertbarNurJuengster)
                    .as("mit nur dem jüngsten Lauf je Slot fände sie keine einzige")
                    .isZero();

            // Die Verdichtung, wie der Job sie fährt (48 Stunden).
            try (Statement s = c.createStatement()) {
                s.execute("CALL schedule_compaction_job(0, '{\"keep_all_runs_hours\": 48}'::jsonb)");
            }
            // Sie hat wirklich gegriffen: der alte Tag hält höchstens drei Zeilen je Slot.
            assertThat(zahl(c, "SELECT max(n) FROM (SELECT count(*) AS n FROM schedule"
                    + " WHERE site_id = ? AND time >= ? AND time < ? GROUP BY time) x",
                    SITE_A1, Timestamp.from(altVon()), Timestamp.from(altBis())))
                    .isLessThanOrEqualTo(3);
        }

        Map<String, Object> nachher = bild();
        assertThat(nachher.keySet()).containsExactlyElementsOf(vorher.keySet());
        for (Map.Entry<String, Object> feld : vorher.entrySet()) {
            assertThat(nachher.get(feld.getKey())).as(feld.getKey()).isEqualTo(feld.getValue());
        }

        // Die eine benannte Abweichung: der beliebige ältere Lauf der Nachtprognose.
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            BigDecimal nachtNachher = new HistoryRepository(new JdbcTemplate(ds),
                    new OptimizerProperties(4.0, 0.3, null, null, false))
                    .nachtPrognoseKwh(SITE_A1, nachtVon, nachtBis, laufVor);
            assertThat(nachtNachher)
                    .as("nachtPrognoseKwh für eine Nacht älter als N: ehrlich null, keine Zahl")
                    .isNull();
        }
    }

    /**
     * Die Zwillinge bleiben die Statements, die sie nachstellen: ein Wächter
     * liest die beiden Python-Quelldateien und verlangt die tragenden Fragmente.
     */
    @Test
    void dieZwillingeHaengenAnIhrenQuellen() throws Exception {
        String evaluate = quelle("services/forecast/voltpilot_forecast/evaluate.py");
        assertThat(evaluate)
                .contains("SELECT DISTINCT ON (time) time, cost_eur, baseline_cost_eur")
                .contains("WHERE site_id = %s AND time >= %s AND time < %s AND generated_at <= time")
                .contains("ORDER BY time, generated_at DESC");

        String inputs = quelle("services/optimization/voltpilot_optimization/inputs.py");
        assertThat(inputs)
                .contains("SELECT 1 FROM schedule")
                .contains("AND generated_at >= time AND generated_at < time + %s")
                .contains("AND battery_kw > %s)");
    }

    // ---- Hilfen ------------------------------------------------------------------

    /** Eine Quelldatei des Repos, vom Modul- oder vom Wurzelverzeichnis aus. */
    private static String quelle(String repoPfad) throws Exception {
        for (Path kandidat : List.of(Path.of("../..").resolve(repoPfad), Path.of(repoPfad))) {
            if (Files.isRegularFile(kandidat)) {
                return Files.readString(kandidat);
            }
        }
        throw new AssertionError("Quelldatei nicht gefunden: " + repoPfad + " (ab "
                + Path.of("").toAbsolutePath() + ")");
    }

    private static long zahl(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                return rs.getLong(1);
            }
        }
    }

    private static Connection superuser() throws Exception {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds.getConnection();
    }

    /** EINE Verbindung als App-Rolle mit gesetztem Mandanten - der RLS-Zaun ist scharf. */
    private static SingleConnectionDataSource appRole(UUID tenant) throws Exception {
        SingleConnectionDataSource ds = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (PreparedStatement ps = ds.getConnection()
                .prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenant.toString());
            ps.execute();
        }
        return ds;
    }
}
