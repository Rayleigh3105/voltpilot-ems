package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Das 15-Minuten-Rollup einer Mehr-Box-Anlage liest die Anlagen-Summen an der führenden Box
 * ({@code V20260922020000}, AP-15 Folgepunkt {@code vp-uems-v15-folge-leser-je-anlage}; W2, B1).
 *
 * <p>Eine Datenbank, zwei Läufe derselben Rohwerte: erst die Prozedur von
 * {@code V20260712000000} (die Fassung vor dieser Migration), dann die neue. So steht der Fehler
 * („rot ohne Heilung“: R3 mit 367 kW am Netzzähler und 77 kW am Abgang ergibt 222 kW) neben der
 * Heilung, und jede Anlage, für die sich nichts ändern darf — Ein-Box-Anlage, Mehr-Box-Anlage
 * ohne führende Box, führende Box ausgebaut —, wird Zeile für Zeile verglichen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsRollupMehrBoxMigrationTest {

    private static final String DIESE = "20260922020000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_dev_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_dev_pw";

    /** Drei Viertelstunden am Dienstag 15.09.2026 (UTC), dazu der Beginn des Laufs. */
    private static final String AB = "2026-09-15T10:00:00Z";
    private static final String R3 = "2026-09-15T10:00:00Z";
    private static final String PV = "2026-09-15T10:15:00Z";
    private static final String OHNE_PAAR = "2026-09-15T10:30:00Z";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static UUID tenant;

    private static Map<String, String> vorher;
    private static Map<String, String> nachMigration;
    private static Map<String, String> nachher;

    @BeforeAll
    static void zweiLaeufe() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        tenant = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", tenant);

        // Mehr-Box-Anlage mit führender Box Halle 1 (liest den Netzzähler) und Box Verwaltung
        // (liest ihren Abgang); der geplante Speicher hängt an Halle 1.
        anlage("ZWEI");
        box("ZWEI", "HALLE");
        box("ZWEI", "VERWALTUNG");
        fuehrt("ZWEI", "HALLE");
        speicher("ZWEI", "HALLE");
        // R3: 367 kW am Netzzähler, 77 kW am Abgang Verwaltung, beide ohne PV.
        senden("HALLE", R3, 0, 367, 367, 0, 50.0);
        senden("VERWALTUNG", R3, 5, 77, 77, 0, null);
        // PV an beiden Boxen, jede Box mit ausgeglichener eigener Bilanz (kein Speicherfluss):
        // Halle 1 240 kW Bezug, 20 kW PV, Last 260 kW; Verwaltung −40 kW (speist 40 kW in den
        // Abgang), 60 kW PV, Last 20 kW. Die Anlage: 240 kW Bezug, 80 kW PV, 320 kW Last.
        senden("HALLE", PV, 0, 240, 260, 20, 50.0);
        senden("VERWALTUNG", PV, 5, -40, 20, 60, null);
        // Verwaltung sendet nur PV: ihre Nettoabgabe ist unbekannt → Last unbekannt.
        senden("HALLE", OHNE_PAAR, 0, 300, 300, 0, 50.0);
        senden("VERWALTUNG", OHNE_PAAR, 5, null, null, 30, null);

        // Ein-Box-Anlage mit gespeicherter führender Box; die letzte Probe jeder Viertelstunde
        // ohne Speicherstand (heute: soc_last NULL) — das darf sich nicht ändern.
        anlage("EINS");
        box("EINS", "EINZIGE");
        fuehrt("EINS", "EINZIGE");
        speicher("EINS", "EINZIGE");
        senden("EINZIGE", R3, 0, 120, 150, 30, 40.0);
        senden("EINZIGE", PV, 0, -25, 35, 70, 41.0);
        root.update("UPDATE telemetry SET soc_pct = NULL WHERE device_id = ? AND time IN (?::timestamptz + interval '890 seconds', ?::timestamptz + interval '890 seconds')",
                IDS.get("EINZIGE"), R3, PV);

        // Mehr-Box-Anlage OHNE gespeicherte führende Box: bleibt beim Verhalten von heute.
        anlage("OHNE");
        box("OHNE", "O1");
        box("OHNE", "O2");
        senden("O1", R3, 0, 367, 367, 0, null);
        senden("O2", R3, 5, 77, 77, 0, null);

        // Mehr-Box-Anlage, deren gespeicherte führende Box ausgebaut ist: keine führt.
        anlage("AUS");
        box("AUS", "A1");
        box("AUS", "A2");
        fuehrt("AUS", "A1");
        root.update("UPDATE device SET status = 'ausgebaut', ausgebaut_am = ?::timestamptz WHERE id = ?", AB, IDS.get("A1"));
        senden("A1", R3, 0, 367, 367, 0, null);
        senden("A2", R3, 5, 77, 77, 0, null);

        root.update("CALL refresh_telemetry_rollups(?::timestamptz)", AB);
        vorher = rollups();

        flyway().target(DIESE).load().migrate();
        nachMigration = rollups();

        root.update("CALL refresh_telemetry_rollups(?::timestamptz)", AB);
        nachher = rollups();
    }

    // =========================================================================== rot ohne Heilung

    @Test
    void vorher_mittelt_das_rollup_die_zeilen_beider_boxen_zu_222_kw() {
        assertThat(kw(vorher, "ZWEI", R3, "grid_import_kwh")).isEqualByComparingTo("222");
    }

    // =========================================================================== Heilung

    @Test
    void r3_nachher_liest_der_bezug_den_netzzaehler_der_fuehrenden_box() {
        assertThat(kw(nachher, "ZWEI", R3, "grid_import_kwh")).isEqualByComparingTo("367");
        assertThat(kw(nachher, "ZWEI", R3, "grid_export_kwh")).isEqualByComparingTo("0");
        // Die Last ist die am Netzzähler: 367 + (77 − 77) — der Abgang liegt dahinter.
        assertThat(kw(nachher, "ZWEI", R3, "load_kwh")).isEqualByComparingTo("367");
    }

    @Test
    void pv_ist_die_summe_der_boxen_und_die_last_kennt_die_pv_der_zweiten_box() {
        assertThat(kw(vorher, "ZWEI", PV, "pv_kwh")).isEqualByComparingTo("40");
        assertThat(kw(vorher, "ZWEI", PV, "load_kwh")).isEqualByComparingTo("140");
        assertThat(kw(nachher, "ZWEI", PV, "pv_kwh")).isEqualByComparingTo("80");
        assertThat(kw(nachher, "ZWEI", PV, "grid_import_kwh")).isEqualByComparingTo("240");
        assertThat(kw(nachher, "ZWEI", PV, "grid_export_kwh")).isEqualByComparingTo("0");
        // 260 kW der führenden Box + (20 − (−40)) kW Nettoabgabe der Verwaltung = 320 kW:
        // Bezug 240 = Last 320 − PV 80, die Bilanz der Anlage geht auf.
        assertThat(kw(nachher, "ZWEI", PV, "load_kwh")).isEqualByComparingTo("320");
        assertThat(kw(nachher, "ZWEI", PV, "battery_charge_kwh")).isEqualByComparingTo("0");
        assertThat(kw(nachher, "ZWEI", PV, "battery_discharge_kwh")).isEqualByComparingTo("0");
    }

    @Test
    void ohne_nettoabgabe_der_zweiten_box_ist_die_last_unbekannt_nie_die_zu_kleine() {
        assertThat(wert(nachher, "ZWEI", OHNE_PAAR, "load_kwh")).isNull();
        assertThat(kw(nachher, "ZWEI", OHNE_PAAR, "grid_import_kwh")).isEqualByComparingTo("300");
        assertThat(kw(nachher, "ZWEI", OHNE_PAAR, "pv_kwh")).isEqualByComparingTo("30");
    }

    @Test
    void der_speicherstand_kommt_von_der_box_des_speichers() {
        // Vorher: die letzte Probe der Viertelstunde ist die der Verwaltung, ohne Speicherstand.
        assertThat(wert(vorher, "ZWEI", R3, "soc_last_pct")).isNull();
        assertThat(wert(nachher, "ZWEI", R3, "soc_last_pct")).isEqualTo("50.00");
        assertThat(wert(nachher, "ZWEI", R3, "soc_min_pct")).isEqualTo("50.00");
        assertThat(wert(nachher, "ZWEI", R3, "n_samples")).isEqualTo("180");
    }

    @Test
    void die_stunden_und_tagesstufe_summieren_die_geheilten_viertelstunden() {
        String stunde = zeile(nachher, "1h", "ZWEI", "2026-09-15T10:00:00Z");
        assertThat(stunde).contains("\"grid_import_kwh\": 226.750000");
    }

    // =========================================================================== Bestand

    @Test
    void die_migration_selbst_rechnet_keinen_bucket_neu() {
        assertThat(nachMigration).isEqualTo(vorher);
    }

    @Test
    void ein_box_anlage_ohne_fuehrung_und_ausgebaute_fuehrung_bleiben_zeile_fuer_zeile() {
        for (String anlage : List.of("EINS", "OHNE", "AUS")) {
            Map<String, String> v = nurAnlage(vorher, anlage);
            assertThat(v).as(anlage).isNotEmpty();
            assertThat(nurAnlage(nachher, anlage)).as(anlage).isEqualTo(v);
        }
        assertThat(kw(nachher, "OHNE", R3, "grid_import_kwh")).isEqualByComparingTo("222");
        assertThat(wert(nachher, "EINS", R3, "soc_last_pct")).isNull();
    }

    // =========================================================================== Hilfen

    private static void anlage(String name) {
        IDS.put(name, root.queryForObject(
                "INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class, tenant, name));
    }

    private static void box(String anlage, String name) {
        IDS.put(name, root.queryForObject(
                "INSERT INTO device (tenant_id, site_id, external_ref, status) "
                        + "VALUES (?, ?, ?, 'claimed') RETURNING id",
                UUID.class, tenant, IDS.get(anlage), "VP-BOX-" + name));
    }

    private static void fuehrt(String anlage, String box) {
        root.update("UPDATE site SET lead_device_id = ? WHERE id = ?", IDS.get(box), IDS.get(anlage));
    }

    private static void speicher(String anlage, String box) {
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                        + "max_discharge_kw, device_id, is_primary) VALUES (?, ?, 'battery', 100, 50, 50, ?, TRUE)",
                tenant, IDS.get(anlage), IDS.get(box));
    }

    /** 90 Proben im 10-s-Takt über die Viertelstunde, um {@code versatz} Sekunden verschoben. */
    private static void senden(String box, String viertelstunde, int versatz, Integer power, Integer load,
            Integer pv, Double soc) {
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, load_kw, "
                        + "pv_power_kw, soc_pct) "
                        + "SELECT ?::timestamptz + make_interval(secs => i * 10 + ?), ?, d.site_id, d.id, "
                        + "?::numeric, ?::numeric, ?::numeric, ?::numeric "
                        + "FROM generate_series(0, 89) i, device d WHERE d.id = ?",
                viertelstunde, versatz, tenant, power, load, pv, soc, IDS.get(box));
    }

    /** Jede Zeile der drei Stufen als Text, Schlüssel „Stufe/Anlage/Bucket“. */
    private static Map<String, String> rollups() {
        Map<String, String> aus = new LinkedHashMap<>();
        for (String stufe : List.of("15m", "1h", "1d")) {
            root.query("SELECT site_id, to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS b, "
                            + "(to_jsonb(r) - 'site_id' - 'bucket' - 'tenant_id')::text AS z "
                            + "FROM telemetry_rollup_" + stufe + " r ORDER BY site_id, bucket",
                    rs -> {
                        aus.put(stufe + "/" + name(UUID.fromString(rs.getString("site_id"))) + "/" + rs.getString("b"),
                                rs.getString("z"));
                    });
        }
        return aus;
    }

    private static String name(UUID id) {
        return IDS.entrySet().stream().filter(e -> e.getValue().equals(id)).map(Map.Entry::getKey)
                .findFirst().orElse(id.toString());
    }

    private static Map<String, String> nurAnlage(Map<String, String> alle, String anlage) {
        return alle.entrySet().stream().filter(e -> e.getKey().split("/")[1].equals(anlage))
                .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue, (a, b) -> a, LinkedHashMap::new));
    }

    private static String zeile(Map<String, String> alle, String stufe, String anlage, String bucket) {
        String z = alle.get(stufe + "/" + anlage + "/" + bucket);
        assertThat(z).as(stufe + "/" + anlage + "/" + bucket).isNotNull();
        return z;
    }

    /** Ein Feld der 15m-Zeile als Text, {@code null} für JSON-null. */
    private static String wert(Map<String, String> alle, String anlage, String bucket, String feld) {
        String z = zeile(alle, "15m", anlage, bucket);
        return root.queryForObject("SELECT (?::jsonb) ->> ?", String.class, z, feld);
    }

    /** Eine Energie der 15m-Zeile als mittlere Leistung (kWh × 4). */
    private static BigDecimal kw(Map<String, String> alle, String anlage, String bucket, String feld) {
        String w = wert(alle, anlage, bucket, feld);
        assertThat(w).as(anlage + "/" + bucket + "/" + feld).isNotNull();
        return new BigDecimal(w).multiply(BigDecimal.valueOf(4));
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
