package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
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
 * Die Migration {@code V20260912205000} und die PERIODENMENGEN (UEMS AP-08 IP-5) gegen eine echte
 * TimescaleDB — die Rohwerte der Vektor-Fälle gehen durch die ganze Strecke (Viertelstunde →
 * Endgültigkeit → Tag → Monat → Jahr, dazu der freie Zeitraum) und kommen als die Zahlen der
 * Vektor-Datei wieder heraus.
 *
 * <p><b>Der eine Satz, den dieser Test beweist:</b> eine Tagesmenge ist NICHT die Summe der
 * Viertelstunden ({@link #gegenprobeDieSummeDerViertelstundenIstNichtDieTagesmenge}) — sie ist die
 * Differenz der Periodenstände an den Tagesgrenzen, und wo an einer Grenze kein Stand gemessen
 * wurde, wird keiner erfunden.
 *
 * <p><b>Die Fälle:</b> F8 (Tag mit 3,5 Stunden Box-Ausfall), F13 (25.10.2026, 25 Stunden), F14
 * (28.03.2027, 23 Stunden), F16 (Oktober 2026), F20 (Lücke über die Tagesgrenze — zwei
 * unvollständige Tage, ein vollständiger Zeitraum); dazu eine Reihe über die Monatsgrenze
 * Oktober/November mit einer Lücke um Mitternacht und eine Reihe des fremden Kundenbereichs.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsPeriodenmengeTest {

    private static final String DIESE = "20260912205000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000005");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000006");

    /** Die letzten Oktobertage laufen noch in ihrer Frist (bis 08.11.) — der Oktober ist vorläufig. */
    private static final Instant T_VORLAEUFIG = Instant.parse("2026-11-05T12:00:00Z");

    /** Alles bis März 2027 hat seine Frist hinter sich. */
    private static final Instant T_SPAETER = Instant.parse("2027-04-10T12:00:00Z");

    private static final List<String> BESTAND = List.of(
            "device_measurement_event", "device_measurement_rollup_5m", "device_measurement_rollup_15m",
            "device_measurement_selection", "measurement_point", "messstelle", "geraet", "standort",
            "unternehmen", "anlage_standort", "telemetry", "telemetry_v2", "schedule",
            "site_supply_price", "entity_registry_state", "device_command_log");

    /**
     * Die Tabellen, die dieses Paket bearbeitet, und die Rohtabelle — nicht Teil des
     * Bestands-Fingerabdrucks. Die Rohtabelle wächst in diesem Test selbst; dass keine BESTEHENDE
     * Rohzeile sich ändert, prüft {@link #rohwerteFinger()} eigens.
     */
    private static final List<String> AUSNAHMEN = List.of("messreihe_%", "device_measurement_sample");

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
    private static ZeitraumMenge zeitraum;

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static final Map<String, JsonNode> FAELLE = new LinkedHashMap<>();

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachAllem;
    private static String rohVorher;
    private static String rohNachAllem;

    private static Map<String, Object> oktoberVorlaeufig;
    private static Map<String, Object> jahr2026Vorlaeufig;
    private static Map<String, Object> oktoberEndgueltig;
    private static Map<String, Object> oktoberNachSpaetankunft;
    private static int tagZweitesMal;
    private static int periodeZweitesMal;
    private static boolean abbruchWarf;
    private static int arbeitNachAbbruch;
    private static int zeilenNachAbbruch;
    private static Map<String, Object> jahrVorAbbruch;
    private static Map<String, Object> jahrNachAbbruch;
    private static int nachgeholt;
    private static int nachholenLeer;

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
        zeitraum = new ZeitraumMenge(app);

        // ---- 1. Anfang November: Viertelstunden, Endgültigkeit, Tage, Monate, Jahre ---------
        arbeitFuellen();
        verdichtenBisLeer(T_VORLAEUFIG);
        endgueltigkeit.umschalten(T_VORLAEUFIG);
        tagArbeitFuellen();
        tagLaufBisLeer(T_VORLAEUFIG);
        periodenLaufBisLeer(T_VORLAEUFIG);
        oktoberVorlaeufig = periode("F16", "monat", LocalDate.of(2026, 10, 1));
        jahr2026Vorlaeufig = periode("F16", "jahr", LocalDate.of(2026, 1, 1));

        // ---- 2. April 2027: alles Fällige wird endgültig, die Stufen ziehen nach ------------
        endgueltigkeit.umschalten(T_SPAETER);
        tage.eintragenAusFrist(T_SPAETER);
        tagLaufBisLeer(T_SPAETER);
        perioden.lauf(T_SPAETER);
        periodenLaufBisLeer(T_SPAETER);
        oktoberEndgueltig = periode("F16", "monat", LocalDate.of(2026, 10, 1));

        // ---- 3. Wiederholbar: dieselben Tage und Perioden noch einmal schreiben NICHTS -------
        tagArbeitFuellen();
        tagZweitesMal = tagLaufBisLeer(T_SPAETER);
        root.update("INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art, tag, grund) "
                + "SELECT tenant_id, entity_id, messkanal, art, tag, 'frist' FROM messreihe_periode "
                + "ON CONFLICT DO NOTHING");
        periodeZweitesMal = periodenLaufBisLeer(T_SPAETER);
        nachholenLeer = perioden.nachholen();

        // ---- 4. Eine ENDGÜLTIGE Periode wird nie angefasst ---------------------------------
        // Ein Rohwert für den 15.10. trifft im April ein: gespeichert, gemeldet, nie angewendet —
        // und selbst wenn Tag und Monat erneut in der Liste stehen, bleibt der Oktober stehen.
        roh(KB, IDS.get("F16"), "energy_kwh_f16", Instant.parse("2026-10-15T10:00:30Z"),
                new BigDecimal("9999999"), T_SPAETER);
        arbeitFuellen();
        verdichtenBisLeer(T_SPAETER);
        tagArbeitFuellen();
        tagLaufBisLeer(T_SPAETER);
        root.update("INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art, tag, grund) "
                + "VALUES (?, ?, 'energy_kwh_f16', 'monat', DATE '2026-10-01', 'tag')", KB, IDS.get("F16"));
        periodenLaufBisLeer(T_SPAETER);
        oktoberNachSpaetankunft = periode("F16", "monat", LocalDate.of(2026, 10, 1));

        // ---- 5. Nachholen: ein Monat ohne Zeile, dessen Tage stehen, kommt in die Liste ------
        root.update("DELETE FROM messreihe_periode WHERE entity_id = ? AND art = 'monat' AND tag = '2026-11-01'",
                IDS.get("MG"));
        nachgeholt = perioden.nachholen();
        periodenLaufBisLeer(T_SPAETER);

        // ---- 6. Abbruchsicher: das Schreiben scheitert, die Arbeit bleibt in der Liste -------
        jahrVorAbbruch = periode("F14", "jahr", LocalDate.of(2027, 1, 1));
        root.update("DELETE FROM messreihe_periode WHERE entity_id = ? AND art = 'jahr'", IDS.get("F14"));
        root.update("INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art, tag, grund) "
                + "VALUES (?, ?, 'energy_kwh_f14', 'jahr', DATE '2027-01-01', 'monat')", KB, IDS.get("F14"));
        root.execute("REVOKE INSERT ON messreihe_periode FROM " + ADMIN_USER);
        try {
            perioden.bildeEinenStapel(T_SPAETER);
            abbruchWarf = false;
        } catch (RuntimeException e) {
            abbruchWarf = true;
        }
        arbeitNachAbbruch = zahl("SELECT count(*) FROM messreihe_periode_arbeit");
        zeilenNachAbbruch = zahl("SELECT count(*) FROM messreihe_periode WHERE entity_id = '"
                + IDS.get("F14") + "' AND art = 'jahr'");
        root.execute("GRANT INSERT ON messreihe_periode TO " + ADMIN_USER);
        periodenLaufBisLeer(T_SPAETER);
        jahrNachAbbruch = periode("F14", "jahr", LocalDate.of(2027, 1, 1));

        fingerNachAllem = fingerabdruck();
        rohNachAllem = rohwerteFinger();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // =========================================================== Die Vektoren über die DB

    /** F8 (Tag): 3,5 Stunden ohne Werte — der Tag ist trotzdem VOLLSTÄNDIG 2 304 kWh, Abdeckung 85 %. */
    @Test
    void f8DerTagMitBoxAusfallAusDenPeriodenstaenden() {
        pruefeTag("F8", LocalDate.of(2026, 11, 3), "Tag 03.11.2026");
    }

    /** F13: der 25.10.2026 hat 25 Stunden und 100 Viertelstunden — 720 kWh, 1 500 von 1 500. */
    @Test
    void f13DerFuenfundzwanzigStundenTag() {
        pruefeTag("F13", LocalDate.of(2026, 10, 25), "Tag 25.10.2026 (25 h)");
    }

    /** F14: der 28.03.2027 hat 23 Stunden und 92 Viertelstunden — 662,4 kWh, 1 380 von 1 380. */
    @Test
    void f14DerDreiundzwanzigStundenTag() {
        pruefeTag("F14", LocalDate.of(2027, 3, 28), "Tag 28.03.2027 (23 h)");
    }

    /** F20: an der Tagesgrenze fehlt der Stand — BEIDE Tage sind unvollständig, keiner erfindet ihn. */
    @Test
    void f20ZweiUnvollstaendigeTageOhneErfundenenStand() {
        Map<String, Object> zwanzigster = pruefeTag("F20", LocalDate.of(2026, 10, 20), "Tag 20.10.2026");
        Map<String, Object> einundzwanzigster = pruefeTag("F20", LocalDate.of(2026, 10, 21), "Tag 21.10.2026");
        assertThat(zwanzigster.get("stand_ende")).as("kein Stand um Mitternacht — nicht fortgeschrieben").isNull();
        assertThat(einundzwanzigster.get("stand_anfang")).as("und nicht vom Wert um 01:00 zurückgerechnet")
                .isNull();
        assertThat((BigDecimal) zwanzigster.get("stand_anfang")).isEqualByComparingTo("402000.0");
        assertThat((BigDecimal) einundzwanzigster.get("stand_ende")).isEqualByComparingTo("406608.0");
    }

    /** F20: der Zeitraum 20.–21.10. hat EIGENE Periodenstände und ist VOLLSTÄNDIG 4 608 kWh. */
    @Test
    void f20DerFreieZeitraumIstVollstaendig() {
        JsonNode soll = erwartung("F20", "Zeitraum 20.–21.10.2026");
        TenantContext.set(KB);
        ZeitraumMenge.Zeitraum z = zeitraum.zeitraum(KB, IDS.get("F20"), "energy_kwh_f20",
                VerbrauchRegeln.zeit(soll.path("von").asText()), VerbrauchRegeln.zeit(soll.path("bis").asText()),
                T_SPAETER);
        vergleiche(soll, z.menge().ergebnis().menge(), z.menge().ergebnis().zustand(), z.erhalten(), z.erwartet(),
                z.abdeckungProzent(), z.menge().ergebnis().kennzeichen());
        BigDecimal summeDerTage = tagesmenge("F20", LocalDate.of(2026, 10, 20))
                .add(tagesmenge("F20", LocalDate.of(2026, 10, 21)));
        assertThat(summeDerTage).as("die Summe der Tage verlöre den Zuwachs über die Lücke")
                .isEqualByComparingTo("4416.0");
        assertThat(z.zustand()).isEqualTo("endgueltig");
    }

    /** F16: der Oktober 2026 — 55 100 kWh, 44 700 von 44 700, 745 Stunden, Zone gespeichert. */
    @Test
    void f16DerOktoberAusDenPeriodenstaenden() {
        JsonNode soll = erwartung("F16", "Monat Oktober 2026");
        Map<String, Object> m = oktoberEndgueltig;
        vergleiche(soll, (BigDecimal) m.get("menge"), (String) m.get("menge_zustand"), zahl(m, "erhalten"),
                zahl(m, "erwartet"), (Integer) nummer(m, "abdeckung_prozent"), kennzeichen(m));
        assertThat(zahl(m, "stunden")).as("der 25-Stunden-Tag steckt im Monat").isEqualTo(745);
        assertThat(m.get("zeitzone")).isEqualTo("Europe/Berlin");
        assertThat(m.get("zeitzone_herkunft")).isEqualTo("standort");
        assertThat(zahl(m, "teile_erwartet")).isEqualTo(31);
        assertThat(zahl(m, "teile_vorhanden")).isEqualTo(31);
        assertThat(((Timestamp) m.get("beginn")).toInstant()).isEqualTo(Instant.parse("2026-09-30T22:00:00Z"));
        assertThat(((Timestamp) m.get("ende")).toInstant()).isEqualTo(Instant.parse("2026-10-31T23:00:00Z"));
    }

    // ============================================================= Die Kernaussage

    /**
     * DER KERN DES PAKETS: am 03.11.2026 (F8) summieren sich die Viertelstundenmengen zu 1 966,4 kWh —
     * die Tagesmenge aus den Periodenständen ist 2 304,0 kWh. Die Differenz ist genau der
     * gemessene Zuwachs über die Lücke (337,6 kWh), den die Summe still verloren hätte.
     */
    @Test
    void gegenprobeDieSummeDerViertelstundenIstNichtDieTagesmenge() {
        Map<String, Object> summe = root.queryForMap(
                "SELECT sum(menge) s, count(*) n, count(menge) mit FROM messreihe_viertelstunde "
                        + "WHERE entity_id = ? AND intervall_beginn >= '2026-11-02T23:00:00Z' "
                        + "AND intervall_beginn < '2026-11-03T23:00:00Z'", IDS.get("F8"));
        BigDecimal tag = tagesmenge("F8", LocalDate.of(2026, 11, 3));
        assertThat((BigDecimal) summe.get("s")).isEqualByComparingTo("1966.4");
        assertThat(tag).isEqualByComparingTo("2304.0");
        assertThat(tag).as("die Tagesmenge ist NICHT die Summe der Viertelstunden")
                .isNotEqualByComparingTo((BigDecimal) summe.get("s"));
        assertThat(tag.subtract((BigDecimal) summe.get("s"))).isEqualByComparingTo("337.6");
        assertThat(((Number) summe.get("mit")).intValue()).as("eine Viertelstunde ohne Menge")
                .isLessThan(((Number) summe.get("n")).intValue());
    }

    /** Die Monatsgrenze: ein freier Zeitraum darüber hat seine eigenen Stände und klebt keine Monate. */
    @Test
    void derFreieZeitraumUeberDieMonatsgrenzeFolgtDerselbenRegel() {
        // 30.10. 00:00 bis 02.11. 00:00 Ortszeit — über die Monatsgrenze und die Lücke um Mitternacht.
        Instant von = Instant.parse("2026-10-29T23:00:00Z");
        Instant bis = Instant.parse("2026-11-01T23:00:00Z");
        TenantContext.set(KB);
        ZeitraumMenge.Zeitraum z = zeitraum.zeitraum(KB, IDS.get("MG"), "energy_kwh_mg", von, bis, T_SPAETER);

        // Dieselbe Regel über dieselben ROHWERTE — die Antwort ist Zeichen für Zeichen dieselbe.
        VerbrauchRegeln.Ergebnis roh = VerbrauchRegeln.ergebnis("zaehlerstand", mgRohwerte(), von, bis,
                Duration.ofSeconds(60), List.of(), BigDecimal.ONE, null, null, false);
        assertThat(z.menge().ergebnis()).isEqualTo(roh);
        assertThat(roh.zustand()).isEqualTo("vollständig");
        assertThat(roh.kennzeichen()).containsExactly(
                "Lücke 23:40–00:20: Zuwachs 64.000 gemessen, nicht auf Viertelstunden verteilbar");

        Map<String, Object> oktober = periode("MG", "monat", LocalDate.of(2026, 10, 1));
        Map<String, Object> november = periode("MG", "monat", LocalDate.of(2026, 11, 1));
        assertThat(oktober.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(november.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(oktober.get("stand_ende")).as("kein Stand an der Monatsgrenze").isNull();
        assertThat(((BigDecimal) oktober.get("menge")).add((BigDecimal) november.get("menge")))
                .as("zwei Monate zusammengeklebt verlören den Zuwachs über Mitternacht")
                .isEqualByComparingTo(z.menge().ergebnis().menge().subtract(new BigDecimal("64.000")));
    }

    /** Nur im Viertelstunden-Raster — ein Zeitraum ab 10:07 ist ein Fehler, nie still gerundet. */
    @Test
    void einFreierZeitraumAusserhalbDesRastersWirdAbgewiesen() {
        TenantContext.set(KB);
        assertThatThrownBy(() -> zeitraum.zeitraum(KB, IDS.get("MG"), "energy_kwh_mg",
                Instant.parse("2026-10-31T10:07:00Z"), Instant.parse("2026-10-31T12:00:00Z"), T_SPAETER))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // ============================================================ Die Fortpflanzung

    /** Ein vorläufiger Tag macht seinen Monat vorläufig — und der Monat sein Jahr. */
    @Test
    void einVorlaeufigerTagMachtSeinenMonatUndSeinJahrVorlaeufig() {
        assertThat(oktoberVorlaeufig.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(zahl(oktoberVorlaeufig, "teile_vorhanden")).isEqualTo(31);
        assertThat(zahl(oktoberVorlaeufig, "teile_endgueltig")).as("der 29.–31.10. laufen noch")
                .isLessThan(31).isPositive();
        assertThat(jahr2026Vorlaeufig.get("zustand")).isEqualTo("vorlaeufig");
        // Die MENGE ist schon dieselbe — vorläufig heißt „kann sich noch ändern", nicht „anders".
        assertThat((BigDecimal) oktoberVorlaeufig.get("menge")).isEqualByComparingTo("55100.000");
        assertThat(oktoberEndgueltig.get("zustand")).isEqualTo("endgueltig");
        assertThat(zahl(oktoberEndgueltig, "teile_endgueltig")).isEqualTo(31);
        assertThat(periode("F16", "jahr", LocalDate.of(2026, 1, 1)).get("zustand")).isEqualTo("endgueltig");
    }

    /** Abdeckung und Kennzeichen pflanzen sich fort: der Monat trägt die Lücke seines Tages. */
    @Test
    void abdeckungUndKennzeichenPflanzenSichInDenMonatFort() {
        Map<String, Object> november = periode("F8", "monat", LocalDate.of(2026, 11, 1));
        assertThat(kennzeichen(november)).contains(
                "Lücke 14:00–17:31: Zuwachs 337.600 gemessen, nicht auf Viertelstunden verteilbar");
        // 1 230 Werte des 03.11. und der Stand um 04.11. 00:00, der den Tag schließt.
        assertThat(zahl(november, "erhalten")).isEqualTo(1231);
        assertThat(zahl(november, "erwartet")).as("jede Minute des Novembers ist erwartet").isEqualTo(43200);
        assertThat(nummer(november, "abdeckung_prozent")).isEqualTo(2);
        assertThat(november.get("menge_zustand")).as("ohne Stand am 01.11. 00:00").isEqualTo("unvollständig");
    }

    // ===================================================== Wiederholbar · endgültig · Abbruch

    @Test
    void derZweiteLaufSchreibtNichts() {
        assertThat(tagZweitesMal).as("Tage").isZero();
        assertThat(periodeZweitesMal).as("Monate und Jahre").isZero();
        assertThat(nachholenLeer).as("und nachzuholen gibt es nichts").isZero();
    }

    @Test
    void eineEndgueltigePeriodeWirdNieAngefasst() {
        assertThat(oktoberNachSpaetankunft).isEqualTo(oktoberEndgueltig);
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival' AND entity_id = '"
                + IDS.get("F16") + "'")).as("der Nachzügler ist gemeldet, nicht angewendet").isPositive();
    }

    @Test
    void einMonatOhneZeileWirdNachgeholt() {
        assertThat(nachgeholt).isPositive();
        assertThat(periode("MG", "monat", LocalDate.of(2026, 11, 1))).isNotNull();
    }

    @Test
    void einAbbruchLaesstNichtsHalbesZurueck() {
        assertThat(abbruchWarf).isTrue();
        assertThat(arbeitNachAbbruch).as("der Eintrag steht noch in der Liste").isOne();
        assertThat(zeilenNachAbbruch).as("und keine halbe Zeile").isZero();
        Map<String, Object> vorher = new LinkedHashMap<>(jahrVorAbbruch);
        Map<String, Object> nachher = new LinkedHashMap<>(jahrNachAbbruch);
        vorher.remove("berechnet_am");
        nachher.remove("berechnet_am");
        assertThat(nachher).as("der nächste Lauf bildet dieselbe Zeile").isEqualTo(vorher);
        assertThat(zahl("SELECT count(*) FROM messreihe_periode_arbeit")).isZero();
    }

    // ============================================================ Tabelle und Zaun

    @Test
    void dieMigrationLegtNurDanebenUndDerGanzeLaufLaesstDenBestandZeichengleich() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).as("nach der Migration")
                .isEmpty();
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachAllem)).as("nach allen Läufen")
                .isEmpty();
        assertThat(fingerVorher).hasSizeGreaterThan(100).containsKeys(BESTAND.toArray(String[]::new));
        assertThat(rohNachAllem).as("keine bestehende Rohzeile ändert sich").isEqualTo(rohVorher);
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile und eine neue Tabelle mit Inhalt fallen auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, AUSNAHMEN, "measurement_point",
                "UPDATE measurement_point SET label = label || ' (Probe)'");
        Bestandsschutz.inhaltsprobe(root, UemsPeriodenmengeTest::rohwerteFinger, "device_measurement_sample",
                "UPDATE device_measurement_sample SET catalog_version = catalog_version || '.probe'");
    }

    @Test
    void diePeriodenklasseIstEineRlsHypertableMitZehnJahren() {
        assertThat(zahl("SELECT count(*) FROM timescaledb_information.hypertables "
                + "WHERE hypertable_name = 'messreihe_periode'")).isOne();
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messreihe_periode'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messreihe_periode_arbeit'", Boolean.class)).isTrue();
        assertThat(zahl("SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention' "
                + "AND hypertable_name = 'messreihe_periode'")).isOne();
        assertThat(rechte(APP_USER, "messreihe_periode")).containsExactly("SELECT");
        assertThat(rechte(APP_USER, "messreihe_periode_arbeit")).isEmpty();
        assertThatThrownBy(() -> root.update("UPDATE messreihe_tag SET menge = 0, menge_zustand = 'keine Werte' "
                + "WHERE entity_id = ?", IDS.get("F8")))
                .as("keine Werte und eine Zahl schließen einander aus").hasMessageContaining("keine_werte_chk");
    }

    @Test
    void derFreieZeitraumEinesFremdenKundenbereichsIstLeer() {
        Instant von = Instant.parse("2026-10-19T00:00:00Z");
        Instant bis = Instant.parse("2026-10-20T00:00:00Z");
        TenantContext.set(KB);
        ZeitraumMenge.Zeitraum fremd = zeitraum.zeitraum(KB, IDS.get("FREMD"), "energy_kwh_fremd", von, bis,
                T_SPAETER);
        assertThat(fremd.viertelstundenVorhanden()).isZero();
        assertThat(fremd.menge()).isNull();
        TenantContext.set(FREMD);
        ZeitraumMenge.Zeitraum eigen = zeitraum.zeitraum(FREMD, IDS.get("FREMD"), "energy_kwh_fremd", von, bis,
                T_SPAETER);
        assertThat(eigen.viertelstundenVorhanden()).isPositive();
        assertThat(eigen.menge()).isNotNull();
    }

    @Test
    void dieAppRolleSiehtNurDenEigenenKundenbereich() {
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_periode", Integer.class)).isZero();
        TenantContext.set(KB);
        int eigene = app.queryForObject("SELECT count(*) FROM messreihe_periode", Integer.class);
        assertThat(eigene).isPositive();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_periode WHERE tenant_id = ?", Integer.class,
                FREMD)).isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_periode WHERE tenant_id = '" + FREMD + "'")).isPositive();
    }

    // ============================================================ Vergleich mit der Datei

    private static Map<String, Object> pruefeTag(String fall, LocalDate tag, String erwartungName) {
        JsonNode soll = erwartung(fall, erwartungName);
        Map<String, Object> t = root.queryForMap("SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?",
                IDS.get(fall), java.sql.Date.valueOf(tag));
        vergleiche(soll, (BigDecimal) t.get("menge"), (String) t.get("menge_zustand"), zahl(t, "erhalten"),
                zahl(t, "erwartet"), (Integer) nummer(t, "abdeckung_prozent"), kennzeichen(t));
        if (soll.has("stunden")) {
            assertThat(zahl(t, "stunden")).isEqualTo(soll.path("stunden").asInt());
            assertThat(zahl(t, "slots_erwartet")).isEqualTo(soll.path("stunden").asInt() * 4);
            // Und die Grenze selbst, in SQL nachgemessen — nicht nur die gespeicherte Zahl.
            assertThat(root.queryForObject("SELECT extract(epoch FROM ende - beginn)::int / 3600 FROM messreihe_tag "
                    + "WHERE entity_id = ? AND tag = ?", Integer.class, IDS.get(fall), java.sql.Date.valueOf(tag)))
                    .isEqualTo(soll.path("stunden").asInt());
        }
        assertThat(t.get("zeitzone")).isEqualTo("Europe/Berlin");
        return t;
    }

    private static void vergleiche(JsonNode soll, BigDecimal menge, String zustand, int erhalten, int erwartet,
            Integer abdeckung, List<String> kennzeichen) {
        String was = soll.path("name").asText();
        VerbrauchVectorsTest.zahl(was + " · menge", soll.path("menge"), menge);
        assertThat(zustand).as(was + " · zustand").isEqualTo(soll.path("zustand").asText());
        assertThat(erhalten).as(was + " · erhalten").isEqualTo(soll.path("erhalten").asInt());
        assertThat(erwartet).as(was + " · erwartet").isEqualTo(soll.path("erwartet").asInt());
        assertThat(abdeckung).as(was + " · abdeckung").isEqualTo(soll.path("abdeckung_prozent").asInt());
        List<String> k = new ArrayList<>();
        soll.path("kennzeichen").forEach(n -> k.add(n.asText()));
        assertThat(kennzeichen).as(was + " · kennzeichen").isEqualTo(k);
    }

    private static JsonNode erwartung(String fall, String name) {
        for (JsonNode e : FAELLE.get(fall.toLowerCase()).path("expected")) {
            if (e.path("name").asText().equals(name)) {
                return e;
            }
        }
        throw new AssertionError("keine Erwartung " + fall + " " + name);
    }

    private static BigDecimal tagesmenge(String fall, LocalDate tag) {
        return root.queryForObject("SELECT menge FROM messreihe_tag WHERE entity_id = ? AND tag = ?",
                BigDecimal.class, IDS.get(fall), java.sql.Date.valueOf(tag));
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

    private static Object nummer(Map<String, Object> zeile, String spalte) {
        Object o = zeile.get(spalte);
        return o == null ? null : ((Number) o).intValue();
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
        for (String r : new String[] {"F8", "F13", "F14", "F16", "F20", "MG"}) {
            IDS.put(r, reihe(KB, IDS.get("AN2"), IDS.get("BOX"), r, "energy_kwh_" + r.toLowerCase()));
        }
        IDS.put("AN-F", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'B-1') RETURNING id", FREMD));
        IDS.put("BOX-F", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-B', 'claimed') RETURNING id", FREMD, IDS.get("AN-F")));
        IDS.put("FREMD", reihe(FREMD, IDS.get("AN-F"), IDS.get("BOX-F"), "FREMD", "energy_kwh_fremd"));
    }

    private static UUID reihe(UUID tenant, UUID site, UUID box, String name, String kanal) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, site, name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, site, box, entity, kanal);
        return entity;
    }

    /** Die Rohwerte der Vektor-Fälle — Zeichen für Zeichen die Eingänge der Datei. */
    private static void rohwerte() {
        for (String fall : new String[] {"F8", "F13", "F14", "F16", "F20"}) {
            JsonNode reihe = FAELLE.get(fall.toLowerCase()).path("input").path("reihe");
            saeen(KB, IDS.get(fall), "energy_kwh_" + fall.toLowerCase(), VerbrauchVectorsTest.rohwerte(reihe));
        }
        saeen(KB, IDS.get("MG"), "energy_kwh_mg", mgRohwerte());
        List<Rohwert> fremd = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            fremd.add(new Rohwert(Instant.parse("2026-10-19T08:00:00Z").plusSeconds(60L * i),
                    new BigDecimal(900 + i)));
        }
        saeen(FREMD, IDS.get("FREMD"), "energy_kwh_fremd", fremd);
    }

    /** Über die Monatsgrenze: 30.10. 00:00 bis 02.11. 00:00 Ortszeit, 1,6 kWh je Minute, Lücke 23:40–00:20. */
    private static List<Rohwert> mgRohwerte() {
        List<Rohwert> aus = new ArrayList<>();
        Instant t = Instant.parse("2026-10-29T23:00:00Z");
        Instant ende = Instant.parse("2026-11-01T23:00:00Z");
        Instant lueckeVon = Instant.parse("2026-10-31T22:41:00Z");
        Instant lueckeBis = Instant.parse("2026-10-31T23:20:00Z");
        for (long i = 0; !t.isAfter(ende); i++, t = t.plusSeconds(60)) {
            if (!t.isBefore(lueckeVon) && t.isBefore(lueckeBis)) {
                continue;
            }
            aus.add(new Rohwert(t, new BigDecimal("300000").add(new BigDecimal("1.6").multiply(BigDecimal.valueOf(i)))));
        }
        return aus;
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2)";

    private static void saeen(UUID tenant, UUID entity, String kanal, List<Rohwert> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(zeile(tenant, entity, kanal, r.zeit(), r.wert(), r.zeit().plusSeconds(2)));
            if (stapel.size() == 5000) {
                root.batchUpdate(ROH_SQL, stapel);
                stapel.clear();
            }
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static void roh(UUID tenant, UUID entity, String kanal, Instant t, BigDecimal wert, Instant eingang) {
        root.update(ROH_SQL, zeile(tenant, entity, kanal, t, wert, eingang));
    }

    private static Object[] zeile(UUID tenant, UUID entity, String kanal, Instant t, BigDecimal wert, Instant eingang) {
        boolean kb = tenant.equals(KB);
        return new Object[] {Timestamp.from(t), Timestamp.from(eingang), tenant, kb ? IDS.get("AN2") : IDS.get("AN-F"),
                kb ? IDS.get("BOX") : IDS.get("BOX-F"), kanal, wert, t.getEpochSecond(), entity};
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

    private static void verdichtenBisLeer(Instant jetzt) {
        while (verdichter.verdichteEinenStapel(jetzt)[0] > 0) {
            // weiter, bis die Liste leer ist
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

    private static Map<String, String> fingerabdruck() {
        return Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
    }

    /** Die pünktlichen Rohwerte — der Nachzügler vom April kommt dazu, keine bestehende Zeile ändert sich. */
    private static String rohwerteFinger() {
        return Bestandsschutz.inhalt(root, "device_measurement_sample", "t.received_at < ?",
                Timestamp.from(T_SPAETER));
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
