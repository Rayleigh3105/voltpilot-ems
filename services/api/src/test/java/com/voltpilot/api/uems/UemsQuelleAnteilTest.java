package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRegisterRepository.QuelleZeile;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Werte;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-08 IP-7 über die Datenbank: EIN Vorzeichen-Kanal (K-3 · Wirkleistung, Katalog import_export)
 * speist die Bezug-Messstelle MS-01 mit seinem positiven und die Abgabe-Messstelle MS-02 mit seinem
 * negativen Anteil — geteilt JE ROHWERT, nie je Mittelwert (E15 = A, Vektor F19).
 *
 * <p>Die Rohwerte sind Zeichen für Zeichen die Reihe {@code wirkleistung} von F19 aus
 * {@code verbrauch-vectors.json} (in W, wie der Katalog sie führt): 12:00–12:04 +38,4 kW Bezug,
 * 12:05–12:15 −34,2 kW Abgabe. Bewiesen wird:
 * <ul>
 *   <li>F19 mit allen vier Zahlen: MS-01 Mittel 12,8 kW · 3,2 kWh, MS-02 Mittel 22,8 kW · 5,7 kWh —
 *       samt Min 0 (die Nullen zählen mit) und dem Kennzeichen „positiver Anteil von K-3 · Wirkleistung“;</li>
 *   <li>die benannte Gegenprobe: erst mitteln, dann nach Vorzeichen zuordnen ist FALSCH (−10,0 → nur
 *       „Abgabe 10,0“), und die gespeicherte Viertelstunde des ganzen Werts trägt keine Energie — kein
 *       stiller Saldo, auch nicht mit einer Bindung {@code integration} mit Anteil;</li>
 *   <li>das Box-Vorzeichen wirkt genau einmal: eine Einstellungs-Fassung „Vorzeichen umgekehrt“ ändert
 *       am Leseweg nichts;</li>
 *   <li>die Datenbank hält den Anteil je Messwert (Exklusion, CHECK, nie überschrieben) und die
 *       Anschlussleistung (&gt; 0); der Mandantenzaun; der Bestand bleibt Zeichen für Zeichen.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsQuelleAnteilTest {

    private static final String DIESE = "20260913180000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0f0000-0000-0000-0000-000000000701");
    private static final UUID FREMD = UUID.fromString("4e0f0000-0000-0000-0000-000000000702");

    /** Der Vorzeichen-Wert am Zählpunkt, wie der Katalog ihn führt (W, import_export). */
    private static final String WIRKLEISTUNG = "sunspec.model_203.w";
    private static final String BEZUG_ZAEHLER = "sunspec.model_203.totwhimp";

    private static final Instant VON = Instant.parse("2026-10-20T10:00:00Z");
    private static final Instant BIS = Instant.parse("2026-10-20T10:15:00Z");
    private static final Instant JETZT = Instant.parse("2026-10-20T12:00:00Z");

    /** Die Tabellen, in die dieser Test NACH der Migration schreibt — ihr Bestand wird eigens geprüft. */
    private static final List<String> AUSNAHMEN = List.of("messreihe_%", "messstelle_quelle", "quelle_einstellung");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static QuelleAnteilWerte leseweg;

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static JsonNode f19;

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachAllem;
    private static String bestandsbindungenVorher;
    private static String bestandsbindungenNachAllem;
    private static String rohVorher;
    private static String rohNachAllem;

    private static QuelleAnteilWerte.Periode ms01;
    private static QuelleAnteilWerte.Periode ms02;
    private static QuelleAnteilWerte.Periode ms01NachVorzeichenFassung;
    private static QuelleAnteilWerte.Periode ms02NachVorzeichenFassung;
    private static Map<String, Object> viertelstundeDesGanzenWerts;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            if (fall.path("name").asText().startsWith("f19-")) {
                f19 = fall;
            }
        }
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        stammdaten();
        rohwerte();
        fingerVorher = fingerabdruck();
        bestandsbindungenVorher = bestandsbindungen();
        rohVorher = tabellenFinger("device_measurement_sample");

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = fingerabdruck();
        flyway().load().migrate();

        JdbcTemplate admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        MeasurementCatalog katalog = new MeasurementCatalog(new ObjectMapper());
        leseweg = new QuelleAnteilWerte(app,
                new MesskanalService(app, null, katalog, new ObjectMapper(), null, null),
                new QuelleKadenzRepository(app));

        // ---- 1. Die Bindungen mit Anteil: MS-01 positiv (Bezug), MS-02 negativ (Abgabe) — als App-Rolle.
        IDS.put("Q01", als(KB, () -> bindung(app, KB, "MS-01", "Wirkleistung", "Bezug", "K-3", WIRKLEISTUNG,
                "gauge", "momentanwert", "fuehrend", null, "positiv")));
        IDS.put("Q02", als(KB, () -> bindung(app, KB, "MS-02", "Wirkleistung", "Abgabe", "K-3", WIRKLEISTUNG,
                "gauge", "momentanwert", "fuehrend", null, "negativ")));
        // Eine Energie aus dem positiven Anteil als VERGLEICH (Herleitung integration): sie darf die
        // Viertelstunde des GANZEN Werts nicht zur Energie machen.
        IDS.put("Q05", bindung(root, KB, "MS-05", "Wirkenergie", "Bezug", "K-3", WIRKLEISTUNG, "gauge",
                "integration", "vergleich", "Plausibilität", "positiv"));
        IDS.put("QF", bindung(root, FREMD, "MS-F1", "Wirkleistung", "Bezug", "K-F", WIRKLEISTUNG, "gauge",
                "momentanwert", "fuehrend", null, "positiv"));

        // ---- 2. Der Leseweg je Anteil.
        ms01 = als(KB, () -> leseweg.periode(IDS.get("Q01"), VON, BIS).orElseThrow());
        ms02 = als(KB, () -> leseweg.periode(IDS.get("Q02"), VON, BIS).orElseThrow());

        // ---- 3. Die Viertelstunde der REIHE (der ganze Vorzeichen-Wert) über den Lauf.
        ViertelstundeVerdichter verdichter = new ViertelstundeVerdichter(admin, katalog, new SpaetankunftMelder(),
                500, 40, 200_000);
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s
                 WHERE s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'
                ON CONFLICT DO NOTHING
                """);
        while (verdichter.verdichteEinenStapel(JETZT)[0] > 0) {
            // bis die Liste leer ist
        }
        viertelstundeDesGanzenWerts = root.queryForMap("SELECT * FROM messreihe_viertelstunde "
                + "WHERE entity_id = ? AND messkanal = ? AND intervall_beginn = ?", IDS.get("K-3"), WIRKLEISTUNG,
                Timestamp.from(VON));

        // ---- 4. Eine Einstellungs-Fassung „Vorzeichen umgekehrt“: die Box hat sie beim Erfassen schon
        //         angewendet — der Leseweg liest sie nie.
        root.update("INSERT INTO quelle_einstellung (tenant_id, geraet_id, entity_id, kanal, art, wert, anwendung, "
                + "herkunft, gueltig_ab, rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, "
                + "'vorzeichen_umgekehrt', '{\"umgekehrt\": true}', 'angewendet', 'eintrag', '2024-03-12T00:00:00Z', "
                + "false, 'sub', 'Probe', 'kunde')", KB, geraet("K-3"), IDS.get("K-3"), WIRKLEISTUNG);
        ms01NachVorzeichenFassung = als(KB, () -> leseweg.periode(IDS.get("Q01"), VON, BIS).orElseThrow());
        ms02NachVorzeichenFassung = als(KB, () -> leseweg.periode(IDS.get("Q02"), VON, BIS).orElseThrow());

        fingerNachAllem = fingerabdruck();
        bestandsbindungenNachAllem = bestandsbindungen();
        rohNachAllem = tabellenFinger("device_measurement_sample");
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================= F19: die vier Zahlen

    /** F19 über die Datenbank: MS-01 positiver Anteil — Mittel 12,8 kW, integriert 3,2 kWh. */
    @Test
    void f19Ms01BezugIstDerPositiveAnteilJeRohwert() {
        JsonNode soll = erwartung("positiv");
        pruefe(ms01.ergebnis(), soll);
        assertThat(ms01.ergebnis().mittel()).isEqualByComparingTo("12.8");
        assertThat(ms01.ergebnis().energieKwh()).isEqualByComparingTo("3.2");
        assertThat(ms01.ergebnis().min()).as("die Nullen der Abgabe-Minuten zählen mit").isEqualByComparingTo("0");
        assertThat(ms01.ergebnis().max()).isEqualByComparingTo("38.4");
        assertThat(ms01.ergebnis().kennzeichen()).containsExactly("positiver Anteil von K-3 · Wirkleistung",
                VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT);
        assertThat(ms01.quelle()).isEqualTo(soll.path("quelle").asText());
        assertThat(ms01.kadenzS()).isEqualTo(60);
    }

    /** F19 über die Datenbank: MS-02 negativer Anteil — Mittel 22,8 kW, integriert 5,7 kWh. */
    @Test
    void f19Ms02AbgabeIstDerNegativeAnteilJeRohwert() {
        JsonNode soll = erwartung("negativ");
        pruefe(ms02.ergebnis(), soll);
        assertThat(ms02.ergebnis().mittel()).isEqualByComparingTo("22.8");
        assertThat(ms02.ergebnis().energieKwh()).isEqualByComparingTo("5.7");
        assertThat(ms02.ergebnis().min()).isEqualByComparingTo("0");
        assertThat(ms02.ergebnis().max()).as("der Betrag, nie −34,2").isEqualByComparingTo("34.2");
        assertThat(ms02.ergebnis().kennzeichen()).containsExactly("negativer Anteil von K-3 · Wirkleistung",
                VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT);
    }

    /** Kein stiller Saldo (E12): zwei Mengen, vereinbar mit den Zählerständen von F19 (3,2 und 5,7 kWh). */
    @Test
    void bezugUndAbgabeBleibenZweiMengenVereinbarMitDenZaehlerstaenden() {
        List<BigDecimal> zaehler = new ArrayList<>();
        for (JsonNode e : f19.path("expected")) {
            if (!e.has("anteil")) {
                zaehler.add(e.path("menge").decimalValue());
            }
        }
        assertThat(zaehler).hasSize(2);
        assertThat(ms01.ergebnis().energieKwh()).isEqualByComparingTo(zaehler.get(0));
        assertThat(ms02.ergebnis().energieKwh()).isEqualByComparingTo(zaehler.get(1));
        assertThat(ms01.ergebnis().energieKwh()).isPositive();
        assertThat(ms02.ergebnis().energieKwh()).as("nie „−2,5“").isPositive();
    }

    // ==================================================== Die Gegenprobe: erst mitteln ist falsch

    /**
     * E15 Option C (verworfen): ERST MITTELN, DANN NACH VORZEICHEN ZUORDNEN IST FALSCH. Das Mittel des
     * ganzen Werts dieser Viertelstunde — hier aus dem Lauf über die Datenbank — ist −10,0 kW; nach seinem
     * Vorzeichen zugeordnet zeigte es „Bezug 0,0 · Abgabe 10,0“: beide Anteile teilweise verschwunden.
     */
    @Test
    void erstMittelnDannZuordnenIstFalsch() {
        BigDecimal mittelKw = ((BigDecimal) viertelstundeDesGanzenWerts.get("mittel"))
                .divide(BigDecimal.valueOf(1000));
        JsonNode g = f19.path("gegenprobe");
        assertThat(mittelKw).isEqualByComparingTo(g.path("mittel_vorzeichen").decimalValue());
        BigDecimal falschBezug = VerbrauchRegeln.anteilDesWerts(mittelKw, "positiv");
        BigDecimal falschAbgabe = VerbrauchRegeln.anteilDesWerts(mittelKw, "negativ");
        assertThat(falschBezug).isEqualByComparingTo(g.path("falsch_bezug").decimalValue())
                .isNotEqualByComparingTo(ms01.ergebnis().mittel());
        assertThat(falschAbgabe).isEqualByComparingTo(g.path("falsch_abgabe").decimalValue())
                .isNotEqualByComparingTo(ms02.ergebnis().mittel());
        // Je Rohwert: die Anteile ergeben zusammen wieder den ganzen Wert (12,8 − 22,8 = −10,0) — die
        // Aufteilung verliert nichts, das Zuordnen des Mittels verliert beide Hälften.
        assertThat(ms01.ergebnis().mittel().subtract(ms02.ergebnis().mittel())).isEqualByComparingTo(mittelKw);
    }

    /**
     * Die Viertelstunde der REIHE ist der ganze Vorzeichen-Wert: Mittel −10 000 W, aber KEINE Energie —
     * obwohl eine Bindung {@code integration} (mit Anteil) die Reihe liest. Die Energie je Anteil entsteht
     * nur je Rohwert; eine Energie des ganzen Werts wäre der stille Saldo −2,5 kWh (E12).
     */
    @Test
    void dieViertelstundeDesGanzenWertsWirdNieZumSaldo() {
        assertThat((BigDecimal) viertelstundeDesGanzenWerts.get("mittel")).isEqualByComparingTo("-10000");
        assertThat(viertelstundeDesGanzenWerts.get("energie")).isNull();
        assertThat(String.valueOf(viertelstundeDesGanzenWerts.get("kennzeichen")))
                .doesNotContain(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT_WORT);
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_quelle WHERE entity_id = ? AND kanal = ? "
                + "AND herleitung = 'integration' AND anteil IS NOT NULL", Integer.class, IDS.get("K-3"), WIRKLEISTUNG))
                .as("die Probe hat eine Bindung integration mit Anteil").isOne();
    }

    // ===================================================== Das Box-Vorzeichen wirkt einmal

    /**
     * AP-04 E5: die Box hat „Vorzeichen umgekehrt“ beim Erfassen angewendet, der Rohwert ist
     * vorzeichenrichtig. Eine Fassung ändert am Leseweg darum NICHTS — kein zweites Drehen, kein Tausch
     * von Bezug und Abgabe.
     */
    @Test
    void dasBoxVorzeichenWirktGenauEinmal() {
        assertThat(root.queryForObject("SELECT count(*) FROM quelle_einstellung WHERE art = 'vorzeichen_umgekehrt' "
                + "AND entity_id = ?", Integer.class, IDS.get("K-3"))).isOne();
        assertThat(ms01NachVorzeichenFassung).isEqualTo(ms01);
        assertThat(ms02NachVorzeichenFassung).isEqualTo(ms02);
        assertThat(rohNachAllem).as("kein Rohwert wird gedreht oder umgeschrieben").isEqualTo(rohVorher);
        // Rein: der Anteil eines schon vorzeichenrichtigen Werts, genau einmal.
        Rohwert minusZehn = new Rohwert(Instant.parse("2026-10-20T10:07:00Z"), new BigDecimal("-10.0"));
        assertThat(VerbrauchRegeln.anteilJeRohwert(List.of(minusZehn), "positiv").get(0).wert()).isEqualByComparingTo("0");
        assertThat(VerbrauchRegeln.anteilJeRohwert(List.of(minusZehn), "negativ").get(0).wert())
                .isEqualByComparingTo("10.0");
    }

    /** Der letzte Wert im Register liest denselben Anteil je Rohwert: −10 000 W an K-3 → MS-01 0 · MS-02 10 000. */
    @Test
    void derLetzteWertDesRegistersIstDerAnteilDesRohwerts() {
        Werte werte = new Werte(60, Instant.parse("2026-10-20T10:07:00Z"), -10_000.0, null, true);
        assertThat(MessstelleBeobachtung.ableiten(zeile("positiv"), werte, 60, "W",
                Instant.parse("2026-10-20T10:08:00Z"), ZoneId.of("Europe/Berlin")).letzterWert().wert())
                .isEqualTo(0.0);
        assertThat(MessstelleBeobachtung.ableiten(zeile("negativ"), werte, 60, "W",
                Instant.parse("2026-10-20T10:08:00Z"), ZoneId.of("Europe/Berlin")).letzterWert().wert())
                .isEqualTo(10_000.0);
        assertThat(MessstelleBeobachtung.ableiten(zeile(null), werte, 60, "W",
                Instant.parse("2026-10-20T10:08:00Z"), ZoneId.of("Europe/Berlin")).letzterWert().wert())
                .as("ohne Anteil der ganze Wert").isEqualTo(-10_000.0);
    }

    // ======================================================= Die Datenbank hält den Anteil

    @Test
    void denselbenAnteilFuehrtNurEineMessstelleUndDerGanzeWertSchliesstJedenAus() {
        abgelehnt("23P01", "messstelle_quelle_kanal_fuehrt_eine_messstelle", () -> bindung(root, KB, "MS-06",
                "Wirkleistung", "Bezug", "K-3", WIRKLEISTUNG, "gauge", "momentanwert", "fuehrend", null, "positiv"));
        abgelehnt("23P01", "messstelle_quelle_kanal_fuehrt_eine_messstelle", () -> bindung(root, KB, "MS-06",
                "Wirkleistung", "Bezug", "K-3", WIRKLEISTUNG, "gauge", "momentanwert", "fuehrend", null, null));
        abgelehnt("23514", "messstelle_quelle_anteil_chk", () -> bindung(root, KB, "MS-06", "Wirkleistung",
                "Bezug", "K-3", WIRKLEISTUNG, "gauge", "momentanwert", "fuehrend", null, "gesamt"));
        abgelehnt("23514", "messstelle_quelle_nie_ueberschrieben", () -> root.update(
                "UPDATE messstelle_quelle SET anteil = 'negativ', gueltig_bis = '2026-11-01T00:00:00Z' WHERE id = ?",
                IDS.get("Q01")));
        assertThat(root.queryForObject("SELECT anteil FROM messstelle_quelle WHERE id = ?", String.class,
                IDS.get("Q01"))).isEqualTo("positiv");
    }

    @Test
    void dieAnschlussleistungIstOptionalUndGroesserNull() {
        abgelehnt("23514", "messstelle_anschlussleistung_chk", () -> root.update(
                "UPDATE messstelle SET anschlussleistung_kw = 0 WHERE id = ?", IDS.get("MS-01")));
        assertThat(als(KB, () -> app.update("UPDATE messstelle SET anschlussleistung_kw = 100 WHERE id = ?",
                IDS.get("MS-06")))).isOne();
        assertThat(MessstelleRegeln.hoechstzuwachsJeKadenz(root.queryForObject(
                "SELECT anschlussleistung_kw FROM messstelle WHERE id = ?", BigDecimal.class, IDS.get("MS-06")),
                "kWh", 60)).isEqualByComparingTo("1.667");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle WHERE anschlussleistung_kw IS NOT NULL "
                + "AND id <> ?", Integer.class, IDS.get("MS-06"))).as("der Bestand bleibt nicht deklariert").isZero();
        root.update("UPDATE messstelle SET anschlussleistung_kw = NULL WHERE id = ?", IDS.get("MS-06"));
    }

    // ============================================================ Zaun und Bestand

    @Test
    void derMandantenzaunHaeltDenLesewegUndDieBindung() {
        assertThat(als(FREMD, () -> leseweg.periode(IDS.get("Q01"), VON, BIS))).isEmpty();
        assertThat(als(KB, () -> leseweg.periode(IDS.get("QF"), VON, BIS))).isEmpty();
        TenantContext.clear();
        assertThat(leseweg.periode(IDS.get("Q01"), VON, BIS)).isEmpty();
        QuelleAnteilWerte.Periode fremd = als(FREMD, () -> leseweg.periode(IDS.get("QF"), VON, BIS).orElseThrow());
        assertThat(fremd.ergebnis().mittel()).as("der eigene Kundenbereich liest seine eigenen Werte")
                .isEqualByComparingTo("5.0");
        assertThat(als(FREMD, () -> app.queryForObject("SELECT count(*) FROM messstelle_quelle WHERE anteil IS NOT NULL",
                Integer.class))).isOne();
        // Ohne Anteil gibt es diesen Leseweg nicht — der ganze Wert hat seine Wege.
        assertThat(als(KB, () -> leseweg.periode(IDS.get("QB"), VON, BIS))).isEmpty();
    }

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).as("nach der Migration").isEmpty();
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachAllem)).as("nach allem").isEmpty();
        assertThat(bestandsbindungenNachAllem).as("die Bindungen von vorher: kein Anteil, nichts geändert")
                .isEqualTo(bestandsbindungenVorher);
        assertThat(fingerVorher).hasSizeGreaterThan(100).containsKeys("messstelle", "measurement_point",
                "device_measurement_sample");
        assertThat(root.queryForList("SELECT privilege_type FROM information_schema.table_privileges "
                + "WHERE grantee = ? AND table_name = 'messstelle_quelle' ORDER BY privilege_type", String.class,
                APP_USER)).contains("INSERT", "SELECT").doesNotContain("DELETE");
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, AUSNAHMEN, "measurement_point",
                "UPDATE measurement_point SET label = label || ' (Probe)'");
        Bestandsschutz.inhaltsprobe(root, () -> tabellenFinger("device_measurement_sample"), "device_measurement_sample",
                "UPDATE device_measurement_sample SET catalog_version = catalog_version || '.probe'");
    }

    // ============================================================ Aufbau der Beispielwelt

    private static void stammdaten() {
        for (UUID t : new UUID[] {KB, FREMD}) {
            root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", t,
                    t.equals(KB) ? "Kunststoffwerk Ahrenberg GmbH" : "Kundenbereich B");
            IDS.put("U:" + t, uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                    + "VALUES (?, ?, 'Europe/Berlin') RETURNING id", t, "U " + t));
            UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, ?, 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", t, IDS.get("U:" + t),
                    "Werk " + t);
            UUID an = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1') RETURNING id", t);
            root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, DATE '2024-01-01')", t, an, st);
            IDS.put("AN:" + t, an);
            IDS.put("BOX:" + t, uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                    + "VALUES (?, ?, ?, 'claimed') RETURNING id", t, an, "VP-BOX-ANTEIL-" + t));
        }
        komponente(KB, "K-3", WIRKLEISTUNG, BEZUG_ZAEHLER);
        komponente(FREMD, "K-F", WIRKLEISTUNG);

        messstelle(KB, "MS-01", "Netzbezug Halle 1", "Bezug", "Wirkleistung", "Bezug");
        messstelle(KB, "MS-02", "Netzeinspeisung Halle 1", "Abgabe", "Wirkleistung", "Abgabe");
        messstelle(KB, "MS-05", "Energie aus Leistung · Bezug", "Bezug", null, null);
        messstelle(KB, "MS-06", "Unterverteilung", "Bezug", "Wirkleistung", "Bezug");
        messstelle(FREMD, "MS-F1", "Fremd", "Bezug", "Wirkleistung", "Bezug");
        // Der Bestand: MS-01 liest seinen Zählerstand aus K-3, als ganzen Wert (vor IP-7 die einzige Form).
        IDS.put("QB", bindung(root, KB, "MS-01", "Wirkenergie", "Bezug", "K-3", BEZUG_ZAEHLER, "counter",
                "zaehlerstand", "fuehrend", null, null));
    }

    private static void komponente(UUID tenant, String name, String... kanaele) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.7\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, IDS.get("AN:" + tenant), name, IDS.get("BOX:" + tenant));
        for (String kanal : kanaele) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                    + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                    tenant, IDS.get("AN:" + tenant), IDS.get("BOX:" + tenant), entity, kanal);
        }
        IDS.put(name, entity);
    }

    /** Eine Messstelle Wirkenergie (Zählerstand) mit — wenn genannt — der Nebengröße Wirkleistung (Momentanwert). */
    private static void messstelle(UUID tenant, String kennzeichen, String name, String richtung,
            String nebenGroesse, String nebenRichtung) {
        UUID id = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', 'Zählerstand') RETURNING id",
                tenant, kennzeichen, name, richtung);
        if (nebenGroesse != null) {
            root.update("INSERT INTO messstelle_groesse (tenant_id, messstelle_id, medium, groesse, richtung, einheit, "
                    + "wertart) VALUES (?, ?, 'Strom', ?, ?, 'kW', 'Momentanwert')", tenant, id, nebenGroesse,
                    nebenRichtung);
        }
        IDS.put(kennzeichen, id);
    }

    private static UUID bindung(JdbcTemplate db, UUID tenant, String messstelle, String groesse, String richtung,
            String komponente, String kanal, String wertart, String herleitung, String rolle, String zweck,
            String anteil) {
        return db.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, zweck, gueltig_ab, rueckwirkend, "
                + "eingetragen_am, actor_sub, actor_name, actor_art" + (anteil == null ? "" : ", anteil")
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', "
                + "'kunde'" + (anteil == null ? "" : ", ?") + ") RETURNING id", UUID.class,
                anteil == null
                        ? new Object[] {tenant, IDS.get(messstelle), groesse, richtung, IDS.get(komponente),
                            geraet(komponente), kanal, wertart, herleitung, rolle, zweck}
                        : new Object[] {tenant, IDS.get(messstelle), groesse, richtung, IDS.get(komponente),
                            geraet(komponente), kanal, wertart, herleitung, rolle, zweck, anteil});
    }

    private static UUID geraet(String komponente) {
        return root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? AND gueltig_bis IS NULL",
                UUID.class, IDS.get(komponente));
    }

    /** F19 · Reihe `wirkleistung` in W (der Katalog-Einheit); die fremde Reihe gleichbleibend 5 kW. */
    private static void rohwerte() {
        List<Rohwert> f19Werte = VerbrauchVectorsTest.rohwerte(f19.path("input").path("reihen").path("wirkleistung"));
        assertThat(f19Werte).hasSize(16);
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : f19Werte) {
            stapel.add(roh(KB, "K-3", r.zeit(), r.wert().multiply(BigDecimal.valueOf(1000))));
        }
        for (Rohwert r : f19Werte) {
            stapel.add(roh(FREMD, "K-F", r.zeit(), new BigDecimal("5000")));
        }
        root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                + "'2026.09.11.1', ?, 'gauge', ?, 3, 'gauge', 'fuehrend', 'direkt', 2)", stapel);
    }

    private static Object[] roh(UUID tenant, String komponente, Instant t, BigDecimal wert) {
        return new Object[] {Timestamp.from(t), Timestamp.from(t.plusSeconds(2)), tenant, IDS.get("AN:" + tenant),
                IDS.get("BOX:" + tenant), WIRKLEISTUNG, wert, t.getEpochSecond() * 10 + (tenant.equals(KB) ? 1 : 2),
                IDS.get(komponente)};
    }

    // ------------------------------------------------------------------------ Helfer

    private static JsonNode erwartung(String anteil) {
        for (JsonNode e : f19.path("expected")) {
            if (anteil.equals(e.path("anteil").asText())) {
                return e;
            }
        }
        throw new AssertionError("F19 hat keine Erwartung mit anteil " + anteil);
    }

    /** Die Erwartung der Vektor-Datei, Feld für Feld — dieselbe Datei wie VerbrauchVectorsTest. */
    private static void pruefe(Ergebnis ist, JsonNode soll) {
        assertThat(ist.mittel()).isEqualByComparingTo(soll.path("mittel").decimalValue());
        assertThat(ist.min()).isEqualByComparingTo(soll.path("min").decimalValue());
        assertThat(ist.max()).isEqualByComparingTo(soll.path("max").decimalValue());
        assertThat(ist.energieKwh()).isEqualByComparingTo(soll.path("energie_kwh").decimalValue());
        assertThat(ist.zustand()).isEqualTo(soll.path("zustand").asText());
        assertThat(ist.erhalten()).isEqualTo(soll.path("erhalten").asInt());
        assertThat(ist.erwartet()).isEqualTo(soll.path("erwartet").asInt());
        assertThat(ist.abdeckungProzent()).isEqualTo(soll.path("abdeckung_prozent").asInt());
        List<String> kennzeichen = new ArrayList<>();
        soll.path("kennzeichen").forEach(k -> kennzeichen.add(k.asText()));
        assertThat(ist.kennzeichen()).isEqualTo(kennzeichen);
    }

    private static QuelleZeile zeile(String anteil) {
        Quelle q = new Quelle(UUID.randomUUID(), UUID.randomUUID(), "MS-01", "Wirkleistung", "Bezug", IDS.get("K-3"),
                null, "K-3", null, "GR-2", "GR-2", "Janitza", WIRKLEISTUNG, "gauge", "momentanwert", "fuehrend", null,
                Instant.parse("2024-03-12T00:00:00Z"), null, null, null, true, null, Instant.parse("2026-10-01T07:14:00Z"),
                "Probe", anteil);
        return new QuelleZeile(q, "Netzzähler", null);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static PSQLException ablehnung(Runnable arbeit) {
        try {
            arbeit.run();
            return null;
        } catch (RuntimeException e) {
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof PSQLException p) {
                    return p;
                }
            }
            throw e;
        }
    }

    private static void abgelehnt(String sqlState, String constraint, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    /**
     * Die Bindung von VOR der Migration als Objekt ohne ihre SQL-NULL-Spalten (wie {@link Bestandsschutz}):
     * die neue Spalte `anteil` bleibt an ihr leer — sie ist der ganze Wert, wie vorher.
     */
    private static String bestandsbindungen() {
        return root.queryForObject("SELECT md5(jsonb_strip_nulls(to_jsonb(t))::text) FROM messstelle_quelle t "
                + "WHERE t.id = ?", String.class, IDS.get("QB"));
    }

    private static String tabellenFinger(String tabelle) {
        return Bestandsschutz.inhalt(root, tabelle, null);
    }

    private static Map<String, String> fingerabdruck() {
        return Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
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
