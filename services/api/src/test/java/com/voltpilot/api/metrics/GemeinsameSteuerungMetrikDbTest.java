package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.BoxMetrikRepository;
import com.voltpilot.api.repo.BoxMetrikRepository.Box;
import com.voltpilot.api.uems.PlanZustellungAufbewahrung;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-15 IP-11 (NW-9): das SQL hinter den Box-Metriken und die Frist für {@code plan_zustellung}
 * gegen eine ECHTE Datenbank, über die Rolle, an der beides in Produktion hängt:
 * {@code voltpilot_admin} (BYPASSRLS). Gesät wird für ZWEI Kundenbereiche — einer davon der
 * Dauerläufer, der hier NICHT ausgenommen wird: die Alarm-Übung findet dort statt.
 *
 * <p>Ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class GemeinsameSteuerungMetrikDbTest {

    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "pw_admin";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    private static JdbcTemplate root;
    private static JdbcTemplate admin;
    private static UUID kunde, werk, dauerlaeufer, dauerlaeuferSite;
    /** Plan 2.0 mit Quittung; alte Box ohne Plan und Block; ausgebaute Box; Box nur mit Block; Dauerläufer. */
    private static UUID mitPlan, alt, ausgebaut, nurBlock, simuliert;
    /** Die Boxen der Frist: seit 40 Tagen stumm, und eine, die weiterläuft. */
    private static UUID stumm, laeuft;
    /** Mitglied ohne Plan (IP-4) und eine aufgehobene Mitgliedschaft. */
    private static UUID mitglied, aufgehoben;
    private static UUID p10uhr, p1015;

    @BeforeAll
    static void migrateAndSeed() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(quelle(POSTGRES.getUsername(), POSTGRES.getPassword()));
        admin = new JdbcTemplate(quelle(ADMIN_USER, ADMIN_PW));

        kunde = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg') RETURNING id", UUID.class);
        werk = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') RETURNING id",
                UUID.class, kunde);
        dauerlaeufer = root.queryForObject("INSERT INTO tenant (name) VALUES ('VoltPilot Dauerläufer (intern)') RETURNING id",
                UUID.class);
        dauerlaeuferSite = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Dauerläufer') RETURNING id",
                UUID.class, dauerlaeufer);

        mitPlan = box(kunde, werk, "VP-IP11-E1");
        root.update("UPDATE device SET supports = '[\"plan_quittung\"]'::jsonb, "
                + "device_status_seen_at = now() - interval '2 minutes' WHERE id = ?", mitPlan);
        p10uhr = UUID.randomUUID();
        p1015 = UUID.randomUUID();
        angenommen(mitPlan, kunde, werk, p10uhr, "20 minutes");
        veroeffentlicht(mitPlan, kunde, werk, p1015, "5 minutes");

        alt = box(kunde, werk, "VP-IP11-ALT");
        root.update("UPDATE device SET device_status_seen_at = now() WHERE id = ?", alt);

        ausgebaut = box(kunde, werk, "VP-IP11-AUS");
        angenommen(ausgebaut, kunde, werk, UUID.randomUUID(), "3 minutes");
        root.update("UPDATE device SET status = 'ausgebaut', ausgebaut_am = now() WHERE id = ?", ausgebaut);

        nurBlock = box(kunde, werk, "VP-IP11-BLOCK");

        simuliert = box(dauerlaeufer, dauerlaeuferSite, "VP-IP11-DL");
        angenommen(simuliert, dauerlaeufer, dauerlaeuferSite, UUID.randomUUID(), "3 minutes");

        UUID verbund = root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id, stufe, epoche) "
                + "VALUES (?, ?, 'anteile_aktiv', 1) RETURNING id", UUID.class, kunde, werk);
        mitglied = box(kunde, werk, "VP-IP11-MITGLIED");
        root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, rolle, "
                + "gueltig_ab, gesendet_epoche, gesendet_revision, gesendet_am) VALUES (?, ?, ?, ?, 'steuert_mit', "
                + "date_trunc('minute', now()) - interval '1 day', 1, 3, now() - interval '40 minutes')",
                kunde, verbund, werk, mitglied);
        aufgehoben = box(kunde, werk, "VP-IP11-AUFGEHOBEN");
        root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, rolle, "
                + "gueltig_ab, aufgehoben_am) VALUES (?, ?, ?, ?, 'steuert_mit', "
                + "date_trunc('minute', now()) - interval '1 day', now())", kunde, verbund, werk, aufgehoben);

        stumm = box(kunde, werk, "VP-IP11-STUMM");
        laeuft = box(kunde, werk, "VP-IP11-LAEUFT");
    }

    // --- Welche Boxen ---------------------------------------------------------------------------

    @Test
    void nurBoxenMitPlanOderBlockErscheinenUndDerDauerlaeuferGehoertDazu() {
        List<Box> boxen = new BoxMetrikRepository(admin).boxen(Set.of(nurBlock));

        assertThat(boxen).extracting(Box::deviceId)
                .contains(mitPlan, nurBlock, simuliert)
                .as("keine Reihe je Bestandsbox ohne Bezug, keine ausgebaute Box")
                .doesNotContain(alt, ausgebaut);
        Box dl = boxen.stream().filter(b -> b.deviceId().equals(simuliert)).findFirst().orElseThrow();
        assertThat(dl.tenantId()).as("über die Verwaltungsrolle - nicht nur der eine Mandant").isEqualTo(dauerlaeufer);
    }

    /** IP-4: ein Mitglied ohne Plan erscheint mit Rolle, Stufe und gesendeter Revision; ein aufgehobenes nicht. */
    @Test
    void einMitgliedOhnePlanErscheintEinAufgehobenesNicht() {
        List<Box> boxen = new BoxMetrikRepository(admin).boxen(Set.of());

        assertThat(boxen).extracting(Box::deviceId).contains(mitglied).doesNotContain(aufgehoben);
        Box m = boxen.stream().filter(b -> b.deviceId().equals(mitglied)).findFirst().orElseThrow();
        assertThat(m.mitglied().rolle()).isEqualTo("steuert_mit");
        assertThat(m.mitglied().stufe()).isEqualTo("anteile_aktiv");
        assertThat(m.mitglied().gesendetRevision()).isEqualTo(3L);
        assertThat(m.mitglied().quittiertRevision()).as("unbekannt ist keine Null").isNull();
        assertThat(GemeinsameSteuerungMetrikSammler.unbestaetigt(m.mitglied())).isTrue();
    }

    /** R11 in der Datenbank: veröffentlicht 10:15 gegen angenommen 10:00 — je die Erzeugung. */
    @Test
    void veroeffentlichtGegenAngenommenInDerOrdnungVonStand() {
        Box b = new BoxMetrikRepository(admin).boxen(Set.of()).stream()
                .filter(x -> x.deviceId().equals(mitPlan)).findFirst().orElseThrow();

        // Jede Saat-Anweisung hat ihr eigenes now(): auf die Sekunde genau, nicht auf die Millisekunde.
        assertThat(Duration.between(b.angenommen(), b.veroeffentlicht()).toSeconds()).isEqualTo(900L);
        assertThat(b.quittiert()).isTrue();
        assertThat(Duration.between(b.herzschlag(), Instant.now()).toMinutes()).isBetween(1L, 4L);
        assertThat(b.siteId()).isEqualTo(werk);
    }

    @Test
    void derSammlerSchreibtDieBoxInDenEchtenScrapeRumpf() throws Exception {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        GemeinsameSteuerungHerzschlag halter = new GemeinsameSteuerungHerzschlag();
        halter.merke(nurBlock, new ObjectMapper().readTree("{\"plan_id\":\"" + UUID.randomUUID()
                + "\",\"waechter\":{\"einspeisung\":\"sicherheitskappe\"}}"));
        new GemeinsameSteuerungMetrikSammler(new BoxMetrikRepository(admin), halter, registry, Clock.systemUTC()).collect();

        String scrape = registry.scrape();

        assertThat(scrape).contains("voltpilot_uems_box_plan_angenommen_age_seconds{device=\"" + mitPlan + "\"");
        assertThat(scrape).contains("voltpilot_uems_box_waechter_stufe{device=\"" + nurBlock
                + "\",richtung=\"einspeisung\",site=\"" + werk + "\",stufe=\"sicherheitskappe\",tenant=\"" + kunde + "\"} 1.0");
        assertThat(scrape).contains("tenant=\"" + dauerlaeufer + "\"");
        assertThat(scrape).as("alte Box ohne Block: KEINE Zeile").doesNotContain(alt.toString());
        assertThat(scrape).as("nie ein Kundenname").doesNotContain("Ahrenberg").doesNotContain("Dauerläufer");
    }

    // --- Frist ---------------------------------------------------------------------------------

    /**
     * 35 Tage: die seit 40 Tagen stumme Box behält ihre jüngste veröffentlichte und ihre jüngste
     * angenommene Zeile (sonst verlöre das Blatt „veröffentlicht gegen angenommen“), ältere gehen;
     * die laufende Box verliert nur, was jenseits der Frist UND nicht das Jüngste ist.
     */
    @Test
    void dieFristBehaeltJeBoxDasJuengsteVeroeffentlichteUndAngenommene() {
        UUID s1 = UUID.randomUUID(), s2 = UUID.randomUUID(), s3 = UUID.randomUUID(), s4 = UUID.randomUUID();
        angenommen(stumm, kunde, werk, s1, "50 days");
        abgelehnt(stumm, kunde, werk, s2, "48 days");
        angenommen(stumm, kunde, werk, s3, "45 days");
        veroeffentlicht(stumm, kunde, werk, s4, "40 days");
        UUID l1 = UUID.randomUUID(), l2 = UUID.randomUUID(), l3 = UUID.randomUUID();
        angenommen(laeuft, kunde, werk, l1, "40 days");
        angenommen(laeuft, kunde, werk, l2, "34 days");
        veroeffentlicht(laeuft, kunde, werk, l3, "1 hour");
        Box vorher = box(stumm);

        int entfernt = new PlanZustellungAufbewahrung(admin, 35).lauf();

        assertThat(plaene(stumm)).containsExactlyInAnyOrder(s3, s4);
        assertThat(plaene(laeuft)).containsExactlyInAnyOrder(l2, l3);
        assertThat(plaene(mitPlan)).as("junge Zeilen bleiben").containsExactlyInAnyOrder(p10uhr, p1015);
        assertThat(entfernt).isEqualTo(3);
        assertThat(box(stumm)).as("die Metrik sieht nach dem Lauf dasselbe").isEqualTo(vorher);
        assertThat(new PlanZustellungAufbewahrung(admin, 35).lauf()).as("ein zweiter Lauf hat nichts mehr").isZero();
    }

    // --- Hilfen ---------------------------------------------------------------------------------

    private static Box box(UUID deviceId) {
        return new BoxMetrikRepository(admin).boxen(Set.of()).stream()
                .filter(b -> b.deviceId().equals(deviceId)).findFirst().orElseThrow();
    }

    private static List<UUID> plaene(UUID deviceId) {
        return root.queryForList("SELECT plan_id FROM plan_zustellung WHERE device_id = ?", UUID.class, deviceId);
    }

    private static UUID box(UUID tenant, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, tenant, site, ref);
    }

    /** Wie der Optimierer: erzeugt und veröffentlicht vor {@code vor}. */
    private static void veroeffentlicht(UUID device, UUID tenant, UUID site, UUID plan, String vor) {
        root.update("INSERT INTO plan_zustellung (device_id, plan_id, tenant_id, site_id, generated_at, veroeffentlicht_um) "
                + "VALUES (?, ?, ?, ?, now() - ?::interval, now() - ?::interval)", device, plan, tenant, site, vor, vor);
    }

    private static void angenommen(UUID device, UUID tenant, UUID site, UUID plan, String vor) {
        veroeffentlicht(device, tenant, site, plan, vor);
        root.update("UPDATE plan_zustellung SET urteil = 'angenommen', quittiert_um = generated_at, "
                + "empfangen_um = generated_at WHERE device_id = ? AND plan_id = ?", device, plan);
    }

    private static void abgelehnt(UUID device, UUID tenant, UUID site, UUID plan, String vor) {
        veroeffentlicht(device, tenant, site, plan, vor);
        root.update("UPDATE plan_zustellung SET urteil = 'abgelehnt', grund = 'fremde_box', quittiert_um = generated_at, "
                + "empfangen_um = generated_at WHERE device_id = ? AND plan_id = ?", device, plan);
    }

    private static PGSimpleDataSource quelle(String user, String pw) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(pw);
        return ds;
    }
}
