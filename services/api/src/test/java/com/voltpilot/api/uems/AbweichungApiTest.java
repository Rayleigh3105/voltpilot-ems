package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
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
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
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
 * Routen von Auffälligkeit und Abweichung (UEMS AP-18 IP-16, A2–A6, U1–U3, RE1–RE3) gegen eine echte Datenbank — mit
 * R1, R2, R8 und R11 der Referenzdatei 1.9 ({@code auffaelligkeiten[]}, {@code abweichungen[]}): KZ-0004 Spritzguss
 * (MS-20 ÷ BZ-1) mit BB-0001 Fassung 1 (Verhältnis, vorläufig, 11/2026–10/2027) und Fassung 2 (Modell, ab 11/2027).
 * Die Vermerke schreibt hier der Test (die Naht ist IP-15) — mit dem Anlass der Referenzdatei, byte-gleich kanonisch.
 * R8 (in der Referenz KZ-0005 × BB-0003 Fassung 1) steht an KZ-0004 × Fassung 1: dieselbe vorläufige Lage, derselbe
 * Anlass mit dem Anker dieser Welt.
 *
 * <p>Personen: Ines Kaltenbach und Jonas Wendlinger nie zugewiesen (Kundenadministrator), Peter Hollerbach Bearbeiter
 * an ST-1, Rita Stein Bearbeiterin an ST-2, Murat Demirci Bedienberechtigter an ST-1, Olga Alt mit beendetem Konto.
 * Die Uhr der Kennzahlen ist gestellt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AbweichungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/abweichungen";
    /** R1: Antwort am 12.01.2028; R2: Aussage am 14.01., Abschluss am 15.01.2028. */
    private static final Instant ANTWORT = Instant.parse("2028-01-12T09:00:00Z");
    private static final Instant ANGELEGT = Instant.parse("2028-01-15T09:00:00Z");
    private static final JsonNode RU = referenz();

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

    @Autowired
    KennzahlService kennzahlen;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID st1, UUID st2, UUID kz4, UUID bz1) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void uhrAmAntworttag() {
        uhr(ANTWORT);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    /**
     * R1: der Vermerk Dezember 2027 (Fassung 2) wird am 12.01.2028 mit „Abweichung eröffnen“ beantwortet — AW-2028-0001,
     * Frist 31.01.2028, Ines verantwortlich; der Anlass ist die Kopie des Vermerks, byte-gleich mit derselben Prüfsumme
     * wie in der Referenzdatei. Ein offener Vermerk der Fassung 1 bleibt offen (eine Abweichung zitiert eine Fassung);
     * die zweite Antwort ist 409.
     */
    @Test
    void r1AntwortEroeffnetAbweichung() throws Exception {
        Welt w = welt();
        JsonNode r1 = vermerkAus("KZ-0004", "2027-12");
        UUID dezember = vermerk(w, 2, "2027-12", r1.get("anlass"), "2028-01-07T04:12:00Z");
        UUID fremdeFassung = vermerk(w, 1, "2026-11", r1.get("anlass"), "2026-12-07T05:00:00Z");
        String pfad = "/api/v1/kennzahlen/" + w.kz4() + "/auffaelligkeiten";

        Antwort liste = ruf(w, "ines", HttpMethod.GET, pfad, null);
        assertThat(liste.status()).as(liste.text()).isEqualTo(200);
        assertThat(liste.body().get("offen").asInt()).isEqualTo(2);
        assertThat(liste.body().at("/kennzahl/kennzeichen").asText()).isEqualTo("KZ-0004");

        Antwort a = ruf(w, "ines", HttpMethod.POST, pfad + "/" + dezember + "/antwort", Map.of("antwort", "abweichung",
                "frist", "2028-01-31", "verantwortlich", sub(w, "ines")));
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        JsonNode aw = a.body().get("abweichung");
        assertThat(aw.get("kennzeichen").asText()).isEqualTo("AW-2028-0001");
        assertThat(aw.get("zustand").asText()).isEqualTo("offen");
        assertThat(aw.at("/herkunft/art").asText()).isEqualTo("auffaelligkeit");
        assertThat(aw.get("monate")).hasSize(1);
        assertThat(aw.at("/monate/0").asText()).isEqualTo("2027-12");
        assertThat(aw.get("fassung").asInt()).isEqualTo(2);
        assertThat(aw.at("/frist/termin").asText()).isEqualTo("2028-01-31");
        assertThat(aw.get("eroeffnet_am").asText()).isEqualTo("2028-01-12");
        assertThat(aw.at("/verantwortlich/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(aw.get("standort_id").asText()).isEqualTo(w.st1().toString());
        assertThat(aw.get("anlass").asText()).isEqualTo(BerichtRegeln.kanonisch(r1.get("anlass")));
        assertThat(aw.get("anlass_pruefsumme").asText()).isEqualTo(r1.get("pruefsumme").asText());
        assertThat(aw.get("vorbehalte")).isEmpty();
        assertThat(aw.get("kopf_satz").asText()).isEqualTo("Abweichung AW-2028-0001 · KZ-0004 Stromeinsatz Spritzguss "
                + "je kg, Dezember 2027: 12,9 % mehr als die Bezugsbasis erwarten lässt · Verantwortlich Ines Kaltenbach · "
                + "Frist 31.01.2028 · offen.");
        assertThat(aw.get("vermerke")).hasSize(1);
        assertThat(aw.at("/verlauf/0/art").asText()).isEqualTo("abweichung_eroeffnet");
        JsonNode v = a.body().get("vermerk");
        assertThat(v.get("zustand").asText()).isEqualTo("beantwortet");
        assertThat(v.get("antwort").asText()).isEqualTo("abweichung");
        assertThat(v.at("/abweichung/kennzeichen").asText()).isEqualTo("AW-2028-0001");
        assertThat(v.get("beantwortet_von").asText()).isEqualTo("Ines Kaltenbach");

        Antwort zweite = ruf(w, "ines", HttpMethod.POST, pfad + "/" + dezember + "/antwort", Map.of("antwort",
                "zur_kenntnis", "begruendung", "Doch nur zur Kenntnis genommen."));
        assertThat(zweite.status()).as(zweite.text()).isEqualTo(409);
        assertThat(zweite.body().get("code").asText()).isEqualTo("auffaelligkeit_beantwortet");
        Antwort nachher = ruf(w, "ines", HttpMethod.GET, pfad + "?zustand=offen", null);
        assertThat(nachher.body().get("offen").asInt()).isEqualTo(1);
        assertThat(nachher.body().at("/vermerke/0/id").asText()).isEqualTo(fremdeFassung.toString());
        assertThat(ruf(w, "ines", HttpMethod.GET, pfad + "?farbe=rot", null).status()).isEqualTo(400);
        // A5: keine Antwort ändert eine Zahl.
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE kennzahl_id = ?", Integer.class,
                w.kz4())).isEqualTo(1);
    }

    /** A2: alle offenen Vermerke derselben Kennzahl × Fassung gehen in EINE Abweichung; ohne Frist Eröffnungstag + 30. */
    @Test
    void alleOffenenVermerkeGehenHinein() throws Exception {
        Welt w = welt();
        JsonNode anlass = vermerkAus("KZ-0004", "2027-12").get("anlass");
        UUID november = vermerk(w, 2, "2027-11", anlass, "2027-12-07T05:00:00Z");
        UUID dezember = vermerk(w, 2, "2027-12", anlass, "2028-01-07T04:12:00Z");
        Antwort a = ruf(w, "peter", HttpMethod.POST, "/api/v1/kennzahlen/" + w.kz4() + "/auffaelligkeiten/" + dezember
                + "/antwort", Map.of("antwort", "abweichung", "verantwortlich", sub(w, "peter")));
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        JsonNode aw = a.body().get("abweichung");
        assertThat(aw.get("monate").toString()).isEqualTo("[\"2027-11\",\"2027-12\"]");
        assertThat(aw.at("/frist/termin").asText()).isEqualTo("2028-02-11");
        assertThat(aw.at("/anlass_inhalt/vermerke")).hasSize(2);
        assertThat(aw.get("kopf_satz").isNull()).isTrue();
        assertThat(aw.get("vermerke")).hasSize(2);
        assertThat(root.queryForObject("SELECT abweichung_id FROM auffaelligkeit WHERE id = ?", UUID.class, november)
                .toString()).isEqualTo(aw.get("id").asText());
    }

    /**
     * R2: AW-2028-0001 mit drei Einträgen — Kommentar (Ines), Ursache-Aussage von Murat Demirci (Bedienberechtigter,
     * ohne Schreibrecht), eingetragen von Ines am 14.01.2028, Kommentar; Abschluss am 15.01.2028 mit Ergebnis
     * {@code massnahme} und Verweis auf M-2028-0001 — ohne Verweis 422, als Bearbeiter 403, ein zweites Mal 409.
     */
    @Test
    void r2UntersuchungUndAbschlussMassnahme() throws Exception {
        Welt w = welt();
        JsonNode r2 = referenzAbweichung("AW-2028-0001");
        UUID dezember = vermerk(w, 2, "2027-12", vermerkAus("KZ-0004", "2027-12").get("anlass"), "2028-01-07T04:12:00Z");
        Antwort er = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen/" + w.kz4() + "/auffaelligkeiten/" + dezember
                + "/antwort", Map.of("antwort", "abweichung", "frist", r2.get("frist").asText(), "verantwortlich",
                sub(w, "ines")));
        assertThat(er.status()).as(er.text()).isEqualTo(201);
        String id = er.body().at("/abweichung/id").asText();
        String eintraege = PFAD + "/" + id + "/eintraege";
        JsonNode e = r2.get("verlauf");

        Antwort k1 = ruf(w, "ines", HttpMethod.POST, eintraege, Map.of("text", e.get(1).get("text").asText()));
        assertThat(k1.status()).as(k1.text()).isEqualTo(201);
        uhr(Instant.parse("2028-01-14T10:00:00Z"));
        Map<String, Object> aussage = new LinkedHashMap<>();
        aussage.put("art", "ursache_aussage");
        aussage.put("wortlaut", e.get(2).get("wortlaut").asText());
        aussage.put("aussage_sub", sub(w, "murat"));
        aussage.put("aussage_am", "2028-01-14");
        Antwort u = ruf(w, "ines", HttpMethod.POST, eintraege, aussage);
        assertThat(u.status()).as(u.text()).isEqualTo(201);
        JsonNode zeile = u.body().at("/verlauf/2");
        assertThat(zeile.get("art").asText()).isEqualTo("ursache_aussage");
        assertThat(zeile.get("person").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(zeile.at("/aussage/name").asText()).isEqualTo("Murat Demirci");
        assertThat(zeile.at("/aussage/sub").asText()).isEqualTo(sub(w, "murat"));
        assertThat(zeile.at("/aussage/kennzeichen").asText()).isEqualTo(e.get(2).get("kennzeichen").asText());
        assertThat(zeile.at("/aussage/satz").asText()).isEqualTo("Ursache — Aussage von Murat Demirci, 14.01.2028 "
                + "(keine Messung): ‚Die Werkzeugheizungen der Maschinen 3 bis 6 liefen vom 23.12. bis 02.01. durch — "
                + "keine Abschaltung in der Betriebspause programmiert.‘");
        // Murat selbst hat kein Schreibrecht (RE3): 403.
        Antwort bd = ruf(w, "murat", HttpMethod.POST, eintraege, aussage);
        assertThat(bd.status()).as(bd.text()).isEqualTo(403);
        assertThat(bd.body().get("code").asText()).isEqualTo("recht_fehlt");

        uhr(ANGELEGT);
        Antwort k2 = ruf(w, "ines", HttpMethod.POST, eintraege, Map.of("art", "kommentar", "text",
                e.get(3).get("text").asText()));
        assertThat(k2.status()).as(k2.text()).isEqualTo(201);
        Antwort m = ruf(w, "ines", HttpMethod.POST, "/api/v1/massnahmen", massnahme(w));
        assertThat(m.status()).as(m.text()).isEqualTo(201);
        assertThat(m.body().get("kennzeichen").asText()).isEqualTo("M-2028-0001");

        String begruendung = r2.at("/abschluss/begruendung").asText();
        String abschluss = PFAD + "/" + id + "/abschliessen";
        Antwort ohne = ruf(w, "ines", HttpMethod.POST, abschluss, Map.of("ergebnis", "massnahme", "begruendung",
                begruendung));
        assertThat(ohne.status()).as(ohne.text()).isEqualTo(422);
        assertThat(ohne.body().get("code").asText()).isEqualTo("massnahme_fehlt");
        Map<String, Object> ab = Map.of("ergebnis", "massnahme", "begruendung", begruendung, "massnahme",
                m.body().get("id").asText());
        Antwort be = ruf(w, "peter", HttpMethod.POST, abschluss, ab);
        assertThat(be.status()).as(be.text()).isEqualTo(403);
        assertThat(be.body().get("code").asText()).isEqualTo("recht_fehlt");
        Antwort ok = ruf(w, "ines", HttpMethod.POST, abschluss, ab);
        assertThat(ok.status()).as(ok.text()).isEqualTo(200);
        JsonNode aw = ok.body();
        assertThat(aw.get("zustand").asText()).isEqualTo("abgeschlossen");
        assertThat(aw.at("/abschluss/ergebnis").asText()).isEqualTo("massnahme");
        assertThat(aw.at("/abschluss/massnahme/kennzeichen").asText()).isEqualTo("M-2028-0001");
        assertThat(aw.at("/abschluss/am").asText()).isEqualTo("2028-01-15");
        assertThat(aw.at("/abschluss/satz").asText()).isEqualTo("Abgeschlossen am 15.01.2028 von Ines Kaltenbach: "
                + "Maßnahme M-2028-0001 — ‚" + begruendung + "‘");
        List<String> arten = new java.util.ArrayList<>();
        aw.get("verlauf").forEach(z -> arten.add(z.get("art").asText()));
        assertThat(arten).containsExactly("abweichung_eroeffnet", "kommentar", "ursache_aussage", "kommentar",
                "abweichung_abgeschlossen");

        Antwort zweiter = ruf(w, "ines", HttpMethod.POST, abschluss, Map.of("ergebnis", "erklaert", "begruendung",
                "Doch nur erklärt, zweiter Versuch."));
        assertThat(zweiter.status()).as(zweiter.text()).isEqualTo(409);
        assertThat(zweiter.body().get("code").asText()).isEqualTo("abweichung_abgeschlossen");
        assertThat(ruf(w, "ines", HttpMethod.POST, eintraege, Map.of("text", "Nachtrag")).status()).isEqualTo(409);
    }

    /**
     * R8: Vermerk November 2026 an der vorläufigen Fassung 1; Abweichung AW-2026-0001 mit Jonas als Verantwortlichem,
     * Ursache-Aussage von Jonas, Abschluss „erklärt“ mit Begründung — der Vorbehalt „vorläufig“ ist in Vermerk und
     * Abweichung geerbt, vor und nach dem Abschluss.
     */
    @Test
    void r8ErklaertMitGeerbtemVorbehalt() throws Exception {
        Welt w = welt();
        JsonNode r8 = referenzAbweichung("AW-2026-0001");
        ObjectNode anlass = ((ObjectNode) r8.get("anlass").deepCopy());
        anlass.put("kennzahl", "KZ-0004");
        anlass.put("bezugsbasis", "BB-0001");
        uhr(Instant.parse("2026-12-09T09:00:00Z"));
        UUID november = vermerk(w, 1, "2026-11", anlass, "2026-12-07T05:00:00Z");
        String pfad = "/api/v1/kennzahlen/" + w.kz4() + "/auffaelligkeiten";
        String vorbehalt = "Bezugsbasis vorläufig (1 von 12 Monaten)";
        assertThat(ruf(w, "ines", HttpMethod.GET, pfad, null).body().at("/vermerke/0/vorbehalte/0").asText())
                .isEqualTo(vorbehalt);
        Antwort a = ruf(w, "ines", HttpMethod.POST, pfad + "/" + november + "/antwort", Map.of("antwort", "abweichung",
                "frist", r8.get("frist").asText(), "verantwortlich", sub(w, "jonas")));
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        JsonNode aw = a.body().get("abweichung");
        assertThat(aw.get("kennzeichen").asText()).isEqualTo("AW-2026-0001");
        assertThat(aw.get("fassung").asInt()).isEqualTo(1);
        assertThat(aw.get("vorbehalte").toString()).isEqualTo("[\"" + vorbehalt + "\"]");
        String id = aw.get("id").asText();

        uhr(Instant.parse("2026-12-10T09:00:00Z"));
        JsonNode aussage = r8.at("/verlauf/1");
        Antwort u = ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + id + "/eintraege", Map.of("art", "ursache_aussage",
                "wortlaut", aussage.get("wortlaut").asText(), "aussage_sub", sub(w, "jonas"), "aussage_am",
                "2026-12-10"));
        assertThat(u.status()).as(u.text()).isEqualTo(201);
        assertThat(u.body().at("/verlauf/1/aussage/kennzeichen").asText())
                .isEqualTo(aussage.get("kennzeichen").asText());

        uhr(Instant.parse("2026-12-20T09:00:00Z"));
        String begruendung = "Baustellenstrom des Anbaus über MS-10 (Aussage JW); keine Maßnahme am Gebäude.";
        Antwort ok = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/abschliessen", Map.of("ergebnis", "erklaert",
                "begruendung", begruendung));
        assertThat(ok.status()).as(ok.text()).isEqualTo(200);
        assertThat(ok.body().at("/abschluss/ergebnis").asText()).isEqualTo("erklaert");
        assertThat(ok.body().at("/abschluss/massnahme").isNull()).isTrue();
        assertThat(ok.body().at("/abschluss/satz").asText()).isEqualTo("Abgeschlossen am 20.12.2026 von Ines "
                + "Kaltenbach: erklärt — ‚Baustellenstrom des Anbaus über MS-10 (Aussage JW); keine Maßnahme am "
                + "Gebäude.‘");
        assertThat(ok.body().get("vorbehalte").toString()).isEqualTo("[\"" + vorbehalt + "\"]");
        assertThat(ok.body().at("/vermerke/0/vorbehalte/0").asText()).isEqualTo(vorbehalt);
        // Erklärt verweist nie auf eine Maßnahme.
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body().at("/abschluss/ergebnis").asText())
                .isEqualTo("erklaert");
    }

    /** R11: „zur Kenntnis“ ohne Begründung 422, mit Frist 400, mit Begründung 200 — keine Abweichung, der Satz aus §5.9. */
    @Test
    void r11ZurKenntnisNurMitBegruendung() throws Exception {
        Welt w = welt();
        uhr(Instant.parse("2028-08-10T09:00:00Z"));
        UUID juli = vermerk(w, 2, "2028-07", vermerkAus("KZ-0004", "2028-07").get("anlass"), "2028-08-07T05:00:00Z");
        String pfad = "/api/v1/kennzahlen/" + w.kz4() + "/auffaelligkeiten/" + juli + "/antwort";
        Antwort ohne = ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "zur_kenntnis"));
        assertThat(ohne.status()).as(ohne.text()).isEqualTo(422);
        assertThat(ohne.body().get("code").asText()).isEqualTo("begruendung_fehlt");
        assertThat(ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "zur_kenntnis", "begruendung", "zu kurz"))
                .status()).isEqualTo(422);
        String begruendung = "Kleinserien-Sonderauftrag KW 27–29, im Produktionsplan dokumentiert; keine Abweichung "
                + "des Prozesses.";
        assertThat(ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "zur_kenntnis", "begruendung", begruendung,
                "frist", "2028-09-01")).status()).isEqualTo(400);
        assertThat(ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "vielleicht")).status()).isEqualTo(400);
        Antwort ok = ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "zur_kenntnis", "begruendung", begruendung));
        assertThat(ok.status()).as(ok.text()).isEqualTo(200);
        assertThat(ok.body().get("abweichung").isNull()).isTrue();
        JsonNode v = ok.body().get("vermerk");
        assertThat(v.get("zustand").asText()).isEqualTo("beantwortet");
        assertThat(v.get("antwort_begruendung").asText()).isEqualTo(begruendung);
        assertThat(v.get("satz").asText()).isEqualTo("Auffälligkeit Juli 2028: 2,5 % mehr als die Bezugsbasis erwarten "
                + "lässt (schlechter, Band ± 2 %) — zur Kenntnis genommen von Ines Kaltenbach am 10.08.2028: "
                + "‚Kleinserien-Sonderauftrag KW 27–29, im Produktionsplan dokumentiert; keine Abweichung des "
                + "Prozesses.‘");
        assertThat(ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "zur_kenntnis", "begruendung", begruendung))
                .status()).isEqualTo(409);
        assertThat(root.queryForObject("SELECT count(*) FROM abweichung WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();
    }

    /**
     * A3/A4: von Hand mit Anlass-Kopie des Lesers und Wortlaut; Frist vor dem Eröffnungstag 422 (beim Eröffnen und beim
     * Ändern), Verantwortlicher nur aktives Konto, Ursache-Aussage mit Beleg-Kennung und ohne Konto, überfällig beim
     * Abruf nach der Frist.
     */
    @Test
    void vonHandFristUndVerantwortlicher() throws Exception {
        Welt w = welt();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzahl", w.kz4().toString());
        body.put("monate", "2027-12");
        body.put("wortlaut", "Grundlast über die Feiertage prüfen, obwohl im Rahmen.");
        body.put("verantwortlich", sub(w, "peter"));
        body.put("frist", "2028-01-05");
        Antwort vor = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(vor.status()).as(vor.text()).isEqualTo(422);
        assertThat(vor.body().get("code").asText()).isEqualTo("frist_vor_eroeffnung");
        body.put("frist", "2028-01-31");
        body.put("monate", "2028-01");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD, body).body().get("code").asText())
                .isEqualTo("monate_nicht_abgeschlossen");
        body.put("monate", "2027-12");
        body.put("wortlaut", "kurz");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD, body).body().get("code").asText()).isEqualTo("wortlaut_fehlt");
        body.put("wortlaut", "Grundlast über die Feiertage prüfen, obwohl im Rahmen.");
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        JsonNode aw = neu.body();
        assertThat(aw.get("kennzeichen").asText()).isEqualTo("AW-2028-0001");
        assertThat(aw.at("/herkunft/art").asText()).isEqualTo("von_hand");
        assertThat(aw.at("/herkunft/wortlaut").asText()).startsWith("Grundlast");
        assertThat(aw.get("fassung").asInt()).isEqualTo(2);
        assertThat(aw.at("/anlass_inhalt/vergleich/0/bereinigt/delta_prozent").asText()).isEqualTo("12.9");
        assertThat(aw.get("anlass_pruefsumme").asText()).isEqualTo(BerichtRegeln.pruefsumme(aw.get("anlass").asText()));
        assertThat(aw.get("kopf_satz").asText()).contains("Dezember 2027: 12,9 % mehr als die Bezugsbasis erwarten "
                + "lässt · Verantwortlich Peter Hollerbach · Frist 31.01.2028 · offen.");
        String id = aw.get("id").asText();

        Antwort fristVor = ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + id + "/frist", Map.of("frist", "2028-01-10",
                "begruendung", "Frist vorziehen auf vor dem Eröffnen."));
        assertThat(fristVor.status()).as(fristVor.text()).isEqualTo(422);
        assertThat(fristVor.body().get("code").asText()).isEqualTo("frist_vor_eroeffnung");
        assertThat(ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + id + "/frist", Map.of("frist", "2028-02-15")).status())
                .isEqualTo(422);
        Antwort frist = ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + id + "/frist", Map.of("frist", "2028-02-15",
                "begruendung", "Messdaten der Halle 1 kommen erst im Februar."));
        assertThat(frist.status()).as(frist.text()).isEqualTo(200);
        assertThat(frist.body().at("/frist/termin").asText()).isEqualTo("2028-02-15");
        assertThat(frist.body().at("/verlauf/1/art").asText()).isEqualTo("abweichung_geaendert");
        assertThat(frist.body().at("/verlauf/1/alt/frist").asText()).isEqualTo("2028-01-31");

        String verantwortlicher = PFAD + "/" + id + "/verantwortlicher";
        Antwort olga = ruf(w, "ines", HttpMethod.PUT, verantwortlicher, Map.of("benutzer", sub(w, "olga"),
                "begruendung", "Olga übernimmt die Abweichung."));
        assertThat(olga.status()).as(olga.text()).isEqualTo(422);
        assertThat(olga.body().get("code").asText()).isEqualTo("benutzer_unbekannt");
        Antwort ines = ruf(w, "ines", HttpMethod.PUT, verantwortlicher, Map.of("benutzer", sub(w, "ines"),
                "begruendung", "Ines übernimmt die Abweichung."));
        assertThat(ines.status()).as(ines.text()).isEqualTo(200);
        assertThat(ines.body().at("/verantwortlich/name").asText()).isEqualTo("Ines Kaltenbach");

        Map<String, Object> aussage = new LinkedHashMap<>();
        aussage.put("art", "ursache_aussage");
        aussage.put("wortlaut", "Der Zählerstand vom Dezember wurde nachträglich berichtigt.");
        aussage.put("aussage_name", "Externer Gutachter");
        aussage.put("aussage_am", "2028-01-11");
        aussage.put("beleg_kennung", "K-2028-0001");
        Antwort mitBeleg = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/eintraege", aussage);
        assertThat(mitBeleg.status()).as(mitBeleg.text()).isEqualTo(201);
        assertThat(mitBeleg.body().at("/verlauf/3/aussage/satz").asText()).isEqualTo("Ursache — Aussage von Externer "
                + "Gutachter, 11.01.2028 (mit Beleg: K-2028-0001): ‚Der Zählerstand vom Dezember wurde nachträglich "
                + "berichtigt.‘");
        assertThat(mitBeleg.body().at("/verlauf/3/aussage/sub").isNull()).isTrue();
        aussage.put("aussage_am", "2028-01-11");
        aussage.remove("aussage_name");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/eintraege", aussage).body().get("code").asText())
                .isEqualTo("aussage_ohne_person");
        aussage.put("aussage_name", "Externer Gutachter");
        aussage.put("aussage_am", "2028-01-13");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/eintraege", aussage).body().get("code").asText())
                .isEqualTo("aussage_in_der_zukunft");

        uhr(Instant.parse("2028-02-20T09:00:00Z"));
        JsonNode ueber = ruf(w, "ines", HttpMethod.GET, PFAD + "?ueberfaellig=true", null).body();
        assertThat(ueber.get("abweichungen")).hasSize(1);
        assertThat(ueber.at("/abweichungen/0/frist/seit_tagen").asInt()).isEqualTo(5);
        assertThat(ueber.at("/abweichungen/0/verlauf").isNull()).isTrue();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?zustand=abgeschlossen", null).body().get("abweichungen"))
                .isEmpty();
    }

    /**
     * RE1/RE2: fremder Kundenbereich 404 (Abweichung, Vermerk, Kennzahl); die Bearbeiterin an ST-2 sieht die
     * Abweichung an ST-1 nicht (404); der Bearbeiter an ST-1 antwortet und trägt ein, schließt aber nicht ab (403); der
     * Bedienberechtigte sieht und schreibt nie (403).
     */
    @Test
    void zaun404UndRechte403() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        JsonNode anlass = vermerkAus("KZ-0004", "2027-12").get("anlass");
        UUID dezember = vermerk(w, 2, "2027-12", anlass, "2028-01-07T04:12:00Z");
        String vermerke = "/api/v1/kennzahlen/" + w.kz4() + "/auffaelligkeiten";
        Map<String, Object> antwort = Map.of("antwort", "abweichung", "verantwortlich", sub(w, "peter"));

        assertThat(ruf(fremd, "ines", HttpMethod.GET, vermerke, null).status()).isEqualTo(404);
        assertThat(ruf(fremd, "ines", HttpMethod.POST, vermerke + "/" + dezember + "/antwort", antwort).status())
                .isEqualTo(404);
        assertThat(ruf(w, "rita", HttpMethod.GET, vermerke, null).status()).isEqualTo(404);
        Antwort bd = ruf(w, "murat", HttpMethod.POST, vermerke + "/" + dezember + "/antwort", antwort);
        assertThat(bd.status()).as(bd.text()).isEqualTo(403);
        assertThat(ruf(w, "murat", HttpMethod.GET, vermerke, null).status()).isEqualTo(200);

        Antwort be = ruf(w, "peter", HttpMethod.POST, vermerke + "/" + dezember + "/antwort", antwort);
        assertThat(be.status()).as(be.text()).isEqualTo(201);
        String id = be.body().at("/abweichung/id").asText();
        for (String pfad : List.of(PFAD + "/" + id, PFAD + "/" + UUID.randomUUID(), PFAD + "/kein-id")) {
            assertThat(ruf(fremd, "ines", HttpMethod.GET, pfad, null).status()).as(pfad).isEqualTo(404);
        }
        assertThat(ruf(w, "rita", HttpMethod.GET, PFAD + "/" + id, null).status()).isEqualTo(404);
        assertThat(ruf(w, "rita", HttpMethod.GET, PFAD, null).body().get("abweichungen")).isEmpty();
        assertThat(ruf(fremd, "ines", HttpMethod.GET, PFAD, null).body().get("abweichungen")).isEmpty();
        Map<String, Map<String, Object>> schreiben = Map.of(
                "/eintraege", Map.of("text", "Fremd schreibt."),
                "/abschliessen", Map.of("ergebnis", "erklaert", "begruendung", "Fremder Kundenbereich schließt."));
        for (var s : schreiben.entrySet()) {
            assertThat(ruf(fremd, "ines", HttpMethod.POST, PFAD + "/" + id + s.getKey(), s.getValue()).status())
                    .as(s.getKey()).isEqualTo(404);
            // Rita hat verbesserung.abschliessen nirgends: der Interceptor urteilt 403 vor dem Zaun.
            assertThat(ruf(w, "rita", HttpMethod.POST, PFAD + "/" + id + s.getKey(), s.getValue()).status())
                    .as("rita " + s.getKey()).isEqualTo(s.getKey().equals("/abschliessen") ? 403 : 404);
            assertThat(ruf(w, "murat", HttpMethod.POST, PFAD + "/" + id + s.getKey(), s.getValue()).status())
                    .as("murat " + s.getKey()).isEqualTo(403);
        }
        assertThat(ruf(fremd, "ines", HttpMethod.PUT, PFAD + "/" + id + "/frist", Map.of("frist", "2028-02-15",
                "begruendung", "Fremder Kundenbereich ändert.")).status()).isEqualTo(404);
        Map<String, Object> vonHand = Map.of("kennzahl", w.kz4().toString(), "monate", "2027-12", "wortlaut",
                "Fremder Kundenbereich eröffnet.", "verantwortlich", sub(fremd, "ines"));
        assertThat(ruf(fremd, "ines", HttpMethod.POST, PFAD, vonHand).status()).isEqualTo(404);

        assertThat(ruf(w, "peter", HttpMethod.POST, PFAD + "/" + id + "/eintraege", Map.of("text", "Peter war da."))
                .status()).isEqualTo(201);
        Antwort abschluss = ruf(w, "peter", HttpMethod.POST, PFAD + "/" + id + "/abschliessen", Map.of("ergebnis",
                "keine_abweichung", "begruendung", "Bearbeiter will abschließen."));
        assertThat(abschluss.status()).as(abschluss.text()).isEqualTo(403);
        assertThat(abschluss.body().get("code").asText()).isEqualTo("recht_fehlt");
        assertThat(ruf(w, "murat", HttpMethod.GET, PFAD + "/" + id, null).status()).isEqualTo(200);
    }

    // ================================================================================ Vermerke und Referenz

    private static JsonNode referenz() {
        try {
            return MAPPER.readTree(java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                    "uems-referenzunternehmen.json").toFile());
        } catch (java.io.IOException x) {
            throw new IllegalStateException(x);
        }
    }

    private static JsonNode vermerkAus(String kennzahl, String periode) {
        for (JsonNode n : RU.get("auffaelligkeiten")) {
            if (n.get("kennzahl").asText().equals(kennzahl) && n.get("periode").asText().equals(periode)) {
                return n;
            }
        }
        throw new IllegalStateException(kennzahl + " " + periode);
    }

    private static JsonNode referenzAbweichung(String kennzeichen) {
        for (JsonNode n : RU.get("abweichungen")) {
            if (n.get("kennzeichen").asText().equals(kennzeichen)) {
                return n;
            }
        }
        throw new IllegalStateException(kennzeichen);
    }

    /** Ein offener Vermerk, wie ihn die Naht (IP-15) schreibt: kanonische Kopie, Prüfsumme der Datenbank, ST-1. */
    private static UUID vermerk(Welt w, int fassung, String periode, JsonNode anlass, String am) {
        UUID basis = root.queryForObject("SELECT id FROM bezugsbasis WHERE kennzahl_id = ?", UUID.class, w.kz4());
        String text = BerichtRegeln.kanonisch(anlass);
        return root.queryForObject("INSERT INTO auffaelligkeit (tenant_id, kennzahl_id, bezugsbasis_id, fassung, periode, "
                + "standort_id, anlass, anlass_pruefsumme, vermerkt_am) VALUES (?, ?, ?, ?, ?, ?, ?, bericht_pruefsumme(?), "
                + "?) RETURNING id", UUID.class, w.mandant(), w.kz4(), basis, fassung, periode, w.st1(), text, text,
                Timestamp.from(Instant.parse(am)));
    }

    /** R3: M-2028-0001 mit Messgrundlage und Herkunft AW-2028-0001. */
    private static Map<String, Object> massnahme(Welt w) {
        JsonNode r3 = null;
        for (JsonNode n : RU.get("massnahmen")) {
            if (n.get("kennzeichen").asText().equals("M-2028-0001")) {
                r3 = n;
            }
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", r3.get("titel").asText());
        m.put("verantwortlich", sub(w, "murat"));
        m.put("termin", r3.get("termin").asText());
        m.put("herkunft", "abweichung");
        m.put("herkunft_kennung", "AW-2028-0001");
        m.put("kennzahl", w.kz4().toString());
        m.put("monate", "2027-12");
        m.put("erwartete_wirkung_wortlaut", r3.at("/erwartete_wirkung/wortlaut").asText());
        return m;
    }

    // ================================================================================ Welt

    private static String sub(Welt w, String person) {
        return "sub-" + person + "-" + w.mandant();
    }

    private void uhr(Instant jetzt) {
        kennzahlen.uhrStellen(Clock.fixed(jetzt, ZoneOffset.UTC));
    }

    private Welt welt() throws Exception {
        // Kennzahl und Bezugsbasis entstehen vor den Monaten, die sie lesen; danach wieder der Anlegetag.
        uhr(Instant.parse("2026-10-01T09:00:00Z"));
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Abweichung #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID st2 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g2, st1);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, ms, g2);
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge Spritzguss', 'periodenwert', "
                + "'kg', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g2);
        String[][] personen = {{"ines", "Ines Kaltenbach", null, "aktiv"}, {"peter", "Peter Hollerbach", "bearbeiter", "aktiv"},
            {"murat", "Murat Demirci", "bedienberechtigt", "aktiv"}, {"olga", "Olga Alt", null, "entfernt"},
            {"jonas", "Jonas Wendlinger", null, "aktiv"}, {"rita", "Rita Stein", "bearbeiter", "aktiv", "st2"}};
        for (String[] p : personen) {
            String sub = "sub-" + p[0] + "-" + t;
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, ?)",
                    t, sub, p[1], p[3]);
            if (p[2] != null) {
                root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                        + "VALUES (?, ?, ?, ?, '2024-01-01', 'Europe/Berlin')", t, sub, p[2], p.length > 4 ? st2 : st1);
            }
        }
        Welt ohne = new Welt(t, st1, st2, null, bz1);
        UUID kz4 = kennzahl(ohne, g2);
        // R3 „gegeben“: Dezember 2027 78 000 kWh bei 250 000 kg, endgültig am 07.01.2028.
        monat(t, kz4, bz1, "2027-12-01", "78000", "250000");

        Welt w = new Welt(t, st1, st2, kz4, bz1);
        TenantContext.set(t);
        UUID bb1 = basis(w, kz4);
        fassung(t, bb1, 1, bz1, "verhaeltnis", "2026-10/2026-10", "2026-11-01", "2027-10-31", "0.2837", null, null,
                null, null);
        fassung(t, bb1, 2, bz1, "regression_eine_variable", "2026-11/2027-10", "2027-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        TenantContext.clear();
        uhr(ANTWORT);
        return w;
    }

    /** Eine endgültige Monatszeile der Kennzahl (Version 1) und der Bezugsgrößen-Wert (Fassung 1). */
    private static void monat(UUID t, UUID kennzahl, UUID bz, String erster, String zaehlerText, String nennerText) {
        LocalDate von = LocalDate.parse(erster);
        LocalDate bis = von.plusMonths(1).minusDays(1);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        Timestamp endgueltig = Timestamp.from(von.plusMonths(1).plusDays(6).atStartOfDay().toInstant(ZoneOffset.UTC));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, richtung, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', NULL, '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, t, kennzahl,
                Date.valueOf(von), Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner,
                endgueltig, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "'MS-20', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-20'), ?, 'kWh', "
                + "'vollständig', 1)", t, wert, kennzahl, t, zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', ?, ?, 'kg', 'vollständig', 1)", t, wert, kennzahl, bz, nenner);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", t, bz, Date.valueOf(von), Date.valueOf(bis), nenner, am);
    }

    /** Die Bezugsbasis über die Route von AP-17 IP-7 (BB-…). */
    private UUID basis(Welt w, UUID kennzahl) throws Exception {
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen/" + kennzahl + "/bezugsbasen", null);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster EnergiezielApiTest); Fassung 1 ist beendet. */
    private static void fassung(UUID t, UUID basis, int nummer, UUID bz, String methode, String referenzperiode,
            String giltAb, String giltBis, String basiswert, String koeffizienten, String streuung, String von,
            String bis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, "
                + "methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, anpassungsgruende, "
                + "begruendung, basiswert, koeffizienten, streuung_prozent, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, ?::text[], 'Freigabe im Abweichung-Test.', ?, ?::jsonb, ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', now(), now()) RETURNING id", UUID.class, t, basis, nummer, referenzperiode,
                methode, nummer == 1 ? "vorlaeufig" : "vollstaendig", Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : Timestamp.from(ANGELEGT),
                giltBis == null ? null : "Fassung 2 ersetzt das Verhältnis.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", new BigDecimal(basiswert), koeffizienten,
                streuung == null ? null : new BigDecimal(streuung));
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, 1, ?, 1, ?, ?)", t, f, bz,
                von == null ? null : new BigDecimal(von), bis == null ? null : new BigDecimal(bis));
    }

    private UUID kennzahl(Welt w, UUID gebaeude) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", "KZ-0004");
        m.put("name", "Stromeinsatz Spritzguss je kg");
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", gebaeude.toString());
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen", m);
        assertThat(a.status()).as("KZ-0004 " + a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Die Zahlen sind JSON-Texte (exakte Dezimalen). */
    private static BigDecimal zahl(JsonNode n) {
        return new BigDecimal(n.asText());
    }

    private static final Map<String, String> NAMEN = Map.of("ines", "Ines Kaltenbach", "peter", "Peter Hollerbach",
            "murat", "Murat Demirci", "olga", "Olga Alt", "jonas", "Jonas Wendlinger", "rita", "Rita Stein");

    private Antwort ruf(Welt w, String person, HttpMethod methode, String pfad, Object body) throws Exception {
        // Über den Rollen-Konverter wie in Produktion: erst so entsteht der Zugriff-Kontext (Rolle je Standort).
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub(w, person)).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", w.mandant().toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(person))
                .claim("preferred_username", NAMEN.get(person)).build();
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }
}
