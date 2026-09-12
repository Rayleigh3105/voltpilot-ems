package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-08 IP-3 über die Datenbank: Momentanwert je Viertelstunde, Tag, Monat und Jahr — Mittel,
 * Min, Max, gemessene Zeit und die GEKENNZEICHNETE Integration aus Leistung (E5).
 *
 * <p>Die Rohwerte kommen Zeichen für Zeichen aus der Vektor-Datei (F3, F18, F24) oder sind hier
 * beschrieben; die Periodenwerte werden gegen die Datei geprüft und — wo die Datei keine Erwartung
 * trägt (Tag, Monat, Jahr) — gegen DIESELBE Regel über alle Rohwerte der Periode
 * ({@link VerbrauchRegeln#momentanwerte}), die {@code VerbrauchVectorsTest} gegen die Datei hält.
 *
 * <p>⚠ F2 (Intervallmenge) läuft hier NICHT durch: das Rohwert-Vokabular kennt kein Wort dafür
 * ({@link #dieIntervallmengeHatKeinRohwertWort}); die Regel samt Zusammensetzung prüfen
 * {@code VerbrauchVectorsTest} und {@code VerbrauchWerteteileTest} ohne Datenbank.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsIntervallMomentanwertTest {

    private static final String DIESE = "20260912213000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0f0000-0000-0000-0000-000000000005");
    private static final UUID FREMD = UUID.fromString("4e0f0000-0000-0000-0000-000000000006");

    /** Der 20.10. steht fest (Frist 27./28.10.), der 31.10./01.11. ist noch vorläufig. */
    private static final Instant T1 = Instant.parse("2026-11-03T12:00:00Z");

    private static final Duration ZEHN = Duration.ofSeconds(10);
    private static final Duration FUENF_MIN = Duration.ofSeconds(300);

    private static final String INTEGRIERT = VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT;

    private static final List<String> BESTAND = List.of(
            "device_measurement_event", "device_measurement_rollup_5m", "device_measurement_rollup_15m",
            "device_measurement_selection", "measurement_point", "messstelle", "messstelle_quelle", "geraet",
            "standort", "unternehmen", "anlage_standort", "telemetry", "telemetry_v2", "schedule");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate admin;
    private static JdbcTemplate app;
    private static ViertelstundeVerdichter verdichter;
    private static EndgueltigkeitLauf endgueltigkeit;
    private static TagVerdichter tage;
    private static PeriodeVerdichter perioden;

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static final Map<String, String> KANAL = new LinkedHashMap<>();
    private static final Map<String, List<Rohwert>> ROH = new LinkedHashMap<>();
    private static final Map<String, JsonNode> FAELLE = new LinkedHashMap<>();

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachAllem;
    private static String rohVorher;
    private static String rohNachAllem;

    private static String werteVorWiederholung;
    private static String werteNachWiederholung;
    private static int viertelZweitesMal;
    private static int tagZweitesMal;
    private static int periodeZweitesMal;

    private static Map<String, Object> f3Viertelstunde;
    private static Map<String, Object> f3ViertelstundeVerbogen;
    private static Map<String, Object> f3TagVerbogen;

    private static boolean abbruchWarf;
    private static int arbeitNachAbbruch;
    private static int zeilenNachAbbruch;
    private static Map<String, Object> tagVorAbbruch;
    private static Map<String, Object> tagNachAbbruch;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            FAELLE.put(fall.path("name").asText().split("-")[0], fall);
        }
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        stammdaten();
        rohwerte();
        fingerVorher = fingerabdruck();
        rohVorher = rohwerteFinger();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = fingerabdruck();
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        verdichter = new ViertelstundeVerdichter(admin, new MeasurementCatalog(new ObjectMapper()),
                new SpaetankunftMelder(), 500, 40, 200_000);
        endgueltigkeit = new EndgueltigkeitLauf(admin, 2000, 200);
        tage = new TagVerdichter(admin, 200, 40, 20_000, 200_000);
        perioden = new PeriodeVerdichter(admin, 50, 40, 2000);

        // ---- 1. Viertelstunden, Endgültigkeit, Tage, Monate, Jahre --------------------------
        arbeitFuellen();
        verdichtenBisLeer(T1);
        endgueltigkeit.umschalten(T1);
        tagArbeitFuellen();
        tagLaufBisLeer(T1);
        periodenLaufBisLeer(T1);

        // ---- 2. Wiederholbar: alles noch einmal in die Listen — geschrieben wird NICHTS -------
        werteVorWiederholung = werteFinger();
        arbeitFuellen();
        viertelZweitesMal = verdichtenBisLeer(T1);
        tagArbeitFuellen();
        tagZweitesMal = tagLaufBisLeer(T1);
        root.update("INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art, tag, grund) "
                + "SELECT tenant_id, entity_id, messkanal, art, tag, 'frist' FROM messreihe_periode "
                + "ON CONFLICT DO NOTHING");
        periodeZweitesMal = periodenLaufBisLeer(T1);
        werteNachWiederholung = werteFinger();

        // ---- 3. Eine ENDGÜLTIGE Zeile wird nie angefasst — auch nicht, um sie zu „heilen" ------
        f3Viertelstunde = viertelstunde("F3", "2026-10-20T08:00:00Z");
        root.update("UPDATE messreihe_viertelstunde SET energie = 99 WHERE entity_id = ? AND intervall_beginn = ?",
                IDS.get("F3"), Timestamp.from(Instant.parse("2026-10-20T08:00:00Z")));
        root.update("UPDATE messreihe_tag SET mittel = 1.0 WHERE entity_id = ? AND tag = DATE '2026-10-20'",
                IDS.get("F3"));
        arbeitFuellen();
        verdichtenBisLeer(T1);
        tagArbeitFuellen();
        tagLaufBisLeer(T1);
        f3ViertelstundeVerbogen = viertelstunde("F3", "2026-10-20T08:00:00Z");
        f3TagVerbogen = tag("F3", LocalDate.of(2026, 10, 20));

        // ---- 4. Abbruchsicher: das Schreiben scheitert, die Arbeit bleibt in der Liste ---------
        tagVorAbbruch = tag("MG", LocalDate.of(2026, 10, 31));
        root.update("DELETE FROM messreihe_tag WHERE entity_id = ? AND tag = DATE '2026-10-31'", IDS.get("MG"));
        root.update("INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund) "
                + "VALUES (?, ?, ?, DATE '2026-10-31', 'viertelstunde')", KB, IDS.get("MG"), KANAL.get("MG"));
        root.execute("REVOKE INSERT ON messreihe_tag FROM " + ADMIN_USER);
        try {
            tage.bildeEinenStapel(T1);
            abbruchWarf = false;
        } catch (RuntimeException e) {
            abbruchWarf = true;
        }
        arbeitNachAbbruch = zahl("SELECT count(*) FROM messreihe_tag_arbeit");
        zeilenNachAbbruch = zahl("SELECT count(*) FROM messreihe_tag WHERE entity_id = '" + IDS.get("MG")
                + "' AND tag = DATE '2026-10-31'");
        root.execute("GRANT INSERT ON messreihe_tag TO " + ADMIN_USER);
        tagLaufBisLeer(T1);
        tagNachAbbruch = tag("MG", LocalDate.of(2026, 10, 31));

        fingerNachAllem = fingerabdruck();
        rohNachAllem = rohwerteFinger();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ===================================================== Die Viertelstunde: F3, F18, halb

    /** F3: Mittel/Min/Max und die Energie aus Leistung — mit Kennzeichen, nie in `menge`. */
    @Test
    void f3DieViertelstundeTraegtIhreEnergieMitKennzeichen() {
        JsonNode soll = erwartung("f3", "Viertelstunde 10:00–10:15");
        Map<String, Object> v = gegenDieDatei("F3", f3Viertelstunde, soll);
        assertThat(v.get("menge")).as("M6: ein Momentanwert liefert nie eine Menge").isNull();
        assertThat((BigDecimal) v.get("summe")).isEqualByComparingTo("8680.5");
        assertThat(zahl(v, "gemessen_s")).isEqualTo(900);
        assertThat(v.get("luecke_innen")).isEqualTo(false);
        // Gespeichert UNGERUNDET — die Rundung passiert erst beim Vergleich und bei der Anzeige.
        assertThat(((BigDecimal) v.get("energie")).subtract(new BigDecimal("24.1125")).abs())
                .isLessThan(new BigDecimal("1e-20"));
    }

    /** F18: die Lücke 10:05–10:09 — Mittel der VORHANDENEN Werte, Energie nur über gemessene Zeit. */
    @Test
    void f18DieLueckeWirdNichtMitDemMittelGefuellt() {
        JsonNode soll = erwartung("f18", "Viertelstunde 10:00–10:15");
        Map<String, Object> v = gegenDieDatei("F18", viertelstunde("F18", "2026-10-20T08:00:00Z"), soll);
        assertThat(zahl(v, "gemessen_s")).isEqualTo(660);
        assertThat(v.get("luecke_innen")).as("zwischen 10:04:50 und 10:09:00 liegt die Lücke").isEqualTo(true);
        assertThat(energie(v)).as("nie 96 kW × 0,25 h").isNotEqualByComparingTo("24.000")
                .isEqualByComparingTo("17.600");
    }

    /**
     * Eine HALB gemessene Viertelstunde (45 von 90 Werten): das Mittel ist das der vorhandenen Werte,
     * die Abdeckung sagt 50 %, die gemessene Zeit 7:30 min — und die Energie zählt nur diese Zeit
     * (9,0 kWh), nie das Mittel über die ganze Viertelstunde (72 kW × 0,25 h = 18 kWh).
     */
    @Test
    void einMittelUeberEineHalbGemesseneViertelstunde() {
        Map<String, Object> v = viertelstunde("HALB", "2026-10-20T08:00:00Z");
        assertThat((BigDecimal) v.get("mittel")).isEqualByComparingTo("72.0");
        assertThat((BigDecimal) v.get("min_wert")).isEqualByComparingTo("50.0");
        assertThat((BigDecimal) v.get("max_wert")).isEqualByComparingTo("94.0");
        assertThat(energie(v)).isEqualByComparingTo("9.000");
        assertThat(v.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(zahl(v, "erhalten")).isEqualTo(45);
        assertThat(zahl(v, "erwartet")).isEqualTo(90);
        assertThat(zahl(v, "abdeckung_prozent")).isEqualTo(50);
        assertThat(zahl(v, "gemessen_s")).isEqualTo(450);
        assertThat(kennzeichen(v)).containsExactly("gemessene Zeit 7:30 min von 15 min", INTEGRIERT);
        Ergebnis regel = VerbrauchRegeln.momentanwerte(ROH.get("HALB"), Instant.parse("2026-10-20T08:00:00Z"),
                Instant.parse("2026-10-20T08:15:00Z"), ZEHN, true);
        assertThat(regel.energieKwh()).isEqualByComparingTo(energie(v));
    }

    // ============================================= Die Integration — und wo sie ausbleibt

    /** Ohne Quellenbindung `integration` gibt es keine Energie: dieselben Werte wie F3, kein Kennzeichen. */
    @Test
    void ohneBindungIntegrationGibtEsKeineEnergie() {
        Map<String, Object> v = viertelstunde("OHNE", "2026-10-20T08:00:00Z");
        assertThat((BigDecimal) v.get("mittel")).isEqualByComparingTo("96.5");
        assertThat(v.get("energie")).isNull();
        assertThat(kennzeichen(v)).isEmpty();
        Map<String, Object> t = tag("OHNE", LocalDate.of(2026, 10, 20));
        assertThat(t.get("energie")).isNull();
        assertThat(kennzeichen(t)).doesNotContain(INTEGRIERT);
        assertThat((BigDecimal) t.get("mittel")).isEqualByComparingTo("96.5");
    }

    /** Kein guter Wert: keine Zahl — keine Energie, keine Summe, kein Mittel, nie 0. */
    @Test
    void ohneGutenWertGibtEsKeineZahl() {
        Map<String, Object> v = viertelstunde("SCHLECHT", "2026-10-20T08:00:00Z");
        assertThat(v.get("menge_zustand")).isEqualTo("keine Werte");
        assertThat(v.get("energie")).isNull();
        assertThat(v.get("summe")).isNull();
        assertThat(v.get("mittel")).isNull();
        assertThat(zahl(v, "n_invalid")).isEqualTo(90);
        assertThat(kennzeichen(v)).isEmpty();
        Map<String, Object> t = tag("SCHLECHT", LocalDate.of(2026, 10, 20));
        assertThat(t.get("menge_zustand")).isEqualTo("keine Werte");
        assertThat(t.get("energie")).isNull();
    }

    /**
     * Die Bindung beginnt um 10:10: die Viertelstunde 09:45 hat keine Energie, die um 10:00 schon. Der
     * TAG hat dann KEINE Energie — eine Summe, der eine Viertelstunde fehlt, wäre eine Behauptung.
     */
    @Test
    void einTagOhneEnergieJederViertelstundeHatKeineEnergie() {
        assertThat(viertelstunde("SPAET", "2026-10-20T07:45:00Z").get("energie")).isNull();
        Map<String, Object> zehn = viertelstunde("SPAET", "2026-10-20T08:00:00Z");
        assertThat(zehn.get("energie")).isNotNull();
        assertThat(kennzeichen(zehn)).contains(INTEGRIERT);
        Map<String, Object> t = tag("SPAET", LocalDate.of(2026, 10, 20));
        assertThat(t.get("energie")).isNull();
        assertThat(kennzeichen(t)).doesNotContain(INTEGRIERT);
        assertThat(t.get("mittel")).as("Mittel, Min, Max gibt es trotzdem").isNotNull();
    }

    /** An der Datenbankgrenze: keine Energie ohne Kennzeichen, keine Menge an einem Momentanwert. */
    @Test
    void dieDatenbankHaeltDasKennzeichenUndM6() {
        assertThatThrownBy(() -> root.update("UPDATE messreihe_viertelstunde SET kennzeichen = '[]'::jsonb "
                + "WHERE entity_id = ?", IDS.get("F18")))
                .hasMessageContaining("energie_kennzeichen_chk");
        assertThatThrownBy(() -> root.update("UPDATE messreihe_tag SET menge = 1 WHERE entity_id = ?",
                IDS.get("F24")))
                .hasMessageContaining("momentanwert_chk");
        assertThatThrownBy(() -> root.update("UPDATE messreihe_periode SET energie = 1, kennzeichen = '[]'::jsonb "
                + "WHERE entity_id = ?", IDS.get("F24")))
                .hasMessageContaining("energie_kennzeichen_chk");
        assertThat(root.queryForObject("SELECT pg_get_functiondef('messreihe_energie_gekennzeichnet(numeric, jsonb)'"
                + "::regprocedure)", String.class))
                .contains("'" + VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT_WORT + "%'");
    }

    /** Befund: das Rohwert-Vokabular hat kein Wort für eine Intervallmenge — F2 kann hier nicht einlaufen. */
    @Test
    void dieIntervallmengeHatKeinRohwertWort() {
        assertThatThrownBy(() -> root.update(ROH_SQL.replace("'gauge', 'fuehrend'", "'intervallmenge', 'fuehrend'"),
                zeile(KB, IDS.get("F3"), KANAL.get("F3"), Instant.parse("2026-10-20T09:00:00Z"),
                        BigDecimal.ONE, "good", 7)))
                .hasMessageContaining("value_kind");
        assertThat(ViertelstundeRegeln.regelWort("intervallmenge")).isEqualTo("intervallmenge");
        assertThat(ViertelstundeRegeln.regelWort("gauge")).isEqualTo("momentanwert");
    }

    // ===================================================== Die Fortpflanzung: Tag, Monat, Jahr

    /**
     * F24 als Tag: die Viertelstunden 10:00–10:45 der Datei plus die eine, die der Wert 11:00:00 öffnet
     * (138,0 kW — die Abschnitte der Datei schließen ihr Ende ein). Der Tag ist die Stunde der Datei plus
     * dieser eine Wert: 349 + 1 Werte, 107,308 + 138,0 × 10 s = 107,691 kWh, Mittel 38 558,1 ÷ 350.
     */
    @Test
    void f24DerTagAusDenViertelstunden() {
        Map<String, Object> t = tag("F24", LocalDate.of(2026, 10, 20));
        JsonNode stunde = erwartung("f24", "Stunde 10:00–11:00");
        assertThat(zahl(viertelstunde("F24", "2026-10-20T09:00:00Z"), "erhalten")).isOne();
        assertThat(energie(t)).isEqualByComparingTo(new BigDecimal(stunde.path("energie_kwh").asText())
                .add(new BigDecimal("138.0").multiply(BigDecimal.TEN)
                        .divide(BigDecimal.valueOf(3600), 3, RoundingMode.HALF_UP)))
                .isEqualByComparingTo("107.691");
        assertThat((BigDecimal) t.get("mittel")).isEqualByComparingTo("110.2");
        VerbrauchVectorsTest.zahl("min", stunde.path("min"), (BigDecimal) t.get("min_wert"));
        assertThat((BigDecimal) t.get("max_wert")).isEqualByComparingTo("138.0");
        assertThat(zahl(t, "erhalten")).isEqualTo(350);
        assertThat(kennzeichen(t)).containsExactly("gemessene Zeit 58:20 min von 1440 min", INTEGRIERT);
        wieDieRegel("F24", t, TagRegeln.beginn(LocalDate.of(2026, 10, 20), ORT),
                TagRegeln.ende(LocalDate.of(2026, 10, 20), ORT), ZEHN);
        assertThat(t.get("zustand")).as("der 20.10. steht fest").isEqualTo("endgueltig");
    }

    /** F24 als Monat und Jahr: dieselbe Regel, die Energie unverändert die des Tages. */
    @Test
    void f24MonatUndJahr() {
        Map<String, Object> monat = periode("F24", "monat", LocalDate.of(2026, 10, 1));
        Map<String, Object> jahr = periode("F24", "jahr", LocalDate.of(2026, 1, 1));
        wieDieRegel("F24", monat, instant("2026-10-01T00:00:00+02:00"), instant("2026-11-01T00:00:00+01:00"), ZEHN);
        wieDieRegel("F24", jahr, instant("2026-01-01T00:00:00+01:00"), instant("2027-01-01T00:00:00+01:00"), ZEHN);
        assertThat(energie(monat)).isEqualByComparingTo("107.691");
        assertThat(energie(jahr)).isEqualByComparingTo("107.691");
        assertThat((BigDecimal) jahr.get("mittel")).isEqualByComparingTo("110.2");
    }

    /**
     * MG über die Monatsgrenze (300 s, versetzt um 2 min): Tag, Monat, Jahr wie die Regel über alle
     * Rohwerte — mit der Lücke 11:00–12:30 UTC am 31.10., dem Halten über eine Viertelstunde OHNE Zeile
     * und dem fehlenden Wert genau an der Monatsgrenze, über die der Wert davor hält.
     */
    @Test
    void mgTageMonateUndDasJahrFolgenDerRegel() {
        wieDieRegel("MG", tag("MG", LocalDate.of(2026, 10, 31)), instant("2026-10-31T00:00:00+01:00"),
                instant("2026-11-01T00:00:00+01:00"), FUENF_MIN);
        wieDieRegel("MG", tag("MG", LocalDate.of(2026, 11, 1)), instant("2026-11-01T00:00:00+01:00"),
                instant("2026-11-02T00:00:00+01:00"), FUENF_MIN);
        wieDieRegel("MG", periode("MG", "monat", LocalDate.of(2026, 10, 1)), instant("2026-10-01T00:00:00+02:00"),
                instant("2026-11-01T00:00:00+01:00"), FUENF_MIN);
        wieDieRegel("MG", periode("MG", "monat", LocalDate.of(2026, 11, 1)), instant("2026-11-01T00:00:00+01:00"),
                instant("2026-12-01T00:00:00+01:00"), FUENF_MIN);
        wieDieRegel("MG", periode("MG", "jahr", LocalDate.of(2026, 1, 1)), instant("2026-01-01T00:00:00+01:00"),
                instant("2027-01-01T00:00:00+01:00"), FUENF_MIN);
        Map<String, Object> t = tag("MG", LocalDate.of(2026, 10, 31));
        assertThat(t.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(t.get("luecke_innen")).isEqualTo(true);
        assertThat(t.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(periode("MG", "monat", LocalDate.of(2026, 11, 1)).get("luecke_innen")).isEqualTo(false);
    }

    /**
     * Die Tagesenergie ist NICHT die Summe der Viertelstunden-Energien: der Wert 10:57 UTC (45,5 kW) hält
     * zwei Minuten in die Viertelstunde 11:00, die keine Zeile hat — die Summe verlöre genau das.
     */
    @Test
    void dieTagesenergieZaehltAuchDasHaltenUeberEineViertelstundeOhneZeile() {
        Map<String, Object> t = tag("MG", LocalDate.of(2026, 10, 31));
        BigDecimal summe = root.queryForObject("SELECT sum(energie) FROM messreihe_viertelstunde WHERE entity_id = ? "
                + "AND intervall_beginn >= '2026-10-30T23:00:00Z' AND intervall_beginn < '2026-10-31T23:00:00Z'",
                BigDecimal.class, IDS.get("MG"));
        BigDecimal gehalten = new BigDecimal("45.5").multiply(BigDecimal.valueOf(120))
                .divide(BigDecimal.valueOf(3600), 20, RoundingMode.HALF_EVEN);
        assertThat(((BigDecimal) t.get("energie")).subtract(summe).subtract(gehalten).abs())
                .isLessThan(new BigDecimal("1e-15"));
    }

    // ===================================================== Wiederholbar, endgültig, Abbruch

    @Test
    void derZweiteLaufSchreibtNichts() {
        assertThat(viertelZweitesMal).as("Viertelstunden").isZero();
        assertThat(tagZweitesMal).as("Tage").isZero();
        assertThat(periodeZweitesMal).as("Monate und Jahre").isZero();
        assertThat(werteNachWiederholung).as("Zeichen für Zeichen").isEqualTo(werteVorWiederholung);
    }

    @Test
    void eineEndgueltigeZeileWirdNieAngefasst() {
        assertThat(f3ViertelstundeVerbogen.get("zustand")).isEqualTo("endgueltig");
        assertThat((BigDecimal) f3ViertelstundeVerbogen.get("energie")).isEqualByComparingTo("99");
        assertThat(f3TagVerbogen.get("zustand")).isEqualTo("endgueltig");
        assertThat((BigDecimal) f3TagVerbogen.get("mittel")).isEqualByComparingTo("1.0");
    }

    @Test
    void einAbbruchLaesstNichtsHalbesZurueck() {
        assertThat(abbruchWarf).isTrue();
        assertThat(arbeitNachAbbruch).as("die Arbeit steht noch in der Liste").isPositive();
        assertThat(zeilenNachAbbruch).as("und keine halbe Zeile").isZero();
        Map<String, Object> vorher = new LinkedHashMap<>(tagVorAbbruch);
        Map<String, Object> nachher = new LinkedHashMap<>(tagNachAbbruch);
        vorher.remove("berechnet_am");
        nachher.remove("berechnet_am");
        assertThat(nachher).as("der nächste Lauf bildet dieselbe Zeile").isEqualTo(vorher);
        assertThat(zahl("SELECT count(*) FROM messreihe_tag_arbeit")).isZero();
    }

    // ============================================================ Bestand und Zaun

    @Test
    void dieMigrationLegtNurDanebenUndDerGanzeLaufLaesstDenBestandZeichengleich() {
        assertThat(fingerNachMigration).as("nach der Migration").isEqualTo(fingerVorher);
        assertThat(fingerNachAllem).as("nach allen Läufen").isEqualTo(fingerVorher);
        assertThat(fingerVorher).hasSizeGreaterThan(100).containsKeys(BESTAND.toArray(String[]::new));
        assertThat(rohNachAllem).as("keine Rohzeile ändert sich").isEqualTo(rohVorher);
        for (String tabelle : List.of("messreihe_viertelstunde", "messreihe_tag", "messreihe_periode")) {
            assertThat(rechte(APP_USER, tabelle)).as(tabelle).containsExactly("SELECT");
        }
    }

    @Test
    void dieAppRolleSiehtNurDenEigenenKundenbereich() {
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag", Integer.class)).isZero();
        TenantContext.set(KB);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE energie IS NOT NULL",
                Integer.class)).isPositive();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_periode WHERE energie IS NOT NULL",
                Integer.class)).isPositive();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag WHERE tenant_id = ?", Integer.class, FREMD))
                .isZero();
        TenantContext.set(FREMD);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE tenant_id = ?",
                Integer.class, KB)).isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_periode WHERE energie IS NOT NULL",
                Integer.class)).isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag", Integer.class)).isPositive();
    }

    // ============================================================ Vergleich

    private static final java.time.ZoneId ORT = java.time.ZoneId.of("Europe/Berlin");

    /** Die Viertelstunde gegen die Erwartung der Datei — Feld für Feld. */
    private static Map<String, Object> gegenDieDatei(String reihe, Map<String, Object> v, JsonNode soll) {
        String was = reihe + " " + soll.path("name").asText();
        VerbrauchVectorsTest.zahl(was + " · mittel", soll.path("mittel"), (BigDecimal) v.get("mittel"));
        VerbrauchVectorsTest.zahl(was + " · min", soll.path("min"), (BigDecimal) v.get("min_wert"));
        VerbrauchVectorsTest.zahl(was + " · max", soll.path("max"), (BigDecimal) v.get("max_wert"));
        VerbrauchVectorsTest.zahl(was + " · energie", soll.path("energie_kwh"), energie(v));
        assertThat(v.get("menge_zustand")).as(was + " · zustand").isEqualTo(soll.path("zustand").asText());
        assertThat(zahl(v, "erhalten")).as(was + " · erhalten").isEqualTo(soll.path("erhalten").asInt());
        assertThat(zahl(v, "erwartet")).as(was + " · erwartet").isEqualTo(soll.path("erwartet").asInt());
        assertThat(zahl(v, "abdeckung_prozent")).as(was + " · abdeckung")
                .isEqualTo(soll.path("abdeckung_prozent").asInt());
        List<String> k = new ArrayList<>();
        soll.path("kennzeichen").forEach(n -> k.add(n.asText()));
        assertThat(kennzeichen(v)).as(was + " · kennzeichen").isEqualTo(k);
        assertThat(v.get("wertart")).isEqualTo("gauge");
        return v;
    }

    /**
     * Eine gröbere Periode aus der Datenbank gegen DIESELBE Regel über alle Rohwerte der Periode —
     * die Zusammensetzung aus Teilen darf nichts anderes ergeben.
     */
    private static void wieDieRegel(String reihe, Map<String, Object> zeile, Instant von, Instant bis,
            Duration kadenz) {
        assertThat(zeile).as(reihe + " " + von).isNotNull();
        Ergebnis soll = VerbrauchRegeln.momentanwerte(ROH.get(reihe), von, bis, kadenz, true);
        String was = reihe + " " + von + "–" + bis;
        assertThat((BigDecimal) zeile.get("mittel")).as(was + " · mittel").isEqualByComparingTo(soll.mittel());
        assertThat((BigDecimal) zeile.get("min_wert")).as(was + " · min").isEqualByComparingTo(soll.min());
        assertThat((BigDecimal) zeile.get("max_wert")).as(was + " · max").isEqualByComparingTo(soll.max());
        assertThat(energie(zeile)).as(was + " · energie").isEqualByComparingTo(soll.energieKwh());
        assertThat(zeile.get("menge_zustand")).as(was + " · zustand").isEqualTo(soll.zustand());
        assertThat(zahl(zeile, "erhalten")).as(was + " · erhalten").isEqualTo(soll.erhalten());
        assertThat(zahl(zeile, "erwartet")).as(was + " · erwartet").isEqualTo(soll.erwartet());
        assertThat(zahl(zeile, "abdeckung_prozent")).as(was + " · abdeckung").isEqualTo(soll.abdeckungProzent());
        assertThat(kennzeichen(zeile)).as(was + " · kennzeichen").isEqualTo(soll.kennzeichen());
        assertThat(zahl(zeile, "gemessen_s")).as(was + " · gemessene Zeit")
                .isEqualTo(soll.erhalten() * (int) kadenz.toSeconds());
        assertThat(zeile.get("menge")).as(was + " · M6").isNull();
    }

    private static JsonNode erwartung(String fall, String name) {
        for (JsonNode e : FAELLE.get(fall).path("expected")) {
            if (e.path("name").asText().equals(name)) {
                return e;
            }
        }
        throw new AssertionError("keine Erwartung " + fall + " " + name);
    }

    private static BigDecimal energie(Map<String, Object> zeile) {
        BigDecimal e = (BigDecimal) zeile.get("energie");
        return e == null ? null : VerbrauchRegeln.rundeEnergie(e);
    }

    private static Map<String, Object> viertelstunde(String reihe, String beginn) {
        return root.queryForMap("SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn = ?",
                IDS.get(reihe), Timestamp.from(Instant.parse(beginn)));
    }

    private static Map<String, Object> tag(String reihe, LocalDate tag) {
        List<Map<String, Object>> z = root.queryForList("SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?",
                IDS.get(reihe), java.sql.Date.valueOf(tag));
        return z.isEmpty() ? null : z.get(0);
    }

    private static Map<String, Object> periode(String reihe, String art, LocalDate tag) {
        List<Map<String, Object>> z = root.queryForList(
                "SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = ? AND tag = ?",
                IDS.get(reihe), art, java.sql.Date.valueOf(tag));
        return z.isEmpty() ? null : z.get(0);
    }

    private static List<String> kennzeichen(Map<String, Object> zeile) {
        return ViertelstundenTeile.kennzeichen(String.valueOf(zeile.get("kennzeichen")));
    }

    private static int zahl(Map<String, Object> zeile, String spalte) {
        return ((Number) zeile.get(spalte)).intValue();
    }

    private static Instant instant(String iso) {
        return VerbrauchRegeln.zeit(iso);
    }

    // ============================================================ Aufbau der Beispielwelt

    private static void stammdaten() {
        for (UUID t : new UUID[] {KB, FREMD}) {
            root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", t,
                    t.equals(KB) ? "Kunststoffwerk Ahrenberg GmbH" : "Kundenbereich B");
            IDS.put("U:" + t, uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                    + "VALUES (?, ?, 'Europe/Berlin') RETURNING id", t, "U " + t));
        }
        IDS.put("ST", uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id",
                KB, IDS.get("U:" + KB)));
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, IDS.get("AN2"), IDS.get("ST"));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));
        int nr = 1;
        for (String r : new String[] {"F3", "F18", "HALB", "OHNE", "SCHLECHT", "SPAET", "F24", "MG"}) {
            int kadenz = "MG".equals(r) ? 300 : 10;
            reihe(KB, IDS.get("AN2"), IDS.get("BOX"), r, "power_kw_" + r.toLowerCase(), kadenz);
            if (!"OHNE".equals(r)) {
                // MS-10 (Spritzgießmaschine, Leistung) als Wirkenergie aus Leistung — Herleitung
                // `integration`, AP-04 Regel 7. SPÄT beginnt erst um 10:10 Ortszeit am 20.10.
                UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                        + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', "
                        + "'Bezug', 'kWh', 'Intervallmenge') RETURNING id", KB, String.format("MS-%04d", nr++),
                        "Energie aus Leistung " + r);
                bindung(KB, ms, IDS.get(r), KANAL.get(r),
                        "SPAET".equals(r) ? "2026-10-20T08:10:00Z" : "2024-03-12T00:00:00Z");
            }
        }
        IDS.put("AN-F", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'B-1') RETURNING id", FREMD));
        IDS.put("BOX-F", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-B', 'claimed') RETURNING id", FREMD, IDS.get("AN-F")));
        reihe(FREMD, IDS.get("AN-F"), IDS.get("BOX-F"), "FREMD", "power_kw_fremd", 10);
    }

    private static void reihe(UUID tenant, UUID site, UUID box, String name, String kanal, int kadenz) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'consumer', ?, 'consumer', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, site, name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, site, box, entity, kanal, kadenz);
        IDS.put(name, entity);
        KANAL.put(name, kanal);
    }

    private static void bindung(UUID tenant, UUID messstelle, UUID komponente, String kanal, String ab) {
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'gauge', 'integration', "
                + "'fuehrend', ?, false, now(), 'sub', 'Probe', 'kunde')",
                tenant, messstelle, komponente, geraet, kanal, Timestamp.from(Instant.parse(ab)));
    }

    private static void rohwerte() {
        saeen(KB, "F3", VerbrauchVectorsTest.rohwerte(FAELLE.get("f3").path("input").path("reihe")), "good");
        saeen(KB, "OHNE", VerbrauchVectorsTest.rohwerte(FAELLE.get("f3").path("input").path("reihe")), "good");
        saeen(KB, "F18", VerbrauchVectorsTest.rohwerte(FAELLE.get("f18").path("input").path("reihe")), "good");
        saeen(KB, "F24", VerbrauchVectorsTest.rohwerte(FAELLE.get("f24").path("input").path("reihe")), "good");

        Instant zehn = Instant.parse("2026-10-20T08:00:00Z");
        List<Rohwert> halb = new ArrayList<>();
        List<Rohwert> schlecht = new ArrayList<>();
        List<Rohwert> spaet = new ArrayList<>();
        for (int i = 0; i < 90; i++) {
            if (i < 45) {
                halb.add(new Rohwert(zehn.plusSeconds(10L * i), new BigDecimal(50 + i).setScale(1)));
            }
            schlecht.add(new Rohwert(zehn.plusSeconds(10L * i), new BigDecimal("96.0")));
        }
        for (int i = 0; i < 180; i++) {
            spaet.add(new Rohwert(zehn.minusSeconds(900).plusSeconds(10L * i), new BigDecimal("50.0")));
        }
        saeen(KB, "HALB", halb, "good");
        saeen(KB, "SCHLECHT", schlecht, "invalid");
        saeen(KB, "SPAET", spaet, "good");
        saeen(KB, "MG", mgRohwerte(), "good");

        List<Rohwert> fremd = new ArrayList<>();
        for (int i = 0; i < 90; i++) {
            fremd.add(new Rohwert(zehn.plusSeconds(10L * i), new BigDecimal("12.0")));
        }
        saeen(FREMD, "FREMD", fremd, "good");
    }

    /**
     * 31.10. 00:02 bis 01.11. 23:57 UTC-Raster + 2 min, alle 300 s, 40,0–45,5 kW im Zwölfer-Takt; ohne
     * die Werte in [31.10. 11:00, 12:30) UTC (Lücke, der Wert 10:57 hält in die leere Viertelstunde 11:00)
     * und ohne den Wert 23:02 UTC am 31.10. — dort, direkt hinter der Monatsgrenze, hält 22:57 bis 23:07.
     */
    private static List<Rohwert> mgRohwerte() {
        List<Rohwert> aus = new ArrayList<>();
        Instant t = Instant.parse("2026-10-30T23:02:00Z");
        Instant ende = Instant.parse("2026-11-01T22:57:00Z");
        Instant lueckeVon = Instant.parse("2026-10-31T11:00:00Z");
        Instant lueckeBis = Instant.parse("2026-10-31T12:30:00Z");
        Instant grenze = Instant.parse("2026-10-31T23:02:00Z");
        for (int i = 0; !t.isAfter(ende); i++, t = t.plusSeconds(300)) {
            if ((!t.isBefore(lueckeVon) && t.isBefore(lueckeBis)) || t.equals(grenze)) {
                continue;
            }
            aus.add(new Rohwert(t, new BigDecimal("40.0").add(new BigDecimal("0.5").multiply(BigDecimal.valueOf(i % 12)))));
        }
        return aus;
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "
                    + "'2026.09.11.1', ?, 'gauge', ?, 3, 'gauge', 'fuehrend', 'direkt', 2)";

    private static void saeen(UUID tenant, String reihe, List<Rohwert> werte, String qualitaet) {
        ROH.put(reihe, List.copyOf(werte));
        int nr = new ArrayList<>(IDS.keySet()).indexOf(reihe);
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(zeile(tenant, IDS.get(reihe), KANAL.get(reihe), r.zeit(), r.wert(), qualitaet, nr));
        }
        root.batchUpdate(ROH_SQL, stapel);
        if (!"good".equals(qualitaet)) {
            ROH.put(reihe, werte.stream().map(r -> new Rohwert(r.zeit(), r.wert(), false)).toList());
        }
    }

    private static Object[] zeile(UUID tenant, UUID entity, String kanal, Instant t, BigDecimal wert, String qualitaet,
            int nr) {
        boolean kb = tenant.equals(KB);
        return new Object[] {Timestamp.from(t), Timestamp.from(t.plusSeconds(2)), tenant,
                kb ? IDS.get("AN2") : IDS.get("AN-F"), kb ? IDS.get("BOX") : IDS.get("BOX-F"), kanal, wert, qualitaet,
                t.getEpochSecond() * 100 + nr, entity};
    }

    // ------------------------------------------------------------------------ Die Läufe

    private static void arbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s
                 WHERE s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'
                ON CONFLICT DO NOTHING
                """);
    }

    private static void tagArbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund)
                SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                       (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                  FROM messreihe_viertelstunde v
                ON CONFLICT DO NOTHING
                """);
    }

    private static int verdichtenBisLeer(Instant jetzt) {
        int geschrieben = 0;
        while (true) {
            int[] r = verdichter.verdichteEinenStapel(jetzt);
            if (r[0] == 0) {
                return geschrieben;
            }
            geschrieben += r[1];
        }
    }

    private static int tagLaufBisLeer(Instant jetzt) {
        int geschrieben = 0;
        while (true) {
            int[] r = tage.bildeEinenStapel(jetzt);
            if (r[0] == 0) {
                return geschrieben;
            }
            geschrieben += r[1];
        }
    }

    private static int periodenLaufBisLeer(Instant jetzt) {
        int geschrieben = 0;
        while (true) {
            int[] r = perioden.bildeEinenStapel(jetzt);
            if (r[0] == 0) {
                return geschrieben;
            }
            geschrieben += r[1];
        }
    }

    // ------------------------------------------------------------------------ Helfer

    private static List<String> rechte(String rolle, String tabelle) {
        return root.queryForList("SELECT privilege_type FROM information_schema.table_privileges "
                + "WHERE grantee = ? AND table_name = ? ORDER BY privilege_type", String.class, rolle, tabelle);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static int zahl(String sql) {
        return root.queryForObject(sql, Integer.class);
    }

    /** Die drei Werteklassen Zeile für Zeile — für „der zweite Lauf schreibt nichts". */
    private static String werteFinger() {
        StringBuilder b = new StringBuilder();
        for (String tabelle : List.of("messreihe_viertelstunde", "messreihe_tag", "messreihe_periode")) {
            b.append(root.queryForObject("SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'leer') "
                    + "FROM " + tabelle + " t", String.class)).append(';');
        }
        return b.toString();
    }

    private static Map<String, String> fingerabdruck() {
        List<String> tabellen = root.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' "
                        + "AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'messreihe_%' "
                        + "AND table_name <> 'device_measurement_sample' "
                        + "AND table_name <> 'flyway_schema_history' ORDER BY table_name",
                String.class);
        Map<String, String> aus = new LinkedHashMap<>();
        for (String tabelle : tabellen) {
            aus.put(tabelle, root.queryForObject("SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), "
                    + "'leer') FROM " + tabelle + " t", String.class));
        }
        return aus;
    }

    private static String rohwerteFinger() {
        return root.queryForObject("SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'leer') "
                + "FROM device_measurement_sample t", String.class);
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
