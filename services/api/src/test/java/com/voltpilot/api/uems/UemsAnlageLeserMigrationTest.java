package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.repo.SeriesRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
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
 * Eine Regel „welche Größe von welcher Box“, drei Nutzer ({@code V20260922170000}, AP-15 Folgepaket
 * {@code vp-uems-v15-folge-mehrbox-restleser}; W2, B1).
 *
 * <p>Die Zwei-Box-Anlage aus {@code UemsRollupMehrBoxMigrationTest} (R3: 367 kW am Netzzähler der
 * führenden Box, 77 kW am Abgang der zweiten; gemittelt 222 kW) und ihre drei Nachbarn, für die sich
 * nichts ändern darf. Bewiesen wird: die Prozedur rechnet über {@code telemetry_anlage_15m} Zeile für
 * Zeile dasselbe wie mit {@code V20260922020000}; ein Geräte-Purge baut die Buckets der Anlage
 * genau so wieder auf wie die Prozedur, auch einen Bucket weit vor dem 7-Tage-Fenster des Jobs; die
 * Tagesansicht zeigt die Werte des Rollups; die Forecast-Abfragen ({@code voltpilot_forecast.anlage},
 * dieselben SQL-Texte) lesen die Anlagen-Summe; jede Ein-Box-Anlage bleibt Zeichen für Zeichen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsAnlageLeserMigrationTest {

    private static final String DIESE = "20260922170000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_dev_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_dev_pw";

    /** Weit vor dem 7-Tage-Fenster des Jobs; der Beginn jedes Laufs. */
    private static final String ALT = "2026-08-03T10:00:00Z";
    private static final String R3 = "2026-09-15T10:00:00Z";
    private static final String PV = "2026-09-15T10:15:00Z";
    private static final String OHNE_PAAR = "2026-09-15T10:30:00Z";
    /** Der Berliner Tag 15.09.2026. */
    private static final Instant TAG_VON = Instant.parse("2026-09-14T22:00:00Z");
    private static final Instant TAG_BIS = Instant.parse("2026-09-15T22:00:00Z");

    /** Die Tagesansicht vor diesem Paket, wörtlich (HistoryRepository#dayBuckets, CTE b). */
    private static final String TAG_VORHER = "SELECT time_bucket('15 minutes', time) AS bucket,"
            + "         avg(pv_power_kw) * 0.25 AS pv_kwh,"
            + "         avg(load_kw) * 0.25 AS load_kwh,"
            + "         avg(CASE WHEN power_kw IS NOT NULL"
            + "                  THEN greatest(power_kw, 0) END) * 0.25 AS grid_import_kwh,"
            + "         avg(CASE WHEN power_kw IS NOT NULL"
            + "                  THEN greatest(-power_kw, 0) END) * 0.25 AS grid_export_kwh,"
            + "         avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL"
            + "                       AND pv_power_kw IS NOT NULL"
            + "                  THEN greatest(power_kw - load_kw + pv_power_kw, 0)"
            + "             END) * 0.25 AS battery_charge_kwh,"
            + "         avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL"
            + "                       AND pv_power_kw IS NOT NULL"
            + "                  THEN greatest(-(power_kw - load_kw + pv_power_kw), 0)"
            + "             END) * 0.25 AS battery_discharge_kwh,"
            + "         min(soc_pct) AS soc_min_pct, max(soc_pct) AS soc_max_pct,"
            + "         last(soc_pct, time) AS soc_last_pct"
            + "  FROM telemetry WHERE site_id = ? AND time >= ? AND time < ?"
            + "  GROUP BY 1 ORDER BY 1";
    private static final String TAG_NACHHER = "SELECT bucket, pv_kwh, load_kwh, grid_import_kwh, "
            + "grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, soc_min_pct, soc_max_pct, "
            + "soc_last_pct FROM telemetry_anlage_15m(?, ?, ?) ORDER BY 1";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static UUID tenant;

    private static Map<String, String> vorher;
    private static Map<String, String> nachMigration;
    private static Map<String, String> nachher;
    private static Map<String, String> tagVorher;
    private static String altGemischtVorPurge;
    private static Map<String, String> nachPurge;
    private static Map<String, String> nachEinBoxPurge;
    private static Map<String, String> prozedurNachPurge;

    @BeforeAll
    static void laeufe() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        tenant = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", tenant);

        // Die Zwei-Box-Anlage aus PR 1040, dazu eine dritte, kleine PV-Box, deren Aufzeichnungen
        // später gelöscht werden (Geräte-Purge).
        anlage("ZWEI");
        box("ZWEI", "HALLE");
        box("ZWEI", "VERWALTUNG");
        box("ZWEI", "DRITTE");
        fuehrt("ZWEI", "HALLE");
        speicher("ZWEI", "HALLE");
        senden("HALLE", R3, 0, 367, 367, 0, 50.0);
        senden("VERWALTUNG", R3, 5, 77, 77, 0, null);
        senden("HALLE", PV, 0, 240, 260, 20, 50.0);
        senden("VERWALTUNG", PV, 5, -40, 20, 60, null);
        senden("HALLE", OHNE_PAAR, 0, 300, 300, 0, 50.0);
        senden("VERWALTUNG", OHNE_PAAR, 5, null, null, 30, null);
        // Der alte Bucket: R3 noch einmal, und die dritte Box speist 10 kW PV in ihren Abgang.
        senden("HALLE", ALT, 0, 367, 367, 0, 50.0);
        senden("VERWALTUNG", ALT, 5, 77, 77, 0, null);
        senden("DRITTE", ALT, 7, -10, 0, 10, null);

        anlage("EINS");
        box("EINS", "EINZIGE");
        fuehrt("EINS", "EINZIGE");
        speicher("EINS", "EINZIGE");
        senden("EINZIGE", ALT, 0, 90, 100, 10, 30.0);
        senden("EINZIGE", R3, 0, 120, 150, 30, 40.0);
        senden("EINZIGE", PV, 0, -25, 35, 70, 41.0);
        root.update("UPDATE telemetry SET soc_pct = NULL WHERE device_id = ? AND time IN (?::timestamptz + interval '890 seconds', ?::timestamptz + interval '890 seconds')",
                IDS.get("EINZIGE"), R3, PV);

        anlage("OHNE");
        box("OHNE", "O1");
        box("OHNE", "O2");
        senden("O1", R3, 0, 367, 367, 0, null);
        senden("O2", R3, 5, 77, 77, 0, null);

        anlage("AUS");
        box("AUS", "A1");
        box("AUS", "A2");
        fuehrt("AUS", "A1");
        root.update("UPDATE device SET status = 'ausgebaut', ausgebaut_am = ?::timestamptz WHERE id = ?", R3, IDS.get("A1"));
        senden("A1", R3, 0, 367, 367, 0, null);
        senden("A2", R3, 5, 77, 77, 0, null);

        root.update("CALL refresh_telemetry_rollups(?::timestamptz)", ALT);
        vorher = rollups();
        tagVorher = new LinkedHashMap<>();
        for (String anlage : List.of("ZWEI", "EINS", "OHNE", "AUS")) {
            tagVorher.put(anlage, zeilen(TAG_VORHER, IDS.get(anlage), ts(TAG_VON), ts(TAG_BIS)));
        }

        flyway().load().migrate();
        nachMigration = rollups();

        root.update("CALL refresh_telemetry_rollups(?::timestamptz)", ALT);
        nachher = rollups();

        // Der alte Bucket der Zwei-Box-Anlage steht, wie vor der Heilung gerechnet, gemittelt da
        // (Job-Fenster 7 Tage; genau das, was die alte Java-Kopie nach einem Purge schrieb).
        altGemischtVorPurge = root.queryForObject(
                "SELECT (avg(CASE WHEN power_kw IS NOT NULL THEN greatest(power_kw, 0) END) * 0.25)::numeric(14, 6)::text "
                        + "FROM telemetry WHERE site_id = ? AND time_bucket('15 minutes', time) = ?::timestamptz "
                        + "AND device_id <> ?",
                String.class, IDS.get("ZWEI"), ALT, IDS.get("DRITTE"));
        for (String stufe : List.of("15m", "1h")) {
            root.update("UPDATE telemetry_rollup_" + stufe + " SET grid_import_kwh = ?::numeric "
                    + "WHERE site_id = ? AND bucket = ?::timestamptz", altGemischtVorPurge, IDS.get("ZWEI"), ALT);
        }

        als(tenant, () -> new SeriesRepository(app).purgeDeviceRecordings(IDS.get("DRITTE"), IDS.get("ZWEI"), null));
        nachPurge = rollups();
        // Ein Purge an der Ein-Box-Anlage, der keine Zeile trifft: der Neuaufbau allein.
        als(tenant, () -> new SeriesRepository(app).purgeDeviceRecordings(IDS.get("EINZIGE"), IDS.get("EINS"),
                Instant.parse("2020-01-01T00:00:00Z")));
        nachEinBoxPurge = rollups();

        for (String stufe : List.of("15m", "1h", "1d")) {
            root.update("DELETE FROM telemetry_rollup_" + stufe + " WHERE site_id = ?", IDS.get("ZWEI"));
        }
        root.update("CALL refresh_telemetry_rollups(?::timestamptz)", ALT);
        prozedurNachPurge = rollups();
    }

    // =========================================================================== die Prozedur

    @Test
    void die_migration_rechnet_keinen_bucket_neu() {
        assertThat(nachMigration).isEqualTo(vorher);
    }

    @Test
    void die_prozedur_rechnet_ueber_die_funktion_zeile_fuer_zeile_wie_v20260922020000() {
        assertThat(nachher).isEqualTo(vorher);
        assertThat(kw(nachher, "ZWEI", R3, "grid_import_kwh")).isEqualByComparingTo("367");
        assertThat(kw(nachher, "OHNE", R3, "grid_import_kwh")).isEqualByComparingTo("222");
    }

    // =========================================================================== (1) Purge

    @Test
    void rot_ohne_heilung_der_alte_bucket_stand_gemittelt() {
        assertThat(new BigDecimal(altGemischtVorPurge).multiply(BigDecimal.valueOf(4)))
                .isEqualByComparingTo("222");
    }

    @Test
    void nach_dem_purge_sind_die_buckets_der_anlage_die_der_prozedur_auch_der_alte() {
        assertThat(nurAnlage(nachPurge, "ZWEI")).isNotEmpty().isEqualTo(nurAnlage(prozedurNachPurge, "ZWEI"));
        // Der Bucket vom 03.08. liegt weit vor dem Job-Fenster und ist trotzdem geheilt.
        assertThat(kw(nachPurge, "ZWEI", ALT, "grid_import_kwh")).isEqualByComparingTo("367");
        assertThat(kw(nachPurge, "ZWEI", ALT, "load_kwh")).isEqualByComparingTo("367");
        assertThat(kw(nachPurge, "ZWEI", ALT, "pv_kwh")).isEqualByComparingTo("0");
        assertThat(zeile(nachPurge, "1h", "ZWEI", ALT)).contains("\"grid_import_kwh\": 91.750000");
        assertThat(kw(nachPurge, "ZWEI", R3, "grid_import_kwh")).isEqualByComparingTo("367");
    }

    @Test
    void der_purge_laesst_die_anderen_anlagen_und_die_ein_box_anlage_zeile_fuer_zeile() {
        for (String anlage : List.of("EINS", "OHNE", "AUS")) {
            assertThat(nurAnlage(nachPurge, anlage)).as(anlage).isNotEmpty().isEqualTo(nurAnlage(nachher, anlage));
        }
        // Der Neuaufbau der Ein-Box-Anlage selbst: dieselben Zeilen wie die Prozedur.
        assertThat(nurAnlage(nachEinBoxPurge, "EINS")).isEqualTo(nurAnlage(nachher, "EINS"));
    }

    // =========================================================================== (2) Tagesansicht

    @Test
    void die_tagesansicht_zeigt_die_werte_des_rollups() {
        HistoryRepository history = new HistoryRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        for (String anlage : List.of("ZWEI", "EINS", "OHNE", "AUS")) {
            List<HistoryBucketDto> tag = als(tenant, () -> history.dayBuckets(IDS.get(anlage), TAG_VON, TAG_BIS, "DE-LU"));
            assertThat(tag).as(anlage).isNotEmpty();
            for (HistoryBucketDto b : tag) {
                String z = zeile(nachher, "15m", anlage, b.start().toString());
                String k = anlage + "/" + b.start();
                gleich(z, "pv_kwh", b.pvKwh(), k);
                gleich(z, "load_kwh", b.loadKwh(), k);
                gleich(z, "grid_import_kwh", b.gridImportKwh(), k);
                gleich(z, "grid_export_kwh", b.gridExportKwh(), k);
                gleich(z, "battery_charge_kwh", b.batteryChargeKwh(), k);
                gleich(z, "battery_discharge_kwh", b.batteryDischargeKwh(), k);
                gleich(z, "soc_last_pct", b.socLastPct(), k);
            }
        }
    }

    @Test
    void die_tagesansicht_der_zwei_box_anlage_liest_367_statt_222() {
        String r3Vorher = Arrays.stream(tagVorher.get("ZWEI").split("\n"))
                .filter(z -> z.startsWith(R3 + "|")).findFirst().orElseThrow();
        // bucket|pv|load|grid_import|… - vorher der Mittelwert beider Boxen.
        assertThat(new BigDecimal(r3Vorher.split("\\|")[3]).multiply(BigDecimal.valueOf(4)))
                .isEqualByComparingTo("222");
        HistoryRepository history = new HistoryRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        HistoryBucketDto r3 = als(tenant, () -> history.dayBuckets(IDS.get("ZWEI"), TAG_VON, TAG_BIS, "DE-LU")).stream()
                .filter(b -> b.start().equals(Instant.parse(R3))).findFirst().orElseThrow();
        assertThat(r3.gridImportKwh().multiply(BigDecimal.valueOf(4))).isEqualByComparingTo("367");
        assertThat(r3.loadKwh().multiply(BigDecimal.valueOf(4))).isEqualByComparingTo("367");
    }

    @Test
    void die_tagesansicht_jeder_anderen_anlage_bleibt_zeichen_fuer_zeichen() {
        for (String anlage : List.of("EINS", "OHNE", "AUS")) {
            assertThat(zeilen(TAG_NACHHER, ts(TAG_VON), ts(TAG_BIS), IDS.get(anlage)))
                    .as(anlage).isNotEmpty().isEqualTo(tagVorher.get(anlage));
        }
    }

    // =========================================================================== (3) Forecast

    @Test
    void der_forecast_erkennt_nur_die_zwei_box_anlage_mit_bestimmter_fuehrung() {
        assertThat(fuehrendeBox("ZWEI")).isEqualTo(IDS.get("HALLE"));
        assertThat(fuehrendeBox("EINS")).isNull();
        assertThat(fuehrendeBox("OHNE")).isNull();
        assertThat(fuehrendeBox("AUS")).isNull();
    }

    @Test
    void der_forecast_liest_die_anlagen_summe() {
        // Die SQL-Texte von voltpilot_forecast.anlage.anlage_slot_kw, %s → ?.
        Map<String, String> netz = forecast("(grid_import_kwh - grid_export_kwh) * 4");
        Map<String, String> pv = forecast("pv_kwh * 4");
        Map<String, String> last = forecast("load_kwh * 4");
        assertThat(new BigDecimal(netz.get(R3))).isEqualByComparingTo("367");
        assertThat(new BigDecimal(netz.get(PV))).isEqualByComparingTo("240");
        assertThat(new BigDecimal(pv.get(PV))).isEqualByComparingTo("80");
        assertThat(new BigDecimal(last.get(PV))).isEqualByComparingTo("320");
        // Ohne Nettoabgabe der zweiten Box ist die Last unbekannt: kein Slot, nie die zu kleine Zahl.
        assertThat(last).doesNotContainKey(OHNE_PAAR);
    }

    // =========================================================================== Hilfen

    private static UUID fuehrendeBox(String anlage) {
        return root.queryForObject("SELECT telemetry_fuehrende_box(?)", UUID.class, IDS.get(anlage));
    }

    private static Map<String, String> forecast(String expr) {
        Map<String, String> aus = new LinkedHashMap<>();
        root.query("SELECT bucket, " + expr + " FROM telemetry_anlage_15m(?, ?, ?) "
                        + "WHERE " + expr + " IS NOT NULL ORDER BY bucket",
                rs -> {
                    aus.put(rs.getTimestamp(1).toInstant().toString(), rs.getString(2));
                },
                ts(TAG_VON), ts(TAG_BIS), IDS.get("ZWEI"));
        return aus;
    }

    private static void gleich(String rollupZeile, String feld, BigDecimal tag, String k) {
        String w = root.queryForObject("SELECT (?::jsonb) ->> ?", String.class, rollupZeile, feld);
        if (w == null) {
            assertThat(tag).as(k + "/" + feld).isNull();
        } else {
            assertThat(tag).as(k + "/" + feld).isNotNull();
            assertThat(tag.setScale(6, java.math.RoundingMode.HALF_UP)).as(k + "/" + feld)
                    .isEqualByComparingTo(new BigDecimal(w));
        }
    }

    private static java.sql.Timestamp ts(Instant i) {
        return java.sql.Timestamp.from(i);
    }

    /** Jede Zeile einer Abfrage als Text „bucket|spalte|…“, Spalten in Abfrage-Reihenfolge. */
    private static String zeilen(String sql, Object... args) {
        StringBuilder aus = new StringBuilder();
        root.query(sql, rs -> {
            int n = rs.getMetaData().getColumnCount();
            aus.append(rs.getTimestamp(1).toInstant());
            for (int c = 2; c <= n; c++) {
                aus.append('|').append(rs.getString(c));
            }
            aus.append('\n');
        }, args);
        return aus.toString();
    }

    private static <T> T als(UUID t, Supplier<T> arbeit) {
        TenantContext.set(t);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

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

    /** Eine Energie der 15m-Zeile als mittlere Leistung (kWh × 4). */
    private static BigDecimal kw(Map<String, String> alle, String anlage, String bucket, String feld) {
        String w = root.queryForObject("SELECT (?::jsonb) ->> ?", String.class, zeile(alle, "15m", anlage, bucket), feld);
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
                .outOfOrder(true)
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
