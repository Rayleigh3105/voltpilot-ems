package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.measurement.MeasurementHistoryService.Datum;
import com.voltpilot.api.measurement.MeasurementHistoryService.History;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.measurement.MeasurementSelectionRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
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
 * AP-07 IP-21 — der Rohdatenablauf als TAT, und danach A2, A7 und A8 gegen den Lesepfad.
 *
 * <p><b>Was hier anders ist als in {@code UemsLesepfadTest}.</b> Dort steht der Zustand nach
 * dem Ablauf, weil die alten Rohwerte gar nicht erst gesät werden — derselbe Zustand, aber
 * eine Annahme. Hier werden die Rohwerte des 20.10.2026 WIRKLICH geschrieben, und dann fällt
 * ihr Chunk mit {@code drop_chunks} genauso, wie die Aufbewahrungsregel
 * ({@code add_retention_policy('device_measurement_sample', INTERVAL '90 days')}, Migration
 * {@code V20260848000000}) ihn fallen lässt. Erst danach wird gefragt. Damit ist belegt, dass
 * der Verlust wirklich eintritt und der Lesepfad ihn wirklich überlebt — nicht nur, dass er
 * mit einer leeren Tabelle zurechtkommt.
 *
 * <p><b>Die Uhr</b> steht auf dem 19.01.2027, 91 Tage nach dem 20.10.2026 — die Zahlen aus
 * §7 A7. Die Frist ist {@code jetzt − 90 Tage}.
 *
 * <p><b>Der Bericht-Datenstand (A8) als Fixture für AP-12:</b> der Lauf hält fest, woraus der
 * Datenstand nach dem Chunk-Drop gebildet wird — Viertelstunden- und Tageswerte, nie Rohwerte
 * — und dass zwei Abfragen nach dem Drop dieselbe Summe liefern.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsRohdatenablaufAbnahmeTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** §7 A7: „Rohwert MS-06 20.10.2026 10:15:00; heute 19.01.2027." */
    private static final Instant JETZT = Instant.parse("2027-01-19T10:00:00Z");

    /** Der 20.10.2026 in der Zeitzone des Standorts (Europe/Berlin, damals UTC+2). */
    private static final Instant TAG_VON = Instant.parse("2026-10-19T22:00:00Z");
    private static final Instant TAG_BIS = Instant.parse("2026-10-20T22:00:00Z");

    /** Ein Zeitraum INNERHALB der Frist — er muss den Drop unberührt überstehen. */
    private static final Instant FRISCH_VON = Instant.parse("2027-01-18T00:00:00Z");
    private static final Instant FRISCH_BIS = Instant.parse("2027-01-18T01:00:00Z");

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-00000000a021");
    private static final String KANAL = "deye.hybrid_1p.meter.today-energy";
    private static final String KATALOG_DAMALS = "2026.06.02.1";

    /** §7 A8: „dieselbe Summe 55 100 kWh für MS-06" — hier die Tagessumme des 20.10.2026. */
    private static final BigDecimal TAGESMENGE = new BigDecimal("57.600");

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

    /** Die Zahlen VOR dem Drop — der Beweis, dass wirklich etwas verloren ging. */
    private static long rohwerteVorDemDrop;
    private static long rohwerteAmTagVorDemDrop;

    @BeforeAll
    static void bauen() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().load().migrate();
        stammdaten();
        // Genau die 96 Viertelstunden des 20.10.2026 — [TAG_VON, TAG_BIS) und keine daneben.
        rohwerte(TAG_VON, 96, 4000L);
        rohwerte(FRISCH_VON, 60, 9000L);                            // 18.01.2027, innerhalb der Frist
        viertelstunden();
        tageswert();

        rohwerteVorDemDrop = zaehle("SELECT count(*) FROM device_measurement_sample");
        rohwerteAmTagVorDemDrop = zaehle("SELECT count(*) FROM device_measurement_sample "
                + "WHERE time >= '" + TAG_VON + "' AND time < '" + TAG_BIS + "'");

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

    // ============================================== Der Ablauf selbst

    /**
     * Der Kern des Pakets: die Aufbewahrungsregel wird ausgeführt, nicht angenommen. Danach
     * sind die Rohwerte des 20.10.2026 weg — und die Werte innerhalb der Frist stehen noch.
     */
    @Test
    void derRetentionDropNimmtDieAltenRohwerteUndNurSie() {
        assertThat(rohwerteAmTagVorDemDrop)
                .as("vor dem Drop lagen wirklich Rohwerte des 20.10.2026").isEqualTo(96);
        assertThat(zaehle("SELECT count(*) FROM timescaledb_information.chunks "
                + "WHERE hypertable_name = 'device_measurement_sample'"))
                .as("die Rohtabelle ist eine Hypertable mit Chunks").isGreaterThanOrEqualTo(2);

        fallenLassen();

        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample "
                + "WHERE time >= '" + TAG_VON + "' AND time < '" + TAG_BIS + "'"))
                .as("A2: die Rohwerte jenseits der 90 Tage sind wirklich gefallen").isZero();
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample "
                + "WHERE time >= '" + FRISCH_VON + "'"))
                .as("innerhalb der Frist wurde nichts angefasst").isEqualTo(60);
        assertThat(rohwerteVorDemDrop)
                .as("es war wirklich mehr da als danach")
                .isGreaterThan(zaehle("SELECT count(*) FROM device_measurement_sample"));

        // Die Speicherklassen und die Ereignisse fallen NIE mit.
        assertThat(zaehle("SELECT count(*) FROM messreihe_viertelstunde"))
                .as("A2: die Viertelstundenwerte des Tages bleiben").isEqualTo(96);
        assertThat(zaehle("SELECT count(*) FROM messreihe_tag"))
                .as("A2: der Tageswert bleibt").isEqualTo(1);
    }

    // ============================================== A2, A7, A8 gegen die Lese-API

    /**
     * A2: „Verlauf … liefert für jede Viertelstunde Wert, Abdeckung, Qualitätszähler, Gerät +
     * Einbau, Fassung, Box, Zustand, nachgeliefert, Version" — NACH dem echten Chunk-Drop.
     */
    @Test
    void a2_nachDemEchtenChunkDropTraegtJedeViertelstundeIhreHerkunft() {
        fallenLassen();
        History h = frei(TAG_VON, TAG_BIS, "decoded");

        assertThat(h.data()).as("kein leerer Verlauf, kein Fehler").hasSize(96);
        assertThat(h.data()).allSatisfy(d -> assertThat(d.herkunft())
                .as("jede Viertelstunde nennt ihre Herkunft").isNotNull());

        Datum erste = h.data().get(0);
        assertThat(erste.herkunft().quelle()).isEqualTo("viertelstunde");
        assertThat(erste.herkunft().katalogVersion())
                .as("die je Wert GESPEICHERTE Katalogfassung, nie die heutige")
                .isEqualTo(KATALOG_DAMALS);
    }

    /**
     * A7: „Rohwerte nicht mehr verfügbar (älter als 90 Tage)" — kein Fehler, kein leerer
     * Verlauf. Und innerhalb der Frist bleibt der Fehler stehen, denn dort ist er wahr.
     */
    @Test
    void a7_dieRohwertAbfrageNachDemChunkDropSagtEsUndWirftNicht() {
        fallenLassen();
        History jenseits = frei(TAG_VON, TAG_BIS, "raw");

        assertThat(jenseits.data()).as("A7: Werte statt eines Fehlers").isNotEmpty();
        assertThat(jenseits.meta().rawAvailable())
                .as("A7: die Antwort sagt, dass es keine echten Rohdaten mehr gibt")
                .isFalse();
    }

    /**
     * A8: der Datenstand eines Berichts ist nach dem Ablauf reproduzierbar — er wird aus den
     * Speicherklassen gebildet, nie aus Rohwerten. Diese Zahlen sind die Fixture für AP-12.
     */
    @Test
    void a8_derBerichtDatenstandIstNachDemChunkDropReproduzierbar() {
        fallenLassen();

        BigDecimal ausViertelstunden = root.queryForObject(
                "SELECT sum(menge) FROM messreihe_viertelstunde WHERE entity_id = ?",
                BigDecimal.class, IDS.get("K5"));
        BigDecimal ausTageswert = root.queryForObject(
                "SELECT menge FROM messreihe_tag WHERE entity_id = ?",
                BigDecimal.class, IDS.get("K5"));

        assertThat(ausViertelstunden).as("A8: die Summe der Viertelstunden")
                .isEqualByComparingTo(TAGESMENGE);
        assertThat(ausTageswert).as("A8: der Tageswert nennt dieselbe Menge")
                .isEqualByComparingTo(TAGESMENGE);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample "
                + "WHERE time >= '" + TAG_VON + "' AND time < '" + TAG_BIS + "'"))
                .as("A8: gebildet wurde ohne einen einzigen Rohwert").isZero();

        // Zweimal gefragt heißt zweimal dieselbe Antwort — „reproduzierbar" ist der Vertrag.
        assertThat(frei(TAG_VON, TAG_BIS, "decoded").data())
                .usingRecursiveComparison()
                .isEqualTo(frei(TAG_VON, TAG_BIS, "decoded").data());
    }

    // ---------------------------------------------------------------- Werkzeug

    /**
     * Genau das, was {@code add_retention_policy(…, INTERVAL '90 days')} tut, nur von Hand
     * angestoßen: der Chunk mit den Werten älter als die Frist fällt. Mehrfach aufrufbar —
     * jede Methode dieses Laufs darf ihn voraussetzen, ohne auf eine Reihenfolge zu bauen.
     */
    private static void fallenLassen() {
        root.queryForList("SELECT drop_chunks('device_measurement_sample', "
                + "older_than => TIMESTAMPTZ '" + JETZT.minusSeconds(90L * 86400) + "')");
    }

    private static History frei(Instant von, Instant bis, String darstellung) {
        return verlauf.history(IDS.get("BOX"), KANAL, "free", von, bis, darstellung, null, null);
    }

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));
        IDS.put("DQ", uuid("INSERT INTO data_source (tenant_id, site_id, kennzeichen, name, "
                + "protokoll, adresse, kadenz_s) VALUES (?, ?, 'DQ-4', 'WAGO Halle 2', "
                + "'modbus_tcp', '10.0.0.9:502/1', 60) RETURNING id", KB, IDS.get("AN2")));
        IDS.put("K5", uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                        + "entity_type, device_id, communication, connection_json, data_source_id, "
                        + "created_at) VALUES (?, ?, 'grid-meter', 'K-5 Unterzähler Spritzguss', "
                        + "'grid-meter', ?, 'modbus_tcp', "
                        + "'{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?, "
                        + "'2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get("AN2"), IDS.get("BOX"), IDS.get("DQ")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                        + "entity_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                        + "catalog_version, changed_by, apply_status, retention_class, "
                        + "long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 900, 1, "
                        + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', "
                        + "'energy_counter', 'fifteen_minute')",
                KB, IDS.get("AN2"), IDS.get("BOX"), IDS.get("K5"), KANAL);
        IDS.put("EINBAU", root.queryForObject("SELECT geraet_id FROM geraet_komponente "
                + "WHERE entity_id = ? AND gueltig_bis IS NULL", UUID.class, IDS.get("K5")));
    }

    /** Echte Rohwerte, die der Drop später wirklich zu nehmen hat. */
    private static void rohwerte(Instant beginn, int wieViele, long sequenzAb) {
        BigDecimal stand = new BigDecimal("5000.0");
        for (int i = 0; i < wieViele; i++) {
            Instant t = beginn.plusSeconds(900L * i);
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                            + "site_id, device_id, point_key, raw_numeric, decoded_numeric, "
                            + "quality, catalog_version, edge_sequence, aggregation_kind, "
                            + "entity_id, device_install_id, applied_revision, value_kind, role, "
                            + "delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', ?, ?, "
                            + "'counter', ?, ?, 1, 'counter', 'fuehrend', 'direkt', 5)",
                    Timestamp.from(t), Timestamp.from(t.plusSeconds(5)), KB, IDS.get("AN2"),
                    IDS.get("BOX"), KANAL, stand.doubleValue(), stand.doubleValue(),
                    KATALOG_DAMALS, sequenzAb + i, IDS.get("K5"), IDS.get("EINBAU"));
            stand = stand.add(new BigDecimal("0.6"));
        }
    }

    /** Die 96 Viertelstunden des 20.10.2026 — sie überleben den Drop und tragen die Antwort. */
    private static void viertelstunden() {
        BigDecimal stand = new BigDecimal("1000.000");
        for (int i = 0; i < 96; i++) {
            Instant beginn = TAG_VON.plusSeconds(900L * i);
            BigDecimal ende = stand.add(new BigDecimal("0.600"));
            root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, "
                            + "entity_id, messkanal, site_id, wertart, stand_anfang, "
                            + "stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, "
                            + "erster_zeit, letzter_wert, letzter_zeit, erhalten, erwartet, "
                            + "abdeckung_prozent, kadenz_s, kadenz_herkunft, n_good, geraet_einbau, "
                            + "box, fassung, katalog, rolle, zustand, endgueltig_ab, version, "
                            + "n_nachgeliefert, letzte_eingangszeit, zustellart, menge, "
                            + "menge_zustand, faktor) VALUES (?, ?, ?, ?, ?, 'counter', ?, ?, ?, ?, "
                            + "?, ?, ?, ?, 15, 15, 100, 60, 'auswahl', 15, ?, ?, 1, ?, 'fuehrend', "
                            + "'endgueltig', ?, 1, 0, ?, 'direkt', ?, 'vollständig', 1)",
                    Timestamp.from(beginn), KB, IDS.get("K5"), KANAL, IDS.get("AN2"),
                    stand, Timestamp.from(beginn), ende, Timestamp.from(beginn.plusSeconds(840)),
                    stand, Timestamp.from(beginn), ende, Timestamp.from(beginn.plusSeconds(840)),
                    IDS.get("EINBAU"), IDS.get("BOX"), KATALOG_DAMALS,
                    Timestamp.from(beginn.plus(java.time.Duration.ofMinutes(10095))),
                    Timestamp.from(beginn.plusSeconds(900)), new BigDecimal("0.600"));
            stand = ende;
        }
    }

    /** Der Tageswert des 20.10.2026 — die zweite Speicherklasse, die den Drop überlebt. */
    private static void tageswert() {
        BigDecimal stand = new BigDecimal("1000.000");
        BigDecimal ende = stand.add(TAGESMENGE);
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, site_id, "
                        + "zeitzone, zeitzone_herkunft, beginn, ende, stunden, slots_erwartet, "
                        + "slots_vorhanden, slots_endgueltig, wertart, stand_anfang, stand_ende, "
                        + "erster_wert, letzter_wert, erhalten, erwartet, abdeckung_prozent, "
                        + "n_good, geraet_einbau, box, fassung, katalog, rolle, zustand, "
                        + "endgueltig_ab, version, n_nachgeliefert, letzte_eingangszeit, "
                        + "zustellart, menge) VALUES (CAST('2026-10-20' AS date), ?, ?, ?, ?, "
                        + "'Europe/Berlin', 'standort', ?, ?, 24, 96, 96, 96, 'counter', ?, ?, ?, "
                        + "?, 1440, 1440, 100, 1440, ?, ?, 1, ?, 'fuehrend', 'endgueltig', ?, 1, "
                        + "0, ?, 'direkt', ?)",
                KB, IDS.get("K5"), KANAL, IDS.get("AN2"), Timestamp.from(TAG_VON),
                Timestamp.from(TAG_BIS), stand, ende, stand, ende, IDS.get("EINBAU"),
                IDS.get("BOX"), KATALOG_DAMALS,
                Timestamp.from(TAG_BIS.plus(java.time.Duration.ofDays(7))),
                Timestamp.from(TAG_BIS), TAGESMENGE);
    }

    private static long zaehle(String sql) {
        Long n = root.queryForObject(sql, Long.class);
        return n == null ? -1 : n;
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
