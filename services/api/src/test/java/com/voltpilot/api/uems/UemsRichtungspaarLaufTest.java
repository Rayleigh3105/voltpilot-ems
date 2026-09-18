package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
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
 * Der Anteil eines Vorzeichen-Kanals durch die ganze Kette (UEMS, Folgepaket zu AP-12 IP-5,
 * {@code V20260918104000}): Rohwerte → Viertelstunde → Tag → Monat. Testcontainers, Docker nötig.
 *
 * <p><b>Warum diese Klasse.</b> AP-08 E15/M5 verlangt den Anteil <b>je Rohwert und VOR jeder
 * Verdichtung</b>. Der Beweis dafür ist die Viertelstunde mit einem VORZEICHENWECHSEL in ihr: dort
 * ist die Energie EINE Zahl mit EINEM Vorzeichen, und beide Anteile sind trotzdem größer als null.
 * Eine Summe über Viertelstunden-Vorzeichen — der verworfene Weg — käme hier auf 0 für die eine
 * Richtung und behauptete damit etwas Falsches über eine gemessene Stunde.
 *
 * <p>Gefahren wird der ECHTE Katalogkanal des Speichers ({@code deye.hybrid_3p.battery.battery-power},
 * {@code charge_discharge}); daneben eine PV-Reihe mit nur einer Richtung, die kein Paar bekommen darf.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsRichtungspaarLaufTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final MeasurementCatalog KATALOG = new MeasurementCatalog(new ObjectMapper());

    /** Speicher: zwei Flussrichtungen in EINER Größe. */
    private static final String SPEICHER = "deye.hybrid_3p.battery.battery-power";
    /** PV: nur Erzeugung — eine Richtung, also nie ein Paar. */
    private static final String PV = "sunspec.model_103.w";

    private static final UUID KB = UUID.fromString("93e99678-5bf3-55b4-9cb3-13e16fc4a25a");
    /** Die Viertelstunde mit dem Vorzeichenwechsel IN ihr. */
    private static final Instant WECHSEL = Instant.parse("2026-10-20T08:00:00Z");
    private static final Instant JETZT = Instant.parse("2026-12-01T09:00:00Z");
    private static final int KADENZ = 300;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static JdbcTemplate root;

    @BeforeAll
    static void bauenUndFahren() {
        Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        stammdaten();
        rohwerte();

        JdbcTemplate admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        ViertelstundeVerdichter viertel =
                new ViertelstundeVerdichter(admin, KATALOG, new SpaetankunftMelder(), 500, 40, 200_000);
        TagVerdichter tage = new TagVerdichter(admin, KATALOG, 200, 40, 20_000, 200_000);
        PeriodeVerdichter perioden = new PeriodeVerdichter(admin, KATALOG, 50, 40, 2000);

        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s WHERE s.entity_id IS NOT NULL
                ON CONFLICT DO NOTHING
                """);
        while (viertel.verdichteEinenStapel(JETZT)[0] > 0) {
            // bis die Arbeitsliste leer ist
        }
        root.update("""
                INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund)
                SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                       (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                  FROM messreihe_viertelstunde v
                ON CONFLICT DO NOTHING
                """);
        while (tage.bildeEinenStapel(JETZT)[0] > 0) {
            // bis die Arbeitsliste leer ist
        }
        while (perioden.bildeEinenStapel(JETZT)[0] > 0) {
            // bis die Arbeitsliste leer ist
        }
    }

    // ======================================================================= Die Viertelstunde

    /**
     * Der Kern: in dieser Viertelstunde lädt der Speicher 5 Minuten und entlädt 5 Minuten. Die
     * Energie ist EINE Zahl; die beiden Anteile sind BEIDE positiv. Genau das kann eine Summe über
     * Viertelstunden-Vorzeichen nicht, und genau darum steht der Anteil hier.
     */
    @Test
    void derVorzeichenwechselInEinerViertelstundeErgibtBeideAnteile() {
        Map<String, Object> v = viertelstunde(SPEICHER, WECHSEL);
        assertThat(v.get("energie_positiv")).as("Laden").isNotNull();
        assertThat(v.get("energie_negativ")).as("Entladen").isNotNull();
        assertThat((BigDecimal) v.get("energie_positiv")).isPositive();
        assertThat((BigDecimal) v.get("energie_negativ")).isPositive();
        // Die vorzeichenbehaftete Energie bleibt, was sie war — das Paar tritt neben sie.
        assertThat((BigDecimal) v.get("energie")).isNotNull();
    }

    /** Ein Anteil ist ein Betrag: nie negativ (der CHECK der Migration sagt dasselbe). */
    @Test
    void keinAnteilIstNegativ() {
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE energie_positiv < 0 OR energie_negativ < 0", Integer.class)).isZero();
    }

    /** Eine Reihe mit nur EINER Richtung macht über Richtungen keine Aussage — NULL, nie 0. */
    @Test
    void einRichtungsKanalBekommtKeinPaar() {
        assertThat(Richtungspaar.zweiRichtungen(KATALOG, PV)).isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE messkanal = ? "
                + "AND (energie_positiv IS NOT NULL OR energie_negativ IS NOT NULL)", Integer.class, PV)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE messkanal = ?",
                Integer.class, PV)).isPositive();
    }

    // ======================================================================= Tag und Monat

    /** Der Tag SUMMIERT nur noch die gespeicherten Anteile — Summe der Viertelstunden, Zahl für Zahl. */
    @Test
    void derTagIstDieSummeSeinerViertelstunden() {
        Map<String, Object> t = tag(SPEICHER, LocalDate.of(2026, 10, 20));
        List<Map<String, Object>> vs = root.queryForList("SELECT energie_positiv p, energie_negativ n "
                + "FROM messreihe_viertelstunde WHERE messkanal = ? AND (intervall_beginn AT TIME ZONE 'UTC')::date "
                + "= DATE '2026-10-20' ORDER BY intervall_beginn", SPEICHER);
        BigDecimal p = BigDecimal.ZERO;
        BigDecimal n = BigDecimal.ZERO;
        for (Map<String, Object> z : vs) {
            p = p.add((BigDecimal) z.get("p"));
            n = n.add((BigDecimal) z.get("n"));
        }
        assertThat((BigDecimal) t.get("menge_positiv")).isEqualByComparingTo(p);
        assertThat((BigDecimal) t.get("menge_negativ")).isEqualByComparingTo(n);
        assertThat(p).isPositive();
        assertThat(n).isPositive();
    }

    /** Und der Monat summiert seine Viertelstunden ebenso; das Jahr dann seine Monate. */
    @Test
    void monatUndJahrTragenDasPaar() {
        Map<String, Object> monat = periode(SPEICHER, "monat", LocalDate.of(2026, 10, 1));
        Map<String, Object> jahr = periode(SPEICHER, "jahr", LocalDate.of(2026, 1, 1));
        assertThat((BigDecimal) monat.get("menge_positiv")).isPositive();
        assertThat((BigDecimal) monat.get("menge_negativ")).isPositive();
        assertThat((BigDecimal) jahr.get("menge_positiv"))
                .as("das Jahr summiert seine Monate").isEqualByComparingTo((BigDecimal) monat.get("menge_positiv"));
        assertThat((BigDecimal) jahr.get("menge_negativ"))
                .isEqualByComparingTo((BigDecimal) monat.get("menge_negativ"));
    }

    /** Die PV-Reihe bleibt auf jeder Ebene ohne Paar. */
    @Test
    void ohneZweiRichtungenBleibtJedeEbeneLeer() {
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_tag WHERE messkanal = ? "
                + "AND (menge_positiv IS NOT NULL OR menge_negativ IS NOT NULL)", Integer.class, PV)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_periode WHERE messkanal = ? "
                + "AND (menge_positiv IS NOT NULL OR menge_negativ IS NOT NULL)", Integer.class, PV)).isZero();
    }

    /**
     * Das Paar ist ABSCHREIBBAR: {@link Richtungspaar#derPeriode} liefert es mit seinen Wörtern,
     * damit ein Berichts-Abzug es nehmen kann, ohne zu rechnen (bericht.md EW3).
     */
    @Test
    void derAbzugKannDasPaarMitSeinenWoerternLesen() {
        var paar = Richtungspaar.derPeriode(root, KATALOG, KB, SPEICHER, "monat",
                Instant.parse("2026-09-30T22:00:00Z"), "entity_id = ? AND messkanal = ?",
                List.of(IDS.get("SPEICHER"), SPEICHER));
        assertThat(paar).isPresent();
        assertThat(paar.get().positivWort()).isEqualTo("Laden");
        assertThat(paar.get().negativWort()).isEqualTo("Entladen");
        assertThat(paar.get().positiv()).isPositive();
        assertThat(paar.get().negativ()).isPositive();
    }

    // ======================================================================= Aufbau

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        UUID un = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                + "VALUES (?, 'Ahrenberg', 'Europe/Berlin') RETURNING id", KB);
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", KB, un);
        UUID site = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1') RETURNING id", KB);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, site, st);
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-1', 'claimed') RETURNING id", KB, site);
        UUID geraet = uuid("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, geraeteart, "
                + "eingebaut_am) VALUES (?, ?, 'GR-1', 'GR-1', 'wechselrichter', '2024-03-12T00:00:00Z') "
                + "RETURNING id", KB, site);
        IDS.put("SITE", site);
        IDS.put("BOX", box);
        IDS.put("GERAET", geraet);
        reihe("SPEICHER", site, box, SPEICHER);
        reihe("PV", site, box, PV);
        // AP-04 Regel 7: die Menge entsteht aus der LEISTUNG, Herleitung `integration` — ohne diese
        // Bindung gibt es gar keine Energie (E5) und damit auch keinen Anteil.
        bindung("SPEICHER", "Laden / Entladen", SPEICHER);
        bindung("PV", "Erzeugung", PV);
    }

    private static void bindung(String reihe, String richtung, String kanal) {
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Intervallmenge') RETURNING id", KB, "MS-" + reihe.substring(0, 2), reihe, richtung);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                + "geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'gauge', "
                + "'integration', 'fuehrend', '2024-03-12T00:00:00Z', false, now(), 'sub', 'Probe', 'kunde')",
                KB, ms, richtung, IDS.get(reihe), IDS.get("GERAET"), kanal);
    }

    private static void reihe(String name, UUID site, UUID box, String kanal) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'consumer', ?, 'consumer', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, site, name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, site, box, entity, kanal, KADENZ);
        IDS.put(name, entity);
    }

    /**
     * Der 20.10.2026, 08:00–09:00 UTC. Die ERSTE Viertelstunde wechselt das Vorzeichen in sich:
     * +12 kW, −12 kW, +12 kW im 5-Minuten-Takt. Danach eine Viertelstunde nur Laden und eine nur
     * Entladen, damit Tag und Monat beide Anteile sehen.
     */
    private static void rohwerte() {
        List<Object[]> zeilen = new ArrayList<>();
        String[] speicher = {"12", "-12", "12", "12", "12", "12", "-9", "-9", "-9", "6", "6", "6", "6"};
        for (int i = 0; i < speicher.length; i++) {
            zeilen.add(roh(SPEICHER, IDS.get("SPEICHER"), WECHSEL.plusSeconds(60L * 5 * i), speicher[i]));
        }
        for (int i = 0; i < speicher.length; i++) {
            zeilen.add(roh(PV, IDS.get("PV"), WECHSEL.plusSeconds(60L * 5 * i), "8"));
        }
        root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                + "'2026.09.11.1', ?, 'gauge', ?, 3, 'gauge', 'fuehrend', 'direkt', 2)", zeilen);
    }

    private static Object[] roh(String kanal, UUID entity, Instant t, String wert) {
        return new Object[] {Timestamp.from(t), Timestamp.from(t), KB, IDS.get("SITE"), IDS.get("BOX"), kanal,
                new BigDecimal(wert), t.getEpochSecond() * 100 + kanal.hashCode() % 90, entity};
    }

    // ======================================================================= Helfer

    private static Map<String, Object> viertelstunde(String kanal, Instant beginn) {
        return root.queryForMap("SELECT * FROM messreihe_viertelstunde WHERE messkanal = ? AND intervall_beginn = ?",
                kanal, Timestamp.from(beginn));
    }

    private static Map<String, Object> tag(String kanal, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_tag WHERE messkanal = ? AND tag = ?", kanal, tag);
    }

    private static Map<String, Object> periode(String kanal, String art, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode WHERE messkanal = ? AND art = ? AND tag = ?",
                kanal, art, tag);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
