package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.UemsMetricsRepository;
import com.voltpilot.api.repo.UemsMetricsRepository.ArbeitslisteStand;
import com.voltpilot.api.repo.UemsMetricsRepository.MesskundeEingang;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.sql.Connection;
import java.sql.Statement;
import java.time.Clock;
import java.util.Map;
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
 * AP-14 IP-9: das SQL hinter den UEMS-Betriebsmetriken gegen eine ECHTE Datenbank — das, was
 * {@link UemsMetricsScrapeTest} bewusst wegattrappt.
 *
 * <p>Bewiesen wird der ganze Weg bis in den Scrape-Rumpf, und zwar über die ROLLE, an der der
 * Sammler in Produktion hängt: {@code voltpilot_admin} (BYPASSRLS). Das ist kein Beiwerk — liefe die
 * Sammlung unter der Mandanten-RLS, lieferte JEDE dieser Abfragen null Zeilen, und null Zeilen heißt
 * hier „kein Rückstand, kein Messkunde ohne Werte“: ein stiller Fehlalarm in die beruhigende
 * Richtung. Gesät wird deshalb für ZWEI Kundenbereiche, und beide müssen erscheinen.
 *
 * <p>Ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMetricsDbTest {

    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "pw_admin";

    /** Zwei Messkunden (aktive Funktion „Messen“) und einer, der nur steuert. */
    private static final UUID MESSKUNDE_A = UUID.fromString("71000000-0000-0000-0000-0000000009a1");
    private static final UUID MESSKUNDE_B = UUID.fromString("71000000-0000-0000-0000-0000000009b2");
    private static final UUID NUR_STEUERN = UUID.fromString("71000000-0000-0000-0000-0000000009c3");
    /** Ein Kundenbereich, dessen Funktion „Messen“ noch ein Entwurf ist — er ist kein Messkunde. */
    private static final UUID MESSEN_ENTWURF = UUID.fromString("71000000-0000-0000-0000-0000000009d4");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    private static UemsMetricsRepository repo;

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();

        try (Connection c = quelle(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
                Statement s = c.createStatement()) {
            kundenbereich(s, MESSKUNDE_A, "messen", "aktiv");
            kundenbereich(s, MESSKUNDE_B, "messen", "aktiv");
            kundenbereich(s, NUR_STEUERN, "steuern", "aktiv");
            kundenbereich(s, MESSEN_ENTWURF, "messen", "entwurf");

            // Der Lückenstand je BOX: der jüngste Eingang. A hat zwei Boxen (die jüngere zählt),
            // B hat noch keine einzige - „nie ein Messwert“.
            box(s, MESSKUNDE_A, "00000000-0000-0000-0000-0000000000a1", "now() - interval '9 minutes'");
            box(s, MESSKUNDE_A, "00000000-0000-0000-0000-0000000000a2", "now() - interval '3 minutes'");
            // Auch der Nur-Steuern-Kunde hat Boxen - er darf trotzdem nicht im Export stehen.
            box(s, NUR_STEUERN, "00000000-0000-0000-0000-0000000000c1", "now() - interval '1 minute'");

            // Die drei Arbeitslisten, je Liste mit einem ALTEN und einem jungen Eintrag, und der
            // alte je in einem ANDEREN Kundenbereich - die Metrik ist global, ohne Tenant-Label.
            s.execute("INSERT INTO messreihe_viertelstunde_arbeit "
                    + "(tenant_id, entity_id, messkanal, intervall_beginn, grund, eingetragen_am) VALUES "
                    + "('" + MESSKUNDE_A + "', gen_random_uuid(), 'k', date_trunc('hour', now()), "
                    + "  'eingang', now() - interval '45 minutes'), "
                    + "('" + MESSKUNDE_B + "', gen_random_uuid(), 'k', date_trunc('hour', now()), "
                    + "  'eingang', now() - interval '2 minutes')");
            s.execute("INSERT INTO messreihe_tag_arbeit "
                    + "(tenant_id, entity_id, messkanal, utc_tag, grund, eingetragen_am) VALUES "
                    + "('" + MESSKUNDE_A + "', gen_random_uuid(), 'k', current_date, 'viertelstunde', "
                    + "  now() - interval '90 minutes')");
            // Die Periodenliste bleibt LEER: sie darf keinen Alterswert melden.
        }

        repo = new UemsMetricsRepository(new JdbcTemplate(quelle(ADMIN_USER, ADMIN_PW)));
    }

    // --- Arbeitslisten -------------------------------------------------------------------------

    @Test
    void dieDreiArbeitslistenMeldenZahlUndAeltestenEintragUeberAlleKundenbereiche() {
        var stand = repo.arbeitslisten();

        assertThat(stand).extracting(ArbeitslisteStand::liste)
                .containsExactly("viertelstunde", "tag", "periode");
        assertThat(liste(stand, "viertelstunde").offen())
                .as("beide Kundenbereiche zaehlen - die Metrik ist global").isEqualTo(2);
        assertThat(alterMinuten(liste(stand, "viertelstunde"))).isBetween(44L, 47L);
        assertThat(liste(stand, "tag").offen()).isEqualTo(1);
        assertThat(alterMinuten(liste(stand, "tag"))).isBetween(89L, 92L);
    }

    @Test
    void eineLeereArbeitslisteMeldetNullOffenUndKeinenAeltestenEintrag() {
        var periode = liste(repo.arbeitslisten(), "periode");

        assertThat(periode.offen()).isZero();
        assertThat(periode.aeltester()).as("kein Alter 0, das ein frisches Abarbeiten vortaeuschte")
                .isNull();
    }

    // --- Dateneingang je Messkunde -------------------------------------------------------------

    @Test
    void nurKundenbereicheMitAKTIVERFunktionMessenErscheinen() {
        var eingaenge = repo.messkundenEingaenge();

        assertThat(eingaenge).extracting(MesskundeEingang::tenantId)
                .containsExactlyInAnyOrder(MESSKUNDE_A, MESSKUNDE_B)
                .doesNotContain(NUR_STEUERN, MESSEN_ENTWURF);
    }

    @Test
    void derJuengsteEingangGewinntUndEinMesskundeOhneBoxMeldetKeinenZeitpunkt() {
        var eingaenge = repo.messkundenEingaenge();

        var a = eingaenge.stream().filter(e -> e.tenantId().equals(MESSKUNDE_A)).findFirst().orElseThrow();
        var b = eingaenge.stream().filter(e -> e.tenantId().equals(MESSKUNDE_B)).findFirst().orElseThrow();

        assertThat(java.time.Duration.between(a.zuletzt(), java.time.Instant.now()).toMinutes())
                .as("die JUENGERE der beiden Boxen").isBetween(2L, 5L);
        assertThat(b.zuletzt()).as("noch nie ein Messwert - und kein erfundener Zeitpunkt").isNull();
    }

    // --- Der ganze Weg bis in den Scrape-Rumpf -------------------------------------------------

    @Test
    void derSammlerSchreibtDieZeilenInDenEchtenScrapeRumpfUndNenntKeinenNamen() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        UemsLaeuferMelder melder = new UemsLaeuferMelder(registry);
        melder.gelaufen(UemsLaeuferMelder.LUECKEN);
        new UemsMetricsCollector(repo, melder, new MockEnvironment(), registry, Clock.systemUTC()).collect();

        String scrape = registry.scrape();

        assertThat(scrape).contains("voltpilot_uems_arbeitsliste_offen{liste=\"viertelstunde\"} 2.0");
        assertThat(scrape).contains("voltpilot_uems_arbeitsliste_offen{liste=\"periode\"} 0.0");
        assertThat(scrape).doesNotContain(
                "voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds{liste=\"periode\"}");
        assertThat(scrape).contains("voltpilot_uems_kundenbereich_letzter_messwert_age_seconds{tenant=\""
                + MESSKUNDE_A + "\"}");
        assertThat(scrape).contains("voltpilot_uems_kundenbereich_messwert_zustand{tenant=\""
                + MESSKUNDE_B + "\",zustand=\"nie\"} 1.0");
        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer=\"luecken\"}");

        // Der ganze UEMS-Export: kein Kundenname, keine Mail, keine Seriennummer, kein Boxname.
        var uems = scrape.lines().filter(l -> l.startsWith("voltpilot_uems_")).toList();
        assertThat(uems).isNotEmpty();
        assertThat(uems).noneMatch(l -> l.contains("Werke")).noneMatch(l -> l.contains("@"))
                .noneMatch(l -> l.contains("name=")).noneMatch(l -> l.contains("serial="));
        assertThat(uems).noneMatch(l -> l.contains(NUR_STEUERN.toString()))
                .noneMatch(l -> l.contains(MESSEN_ENTWURF.toString()));
    }

    // ---------------------------------------------------------------------------------------------

    private static ArbeitslisteStand liste(java.util.List<ArbeitslisteStand> stand, String name) {
        return stand.stream().filter(s -> s.liste().equals(name)).findFirst().orElseThrow();
    }

    private static long alterMinuten(ArbeitslisteStand s) {
        return java.time.Duration.between(s.aeltester(), java.time.Instant.now()).toMinutes();
    }

    /** Kundenbereich mit Unternehmen, Standort und EINER Funktion im genannten Zustand. */
    private static void kundenbereich(Statement s, UUID tenant, String funktion, String zustand)
            throws Exception {
        UUID unternehmen = UUID.randomUUID();
        UUID standort = UUID.randomUUID();
        s.execute("INSERT INTO tenant (id, name) VALUES ('" + tenant + "', 'Testvorrichtung "
                + tenant.toString().substring(0, 8) + "')");
        s.execute("INSERT INTO unternehmen (id, tenant_id, name, zeitzone) VALUES ('" + unternehmen
                + "', '" + tenant + "', 'Testvorrichtung', 'Europe/Berlin')");
        s.execute("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone,"
                + " zustand) VALUES ('" + standort + "', '" + tenant + "', '" + unternehmen
                + "', 'Werk', 'ST-1', 'Europe/Berlin', 'aktiv')");
        s.execute("INSERT INTO funktion (tenant_id, standort_id, funktion, zustand, geaendert_von)"
                + " VALUES ('" + tenant + "', '" + standort + "', '" + funktion + "', '" + zustand
                + "', 'Testvorrichtung')");
    }

    /** Eine Box-Zeile des Lücken-Melders: {@code zuletzt} ist der jüngste EINGANG (received_at). */
    private static void box(Statement s, UUID tenant, String device, String zuletzt) throws Exception {
        s.execute("INSERT INTO messreihe_luecke_stand (tenant_id, einheit, art, device_id, zuletzt)"
                + " VALUES ('" + tenant + "', 'box:" + device + "', 'box', '" + device + "', "
                + zuletzt + ")");
    }

    private static DataSource quelle(String user, String pw) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(pw);
        return ds;
    }
}
