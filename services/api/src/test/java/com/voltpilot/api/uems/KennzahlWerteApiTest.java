package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.dao.DataAccessException;
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
 * Die Werte einer Kennzahl lesen (UEMS AP-11 IP-7) — über die Routen, gegen eine echte Datenbank.
 *
 * <p>Die Zeilen schreibt der Test so, wie Rechenlauf (IP-6) und Kaskade (IP-8/IP-9) sie schreiben: als
 * Verwaltungsrolle, append-only, Version für Version durch den Trigger {@code kennzahl_wert_version_folgt}. Eingänge
 * und Ergebnis jeder Zeile sind die des Herkunfts-Vektors ({@code kennzahl-vectors.json}, Regel {@code herkunft}) —
 * dass der Rechenlauf genau diese Eingänge speichert, prüft {@code UemsKennzahlRechenlaufTest.herkunftGleich}. Hier
 * zählt der zweite Teil: aus den gespeicherten Zeilen kommt die Hülle {@code {satz, fehlt}} BYTE-GLEICH zum Vektor.
 *
 * <p>Die Kennzahlen selbst entstehen über den Schreibweg (IP-5), jede mit der Einheit ihres Falls. Die Korrektur
 * K-2026-0007 ist die der Referenzdatei 1.4 (Ines Kaltenbach, Begründung und Zeitpunkte von dort).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KennzahlWerteApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "kennzahl-vectors.json");
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final String OKTOBER = "?periode=monat&von=2026-10-01&bis=2026-10-31";
    private static final String K7_BEGRUENDUNG = "Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)";

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
        // Der Stundentakt schreibt selbst Kennzahl-Zeilen — hier schreibt allein der Test.
        registry.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired
    MockMvc mvc;

    @MockBean
    KennzahlAufrufer aufrufer;

    @Autowired
    KennzahlService kennzahlen;

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID unternehmen, UUID g2, UUID g5, Map<String, UUID> kz) {}

    private record Antwort(int status, JsonNode body) {}

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
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    @Test
    void a15W3UndRa6SchuetzenAlleKennzahlLesewegeOhneTeilrechnung() throws Exception {
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2026-11-20T12:00:00Z"), ZoneOffset.UTC));
        Welt w = welt();
        zeile(w, eingang("K3", 0), "vorlaeufig", null);
        UUID st1 = root.queryForObject("SELECT id FROM standort WHERE tenant_id = ? AND kurzzeichen = 'ST-1'",
                UUID.class, w.mandant());
        UUID st2 = root.queryForObject("SELECT id FROM standort WHERE tenant_id = ? AND kurzzeichen = 'ST-2'",
                UUID.class, w.mandant());
        String basis = PFAD + "/" + w.kz().get("KZ-0003");
        String werte = basis + "/werte?periode=monat&von=2026-10-01&bis=2026-10-31";
        for (var rolle : List.of(RechteAbleitung.Rolle.KUNDENADMINISTRATOR, RechteAbleitung.Rolle.ENERGIEMANAGER)) {
            doReturn(person(rolle, null)).when(aufrufer).benutzer(any());
            JsonNode wert = einziger(ok(ruf(w, werte)));
            assertThat(new BigDecimal(wert.path("wert").asText()).setScale(2, java.math.RoundingMode.HALF_UP))
                    .isEqualByComparingTo("0.20");
            assertThat(ok(ruf(w, PFAD)).has("ausserhalb_zugriff")).isFalse();
        }
        String vorher = root.queryForObject("SELECT jsonb_agg(to_jsonb(k) ORDER BY id)::text FROM kennzahl_wert k "
                + "WHERE tenant_id = ?", String.class, w.mandant());
        for (var person : List.of(person(RechteAbleitung.Rolle.BEARBEITER, List.of(st2.toString())),
                person(RechteAbleitung.Rolle.LESER, List.of(st1.toString(), st2.toString())))) {
            doReturn(person).when(aufrufer).benutzer(any());
            JsonNode liste = ok(ruf(w, PFAD));
            assertThat(liste.path("ausserhalb_zugriff").path("anzahl").asInt()).isEqualTo(1);
            assertThat(liste.path("ausserhalb_zugriff").path("text").asText())
                    .isEqualTo("1 Kennzahl umfasst Standorte außerhalb Ihres Zugriffs");
            assertThat(liste.toString()).doesNotContain("KZ-0003", w.kz().get("KZ-0003").toString(), "0.2012");
            assertThat(ok(ruf(w, PFAD + "/paare")).toString()).doesNotContain("KZ-0003");
            for (String weg : List.of(basis, basis + "/fassungen", basis + "/berechnung", werte,
                    basis + "/werte/versionen?periode=monat&von=2026-10-01")) {
                Antwort a = ruf(w, weg);
                assertThat(a.status()).as(weg + " " + a.body()).isEqualTo(404);
                assertThat(a.body().toString()).doesNotContain("KZ-0003", "6100", "3600", "48200");
            }
        }
        assertThat(root.queryForObject("SELECT jsonb_agg(to_jsonb(k) ORDER BY id)::text FROM kennzahl_wert k "
                + "WHERE tenant_id = ?", String.class, w.mandant())).as("kein Aufruf rechnet 3600 geteilt durch irgendetwas")
                .isEqualTo(vorher);
    }

    private static RechteAbleitung.Benutzer person(RechteAbleitung.Rolle rolle, List<String> standorte) {
        return new RechteAbleitung.Benutzer("ip11", "Ahrenberg", RechteAbleitung.Konto.BENUTZER,
                RechteAbleitung.KontoZustand.AKTIV, List.of(new RechteAbleitung.Zuweisung(rolle, standorte, null, null,
                        Instant.parse("2020-01-01T00:00:00Z"), null, null)));
    }

    @Test
    void ra6VerbirgtAuchStandortKennzahlMitSpaeterFremdemEingang() throws Exception {
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2026-11-20T12:00:00Z"), ZoneOffset.UTC));
        Welt w = welt();
        UUID st2 = root.queryForObject("SELECT id FROM standort WHERE tenant_id = ? AND kurzzeichen = 'ST-2'",
                UUID.class, w.mandant());
        doReturn(person(RechteAbleitung.Rolle.BEARBEITER, List.of(st2.toString()))).when(aufrufer).benutzer(any());
        String kz2 = PFAD + "/" + w.kz().get("KZ-0002");
        assertThat(ruf(w, kz2).status()).isEqualTo(200);
        UUID ms18 = objektId(w, "messstelle", "MS-18", "MS-18");
        root.update("UPDATE messstelle_ort SET gueltig_bis = '2026-10-31' WHERE messstelle_id = ?", ms18);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-11-01')", w.mandant(), ms18, w.g2());
        for (String suffix : List.of("", "/fassungen", "/berechnung",
                "/werte?periode=monat&von=2026-10-01&bis=2026-10-31",
                "/werte/versionen?periode=monat&von=2026-10-01")) {
            assertThat(ruf(w, kz2 + suffix).status()).as(suffix).isEqualTo(404);
        }
        assertThat(ok(ruf(w, PFAD)).path("kennzahlen").toString()).doesNotContain("KZ-0002");
        String vorher = root.queryForObject("SELECT to_jsonb(k)::text FROM kennzahl k WHERE id = ?", String.class,
                w.kz().get("KZ-0002"));
        String fassungenVorher = root.queryForObject("SELECT jsonb_agg(to_jsonb(f) ORDER BY id)::text "
                + "FROM kennzahl_fassung f WHERE kennzahl_id = ?", String.class, w.kz().get("KZ-0002"));
        Map<String, Object> aenderung = Map.of("kennzeichen", "KZ-0002", "name", "Verdeckte Änderung",
                "verantwortlich_name", "Peter Hollerbach");
        Map<String, Object> fassung = Map.of("gueltig_ab", "2026-11-21", "begruendung", "Versuch", "eingaenge", List.of(
                Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-18"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-7")));
        for (Object[] weg : new Object[][] {{HttpMethod.PUT, "", aenderung}, {HttpMethod.POST, "/archivieren", null},
                {HttpMethod.DELETE, "", null}, {HttpMethod.POST, "/fassungen", fassung}}) {
            Antwort a = ruf(w, (HttpMethod) weg[0], kz2 + weg[1], weg[2]);
            assertThat(a.status()).as(weg[0] + " " + weg[1] + " " + a.body()).isEqualTo(404);
            assertThat(a.body().toString()).doesNotContain("KZ-0002", "MS-18", "BZ-7");
        }
        assertThat(root.queryForObject("SELECT to_jsonb(k)::text FROM kennzahl k WHERE id = ?", String.class,
                w.kz().get("KZ-0002"))).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT jsonb_agg(to_jsonb(f) ORDER BY id)::text "
                + "FROM kennzahl_fassung f WHERE kennzahl_id = ?", String.class, w.kz().get("KZ-0002")))
                .isEqualTo(fassungenVorher);
    }

    // ================================================================ §7: jeder Fall mit Herkunft, byte-gleich

    /**
     * Jede Prüfung der Regel {@code herkunft} in {@code kennzahl-vectors.json} — K1, K3–K7, K10–K12, K15, K17, K19, K22.
     * Die mit Satz kommen aus der Route byte-gleich zum Vektor (Schlüsselreihenfolge, Dezimaltext, {@code null}),
     * jeweils mit der Version ihres Satzes angefragt: K1 und K5 sind darum {@code version=1}, während K7 bzw. K6
     * aktuell ist. Die Prüfung OHNE Satz (K6: ab Version 2 ohne Anlass) kann gar nicht gespeichert werden — die Tabelle
     * lehnt die Zeile ab, eine halbe Herkunft erreicht den Leser nie. Kommt ein Fall dazu, bleibt er hier ungesät und
     * der Test wird rot.
     */
    @Test
    void jederHerkunftsFallDerVektorenKommtByteGleichAusDerRoute() throws Exception {
        Welt a = welt();
        zeile(a, eingang("K1", 0), "endgueltig", null);
        zeile(a, eingang("K7", 0), "endgueltig", "eingang");
        zeile(a, eingang("K3", 0), "vorlaeufig", null);
        zeile(a, eingang("K4", 0), "vorlaeufig", null);
        zeile(a, eingang("K5", 0), "endgueltig", null);
        zeile(a, eingang("K6", 0), "endgueltig", "eingang");
        zeile(a, eingang("K10", 0), "vorlaeufig", null);
        zeile(a, eingang("K11", 0), "vorlaeufig", null);
        zeile(a, eingang("K12", 0), "vorlaeufig", null);
        zeile(a, eingang("K15", 0), "vorlaeufig", null);
        zeile(a, eingang("K17", 0), "vorlaeufig", null);
        zeile(a, eingang("K22", 0), "vorlaeufig", null);
        // K19 ist eine andere Geschichte desselben Oktobers von KZ-0004: ein eigener Kundenbereich.
        Welt b = welt();
        zeile(b, eingang("K5", 0), "endgueltig", null);
        zeile(b, eingang("K19", 0), "endgueltig", "eingang");

        int mitSatz = 0;
        int ohneSatz = 0;
        int alle = 0;
        for (JsonNode fall : vertrag.get("cases")) {
            for (JsonNode p : fall.get("pruefungen")) {
                if (!"herkunft".equals(p.get("regel").asText())) {
                    continue;
                }
                alle++;
                String was = fall.get("id").asText() + " „" + p.get("name").asText() + "“";
                JsonNode h = p.get("eingang");
                if (p.get("ergebnis").get("satz").isNull()) {
                    assertThat(texte(p.get("ergebnis").get("fehlt"))).as(was).containsExactly("anlass");
                    halbeHerkunftWirdNichtGespeichert(a, h);
                    ohneSatz++;
                    continue;
                }
                Welt w = "K19".equals(fall.get("id").asText()) ? b : a;
                LocalDate[] p0 = spanne(h);
                JsonNode antwort = ok(ruf(w, PFAD + "/" + w.kz().get(h.get("kennzahl").asText()) + "/werte?periode="
                        + h.get("periode").get("art").asText() + "&von=" + p0[0] + "&bis=" + p0[1] + "&version="
                        + h.get("version").asInt()));
                JsonNode schritt = einziger(antwort);
                assertThat(schritt.get("version").asInt()).as(was).isEqualTo(h.get("version").asInt());
                assertThat(MAPPER.writeValueAsString(schritt.get("herkunft"))).as(was + " byte-gleich")
                        .isEqualTo(MAPPER.writeValueAsString(p.get("ergebnis")));
                mitSatz++;
            }
        }
        assertThat(mitSatz).as("Herkunfts-Fälle mit Satz").isEqualTo(13);
        assertThat(ohneSatz).as("Herkunfts-Fälle ohne Satz").isEqualTo(1);
        assertThat(mitSatz + ohneSatz).isEqualTo(alle);
    }

    // ================================================================ K7 (und K6): Version 1 bleibt lesbar

    /**
     * K7: KZ-0001 Oktober ist nach der Korrektur K-2026-0007 Version 2 (0,1473); {@code ?version=1} liefert Version 1
     * (0,1488) mit IHRER Herkunft, eine Version 3 gibt es nirgends (404). Die Historie nennt beide mit „was vorher“,
     * und an Version 2 wer, wann, warum aus den Fassungen der Korrektur — auch in einem zweiten Kundenbereich mit
     * derselben Kennung erscheint nie dessen Grund. K6 (die Stelle, auf die der Auftrag zeigt): KZ-0004 Version 1 =
     * 0,2837 bleibt unter {@code …/werte/versionen} lesbar, aktuell ist 0,2833; ihr Beleg nennt einen Import — einen
     * Vorgang, den der Leser (noch) nicht auflöst: keine Entscheidung, der Text steht im Anlass.
     */
    @Test
    void k7FragtVersionEinsUndDieHistorieNenntWerWannWarum() throws Exception {
        Welt w = welt();
        zeile(w, eingang("K1", 0), "endgueltig", null);
        korrekturK7(w, K7_BEGRUENDUNG);
        zeile(w, eingang("K7", 0), "endgueltig", "eingang");
        zeile(w, eingang("K5", 0), "endgueltig", null);
        zeile(w, eingang("K6", 0), "endgueltig", "eingang");
        Welt fremd = welt();
        korrekturK7(fremd, "Ein Grund aus einem fremden Kundenbereich, der nie erscheint");
        String kz1 = PFAD + "/" + w.kz().get("KZ-0001");

        JsonNode aktuell = ok(ruf(w, kz1 + "/werte" + OKTOBER));
        assertThat(aktuell.get("version").isNull()).isTrue();
        JsonNode v2 = einziger(aktuell);
        assertThat(v2.get("wert").asText()).isEqualTo("0.1473");
        assertThat(v2.get("version").asInt()).isEqualTo(2);
        assertThat(v2.get("versionen").asInt()).isEqualTo(2);
        assertThat(v2.get("definition_fassung").asInt()).as("Fassung und Version sind zwei Achsen").isEqualTo(1);
        assertThat(texte(v2.get("kennzeichen"))).containsExactly("berechnet (Kennzahl)", "korrigiert (Version 2)");
        assertThat(MAPPER.writeValueAsString(v2.get("herkunft"))).isEqualTo(MAPPER.writeValueAsString(
                herkunft("K7", 0).get("ergebnis")));

        JsonNode alt = ok(ruf(w, kz1 + "/werte" + OKTOBER + "&version=1"));
        assertThat(alt.get("version").asInt()).isEqualTo(1);
        JsonNode v1 = einziger(alt);
        assertThat(v1.get("wert").asText()).as("die damalige Zahl, nicht die heutige mit Etikett").isEqualTo("0.1488");
        assertThat(v1.get("version").asInt()).isEqualTo(1);
        assertThat(v1.get("versionen").asInt()).isEqualTo(2);
        assertThat(texte(v1.get("kennzeichen"))).containsExactly("berechnet (Kennzahl)");
        assertThat(MAPPER.writeValueAsString(v1.get("herkunft"))).isEqualTo(MAPPER.writeValueAsString(
                herkunft("K1", 0).get("ergebnis")));

        Antwort drei = ruf(w, kz1 + "/werte" + OKTOBER + "&version=3");
        assertThat(drei.status()).isEqualTo(404);
        assertThat(drei.body().get("code").asText()).isEqualTo("version_gibt_es_nicht");
        assertThat(drei.body().get("feld").asText()).isEqualTo("version");
        assertThat(drei.body().get("version").asInt()).isEqualTo(3);
        assertThat(drei.body().get("hoechste_version").asInt()).isEqualTo(2);

        JsonNode h = ok(ruf(w, kz1 + "/werte/versionen?periode=monat&von=2026-10-01"));
        assertThat(felder(h)).containsExactly("kennzahl", "periode", "von", "bis", "zeitzone", "grund", "versionen");
        assertThat(h.get("bis").asText()).isEqualTo("2026-10-31");
        assertThat(h.get("grund").isNull()).isTrue();
        assertThat(h.get("versionen")).hasSize(2);
        JsonNode erste = h.get("versionen").get(0);
        assertThat(erste.get("version").asInt()).isEqualTo(1);
        assertThat(erste.get("wert_alt").isNull()).isTrue();
        assertThat(erste.get("wert_neu").get("wert").asText()).isEqualTo("0.1488");
        assertThat(erste.get("gebildet_am").asText()).isEqualTo("2026-11-01T00:20:00+01:00");
        assertThat(erste.get("nachgezogen_am").isNull()).isTrue();
        assertThat(erste.get("anlass").isNull()).isTrue();
        assertThat(erste.get("entscheidungen")).isEmpty();
        JsonNode zweite = h.get("versionen").get(1);
        assertThat(zweite.get("version").asInt()).isEqualTo(2);
        assertThat(zweite.get("wert_alt").get("wert").asText()).as("was vorher dastand").isEqualTo("0.1488");
        assertThat(zweite.get("wert_neu").get("wert").asText()).isEqualTo("0.1473");
        assertThat(zweite.get("gebildet_am").asText()).isEqualTo("2026-11-12T10:05:33+01:00");
        assertThat(zweite.get("anlass").get("art").asText()).isEqualTo("eingang");
        assertThat(zweite.get("anlass").get("beleg").asText()).isEqualTo("K-2026-0007 (freigegeben 12.11.2026)");
        assertThat(zweite.get("entscheidungen")).hasSize(1);
        JsonNode e = zweite.get("entscheidungen").get(0);
        assertThat(felder(e)).containsExactly("vorgang", "kennung", "fassung", "status", "methode", "art", "wer", "wann",
                "warum", "beleg", "fehlt", "angelegt");
        assertThat(e.get("vorgang").asText()).isEqualTo("korrektur");
        assertThat(e.get("kennung").asText()).isEqualTo("K-2026-0007");
        assertThat(e.get("fassung").asInt()).isEqualTo(2);
        assertThat(e.get("status").asText()).isEqualTo("freigegeben");
        assertThat(e.get("wer").get("name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(e.get("wann").asText()).isEqualTo("2026-11-12T10:05:33+01:00");
        assertThat(e.get("warum").isNull()).as("die Freigabe hat keinen eigenen Grund — keiner wird erfunden").isTrue();
        assertThat(texte(e.get("fehlt"))).containsExactly("warum");
        assertThat(e.get("angelegt").get("warum").asText()).isEqualTo(K7_BEGRUENDUNG);
        assertThat(e.get("angelegt").get("wann").asText()).isEqualTo("2026-11-11T16:40:00+01:00");

        String kz4 = PFAD + "/" + w.kz().get("KZ-0004");
        assertThat(einziger(ok(ruf(w, kz4 + "/werte" + OKTOBER))).get("wert").asText()).isEqualTo("0.2833");
        assertThat(einziger(ok(ruf(w, kz4 + "/werte" + OKTOBER + "&version=1"))).get("wert").asText()).isEqualTo("0.2837");
        JsonNode k6 = ok(ruf(w, kz4 + "/werte/versionen?periode=monat&von=2026-10-01")).get("versionen");
        assertThat(k6).hasSize(2);
        assertThat(k6.get(0).get("wert_neu").get("wert").asText()).isEqualTo("0.2837");
        assertThat(k6.get(1).get("wert_alt").get("wert").asText()).isEqualTo("0.2837");
        assertThat(k6.get(1).get("wert_neu").get("wert").asText()).isEqualTo("0.2833");
        assertThat(k6.get(1).get("anlass").get("beleg").asText())
                .isEqualTo("correction BZ-1 2026-10 Fassung 1 → 2 (I-2026-0003)");
        assertThat(k6.get(1).get("entscheidungen")).isEmpty();
    }

    /** Eine geänderte Berechnung (K17, „wäre der März endgültig gewesen“): wer die Fassung 2 eingetragen hat und warum. */
    @Test
    void eineGeaenderteBerechnungNenntIhreFassung() throws Exception {
        Welt w = welt();
        JsonNode maerz = herkunft("K17", 0).get("eingang");
        ObjectNode v1 = maerz.deepCopy();
        v1.put("definition_fassung", 1);
        zeile(w, v1, "endgueltig", null);
        ObjectNode v2 = maerz.deepCopy();
        v2.put("version", 2);
        v2.put("berechnet_am", "2027-04-02T09:00:00+02:00");
        v2.put("anlass", "Berechnung geändert (Fassung 2)");
        zeile(w, v2, "endgueltig", "definition");

        JsonNode h = ok(ruf(w, PFAD + "/" + w.kz().get("KZ-0004") + "/werte/versionen?periode=monat&von=2027-03-01"));
        JsonNode zweite = h.get("versionen").get(1);
        assertThat(zweite.get("anlass").get("art").asText()).isEqualTo("definition");
        assertThat(zweite.get("wert_alt").get("definition_fassung").asInt()).isEqualTo(1);
        assertThat(zweite.get("wert_neu").get("definition_fassung").asInt()).isEqualTo(2);
        JsonNode e = zweite.get("entscheidungen").get(0);
        assertThat(e.get("vorgang").asText()).isEqualTo("berechnung");
        assertThat(e.get("kennung").asText()).isEqualTo("KZ-0004");
        assertThat(e.get("fassung").asInt()).isEqualTo(2);
        assertThat(e.get("art").asText()).isEqualTo("eintrag");
        assertThat(e.get("wer").get("name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(e.get("warum").asText()).isEqualTo(K17_BEGRUENDUNG);
        assertThat(e.get("fehlt")).isEmpty();
    }

    // ================================================================ Schritte ohne Zahl, ungerundet, Zeit-Periode

    /**
     * Drei Monate von KZ-0001: der Oktober vorläufig gebildet und nachgezogen — ungerundet, wie NUMERIC ihn speichert;
     * der November „keine Werte“ ohne Version (K8, Nenner fehlt — keine Herkunft, die Zeile sagt den Grund); der
     * Dezember ohne Zeile. Das Jahr 2026 der Zusammenfassung (K14) bildet der Lauf über die eigenen Monate — ohne
     * gespeicherte Eingänge ist die Herkunft die ehrliche Antwort der Regel: kein Satz, {@code fehlt} eingaenge.
     */
    @Test
    void ohneZahlSagtJederSchrittWarumUndDieZahlBleibtUngerundet() throws Exception {
        Welt w = welt();
        String ungerundet = "0.14878048780487804878";
        ObjectNode gebildet = herkunft("K1", 0).get("eingang").deepCopy();
        ((ObjectNode) gebildet.get("ergebnis")).put("wert", ungerundet);
        zeile(w, gebildet, "vorlaeufig", null);
        ObjectNode nachgezogen = gebildet.deepCopy();
        nachgezogen.put("berechnet_am", "2026-11-02T00:20:00+01:00");
        zeile(w, nachgezogen, "vorlaeufig", null);
        UUID kz1 = w.kz().get("KZ-0001");
        root.update("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, richtung, grund, zustand, "
                + "endgueltig_ab, definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) VALUES (?, ?, 'monat', "
                + "'2026-11-01', '2026-11-30', 'Europe/Berlin', NULL, NULL, 6300, NULL, 'keine Werte', '[]'::jsonb, 100, "
                + "NULL, 'nenner_fehlt', NULL, NULL, ?, '2026-12-01T00:20:00+01:00', NULL, NULL)", w.mandant(), kz1,
                fassungId(kz1, 1));
        JsonNode jahr = pruefung("K14", "wert", 0).get("ergebnis");
        UUID kz3 = w.kz().get("KZ-0003");
        root.update("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, richtung, grund, zustand, "
                + "endgueltig_ab, definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) VALUES (?, ?, 'jahr', "
                + "'2026-01-01', '2026-12-31', 'Europe/Berlin', 1, ?, ?, ?, ?, ?::jsonb, 100, NULL, NULL, 'vorlaeufig', "
                + "NULL, ?, '2027-01-01T00:40:00+01:00', NULL, NULL)", w.mandant(), kz3, zahl(jahr.get("wert")),
                zahl(jahr.get("zaehler")), zahl(jahr.get("nenner")), jahr.get("zustand").asText(),
                jahr.get("kennzeichen").toString(), fassungId(kz3, 1));

        String werte = PFAD + "/" + kz1 + "/werte?periode=monat&von=2026-10-01&bis=2026-12-31";
        JsonNode antwort = ok(ruf(w, werte));
        assertThat(felder(antwort)).containsExactly("kennzahl", "periode", "von", "bis", "zeitzone", "version", "werte");
        assertThat(felder(antwort.get("kennzahl"))).containsExactly("id", "kennzeichen", "name", "rechenform", "einheit",
                "einheit_anzeige");
        assertThat(antwort.get("kennzahl").get("einheit_anzeige").asText()).isEqualTo("kWh je Stück");
        assertThat(antwort.get("zeitzone").asText()).isEqualTo("Europe/Berlin");
        JsonNode schritte = antwort.get("werte");
        assertThat(schritte).hasSize(3);
        JsonNode okt = schritte.get(0);
        assertThat(felder(okt)).containsExactly("von", "bis", "schluessel", "beschriftung", "wert", "zaehler", "nenner",
                "einheit", "zustand", "richtung", "kennzeichen", "abdeckung_prozent", "fassung", "endgueltig_ab", "version",
                "definition_fassung", "berechnet_am", "grund", "herkunft", "versionen");
        assertThat(okt.get("von").asText()).isEqualTo("2026-10-01");
        assertThat(okt.get("bis").asText()).isEqualTo("2026-10-31");
        assertThat(okt.get("schluessel").asText()).isEqualTo("2026-10");
        assertThat(okt.get("beschriftung").asText()).isEqualTo("Oktober 2026");
        assertThat(okt.get("wert").isTextual()).as("Dezimaltext").isTrue();
        assertThat(okt.get("wert").asText()).as("ungerundet").isEqualTo(ungerundet);
        assertThat(okt.get("zaehler").asText()).isEqualTo("6100");
        assertThat(okt.get("nenner").asText()).isEqualTo("41000");
        assertThat(okt.get("einheit").asText()).isEqualTo("kWh/Stück");
        assertThat(okt.get("zustand").asText()).isEqualTo("vollständig");
        assertThat(okt.get("abdeckung_prozent").asText()).isEqualTo("100");
        assertThat(okt.get("fassung").asText()).isEqualTo("vorlaeufig");
        assertThat(okt.get("endgueltig_ab").isNull()).isTrue();
        assertThat(okt.get("version").asInt()).isEqualTo(1);
        assertThat(okt.get("versionen").asInt()).isEqualTo(1);
        assertThat(okt.get("berechnet_am").asText()).as("die nachgezogene Zeile").isEqualTo("2026-11-02T00:20:00+01:00");
        assertThat(okt.get("herkunft").get("satz").get("ergebnis").get("wert").asText()).isEqualTo(ungerundet);
        assertThat(okt.get("herkunft").get("satz").get("berechnet_am").asText()).isEqualTo("2026-11-02T00:20:00+01:00");
        JsonNode nov = schritte.get(1);
        assertThat(nov.get("zustand").asText()).isEqualTo("keine Werte");
        assertThat(nov.get("wert").isNull()).as("nie 0").isTrue();
        assertThat(nov.get("grund").asText()).isEqualTo("nenner_fehlt");
        assertThat(nov.get("version").isNull()).isTrue();
        assertThat(nov.get("versionen").isNull()).isTrue();
        assertThat(nov.get("herkunft").isNull()).isTrue();
        JsonNode dez = schritte.get(2);
        assertThat(dez.get("zustand").isNull()).isTrue();
        assertThat(dez.get("grund").asText()).isEqualTo("noch_nicht_gebildet");
        assertThat(dez.get("kennzeichen")).isEmpty();
        assertThat(dez.get("herkunft").isNull()).isTrue();
        assertThat(dez.get("beschriftung").asText()).isEqualTo("Dezember 2026");

        JsonNode eins = ok(ruf(w, werte + "&version=1")).get("werte");
        assertThat(eins.get(0).get("version").asInt()).isEqualTo(1);
        assertThat(eins.get(1).get("grund").asText()).isEqualTo("version_nicht_gespeichert");
        assertThat(eins.get(1).get("zustand").isNull()).isTrue();
        assertThat(eins.get(2).get("grund").asText()).isEqualTo("noch_nicht_gebildet");
        Antwort zwei = ruf(w, werte + "&version=2");
        assertThat(zwei.status()).isEqualTo(404);
        assertThat(zwei.body().get("hoechste_version").asInt()).isEqualTo(1);

        JsonNode oktober = ok(ruf(w, PFAD + "/" + kz1 + "/werte/versionen?periode=monat&von=2026-10-01"));
        assertThat(oktober.get("versionen")).hasSize(1);
        assertThat(oktober.get("versionen").get(0).get("gebildet_am").asText()).isEqualTo("2026-11-01T00:20:00+01:00");
        assertThat(oktober.get("versionen").get(0).get("nachgezogen_am").asText()).isEqualTo("2026-11-02T00:20:00+01:00");
        assertThat(oktober.get("versionen").get(0).get("wert_neu").get("wert").asText()).isEqualTo(ungerundet);
        JsonNode november = ok(ruf(w, PFAD + "/" + kz1 + "/werte/versionen?periode=monat&von=2026-11-01"));
        assertThat(november.get("grund").asText()).isEqualTo("nenner_fehlt");
        assertThat(november.get("versionen")).isEmpty();
        JsonNode dezember = ok(ruf(w, PFAD + "/" + kz1 + "/werte/versionen?periode=monat&von=2026-12-01"));
        assertThat(dezember.get("grund").asText()).isEqualTo("noch_nicht_gebildet");

        JsonNode j = einziger(ok(ruf(w, PFAD + "/" + kz3 + "/werte?periode=jahr&von=2026-01-01&bis=2026-12-31")));
        assertThat(j.get("wert").asText()).isEqualTo(jahr.get("wert").asText());
        assertThat(j.get("beschriftung").asText()).isEqualTo("2026");
        assertThat(j.get("herkunft").get("satz").isNull()).isTrue();
        assertThat(texte(j.get("herkunft").get("fehlt"))).containsExactly("eingaenge");
    }

    // ================================================================ Anfrage streng, fremd ist nicht da

    @Test
    void dieAnfrageWirdStrengGelesenUndFremdesIstNichtDa() throws Exception {
        Welt w = welt();
        String p = PFAD + "/" + w.kz().get("KZ-0001") + "/werte";
        ungueltig(w, p, "periode");
        ungueltig(w, p + "?periode=quartal&von=2026-10-01&bis=2026-10-31", "periode");
        ungueltig(w, p + "?periode=monat&bis=2026-10-31", "von");
        ungueltig(w, p + "?periode=monat&von=2026-10-02&bis=2026-10-31", "von");
        ungueltig(w, p + "?periode=monat&von=01.10.2026&bis=2026-10-31", "von");
        ungueltig(w, p + "?periode=woche&von=2026-10-01&bis=2026-10-04", "von");
        ungueltig(w, p + "?periode=monat&von=2026-10-01", "bis");
        ungueltig(w, p + "?periode=monat&von=2026-10-01&bis=2026-10-30", "bis");
        ungueltig(w, p + "?periode=monat&von=2026-11-01&bis=2026-10-31", "bis");
        ungueltig(w, p + "?periode=tag&von=2020-01-01&bis=2026-12-31", "bis");
        ungueltig(w, p + OKTOBER + "&version=0", "version");
        ungueltig(w, p + OKTOBER + "&version=eins", "version");
        ungueltig(w, p + OKTOBER + "&raster=monat", "raster");
        ungueltig(w, p + "/versionen?periode=monat", "von");
        ungueltig(w, p + "/versionen?periode=monat&von=2026-10-01&bis=2026-10-31", "bis");

        JsonNode woche = ok(ruf(w, p + "?periode=woche&von=2026-09-28&bis=2026-10-11"));
        assertThat(woche.get("werte")).hasSize(2);
        assertThat(woche.get("werte").get(0).get("schluessel").asText()).isEqualTo("2026-W40");
        assertThat(woche.get("werte").get(0).get("beschriftung").asText()).isEqualTo("KW 40/2026");
        assertThat(woche.get("werte").get(1).get("bis").asText()).isEqualTo("2026-10-11");

        nichtDa(ruf(w, PFAD + "/" + UUID.randomUUID() + "/werte" + OKTOBER));
        nichtDa(ruf(w, PFAD + "/keine-id/werte" + OKTOBER));
        nichtDa(ruf(w, PFAD + "/" + UUID.randomUUID() + "/werte/versionen?periode=monat&von=2026-10-01"));
        Welt fremd = welt();
        nichtDa(ruf(fremd, p + OKTOBER));
        nichtDa(ruf(fremd, p + "/versionen?periode=monat&von=2026-10-01"));
    }

    // ================================================================ Gerüst

    private static final String K17_BEGRUENDUNG = "Kühlung gehört ab März zum Spritzguss: Zähler MS-24 statt MS-20";

    /** Ein Kundenbereich mit den Kennzahlen der Herkunfts-Fälle — angelegt über den Schreibweg, jede mit ihrer Einheit. */
    // ================================================================ Summen-Wächter des geteilten Punkts

    /**
     * AP-07 IP-18b Summen-Wächter an der Zusammenfassung: KZ-0003 fasst KZ-0001 (MS-12) und KZ-0002 (MS-18) zusammen.
     * Lesen MS-12 und MS-18 denselben Kanal DERSELBEN Box über zwei Komponenten (geteilter Punkt), zählt Σ ihn zweimal,
     * sobald die Box je Komponente sendet. Die Werte-Antwort benennt es neben den Werten und ändert keinen; ohne Fund
     * (zwei Boxen) und an einem Quotienten (keine Summe) fehlt das Feld.
     */
    @Test
    void zusammenfassungBenenntZweiMessstellenAmSelbenRegisterEinerBox() throws Exception {
        Welt w = welt();
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Werk Ahrenberg', ?) "
                + "RETURNING id", UUID.class, w.mandant(), Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        UUID box12 = quelle(w, site, "MS-12");
        UUID box18 = quelle(w, site, "MS-18");
        String pfad = PFAD + "/" + w.kz().get("KZ-0003") + "/werte?periode=jahr&von=2026-01-01&bis=2026-12-31";
        JsonNode vorher = ok(ruf(w, pfad));
        assertThat(vorher.has("geteilte_register")).as("zwei Boxen: kein Fund, kein Feld").isFalse();

        root.update("UPDATE device_measurement_selection SET device_id = ? WHERE device_id = ?", box12, box18);
        JsonNode nachher = ok(ruf(w, pfad));
        assertThat(nachher.get("geteilte_register")).hasSize(1);
        JsonNode fund = nachher.get("geteilte_register").get(0);
        assertThat(fund.get("rolle").asText()).isEqualTo("zaehler");
        assertThat(fund.get("register").asText()).isEqualTo(ENERGIE);
        assertThat(fund.get("messstellen")).extracting(JsonNode::asText).containsExactly("MS-12", "MS-18");
        assertThat(nachher.get("werte")).as("benennen, nicht rechnen").isEqualTo(vorher.get("werte"));
        JsonNode quotient = ok(ruf(w, PFAD + "/" + w.kz().get("KZ-0001")
                + "/werte?periode=monat&von=2026-10-01&bis=2026-10-31"));
        assertThat(quotient.has("geteilte_register")).as("ein Quotient hat keine Summe").isFalse();
    }

    private static final String ENERGIE = "sunspec.model_203.totwhimp";

    /** Box, Komponente, Auswahlzeile und führende Quelle der Hauptgröße (Wirkenergie Bezug) einer Messstelle. */
    private static UUID quelle(Welt w, UUID site, String kennzeichen) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, site, "VP-KZ-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, site,
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), '2026.09.11.1', 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, site, box, komponente, ENERGIE);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID ms = root.queryForObject("SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = ?", UUID.class, t,
                kennzeichen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, ms, komponente, geraet, ENERGIE, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                Timestamp.from(Instant.parse("2020-01-01T00:01:00Z")));
        return box;
    }

    private Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Kennzahl-Werte #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        UUID g2 = gebaeude(t, st1, "Halle 2", "G-2");
        UUID g5 = gebaeude(t, st2, "Montagehalle Lindach", "G-5");
        for (String ms : List.of("MS-08", "MS-10", "MS-12", "MS-14", "MS-19", "MS-20", "MS-23", "MS-24")) {
            messstelle(t, ms, g2);
        }
        messstelle(t, "MS-18", g5);
        bezugsgroesse(t, "BZ-6", "Stück", g2);
        bezugsgroesse(t, "BZ-7", "Stück", g5);
        bezugsgroesse(t, "BZ-1", "kg", g2);
        bezugsgroesse(t, "BZ-2", "Stück", g2);
        bezugsgroesse(t, "BZ-4", "m²", g2);
        bezugsgroesse(t, "BZ-5", "h", g2);
        bezugsgroesse(t, "BZ-8", "Personen", g2);
        Welt w = new Welt(t, u, g2, g5, new LinkedHashMap<>());
        w.kz().put("KZ-0001", anlegen(w, "KZ-0001", "quotient", "gebaeude", g2, e("zaehler", "messstelle", "MS-12"),
                e("nenner", "bezugsgroesse", "BZ-6")));
        w.kz().put("KZ-0002", anlegen(w, "KZ-0002", "quotient", "gebaeude", g5, e("zaehler", "messstelle", "MS-18"),
                e("nenner", "bezugsgroesse", "BZ-7")));
        w.kz().put("KZ-0003", anlegen(w, "KZ-0003", "zusammenfassung", "unternehmen", u, e("paar", "kennzahl", "KZ-0001"),
                e("paar", "kennzahl", "KZ-0002")));
        w.kz().put("KZ-0004", quotient(w, "KZ-0004", "MS-20", "BZ-1"));
        w.kz().put("KZ-0005", quotient(w, "KZ-0005", "MS-10", "BZ-4"));
        w.kz().put("KZ-0006", quotient(w, "KZ-0006", "MS-23", "BZ-2"));
        w.kz().put("KZ-0007", quotient(w, "KZ-0007", "MS-19", "BZ-8"));
        w.kz().put("KZ-0008", quotient(w, "KZ-0008", "MS-14", "BZ-5"));
        w.kz().put("KZ-0009", anlegen(w, "KZ-0009", "anteil", "gebaeude", g2, e("zaehler", "messstelle", "MS-20"),
                e("nenner", "messstelle", "MS-19")));
        w.kz().put("KZ-0014", quotient(w, "KZ-0014", "MS-08", "BZ-1"));
        Map<String, Object> fassung2 = new LinkedHashMap<>();
        fassung2.put("gueltig_ab", "2027-03-01");
        fassung2.put("begruendung", K17_BEGRUENDUNG);
        fassung2.put("eingaenge", List.of(e("zaehler", "messstelle", "MS-24"), e("nenner", "bezugsgroesse", "BZ-1")));
        Antwort f = ruf(w, HttpMethod.POST, PFAD + "/" + w.kz().get("KZ-0004") + "/fassungen", fassung2);
        assertThat(f.status()).as(f.body().toString()).isEqualTo(200);
        return w;
    }

    /**
     * Eine Zeile, wie der Rechenlauf bzw. die Kaskade sie schreibt: Periode, Fassung, Zeitpunkt, Version, Anlass und
     * Ergebnis aus dem Herkunfts-Eingang {@code h}, Zähler und Nenner aus seinen Eingängen, dazu jeder Eingang.
     */
    private static void zeile(Welt w, JsonNode h, String zustand, String anlassArt) {
        UUID kennzahl = w.kz().get(h.get("kennzahl").asText());
        LocalDate[] p = spanne(h);
        int version = h.get("version").asInt();
        JsonNode erg = h.get("ergebnis");
        List<JsonNode> eingaenge = new ArrayList<>();
        h.get("eingaenge").forEach(eingaenge::add);
        BigDecimal zaehler = null;
        BigDecimal nenner = null;
        if ("zusammenfassung".equals(h.get("rechenform").asText())) {
            zaehler = BigDecimal.ZERO;
            nenner = BigDecimal.ZERO;
            for (JsonNode e : eingaenge) {
                zaehler = zaehler.add(zahl(e.get("zaehler")));
                nenner = nenner.add(zahl(e.get("nenner")));
            }
        } else {
            for (JsonNode e : eingaenge) {
                if ("zaehler".equals(e.get("rolle").asText())) {
                    zaehler = zahl(e.get("wert"));
                } else {
                    nenner = zahl(e.get("wert"));
                }
            }
        }
        Timestamp am = Timestamp.from(OffsetDateTime.parse(h.get("berechnet_am").asText()).toInstant());
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, richtung, grund, zustand, "
                + "endgueltig_ab, definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) VALUES (?, ?, ?, ?, ?, ?, "
                + "'Europe/Berlin', ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?)", wert, w.mandant(), kennzahl,
                h.get("periode").get("art").asText(), Date.valueOf(p[0]), Date.valueOf(p[1]), version,
                zahl(erg.get("wert")), zaehler, nenner, erg.get("zustand").asText(), erg.get("kennzeichen").toString(),
                zahl(erg.get("abdeckung_prozent")), text(erg.get("richtung")), text(erg.get("grund")), zustand,
                "endgueltig".equals(zustand) ? am : null, fassungId(kennzahl, h.get("definition_fassung").asInt()), am,
                anlassArt, text(h.get("anlass")));
        for (int i = 0; i < eingaenge.size(); i++) {
            JsonNode e = eingaenge.get(i);
            String art = e.get("art").asText();
            String objekt = e.get("objekt").asText();
            root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                    + "messstelle_id, bezugsgroesse_id, eingang_kennzahl_id, wert, zaehler, nenner, einheit, menge_zustand, "
                    + "abdeckung_prozent, version, fassung, kennzeichen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                    + "?, ?, ?, ?::jsonb)", w.mandant(), wert, kennzahl, i, e.get("rolle").asText(), art, objekt,
                    "messstelle".equals(art) ? objektId(w, "messstelle", objekt, "MS-12") : null,
                    "bezugsgroesse".equals(art) ? objektId(w, "bezugsgroesse", objekt, "BZ-6") : null,
                    "kennzahl".equals(art) ? w.kz().get(objekt) : null, zahl(e.get("wert")), zahl(e.get("zaehler")),
                    zahl(e.get("nenner")), e.get("einheit").asText(), e.get("zustand").asText(),
                    zahl(e.get("abdeckung_prozent")), e.get("version").isNull() ? null : e.get("version").asInt(),
                    e.get("fassung").isNull() ? null : e.get("fassung").asInt(), e.get("kennzeichen").toString());
        }
    }

    /** K6 „ohne Anlass“: eine Version ab 2 ohne Anlass lehnt die Tabelle ab — und schreibt nichts. */
    private static void halbeHerkunftWirdNichtGespeichert(Welt w, JsonNode h) {
        UUID kennzahl = w.kz().get(h.get("kennzahl").asText());
        Integer vorher = root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE kennzahl_id = ?", Integer.class,
                kennzahl);
        ObjectNode ohneAnlass = h.deepCopy();
        ohneAnlass.put("version", 3);
        ohneAnlass.put("berechnet_am", "2026-11-30T12:00:00+01:00");
        assertThatThrownBy(() -> zeile(w, ohneAnlass, "endgueltig", null)).isInstanceOf(DataAccessException.class);
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE kennzahl_id = ?", Integer.class, kennzahl))
                .isEqualTo(vorher);
    }

    /**
     * K-2026-0007 wie in der Referenzdatei 1.4: vorgeschlagen von Ines Kaltenbach am 11.11.2026 16:40 mit ihrer
     * Begründung, freigegeben von ihr am 12.11.2026 10:05:33 — die Freigabe ohne eigenen Grund.
     */
    private static void korrekturK7(Welt w, String begruendung) {
        String reihen = MAPPER.createArrayNode().add(MAPPER.createObjectNode()
                .put("entity_id", UUID.randomUUID().toString()).put("messkanal", "ms-12.energie")).toString();
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, "
                + "'K-2026-0007', 1, 'vorschlag', 'nachlieferung_nach_endgueltigkeit', ?::jsonb, "
                + "'2026-10-01T00:00:00+02:00', '2026-11-01T00:00:00+01:00', ?, '[{}]'::jsonb, 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-11-11T16:40:00+01:00')", w.mandant(), reihen,
                begruendung);
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art, created_at) VALUES (?, 'K-2026-0007', 2, 'freigegeben', NULL, "
                + "'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-11-12T10:05:33+01:00')",
                w.mandant());
    }

    private static JsonNode herkunft(String fall, int n) {
        return pruefung(fall, "herkunft", n);
    }

    /** Der Eingang der n-ten Herkunfts-Prüfung eines Falls — der Satz, den die Zeile beim Bilden las. */
    private static JsonNode eingang(String fall, int n) {
        return herkunft(fall, n).get("eingang");
    }

    private static JsonNode pruefung(String fall, String regel, int n) {
        int i = 0;
        for (JsonNode c : vertrag.get("cases")) {
            if (!c.get("id").asText().equals(fall)) {
                continue;
            }
            for (JsonNode p : c.get("pruefungen")) {
                if (regel.equals(p.get("regel").asText()) && i++ == n) {
                    return p;
                }
            }
        }
        throw new AssertionError(fall + " hat keine " + (n + 1) + ". Prüfung der Regel " + regel);
    }

    private static LocalDate[] spanne(JsonNode h) {
        return BezugsPeriode.spanneVon(h.get("periode").get("schluessel").asText(), h.get("periode").get("art").asText());
    }

    private static UUID fassungId(UUID kennzahl, int nummer) {
        return root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = ?", UUID.class,
                kennzahl, nummer);
    }

    private static UUID objektId(Welt w, String tabelle, String kennzeichen, String sonst) {
        List<UUID> ids = root.queryForList("SELECT id FROM " + tabelle + " WHERE tenant_id = ? AND kennzeichen = ?",
                UUID.class, w.mandant(), kennzeichen);
        return ids.isEmpty() ? objektId(w, tabelle, sonst, sonst) : ids.get(0);
    }

    private UUID quotient(Welt w, String kennzeichen, String zaehler, String nenner) throws Exception {
        return anlegen(w, kennzeichen, "quotient", "gebaeude", w.g2(), e("zaehler", "messstelle", zaehler),
                e("nenner", "bezugsgroesse", nenner));
    }

    @SafeVarargs
    private UUID anlegen(Welt w, String kennzeichen, String rechenform, String geltungArt, UUID geltung,
            Map<String, Object>... eingaenge) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", kennzeichen + " " + rechenform);
        m.put("rechenform", rechenform);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        m.put("eingaenge", List.of(eingaenge));
        Antwort a = ruf(w, HttpMethod.POST, PFAD, m);
        assertThat(a.status()).as(kennzeichen + " " + a.body()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
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

    private static void messstelle(UUID t, String kennzeichen, UUID ort) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') "
                + "RETURNING id", UUID.class, t, kennzeichen, "Messstelle " + kennzeichen);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, ms, ort);
    }

    private static void bezugsgroesse(UUID t, String kennzeichen, String einheit, UUID ort) {
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, ?, ?, 'periodenwert', ?, 'monat', 'gebaeude', ?)", t, kennzeichen,
                "Bezugsgröße " + kennzeichen, einheit, ort);
    }

    private Antwort ruf(Welt w, String pfad) throws Exception {
        return ruf(w, HttpMethod.GET, pfad, null);
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    private static JsonNode einziger(JsonNode werte) {
        assertThat(werte.get("werte")).as(werte.toString()).hasSize(1);
        return werte.get("werte").get(0);
    }

    private void ungueltig(Welt w, String pfad, String feld) throws Exception {
        Antwort a = ruf(w, pfad);
        assertThat(a.status()).as(pfad + " " + a.body()).isEqualTo(400);
        assertThat(a.body().get("code").asText()).as(pfad).isEqualTo("anfrage_ungueltig");
        assertThat(a.body().get("feld").asText()).as(pfad).isEqualTo(feld);
        assertThat(a.body().get("message").asText()).isEqualTo(KennzahlAbgelehnt.Ablehnung.ANFRAGE_UNGUELTIG.satz());
    }

    private static void nichtDa(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(404);
        assertThat(a.body().get("code").asText()).isEqualTo("nicht_gefunden");
    }

    private static BigDecimal zahl(JsonNode n) {
        return n == null || n.isNull() ? null : new BigDecimal(n.asText());
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }
}
