package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der RECHENLAUF der Kennzahlen an der Datenbank (UEMS AP-11 IP-6): die Plan-Abnahme K1–K3 und K14 als gespeicherte
 * Periodenwerte, byte-gleich zu {@code kennzahl-vectors.json} (Zahlen auf die Vergleichsstellen des Vertrags), die
 * Q-Regeln je Fall mit Grund, die Reihenfolge gemessen → berechnet → Kennzahl in EINEM Takt, ein benannter Kreis — und
 * dass 0,32 und 0,2346 nirgends entstehen.
 *
 * <p>Die Welt ist das Referenzunternehmen Ahrenberg 1.3 (Oktober 2026). November und Dezember sind nur als SUMMEN
 * Vertrag (K14: 14 200 / 57 500 und 13 900 / 54 400); ihre Aufteilung auf die Gebäude ist eine Annahme dieses Tests
 * (November MS-12 6 300 und BZ-6 42 500 aus K8).
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsKennzahlRechenlaufTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "kennzahl-vectors.json");
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final String VOLL = "vollständig";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    KennzahlLauf lauf;

    @Autowired
    BerechnetePeriodenLauf berechnete;

    @Autowired
    EndgueltigkeitLauf endgueltigkeit;

    @Autowired
    TagVerdichter tage;

    @Autowired
    PeriodeVerdichter perioden;

    @Autowired
    KorrekturVorschlagLauf vorschlaege;

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ K1–K3: Grundperiode, Paare, Ordnung

    /**
     * K1, K2, K3 in EINEM Lauf: die Gebäude-Kennzahlen aus MS-12/BZ-6 und MS-18/BZ-7, die Unternehmens-Kennzahl Summe
     * durch Summe über ihre Paare. KZ-0000 liest dieselben Paare, steht nach Kennzeichen aber VOR ihnen — sie trägt
     * trotzdem 0,20: die Ordnung kommt aus den Eingängen, nicht aus der Liste. Ein zweiter Lauf schreibt nichts (V3).
     */
    @Test
    void k1K2K3RechnenInEinemLaufInDerOrdnungIhrerEingaenge() throws Exception {
        Welt w = welt();
        oktober(w);
        quotient(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6");
        quotient(w, "KZ-0002", "gebaeude", w.g5(), "MS-18", "BZ-7");
        zusammenfassung(w, "KZ-0000", "KZ-0001", "KZ-0002");
        zusammenfassung(w, "KZ-0003", "KZ-0001", "KZ-0002");

        lauf.lauf(Instant.parse("2026-11-20T07:00:00Z"));

        gleichDemVektor(zeile(w, "KZ-0001", "monat", "2026-10-01"), ergebnis("K1", "wert", 0), "K1");
        gleichDemVektor(zeile(w, "KZ-0002", "monat", "2026-10-01"), ergebnis("K2", "wert", 0), "K2");
        gleichDemVektor(zeile(w, "KZ-0003", "monat", "2026-10-01"), ergebnis("K3", "wert", 0), "K3");
        gleichDemVektor(zeile(w, "KZ-0000", "monat", "2026-10-01"), ergebnis("K3", "wert", 0), "KZ-0000 vor ihren Paaren");
        herkunftGleich(zeile(w, "KZ-0001", "monat", "2026-10-01"), herkunft("K1"), "K1");
        herkunftGleich(zeile(w, "KZ-0003", "monat", "2026-10-01"), herkunft("K3"), "K3");
        assertThat(zeile(w, "KZ-0001", "monat", "2026-10-01").get("definition_fassung")).isEqualTo(1);

        String vorher = kennzahlTabellen(w);
        lauf.lauf(Instant.parse("2026-11-20T08:00:00Z"));
        assertThat(kennzahlTabellen(w)).as("ein zweiter Lauf ohne neuen Eingang schreibt nichts").isEqualTo(vorher);
    }

    // ================================================================ K21, K8, K14 und die Zahlen, die nie entstehen

    /**
     * Drei Läufe über den Jahreswechsel: K21 (November läuft — „keine Werte“, Periode nicht zu Ende), K8 (November zu
     * Ende, BZ-6 fehlt — „keine Werte“, Nenner fehlt), dann K14 (Jahr 2026 = Summe durch Summe über die Monate = 0,2361).
     * Der November der Unternehmens-Kennzahl war vorläufig und zieht als Version 1 nach; ein endgültiger Wert bleibt
     * stehen, auch wenn sich ein Eingang ändert (Version n + 1 bildet erst die Kaskade). Und: an KEINER Stelle — Wert,
     * Zähler, Nenner, Herkunft — steht das ungewichtete Mittel 0,32 der Gebäude oder 0,2346 der Monate.
     */
    @Test
    void k21K8K14DasJahrIstSummeDurchSummeUnd032Und02346EntstehenNirgends() throws Exception {
        Welt w = welt();
        oktober(w);
        monat(w, "MS-12", "2026-11-01", "4100", List.of(), false);
        quotient(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6");
        quotient(w, "KZ-0002", "gebaeude", w.g5(), "MS-18", "BZ-7");
        zusammenfassung(w, "KZ-0003", "KZ-0001", "KZ-0002");

        // K21 — am 20.11.2026: kein Live-Wert, keine Hochrechnung aus 19 Tagen.
        lauf.lauf(Instant.parse("2026-11-20T07:00:00Z"));
        JsonNode k21 = ergebnis("K21", "laufend", 0);
        Map<String, Object> laufend = zeile(w, "KZ-0001", "monat", "2026-11-01");
        assertThat(laufend.get("grund")).isEqualTo(k21.get("grund").asText());
        assertThat(laufend.get("wert")).isNull();
        assertThat(laufend.get("menge_zustand")).isEqualTo(ErgebnisZustand.KEINE_WERTE);
        assertThat(laufend.get("version")).isNull();
        assertThat(zeile(w, "KZ-0003", "monat", "2026-11-01").get("grund")).isEqualTo(KennzahlRegeln.PERIODE_NICHT_ZU_ENDE);

        // K8 — am 10.12.2026: November zu Ende, MS-12 hat 6 300 kWh, BZ-6 ist noch nicht eingegeben.
        root.update("UPDATE messreihe_periode SET menge = 6300, zustand = 'endgueltig', teile_endgueltig = teile_vorhanden "
                + "WHERE tenant_id = ? AND art = 'monat' AND tag = '2026-11-01' AND entity_id = ?", w.mandant(),
                w.komponenten().get("MS-12"));
        monat(w, "MS-18", "2026-11-01", "7900", List.of(), true);
        bezugswert(w, "BZ-7", "2026-11-01", "15000");
        lauf.lauf(Instant.parse("2026-12-10T07:00:00Z"));
        gleichDemVektor(zeile(w, "KZ-0001", "monat", "2026-11-01"), ergebnis("K8", "wert", 0), "K8");

        // Dezember, und BZ-6 November wird nachgetragen.
        monat(w, "MS-12", "2026-12-01", "6200", List.of(), true);
        monat(w, "MS-18", "2026-12-01", "7700", List.of(), true);
        bezugswert(w, "BZ-6", "2026-12-01", "40400");
        bezugswert(w, "BZ-7", "2026-12-01", "14000");
        bezugswert(w, "BZ-6", "2026-11-01", "42500");
        lauf.lauf(Instant.parse("2027-01-20T07:00:00Z"));

        gleichDemVektor(zeile(w, "KZ-0003", "jahr", "2026-01-01"), ergebnis("K14", "wert", 0), "K14");
        // IP-11: das Jahr nennt als Herkunft seine Paare im Jahr (Report K14) — je Gebäude die gespeicherte Jahreszeile mit
        // Zähler und Nenner; ihre Summen sind Zähler und Nenner des Jahres. Die Route baut daraus den Satz.
        Map<String, Object> jahr = zeile(w, "KZ-0003", "jahr", "2026-01-01");
        List<Map<String, Object>> paare = eingaenge(jahr);
        assertThat(paare).extracting(e -> e.get("rolle") + " " + e.get("art") + " " + e.get("objekt"))
                .containsExactly("paar kennzahl KZ-0001", "paar kennzahl KZ-0002");
        for (Map<String, Object> e : paare) {
            Map<String, Object> paarJahr = zeile(w, (String) e.get("objekt"), "jahr", "2026-01-01");
            assertThat(zahl(e.get("zaehler"))).as(e.get("objekt") + " Zähler").isEqualByComparingTo(zahl(paarJahr.get("zaehler")));
            assertThat(zahl(e.get("nenner"))).as(e.get("objekt") + " Nenner").isEqualByComparingTo(zahl(paarJahr.get("nenner")));
            assertThat(e.get("version")).as(e.get("objekt") + " Version").isEqualTo(paarJahr.get("version"));
        }
        assertThat(zahl(paare.get(0).get("zaehler")).add(zahl(paare.get(1).get("zaehler"))))
                .isEqualByComparingTo(zahl(jahr.get("zaehler")));
        assertThat(zahl(paare.get(0).get("nenner")).add(zahl(paare.get(1).get("nenner"))))
                .isEqualByComparingTo(zahl(jahr.get("nenner")));
        UUID kz3 = root.queryForObject("SELECT id FROM kennzahl WHERE tenant_id = ? AND kennzeichen = 'KZ-0003'", UUID.class,
                w.mandant());
        JsonNode schritt = lesen(w, PFAD + "/" + kz3 + "/werte?periode=jahr&von=2026-01-01&bis=2026-12-31").get("werte")
                .get(0);
        assertThat(schritt.get("herkunft").get("fehlt")).as(schritt.toString()).isEmpty();
        assertThat(schritt.get("herkunft").get("satz").get("rechenform").asText()).isEqualTo("zusammenfassung");
        assertThat(schritt.get("herkunft").get("satz").get("eingaenge").findValuesAsText("objekt"))
                .containsExactly("KZ-0001", "KZ-0002");
        assertThat(vier(zeile(w, "KZ-0003", "monat", "2026-11-01").get("wert"))).isEqualByComparingTo("0.2470");
        assertThat(vier(zeile(w, "KZ-0003", "monat", "2026-12-01").get("wert"))).isEqualByComparingTo("0.2555");
        assertThat(root.queryForList("SELECT coalesce(w.version::text, '-') || ':' || coalesce(w.zustand, '-') || ':' "
                + "|| coalesce(w.grund, '-') FROM kennzahl_wert w JOIN kennzahl k ON k.id = w.kennzahl_id "
                + "WHERE w.tenant_id = ? AND k.kennzeichen = 'KZ-0003' AND w.periode_art = 'monat' "
                + "AND w.periode_von = '2026-11-01' ORDER BY w.berechnet_am", String.class, w.mandant()))
                .as("K21 ohne Version, dann V3: der vorläufige November zieht nach — Version 1 bleibt Version 1")
                .containsExactly("-:-:periode_nicht_zu_ende", "1:vorlaeufig:-", "1:endgueltig:-");

        // Die Zahlen, die nie entstehen dürfen — gerechnet aus denselben Eingängen, gesucht in jeder Zahl des Kundenbereichs.
        BigDecimal mittelGebaeude = quotient("6100", "41000").add(quotient("3600", "7200"))
                .divide(new BigDecimal("2"), 10, RoundingMode.HALF_UP);
        BigDecimal mittelMonate = quotient("9700", "48200").add(quotient("14200", "57500")).add(quotient("13900", "54400"))
                .divide(new BigDecimal("3"), 10, RoundingMode.HALF_UP);
        assertThat(mittelGebaeude.setScale(4, RoundingMode.HALF_UP).toPlainString())
                .isEqualTo(pruefung("K3", "wert", 0).get("ergebnis").get("nie").asText());
        assertThat(mittelMonate.setScale(4, RoundingMode.HALF_UP).toPlainString())
                .isEqualTo(pruefung("K14", "wert", 0).get("ergebnis").get("nie").asText());
        List<BigDecimal> alle = alleZahlen(w);
        assertThat(alle).as("die Unternehmens-Kennzahl steht da").anyMatch(x -> naehe(x, new BigDecimal("0.2012")));
        assertThat(alle).as("0,32 — das Mittel der Gebäude-Quotienten").noneMatch(x -> naehe(x, mittelGebaeude));
        assertThat(alle).as("0,2346 — das Mittel der Monats-Quotienten").noneMatch(x -> naehe(x, mittelMonate));

        // Ein endgültiger Wert bleibt stehen: der Regellauf bildet keine Version n + 1 (das tut die Kaskade, K7).
        root.update("UPDATE messreihe_periode SET menge = 6040 WHERE tenant_id = ? AND art = 'monat' "
                + "AND tag = '2026-10-01' AND entity_id = ?", w.mandant(), w.komponenten().get("MS-12"));
        lauf.lauf(Instant.parse("2027-01-20T09:00:00Z"));
        assertThat(anzahl(w, "KZ-0001", "monat", "2026-10-01")).isEqualTo(1);
        assertThat(vier(zeile(w, "KZ-0001", "monat", "2026-10-01").get("wert"))).isEqualByComparingTo("0.1488");
    }

    // ================================================================ Q2: Nenner 0, Zähler fehlt, vor dem Bestehen

    /**
     * K9 (Betriebsferien Lindach: 410 kWh ÷ 0 Stück) ist „keine Werte“ mit Grund {@code nenner_null} und dem
     * Kennzeichen „Nenner 0 (…)“ — nie 0, nie ∞. Ein Monat mit Stückzahl, aber ohne Menge ist {@code zaehler_fehlt}.
     * Und die Monate davor, in denen es weder Menge noch Stückzahl gibt, haben KEINE Zeile (P4).
     */
    @Test
    void k9NennerNullUndZaehlerFehltTragenIhrenGrundUndVorDemBestehenGibtEsKeineZeile() throws Exception {
        Welt w = welt();
        quotient(w, "KZ-0002", "gebaeude", w.g5(), "MS-18", "BZ-7");
        monat(w, "MS-18", "2027-08-01", "410", List.of(), true);
        bezugswert(w, "BZ-7", "2027-08-01", "0");
        bezugswert(w, "BZ-7", "2027-02-01", "5000");

        lauf.lauf(Instant.parse("2027-09-20T06:00:00Z"));

        gleichDemVektor(zeile(w, "KZ-0002", "monat", "2027-08-01"), ergebnis("K9", "wert", 0), "K9");
        Map<String, Object> februar = zeile(w, "KZ-0002", "monat", "2027-02-01");
        assertThat(februar.get("grund")).isEqualTo(KennzahlRegeln.ZAEHLER_FEHLT);
        assertThat(februar.get("menge_zustand")).isEqualTo(ErgebnisZustand.KEINE_WERTE);
        assertThat(februar.get("wert")).isNull();
        assertThat(februar.get("zaehler")).isNull();
        assertThat(zahl(februar.get("nenner"))).isEqualByComparingTo("5000");
        assertThat(februar.get("version")).isNull();
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE tenant_id = ? AND periode_art = 'monat'",
                Long.class, w.mandant())).as("nur Februar und August tragen einen Periodenwert").isEqualTo(2L);
    }

    /**
     * K9 in der Zusammenfassung (IP-11): Lindach mit 410 kWh und 0 Stück hat selbst keine Zahl, zählt aber MIT — Summe der
     * Zähler 6 310, Summe der Nenner 38 000, „2 von 2 Gebäuden“, byte-gleich zum Vertrag und endgültig: ein Paar ohne Zahl
     * ist endgültig, wenn seine eigenen Eingänge es sind. Nicht stillschweigend übersprungen — dann stünde 5 900 ÷ 38 000
     * da. Und ein Monat, in dem Lindach gar nichts hat, ist „1 von 2 Gebäuden (KZ-0002 fehlt)“, unvollständig, Richtung
     * unbestimmt.
     */
    @Test
    void k9DieZusammenfassungZaehltDasPaarMitNennerNullMitUndEinFehlendesPaarIstXVonY() throws Exception {
        Welt w = welt();
        quotient(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6");
        quotient(w, "KZ-0002", "gebaeude", w.g5(), "MS-18", "BZ-7");
        zusammenfassung(w, "KZ-0003", "KZ-0001", "KZ-0002");
        monat(w, "MS-12", "2027-08-01", "5900", List.of(), true);
        bezugswert(w, "BZ-6", "2027-08-01", "38000");
        monat(w, "MS-18", "2027-08-01", "410", List.of(), true);
        bezugswert(w, "BZ-7", "2027-08-01", "0");
        monat(w, "MS-12", "2027-07-01", "5000", List.of(), true);
        bezugswert(w, "BZ-6", "2027-07-01", "30000");

        lauf.lauf(Instant.parse("2027-09-20T06:00:00Z"));

        gleichDemVektor(zeile(w, "KZ-0002", "monat", "2027-08-01"), ergebnis("K9", "wert", 0), "K9 Lindach");
        Map<String, Object> august = zeile(w, "KZ-0003", "monat", "2027-08-01");
        gleichDemVektor(august, ergebnis("K9", "wert", 1), "K9 Unternehmen");
        assertThat(vier(august.get("wert"))).as("übersprungen wäre 5 900 ÷ 38 000")
                .isNotEqualByComparingTo(vier(quotient("5900", "38000")));
        List<Map<String, Object>> paare = eingaenge(august);
        assertThat(paare).extracting(e -> e.get("rolle") + " " + e.get("objekt")).containsExactly("paar KZ-0001",
                "paar KZ-0002");
        assertThat(paare.get(1).get("wert")).as("das Paar Lindach hat keine Zahl").isNull();
        assertThat(zahl(paare.get(1).get("zaehler"))).isEqualByComparingTo("410");
        assertThat(zahl(paare.get(1).get("nenner"))).isEqualByComparingTo("0");

        Map<String, Object> juli = zeile(w, "KZ-0003", "monat", "2027-07-01");
        assertThat(juli.get("menge_zustand")).isEqualTo(ErgebnisZustand.UNVOLLSTAENDIG);
        assertThat(juli.get("richtung")).isEqualTo(KennzahlRegeln.UNBESTIMMT);
        assertThat(vier(juli.get("wert"))).isEqualByComparingTo(vier(quotient("5000", "30000")));
        assertThat(saetze(juli.get("kennzeichen"))).contains(KennzahlRegeln.GEWICHTET, KennzahlRegeln.RICHTUNG_UNBESTIMMT,
                "1 von 2 Gebäuden (KZ-0002 fehlt)");
    }

    // ================================================================ K10: gemessen → berechnet → Kennzahl in einem Takt

    /**
     * Der ECHTE Stundentakt ({@link EndgueltigkeitLaeufer}): MS-19 = MS-16 + MS-17 + MS-18 am 05.11.2026 ohne MS-16 wird im
     * selben Takt berechnet („mindestens 5 550 kWh“) und von der Kennzahl gelesen — vorher gibt es beides nicht. K10:
     * Zähler unvollständig → Untergrenze mit Ursache „MS-16 fehlt“; der Anteil MS-17 am unvollständigen Ganzen ist eine
     * Obergrenze. Der Nenner Mitarbeitende ist ein Stammdatum am Stichtag (E17).
     */
    @Test
    void k10GemessenBerechnetKennzahlInEinemTaktUndDieRichtungJeFall() throws Exception {
        Welt w = welt();
        UUID ms19 = summe(w, "MS-19", List.of("MS-16", "MS-17", "MS-18"));
        LocalDate tag = LocalDate.parse("2026-11-05");
        tageswert(w, "MS-17", tag, "3550");
        tageswert(w, "MS-18", tag, "2000");
        stammdatum(w, "BZ-8", "Mitarbeitende", "Personen", "180");
        anlegen(w, "KZ-0007", "quotient", "unternehmen", w.unternehmen(), e("zaehler", "messstelle", "MS-19"),
                e("nenner", "bezugsgroesse", "BZ-8"));
        anlegen(w, "KZ-0010", "anteil", "unternehmen", w.unternehmen(), e("zaehler", "messstelle", "MS-17"),
                e("nenner", "messstelle", "MS-19"));
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_tag WHERE messstelle_id = ?", Long.class, ms19))
                .isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE tenant_id = ?", Long.class, w.mandant()))
                .isZero();

        new EndgueltigkeitLaeufer(endgueltigkeit, tage, perioden, berechnete, lauf, vorschlaege)
                .takt(Instant.parse("2026-11-20T07:00:00Z"));

        BigDecimal summe = root.queryForObject("SELECT menge FROM messreihe_tag WHERE tenant_id = ? AND messstelle_id = ? "
                + "AND tag = ?", BigDecimal.class, w.mandant(), ms19, tag);
        assertThat(summe).as("MS-19 im selben Takt berechnet").isEqualByComparingTo("5550");

        JsonNode k10 = ergebnis("K10", "wert", 0);
        Map<String, Object> kz7 = zeile(w, "KZ-0007", "tag", "2026-11-05");
        assertThat(zahl(kz7.get("wert")).setScale(4, RoundingMode.HALF_UP)).isEqualByComparingTo(k10.get("wert").asText());
        assertThat(zahl(kz7.get("zaehler"))).isEqualByComparingTo(k10.get("zaehler").asText());
        assertThat(zahl(kz7.get("nenner"))).isEqualByComparingTo(k10.get("nenner").asText());
        assertThat(kz7.get("menge_zustand")).isEqualTo(k10.get("zustand").asText());
        assertThat(kz7.get("richtung")).isEqualTo(k10.get("richtung").asText());
        assertThat(fassungWort(kz7.get("zustand"))).isEqualTo(k10.get("fassung").asText());
        assertThat(kz7.get("version")).isEqualTo(k10.get("version").asInt());
        assertThat(saetze(kz7.get("kennzeichen"))).as("K10: eigene Sätze, Richtung mit Ursache")
                .contains("berechnet (Kennzahl)", "Untergrenze — Menge unvollständig (MS-16 fehlt)");
        assertThat(KennzahlRegeln.anzeige(zahl(kz7.get("wert")), "kWh/Person", (String) kz7.get("richtung")))
                .isEqualTo(k10.get("anzeige").asText());
        List<Map<String, Object>> eingaenge = eingaenge(kz7);
        assertThat(zahl(eingaenge.get(0).get("wert"))).as("gelesen, was der Takt eben berechnet hat").isEqualByComparingTo(summe);
        assertThat(saetze(eingaenge.get(1).get("kennzeichen"))).containsExactly("Stichtag 05.11.2026");

        Map<String, Object> kz10 = zeile(w, "KZ-0010", "tag", "2026-11-05");
        assertThat(kz10.get("richtung")).isEqualTo(KennzahlRegeln.OBERGRENZE);
        assertThat(saetze(kz10.get("kennzeichen"))).contains("Obergrenze — Bezugsgröße unvollständig (MS-16 fehlt)");
        assertThat(zahl(kz10.get("wert")).setScale(4, RoundingMode.HALF_UP)).isEqualByComparingTo("63.9640");
    }

    // ================================================================ Q10: der Kreis

    /**
     * Ein Kreis über Kennzahlen — am Schreibweg unmöglich (K16), hier an ihm vorbei in die Tabelle gelegt — wird im Lauf
     * benannt: {@code formel_kreis} mit Kette für die Kennzahlen im Kreis, {@code haengt_an_kreis} für die, die an ihm
     * hängt. Keine davon bekommt eine Zeile; die übrigen rechnen. Paare einer Zusammenfassung haben dieselbe Rechenform
     * (U1): der Kreis läuft darum über Zusammenfassungen von Zusammenfassungen.
     */
    @Test
    void einKreisWirdBenanntUndNieGerechnet() throws Exception {
        Welt w = welt();
        oktober(w);
        quotient(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6");
        quotient(w, "KZ-0002", "gebaeude", w.g5(), "MS-18", "BZ-7");
        UUID z1 = zusammenfassung(w, "KZ-0901", "KZ-0001", "KZ-0002");
        zusammenfassung(w, "KZ-0904", "KZ-0001", "KZ-0002");
        UUID z2 = zusammenfassung(w, "KZ-0902", "KZ-0901", "KZ-0904");
        UUID z3 = zusammenfassung(w, "KZ-0903", "KZ-0902", "KZ-0904");
        UUID f1 = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1", UUID.class, z1);
        root.update("INSERT INTO kennzahl_eingang (tenant_id, kennzahl_id, fassung_id, rechenform, position, rolle, art, "
                + "eingang_kennzahl_id) VALUES (?, ?, ?, 'zusammenfassung', 2, 'paar', 'kennzahl', ?)", w.mandant(), z1, f1, z2);

        KennzahlLauf.Lauf l = lauf.lauf(Instant.parse("2026-11-20T07:00:00Z"));

        Map<String, KennzahlLauf.Abgelehnt> abgelehnt = l.abgelehnt().stream()
                .filter(a -> a.kennzahl().startsWith("KZ-090"))
                .collect(Collectors.toMap(KennzahlLauf.Abgelehnt::kennzahl, a -> a, (a, b) -> a));
        assertThat(abgelehnt.get("KZ-0901").grund()).isEqualTo(BerechnetePeriode.FORMEL_KREIS);
        assertThat(abgelehnt.get("KZ-0901").kette()).contains("KZ-0901", "KZ-0902");
        assertThat(abgelehnt.get("KZ-0902").grund()).isEqualTo(BerechnetePeriode.FORMEL_KREIS);
        assertThat(abgelehnt.get("KZ-0903").grund()).isEqualTo(BerechnetePeriode.HAENGT_AN_KREIS);
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE kennzahl_id IN (?, ?, ?)", Long.class,
                z1, z2, z3)).isZero();
        assertThat(vier(zeile(w, "KZ-0001", "monat", "2026-10-01").get("wert"))).isEqualByComparingTo("0.1488");
        assertThat(vier(zeile(w, "KZ-0904", "monat", "2026-10-01").get("wert"))).as("was nicht am Kreis hängt, rechnet")
                .isEqualByComparingTo("0.2012");
        assertThat(abgelehnt).doesNotContainKey("KZ-0904");
    }

    // ================================================================ Bestandsschutz

    /**
     * Ein Kundenbereich OHNE Kennzahl — mit gemessenen und berechneten Periodenwerten — ist nach dem Kennzahl-Schritt
     * Zeile für Zeile derselbe: der Schritt schreibt in keine andere Tabelle als die Kennzahl-Werte, und für diesen
     * Kundenbereich auch dort nichts.
     */
    @Test
    void einKundenbereichOhneKennzahlBleibtZeileFuerZeileUnberuehrt() throws Exception {
        Welt w = welt();
        oktober(w);
        summe(w, "MS-19", List.of("MS-16", "MS-17", "MS-18"));
        tageswert(w, "MS-17", LocalDate.parse("2026-11-05"), "3550");
        berechnete.lauf(Instant.parse("2026-11-20T07:00:00Z"));
        List<String> ausnahmen = List.of("kennzahl_wert", "kennzahl_wert_eingang");
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, ausnahmen);

        lauf.lauf(Instant.parse("2026-11-20T07:30:00Z"));

        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, ausnahmen)))
                .as("der Kennzahl-Schritt schreibt nur Kennzahl-Werte").isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE tenant_id = ?", Long.class, w.mandant()))
                .isZero();
    }

    // ================================================================ IP-12: Wochen

    /**
     * IP-12 — konstruiert, als Annahme gekennzeichnet: der Vertrag nennt keine Wochenzahlen, BZ-9 ist die Annahme aus K13.
     * KW 43/2026 (19.–25.10.) an einem Standort in Europe/Zurich endet mit der Sommerzeit: Montag 00:00 bis Montag 00:00
     * in der Zone des STANDORTS sind 169 Stunden. MS-30 zählt 1 kWh je Stunde über beide Wochengrenzen hinaus — die
     * Woche hat 169 kWh (Montag bis Montag in UTC wären es 168), gebildet aus den Periodenständen an den Grenzen, nie als
     * Summe der Tage: es gibt keinen einzigen Tageswert. KZ-0030 hat die Grundperiode Woche (Wochen-Bezugsgröße als
     * Nenner), KZ-0031 die Grundperiode Tag (Stammdatum) und damit auch die Woche. Die Passung bleibt: eine
     * Monatskennzahl aus BZ-9 ist weiter 422 {@code periode_passt_nicht} (K13 Versuch 2).
     */
    @Test
    void ip12DieWocheLiegtInDerZoneDesStandortsUndHatAmEndeDerSommerzeit169Stunden() throws Exception {
        Welt w = welt();
        UUID zuerich = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Zürich', 'ST-3', 'Europe/Zurich', 'aktiv') RETURNING id", UUID.class,
                w.mandant(), w.unternehmen());
        UUID g9 = gebaeude(w.mandant(), zuerich, "Halle Zürich", "G-9");
        UUID anlage = anlage(w.mandant(), "Zürich #" + NR.get());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "DATE '2020-01-01')", w.mandant(), anlage, zuerich);
        messstelle(w, "MS-30", anlage, "Hauptzähler", null);
        stuendlich(w, "MS-30", Instant.parse("2026-10-18T20:00:00Z"), Instant.parse("2026-10-26T02:00:00Z"));
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-9', 'Produktionsmenge je Woche', 'periodenwert', 'Stück', 'woche', 'gebaeude', ?)",
                w.mandant(), g9);
        wochenwert(w, "BZ-9", LocalDate.parse("2026-10-19"), "338");
        stammdatum(w, "BZ-8", "Mitarbeitende", "Personen", "180");
        UUID kz30 = anlegen(w, "KZ-0030", "quotient", "gebaeude", g9, e("zaehler", "messstelle", "MS-30"),
                e("nenner", "bezugsgroesse", "BZ-9"));
        anlegen(w, "KZ-0031", "quotient", "unternehmen", w.unternehmen(), e("zaehler", "messstelle", "MS-30"),
                e("nenner", "bezugsgroesse", "BZ-8"));

        lauf.lauf(Instant.parse("2026-11-20T07:00:00Z"));

        Map<String, Object> kw43 = zeile(w, "KZ-0030", "woche", "2026-10-19");
        assertThat(zahl(kw43.get("zaehler"))).as("169 Stunden Ortszeit, nicht 168 in UTC").isEqualByComparingTo("169");
        assertThat(zahl(kw43.get("nenner"))).isEqualByComparingTo("338");
        assertThat(zahl(kw43.get("wert"))).isEqualByComparingTo("0.5");
        assertThat(kw43.get("menge_zustand")).isEqualTo(VOLL);
        Map<String, Object> grenzen = root.queryForMap("SELECT periode_bis::text AS bis, zeitzone FROM kennzahl_wert "
                + "WHERE id = ?", kw43.get("id"));
        assertThat(grenzen).containsEntry("bis", "2026-10-25").containsEntry("zeitzone", "Europe/Zurich");
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert v JOIN kennzahl k ON k.id = v.kennzahl_id "
                + "WHERE v.tenant_id = ? AND k.kennzeichen = 'KZ-0030' AND v.periode_art <> 'woche'", Long.class,
                w.mandant())).as("Grundperiode Woche: in nichts aufgehend").isZero();

        Map<String, Object> tagesGrund = zeile(w, "KZ-0031", "woche", "2026-10-19");
        assertThat(zahl(tagesGrund.get("zaehler"))).isEqualByComparingTo("169");
        assertThat(zahl(tagesGrund.get("nenner"))).as("Stichtag Sonntag 25.10.").isEqualByComparingTo("180");
        assertThat(root.queryForObject("SELECT zeitzone FROM kennzahl_wert WHERE id = ?", String.class,
                tagesGrund.get("id"))).as("P5: die Zone des Geltungsobjekts, hier das Unternehmen").isEqualTo("Europe/Berlin");
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_tag WHERE tenant_id = ?", Long.class, w.mandant()))
                .as("keine Tageswerte — die Woche ist keine Summe der Tage").isZero();

        JsonNode route = lesen(w, PFAD + "/" + kz30 + "/werte?periode=woche&von=2026-10-19&bis=2026-10-25");
        assertThat(new BigDecimal(route.get("werte").get(0).get("zaehler").asText())).as("die Route liest die Woche")
                .isEqualByComparingTo("169");

        Map<String, Object> monat = new LinkedHashMap<>();
        monat.put("kennzeichen", "KZ-0032");
        monat.put("name", "Kennzahl KZ-0032");
        monat.put("rechenform", "quotient");
        monat.put("geltung_art", "gebaeude");
        monat.put("geltung_id", g9.toString());
        monat.put("eingaenge", List.of(e("zaehler", "messstelle", "MS-30"), e("nenner", "bezugsgroesse", "BZ-9")));
        monat.put("periode_art", "monat");
        MvcResult abgelehnt = ruf(w, monat);
        String text = abgelehnt.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(abgelehnt.getResponse().getStatus()).as(text).isEqualTo(422);
        assertThat(MAPPER.readTree(text).get("code").asText()).isEqualTo("periode_passt_nicht");
    }

    /**
     * Endgültige Viertelstunden des Zählerstands in {@code [von, bis)}, je 0,25 kWh (1 kWh je Stunde) — die Form, aus
     * der der freie Zeitraum der Regel eine Woche bildet (Annahme dieses Tests).
     */
    private static void stuendlich(Welt w, String kennzeichen, Instant von, Instant bis) {
        List<Object[]> zeilen = new ArrayList<>();
        BigDecimal stand = new BigDecimal("1000.00");
        for (Instant b = von; b.isBefore(bis); b = b.plusSeconds(900)) {
            BigDecimal ende = stand.add(new BigDecimal("0.25"));
            Timestamp anfang = Timestamp.from(b);
            Timestamp letzte = Timestamp.from(b.plusSeconds(840));
            zeilen.add(new Object[] {anfang, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE, stand, anfang, ende,
                    letzte, stand, anfang, ende, letzte, Timestamp.from(b.plus(Duration.ofDays(8))), new BigDecimal("0.25")});
            stand = ende;
        }
        root.batchUpdate("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, entity_id, messkanal, wertart, "
                + "stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, erster_zeit, letzter_wert, "
                + "letzter_zeit, erhalten, erwartet, abdeckung_prozent, kadenz_s, kadenz_herkunft, n_good, rolle, zustand, "
                + "endgueltig_ab, version, menge, menge_zustand, faktor) VALUES (?, ?, ?, ?, 'counter', ?, ?, ?, ?, ?, ?, ?, "
                + "?, 15, 15, 100, 60, 'auswahl', 15, 'fuehrend', 'endgueltig', ?, 1, ?, 'vollständig', 1)", zeilen);
    }

    /** Ein wirksamer Wochenwert einer Bezugsgröße (Annahme: BZ-9 aus K13) — eingetragen am Montag nach der Woche. */
    private static void wochenwert(Welt w, String kennzeichen, LocalDate montag, String betrag) {
        UUID bg = root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                w.mandant(), kennzeichen);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'Stück', 'woche', ?, ?, "
                + "'Europe/Zurich', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", w.mandant(), bg, montag, montag.plusDays(6), new BigDecimal(betrag),
                Timestamp.from(montag.plusDays(7).atStartOfDay(ZoneId.of("Europe/Zurich")).plusHours(9).toInstant()));
    }

    // ================================================================ Vergleich mit dem Vertrag

    private static JsonNode pruefung(String fall, String regel, int index) {
        for (JsonNode c : vertrag.get("cases")) {
            if (c.get("id").asText().equals(fall)) {
                List<JsonNode> treffer = new ArrayList<>();
                c.get("pruefungen").forEach(p -> {
                    if (p.get("regel").asText().equals(regel)) {
                        treffer.add(p);
                    }
                });
                return treffer.get(index);
            }
        }
        throw new AssertionError("Fall " + fall + " fehlt");
    }

    private static JsonNode ergebnis(String fall, String regel, int index) {
        return pruefung(fall, regel, index).get("ergebnis");
    }

    private static JsonNode herkunft(String fall) {
        return pruefung(fall, "herkunft", 0).get("eingang");
    }

    /** Die gespeicherte Zeile gleich dem Ergebnis der Regel im Vertrag — Zahlen auf die Vergleichsstellen (U4). */
    private static void gleichDemVektor(Map<String, Object> z, JsonNode erw, String was) {
        zahlGleich(z.get("wert"), erw.get("wert"), was + " wert");
        zahlGleich(z.get("zaehler"), erw.get("zaehler"), was + " zaehler");
        zahlGleich(z.get("nenner"), erw.get("nenner"), was + " nenner");
        zahlGleich(z.get("abdeckung_prozent"), erw.get("abdeckung_prozent"), was + " abdeckung");
        assertThat(z.get("menge_zustand")).as(was + " zustand").isEqualTo(erw.get("zustand").asText());
        assertThat(z.get("richtung")).as(was + " richtung").isEqualTo(text(erw.get("richtung")));
        assertThat(z.get("grund")).as(was + " grund").isEqualTo(text(erw.get("grund")));
        assertThat(fassungWort(z.get("zustand"))).as(was + " fassung").isEqualTo(text(erw.get("fassung")));
        assertThat(z.get("version")).as(was + " version").isEqualTo(erw.get("version").isNull() ? null
                : erw.get("version").asInt());
        assertThat(saetze(z.get("kennzeichen"))).as(was + " kennzeichen")
                .containsExactlyElementsOf(texte(erw.get("kennzeichen")));
        if (z.get("wert") != null) {
            String einheit = saetze(z.get("kennzeichen")).isEmpty() ? null : "kWh/Stück";
            if (einheit != null && erw.get("anzeige").asText().contains("Stück")) {
                assertThat(KennzahlRegeln.anzeige(zahl(z.get("wert")), einheit, (String) z.get("richtung")))
                        .as(was + " anzeige").isEqualTo(erw.get("anzeige").asText());
            }
        }
    }

    /** Die Eingänge der gespeicherten Herkunft gleich den Eingängen des Herkunft-Vektors. */
    private static void herkunftGleich(Map<String, Object> z, JsonNode erw, String was) {
        List<Map<String, Object>> ist = eingaenge(z);
        JsonNode soll = erw.get("eingaenge");
        assertThat(ist).as(was + " Eingänge").hasSize(soll.size());
        for (int i = 0; i < soll.size(); i++) {
            Map<String, Object> e = ist.get(i);
            JsonNode s = soll.get(i);
            String wo = was + " Eingang " + i;
            assertThat(e.get("rolle")).as(wo + " rolle").isEqualTo(s.get("rolle").asText());
            assertThat(e.get("art")).as(wo + " art").isEqualTo(s.get("art").asText());
            assertThat(e.get("objekt")).as(wo + " objekt").isEqualTo(s.get("objekt").asText());
            assertThat(e.get("einheit")).as(wo + " einheit").isEqualTo(s.get("einheit").asText());
            assertThat(e.get("menge_zustand")).as(wo + " zustand").isEqualTo(s.get("zustand").asText());
            zahlGleich(e.get("wert"), s.get("wert"), wo + " wert");
            zahlGleich(e.get("zaehler"), s.get("zaehler"), wo + " zaehler");
            zahlGleich(e.get("nenner"), s.get("nenner"), wo + " nenner");
            zahlGleich(e.get("abdeckung_prozent"), s.get("abdeckung_prozent"), wo + " abdeckung");
            assertThat(e.get("version")).as(wo + " version").isEqualTo(s.get("version").isNull() ? null
                    : s.get("version").asInt());
            assertThat(e.get("fassung")).as(wo + " fassung").isEqualTo(s.get("fassung").isNull() ? null
                    : s.get("fassung").asInt());
            assertThat(saetze(e.get("kennzeichen"))).as(wo + " kennzeichen")
                    .containsExactlyElementsOf(texte(s.get("kennzeichen")));
        }
    }

    private static void zahlGleich(Object ist, JsonNode soll, String was) {
        if (soll == null || soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isNotNull();
        assertThat(zahl(ist).setScale(4, RoundingMode.HALF_UP)).as(was)
                .isEqualByComparingTo(new BigDecimal(soll.asText()).setScale(4, RoundingMode.HALF_UP));
    }

    private static BigDecimal zahl(Object o) {
        return o == null ? null : new BigDecimal(o.toString());
    }

    /** Auf die Vergleichsstellen des Vertrags (U4: verglichen auf 4). */
    private static BigDecimal vier(Object o) {
        return zahl(o).setScale(4, RoundingMode.HALF_UP);
    }

    private static BigDecimal quotient(String z, String n) {
        return new BigDecimal(z).divide(new BigDecimal(n), 10, RoundingMode.HALF_UP);
    }

    private static boolean naehe(BigDecimal x, BigDecimal ziel) {
        return x.subtract(ziel).abs().compareTo(new BigDecimal("0.00005")) < 0;
    }

    private static String fassungWort(Object zustand) {
        return zustand == null ? null : "endgueltig".equals(zustand) ? "endgültig" : "vorläufig";
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static List<String> saetze(Object json) {
        try {
            return json == null ? List.of() : MAPPER.readValue(json.toString(), new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    // ================================================================ lesen

    private static Map<String, Object> zeile(Welt w, String kennzahl, String art, String von) {
        List<Map<String, Object>> z = root.queryForList("SELECT w.id, w.version, w.wert, w.zaehler, w.nenner, "
                + "w.menge_zustand, w.kennzeichen::text AS kennzeichen, w.abdeckung_prozent, w.richtung, w.grund, w.zustand, "
                + "w.endgueltig_ab, f.nummer AS definition_fassung FROM kennzahl_wert w "
                + "JOIN kennzahl k ON k.id = w.kennzahl_id JOIN kennzahl_fassung f ON f.id = w.definition_fassung_id "
                + "WHERE w.tenant_id = ? AND k.kennzeichen = ? AND w.periode_art = ? AND w.periode_von = ? "
                + "ORDER BY w.version DESC NULLS LAST, w.berechnet_am DESC LIMIT 1", w.mandant(), kennzahl, art,
                LocalDate.parse(von));
        assertThat(z).as(kennzahl + " " + art + " " + von + " hat eine Zeile").hasSize(1);
        return z.get(0);
    }

    private static long anzahl(Welt w, String kennzahl, String art, String von) {
        return root.queryForObject("SELECT count(*) FROM kennzahl_wert v JOIN kennzahl k ON k.id = v.kennzahl_id "
                + "WHERE v.tenant_id = ? AND k.kennzeichen = ? AND v.periode_art = ? AND v.periode_von = ?", Long.class,
                w.mandant(), kennzahl, art, LocalDate.parse(von));
    }

    private static List<Map<String, Object>> eingaenge(Map<String, Object> zeile) {
        return root.queryForList("SELECT position, rolle, art, objekt, wert, zaehler, nenner, einheit, menge_zustand, "
                + "abdeckung_prozent, version, fassung, kennzeichen::text AS kennzeichen FROM kennzahl_wert_eingang "
                + "WHERE wert_id = ? ORDER BY position", zeile.get("id"));
    }

    private static List<BigDecimal> alleZahlen(Welt w) {
        return root.queryForList("SELECT x FROM (SELECT wert AS x FROM kennzahl_wert WHERE tenant_id = ? "
                + "UNION ALL SELECT zaehler FROM kennzahl_wert WHERE tenant_id = ? "
                + "UNION ALL SELECT nenner FROM kennzahl_wert WHERE tenant_id = ? "
                + "UNION ALL SELECT wert FROM kennzahl_wert_eingang WHERE tenant_id = ? "
                + "UNION ALL SELECT zaehler FROM kennzahl_wert_eingang WHERE tenant_id = ? "
                + "UNION ALL SELECT nenner FROM kennzahl_wert_eingang WHERE tenant_id = ?) s WHERE x IS NOT NULL",
                BigDecimal.class, w.mandant(), w.mandant(), w.mandant(), w.mandant(), w.mandant(), w.mandant());
    }

    /** Die Kennzahl-Werte des Kundenbereichs, Zeile für Zeile. */
    private static String kennzahlTabellen(Welt w) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("kennzahl_wert", "kennzahl_wert_eingang")) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg("
                    + "t::text, '|' ORDER BY t::text)), '-') FROM " + tabelle + " t WHERE t.tenant_id = ?", String.class,
                    w.mandant())).append('\n');
        }
        return s.toString();
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID unternehmen, UUID g2, UUID g5, UUID halle2, UUID lindach,
            Map<String, UUID> messstellen, Map<String, UUID> komponenten) {}

    /** Ahrenberg 1.3: ST-1 mit Halle 2 (MS-10, MS-12), ST-2 mit der Montagehalle Lindach (MS-16, MS-17, MS-18), BZ-6/BZ-7. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Rechenlauf #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        Welt w = new Welt(t, u, gebaeude(t, st1, "Halle 2", "G-2"), gebaeude(t, st2, "Montagehalle Lindach", "G-5"),
                anlage(t, "Halle 2 #" + nr), anlage(t, "Lindach #" + nr), new LinkedHashMap<>(), new LinkedHashMap<>());
        messstelle(w, "MS-10", w.halle2(), "Hauptzähler", null);
        messstelle(w, "MS-12", w.halle2(), "Unterzähler", "MS-10");
        messstelle(w, "MS-16", w.lindach(), "Hauptzähler", null);
        messstelle(w, "MS-17", w.lindach(), "Unterzähler", "MS-16");
        messstelle(w, "MS-18", w.lindach(), "Unterzähler", "MS-16");
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-6', 'Gutteile Montage Halle 2', 'periodenwert', 'Stück', 'monat', 'gebaeude', ?)",
                t, w.g2());
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-7', 'Gutteile Montage Lindach', 'periodenwert', 'Stück', 'monat', 'gebaeude', ?)",
                t, w.g5());
        return w;
    }

    /** Oktober 2026 des Referenzunternehmens: MS-12 6 100 kWh, MS-18 3 600 kWh ab 15.10., BZ-6 41 000, BZ-7 7 200 Stück. */
    private void oktober(Welt w) {
        monat(w, "MS-12", "2026-10-01", "6100", List.of(), true);
        monat(w, "MS-18", "2026-10-01", "3600", List.of("ab 15.10.2026"), true);
        bezugswert(w, "BZ-6", "2026-10-01", "41000");
        bezugswert(w, "BZ-7", "2026-10-01", "7200");
    }

    private static UUID standort(UUID t, UUID u, String name, String kurz) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, name, kurz);
    }

    private static UUID gebaeude(UUID t, UUID standort, String name, String kurz) {
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', ?, "
                + "?, 'aktiv') RETURNING id", UUID.class, t, name, kurz);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g, standort);
        return g;
    }

    private static UUID anlage(UUID t, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
    }

    /** Box, Komponente, Mess-Selektion des Zählerstands, gemessene Messstelle mit führender Quelle, Stellung. */
    private static void messstelle(Welt w, String kennzeichen, UUID anlage, String stellung, String unterzaehlerVon) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-KENNZAHL-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, anlage,
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, anlage, box, komponente, ENERGIE, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                Timestamp.from(Instant.parse("2020-01-01T00:01:00Z")));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, anlage, stellung,
                unterzaehlerVon == null ? null : w.messstellen().get(unterzaehlerVon), LocalDate.parse("2020-01-01"));
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
    }

    /** Eine berechnete Messstelle: gewichtete Summe aus Baustein-Termen (je „+“, Faktor 1). */
    private static UUID summe(Welt w, String kennzeichen, List<String> bausteine) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'berechnet', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') "
                + "RETURNING id", UUID.class, w.mandant(), kennzeichen, "Netzbezug gesamt");
        w.messstellen().put(kennzeichen, ms);
        UUID fassung = root.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, "
                + "formel_typ, herkunft, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'gewichtete_summe', 'anlage', "
                + "'sub-test', 'Test', 'kunde') RETURNING id", UUID.class, w.mandant(), ms);
        int position = 0;
        for (String b : bausteine) {
            root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                    + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, ?, ?, 'messstelle', ?, '+', 1)", w.mandant(),
                    ms, fassung, position++, w.messstellen().get(b));
        }
        return ms;
    }

    /** Ein gemessener Monatswert der Reihe einer Messstelle (AP-08 IP-5) — endgültig oder noch vorläufig. */
    private static void monat(Welt w, String kennzeichen, String ersterTag, String menge, List<String> saetze,
            boolean endgueltig) {
        LocalDate erster = LocalDate.parse(ersterTag);
        Instant b = erster.atStartOfDay(ZONE).toInstant();
        Instant e = erster.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int tageImMonat = erster.lengthOfMonth();
        long stunden = ChronoUnit.HOURS.between(b, e);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', ?::jsonb, ?, ?, "
                + "100, ?, ?, 1)", erster, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE, Timestamp.from(b),
                Timestamp.from(e), stunden, tageImMonat, tageImMonat, endgueltig ? tageImMonat : 0, menge, json(saetze),
                stunden * 60, stunden * 60, endgueltig ? "endgueltig" : "vorlaeufig",
                Timestamp.from(e.plus(Duration.ofDays(7))));
    }

    /** Ein gemessener, vollständiger, vorläufiger Tageswert der Reihe einer Messstelle (AP-07 IP-13, AP-08 IP-5). */
    private static void tageswert(Welt w, String kennzeichen, LocalDate tag, String menge) {
        int stunden = TagRegeln.stunden(tag, ZONE);
        int slots = stunden * 4;
        int erwartet = stunden * 60;
        Instant beginn = tag.atStartOfDay(ZONE).toInstant();
        Instant ende = tag.plusDays(1).atStartOfDay(ZONE).toInstant();
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, erhalten, erwartet, "
                + "abdeckung_prozent, rolle, zustand, endgueltig_ab, version, menge, menge_zustand, kennzeichen) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, 0, 'counter', ?, ?, 100, 'fuehrend', "
                + "'vorlaeufig', ?, 1, ?::numeric, ?, '[]'::jsonb)", tag, w.mandant(), w.komponenten().get(kennzeichen),
                ENERGIE, Timestamp.from(beginn), Timestamp.from(ende), stunden, slots, slots, erwartet, erwartet,
                Timestamp.from(ende.plus(Duration.ofDays(7))), menge, VOLL);
    }

    /** Ein wirksamer Monatswert einer Bezugsgröße, so wie ihn AP-09 IP-7 schreibt — eingetragen nach dem Monatsende (E16). */
    private static void bezugswert(Welt w, String kennzeichen, String ersterTag, String betrag) {
        LocalDate erster = LocalDate.parse(ersterTag);
        UUID bg = root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                w.mandant(), kennzeichen);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'Stück', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", w.mandant(), bg, erster, erster.plusMonths(1).minusDays(1), new BigDecimal(betrag),
                Timestamp.from(erster.plusMonths(1).atStartOfDay(ZONE).plusHours(9).toInstant()));
    }

    /** Ein Bezugs-Stammdatum am Unternehmen, gültig seit 2020 (AP-09 E15). */
    private static void stammdatum(Welt w, String kennzeichen, String name, String einheit, String wert) {
        UUID bg = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, unternehmen_id) VALUES (?, ?, ?, 'stammdatum', ?, NULL, 'unternehmen', ?) RETURNING id",
                UUID.class, w.mandant(), kennzeichen, name, einheit, w.unternehmen());
        root.update("INSERT INTO bezugsgroesse_stammdatum (tenant_id, bezugsgroesse_id, einheit, wert, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, '2020-01-01')", w.mandant(), bg, einheit, new BigDecimal(wert));
    }

    private static String json(List<String> saetze) {
        try {
            return MAPPER.writeValueAsString(saetze);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    // ================================================================ Kennzahlen über die Schnittstelle (IP-5)

    private void quotient(Welt w, String kennzeichen, String geltungArt, UUID geltung, String zaehler, String nenner)
            throws Exception {
        anlegen(w, kennzeichen, "quotient", geltungArt, geltung, e("zaehler", "messstelle", zaehler),
                e("nenner", "bezugsgroesse", nenner));
    }

    @SafeVarargs
    private UUID anlegen(Welt w, String kennzeichen, String rechenform, String geltungArt, UUID geltung,
            Map<String, Object>... eingaenge) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", "Kennzahl " + kennzeichen);
        m.put("rechenform", rechenform);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        m.put("eingaenge", List.of(eingaenge));
        MvcResult r = ruf(w, m);
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(201);
        JsonNode body = text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text);
        return UUID.fromString(body.get("id").asText());
    }

    private UUID zusammenfassung(Welt w, String kennzeichen, String... paare) throws Exception {
        List<Map<String, Object>> eingaenge = new ArrayList<>();
        for (String p : paare) {
            eingaenge.add(e("paar", "kennzahl", p));
        }
        @SuppressWarnings("unchecked")
        Map<String, Object>[] liste = eingaenge.toArray(new Map[0]);
        return anlegen(w, kennzeichen, "zusammenfassung", "unternehmen", w.unternehmen(), liste);
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    private MvcResult ruf(Welt w, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(HttpMethod.POST, PFAD)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(body));
        return mvc.perform(anfrage).andReturn();
    }

    /** Ein GET als Ines — die Antwort muss 200 sein. */
    private JsonNode lesen(Welt w, String pfad) throws Exception {
        MvcResult r = mvc.perform(request(HttpMethod.GET, pfad).with(jwt().jwt(j -> {
            j.subject("sub-ines-" + w.mandant());
            j.claim("preferred_username", "Ines Kaltenbach");
            j.claim("tenant_id", w.mandant().toString());
        }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(200);
        return MAPPER.readTree(text);
    }
}
