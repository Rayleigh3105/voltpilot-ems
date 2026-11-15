package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.tenant.TenantFilter;
import com.zaxxer.hikari.HikariDataSource;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Die Admin-Rolle hat zwei Pools (Lasttest vp-lasttest, Befunde B3/B4, Rang 7): während einer HTTP-Anfrage (vom
 * {@link TenantFilter} markiert) den Anfrage-Pool, sonst - Läufer, Sammler, MQTT-Listener - den kleinen
 * Hintergrund-Pool. Belegt an einer echten Datenbank mit den Beans aus {@link DataSourceConfig}:
 *
 * <ul>
 *   <li>dieselbe Weiche wie für die App-Rolle: außerhalb einer Anfrage der Hintergrund-Pool, im Filter der
 *       Anfrage-Pool (sichtbar am {@code application_name} der Verbindung);
 *   <li>dieselbe Rolle auf beiden Seiten - RLS-Umgehung und Rechte ändern sich nicht;
 *   <li>der Kern: hält Hintergrundarbeit alle Hintergrund-Verbindungen, antwortet eine Anfrage trotzdem sofort -
 *       vorher teilten sich beide die vier Verbindungen EINES Pools;
 *   <li>der Hintergrund-Pool hält im Ruhezustand keine Verbindung (das Gesamtbudget je Instanz wächst nicht).
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class AdminPoolTrennungTest {

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    private static HikariDataSource anfrage;
    private static HikariDataSource hintergrund;
    private static DataSource admin;

    @BeforeAll
    static void pools() {
        DataSourceConfig config = new DataSourceConfig();
        anfrage = config.adminRequestDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
        // Klein gesetzt, damit der Test den vollen Hintergrund-Pool billig erreicht (Vorgabe 4, application.yml).
        hintergrund = config.adminBackgroundDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword(), 2);
        hintergrund.setConnectionTimeout(1_000);
        admin = config.adminDataSource(anfrage, hintergrund);
    }

    @AfterAll
    static void zu() {
        anfrage.close();
        hintergrund.close();
    }

    private static String anwendung(JdbcTemplate jdbc) {
        return jdbc.queryForObject("SELECT current_setting('application_name') || '|' || current_user",
                String.class);
    }

    /** Führt {@code arbeit} so aus, wie eine HTTP-Anfrage hinter dem TenantFilter läuft. */
    private static <T> T inAnfrage(java.util.function.Supplier<T> arbeit) throws Exception {
        AtomicReference<T> ergebnis = new AtomicReference<>();
        new TenantFilter().doFilter(new MockHttpServletRequest("GET", "/api/v1/admin/fleet"),
                new MockHttpServletResponse(), new MockFilterChain() {
                    @Override
                    public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res) {
                        ergebnis.set(arbeit.get());
                    }
                });
        return ergebnis.get();
    }

    @Test
    void ausserhalbEinerAnfrageDerHintergrundPoolImFilterDerAnfragePoolMitDerselbenRolle() throws Exception {
        JdbcTemplate jdbc = new JdbcTemplate(admin);
        String draussen = anwendung(jdbc);
        String drinnen = inAnfrage(() -> anwendung(jdbc));
        assertThat(draussen).startsWith("voltpilot-api admin hintergrund|");
        assertThat(drinnen).startsWith("voltpilot-api admin|");
        assertThat(draussen.substring(draussen.indexOf('|'))).as("dieselbe Rolle")
                .isEqualTo(drinnen.substring(drinnen.indexOf('|')));
    }

    @Test
    void volleHintergrundarbeitHaeltKeineAnfrageAuf() throws Exception {
        JdbcTemplate jdbc = new JdbcTemplate(admin);
        ExecutorService laeufer = Executors.newFixedThreadPool(2);
        CountDownLatch belegt = new CountDownLatch(2);
        try {
            List<CompletableFuture<Void>> lang = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                lang.add(CompletableFuture.runAsync(() -> jdbc.execute((java.sql.Connection c) -> {
                    belegt.countDown();
                    try (var s = c.createStatement()) {
                        s.execute("SELECT pg_sleep(4)");
                    }
                    return null;
                }), laeufer));
            }
            assertThat(belegt.await(10, TimeUnit.SECONDS)).isTrue();
            assertThat(hintergrund.getHikariPoolMXBean().getActiveConnections()).isEqualTo(2);

            Instant start = Instant.now();
            String drinnen = inAnfrage(() -> anwendung(jdbc));
            Duration dauer = Duration.between(start, Instant.now());
            assertThat(drinnen).startsWith("voltpilot-api admin|");
            assertThat(dauer).as("die Anfrage wartet nicht auf die Läufer").isLessThan(Duration.ofSeconds(2));

            // Ein dritter Läufer wartet dagegen - die Enge bleibt im Hintergrund.
            Instant dritter = Instant.now();
            try {
                anwendung(jdbc);
            } catch (org.springframework.jdbc.CannotGetJdbcConnectionException erwartet) {
                // connectionTimeout 1 s: der Hintergrund-Pool ist voll
            }
            assertThat(Duration.between(dritter, Instant.now())).isGreaterThanOrEqualTo(Duration.ofMillis(900));
            CompletableFuture.allOf(lang.toArray(CompletableFuture[]::new)).get(20, TimeUnit.SECONDS);
        } finally {
            laeufer.shutdownNow();
        }
    }

    /**
     * Beim Start öffnet die Anwendung den Anfrage-Pool vor (früher taten das Start-Läufer nebenbei am gemeinsamen
     * Pool): die erste Kunden-Anfrage nach einem Start zahlt keinen Verbindungsaufbau.
     */
    @Test
    void derAnfragePoolWirdBeimStartVorgewaermt() {
        HikariDataSource kalt = new DataSourceConfig().adminRequestDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
        try {
            assertThat(kalt.getHikariPoolMXBean()).as("vorher kalt").isNull();
            new DataSourceConfig().adminAnfragePoolVorwaermen(kalt).onApplicationEvent(null);
            assertThat(kalt.getHikariPoolMXBean()).isNotNull();
            assertThat(kalt.getHikariPoolMXBean().getTotalConnections()).isPositive();
        } finally {
            kalt.close();
        }
    }

    /** Die ausgelieferte Vorgabe: so viele Hintergrund-Verbindungen, wie der Hintergrund bisher höchstens bekam. */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteGroesseDesHintergrundPoolsIstVier() throws Exception {
        java.util.Map<String, Object> yml;
        try (java.io.InputStream in = getClass().getResourceAsStream("/application.yml")) {
            yml = (java.util.Map<String, Object>) new org.yaml.snakeyaml.Yaml().loadAll(in).iterator().next();
        }
        Object node = yml;
        for (String key : new String[] {"voltpilot", "admin-datasource", "background-max-size"}) {
            node = ((java.util.Map<String, Object>) node).get(key);
        }
        assertThat(node).isEqualTo("${DB_POOL_ADMIN_BACKGROUND_MAX_SIZE:4}");
    }

    @Test
    void derHintergrundPoolHaeltImRuhezustandKeineVerbindung() {
        assertThat(hintergrund.getMinimumIdle()).isZero();
        assertThat(hintergrund.getMaximumPoolSize()).isEqualTo(2);
        assertThat(anfrage.getMaximumPoolSize()).as("Anfrage-Seite unverändert").isEqualTo(4);
        assertThat(anfrage.getPoolName()).isEqualTo("voltpilot-admin-pool");
        assertThat(hintergrund.getPoolName()).isEqualTo("voltpilot-admin-background-pool");
    }
}
