package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.FleetMetricsRepository;
import com.voltpilot.api.repo.UemsMetricsRepository;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.env.MockEnvironment;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-14 IP-18 (Kasten E11): der Dauerläufer-Kundenbereich gegen eine ECHTE Wegwerf-Datenbank —
 * ein Dauerläufer und ein echter Messkunde, beide mit Anlage, Box und Funktion „Messen“.
 *
 * <ul>
 *   <li><b>Flottenkennzahlen</b>: ohne Schalter zählt der Dauerläufer mit (Bestand, bytegleich);
 *       mit Schalter fehlt er im Nenner {@code voltpilot_sites} und in jeder
 *       {@code voltpilot_site_*}-Reihe, der echte Kunde bleibt unverändert.</li>
 *   <li><b>Messkunden-Alter</b>: bleibt MIT und OHNE Schalter mit seinem {@code tenant}-Etikett
 *       sichtbar — in genau der Form, die gitops PR 37 einträgt (kanonische UUID, klein).</li>
 *   <li><b>NW-6, api-seitig</b>: Messwerte kommen an → das Alter ist klein; der Simulator wird
 *       angehalten → mit verstellter Uhr überschreitet das Alter 900 s, die Grenze von
 *       {@code VoltPilotDauerlaeuferStumm}. Keine 15 Minuten Wartezeit.</li>
 * </ul>
 *
 * <p>Läuft ohne Spring-Kontext wie {@link FleetMetricsDbTest}. Auto-Skip ohne Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
class DauerlaeuferMetrikenDbTest {

    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "pw_admin";

    /** Die für den Dauerläufer vorgesehene Kennung aus dem Auftrag; hier nur eine Testkennung. */
    private static final UUID DAUERLAEUFER = UUID.fromString("e1b07da2-5f48-4330-a46b-6457ab9fb020");
    private static final UUID KUNDE = UUID.fromString("c0de0000-0000-4000-8000-00000000000c");

    private static final UUID DL_ANLAGE_1 = UUID.fromString("d1000000-0000-4000-8000-000000000001");
    private static final UUID DL_ANLAGE_2 = UUID.fromString("d1000000-0000-4000-8000-000000000002");
    private static final UUID DL_BOX_1 = UUID.fromString("d1b00000-0000-4000-8000-000000000001");
    private static final UUID DL_BOX_2 = UUID.fromString("d1b00000-0000-4000-8000-000000000002");
    private static final UUID KUNDE_ANLAGE = UUID.fromString("c1000000-0000-4000-8000-000000000001");
    private static final UUID KUNDE_BOX = UUID.fromString("c1b00000-0000-4000-8000-000000000001");

    /** Fester „Jetzt“-Zeitpunkt der Saat; alle Alter sind von Hand nachrechenbar. */
    private static final Instant NOW = Instant.parse("2026-11-03T10:00:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();

        try (Connection c = quelle(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection()) {
            messkunde(c, DAUERLAEUFER, "VoltPilot Dauerläufer (intern)");
            messkunde(c, KUNDE, "Echter Messkunde");
            anlage(c, DAUERLAEUFER, DL_ANLAGE_1, "Dauerläufer AN-1");
            anlage(c, DAUERLAEUFER, DL_ANLAGE_2, "Dauerläufer AN-2");
            anlage(c, KUNDE, KUNDE_ANLAGE, "Kundenanlage");
            box(c, DAUERLAEUFER, DL_ANLAGE_1, DL_BOX_1, "dl-e1");
            box(c, DAUERLAEUFER, DL_ANLAGE_2, DL_BOX_2, "dl-e2");
            box(c, KUNDE, KUNDE_ANLAGE, KUNDE_BOX, "kunde-e1");
            // Was der Lücken-Melder aus den Eingängen je Box schreibt: der jüngste EINGANG.
            // Dauerläufer: E-1 vor 60 s, E-2 vor 90 s — der Kundenbereich ist 60 s alt.
            eingang(c, DAUERLAEUFER, DL_BOX_1, NOW.minusSeconds(60));
            eingang(c, DAUERLAEUFER, DL_BOX_2, NOW.minusSeconds(90));
            eingang(c, KUNDE, KUNDE_BOX, NOW.minusSeconds(120));
        }
    }

    // --- Flottenkennzahlen ---------------------------------------------------------------------

    @Test
    void ohneSchalterZaehltDerDauerlaeuferWieBisherMit() {
        String scrape = flotte(Optional.empty());

        assertThat(zeile(scrape, FleetMetricsCollector.SITES + " ")).endsWith(" 3.0");
        assertThat(scrape).contains("site=\"" + DL_ANLAGE_1 + "\"").contains("site=\"" + DL_ANLAGE_2 + "\"")
                .contains("site=\"" + KUNDE_ANLAGE + "\"");
    }

    @Test
    void mitSchalterFehltDerDauerlaeuferInJederFlottenkennzahl() {
        String scrape = flotte(Optional.of(DAUERLAEUFER));

        assertThat(zeile(scrape, FleetMetricsCollector.SITES + " "))
                .as("der Nenner der Quoten zählt nur echte Anlagen").endsWith(" 1.0");
        assertThat(scrape.lines().filter(l -> l.startsWith("voltpilot_site")))
                .isNotEmpty()
                .noneMatch(l -> l.contains(DAUERLAEUFER.toString()))
                .noneMatch(l -> l.contains(DL_ANLAGE_1.toString()))
                .noneMatch(l -> l.contains(DL_ANLAGE_2.toString()));
        assertThat(scrape).as("der echte Kunde bleibt, wie er war")
                .contains(FleetMetricsCollector.TELEMETRY_STATE + "{site=\"" + KUNDE_ANLAGE
                        + "\",state=\"never\",tenant=\"" + KUNDE + "\"} 1.0");
    }

    @Test
    void derEchteKundeIstMitUndOhneSchalterBytegleich() {
        String ohne = flotte(Optional.empty());
        String mit = flotte(Optional.of(DAUERLAEUFER));

        assertThat(kundenzeilen(mit)).isEqualTo(kundenzeilen(ohne)).isNotEmpty();
    }

    // --- Messkunden-Alter: bleibt sichtbar, trägt das Etikett aus gitops PR 37 ---------------

    @Test
    void dasMesskundenAlterDesDauerlaeufersBleibtMitSchalterSichtbar() {
        String scrape = uems(Clock.fixed(NOW, ZoneOffset.UTC));

        assertThat(zeile(scrape, UemsMetricsCollector.MESSWERT_ALTER + "{tenant=\"" + DAUERLAEUFER + "\"}"))
                .as("die jüngere der beiden Boxen zählt").endsWith(" 60.0");
        assertThat(zeile(scrape, UemsMetricsCollector.MESSWERT_ALTER + "{tenant=\"" + KUNDE + "\"}"))
                .endsWith(" 120.0");
        // PR 37 vergleicht `and on (namespace, tenant)` wörtlich: kanonische UUID, Kleinschreibung.
        assertThat(scrape).contains("tenant=\"e1b07da2-5f48-4330-a46b-6457ab9fb020\"");
    }

    @Test
    void nw6SimulatorAngehaltenUeberschreitetDasAlterDie900SekundenOhneZuWarten() {
        MutableUhr uhr = new MutableUhr(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        UemsMetricsCollector sammler = new UemsMetricsCollector(new UemsMetricsRepository(
                new JdbcTemplate(adminRole())), new UemsLaeuferMelder(registry), new MockEnvironment(),
                registry, uhr);
        sammler.collect();
        String zeile = UemsMetricsCollector.MESSWERT_ALTER + "{tenant=\"" + DAUERLAEUFER + "\"}";
        assertThat(wert(registry.scrape(), zeile)).as("Dauerbetrieb: frisch").isLessThan(900);

        // Simulator angehalten: es kommt nichts mehr an. Der nächste Sammel-Lauf findet denselben
        // jüngsten Eingang, die Uhr steht 16 Minuten weiter.
        uhr.weiter(Duration.ofMinutes(16));
        sammler.collect();
        assertThat(wert(registry.scrape(), zeile)).as("über der Grenze von VoltPilotDauerlaeuferStumm")
                .isEqualTo(60 + 16 * 60).isGreaterThan(900);

        // Und auch ohne Sammel-Lauf wächst das Alter weiter — ein stehender Sammler verdeckt nichts.
        uhr.weiter(Duration.ofMinutes(5));
        assertThat(wert(registry.scrape(), zeile)).isEqualTo(60 + 21 * 60);
    }

    // --- Der Schalter ----------------------------------------------------------------------------

    @Test
    void derSchalterNimmtNurLeerOderEineKanonischeUuid() {
        assertThat(Dauerlaeufer.kennung(null)).isEmpty();
        assertThat(Dauerlaeufer.kennung("  ")).isEmpty();
        assertThat(Dauerlaeufer.kennung(" E1B07DA2-5F48-4330-A46B-6457AB9FB020 "))
                .as("großgeschrieben eingetragen, klein im Etikett").contains(DAUERLAEUFER);
        assertThat(Dauerlaeufer.kennung("E1B07DA2-5F48-4330-A46B-6457AB9FB020").orElseThrow().toString())
                .isEqualTo("e1b07da2-5f48-4330-a46b-6457ab9fb020");
        assertThatThrownBy(() -> Dauerlaeufer.kennung("CHANGE-ME-dauerlaeufer-tenant"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(Dauerlaeufer.EIGENSCHAFT);
        assertThatThrownBy(() -> Dauerlaeufer.kennung("1-1-1-1-1"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // ---------------------------------------------------------------------------------------------

    private static String flotte(Optional<UUID> dauerlaeufer) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new FleetMetricsCollector(new FleetMetricsRepository(new JdbcTemplate(adminRole())), registry,
                Clock.fixed(NOW, ZoneOffset.UTC), dauerlaeufer).collect();
        return registry.scrape();
    }

    private static String uems(Clock uhr) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new UemsMetricsCollector(new UemsMetricsRepository(new JdbcTemplate(adminRole())),
                new UemsLaeuferMelder(registry), new MockEnvironment(), registry, uhr).collect();
        return registry.scrape();
    }

    private static java.util.List<String> kundenzeilen(String scrape) {
        return scrape.lines().filter(l -> l.startsWith("voltpilot_site") && l.contains(KUNDE.toString()))
                .toList();
    }

    private static String zeile(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    private static double wert(String scrape, String prefix) {
        String z = zeile(scrape, prefix);
        assertThat(z).as(prefix).isNotNull();
        return Double.parseDouble(z.substring(z.lastIndexOf(' ') + 1));
    }

    private static void messkunde(Connection c, UUID tenant, String name) throws Exception {
        UUID unternehmen = UUID.randomUUID();
        UUID standort = UUID.randomUUID();
        exec(c, "INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        exec(c, "INSERT INTO unternehmen (id, tenant_id, name, zeitzone) VALUES (?, ?, ?, 'Europe/Berlin')",
                unternehmen, tenant, name);
        exec(c, "INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand)"
                + " VALUES (?, ?, ?, 'Werk', 'ST-1', 'Europe/Berlin', 'aktiv')", standort, tenant, unternehmen);
        exec(c, "INSERT INTO funktion (tenant_id, standort_id, funktion, zustand, geaendert_von)"
                + " VALUES (?, ?, 'messen', 'aktiv', 'Testvorrichtung')", tenant, standort);
    }

    private static void anlage(Connection c, UUID tenant, UUID site, String name) throws Exception {
        exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')",
                site, tenant, name);
    }

    private static void box(Connection c, UUID tenant, UUID site, UUID device, String ref) throws Exception {
        exec(c, "INSERT INTO device (id, tenant_id, site_id, external_ref, status)"
                + " VALUES (?, ?, ?, ?, 'claimed')", device, tenant, site, ref);
    }

    private static void eingang(Connection c, UUID tenant, UUID device, Instant zuletzt) throws Exception {
        try (PreparedStatement ps = c.prepareStatement("INSERT INTO messreihe_luecke_stand"
                + " (tenant_id, einheit, art, device_id, zuletzt) VALUES (?, ?, 'box', ?, ?)")) {
            ps.setObject(1, tenant);
            ps.setString(2, "box:" + device);
            ps.setObject(3, device);
            ps.setTimestamp(4, Timestamp.from(zuletzt));
            ps.execute();
        }
    }

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }

    private static DataSource adminRole() {
        return quelle(ADMIN_USER, ADMIN_PW);
    }

    private static DataSource quelle(String user, String pw) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(pw);
        return ds;
    }

    /** Eine Uhr, die der Test vorstellt — der Simulator steht, die Zeit läuft. */
    private static final class MutableUhr extends Clock {
        private Instant jetzt;

        MutableUhr(Instant start) {
            this.jetzt = start;
        }

        void weiter(Duration d) {
            jetzt = jetzt.plus(d);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return jetzt;
        }
    }
}
