package com.voltpilot.api.repo;

import static com.voltpilot.api.FahrplanVersionenBestand.laeufe;
import static com.voltpilot.api.FahrplanVersionenBestand.stammdaten;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.OverviewRepository.DailySavings;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
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
 * Die vorberechnete Sparzeile ({@code schedule_savings_1d}, Migration {@code V20261105090000},
 * Bericht vp-anlagen-cockpit-perf Rang 4b) gegen die Live-Form aus {@code schedule}.
 *
 * <p>Der Beweis ist die GLEICHHEIT: {@link OverviewRepository#dailySavings} (Tabelle für fertige Tage, live für den
 * Rest) liefert für jedes Fenster dieselbe Liste wie {@link OverviewRepository#dailySavingsLive}, Zeichen für
 * Zeichen (BigDecimal mit Skala) - mit Neuplanungen, einem jüngsten Lauf ohne Basiskosten (der Slot entfällt, kein
 * Rückgriff auf einen älteren Lauf), einem Tag ohne Plan, zwei Mandanten und dem Zeitumstellungstag mit 25 Stunden.
 * Dazu: der Stand-Mechanismus (leer, Lücke, Nachrechnen), dass die Tabelle WIRKLICH bedient (Fahrplan-Zeilen
 * gelöscht, Antwort bleibt), RLS und Abräumen mit der Anlage.
 *
 * <p>Ohne Docker übersprungen ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ScheduleSavings1dTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID TENANT_A = UUID.fromString("5c000000-0000-0000-0000-0000000002a0");
    private static final UUID TENANT_B = UUID.fromString("5c000000-0000-0000-0000-0000000002b0");
    private static final UUID SITE_A1 = UUID.fromString("5c000000-0000-0000-0000-0000000002a1");
    private static final UUID SITE_A2 = UUID.fromString("5c000000-0000-0000-0000-0000000002a2");
    private static final UUID SITE_B1 = UUID.fromString("5c000000-0000-0000-0000-0000000002b1");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static Instant jetzt;
    /** Mittag des heutigen Berliner Tages: gestern ist sicher abgeschlossen, heute sicher nicht. */
    private static Instant mittags;
    private static LocalDate heute;

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
        heute = jetzt.atZone(BERLIN).toLocalDate();
        mittags = heute.atTime(12, 0).atZone(BERLIN).toInstant();
        try (Connection c = superuser()) {
            stammdaten(c, TENANT_A, SITE_A1, "A1");
            stammdaten(c, TENANT_A, SITE_A2, "A2");
            stammdaten(c, TENANT_B, SITE_B1, "B1");
            // Der Scheduler rechnet nicht hinter dem Rücken der Fälle.
            for (String job : List.of("schedule_compaction_job", "schedule_savings_1d_job")) {
                try (Statement s = c.createStatement()) {
                    s.execute("SELECT alter_job(job_id, next_start => now() + interval '1 day') "
                            + "FROM timescaledb_information.jobs WHERE proc_name = '" + job + "'");
                }
            }
            // Bestand mit Neuplanungen (jeder fünfzigste Lauf): A1 über 16 Tage - die Sparzeile ist 14 Tage breit -,
            // B1 und A2 über je vier Tage in der Mitte des Fensters (A2 lässt Tage OHNE Plan davor und danach).
            Instant raster = jetzt.truncatedTo(ChronoUnit.HOURS);
            laeufe(c, TENANT_A, SITE_A1, raster.minus(Duration.ofDays(16)), raster);
            laeufe(c, TENANT_B, SITE_B1, raster.minus(Duration.ofDays(9)), raster.minus(Duration.ofDays(5)));
            laeufe(c, TENANT_A, SITE_A2, raster.minus(Duration.ofDays(8)), raster.minus(Duration.ofDays(4)));
            // Der JÜNGSTE Lauf eines Slots ohne Basiskosten: der Slot entfällt, kein Rückgriff auf einen älteren Lauf.
            update(c, "UPDATE schedule SET baseline_cost_eur = NULL WHERE site_id = ? AND time = ?"
                    + " AND generated_at = (SELECT max(generated_at) FROM schedule WHERE site_id = ? AND time = ?)",
                    SITE_A1, Timestamp.from(raster.minus(Duration.ofDays(10))),
                    SITE_A1, Timestamp.from(raster.minus(Duration.ofDays(10))));
        }
    }

    // ---- Die Fenster -------------------------------------------------------------

    private static Instant tagBeginn(LocalDate tag) {
        return tag.atStartOfDay(BERLIN).toInstant();
    }

    /** So ruft der Controller: 14 Tage bis einschließlich heute. */
    private static Instant sparzeileVon() {
        return tagBeginn(heute.minusDays(13));
    }

    private static Instant sparzeileBis() {
        return tagBeginn(heute.plusDays(1));
    }

    /** Beide Wege für dasselbe Fenster: (Tabelle + live, nur live). */
    private record Beide(List<DailySavings> gemischt, List<DailySavings> live) {
    }

    private static Beide lies(UUID mandant, Instant von, Instant bis) throws Exception {
        try (SingleConnectionDataSource ds = appRole(mandant)) {
            OverviewRepository overview = new OverviewRepository(new JdbcTemplate(ds));
            return new Beide(overview.dailySavings(von, bis), overview.dailySavingsLive(von, bis));
        }
    }

    private static void gleich(UUID mandant, Instant von, Instant bis, String was) throws Exception {
        Beide b = lies(mandant, von, bis);
        assertThat(b.gemischt()).as(was).isEqualTo(b.live());
    }

    private static void rechne(Instant uhr, int fensterTage, int abschlussStunden) throws Exception {
        try (Connection c = superuser(); PreparedStatement ps = c.prepareStatement(
                "CALL refresh_schedule_savings_1d(?, ?, ?)")) {
            ps.setTimestamp(1, Timestamp.from(uhr));
            ps.setInt(2, fensterTage);
            ps.setInt(3, abschlussStunden);
            ps.execute();
        }
    }

    // ---- Die Fälle ---------------------------------------------------------------

    @Test
    @Order(1)
    void dieMigrationRegistriertDenJobStuendlichMitDenStandardwerten() throws Exception {
        try (Connection c = superuser(); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT schedule_interval::text, config::text"
                        + " FROM timescaledb_information.jobs WHERE proc_name = 'schedule_savings_1d_job'")) {
            assertThat(rs.next()).as("Job registriert").isTrue();
            assertThat(rs.getString(1)).isEqualTo("01:00:00");
            assertThat(rs.getString(2)).contains("\"window_days\": 35").contains("\"settle_hours\": 1");
        }
        // Die Prüffunktion lehnt Unsinn schon beim alter_job ab, nicht erst eine Stunde später im Lauf.
        try (Connection c = superuser(); Statement s = c.createStatement()) {
            assertThatThrownBy(() -> s.execute("SELECT alter_job(job_id, config => '{\"window_days\": 3}'::jsonb)"
                    + " FROM timescaledb_information.jobs WHERE proc_name = 'schedule_savings_1d_job'"))
                    .hasMessageContaining("window_days");
            assertThatThrownBy(() -> s.execute("SELECT alter_job(job_id, config => '{\"settle_hours\": 0}'::jsonb)"
                    + " FROM timescaledb_information.jobs WHERE proc_name = 'schedule_savings_1d_job'"))
                    .hasMessageContaining("settle_hours");
        }
    }

    @Test
    @Order(2)
    void ohneStandRechnetDerLeserLiveWieBisher() throws Exception {
        Beide a = lies(TENANT_A, sparzeileVon(), sparzeileBis());
        assertThat(a.live()).as("der Bestand trägt Tage").hasSizeGreaterThan(10);
        assertThat(a.gemischt()).isEqualTo(a.live());
    }

    @Test
    @Order(3)
    void jedesFensterIstNachDemJobGleichZurLiveForm() throws Exception {
        rechne(mittags, 35, 1);
        try (Connection c = superuser()) {
            // Gestern ist fertig, heute nicht: der Stand endet gestern.
            assertThat(text(c, "SELECT von::text || '..' || bis::text FROM schedule_savings_1d_state"))
                    .isEqualTo(heute.minusDays(35) + ".." + heute.minusDays(1));
            assertThat(zahl(c, "SELECT count(*) FROM schedule_savings_1d WHERE day >= ?", heute))
                    .as("der heutige Tag wird nie vorberechnet").isZero();
            // Tage ohne Plan tragen eine NULL-Zeile (berechnet, nichts zu summieren) - nie eine Null.
            assertThat(zahl(c, "SELECT count(*) FROM schedule_savings_1d WHERE site_id = ? AND savings_eur IS NULL",
                    SITE_A2)).isPositive();
        }

        Instant von = sparzeileVon();
        Instant bis = sparzeileBis();
        gleich(TENANT_A, von, bis, "Mandant A, 14 Tage");
        gleich(TENANT_B, von, bis, "Mandant B, 14 Tage");
        // Kürzere und längere Fenster, auch mit der Tabellengrenze mittendrin und ohne den heutigen Tag.
        gleich(TENANT_A, tagBeginn(heute.minusDays(3)), bis, "3 Tage");
        gleich(TENANT_A, tagBeginn(heute.minusDays(10)), tagBeginn(heute.minusDays(2)), "ganz in der Tabelle");
        gleich(TENANT_A, tagBeginn(heute.minusDays(60)), bis, "60 Tage: vor dem Stand live, dahinter Tabelle");
        gleich(TENANT_A, tagBeginn(heute), bis, "nur heute");
        // Ein Fenster, das nicht auf Berliner Tagesgrenzen liegt, rechnet live und bleibt trotzdem gleich.
        gleich(TENANT_A, jetzt.minus(Duration.ofHours(80)), jetzt.minus(Duration.ofHours(8)), "UTC-Stundenfenster");

        // Die Tabelle trägt die Mandanten getrennt: A sieht keine Summe aus B und umgekehrt.
        Beide a = lies(TENANT_A, von, bis);
        Beide b = lies(TENANT_B, von, bis);
        assertThat(a.gemischt()).isNotEqualTo(b.gemischt());
        assertThat(b.gemischt()).as("B hat nur vier Tage Fahrplan").hasSizeLessThan(a.gemischt().size());
    }

    @Test
    @Order(4)
    void derJuengsteLaufOhneBasiskostenLaesstDenSlotEntfallen() throws Exception {
        // Der Slot vor zehn Tagen hat im jüngsten Lauf keine Basiskosten: die Live-Form lässt ihn aus (sie fällt nicht
        // auf einen älteren Lauf zurück), und die Tabelle trägt dieselbe Summe.
        Instant slot = jetzt.truncatedTo(ChronoUnit.HOURS).minus(Duration.ofDays(10));
        LocalDate tag = slot.atZone(BERLIN).toLocalDate();
        String juengsteJeSlot = "(SELECT DISTINCT ON (time) time, baseline_cost_eur, cost_eur FROM schedule"
                + " WHERE site_id = ? AND time >= ? AND time < ? ORDER BY time, generated_at DESC) x";
        Object[] fenster = {SITE_A1, Timestamp.from(tagBeginn(tag)), Timestamp.from(tagBeginn(tag.plusDays(1)))};
        try (Connection c = superuser()) {
            long alleSlots = zahl(c, "SELECT count(*) FROM " + juengsteJeSlot, fenster);
            long mitBeidenKosten = zahl(c, "SELECT count(*) FROM " + juengsteJeSlot
                    + " WHERE baseline_cost_eur IS NOT NULL AND cost_eur IS NOT NULL", fenster);
            assertThat(mitBeidenKosten).as("genau ein Slot entfällt").isEqualTo(alleSlots - 1);
            BigDecimal summe = decimal(c, "SELECT sum(baseline_cost_eur - cost_eur) FROM " + juengsteJeSlot
                    + " WHERE baseline_cost_eur IS NOT NULL AND cost_eur IS NOT NULL", fenster);
            BigDecimal gespeichert = decimal(c,
                    "SELECT savings_eur FROM schedule_savings_1d WHERE site_id = ? AND day = ?", SITE_A1, tag);
            assertThat(gespeichert).isEqualTo(summe);
        }
        gleich(TENANT_A, tagBeginn(tag), tagBeginn(tag.plusDays(1)), "der Tag mit dem entfallenen Slot");
    }

    @Test
    @Order(5)
    void derJobIstIdempotentUndRechnetNurDenNachlauf() throws Exception {
        long vorher;
        Timestamp stempel;
        try (Connection c = superuser()) {
            vorher = zahl(c, "SELECT count(*) FROM schedule_savings_1d");
            stempel = timestamp(c, "SELECT max(computed_at) FROM schedule_savings_1d");
        }
        rechne(mittags, 35, 1);
        try (Connection c = superuser()) {
            assertThat(zahl(c, "SELECT count(*) FROM schedule_savings_1d")).isEqualTo(vorher);
            assertThat(timestamp(c, "SELECT max(computed_at) FROM schedule_savings_1d"))
                    .as("ein zweiter Lauf schreibt nichts neu").isEqualTo(stempel);
        }

        // Ein stehen gebliebener Job: drei Tage fehlen. Der Leser rechnet sie live, der nächste Lauf holt sie nach.
        try (Connection c = superuser()) {
            update(c, "UPDATE schedule_savings_1d_state SET bis = bis - 3");
            update(c, "DELETE FROM schedule_savings_1d WHERE day > ?", heute.minusDays(4));
        }
        gleich(TENANT_A, sparzeileVon(), sparzeileBis(), "Lücke von drei Tagen, live aufgefüllt");
        rechne(mittags, 35, 1);
        try (Connection c = superuser()) {
            assertThat(text(c, "SELECT bis::text FROM schedule_savings_1d_state")).isEqualTo(heute.minusDays(1).toString());
            assertThat(zahl(c, "SELECT count(*) FROM schedule_savings_1d")).isEqualTo(vorher);
        }
        gleich(TENANT_A, sparzeileVon(), sparzeileBis(), "nach dem Nachholen");
    }

    @Test
    @Order(6)
    void vorMitternachtPlusAbschlussBleibtGesternLive() throws Exception {
        // 00:30 Berliner Zeit: gestern ist noch nicht abgeschlossen (Abschluss eine Stunde nach Mitternacht).
        Instant halbEins = tagBeginn(heute).plus(Duration.ofMinutes(30));
        try (Connection c = superuser()) {
            update(c, "UPDATE schedule_savings_1d_state SET bis = bis - 1");
            update(c, "DELETE FROM schedule_savings_1d WHERE day >= ?", heute.minusDays(1));
        }
        rechne(halbEins, 35, 1);
        try (Connection c = superuser()) {
            assertThat(text(c, "SELECT bis::text FROM schedule_savings_1d_state"))
                    .as("um 00:30 ist vorgestern der jüngste fertige Tag").isEqualTo(heute.minusDays(2).toString());
        }
        gleich(TENANT_A, sparzeileVon(), sparzeileBis(), "gestern wird live gerechnet");
        rechne(mittags, 35, 1);
        gleich(TENANT_A, sparzeileVon(), sparzeileBis(), "ab 01:00 ist gestern in der Tabelle");
    }

    @Test
    @Order(7)
    void dieTabelleBedientWirklichUndRlsHaeltDieMandantenGetrennt() throws Exception {
        Beide vorher = lies(TENANT_A, sparzeileVon(), sparzeileBis());
        try (Connection c = superuser()) {
            // Alle Fahrplan-Zeilen vor gestern weg: die Live-Form findet die alten Tage nicht mehr, die Tabelle trägt sie.
            update(c, "DELETE FROM schedule WHERE time < ?", Timestamp.from(tagBeginn(heute.minusDays(1))));
        }
        Beide nachher = lies(TENANT_A, sparzeileVon(), sparzeileBis());
        assertThat(nachher.live()).as("ohne Fahrplan-Zeilen bleibt live fast leer").hasSizeLessThan(vorher.live().size());
        assertThat(nachher.gemischt()).as("die Tabelle bedient die fertigen Tage").isEqualTo(vorher.gemischt());

        // RLS: die App-Rolle sieht nur die Zeilen ihres Mandanten, ohne Mandant keine, und sie kann nicht schreiben.
        try (SingleConnectionDataSource ds = appRole(TENANT_B)) {
            JdbcTemplate jdbc = new JdbcTemplate(ds);
            assertThat(jdbc.queryForList("SELECT DISTINCT site_id FROM schedule_savings_1d", UUID.class))
                    .containsExactly(SITE_B1);
            assertThatThrownBy(() -> jdbc.update("DELETE FROM schedule_savings_1d"))
                    .hasRootCauseMessage("ERROR: permission denied for table schedule_savings_1d");
        }
        try (SingleConnectionDataSource ds = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true)) {
            assertThat(new JdbcTemplate(ds).queryForObject("SELECT count(*) FROM schedule_savings_1d", Long.class))
                    .as("ohne gesetzten Mandanten sieht die App-Rolle nichts").isZero();
        }
    }

    @Test
    @Order(8)
    void derZeitumstellungstagHatFuenfundzwanzigStundenUndBleibtGleich() throws Exception {
        // 25.10.2026: Ende der Sommerzeit, der Berliner Tag hat 25 Stunden. Eine eigene Anlage mit einem Lauf je Tag
        // über drei Tage drumherum; der Job rechnet sie aus der Sicht des 30.10.
        UUID anlage = UUID.fromString("5c000000-0000-0000-0000-0000000002c1");
        UUID mandant = UUID.fromString("5c000000-0000-0000-0000-0000000002c0");
        try (Connection c = superuser()) {
            stammdaten(c, mandant, anlage, "C1");
            // Die Uhr springt hier zurück (die Fälle davor liefen "heute"): der Stand wird neu aufgesetzt.
            update(c, "DELETE FROM schedule_savings_1d_state");
            update(c, "INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, battery_kw, grid_kw,"
                    + " soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur, stur_cost_eur,"
                    + " curtail_kw, slot_role)"
                    + " SELECT t, ?, ?, md5(t::text)::uuid, t - interval '1 hour', 0, 0, 50, 1, 1, 50,"
                    + "        0.0100, 0.0100 + ((extract(epoch FROM t)::bigint / 900) % 7) / 1000.0, NULL, 0, 'warten'"
                    + " FROM generate_series(?::timestamptz, ?::timestamptz, interval '15 minutes') t",
                    mandant, anlage, Timestamp.from(tagBeginn(LocalDate.of(2026, 10, 23))),
                    Timestamp.from(tagBeginn(LocalDate.of(2026, 10, 28)).minusSeconds(900)));
        }
        Instant dreissigster = LocalDate.of(2026, 10, 30).atTime(12, 0).atZone(BERLIN).toInstant();
        rechne(dreissigster, 35, 1);
        Instant von = tagBeginn(LocalDate.of(2026, 10, 22));
        Instant bis = tagBeginn(LocalDate.of(2026, 10, 30));
        Beide b = lies(mandant, von, bis);
        assertThat(b.live()).as("fünf Tage mit Plan").hasSize(5);
        assertThat(b.gemischt()).isEqualTo(b.live());
        // Der Zeitumstellungstag trägt 25 Stunden Slots: 100 Viertelstunden.
        try (Connection c = superuser()) {
            assertThat(zahl(c, "SELECT count(DISTINCT time) FROM schedule WHERE site_id = ? AND time >= ? AND time < ?",
                    anlage, Timestamp.from(tagBeginn(LocalDate.of(2026, 10, 25))),
                    Timestamp.from(tagBeginn(LocalDate.of(2026, 10, 26))))).isEqualTo(100);
        }
    }

    @Test
    @Order(9)
    void mitDerAnlageverschwindenAuchIhreZeilen() throws Exception {
        try (Connection c = superuser()) {
            assertThat(zahl(c, "SELECT count(*) FROM schedule_savings_1d WHERE site_id = ?", SITE_B1)).isPositive();
        }
        // Der echte Weg: die App-Rolle löscht die Anlage (SiteRepository.delete); sie hat kein DELETE auf der
        // Tabelle, die Kaskade der Fremdschlüssel räumt sie ab.
        try (SingleConnectionDataSource ds = appRole(TENANT_B)) {
            assertThat(new SiteRepository(new JdbcTemplate(ds)).delete(SITE_B1)).isTrue();
        }
        try (Connection c = superuser()) {
            assertThat(zahl(c, "SELECT count(*) FROM schedule_savings_1d WHERE site_id = ?", SITE_B1)).isZero();
        }
    }

    // ---- Hilfen ------------------------------------------------------------------

    private static void update(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.executeUpdate();
        }
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

    private static String text(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                return rs.getString(1);
            }
        }
    }

    private static BigDecimal decimal(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                return rs.getBigDecimal(1);
            }
        }
    }

    private static Timestamp timestamp(Connection c, String sql) throws Exception {
        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            assertThat(rs.next()).isTrue();
            return rs.getTimestamp(1);
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
