package com.voltpilot.api;

import static com.voltpilot.api.FahrplanVersionenBestand.HORIZONT_SLOTS;
import static com.voltpilot.api.FahrplanVersionenBestand.ersterNeuplanungsSlot;
import static com.voltpilot.api.FahrplanVersionenBestand.ersterRegulaererSlot;
import static com.voltpilot.api.FahrplanVersionenBestand.laeufe;
import static com.voltpilot.api.FahrplanVersionenBestand.stammdaten;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.OptimizerDiagnosticsRepository;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Verdichtungs-Job für überholte Fahrplan-Läufe (Migration
 * {@code V20261104133000}, Bericht vp-anlagen-cockpit-perf Befund B5) auf
 * einem künstlich versionierten Bestand: alle 15 Minuten ein Lauf über 192
 * Slots, also jede Viertelstunde bis zu 192-mal, dazu einzelne Neuplanungen
 * mitten im Slot. Bewiesen wird:
 *
 * <ul>
 *   <li>die Migration läuft auf einer frischen DB durch und registriert den
 *       Job stündlich mit {@code keep_all_runs_hours = 48} - unter demselben
 *       Eigentümer wie der Rollup-Job, der an FORCE RLS vorbeikommt; die
 *       Retention von 180 Tagen auf {@code schedule} bleibt daneben bestehen;</li>
 *   <li>je Slot älter als N bleiben GENAU der bei Slotbeginn gültige Lauf
 *       (jüngster {@code generated_at <= time}) und jeder spätere Lauf, der den
 *       Slot noch plante; die letzten N Stunden behalten jede Version;</li>
 *   <li>der Job ist idempotent, mandantenübergreifend, läuft auch unter dem
 *       echten TimescaleDB-Scheduler, und der Konfigurationspunkt greift
 *       (96 statt 48 Stunden; unter 1 wird schon beim {@code alter_job}
 *       abgelehnt);</li>
 *   <li>die Admin-Optimierer-Diagnose liest den verdichteten Bestand ohne
 *       Fehler: jeder alte Lauf bleibt auffindbar, mit den Viertelstunden, in
 *       denen er galt.</li>
 * </ul>
 *
 * <p>Die Leser-Gleichheit (Nutzerweg vor und nach der Verdichtung) steht in
 * {@code ScheduleKompaktierungLeserGleichheitTest}. Ohne Docker übersprungen
 * ({@code disabledWithoutDocker}).
 *
 * <p>Die Fälle teilen sich EINE Datenbank und laufen in fester Reihenfolge:
 * erst die Prüfungen am unverdichteten Bestand, dann der Haupt-Lauf, dann die
 * Varianten (Konfigurationspunkt, Scheduler) auf jeweils eigenen Anlagen. Der
 * Scheduler bekommt seinen ersten Termin erst, wenn der Test ihn ruft.
 */
@Testcontainers(disabledWithoutDocker = true)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ScheduleKompaktierungJobTest {

    private static final UUID TENANT_A = UUID.fromString("5c000000-0000-0000-0000-00000000000a");
    private static final UUID TENANT_B = UUID.fromString("5c000000-0000-0000-0000-00000000000b");
    private static final UUID SITE_A1 = UUID.fromString("5c000000-0000-0000-0000-0000000000a1");
    private static final UUID SITE_B1 = UUID.fromString("5c000000-0000-0000-0000-0000000000b1");
    /** Eigene Anlage für den Lauf unter dem Scheduler (ihr Bestand ist beim ersten Aufruf noch nicht da). */
    private static final UUID SITE_A2 = UUID.fromString("5c000000-0000-0000-0000-0000000000a2");
    /** Eigene Anlage für den Konfigurationspunkt (96 Stunden). */
    private static final UUID SITE_A3 = UUID.fromString("5c000000-0000-0000-0000-0000000000a3");

    /** Startzeit des Bestands, 15-Minuten-Raster, fest für den ganzen Lauf dieser Klasse. */
    private static Instant seedBeginn;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

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

        Instant jetzt = Instant.now();
        seedBeginn = jetzt.truncatedTo(ChronoUnit.HOURS).minus(Duration.ofDays(5));
        try (Connection c = superuser()) {
            // Der Scheduler soll den Bestand nicht hinter dem Rücken der Fälle
            // verdichten: sein erster Termin wandert weit weg, bis der
            // Scheduler-Fall ihn selbst ruft. ⚠ VOR dem Seed: der Job ist mit der Migration fällig, und ein Lauf
            // mitten im Seed verdichtet Slots, die der erste Fall noch voll versioniert erwartet (Rennen unter Last).
            try (Statement s = c.createStatement()) {
                s.execute("SELECT alter_job(job_id, next_start => now() + interval '1 day') "
                        + "FROM timescaledb_information.jobs WHERE proc_name = 'schedule_compaction_job'");
            }
            stammdaten(c, TENANT_A, SITE_A1, "A1");
            stammdaten(c, TENANT_A, SITE_A2, "A2");
            stammdaten(c, TENANT_A, SITE_A3, "A3");
            stammdaten(c, TENANT_B, SITE_B1, "B1");
            // Fünf Tage Läufe bis jetzt - die beiden ersten Anlagen tragen den
            // Bestand des Haupt-Laufs, mandantenübergreifend.
            laeufe(c, TENANT_A, SITE_A1, seedBeginn, jetzt);
            laeufe(c, TENANT_B, SITE_B1, seedBeginn, jetzt);
        }
    }

    // ---- Registrierung ------------------------------------------------------

    @Test
    @Order(1)
    void derJobIstStuendlichMit48StundenRegistriertNebenDerRetention() throws Exception {
        try (Connection c = superuser();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT j.schedule_interval::text AS takt, j.config, j.owner::text AS eigentuemer,"
                                + " (SELECT b.check_name FROM _timescaledb_config.bgw_job b"
                                + "   WHERE b.id = j.job_id) AS pruefung,"
                                + " (SELECT r.owner::text FROM timescaledb_information.jobs r"
                                + "   WHERE r.proc_name = 'telemetry_rollups_job') AS rollup_eigentuemer,"
                                + " (SELECT bool_or(p.rolsuper OR p.rolbypassrls) FROM pg_roles p"
                                + "   WHERE p.rolname = j.owner::text) AS kommt_an_rls_vorbei"
                                + " FROM timescaledb_information.jobs j"
                                + " WHERE j.proc_schema = 'public' AND j.proc_name = 'schedule_compaction_job'");
                ResultSet rs = ps.executeQuery()) {
            assertThat(rs.next()).as("der Job ist registriert").isTrue();
            assertThat(rs.getString("takt")).isEqualTo("01:00:00");
            assertThat(rs.getString("config")).contains("\"keep_all_runs_hours\": 48");
            assertThat(rs.getString("pruefung")).contains("schedule_compaction_check_config");
            assertThat(rs.getString("eigentuemer"))
                    .as("derselbe Eigentümer wie der Rollup-Job (die Flyway-Rolle)")
                    .isEqualTo(rs.getString("rollup_eigentuemer"));
            assertThat(rs.getBoolean("kommt_an_rls_vorbei"))
                    .as("ohne BYPASSRLS/Superuser löschte FORCE RLS still nichts")
                    .isTrue();
            assertThat(rs.next()).as("genau ein Job").isFalse();
        }
        try (Connection c = superuser();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT config->>'drop_after' FROM timescaledb_information.jobs "
                                + "WHERE proc_name = 'policy_retention' AND hypertable_name = 'schedule'");
                ResultSet rs = ps.executeQuery()) {
            assertThat(rs.next()).as("die Retention auf schedule bleibt").isTrue();
            assertThat(rs.getString(1)).isEqualTo("180 days");
        }
    }

    @Test
    @Order(2)
    void einWertUnterEinsWirdSchonBeimAlterJobAbgelehnt() throws Exception {
        try (Connection c = superuser(); Statement s = c.createStatement()) {
            assertThatThrownBy(() -> s.execute(
                    "SELECT alter_job(job_id, config => '{\"keep_all_runs_hours\": 0}'::jsonb) "
                            + "FROM timescaledb_information.jobs WHERE proc_name = 'schedule_compaction_job'"))
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("keep_all_runs_hours");
            assertThatThrownBy(() -> s.execute(
                    "CALL schedule_compaction_job(0, '{\"keep_all_runs_hours\": -5}'::jsonb)"))
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("keep_all_runs_hours");
        }
        try (Connection c = superuser();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT config->>'keep_all_runs_hours' FROM timescaledb_information.jobs "
                                + "WHERE proc_name = 'schedule_compaction_job'");
                ResultSet rs = ps.executeQuery()) {
            rs.next();
            assertThat(rs.getString(1)).as("die Ablehnung hat die Konfiguration nicht angefasst").isEqualTo("48");
        }
    }

    // ---- Die Verdichtung ------------------------------------------------------

    @Test
    @Order(3)
    void verdichtetAlteSlotsAufDenGueltigenUndJedenSpaeterenLaufUndLaesstDieLetzten48StundenGanz()
            throws Exception {
        Instant jetzt = Instant.now();
        // Scharfe Grenzen mit einer Stunde Luft zur beweglichen Uhr des Jobs.
        Instant sicherAlt = jetzt.minus(Duration.ofHours(49));
        Instant sicherJung = jetzt.minus(Duration.ofHours(47));
        Instant regulaer = ersterRegulaererSlot(seedBeginn.plus(Duration.ofDays(2)));

        long vorherGesamt;
        long vorherJung;
        long vorherAlt;
        try (Connection c = superuser()) {
            vorherGesamt = zahl(c, "SELECT count(*) FROM schedule WHERE site_id IN (?, ?)", SITE_A1, SITE_B1);
            vorherJung = zahl(c, "SELECT count(*) FROM schedule WHERE site_id IN (?, ?) AND time >= ?",
                    SITE_A1, SITE_B1, Timestamp.from(sicherJung));
            vorherAlt = zahl(c, "SELECT count(*) FROM schedule WHERE site_id IN (?, ?) AND time < ?",
                    SITE_A1, SITE_B1, Timestamp.from(sicherAlt));
            // Der Bestand ist wirklich versioniert: ein alter Slot trägt den vollen
            // Horizont (192 Läufe, dazu die Neuplanungen darunter).
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                    SITE_A1, Timestamp.from(regulaer)))
                    .isGreaterThanOrEqualTo(HORIZONT_SLOTS);
            // Vorher-Bild: Bestand, Neuplanungen, und je Slot der bei Beginn gültige Lauf.
            try (Statement s = c.createStatement()) {
                s.execute("DROP TABLE IF EXISTS vorher_bild");
                s.execute("CREATE TABLE vorher_bild AS SELECT site_id, time, generated_at FROM schedule "
                        + "WHERE site_id IN ('" + SITE_A1 + "', '" + SITE_B1 + "')");
            }
            // Der Job läuft mit SEINER registrierten Konfiguration (48 Stunden).
            String config;
            try (PreparedStatement ps = c.prepareStatement("SELECT config::text FROM timescaledb_information.jobs "
                    + "WHERE proc_name = 'schedule_compaction_job'");
                    ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                config = rs.getString(1);
            }
            assertThat(config).contains("48");
            try (PreparedStatement ps = c.prepareStatement("CALL schedule_compaction_job(0, ?::jsonb)")) {
                ps.setString(1, config);
                ps.execute();
            }
        }

        try (Connection c = superuser()) {
            // 1) Die letzten 48 Stunden: jede Version noch da, Zeile für Zeile.
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id IN (?, ?) AND time >= ?",
                    SITE_A1, SITE_B1, Timestamp.from(sicherJung))).isEqualTo(vorherJung);
            assertThat(zahl(c, "SELECT count(*) FROM (SELECT site_id, time, generated_at FROM vorher_bild"
                    + " WHERE time >= ? EXCEPT SELECT site_id, time, generated_at FROM schedule) x",
                    Timestamp.from(sicherJung))).isZero();

            // 2) Alte Slots: kein Lauf mehr, der schon vor Slotbeginn abgelöst war ...
            assertThat(zahl(c, "SELECT count(*) FROM schedule s WHERE s.site_id IN (?, ?) AND s.time < ?"
                    + " AND s.generated_at < (SELECT max(k.generated_at) FROM schedule k"
                    + "   WHERE k.site_id = s.site_id AND k.time = s.time AND k.generated_at <= k.time)",
                    SITE_A1, SITE_B1, Timestamp.from(sicherAlt)))
                    .as("überholte Läufe alter Slots").isZero();
            // ... und GENAU die erwartete Menge ist geblieben: aus dem Vorher-Bild je
            // Slot der bei Beginn gültige Lauf (Fensterfunktion, bewusst eine andere
            // Form als das DELETE des Jobs) und jeder Lauf nach Slotbeginn.
            String erwartet = "SELECT site_id, time, generated_at FROM ("
                    + "  SELECT site_id, time, generated_at,"
                    + "    max(generated_at) FILTER (WHERE generated_at <= time)"
                    + "      OVER (PARTITION BY site_id, time) AS gueltig"
                    + "  FROM vorher_bild WHERE time < ?) v"
                    + " WHERE generated_at > time OR generated_at = gueltig";
            assertThat(zahl(c, "SELECT count(*) FROM ((" + erwartet + ") EXCEPT"
                    + " SELECT site_id, time, generated_at FROM schedule WHERE time < ?) x",
                    Timestamp.from(sicherAlt), Timestamp.from(sicherAlt)))
                    .as("erwartete Zeilen, die fehlen").isZero();
            assertThat(zahl(c, "SELECT count(*) FROM (SELECT site_id, time, generated_at FROM schedule"
                    + " WHERE site_id IN (?, ?) AND time < ? EXCEPT (" + erwartet + ")) x",
                    SITE_A1, SITE_B1, Timestamp.from(sicherAlt), Timestamp.from(sicherAlt)))
                    .as("übrig gebliebene Zeilen, die nicht erwartet sind").isZero();

            // 3) In Zahlen: ein regulärer alter Slot hält zwei Zeilen (gültiger Lauf +
            //    der an der Slotgrenze ausgelöste), ein Slot mit Neuplanung drei; die
            //    alten Slots insgesamt sind auf höchstens drei Zeilen je Slot geschrumpft.
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                    SITE_A1, Timestamp.from(regulaer))).isEqualTo(2);
            Instant neugeplant = ersterNeuplanungsSlot(seedBeginn.plus(Duration.ofDays(1)));
            assertThat(neugeplant).isBefore(sicherAlt);
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                    SITE_A1, Timestamp.from(neugeplant))).isEqualTo(3);
            long nachherAlt = zahl(c, "SELECT count(*) FROM schedule WHERE site_id IN (?, ?) AND time < ?",
                    SITE_A1, SITE_B1, Timestamp.from(sicherAlt));
            long alteSlots = zahl(c, "SELECT count(DISTINCT (site_id, time)) FROM schedule"
                    + " WHERE site_id IN (?, ?) AND time < ?", SITE_A1, SITE_B1, Timestamp.from(sicherAlt));
            assertThat(nachherAlt).isLessThanOrEqualTo(3 * alteSlots);
            assertThat(nachherAlt).as("die alten Slots verlieren ihre Versionen").isLessThan(vorherAlt / 20);
            // Der jüngste Lauf je altem Slot ist unverändert der jüngste von vorher.
            assertThat(zahl(c, "SELECT count(*) FROM (SELECT site_id, time, max(generated_at) FROM vorher_bild"
                    + " WHERE time < ? GROUP BY 1, 2 EXCEPT SELECT site_id, time, max(generated_at) FROM schedule"
                    + " WHERE site_id IN (?, ?) AND time < ? GROUP BY 1, 2) x",
                    Timestamp.from(sicherAlt), SITE_A1, SITE_B1, Timestamp.from(sicherAlt))).isZero();
            // Beide Mandanten sind verdichtet - der Job kennt keinen Zaun.
            for (UUID site : List.of(SITE_A1, SITE_B1)) {
                assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                        site, Timestamp.from(regulaer))).as("Anlage " + site).isEqualTo(2);
            }
            long nachher = zahl(c, "SELECT count(*) FROM schedule WHERE site_id IN (?, ?)", SITE_A1, SITE_B1);
            assertThat(nachher).isLessThan(vorherGesamt);

            // 4) Idempotent: ein zweiter Lauf löscht nichts mehr.
            try (Statement s = c.createStatement()) {
                s.execute("CALL schedule_compaction_job(0, '{\"keep_all_runs_hours\": 48}'::jsonb)");
            }
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id IN (?, ?)", SITE_A1, SITE_B1))
                    .isEqualTo(nachher);
        }

        // 5) Die Admin-Diagnose liest den verdichteten Bestand sauber (App-Rolle, RLS).
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            OptimizerDiagnosticsRepository diag = new OptimizerDiagnosticsRepository(new JdbcTemplate(ds));
            assertThat(diag.firstRun(SITE_A1)).as("der älteste Lauf bleibt auffindbar").isNotNull();
            // Ein Lauf aus den ersten zwölf Stunden des Bestands: älter als 96 h, also
            // liegt auch sein 48-h-Horizont ganz im verdichteten Teil. (Ein Lauf von
            // vor 60 h behält daneben den Teil seines Horizonts, der noch in den
            // geschützten 48 Stunden liegt - dort jede Version.)
            List<Instant> laeufe = diag.runsBetween(SITE_A1, seedBeginn, seedBeginn.plus(Duration.ofHours(12)));
            assertThat(laeufe).as("ein alter Tag listet weiterhin seine Läufe").hasSizeGreaterThan(40);
            Instant alterLauf = laeufe.get(laeufe.size() / 2);
            assertThat(diag.resolveRun(SITE_A1, alterLauf)).isEqualTo(alterLauf);
            assertThat(diag.slots(SITE_A1, alterLauf))
                    .as("ein alter Lauf zeigt die Viertelstunden, in denen er galt")
                    .hasSizeBetween(1, 3);
            assertThat(diag.slots(SITE_A1, diag.resolveRun(SITE_A1, null)))
                    .as("der jüngste Lauf ist vollständig").hasSize(HORIZONT_SLOTS);
            assertThat(diag.firstRun(SITE_B1)).as("RLS: der fremde Mandant bleibt unsichtbar").isNull();
        }
    }

    @Test
    @Order(4)
    void derKonfigurationspunktVerschiebtDieGrenze() throws Exception {
        Instant jetzt = Instant.now();
        try (Connection c = superuser()) {
            laeufe(c, TENANT_A, SITE_A3, seedBeginn, jetzt);
            try (Statement s = c.createStatement()) {
                s.execute("CALL schedule_compaction_job(0, '{\"keep_all_runs_hours\": 96}'::jsonb)");
            }
            // Zwischen 96 und 48 Stunden zurück: alle Versionen bleiben ...
            Instant in72h = jetzt.minus(Duration.ofHours(72)).truncatedTo(ChronoUnit.HOURS);
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                    SITE_A3, Timestamp.from(in72h))).isGreaterThanOrEqualTo(HORIZONT_SLOTS);
            // ... älter als 96 Stunden ist verdichtet.
            Instant in100h = ersterRegulaererSlot(jetzt.minus(Duration.ofHours(100)).truncatedTo(ChronoUnit.HOURS));
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                    SITE_A3, Timestamp.from(in100h))).isEqualTo(2);
        }
    }

    @Test
    @Order(5)
    void derJobLaeuftAuchUnterDemEchtenScheduler() throws Exception {
        Instant jetzt = Instant.now();
        Instant alt = ersterRegulaererSlot(seedBeginn.plus(Duration.ofDays(2)));
        String statistik = "SELECT coalesce(sum(js.total_successes), 0) AS erfolge,"
                + " coalesce(sum(js.total_failures), 0) AS fehler, max(js.last_run_status) AS status"
                + " FROM timescaledb_information.jobs j"
                + " LEFT JOIN timescaledb_information.job_stats js ON js.job_id = j.job_id"
                + " WHERE j.proc_name = 'schedule_compaction_job'";
        String schedulerDa = "SELECT count(*) FROM pg_stat_activity"
                + " WHERE backend_type = 'TimescaleDB Background Worker Scheduler'"
                + " AND datname = current_database()";
        try (Connection c = superuser()) {
            laeufe(c, TENANT_A, SITE_A2, seedBeginn, jetzt);
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                    SITE_A2, Timestamp.from(alt))).isGreaterThanOrEqualTo(HORIZONT_SLOTS);
            // Der Launcher startet den Scheduler einer Datenbank spätestens mit
            // seinem nächsten Poll (timescaledb.bgw_launcher_poll_time, 60 s).
            Instant schedulerFrist = Instant.now().plus(Duration.ofSeconds(120));
            while (zahl(c, schedulerDa) == 0 && Instant.now().isBefore(schedulerFrist)) {
                Thread.sleep(1000);
            }
            assertThat(zahl(c, schedulerDa))
                    .as("ein Scheduler für diese Datenbank läuft:\n" + befund(c))
                    .isEqualTo(1);
            long erfolgeVorher = zahl(c, statistik);
            try (Statement s = c.createStatement()) {
                s.execute("SELECT alter_job(job_id, next_start => now()) FROM timescaledb_information.jobs"
                        + " WHERE proc_name = 'schedule_compaction_job'");
            }
            Instant frist = Instant.now().plus(Duration.ofSeconds(180));
            long erfolge = erfolgeVorher;
            String letzterStatus = null;
            while (Instant.now().isBefore(frist)) {
                try (PreparedStatement ps = c.prepareStatement(statistik);
                        ResultSet rs = ps.executeQuery()) {
                    assertThat(rs.next()).isTrue();
                    erfolge = rs.getLong("erfolge");
                    letzterStatus = rs.getString("status");
                    assertThat(rs.getLong("fehler"))
                            .as("der Scheduler-Lauf darf nicht fehlschlagen:\n" + befund(c)).isZero();
                }
                if (erfolge > erfolgeVorher) {
                    break;
                }
                Thread.sleep(1000);
            }
            assertThat(erfolge)
                    .as("der Scheduler hat den Job ausgeführt (letzter Status: %s):\n%s", letzterStatus, befund(c))
                    .isGreaterThan(erfolgeVorher);
            assertThat(zahl(c, "SELECT count(*) FROM schedule WHERE site_id = ? AND time = ?",
                    SITE_A2, Timestamp.from(alt)))
                    .as("der Scheduler-Lauf hat als Jobeigentümer an RLS vorbei gelöscht")
                    .isEqualTo(2);
        }
    }

    /** Was der Scheduler gerade sieht - für die Fehlermeldung, wenn er nicht läuft oder nicht lief. */
    static String befund(Connection c) throws Exception {
        StringBuilder b = new StringBuilder();
        for (String sql : List.of(
                "SELECT datname, backend_type, state FROM pg_stat_activity"
                        + " WHERE backend_type LIKE 'TimescaleDB%' ORDER BY 1, 2",
                "SELECT j.job_id, j.scheduled, j.next_start, j.owner, js.last_run_status, js.total_runs,"
                        + " js.total_failures, js.last_run_started_at FROM timescaledb_information.jobs j"
                        + " LEFT JOIN timescaledb_information.job_stats js ON js.job_id = j.job_id"
                        + " WHERE j.proc_name = 'schedule_compaction_job'",
                "SELECT current_setting('timescaledb.max_background_workers') AS bgw,"
                        + " current_setting('max_worker_processes') AS worker")) {
            b.append(sql).append('\n');
            try (PreparedStatement ps = c.prepareStatement(sql); ResultSet rs = ps.executeQuery()) {
                int spalten = rs.getMetaData().getColumnCount();
                while (rs.next()) {
                    b.append("  ");
                    for (int i = 1; i <= spalten; i++) {
                        b.append(rs.getMetaData().getColumnLabel(i)).append('=').append(rs.getString(i)).append(' ');
                    }
                    b.append('\n');
                }
            }
        }
        String logs = POSTGRES.getLogs();
        b.append("Container-Log (Ende):\n").append(logs.substring(Math.max(0, logs.length() - 4000)));
        return b.toString();
    }

    // ---- Verbindungen ------------------------------------------------------------

    static long zahl(Connection c, String sql, Object... args) throws Exception {
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

    static Connection superuser() throws Exception {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds.getConnection();
    }

    /** EINE Verbindung als App-Rolle mit gesetztem Mandanten - der RLS-Zaun ist scharf. */
    static SingleConnectionDataSource appRole(UUID tenant) throws Exception {
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
