package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.measurement.MeasurementSelectionRepository;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.Observation;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-07 IP-18b Punktzustand ({@code V20260923241500}): ein geteilter Punkt führt den
 * Punktzustand der Box weiter, gekennzeichnet mit {@code component_read_at}.
 *
 * <p>Bestand auf der Fassung davor, dann die Migration: keine Zeile ändert sich, keine trägt das
 * Kennzeichen, und die Geräteseite ({@link MeasurementSelectionRepository#latestObservations})
 * liest jeden heutigen Punkt mit Wert und Qualität wie gespeichert. Danach ein geteilter Punkt in
 * der Form, in der der Writer ihn schreibt: „zuletzt gelesen" bewegt sich mit jeder Komponente,
 * ein Wert der Box wird nicht behauptet, und die Vergleichs-Auswahl der Anlage (Box-Verlauf)
 * bietet ihn nicht an; ein späterer Wert ohne Komponente hebt das Kennzeichen auf, ohne die
 * Spalte zu nennen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsPunktzustandJeKomponenteMigrationTest {

    private static final String DIESE = "20260923241500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-00000000b118");
    private static final String ZAHL = "fronius_solar_api.grid-power";
    private static final String TEXT = "deye.hybrid_1p.inverter.device-state";
    private static final String GETEILT = "kaco_http.energy-today";
    private static final Instant T0 = Instant.parse("2027-01-18T10:00:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static MeasurementSelectionRepository geraeteseite;
    private static MeasurementHistoryService verlauf;
    private static UUID anlage;
    private static UUID box;

    private static String zeilenVorher;
    private static String zeilenNachher;
    private static long kennzeichenNachher;

    @BeforeAll
    static void migriereMitBestand() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        anlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') "
                + "RETURNING id", UUID.class, KB);
        box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", UUID.class, KB, anlage);
        // Zwei heutige Punkte, wie der Writer sie heute schreibt: Zahl und Text.
        root.update("INSERT INTO device_measurement_point_state (tenant_id, site_id, device_id, "
                        + "point_key, first_read_at, last_read_at, edge_sequence, raw_numeric, "
                        + "decoded_numeric, quality, gap, dropped_samples, catalog_version) "
                        + "VALUES (?, ?, ?, ?, ?, ?, 83401, 250, 25, 'good', false, 0, '2026.09.11.1')",
                KB, anlage, box, ZAHL, ts(T0.minusSeconds(3600)), ts(T0));
        root.update("INSERT INTO device_measurement_point_state (tenant_id, site_id, device_id, "
                        + "point_key, first_read_at, last_read_at, edge_sequence, raw_text, "
                        + "decoded_text, quality, gap, dropped_samples, catalog_version) "
                        + "VALUES (?, ?, ?, ?, ?, ?, 83402, 'RUN', 'Betrieb', 'device_error', true, 2, "
                        + "'2026.09.11.1')",
                KB, anlage, box, TEXT, ts(T0.minusSeconds(60)), ts(T0.minusSeconds(30)));
        zeilenVorher = zeilen("to_jsonb(s)");

        flyway().target(DIESE).load().migrate();
        zeilenNachher = zeilen("to_jsonb(s) - 'component_read_at'");
        kennzeichenNachher = root.queryForObject("SELECT count(*) FROM device_measurement_point_state "
                + "WHERE component_read_at IS NOT NULL", Long.class);

        flyway().load().migrate();
        JdbcTemplate app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        geraeteseite = new MeasurementSelectionRepository(app);
        verlauf = new MeasurementHistoryService(app, new MeasurementCatalog(new ObjectMapper()),
                geraeteseite);
        TenantContext.set(KB);
    }

    @AfterAll
    static void aufraeumen() {
        TenantContext.clear();
    }

    /** Keine Bestandszeile wird umgeschrieben: dieselben Spalten, dieselben Werte, kein Kennzeichen. */
    @Test
    void derBestandBleibtZeileFuerZeileOhneKennzeichen() {
        assertThat(zeilenNachher).isEqualTo(zeilenVorher).contains(ZAHL, TEXT);
        assertThat(kennzeichenNachher).isZero();
    }

    /** Die Geräteseite liest jeden heutigen Punkt mit Wert und Qualität, wie er gespeichert ist. */
    @Test
    void dieGeraeteseiteLiestDenBestandWieGespeichert() {
        Map<String, Observation> gelesen = geraeteseite.latestObservations(box);
        assertThat(gelesen.get(ZAHL))
                .isEqualTo(new Observation(T0, "250", "25", "good", false, 0L, false));
        assertThat(gelesen.get(TEXT)).isEqualTo(new Observation(T0.minusSeconds(30), "RUN",
                "Betrieb", "device_error", true, 2L, false));
    }

    /**
     * Der geteilte Punkt, wie der Writer ihn fortschreibt: „zuletzt gelesen" folgt jeder
     * Komponente, ein Wert der Box wird nie behauptet. Ein späterer Wert ohne Komponente (die
     * Anweisung von heute, ohne die Spalte) ist wieder der Wert der Box.
     */
    @Test
    void einGeteilterPunktBleibtAktuellUndBehauptetKeinenWertDerBox() {
        Instant t1 = T0.plusSeconds(60);
        root.update("INSERT INTO device_measurement_point_state (tenant_id, site_id, device_id, "
                        + "point_key, first_read_at, last_read_at, edge_sequence, raw_numeric, "
                        + "quality, gap, dropped_samples, catalog_version, component_read_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, 9001, 1000, 'good', false, 0, '2026.09.11.1', ?)",
                KB, anlage, box, GETEILT, ts(t1), ts(t1), ts(t1));
        assertThat(geraeteseite.latestObservations(box).get(GETEILT))
                .as("gelesen, je Komponente, ohne Wert")
                .isEqualTo(new Observation(t1, null, null, null, false, 0L, true));
        assertThat(vergleichbar()).as("ohne Box-Verlauf kein Vergleich auf Box-Ebene")
                .doesNotContain(GETEILT).contains(ZAHL);

        Instant t2 = t1.plusSeconds(60);
        root.update("UPDATE device_measurement_point_state SET last_read_at = ?, edge_sequence = 9002, "
                + "raw_numeric = 2000, component_read_at = ? WHERE point_key = ?", ts(t2), ts(t2), GETEILT);
        assertThat(geraeteseite.latestObservations(box).get(GETEILT).lastReadAt())
                .as("die nächste Komponente rückt „zuletzt gelesen“ weiter").isEqualTo(t2);

        Instant t3 = t2.plusSeconds(60);
        root.update("UPDATE device_measurement_point_state SET last_read_at = ?, edge_sequence = 9003, "
                + "raw_numeric = 42, decoded_numeric = 4.2 WHERE point_key = ?", ts(t3), GETEILT);
        assertThat(geraeteseite.latestObservations(box).get(GETEILT))
                .as("ein späterer Wert ohne Komponente ist wieder der Wert der Box")
                .isEqualTo(new Observation(t3, "42", "4.2", "good", false, 0L, false));
        assertThat(vergleichbar()).as("wieder ein Wert der Box, wieder vergleichbar")
                .contains(GETEILT, ZAHL);
        root.update("DELETE FROM device_measurement_point_state WHERE point_key = ?", GETEILT);
    }

    // ---- Werkzeug --------------------------------------------------------------------------

    private static List<String> vergleichbar() {
        return verlauf.comparisonOptions(anlage).stream()
                .map(MeasurementHistoryService.ComparisonOption::pointKey).toList();
    }

    private static String zeilen(String ausdruck) {
        return root.queryForObject("SELECT string_agg((" + ausdruck + ")::text, E'\\n' "
                + "ORDER BY point_key) FROM device_measurement_point_state s", String.class);
    }

    private static Timestamp ts(Instant t) {
        return Timestamp.from(t);
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
