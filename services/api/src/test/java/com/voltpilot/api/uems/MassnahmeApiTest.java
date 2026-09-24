package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
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
 * Maßnahme-Routen (UEMS AP-18 IP-10, M1–M4, M6, M7, RE1–RE3) gegen eine echte Datenbank — mit R3 und R7 der
 * Referenzdatei 1.9 ({@code massnahmen[]}): KZ-0004 Spritzguss (MS-20 ÷ BZ-1) mit BB-0001 Fassung 2 (Modell
 * 10 523 kWh + 0,2343 kWh je kg, Streuung ± 0,8 %, Spannweite 254 000–341 000 kg, gilt ab 01.11.2027); Dezember 2027
 * 78 000 kWh bei 250 000 kg, endgültig ab 07.01.2028. Angelegt am 15.01.2028, umgesetzt am 22.01.2028 (R3);
 * M-2028-0002 ohne Messgrundlage am Einsatz EE-3 Druckluft, Termin 29.02.2028, am 15.03.2028 überfällig seit 15 Tagen
 * (R7, R9).
 *
 * <p>Personen: Ines Kaltenbach nie zugewiesen (Kundenadministrator), Peter Hollerbach Bearbeiter an ST-1, Murat
 * Demirci Bedienberechtigter an ST-1, Olga Alt mit beendetem Konto. Die Uhr der Kennzahlen ist gestellt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MassnahmeApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/massnahmen";
    private static final Instant ANGELEGT = Instant.parse("2028-01-15T09:00:00Z");
    private static final Instant UMGESETZT = Instant.parse("2028-01-22T09:00:00Z");
    private static final Instant MAERZ = Instant.parse("2028-03-15T09:00:00Z");
    private static final Map<String, JsonNode> RU = referenz();

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

    private record Welt(UUID mandant, UUID st1, UUID st2, UUID kz4, UUID ee3) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void uhrAmAnlegetag() {
        uhr(ANGELEGT);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    /**
     * R3: M-2028-0001 an KZ-0004 × BB-0001 Fassung 2 mit der Ausgangslage Dezember 2027 — 78 000 kWh (Version 1),
     * 12,9 % mehr als erwartet, schlechter; die Kopie hat eine Prüfsumme, die eine zweite Bildung byte-gleich trifft.
     * Dann Kommentar, umgesetzt am 22.01.2028 (einmalig: 409), und eine zweite Maßnahme: umgesetzt in der Zukunft 422,
     * verworfen mit Begründung.
     */
    @Test
    void r3AusgangslageDezember2027UndUmgesetzt() throws Exception {
        Welt w = welt();
        JsonNode r3 = RU.get("M-2028-0001");
        Map<String, Object> body = mitMessgrundlage(w, r3);
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        JsonNode m = neu.body();
        assertThat(m.get("kennzeichen").asText()).isEqualTo("M-2028-0001");
        assertThat(m.get("zustand").asText()).isEqualTo("geplant");
        assertThat(m.at("/verantwortlich/name").asText()).isEqualTo("Murat Demirci");
        assertThat(m.get("termin").asText()).isEqualTo("2028-01-31");
        assertThat(m.get("angelegt_am").asText()).isEqualTo("2028-01-15");
        assertThat(m.get("standort_id").asText()).isEqualTo(w.st1().toString());
        assertThat(m.at("/herkunft/art").asText()).isEqualTo("abweichung");
        assertThat(m.at("/herkunft/kennung").asText()).isEqualTo("AW-2028-0001");
        assertThat(m.get("erwartete_wirkung_prozent").asText()).isEqualTo("-3.0");
        assertThat(m.get("ohne_messgrundlage").isNull()).isTrue();
        JsonNode mg = m.get("messgrundlage");
        assertThat(mg.at("/kennzahl/kennzeichen").asText()).isEqualTo("KZ-0004");
        assertThat(mg.at("/bezugsbasis/kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(mg.get("fassung").asInt()).isEqualTo(2);
        assertThat(mg.get("bewertungsmethode").asText()).isEqualTo("Modell mit einer Einflussgröße");
        JsonNode dezember = mg.at("/ausgangslage_inhalt/vergleich/0");
        assertThat(dezember.get("periode").asText()).isEqualTo("2027-12");
        assertThat(zahl(dezember.at("/bereinigt/gemessen/wert"))).isEqualByComparingTo("78000");
        assertThat(dezember.at("/bereinigt/gemessen/version").asInt()).isEqualTo(1);
        assertThat(zahl(dezember.at("/bereinigt/erwartet")).setScale(0, RoundingMode.HALF_UP))
                .isEqualByComparingTo("69098");
        assertThat(dezember.at("/bereinigt/delta_prozent").asText()).isEqualTo("12.9");
        assertThat(dezember.at("/bereinigt/urteil").asText()).isEqualTo("schlechter");
        assertThat(dezember.at("/bereinigt/fassung/fassung").asInt()).isEqualTo(2);
        assertThat(mg.at("/ausgangslage_inhalt/monate").asText()).isEqualTo("2027-12");
        // Die Prüfsumme ist sha256 über den gespeicherten kanonischen Text — dieselbe wie in der Datenbank.
        String text = mg.get("ausgangslage").asText();
        String pruefsumme = mg.get("pruefsumme").asText();
        assertThat(pruefsumme).isEqualTo(BerichtRegeln.pruefsumme(text)).startsWith("sha256:");
        assertThat(root.queryForObject("SELECT bericht_pruefsumme(ausgangslage) FROM massnahme WHERE id = ?",
                String.class, UUID.fromString(m.get("id").asText()))).isEqualTo(pruefsumme);
        assertThat(text).isEqualTo(BerichtRegeln.kanonisch(MAPPER.readTree(text)));
        assertThat(mg.get("satz").asText()).startsWith("Messgrundlage: KZ-0004 Stromeinsatz Spritzguss je kg, "
                + "Bezugsbasis BB-0001, Fassung 2 — bereinigt um ")
                .contains("(Modell mit einer Einflussgröße). Ausgangslage Dezember 2027: 12,9 % mehr als erwartet "
                        + "(Version 1, Kopie vom 15.01.2028). Erwartete Wirkung: 3 % weniger — ‚");
        assertThat(m.get("verlauf")).hasSize(1);
        assertThat(m.at("/verlauf/0/art").asText()).isEqualTo("massnahme_angelegt");

        // Zweite Bildung derselben Ausgangslage: byte-gleich, dieselbe Prüfsumme.
        Map<String, Object> zweite = mitMessgrundlage(w, r3);
        zweite.put("titel", "Zweite Maßnahme an derselben Ausgangslage");
        zweite.put("herkunft", "von_hand");
        zweite.remove("herkunft_kennung");
        Antwort b = ruf(w, "ines", HttpMethod.POST, PFAD, zweite);
        assertThat(b.status()).as(b.text()).isEqualTo(201);
        assertThat(b.body().get("kennzeichen").asText()).isEqualTo("M-2028-0002");
        assertThat(b.body().at("/messgrundlage/ausgangslage").asText()).isEqualTo(text);
        assertThat(b.body().at("/messgrundlage/pruefsumme").asText()).isEqualTo(pruefsumme);

        String id = m.get("id").asText();
        Antwort k = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/eintraege",
                Map.of("text", "Murat meldet: Zeitschaltuhren sind bestellt."));
        assertThat(k.status()).as(k.text()).isEqualTo(201);
        assertThat(k.body().at("/verlauf/1/art").asText()).isEqualTo("kommentar");
        assertThat(k.body().at("/verlauf/1/kommentar").asText()).isEqualTo("Murat meldet: Zeitschaltuhren sind bestellt.");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/eintraege", Map.of("text", " ")).status())
                .isEqualTo(422);

        uhr(UMGESETZT);
        JsonNode u = r3.get("verlauf").get(1);
        Antwort um = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/umgesetzt",
                Map.of("am", "2028-01-22", "begruendung", u.get("begruendung").asText()));
        assertThat(um.status()).as(um.text()).isEqualTo(200);
        assertThat(um.body().get("zustand").asText()).isEqualTo("umgesetzt");
        assertThat(um.body().get("umgesetzt_am").asText()).isEqualTo("2028-01-22");
        assertThat(um.body().get("kopf_satz").asText()).isEqualTo("M-2028-0001 · " + r3.get("titel").asText()
                + " · Verantwortlich Murat Demirci · Termin 31.01.2028 · umgesetzt am 22.01.2028.");
        assertThat(um.body().at("/verlauf/2/art").asText()).isEqualTo("massnahme_umgesetzt");
        Antwort nochmal = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/umgesetzt",
                Map.of("am", "2028-01-22", "begruendung", "Noch einmal umgesetzt gemeldet."));
        assertThat(nochmal.status()).as(nochmal.text()).isEqualTo(409);
        assertThat(nochmal.body().get("code").asText()).isEqualTo("massnahme_nicht_geplant");
        assertThat(ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + id, Map.of("titel", "Neu",
                "begruendung", "Titel nach der Umsetzung ändern.")).status()).isEqualTo(409);

        String zweiteId = b.body().get("id").asText();
        Antwort zukunft = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + zweiteId + "/umgesetzt",
                Map.of("am", "2028-01-23", "begruendung", "Morgen wird es umgesetzt sein."));
        assertThat(zukunft.status()).as(zukunft.text()).isEqualTo(422);
        assertThat(zukunft.body().get("code").asText()).isEqualTo("umgesetzt_in_der_zukunft");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + zweiteId + "/verwerfen", Map.of()).status())
                .isEqualTo(422);
        Antwort weg = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + zweiteId + "/verwerfen",
                Map.of("begruendung", "Doppelt angelegt, M-2028-0001 deckt es ab."));
        assertThat(weg.status()).as(weg.text()).isEqualTo(200);
        assertThat(weg.body().get("zustand").asText()).isEqualTo("verworfen");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + zweiteId + "/verwerfen",
                Map.of("begruendung", "Noch einmal verworfen.")).status()).isEqualTo(409);
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + zweiteId + "/eintraege",
                Map.of("text", "Nach dem Verwerfen")).status()).isEqualTo(409);
    }

    /**
     * R7: M-2028-0002 am Einsatz EE-3 Druckluft ohne Messgrundlage — eine Zahl der erwarteten Wirkung ist 422
     * {@code ohne_messgrundlage}; ohne Zahl entsteht sie mit dem Kennzeichen und dem Hinweis, welche Kennzahl fehlt, auch
     * im Register. R9: am 15.03.2028 überfällig seit 15 Tagen (Operation {@code frist}), Filter {@code ueberfaellig}.
     */
    @Test
    void r7OhneMessgrundlageUndUeberfaellig() throws Exception {
        Welt w = welt();
        uhr(Instant.parse("2028-01-20T09:00:00Z"));
        JsonNode r7 = RU.get("M-2028-0002");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("titel", "Druckluft-Leckagen orten und beseitigen");
        body.put("verantwortlich", sub(w, "ines"));
        body.put("termin", r7.get("termin").asText());
        body.put("herkunft", "einsatz");
        body.put("einsatz", w.ee3().toString());
        body.put("standort", w.st1().toString());
        body.put("erwartete_wirkung_wortlaut", r7.at("/erwartete_wirkung/wortlaut").asText());
        body.put("erwartete_wirkung_prozent", -10.0);
        Antwort zahl = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(zahl.status()).as(zahl.text()).isEqualTo(422);
        assertThat(zahl.body().get("code").asText()).isEqualTo("ohne_messgrundlage");
        assertThat(zahl.body().get("kennzeichen").asText()).isEqualTo("ohne Messgrundlage — Wirkung nicht messbar");
        assertThat(zahl.body().get("hinweis").asText()).isEqualTo("zum Beispiel Druckluft je Betriebsstunde mit einer "
                + "Bezugsbasis");
        body.remove("erwartete_wirkung_prozent");
        body.put("erwartete_wirkung_wortlaut", " ");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD, body).body().get("code").asText()).isEqualTo("wortlaut_fehlt");
        body.put("erwartete_wirkung_wortlaut", r7.at("/erwartete_wirkung/wortlaut").asText());
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();

        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        JsonNode m = neu.body();
        assertThat(m.get("kennzeichen").asText()).isEqualTo("M-2028-0001");
        assertThat(m.get("messgrundlage").isNull()).isTrue();
        assertThat(m.get("erwartete_wirkung_prozent").isNull()).isTrue();
        assertThat(m.at("/herkunft/art").asText()).isEqualTo("einsatz");
        assertThat(m.at("/herkunft/kennung").asText()).isEqualTo("EE-3");
        assertThat(m.at("/einsatz/kennzeichen").asText()).isEqualTo("EE-3");
        assertThat(m.at("/ohne_messgrundlage/kennzeichen").asText()).isEqualTo("ohne Messgrundlage — Wirkung nicht messbar");
        assertThat(m.at("/ohne_messgrundlage/satz").asText()).isEqualTo("M-2028-0001 · Druckluft-Leckagen orten und "
                + "beseitigen · ohne Messgrundlage — Wirkung nicht messbar. Um die Wirkung zu messen, braucht Druckluft "
                + "eine Energieleistungskennzahl (zum Beispiel Druckluft je Betriebsstunde mit einer Bezugsbasis).");
        String id = m.get("id").asText();
        Antwort zahlSpaeter = ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + id, Map.of("erwartete_wirkung_prozent", -5.0,
                "begruendung", "Doch eine Zahl nachtragen."));
        assertThat(zahlSpaeter.status()).as(zahlSpaeter.text()).isEqualTo(422);
        assertThat(zahlSpaeter.body().get("code").asText()).isEqualTo("ohne_messgrundlage");

        uhr(MAERZ);
        JsonNode register = ruf(w, "ines", HttpMethod.GET, PFAD + "?ueberfaellig=true", null).body();
        assertThat(register.get("abruf").asText()).isEqualTo("2028-03-15");
        assertThat(register.get("massnahmen")).hasSize(1);
        JsonNode zeile = register.at("/massnahmen/0");
        assertThat(zeile.at("/ohne_messgrundlage/kennzeichen").asText())
                .isEqualTo("ohne Messgrundlage — Wirkung nicht messbar");
        assertThat(zeile.at("/frist/faellig").asText()).isEqualTo("ueberfaellig");
        assertThat(zeile.at("/frist/seit_tagen").asInt()).isEqualTo(15);
        assertThat(zeile.at("/frist/satz").asText()).isEqualTo("M-2028-0001 · geplant · Termin 29.02.2028 · überfällig "
                + "seit 15 Tagen · Ines Kaltenbach.");
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?ueberfaellig=false", null).body().get("massnahmen")).isEmpty();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?einsatz=" + w.ee3(), null).body().get("massnahmen")).hasSize(1);
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?zustand=umgesetzt", null).body().get("massnahmen")).isEmpty();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?kennzahl=" + w.kz4(), null).body().get("massnahmen")).isEmpty();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?farbe=rot", null).status()).isEqualTo(400);
    }

    /** RE3: der Verantwortliche ist ein aktives Konto des Kundenbereichs — sonst 422 {@code benutzer_unbekannt}. */
    @Test
    void verantwortlicherNurAktivesKonto() throws Exception {
        Welt w = welt();
        Map<String, Object> body = vonHand(w, w.st1());
        for (String sub : List.of("sub-niemand", sub(w, "olga"))) {
            body.put("verantwortlich", sub);
            Antwort a = ruf(w, "ines", HttpMethod.POST, PFAD, body);
            assertThat(a.status()).as(a.text()).isEqualTo(422);
            assertThat(a.body().get("code").asText()).isEqualTo("benutzer_unbekannt");
        }
        body.put("verantwortlich", sub(w, "murat"));
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        String pfad = PFAD + "/" + neu.body().get("id").asText() + "/verantwortlicher";
        Antwort a = ruf(w, "ines", HttpMethod.PUT, pfad, Map.of("benutzer", sub(w, "olga"),
                "begruendung", "Olga übernimmt die Maßnahme."));
        assertThat(a.status()).as(a.text()).isEqualTo(422);
        assertThat(a.body().get("code").asText()).isEqualTo("benutzer_unbekannt");
        Antwort ok = ruf(w, "ines", HttpMethod.PUT, pfad, Map.of("benutzer", sub(w, "peter"),
                "begruendung", "Peter übernimmt die Maßnahme."));
        assertThat(ok.status()).as(ok.text()).isEqualTo(200);
        assertThat(ok.body().at("/verantwortlich/name").asText()).isEqualTo("Peter Hollerbach");
        assertThat(ok.body().at("/verlauf/1/art").asText()).isEqualTo("verantwortlicher_geaendert");
    }

    /**
     * RE1/RE2: fremder Kundenbereich 404; der Bearbeiter (BE S) legt am eigenen Standort an, nicht am fremden und nicht
     * am Unternehmen, und sieht die Maßnahme am Unternehmen nicht; der Bedienberechtigte (BD) sieht, schreibt nie (403).
     */
    @Test
    void zaun404BeamEigenenStandortBd403() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        Antwort st1 = ruf(w, "ines", HttpMethod.POST, PFAD, vonHand(w, w.st1()));
        assertThat(st1.status()).as(st1.text()).isEqualTo(201);
        String id = st1.body().get("id").asText();
        Antwort firma = ruf(w, "ines", HttpMethod.POST, PFAD, vonHand(w, null));
        assertThat(firma.status()).as(firma.text()).isEqualTo(201);
        String firmaId = firma.body().get("id").asText();
        Antwort mitKennzahl = ruf(w, "ines", HttpMethod.POST, PFAD, mitMessgrundlage(w, RU.get("M-2028-0001")));
        assertThat(mitKennzahl.status()).as(mitKennzahl.text()).isEqualTo(201);

        for (String pfad : List.of(PFAD + "/" + id, PFAD + "/" + UUID.randomUUID(), PFAD + "/kein-id")) {
            assertThat(ruf(fremd, "ines", HttpMethod.GET, pfad, null).status()).as(pfad).isEqualTo(404);
        }
        assertThat(ruf(fremd, "ines", HttpMethod.PUT, PFAD + "/" + id, Map.of("titel", "fremd",
                "begruendung", "Fremder Kundenbereich will ändern.")).status()).isEqualTo(404);
        for (var r : koerper("Fremder Kundenbereich schreibt.").entrySet()) {
            assertThat(ruf(fremd, "ines", HttpMethod.POST, PFAD + "/" + id + "/" + r.getKey(), r.getValue()).status())
                    .as(r.getKey()).isEqualTo(404);
        }
        assertThat(ruf(fremd, "ines", HttpMethod.GET, PFAD, null).body().get("massnahmen")).isEmpty();
        Map<String, Object> fremdeKennzahl = mitMessgrundlage(fremd, RU.get("M-2028-0001"));
        fremdeKennzahl.put("kennzahl", w.kz4().toString());
        assertThat(ruf(fremd, "ines", HttpMethod.POST, PFAD, fremdeKennzahl).status()).isEqualTo(404);

        // BE S: am eigenen Standort anlegen, ändern, kommentieren; nicht am fremden, nicht am Unternehmen.
        Antwort be = ruf(w, "peter", HttpMethod.POST, PFAD, vonHand(w, w.st1()));
        assertThat(be.status()).as(be.text()).isEqualTo(201);
        assertThat(ruf(w, "peter", HttpMethod.POST, PFAD + "/" + id + "/eintraege", Map.of("text", "Peter war da."))
                .status()).isEqualTo(201);
        Antwort beFremd = ruf(w, "peter", HttpMethod.POST, PFAD, vonHand(w, w.st2()));
        assertThat(beFremd.status()).as(beFremd.text()).isIn(403, 404);
        Antwort beFirma = ruf(w, "peter", HttpMethod.POST, PFAD, vonHand(w, null));
        assertThat(beFirma.status()).as(beFirma.text()).isIn(403, 404);
        assertThat(ruf(w, "peter", HttpMethod.GET, PFAD + "/" + firmaId, null).status()).isEqualTo(404);
        assertThat(ruf(w, "peter", HttpMethod.GET, PFAD, null).body().findValuesAsText("id")).contains(id)
                .doesNotContain(firmaId);
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme WHERE tenant_id = ?", Integer.class,
                w.mandant())).isEqualTo(4);

        // BD: sieht am eigenen Standort, schreibt nie.
        assertThat(ruf(w, "murat", HttpMethod.GET, PFAD + "/" + id, null).status()).isEqualTo(200);
        Antwort bd = ruf(w, "murat", HttpMethod.POST, PFAD, vonHand(w, w.st1()));
        assertThat(bd.status()).as(bd.text()).isEqualTo(403);
        assertThat(bd.body().get("code").asText()).isEqualTo("recht_fehlt");
        for (var r : koerper("Bedienberechtigter meldet.").entrySet()) {
            Antwort x = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + id + "/" + r.getKey(), r.getValue());
            assertThat(x.status()).as(r.getKey() + " " + x.text()).isEqualTo(403);
        }
        assertThat(ruf(w, "murat", HttpMethod.PUT, PFAD + "/" + id, Map.of("titel", "BD ändert",
                "begruendung", "Bedienberechtigter will ändern.")).status()).isEqualTo(403);
    }

    // ================================================================================ Welt

    private static Map<String, JsonNode> referenz() {
        try {
            JsonNode datei = MAPPER.readTree(java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                    "uems-referenzunternehmen.json").toFile());
            Map<String, JsonNode> m = new LinkedHashMap<>();
            datei.get("massnahmen").forEach(n -> m.put(n.get("kennzeichen").asText(), n));
            return m;
        } catch (java.io.IOException x) {
            throw new IllegalStateException(x);
        }
    }

    private static Map<String, Object> mitMessgrundlage(Welt w, JsonNode r3) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", r3.get("titel").asText());
        m.put("verantwortlich", sub(w, "murat"));
        m.put("termin", r3.get("termin").asText());
        m.put("herkunft", r3.at("/herkunft/art").asText());
        m.put("herkunft_kennung", r3.at("/herkunft/kennung").asText());
        m.put("kennzahl", w.kz4().toString());
        m.put("monate", r3.at("/ausgangslage/kopie/monat").asText());
        m.put("erwartete_wirkung_prozent", r3.at("/erwartete_wirkung/prozent").decimalValue());
        m.put("erwartete_wirkung_wortlaut", r3.at("/erwartete_wirkung/wortlaut").asText());
        return m;
    }

    private static Map<String, Object> vonHand(Welt w, UUID standort) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", "Beleuchtung Halle 1 auf LED umstellen");
        m.put("verantwortlich", sub(w, "ines"));
        m.put("termin", "2028-06-30");
        m.put("herkunft", "von_hand");
        if (standort != null) {
            m.put("standort", standort.toString());
        }
        m.put("erwartete_wirkung_wortlaut", "Weniger Strom für die Hallenbeleuchtung.");
        return m;
    }

    /** Gültige Körper der drei POST-Übergänge — damit ein 404/403 nicht hinter einem 400 verschwindet. */
    private static Map<String, Map<String, Object>> koerper(String begruendung) {
        return Map.of("umgesetzt", Map.of("am", "2028-01-10", "begruendung", begruendung),
                "verwerfen", Map.of("begruendung", begruendung), "eintraege", Map.of("text", begruendung));
    }

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
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Maßnahme #" + nr);
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
            {"murat", "Murat Demirci", "bedienberechtigt", "aktiv"}, {"olga", "Olga Alt", null, "entfernt"}};
        for (String[] p : personen) {
            String sub = "sub-" + p[0] + "-" + t;
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, ?)",
                    t, sub, p[1], p[3]);
            if (p[2] != null) {
                root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                        + "VALUES (?, ?, ?, ?, '2024-01-01', 'Europe/Berlin')", t, sub, p[2], st1);
            }
        }
        Welt ohne = new Welt(t, st1, st2, null, null);
        UUID kz4 = kennzahl(ohne, g2);
        // R3 „gegeben“: Dezember 2027 78 000 kWh bei 250 000 kg, endgültig am 07.01.2028.
        monat(t, kz4, bz1, "2027-12-01", "78000", "250000");

        UUID p3 = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-3', 'Druckluft', '2024-01-01') RETURNING id", UUID.class, t, u);
        UUID ee3 = root.queryForObject("INSERT INTO energieeinsatz (tenant_id, kennzeichen, prozess_id, traeger, name, "
                + "gueltig_ab, actor_sub, actor_name, actor_art) VALUES (?, 'EE-3', ?, 'Druckluft', 'Druckluft', "
                + "'2026-10-01', 'IK', 'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, t, p3);
        root.update("INSERT INTO energieeinsatz_einflussgroesse (tenant_id, einsatz_id, wortlaut, art, position) "
                + "VALUES (?, ?, 'Betriebsstunde', 'betriebszeit', 0)", t, ee3);

        Welt w = new Welt(t, st1, st2, kz4, ee3);
        TenantContext.set(t);
        UUID bb1 = basis(w, kz4);
        fassung(t, bb1, 1, bz1, "verhaeltnis", "2026-10/2026-10", "2026-11-01", "2027-10-31", "0.2837", null, null,
                null, null);
        fassung(t, bb1, 2, bz1, "regression_eine_variable", "2026-11/2027-10", "2027-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        TenantContext.clear();
        uhr(ANGELEGT);
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
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, ?::text[], 'Freigabe im Maßnahme-Test.', ?, ?::jsonb, ?, "
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
            "murat", "Murat Demirci", "olga", "Olga Alt");

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
