package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Betriebsabfrage {@code tools/betriebsabfragen/katalog-zaehler-einheiten-nutzung.sql} gegen die
 * ENTWICKLUNGS-DB, wie das Profil {@code local} sie baut (Migrationen + {@code db/dev}): dort hängt keiner
 * der 71 Zähler-Messpunkte ohne Anzeige-Einheit an einer Anlage. Danach beweist eine Auswahl, ein
 * konkreter OCPP-Messwert und eine Quellenbindung, dass die Abfrage sie findet — Vorlage UND konkreter
 * Schlüssel —, damit dieselbe Datei im Bestand eine belastbare Zahl liefert. Ohne Spring, ohne Docker
 * übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class KatalogEinheitenNutzungAbfrageTest {

    private static final Path ABFRAGE = Path.of("..", "..", "tools", "betriebsabfragen",
            "katalog-zaehler-einheiten-nutzung.sql");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void entwicklungsDb() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .outOfOrder(true)
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"))
                .load()
                .migrate();
    }

    private static Connection verbindung() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    /** Gruppe → [katalog, ausgewählt, Anlagen mit Auswahl, mit Messwerten, Anlagen mit Messwerten, Messstellen]. */
    private static Map<String, List<Long>> zaehle() throws Exception {
        Map<String, List<Long>> aus = new LinkedHashMap<>();
        try (Connection c = verbindung(); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(Files.readString(ABFRAGE))) {
            while (rs.next()) {
                aus.put(rs.getString("gruppe"), List.of(rs.getLong("katalog_punkte"),
                        rs.getLong("punkte_ausgewaehlt"), rs.getLong("anlagen_mit_auswahl"),
                        rs.getLong("punkte_mit_messwerten_90d"), rs.getLong("anlagen_mit_messwerten_90d"),
                        rs.getLong("messstellen_gespeist")));
            }
        }
        return aus;
    }

    @Test
    void inDerEntwicklungsDbHaengtKeinerAnEinerAnlageUndDieAbfrageFindetJedeSpur() throws Exception {
        assertThat(zaehle()).as("Entwicklungs-DB: kein Zähler ohne Anzeige-Einheit in Benutzung")
                .containsExactly(
                        Map.entry("ohne Einheit", List.of(41L, 0L, 0L, 0L, 0L, 0L)),
                        Map.entry("VAh", List.of(25L, 0L, 0L, 0L, 0L, 0L)),
                        Map.entry("0,1 kWh", List.of(4L, 0L, 0L, 0L, 0L, 0L)),
                        Map.entry("Wmin", List.of(1L, 0L, 0L, 0L, 0L, 0L)));

        UUID tenant;
        UUID site;
        UUID device;
        try (Connection c = verbindung(); Statement s = c.createStatement()) {
            try (ResultSet rs = s.executeQuery("SELECT id, tenant_id, site_id FROM device ORDER BY id LIMIT 1")) {
                assertThat(rs.next()).as("die Entwicklungs-DB hat ein Gerät").isTrue();
                device = rs.getObject(1, UUID.class);
                tenant = rs.getObject(2, UUID.class);
                site = rs.getObject(3, UUID.class);
            }
            String kopf = "'" + tenant + "','" + site + "','" + device + "'";
            // Eine Auswahl an der Vorlage (KACO), ein Messwert am KONKRETEN Schlüssel (OCPP, Einheit Wh).
            s.execute("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, point_key, enabled,"
                    + " cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status,"
                    + " retention_class, long_term_strategy) VALUES (" + kopf + ", 'kaco_http.energy-total', true,"
                    + " 300, 1, now(), '2026.08.26.3', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute')");
            s.execute("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id,"
                    + " point_key, raw_text, decoded_numeric, quality, catalog_version, edge_sequence,"
                    + " aggregation_kind, long_term_cadence_s, gap, dropped_samples) VALUES (now() - interval"
                    + " '5 minutes', now(), " + kopf + ", 'ocpp.1_6.metervalues.energy.active.import.register"
                    + ".context[sample-periodic].format[raw].phase[none].location[outlet].unit[wh]', '12345.6',"
                    + " 12345.6, 'good', '2026.08.26.3', 1, 'counter', 300, false, 0)");
            s.execute("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id,"
                    + " point_key, raw_text, decoded_numeric, quality, catalog_version, edge_sequence,"
                    + " aggregation_kind, long_term_cadence_s, gap, dropped_samples) VALUES (now() - interval"
                    + " '4 minutes', now(), " + kopf + ", 'shelly.gen1.meter[0].meters[1].total', '600',"
                    + " 600, 'good', '2026.08.26.3', 2, 'counter', 300, false, 0)");
            // Ein Messwert vor der Frist und ein fremder Wh-Zähler zählen nicht.
            s.execute("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id,"
                    + " point_key, raw_text, decoded_numeric, quality, catalog_version, edge_sequence,"
                    + " aggregation_kind, long_term_cadence_s, gap, dropped_samples) VALUES"
                    + " (now() - interval '100 days', now(), " + kopf + ", 'sunspec.model_203.totvahimp', '1', 1,"
                    + " 'good', '2026.08.26.3', 3, 'counter', 300, false, 0),"
                    + " (now() - interval '3 minutes', now(), " + kopf + ", 'sunspec.model_203.totwhimp', '1', 1,"
                    + " 'good', '2026.08.26.3', 4, 'counter', 300, false, 0)");
        }

        Map<String, List<Long>> danach = zaehle();
        assertThat(danach.get("0,1 kWh")).as("Auswahl an der Vorlage").isEqualTo(List.of(4L, 1L, 1L, 0L, 0L, 0L));
        assertThat(danach.get("ohne Einheit")).as("OCPP am konkreten Schlüssel").isEqualTo(List.of(41L, 0L, 0L, 1L, 1L, 0L));
        assertThat(danach.get("Wmin")).as("zwei Indizes im Schlüssel").isEqualTo(List.of(1L, 0L, 0L, 1L, 1L, 0L));
        assertThat(danach.get("VAh")).as("vor der Frist zählt nicht").isEqualTo(List.of(25L, 0L, 0L, 0L, 0L, 0L));
    }
}
