package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.measurement.MeasurementSelectionRepository;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
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
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-07 IP-18b, Teil 1b ({@code V20260922236000} Spalte und Verdichtung, {@code
 * V20260922236500} die Schlüssel, Chunk für Chunk): der Box-Schlüssel des GETEILTEN Punkts.
 *
 * <p>Bestand auf der Fassung davor, dann die Migration: keine Zeile ändert sich, jede trägt
 * {@code edge_entity_id} NULL, der alte Schlüssel ist durch zwei partielle ersetzt, und die
 * Box-Verdichtung schreibt Zeile für Zeile dasselbe. Danach ein geteilter Punkt - zwei Komponenten
 * je Tick, auch auf der Messzeit und Sequenz eines Bestandswerts: beide liegen, der Schlüssel gilt
 * je genannter Komponente, und im Box-Verlauf (Kurve und CSV) wie in der Box-Verdichtung erscheint
 * er nicht - weder doppelt noch einfach. Seine Werte zeigt nur die Reihe.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsGeteilterPunktBoxSchluesselMigrationTest {

    /** Die erste der beiden Migrationen; der Bestand liegt auf der Fassung davor. */
    private static final String ERSTE = "20260922236000";
    private static final String DIESE = "20260922236500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final Instant JETZT = Instant.parse("2027-01-19T10:00:00Z");
    private static final Instant VON = Instant.parse("2027-01-18T00:00:00Z");
    private static final Instant BIS = Instant.parse("2027-01-18T01:00:00Z");
    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-00000000b018");
    private static final String KANAL = "deye.hybrid_1p.meter.today-energy";
    private static final MeasurementHistoryService.Erzeugung ERZEUGUNG =
            new MeasurementHistoryService.Erzeugung(JETZT, "Jonas Wendlinger", "ST-1 Werk Ahrenberg",
                    "Kunststoffwerk Ahrenberg GmbH");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static MeasurementHistoryService verlauf;
    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static long zeilenVorher;
    private static String zeilenFingerabdruckVorher;
    private static String verdichtungVorher;
    private static long zeilenNachher;
    private static long nennungenNachher;
    private static String zeilenFingerabdruckNachher;
    private static String verdichtungNachher;

    @BeforeAll
    static void migriereMitBestand() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        stammdaten();
        for (int i = 0; i < 60; i++) {
            bestandswert(VON.plusSeconds(60L * i), 1000.0 + 0.5 * i, 9000L + i, IDS.get("K5"));
        }
        verdichte();
        zeilenVorher = zaehle("SELECT count(*) FROM device_measurement_sample");
        zeilenFingerabdruckVorher = zeilenFingerabdruck();
        verdichtungVorher = verdichtung();

        flyway().target(DIESE).load().migrate();

        zeilenNachher = zaehle("SELECT count(*) FROM device_measurement_sample");
        nennungenNachher = zaehle("SELECT count(*) FROM device_measurement_sample "
                + "WHERE edge_entity_id IS NOT NULL");
        zeilenFingerabdruckNachher = zeilenFingerabdruck();
        verdichte();
        verdichtungNachher = verdichtung();

        flyway().load().migrate();
        verlauf = new MeasurementHistoryService(
                new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW))),
                new MeasurementCatalog(new ObjectMapper()),
                new MeasurementSelectionRepository(
                        new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)))),
                new SpeicherklasseHistorie(
                        new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW))),
                        new MeasurementCatalog(new ObjectMapper())),
                Clock.fixed(JETZT, ZoneOffset.UTC));
        TenantContext.set(KB);
    }

    @AfterAll
    static void aufraeumen() {
        TenantContext.clear();
    }

    /** Keine Bestandszeile wird umgeschrieben: dieselben Zeilen, dieselben Werte, keine Nennung. */
    @Test
    void derBestandBleibtZeileFuerZeileUndTraegtKeineNennung() {
        assertThat(zeilenVorher).isEqualTo(60);
        assertThat(zeilenNachher).isEqualTo(zeilenVorher);
        assertThat(nennungenNachher).isZero();
        assertThat(zeilenFingerabdruckNachher).isEqualTo(zeilenFingerabdruckVorher);
    }

    /** Die Box-Verdichtung schreibt für den Bestand Zeile für Zeile dieselben Buckets. */
    @Test
    void dieBoxVerdichtungBleibtFuerDenBestandGleich() {
        assertThat(verdichtungVorher).isNotBlank();
        assertThat(verdichtungNachher).isEqualTo(verdichtungVorher);
    }

    /** Der alte Index ist weg; ohne Nennung trägt die alte Spaltenfolge, mit Nennung die je Komponente. */
    @Test
    void zweiPartielleSchluesselErsetzenDenAlten() {
        Map<String, String> indexe = new LinkedHashMap<>();
        root.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' "
                + "AND tablename = 'device_measurement_sample'",
                rs -> { indexe.put(rs.getString(1), rs.getString(2)); });
        assertThat(indexe).doesNotContainKey("uq_device_measurement_sample_idempotency");
        assertThat(indexe.get("uq_device_measurement_sample_box"))
                .contains("UNIQUE", "(device_id, point_key, \"time\", edge_sequence)",
                        "WHERE (edge_entity_id IS NULL)");
        assertThat(indexe.get("uq_device_measurement_sample_box_komponente"))
                .contains("UNIQUE", "(device_id, point_key, edge_entity_id, \"time\", edge_sequence)",
                        "WHERE (edge_entity_id IS NOT NULL)");
    }

    /**
     * Der Kern: ein geteilter Punkt mit zwei Komponenten je Tick. Beide liegen - aufgelöst oder
     * nicht, und auch auf Messzeit und Sequenz eines Bestandswerts. Box-Verlauf (roh und
     * dekodiert, Kurve und CSV) und Box-Verdichtung sehen sie nicht: Byte für Byte dasselbe wie
     * ohne sie. Dieselbe Nennung desselben Ticks noch einmal weist der Schlüssel je Komponente ab.
     */
    @Test
    void einGeteilterPunktLiegtDoppeltUndErscheintNichtImBoxVerlauf() {
        byte[] rohVorher = csv("raw");
        byte[] dekodiertVorher = csv("decoded");
        MeasurementHistoryService.History kurveVorher = verlauf.history(IDS.get("BOX"), KANAL,
                "free", VON, BIS, "decoded", null, null);
        long imFensterVorher = zaehle("SELECT count(*) FROM device_measurement_sample "
                + "WHERE time >= '" + VON + "' AND time <= '" + BIS + "' AND quality = 'good'");

        UUID k6 = IDS.get("K6");
        UUID k7 = UUID.fromString("4e0e0000-0000-0000-0000-00000000b0f7");
        UUID k8 = UUID.fromString("4e0e0000-0000-0000-0000-00000000b0f8");
        for (int minute : List.of(10, 20, 30)) {
            Instant t = VON.plusSeconds(60L * minute);
            // Unaufgelöst, auf Messzeit UND Sequenz des Bestandswerts dieser Minute.
            geteilterWert(t, 9000L + minute, k7, null, 99_999.0);
            geteilterWert(t, 9000L + minute, k8, null, 88_888.0);
            // Aufgelöst, eine halbe Minute später: je Komponente in ihrer Reihe.
            geteilterWert(t.plusSeconds(30), 9500L + minute, IDS.get("K5"), IDS.get("K5"), 77_777.0);
            geteilterWert(t.plusSeconds(30), 9500L + minute, k6, k6, 66_666.0);
        }
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample "
                + "WHERE time >= '" + VON + "' AND time <= '" + BIS + "' AND quality = 'good'"))
                .as("alle zwölf Werte des geteilten Punkts liegen im Fenster")
                .isEqualTo(imFensterVorher + 12);

        assertThat(csv("raw")).as("Box-Verlauf roh als CSV").isEqualTo(rohVorher);
        assertThat(csv("decoded")).as("Box-Verlauf dekodiert als CSV").isEqualTo(dekodiertVorher);
        assertThat(verlauf.history(IDS.get("BOX"), KANAL, "free", VON, BIS, "decoded", null, null)
                .data()).as("die Kurve der Box").isEqualTo(kurveVorher.data());
        verdichte();
        assertThat(verdichtung()).as("die Box-Verdichtung").isEqualTo(verdichtungVorher);

        assertThatThrownBy(() -> geteilterWert(VON.plusSeconds(600), 9010L, k7, null, 99_999.0))
                .as("dieselbe Nennung desselben Ticks noch einmal")
                .isInstanceOf(DuplicateKeyException.class)
                .hasMessageContaining("uq_device_measurement_sample_box");
        // Ohne Nennung und ohne Reihe (Spiegel-Spur): nur der Box-Schlüssel kann abweisen.
        Instant ohneReihe = VON.plusSeconds(90);
        bestandswert(ohneReihe, 2000.0, 7001L, null);
        assertThatThrownBy(() -> bestandswert(ohneReihe, 2000.0, 7001L, null))
                .as("ohne Nennung bleibt der Box-Schlüssel der alte")
                .isInstanceOf(DuplicateKeyException.class)
                .hasMessageContaining("uq_device_measurement_sample_box");
    }

    // ---- Werkzeug --------------------------------------------------------------------------

    private static byte[] csv(String darstellung) {
        return verlauf.csv(verlauf.history(IDS.get("BOX"), KANAL, "free", VON, BIS, darstellung,
                null, null), ERZEUGUNG);
    }

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));
        IDS.put("K5", komponente("K-5 Unterzähler Spritzguss"));
        IDS.put("K6", komponente("K-6 Unterzähler Granulat"));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                        + "entity_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                        + "catalog_version, changed_by, apply_status, retention_class, "
                        + "long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                        + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', "
                        + "'energy_counter', 'fifteen_minute')",
                KB, IDS.get("AN2"), IDS.get("BOX"), IDS.get("K5"), KANAL);
    }

    private static UUID komponente(String label) {
        return uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                        + "device_id, communication, connection_json, created_at) VALUES (?, ?, "
                        + "'grid-meter', ?, 'grid-meter', ?, 'modbus_tcp', "
                        + "'{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') "
                        + "RETURNING id",
                KB, IDS.get("AN2"), label, IDS.get("BOX"));
    }

    /** Ein Bestandswert, wie der Writer ihn heute schreibt: ohne Nennung, mit oder ohne Reihe. */
    private static void bestandswert(Instant t, double stand, long sequenz, UUID reihe) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                        + "device_id, point_key, raw_numeric, decoded_numeric, quality, "
                        + "catalog_version, edge_sequence, aggregation_kind, long_term_cadence_s, "
                        + "entity_id, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.11.1', "
                        + "?, 'counter', 300, ?, ?)",
                Timestamp.from(t), Timestamp.from(t.plusSeconds(5)), KB, IDS.get("AN2"),
                IDS.get("BOX"), KANAL, stand, stand, sequenz, reihe,
                reihe == null ? "spiegel" : "fuehrend");
    }

    /** Ein Wert des geteilten Punkts: die Box nennt die Komponente, der Nachschlag ergab {@code reihe}. */
    private static void geteilterWert(Instant t, long sequenz, UUID genannt, UUID reihe, double wert) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                        + "device_id, point_key, raw_numeric, decoded_numeric, quality, "
                        + "catalog_version, edge_sequence, aggregation_kind, long_term_cadence_s, "
                        + "entity_id, role, edge_entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', "
                        + "'2026.09.11.1', ?, 'counter', 300, ?, ?, ?)",
                Timestamp.from(t), Timestamp.from(t.plusSeconds(5)), KB, IDS.get("AN2"),
                IDS.get("BOX"), KANAL, wert, wert, sequenz, reihe, reihe == null ? null : "fuehrend",
                genannt);
    }

    private static void verdichte() {
        root.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_5m', "
                + "INTERVAL '5 minutes', TIMESTAMPTZ '" + VON + "')");
    }

    private static String verdichtung() {
        return root.queryForObject("SELECT coalesce(string_agg(to_jsonb(r)::text, '|' ORDER BY "
                + "r.device_id, r.point_key, r.bucket), '') FROM device_measurement_rollup_5m r",
                String.class);
    }

    /** Jede Zeile mit ihren Spalten von VOR der Migration - die neue Spalte zählt nicht mit. */
    private static String zeilenFingerabdruck() {
        return root.queryForObject("SELECT md5(string_agg((to_jsonb(s) - 'edge_entity_id')::text, "
                + "'|' ORDER BY s.time, s.edge_sequence)) FROM device_measurement_sample s",
                String.class);
    }

    private static long zaehle(String sql) {
        Long n = root.queryForObject(sql, Long.class);
        return n == null ? -1 : n;
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(ERSTE);
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
