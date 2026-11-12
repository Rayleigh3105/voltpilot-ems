package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
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
 * Prod-Befund 12.11.2026: der Tageslauf überspringt eine Reihe mit
 * {@code org.springframework.dao.DataIntegrityViolationException} auf
 * {@code messreihe_tag_zustellart_chk} — hergestellt mit produktionsnahen Daten, nicht geraten.
 *
 * <p><b>Der Auslöser.</b> Die REIHE "G" hat an einem Tag ZWEI Viertelstunden mit Rohwerten: die erste
 * rein {@code direkt}, die zweite mit drei pünktlichen und einem nachgelieferten Wert — genau das
 * Muster von {@code UemsEndgueltigkeitTagesklasseTest#OFFEN} — und wird darum selbst {@code gemischt}.
 * {@link TagVerdichter} fasste beide mit {@link ViertelstundeRegeln#zustellart} zu EINEM Tageswort
 * zusammen — derselben Regel, die {@link ViertelstundeVerdichter} auf ROHWERTE anwendet (die nie
 * {@code gemischt} tragen, nur {@code direkt}/{@code nachgeliefert}). Die Regel erkennt {@code
 * gemischt} als Listenelement nicht: {@code arten.contains("direkt")} ist wegen der ERSTEN
 * Viertelstunde {@code true}, {@code arten.contains("nachgeliefert")} bleibt {@code false} (kein
 * Slot trägt das WORT {@code nachgeliefert} für sich allein) — die Regel schreibt {@code direkt}.
 * Der Tag trägt dann {@code zustellart = 'direkt'} UND {@code n_nachgeliefert = 1} — genau die
 * Kombination, die {@code messreihe_tag_zustellart_chk} verbietet.
 *
 * <p><b>Warum nicht einfach {@code NULL}.</b> Eine Reihe mit NUR der gemischten Viertelstunde (keine
 * zweite, rein direkte) schreibt {@code zustellart = NULL} — das verletzt die CHECK NICHT, weil
 * Postgres eine CHECK-Bedingung als erfüllt behandelt, sobald sie zu {@code NULL} statt zu {@code
 * false} auswertet ({@code (n_nachgeliefert = 0) OR (NULL IN (...))} ergibt {@code NULL}, nicht
 * {@code false}). Erst das ZWEITE, rein direkte Intervall macht aus dem {@code NULL} ein falsches,
 * aber NICHT-NULL {@code 'direkt'} — und DAS verletzt die CHECK wirklich. Ein dicht gemessener Kanal
 * hat praktisch immer so ein zweites, rein direktes Intervall am selben Tag; der Fehler trifft also
 * nicht nur lückenhafte Reihen, sondern jeden Tag, an dem irgendeine Viertelstunde einmal
 * {@code gemischt} wird (ein kurzer Verbindungsabbruch mitten im Intervall reicht). Seit der Migration
 * {@code V20260912190000} (12.09.2026) latent; die bestehenden Tests prüften {@code OFFEN} nur auf
 * Viertelstundenebene (n_nachgeliefert, nicht zustellart) und nie auf Tagesebene, darum unbemerkt.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsTagZustellartGemischtTest {

    private static final MeasurementCatalog KATALOG = UemsTestKatalog.mitKwhTestkanaelen();

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-00000000aa01");
    private static final String KANAL = "energy_kwh_g";

    /** Das Intervall mit der Nachlieferung — 05.10.2026, 12:00–12:15 Ortszeit (Europe/Berlin, CEST). */
    private static final Instant BEGINN = Instant.parse("2026-10-05T10:00:00Z");
    /** Ein zweites, rein pünktliches Intervall DESSELBEN Tages — der Auslöser braucht beide. */
    private static final Instant BEGINN_DIREKT = Instant.parse("2026-10-05T14:00:00Z");
    private static final LocalDate TAG = LocalDate.of(2026, 10, 5);
    private static final Instant JETZT = Instant.parse("2026-10-05T15:00:00Z");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static JdbcTemplate root;
    private static JdbcTemplate admin;
    private static ViertelstundeVerdichter verdichter;
    private static TagVerdichter tage;

    private static Map<String, Object> viertelstundeVorTagesLauf;
    private static Map<String, Object> viertelstundeDirektVorTagesLauf;
    private static RuntimeException tagLaufFehler;
    private static Map<String, Object> tagZeile;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void bauenUndFahren() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().load().migrate();
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        stammdaten();
        rohwerte();

        verdichter = new ViertelstundeVerdichter(admin, KATALOG, new SpaetankunftMelder(), 500, 40, 200_000);
        tage = new TagVerdichter(admin, KATALOG, 200, 40, 20_000, 200_000);

        arbeitFuellen();
        verdichtenBisLeer(JETZT);

        viertelstundeVorTagesLauf = root.queryForList(
                "SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn = ?",
                IDS.get("G"), Timestamp.from(BEGINN)).get(0);
        viertelstundeDirektVorTagesLauf = root.queryForList(
                "SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn = ?",
                IDS.get("G"), Timestamp.from(BEGINN_DIREKT)).get(0);

        // ---- Der TAGESLAUF, wie EndgueltigkeitLaeufer.takt() ihn fährt --------------------------
        // Der erste Lauf setzt nur den Zeiger; die Vergangenheit holt die Rückrechnung in
        // Tagesscheiben (dasselbe Muster wie in UemsEndgueltigkeitTagesklasseTest).
        try {
            tage.lauf(JETZT);
            tage.rueckrechnenGanz(JETZT, 200);
            int[] r;
            do {
                r = tage.bildeEinenStapel(JETZT);
            } while (r[0] > 0);
        } catch (RuntimeException e) {
            tagLaufFehler = e;
        }
        if (tagLaufFehler == null) {
            tagZeile = root.queryForList(
                    "SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?", IDS.get("G"),
                    Date.valueOf(TAG)).get(0);
        }
    }

    // =========================================================================== Die Viertelstunden

    /**
     * Beleg des Auslösers: EINE Viertelstunde des Tages ist selbst {@code gemischt} (direkt UND
     * nachgeliefert in einem Intervall), die ANDERE ist rein {@code direkt} — das ist die Kombination,
     * die {@code zustellart()} am Tag falsch zusammenfasst.
     */
    @Test
    void eineViertelstundeIstGemischtDieAndereReinDirekt() {
        assertThat(viertelstundeVorTagesLauf.get("zustellart")).isEqualTo("gemischt");
        assertThat(viertelstundeVorTagesLauf.get("n_nachgeliefert")).isEqualTo(1);
        assertThat(viertelstundeDirektVorTagesLauf.get("zustellart")).isEqualTo("direkt");
        assertThat(viertelstundeDirektVorTagesLauf.get("n_nachgeliefert")).isEqualTo(0);
    }

    // =========================================================================== Der Tageslauf

    /**
     * Die Regression: der Tageslauf darf NICHT mehr an {@code messreihe_tag_zustellart_chk}
     * scheitern — genau der Fehler aus dem Produktions-Log vom 12.11.2026, 10:34:45 UTC.
     */
    @Test
    void derTageslaufScheitertNichtMehrAnDerZustellartPruefung() {
        assertThat(tagLaufFehler).as("kein DataIntegrityViolationException mehr auf dem Tag von G").isNull();
    }

    /** Die geschriebene Zeile trägt das fachlich richtige Wort: gemischt, nicht das falsche direkt. */
    @Test
    void derTagTraegtGemischtWeilEineSeinerViertelstundenGemischtIst() {
        assertThat(tagZeile.get("zustellart")).isEqualTo("gemischt");
        assertThat(tagZeile.get("n_nachgeliefert")).isEqualTo(1);
        assertThat(tagZeile.get("slots_vorhanden")).isEqualTo(2);
    }

    // =========================================================================== Aufbau

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Probe Zustellart GmbH')", KB);
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'U', 'Europe/Berlin') "
                + "RETURNING id", KB);
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", KB, u);
        UUID site = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-G') RETURNING id", KB);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, site, st);
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-G', 'claimed') RETURNING id", KB, site);
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', 'G', "
                + "'grid-meter', ?, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, "
                + "'2024-03-12T00:00:00Z') RETURNING id", KB, site, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', "
                + "'fifteen_minute')", KB, site, box, entity, KANAL);
        IDS.put("AN", site);
        IDS.put("BOX", box);
        IDS.put("G", entity);
    }

    /**
     * Zwei Viertelstunden desselben Tages: {@code BEGINN} mit drei pünktlichen Werten und einem
     * nachgelieferten (dasselbe Muster wie OFFEN, wird selbst {@code gemischt}), {@code
     * BEGINN_DIREKT} rein pünktlich — der Normalfall, der an jedem dicht gemessenen Tag vorkommt.
     */
    private static void rohwerte() {
        for (int i = 0; i < 3; i++) {
            roh(BEGINN.plus(Duration.ofMinutes(i)), new BigDecimal(1000 + i),
                    BEGINN.plus(Duration.ofMinutes(i)).plusSeconds(2), "direkt");
        }
        roh(BEGINN.plus(Duration.ofMinutes(3)), new BigDecimal(1003),
                BEGINN.plus(Duration.ofMinutes(20)), "nachgeliefert");
        for (int i = 0; i < 3; i++) {
            roh(BEGINN_DIREKT.plus(Duration.ofMinutes(i)), new BigDecimal(2000 + i),
                    BEGINN_DIREKT.plus(Duration.ofMinutes(i)).plusSeconds(2), "direkt");
        }
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                    + "entity_id, applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, "
                    + "?, ?, ?, 'good', '2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', ?, 2)";

    private static void roh(Instant t, BigDecimal wert, Instant eingang, String zustellart) {
        root.update(ROH_SQL, Timestamp.from(t), Timestamp.from(eingang), KB, IDS.get("AN"), IDS.get("BOX"),
                KANAL, wert, t.getEpochSecond(), IDS.get("G"), zustellart);
    }

    /** Ein Eintrag je Reihe, die mindestens einen Rohwert hat (wie PR 700). */
    private static void arbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit
                       (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s
                 WHERE s.entity_id IS NOT NULL
                ON CONFLICT DO NOTHING
                """);
    }

    private static ViertelstundeVerdichter.Lauf verdichtenBisLeer(Instant jetzt) {
        int verdichtet = 0;
        int geschrieben = 0;
        int spaet = 0;
        while (true) {
            int[] r = verdichter.verdichteEinenStapel(jetzt);
            if (r[0] == 0) {
                break;
            }
            verdichtet += r[0];
            geschrieben += r[1];
            spaet += r[2];
        }
        return new ViertelstundeVerdichter.Lauf(0, 0, 0, false, verdichtet, geschrieben, spaet);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
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
