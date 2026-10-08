package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MassnahmeWelt.Antwort;
import com.voltpilot.api.uems.MassnahmeWelt.Welt;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
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
 * <p>Personen: Ines Kaltenbach und Jonas Wendlinger nie zugewiesen (Kundenadministrator), Peter Hollerbach Bearbeiter
 * an ST-1, Petra Lindner Bearbeiterin an ST-2, Murat Demirci Bedienberechtigter an ST-1, Olga Alt mit beendetem Konto.
 * Die Uhr der Kennzahlen ist gestellt.
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
    private static final Map<String, JsonNode> RU = MassnahmeWelt.RU;

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

    private MassnahmeWelt mw;

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void uhrAmAnlegetag() {
        mw = new MassnahmeWelt(mvc, kennzahlen, root);
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
     * Konzept Verbessern, Entscheid 5: {@code ?energieziel=} liefert die Maßnahmen für das Energieziel und die, deren
     * Wirkung schon im Stand enthalten ist - M-2028-0001 (umgesetzt am 22.01.2028, nach der Referenzperiode der Fassung
     * 2) an derselben Kennzahl steht zusätzlich in {@code im_stand_enthalten}; eine geplante Maßnahme ohne Bezug nicht.
     * Ein unbekanntes Energieziel ist 404, ein Text statt einer ID 400; ohne Filter bleibt die Liste leer. Der Zaun
     * (Review r1 S-1.3): ein Energieziel außerhalb der eigenen Standorte (Petra an ST-2, KZ-0004 an ST-1) und eines aus
     * einem fremden Kundenbereich antworten wie ein unbekanntes - 404, ohne eine Maßnahmen-ID.
     */
    @Test
    void energiezielFilterMitImStandEnthalten() throws Exception {
        Welt w = welt();
        String enthalten = umgesetzteMassnahme(w)[0];
        Map<String, Object> ez = new LinkedHashMap<>();
        ez.put("kennzahl", w.kz4().toString());
        ez.put("zielwert_prozent", -4.0);
        ez.put("zielperiode", "2028-02/2028-12");
        ez.put("wortlaut", "Spritzguss: 4 % weniger Strom, als die Bezugsbasis erwarten lässt.");
        ez.put("begruendung", "Beschluss der Managementbewertung zum Spritzguss.");
        Antwort z = ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele", ez);
        assertThat(z.status()).as(z.text()).isEqualTo(201);
        String ziel = z.body().get("id").asText();

        Map<String, Object> fuer = vonHand(w, w.st1());
        fuer.put("titel", "Kühlwasserpumpen drehzahlgeregelt betreiben");
        fuer.put("herkunft", "energieziel");
        fuer.put("energieziel", ziel);
        Antwort f = ruf(w, "ines", HttpMethod.POST, PFAD, fuer);
        assertThat(f.status()).as(f.text()).isEqualTo(201);
        Antwort ohne = ruf(w, "ines", HttpMethod.POST, PFAD, vonHand(w, w.st1()));
        assertThat(ohne.status()).as(ohne.text()).isEqualTo(201);

        Antwort a = ruf(w, "ines", HttpMethod.GET, PFAD + "?energieziel=" + ziel, null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        List<String> ids = new ArrayList<>();
        a.body().get("massnahmen").forEach(m -> ids.add(m.get("id").asText()));
        assertThat(ids).containsExactly(enthalten, f.body().get("id").asText());
        assertThat(a.body().get("im_stand_enthalten").toString()).isEqualTo("[\"" + enthalten + "\"]");

        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD, null).body().get("im_stand_enthalten")).isEmpty();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?energieziel=" + UUID.randomUUID(), null).status())
                .isEqualTo(404);
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?energieziel=EZ-2028-0001", null).status()).isEqualTo(400);

        // Der Zaun: Peter (ST-1) sieht es, Petra (nur ST-2) und ein fremder Kundenbereich bekommen dasselbe 404 wie
        // für ein unbekanntes Energieziel - keine Maßnahme, kein Hinweis, dass es existiert.
        assertThat(ruf(w, "peter", HttpMethod.GET, PFAD + "?energieziel=" + ziel, null).status()).isEqualTo(200);
        Welt fremd = welt();
        for (var x : List.of(ruf(w, "petra", HttpMethod.GET, PFAD + "?energieziel=" + ziel, null),
                ruf(fremd, "ines", HttpMethod.GET, PFAD + "?energieziel=" + ziel, null))) {
            assertThat(x.status()).as(x.text()).isEqualTo(404);
            assertThat(x.text()).doesNotContain(enthalten).doesNotContain(f.body().get("id").asText());
            assertThat(x.body().get("massnahmen")).isNull();
        }
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

    /**
     * Verbessern-Konzept v1, Entscheid 8 (eng gefasst): wer für eine Maßnahme verantwortlich ist, meldet SIE als
     * umgesetzt und kommentiert SIE - auch ohne {@code verbesserung.verwalten} (Murat Demirci, bedienberechtigt; eine
     * Leserin). Eine fremde Maßnahme bleibt 403, ein anderer Kundenbereich 404; Ändern, Verwerfen und Bewerten bleiben
     * 403; Einsicht schreibt nie, auch als Verantwortliche.
     */
    @Test
    void verantwortlicheMeldenUndKommentierenNurDieEigeneMassnahme() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        person(w, "lena", "leser", w.st1());
        person(w, "robert", "einsicht", null);
        String eigene = anlegen(w, vonHand(w, w.st1()), "murat");
        String fremde = anlegen(w, vonHand(w, w.st1()), "ines");
        String vonLena = anlegen(w, vonHand(w, w.st1()), "lena");
        String vonRobert = anlegen(w, vonHand(w, w.st1()), "robert");

        // Murat: die eigene Maßnahme kommentieren und als umgesetzt melden - genau diese zwei Schritte.
        Antwort k = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/eintraege", Map.of("text", "Angebot liegt vor."));
        assertThat(k.status()).as(k.text()).isEqualTo(201);
        assertThat(k.body().at("/verlauf/1/art").asText()).isEqualTo("kommentar");
        assertThat(k.body().at("/verlauf/1/person").asText()).isEqualTo("Murat Demirci");
        Antwort aendern = ruf(w, "murat", HttpMethod.PUT, PFAD + "/" + eigene, Map.of("titel", "Murat ändert",
                "begruendung", "Der Verantwortliche will den Titel ändern."));
        assertThat(aendern.status()).as(aendern.text()).isEqualTo(403);
        assertThat(aendern.body().get("code").asText()).isEqualTo("recht_fehlt");
        assertThat(ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/verwerfen",
                Map.of("begruendung", "Der Verantwortliche will verwerfen.")).status()).isEqualTo(403);
        assertThat(ruf(w, "murat", HttpMethod.PUT, PFAD + "/" + eigene + "/verantwortlicher", Map.of("benutzer",
                sub(w, "peter"), "begruendung", "Der Verantwortliche gibt ab.")).status()).isEqualTo(403);

        // Eine fremde Maßnahme bleibt, wie sie war: 403 mit der nötigen Rolle von verwalten.
        for (var r : koerper("Murat meldet eine fremde Maßnahme.").entrySet()) {
            if (r.getKey().equals("verwerfen")) {
                continue;
            }
            Antwort x = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + fremde + "/" + r.getKey(), r.getValue());
            assertThat(x.status()).as(r.getKey() + " " + x.text()).isEqualTo(403);
            assertThat(x.body().get("code").asText()).isEqualTo("recht_fehlt");
        }
        // Ein anderer Kundenbereich sieht die Maßnahme nicht - auch nicht sein Murat, der dort selbst eigene_massnahme
        // hat: die Vorprüfung lässt ihn durch, der Dienst antwortet wie für eine unbekannte Kennung (404).
        for (String schritt : List.of("umgesetzt", "eintraege")) {
            assertThat(ruf(fremd, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/" + schritt,
                    koerper("Murat aus einem anderen Kundenbereich.").get(schritt)).status()).as(schritt).isEqualTo(404);
        }

        uhr(UMGESETZT);
        Antwort um = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/umgesetzt", Map.of("am", "2028-01-22",
                "begruendung", "Zeitschaltung an den Maschinen 3 bis 6 eingebaut."));
        assertThat(um.status()).as(um.text()).isEqualTo(200);
        assertThat(um.body().get("zustand").asText()).isEqualTo("umgesetzt");
        // Bewerten bleibt bei verbesserung.abschliessen - auch an der eigenen Maßnahme.
        assertThat(ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/bewertungen", Map.of("ergebnis",
                "nicht_messbar", "begruendung", "Der Verantwortliche will selbst bewerten.")).status()).isEqualTo(403);

        // Leserin am Werk (LE S): dieselben zwei Schritte an ihrer Maßnahme.
        assertThat(ruf(w, "lena", HttpMethod.POST, PFAD + "/" + vonLena + "/eintraege", Map.of("text",
                "Leuchten sind bestellt.")).status()).isEqualTo(201);
        assertThat(ruf(w, "lena", HttpMethod.POST, PFAD + "/" + vonLena + "/umgesetzt", Map.of("am", "2028-01-22",
                "begruendung", "Halle 1 leuchtet mit LED.")).status()).isEqualTo(200);
        assertThat(ruf(w, "lena", HttpMethod.POST, PFAD + "/" + fremde + "/eintraege", Map.of("text",
                "Lena kommentiert fremd.")).status()).isEqualTo(403);

        // Einsicht nie ein Eintrag (AP-19 RE3) - auch als Verantwortliche.
        for (var r : koerper("Einsicht meldet.").entrySet()) {
            if (r.getKey().equals("verwerfen")) {
                continue;
            }
            Antwort x = ruf(w, "robert", HttpMethod.POST, PFAD + "/" + vonRobert + "/" + r.getKey(), r.getValue());
            assertThat(x.status()).as(r.getKey() + " " + x.text()).isEqualTo(403);
        }
        assertThat(root.queryForObject("SELECT zustand FROM massnahme WHERE id = ?::uuid", String.class, vonRobert))
                .isEqualTo("geplant");
        assertThat(root.queryForObject("SELECT zustand FROM massnahme WHERE id = ?::uuid", String.class, fremde))
                .isEqualTo("geplant");
    }

    /**
     * Entscheid 8 an den Grenzen (Review r2 SOLLTE-2, Anhang C): der Kennzahl-Pfad trägt wie der Standort-Pfad; eine
     * Maßnahme außerhalb der eigenen Sicht (an ST-2, am Unternehmen) bleibt 404, auch als Verantwortlicher - es wird
     * nichts geschrieben; wer nicht mehr verantwortlich ist, verliert beide Schritte (403); Vier-Augen bleibt bei
     * {@code verbesserung.abschliessen}, auch an der eigenen Maßnahme. Entschieden wird über den geprüften Zwilling
     * {@code RechteAbleitung.eigeneMassnahme} (Vektoren {@code e8-*}).
     */
    @Test
    void eigeneMassnahmeKennzahlPfadStandortZaunUnternehmenWechselUndVierAugen() throws Exception {
        Welt w = welt();
        // (a) Kennzahl-Pfad: R3 an KZ-0004 (Geltung ST-1), verantwortlich Murat (bedienberechtigt an ST-1).
        String r3 = anlegen(w, mitMessgrundlage(w, RU.get("M-2028-0001")), "murat");
        Antwort k = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + r3 + "/eintraege", Map.of("text", "Zeitschaltuhren bestellt."));
        assertThat(k.status()).as(k.text()).isEqualTo(201);

        // (b) Standort-Zaun: an ST-2 sieht Murat nichts - dieselbe Antwort wie für eine unbekannte Kennung.
        String st2 = anlegen(w, vonHand(w, w.st2()), "murat");
        // (c) Am Unternehmen (ohne Standort) ebenso: Murat hat nur ST-1.
        String firma = anlegen(w, vonHand(w, null), "murat");
        for (String id : List.of(st2, firma)) {
            for (String schritt : List.of("umgesetzt", "eintraege")) {
                Antwort x = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + id + "/" + schritt,
                        koerper("Murat außerhalb seiner Sicht.").get(schritt));
                assertThat(x.status()).as(schritt + " " + x.text()).isEqualTo(404);
            }
            assertThat(root.queryForObject("SELECT zustand FROM massnahme WHERE id = ?::uuid", String.class, id))
                    .isEqualTo("geplant");
            assertThat(root.queryForObject("SELECT count(*) FROM massnahme_aenderung WHERE massnahme_id = ?::uuid "
                    + "AND art = 'kommentar'", Integer.class, id)).isZero();
        }

        // (d) Wechsel des Verantwortlichen: danach hat Murat an der R3 keinen der beiden Schritte mehr.
        Antwort wechsel = ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + r3 + "/verantwortlicher", Map.of("benutzer",
                sub(w, "peter"), "begruendung", "Peter übernimmt die Werkzeugheizungen."));
        assertThat(wechsel.status()).as(wechsel.text()).isEqualTo(200);
        for (String schritt : List.of("umgesetzt", "eintraege")) {
            Antwort x = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + r3 + "/" + schritt,
                    koerper("Murat ist nicht mehr verantwortlich.").get(schritt));
            assertThat(x.status()).as(schritt + " " + x.text()).isEqualTo(403);
            assertThat(x.body().get("code").asText()).isEqualTo("recht_fehlt");
        }

        // (e) Vier-Augen an der eigenen, umgesetzten Maßnahme: beantragen, freigeben, ablehnen bleiben 403.
        String eigene = anlegen(w, mitMessgrundlage(w, RU.get("M-2028-0001")), "murat");
        uhr(UMGESETZT);
        Antwort um = ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/umgesetzt", Map.of("am", "2028-01-22",
                "begruendung", "Zeitschaltung an den Maschinen 3 bis 6 eingebaut."));
        assertThat(um.status()).as(um.text()).isEqualTo(200);
        Map<String, Object> belegt = Map.of("ergebnis", "belegt", "begruendung", "Der Verantwortliche will selbst belegen.");
        for (var x : List.of(ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/bewertungen/beantragen", belegt),
                ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/bewertungen/freigeben", Map.of()),
                ruf(w, "murat", HttpMethod.POST, PFAD + "/" + eigene + "/bewertungen/ablehnen",
                        Map.of("begruendung", "Der Verantwortliche lehnt ab.")))) {
            assertThat(x.status()).as(x.text()).isEqualTo(403);
        }
    }

    /** Eine weitere Person mit einer Rolle (am Standort bzw. unternehmensweit), aktiv seit 2024. */
    private void person(Welt w, String person, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", w.mandant(), sub(w, person), person.equals("lena") ? "Lena Brandt" : "Robert Fink");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01', 'Europe/Berlin')", w.mandant(), sub(w, person), rolle, standort);
    }

    /** Legt die Maßnahme als Ines Kaltenbach an, verantwortlich {@code person}; die Kennung. */
    private String anlegen(Welt w, Map<String, Object> body, String person) throws Exception {
        body.put("verantwortlich", sub(w, person));
        Antwort a = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return a.body().get("id").asText();
    }

    // ================================================================================ Herkunft aus dem Energiemanagement (AP-19 IP-17)

    /**
     * R10 (W1, W4, W14; FS3): M-2029-0001 entsteht mit Herkunft {@code nichtkonformitaet} an der offenen Feststellung
     * F-2029-0001 — bis IP-17 lehnte die Route das Wort ab (400) und der CHECK die Zeile ({@code ELSE false}). Eine
     * unbekannte Kennung ist 422 {@code herkunft_kennung}, eine abgeschlossene Feststellung 422
     * {@code feststellung_nicht_offen}, ein geplantes Audit 422 {@code audit_nicht_durchgefuehrt}; ein Beschluss der
     * Managementbewertung ist bis IP-23 unbekannt. Außerhalb des Zauns sieht der Bearbeiter die Feststellung am
     * Unternehmen nicht — dieselbe Antwort wie unbekannt, kein Hinweis auf ihre Existenz.
     */
    @Test
    void r10HerkunftAusFeststellungAuditUndManagementbewertung() throws Exception {
        Welt w = welt();
        UUID cb = root.queryForObject("INSERT INTO energiemanagement_person (tenant_id, name, funktion, kuerzel, actor_sub, "
                + "actor_name, actor_art) VALUES (?, 'Claudia Berger', 'Controlling', 'CB', 'IK', 'Ines Kaltenbach', "
                + "'kunde') RETURNING id", UUID.class, w.mandant());
        root.update("INSERT INTO internes_audit (tenant_id, kennzeichen, titel, termin, auditor_ids, unabhaengigkeit, was, "
                + "woran, verantwortlich_sub, verantwortlich_name, verantwortlich_konto, actor_sub, actor_name, actor_art, "
                + "angelegt_am) VALUES (?, 'AU-2029-0001', 'Internes Audit 2029', '2029-01-22', ?::uuid[], 'Claudia Berger "
                + "(Controlling) gehört nicht zum Energieteam.', 'Bezugsbasen und Energieziel', 'Energiepolitik D-0001 "
                + "Fassung 1', ?, 'Ines Kaltenbach', 'benutzer', 'IK', 'Ines Kaltenbach', 'kunde', '2029-01-10 09:00+01')",
                w.mandant(), "{" + cb + "}", sub(w, "ines"));
        UUID f1 = feststellung(w, cb, "F-2029-0001", null);
        UUID f2 = feststellung(w, cb, "F-2029-0002", null);
        feststellung(w, cb, "F-2029-0003", w.st1());
        String kopie = "{\"am\":\"2029-01-24\",\"feststellung\":\"F-2029-0002\",\"massnahmen\":[]}";
        root.update("INSERT INTO feststellung_wirksamkeit (tenant_id, feststellung_id, ergebnis, begruendung, "
                + "entschieden_von, entschieden_tag, kopie, pruefsumme, vieraugen, status, freigabe_sub, freigabe_name, "
                + "freigabe_rolle, freigabe_art, freigabe_am) VALUES (?, ?, 'ohne_massnahme', 'Die sofortige Behebung "
                + "genügt.', ?, '2029-01-24', ?, bericht_pruefsumme(?), false, 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', '2029-01-24 10:00+01')", w.mandant(), f2, cb, kopie, kopie);
        assertThat(root.queryForList("SELECT zustand FROM feststellung WHERE id IN (?, ?) ORDER BY kennzeichen",
                String.class, f1, f2)).containsExactly("offen", "abgeschlossen");
        uhr(Instant.parse("2029-01-26T09:00:00Z"));

        JsonNode r10 = MassnahmeWelt.REFERENZ.at("/massnahmen_1_10/0");
        Map<String, Object> body = vonHand(w, null);
        body.put("titel", r10.get("titel").asText());
        body.put("verantwortlich", sub(w, "jonas"));
        body.put("termin", r10.get("termin").asText());
        body.put("erwartete_wirkung_wortlaut", r10.at("/erwartete_wirkung/wortlaut").asText());
        body.put("herkunft", r10.at("/herkunft/art").asText());
        Antwort ohneKennung = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(ohneKennung.status()).as(ohneKennung.text()).isEqualTo(400);
        for (String[] fall : new String[][] {{"AU-2029-0001", "400", "anfrage_ungueltig"},
            {"F-2029-0099", "422", "herkunft_kennung"}, {"F-2029-0002", "422", "feststellung_nicht_offen"}}) {
            body.put("herkunft_kennung", fall[0]);
            Antwort a = ruf(w, "ines", HttpMethod.POST, PFAD, body);
            assertThat(a.status()).as(fall[0] + " " + a.text()).isEqualTo(Integer.parseInt(fall[1]));
            assertThat(a.body().get("code").asText()).as(fall[0]).isEqualTo(fall[2]);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();

        body.put("herkunft_kennung", r10.at("/herkunft/kennung").asText());
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        JsonNode m = neu.body();
        assertThat(m.get("kennzeichen").asText()).isEqualTo(r10.get("kennzeichen").asText());
        assertThat(m.at("/herkunft/art").asText()).isEqualTo("nichtkonformitaet");
        // Ohne Angabe der Art dieselbe Ableitung wie Migration, Trigger und Portal: aus einer Feststellung organisatorisch.
        assertThat(body).doesNotContainKey("art");
        assertThat(m.get("art").asText()).isEqualTo("organisatorisch");
        assertThat(m.at("/herkunft/kennung").asText()).isEqualTo("F-2029-0001");
        assertThat(m.get("messgrundlage").isNull()).isTrue();
        assertThat(m.at("/ohne_messgrundlage/kennzeichen").asText()).isEqualTo("ohne Messgrundlage — Wirkung nicht messbar");
        assertThat(root.queryForObject("SELECT (neu ->> 'herkunft') || ' ' || (neu ->> 'herkunft_kennung') FROM "
                + "massnahme_aenderung WHERE massnahme_id = ?::uuid", String.class, m.get("id").asText()))
                .isEqualTo("nichtkonformitaet F-2029-0001");

        // Das interne Audit: erst durchgeführt (IA1), dann Herkunft eines Hinweises.
        body.put("herkunft", "audit");
        body.put("herkunft_kennung", "AU-2029-0001");
        Antwort geplant = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(geplant.status()).as(geplant.text()).isEqualTo(422);
        assertThat(geplant.body().get("code").asText()).isEqualTo("audit_nicht_durchgefuehrt");
        root.update("UPDATE internes_audit SET zustand = 'durchgefuehrt', durchgefuehrt_am = '2029-01-22' "
                + "WHERE tenant_id = ?", w.mandant());
        Antwort ausAudit = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(ausAudit.status()).as(ausAudit.text()).isEqualTo(201);
        assertThat(ausAudit.body().at("/herkunft/kennung").asText()).isEqualTo("AU-2029-0001");
        assertThat(ausAudit.body().get("art").asText()).isEqualTo("organisatorisch");

        // Die Managementbewertung gibt es erst mit IP-23: jeder Beschluss ist unbekannt; das Muster ist BR-…/Bn.
        body.put("herkunft", "managementbewertung");
        body.put("herkunft_kennung", "BR-2029-0001/B2");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD, body).body().get("code").asText()).isEqualTo("herkunft_kennung");
        body.put("herkunft_kennung", "BR-2029-0001");
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD, body).status()).isEqualTo(400);

        // Zaun: der Bearbeiter an ST-1 sieht F-2029-0001 (am Unternehmen) nicht, F-2029-0003 (an ST-1) schon.
        Map<String, Object> be = vonHand(w, w.st1());
        be.put("herkunft", "nichtkonformitaet");
        be.put("herkunft_kennung", "F-2029-0001");
        Antwort beFirma = ruf(w, "peter", HttpMethod.POST, PFAD, be);
        assertThat(beFirma.status()).as(beFirma.text()).isEqualTo(422);
        assertThat(beFirma.body().get("code").asText()).isEqualTo("herkunft_kennung");
        be.put("herkunft_kennung", "F-2029-0003");
        Antwort beSt1 = ruf(w, "peter", HttpMethod.POST, PFAD, be);
        assertThat(beSt1.status()).as(beSt1.text()).isEqualTo(201);
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme WHERE tenant_id = ?", Integer.class,
                w.mandant())).isEqualTo(3);
    }

    /** Eine offene Feststellung (Quelle eigene), festgestellt von CB am 22.01.2029, verantwortlich Jonas. */
    private UUID feststellung(Welt w, UUID festgestelltVon, String kennzeichen, UUID standort) {
        return root.queryForObject("INSERT INTO feststellung (tenant_id, kennzeichen, quelle_art, wortlaut, "
                + "vorgabe_wortlaut, standort_id, festgestellt_von, festgestellt_am, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, actor_sub, actor_name, actor_art, angelegt_am) VALUES (?, ?, 'eigene', "
                + "'Wer die Bezugsbasen pflegt und freigibt, ist nicht festgelegt.', '„Wir legen fest, wer im "
                + "Energiemanagement wofür zuständig ist.“', ?, ?, '2029-01-22', ?, 'Jonas Wendlinger', 'benutzer', 'IK', "
                + "'Ines Kaltenbach', 'kunde', '2029-01-23 10:00+01') RETURNING id", UUID.class, w.mandant(), kennzeichen,
                standort, festgestelltVon, sub(w, "jonas"));
    }

    // ================================================================================ Wirkung (IP-11)

    /**
     * R5/R6 (WK1–WK3, WK5): M-2028-0001 umgesetzt am 22.01.2028. Am 15.11.2028 (Oktober endgültig seit 07.11.) liest
     * der Leser Februar bis Oktober 2028 gegen Fassung 2: 2,4 % weniger — Σ 647 000 ÷ Σ 663 139 kWh, nie das Mittel der
     * Monats-Δ (−2,3 %, NW-1) —, 8 von 12, vorläufig, März ausgeschlossen (Produktionsmenge außerhalb), Juli
     * {@code schlechter} gezählt; der Januar 2028 war 3,5 % besser und ist der Umsetzungsmonat — nicht gezählt (R6).
     * Am 10.02.2029: 2,7 % weniger, 11 von 12, nicht mehr vorläufig. Erwartete Wirkung und Ausgangslage daneben,
     * byte-gleich; kein Satz nennt eine Ursache.
     */
    @Test
    void r5r6WirkungNachDerUmsetzung() throws Exception {
        Welt w = welt();
        String[] m = umgesetzteMassnahme(w);
        String id = m[0];
        nachher(w, "2028-01", "2028-10");

        uhr(Instant.parse("2028-11-15T09:00:00Z"));
        Antwort a = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/wirkung", null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        JsonNode r = a.body();
        assertThat(r.get("grund").isNull()).isTrue();
        assertThat(r.get("abruf").asText()).isEqualTo("2028-11-15");
        assertThat(r.get("umsetzungsmonat").asText()).isEqualTo("2028-01");
        assertThat(r.get("nachher_von").asText()).isEqualTo("2028-02");
        assertThat(r.get("nachher_bis").asText()).isEqualTo("2029-01");
        assertThat(r.get("monate_text").asText()).isEqualTo("8 von 12");
        assertThat(r.get("monate_bewertbar").asInt()).isEqualTo(8);
        assertThat(r.get("monate_endgueltig").asInt()).isEqualTo(9);
        assertThat(r.get("monate_soll").asInt()).isEqualTo(12);
        assertThat(r.get("vorlaeufig").asBoolean()).isTrue();
        JsonNode summe = r.get("summe");
        assertThat(summe.get("delta_prozent").asText()).isEqualTo("-2.4");
        assertThat(summe.get("urteil").asText()).isEqualTo("besser");
        assertThat(zahl(summe.get("gemessen"))).isEqualByComparingTo("647000");
        assertThat(zahl(summe.get("erwartet")).setScale(0, RoundingMode.HALF_UP)).isEqualByComparingTo("663139");
        assertThat(zahl(summe.get("band_prozent"))).isEqualByComparingTo("2");
        assertThat(summe.get("kennzeichen").toString()).contains("8 von 12 Monaten");
        assertThat(r.get("nicht_gezaehlt").toString()).isEqualTo("[{\"monat\":\"2028-01\",\"grund\":\"umsetzungsmonat\"},"
                + "{\"monat\":\"2028-03\",\"grund\":\"variable_ausserhalb\"}]");

        JsonNode monate = r.get("monate");
        assertThat(monate).hasSize(13);
        JsonNode januar = monate.get(0);
        assertThat(januar.get("periode").asText()).isEqualTo("2028-01");
        assertThat(januar.get("gezaehlt").asBoolean()).isFalse();
        assertThat(januar.get("grund").asText()).isEqualTo("umsetzungsmonat");
        assertThat(januar.get("satz").asText()).isEqualTo("Januar 2028: Umsetzungsmonat — nicht gezählt.");
        assertThat(januar.at("/vergleich/bereinigt/urteil").asText()).isEqualTo("besser");
        assertThat(januar.at("/vergleich/bereinigt/delta_prozent").asText()).isEqualTo("-3.5");
        JsonNode februar = monate.get(1);
        assertThat(februar.get("gezaehlt").asBoolean()).isTrue();
        assertThat(februar.get("satz").isNull()).isTrue();
        assertThat(februar.get("kennzahl_roh").asText()).startsWith("0.2672");
        assertThat(februar.at("/vergleich/bereinigt/urteil").asText()).isEqualTo("im_rahmen");
        assertThat(februar.at("/vergleich/bereinigt/gemessen/version").asInt()).isEqualTo(1);
        assertThat(februar.at("/vergleich/bereinigt/fassung/fassung").asInt()).isEqualTo(2);
        JsonNode maerz = monate.get(2);
        assertThat(maerz.get("gezaehlt").asBoolean()).isFalse();
        assertThat(maerz.get("grund").asText()).isEqualTo("variable_ausserhalb");
        assertThat(maerz.get("satz").asText()).isEqualTo("März 2028: nicht bewertbar — Produktionsmenge Spritzguss "
                + "390 000 kg außerhalb der Bezugsbasis (228 600–375 100 kg).");
        JsonNode juli = monate.get(6);
        assertThat(juli.get("gezaehlt").asBoolean()).isTrue();
        assertThat(juli.at("/vergleich/bereinigt/urteil").asText()).isEqualTo("schlechter");
        assertThat(juli.at("/vergleich/bereinigt/delta_prozent").asText()).isEqualTo("2.5");
        JsonNode november = monate.get(10);
        assertThat(november.get("periode").asText()).isEqualTo("2028-11");
        assertThat(november.get("endgueltig").asBoolean()).isFalse();
        assertThat(november.get("gezaehlt").asBoolean()).isFalse();
        assertThat(november.get("grund").isNull()).isTrue();

        String satz = r.get("satz").asText();
        assertThat(satz).isEqualTo("Wirkung von M-2028-0001, beobachtet: 2,4 % weniger Strom als die Bezugsbasis "
                + "erwarten lässt (Februar bis Oktober 2028, 8 von 12 Monaten; März 2028 nicht bewertbar: Produktionsmenge "
                + "Spritzguss außerhalb der Bezugsbasis) — erwartet waren 3 % weniger. Ob die Maßnahme das bewirkt hat, "
                + "sagt eine Person.");
        assertThat(a.text()).doesNotContain("hat gewirkt").doesNotContain("Einsparung durch").doesNotContain("Ursache");
        // Erwartete Wirkung und Ausgangslage daneben: die Kopie aus IP-10, byte-gleich.
        assertThat(r.at("/massnahme/erwartete_wirkung_prozent").asText()).isEqualTo("-3.0");
        assertThat(r.at("/massnahme/messgrundlage/ausgangslage").asText()).isEqualTo(m[1]);
        assertThat(r.at("/massnahme/messgrundlage/pruefsumme").asText()).isEqualTo(m[2]);
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme_aenderung WHERE massnahme_id = ?", Integer.class,
                UUID.fromString(id))).as("ein Leser schreibt nichts").isEqualTo(2);

        nachher(w, "2028-11", "2029-01");
        uhr(Instant.parse("2029-02-10T09:00:00Z"));
        JsonNode voll = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/wirkung", null).body();
        assertThat(voll.at("/summe/delta_prozent").asText()).isEqualTo("-2.7");
        assertThat(zahl(voll.at("/summe/gemessen"))).isEqualByComparingTo("876700");
        assertThat(zahl(voll.at("/summe/erwartet")).setScale(0, RoundingMode.HALF_UP)).isEqualByComparingTo("900892");
        assertThat(voll.get("monate_text").asText()).isEqualTo("11 von 12");
        assertThat(voll.get("monate_endgueltig").asInt()).isEqualTo(12);
        assertThat(voll.get("vorlaeufig").asBoolean()).isFalse();
        assertThat(voll.get("satz").asText()).contains("2,7 % weniger Strom").contains("(Februar 2028 bis Januar 2029, "
                + "11 von 12 Monaten; März 2028 nicht bewertbar");

        // WK2: ein längerer Zeitraum ist eine Wahl beim Abruf — bis 36, sonst 400.
        JsonNode lang = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/wirkung?monate=24", null).body();
        assertThat(lang.get("monate_soll").asInt()).isEqualTo(24);
        assertThat(lang.get("nachher_bis").asText()).isEqualTo("2030-01");
        assertThat(lang.get("monate_text").asText()).isEqualTo("11 von 24");
        assertThat(lang.get("vorlaeufig").asBoolean()).isTrue();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/wirkung?monate=36", null).status()).isEqualTo(200);
        for (String q : List.of("monate=37", "monate=11", "monate=zwoelf", "monate=-12", "zeitraum=12")) {
            Antwort x = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/wirkung?" + q, null);
            assertThat(x.status()).as(q + " " + x.text()).isEqualTo(400);
            assertThat(x.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
        }
    }

    /**
     * Verbessern-Konzept v1, Entscheide 6 und 13: die Art der Maßnahme (gemessen genau mit Kennzahl) und die Schätzung in
     * kWh im Jahr - ohne Kennzahl von der Person (nur weniger Energie, nie organisatorisch), mit Kennzahl umgerechnet über
     * die gemessene Menge der zwölf abgeschlossenen Monate vor heute, wie {@code GET …/schaetzung} sie vorab zeigt.
     */
    @Test
    void artUndSchaetzungInKwhImJahr() throws Exception {
        Welt w = welt();
        Map<String, Object> organisatorisch = vonHand(w, null);
        organisatorisch.put("art", "organisatorisch");
        Antwort o = ruf(w, "ines", HttpMethod.POST, PFAD, organisatorisch);
        assertThat(o.status()).as(o.text()).isEqualTo(201);
        assertThat(o.body().get("art").asText()).isEqualTo("organisatorisch");
        assertThat(o.body().get("erwartete_einsparung").isNull()).isTrue();
        assertThat(o.body().at("/verlauf/0/neu/art").asText()).isEqualTo("organisatorisch");

        Map<String, Object> geschaetzt = vonHand(w, null);
        geschaetzt.put("art", "nicht_gemessen");
        geschaetzt.put("erwartete_einsparung_kwh_jahr", 12000);
        Antwort g = ruf(w, "ines", HttpMethod.POST, PFAD, geschaetzt);
        assertThat(g.status()).as(g.text()).isEqualTo(201);
        assertThat(g.body().get("art").asText()).isEqualTo("nicht_gemessen");
        assertThat(g.body().at("/erwartete_einsparung/kwh_jahr").asText()).isEqualTo("12000");
        assertThat(g.body().at("/erwartete_einsparung/grundlage_kwh").isNull()).isTrue();
        // Ohne Angabe: die Art aus der Zeile (von Hand ohne Kennzahl nicht gemessen; aus Feststellung oder Audit
        // organisatorisch, siehe R10).
        Antwort ohneArt = ruf(w, "ines", HttpMethod.POST, PFAD, vonHand(w, null));
        assertThat(ohneArt.body().get("art").asText()).as(ohneArt.text()).isEqualTo("nicht_gemessen");

        JsonNode r3 = RU.get("M-2028-0001");
        for (Object[] fall : new Object[][] {
            {vonHand(w, null), Map.of("art", "organisatorisch", "erwartete_einsparung_kwh_jahr", 500), 422,
                "einsparung_organisatorisch"},
            {vonHand(w, null), Map.of("art", "gemessen"), 422, "art_ohne_kennzahl"},
            {mitMessgrundlage(w, r3), Map.of("art", "nicht_gemessen"), 422, "art_mit_kennzahl"},
            {mitMessgrundlage(w, r3), Map.of("erwartete_einsparung_kwh_jahr", 30000), 422, "einsparung_mit_kennzahl"},
            {vonHand(w, null), Map.of("art", "geschaetzt"), 400, "anfrage_ungueltig"},
            {vonHand(w, null), Map.of("erwartete_einsparung_kwh_jahr", -400), 400, "anfrage_ungueltig"},
            {vonHand(w, null), Map.of("erwartete_einsparung_kwh_jahr", 120.5), 400, "anfrage_ungueltig"}}) {
            @SuppressWarnings("unchecked")
            Map<String, Object> body = new LinkedHashMap<>((Map<String, Object>) fall[0]);
            @SuppressWarnings("unchecked")
            Map<String, Object> mehr = (Map<String, Object>) fall[1];
            body.putAll(mehr);
            Antwort x = ruf(w, "ines", HttpMethod.POST, PFAD, body);
            assertThat(x.status()).as(mehr + " " + x.text()).isEqualTo(fall[2]);
            assertThat(x.body().get("code").asText()).as(mehr.toString()).isEqualTo(fall[3]);
        }

        // Am Anlegetag fehlen der Kennzahl die zwölf Monate davor: keine Zahl, mit Grund - angelegt wird trotzdem.
        String kz = w.kz4().toString();
        JsonNode frueh = ruf(w, "ines", HttpMethod.GET, PFAD + "/schaetzung?kennzahl=" + kz + "&prozent=-3", null).body();
        assertThat(frueh.get("kwh_jahr").isNull()).isTrue();
        assertThat(frueh.get("grund").asText()).isEqualTo("monate_fehlen");
        assertThat(frueh.get("grundlage_monate").asText()).isEqualTo("2027-01/2027-12");
        Antwort ohneGrundlage = ruf(w, "ines", HttpMethod.POST, PFAD, mitMessgrundlage(w, r3));
        assertThat(ohneGrundlage.status()).as(ohneGrundlage.text()).isEqualTo(201);
        assertThat(ohneGrundlage.body().get("art").asText()).isEqualTo("gemessen");
        assertThat(ohneGrundlage.body().get("erwartete_einsparung").isNull()).isTrue();

        // Gilt die freigegebene Fassung erst ab morgen, nennt die Schätzung denselben Grund wie das Anlegen (M2) -
        // keine Zahl, die das Anlegen danach ablehnt.
        LocalDate giltAb = root.queryForObject("SELECT min(f.gilt_ab) FROM bezugsbasis_fassung f JOIN bezugsbasis b "
                + "ON b.id = f.bezugsbasis_id WHERE b.kennzahl_id = ? AND f.freigabe_status = 'freigegeben'",
                LocalDate.class, w.kz4());
        uhr(giltAb.minusDays(1).atTime(9, 0).toInstant(ZoneOffset.UTC));
        JsonNode vorGeltung = ruf(w, "ines", HttpMethod.GET, PFAD + "/schaetzung?kennzahl=" + kz + "&prozent=-3", null)
                .body();
        assertThat(vorGeltung.get("kwh_jahr").isNull()).isTrue();
        assertThat(vorGeltung.get("grund").asText()).as(vorGeltung.toString()).isEqualTo("kennzahl_ohne_bezugsbasis");
        Antwort vorGeltungAnlegen = ruf(w, "ines", HttpMethod.POST, PFAD, mitMessgrundlage(w, r3));
        assertThat(vorGeltungAnlegen.status()).as(vorGeltungAnlegen.text()).isEqualTo(422);
        assertThat(vorGeltungAnlegen.body().get("code").asText()).isEqualTo("kennzahl_ohne_bezugsbasis");

        // Am 10.02.2029 liegen Februar 2028 bis Januar 2029 vor: 3 % weniger von ihrer Menge, auf ganze kWh.
        nachher(w, "2028-01", "2029-01");
        uhr(Instant.parse("2029-02-10T09:00:00Z"));
        BigDecimal menge = root.queryForObject("SELECT sum(zaehler) FROM kennzahl_wert WHERE tenant_id = ? "
                + "AND kennzahl_id = ? AND periode_art = 'monat' AND periode_von >= DATE '2028-02-01' "
                + "AND periode_von < DATE '2029-02-01'", BigDecimal.class, w.mandant(), w.kz4());
        Antwort sch = ruf(w, "ines", HttpMethod.GET, PFAD + "/schaetzung?kennzahl=" + kz + "&prozent=-3", null);
        assertThat(sch.status()).as(sch.text()).isEqualTo(200);
        assertThat(sch.body().get("grund").isNull()).as(sch.text()).isTrue();
        assertThat(sch.body().get("grundlage_monate").asText()).isEqualTo("2028-02/2029-01");
        assertThat(sch.body().get("monate_mit_wert").asInt()).isEqualTo(12);
        assertThat(zahl(sch.body().get("grundlage_kwh"))).isEqualByComparingTo(menge.setScale(0, RoundingMode.HALF_UP));
        BigDecimal erwartet = menge.multiply(new BigDecimal("0.03")).setScale(0, RoundingMode.HALF_UP);
        assertThat(zahl(sch.body().get("kwh_jahr"))).isEqualByComparingTo(erwartet);
        // „Mehr“ steht als negative Zahl da.
        assertThat(zahl(ruf(w, "ines", HttpMethod.GET, PFAD + "/schaetzung?kennzahl=" + kz + "&prozent=2", null).body()
                .get("kwh_jahr"))).isNegative();
        for (String q : List.of("kennzahl=" + kz, "prozent=-3", "kennzahl=" + kz + "&prozent=drei",
                "kennzahl=" + kz + "&prozent=0", "kennzahl=" + kz + "&prozent=-3.25", "kennzahl=" + kz + "&prozent=-3&x=1",
                "kennzahl=keine-id&prozent=-3")) {
            Antwort x = ruf(w, "ines", HttpMethod.GET, PFAD + "/schaetzung?" + q, null);
            assertThat(x.status()).as(q + " " + x.text()).isEqualTo(400);
        }
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/schaetzung?kennzahl=" + UUID.randomUUID() + "&prozent=-3",
                null).status()).isEqualTo(404);

        // Anlegen hält dieselbe Zahl samt Grundlage fest; Ändern der Prozent rechnet neu, ohne Prozent bleibt keine Zahl.
        Map<String, Object> neu = mitMessgrundlage(w, r3);
        neu.put("monate", "2029-01");
        Antwort mit = ruf(w, "ines", HttpMethod.POST, PFAD, neu);
        assertThat(mit.status()).as(mit.text()).isEqualTo(201);
        assertThat(zahl(mit.body().at("/erwartete_einsparung/kwh_jahr"))).isEqualByComparingTo(erwartet);
        assertThat(mit.body().at("/erwartete_einsparung/grundlage_monate").asText()).isEqualTo("2028-02/2029-01");
        String id = mit.body().get("id").asText();
        Antwort vier = ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + id, Map.of("erwartete_wirkung_prozent", -4,
                "begruendung", "Nach der Messung an Maschine 3 eher vier Prozent."));
        assertThat(vier.status()).as(vier.text()).isEqualTo(200);
        assertThat(zahl(vier.body().at("/erwartete_einsparung/kwh_jahr")))
                .isEqualByComparingTo(menge.multiply(new BigDecimal("0.04")).setScale(0, RoundingMode.HALF_UP));
        Antwort kwhMitKennzahl = ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + id, Map.of("erwartete_einsparung_kwh_jahr",
                40000, "begruendung", "Die Zahl in kWh von Hand setzen."));
        assertThat(kwhMitKennzahl.status()).as(kwhMitKennzahl.text()).isEqualTo(422);
        assertThat(kwhMitKennzahl.body().get("code").asText()).isEqualTo("einsparung_mit_kennzahl");
        // Ohne Kennzahl ändert die Person ihre Schätzung selbst.
        Antwort mehr = ruf(w, "ines", HttpMethod.PUT, PFAD + "/" + g.body().get("id").asText(), Map.of(
                "erwartete_einsparung_kwh_jahr", 15000, "begruendung", "Nach dem Rundgang mit dem Lieferanten."));
        assertThat(mehr.status()).as(mehr.text()).isEqualTo(200);
        assertThat(mehr.body().at("/erwartete_einsparung/kwh_jahr").asText()).isEqualTo("15000");
        assertThat(mehr.body().at("/verlauf/1/neu/erwartete_einsparung_kwh_jahr").asText()).isEqualTo("15000");
    }

    /**
     * Entscheid 12 (Befund 6): „Weiß ich noch nicht“ - eine gemessene Maßnahme ohne Zahl der Person bekommt den Satz
     * {@code wirkung_ohne_erwartung}; die Liste trägt je Maßnahme die beobachtete Wirkung in Kurzform (§6.5), dieselbe
     * Summe wie {@code …/wirkung}, und nur ab umgesetzt mit bewertbarem Monat.
     */
    @Test
    void wirkungOhneErwartungUndKurzformInDerListe() throws Exception {
        Welt w = welt();
        String mitZahl = umgesetzteMassnahme(w)[0];
        JsonNode r3 = RU.get("M-2028-0001");
        uhr(ANGELEGT);
        Map<String, Object> body = mitMessgrundlage(w, r3);
        body.remove("erwartete_wirkung_prozent");
        body.put("titel", "Kühlwasserpumpen drehzahlgeregelt betreiben");
        body.put("herkunft", "von_hand");
        body.remove("herkunft_kennung");
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        String ohneZahl = neu.body().get("id").asText();
        uhr(UMGESETZT);
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + ohneZahl + "/umgesetzt", Map.of("am", "2028-01-22",
                "begruendung", "Frequenzumrichter an beiden Pumpen eingebaut.")).status()).isEqualTo(200);
        // Eine dritte Maßnahme derselben Kennzahl, zwei Monate später umgesetzt: die Liste liest den Vergleich je
        // Kennzahl einmal über beide Zeiträume - die Kurzform bleibt genau die der eigenen Wirkung.
        Map<String, Object> spaet = mitMessgrundlage(w, r3);
        spaet.put("titel", "Trocknerluft im Spritzguss nachts abschalten");
        spaet.put("herkunft", "von_hand");
        spaet.remove("herkunft_kennung");
        Antwort s3 = ruf(w, "ines", HttpMethod.POST, PFAD, spaet);
        assertThat(s3.status()).as(s3.text()).isEqualTo(201);
        String spaetId = s3.body().get("id").asText();
        uhr(Instant.parse("2028-03-25T09:00:00Z"));
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + spaetId + "/umgesetzt", Map.of("am", "2028-03-20",
                "begruendung", "Zeitschaltung der Trocknerluft eingebaut.")).status()).isEqualTo(200);
        Antwort geplant = ruf(w, "ines", HttpMethod.POST, PFAD, vonHand(w, null));
        nachher(w, "2028-01", "2029-01");
        uhr(Instant.parse("2029-02-10T09:00:00Z"));

        JsonNode wirkung = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + ohneZahl + "/wirkung", null).body();
        assertThat(wirkung.get("energie").asText()).isEqualTo("Strom");
        assertThat(wirkung.at("/massnahme/wirkung_kurz/monate_text").asText()).isEqualTo("11 von 12");
        assertThat(wirkung.get("satz").asText()).isEqualTo("Wirkung von " + neu.body().get("kennzeichen").asText()
                + ", beobachtet: 2,7 % weniger Strom als die Bezugsbasis erwarten lässt (Februar 2028 bis Januar 2029, "
                + "11 von 12 Monaten; März 2028 nicht bewertbar: Produktionsmenge Spritzguss außerhalb der Bezugsbasis). "
                + "Eine erwartete Wirkung ist nicht genannt. Ob die Maßnahme das bewirkt hat, sagt eine Person.");

        Antwort liste = ruf(w, "ines", HttpMethod.GET, PFAD, null);
        assertThat(liste.status()).as(liste.text()).isEqualTo(200);
        Map<String, JsonNode> je = new LinkedHashMap<>();
        liste.body().get("massnahmen").forEach(m -> je.put(m.get("id").asText(), m));
        JsonNode kurz = je.get(mitZahl).get("wirkung_kurz");
        assertThat(kurz.get("delta_prozent").asText()).isEqualTo("-2.7");
        assertThat(kurz.get("richtung").asText()).isEqualTo("weniger");
        assertThat(kurz.get("urteil").asText()).isEqualTo("besser");
        assertThat(kurz.get("monate_text").asText()).isEqualTo("11 von 12");
        assertThat(kurz.get("vorlaeufig").asBoolean()).isFalse();
        assertThat(kurz.get("zeitraum_von").asText()).isEqualTo("2028-02");
        assertThat(kurz.get("zeitraum_bis").asText()).isEqualTo("2029-01");
        assertThat(zahl(kurz.get("gemessen"))).isEqualByComparingTo("876700");
        assertThat(zahl(kurz.get("erwartet")).setScale(0, RoundingMode.HALF_UP)).isEqualByComparingTo("900892");
        assertThat(zahl(kurz.get("differenz"))).isEqualByComparingTo("-24192");
        assertThat(zahl(kurz.get("erwartete_wirkung"))).isEqualByComparingTo("-27027");
        assertThat(kurz.get("einheit").asText()).isEqualTo("kWh");
        assertThat(kurz.get("energie").asText()).isEqualTo("Strom");
        assertThat(je.get(ohneZahl).at("/wirkung_kurz/erwartete_wirkung").isNull()).isTrue();
        assertThat(je.get(ohneZahl).at("/wirkung_kurz/delta_prozent").asText()).isEqualTo("-2.7");
        assertThat(je.get(geplant.body().get("id").asText()).get("wirkung_kurz").isNull()).isTrue();
        for (String id : List.of(mitZahl, ohneZahl, spaetId)) {
            JsonNode eigene = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/wirkung", null).body()
                    .at("/massnahme/wirkung_kurz");
            assertThat(je.get(id).get("wirkung_kurz")).as(id).isEqualTo(eigene);
        }
        assertThat(je.get(spaetId).at("/wirkung_kurz/zeitraum_von").asText()).isEqualTo("2028-04");
        // Die einzelne Maßnahme trägt keine Kurzform - dort steht die ganze Wirkung.
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/" + mitZahl, null).body().get("wirkung_kurz").isNull()).isTrue();
    }

    /**
     * WK4: Fassung 3 (Referenzperiode November 2027 bis Oktober 2028, gilt ab 01.11.2028) enthielte die Umsetzung —
     * November 2028 bis Januar 2029 zählen nicht ({@code basis_nach_umsetzung}); die Summe bleibt bei den acht
     * bewertbaren Monaten gegen Fassung 2.
     */
    @Test
    void wk4BasisNachDerUmsetzung() throws Exception {
        Welt w = welt();
        String id = umgesetzteMassnahme(w)[0];
        nachher(w, "2028-01", "2029-01");
        UUID bb1 = root.queryForObject("SELECT id FROM bezugsbasis WHERE tenant_id = ? AND kennzeichen = 'BB-0001'",
                UUID.class, w.mandant());
        root.update("UPDATE bezugsbasis_fassung SET gilt_bis = '2028-10-31', beendet_am = now(), beendet_grund = "
                + "'Fassung 3 mit der jüngsten Referenzperiode.' WHERE bezugsbasis_id = ? AND fassung = 2", bb1);
        fassung(w.mandant(), bb1, 3, bz1(w), "regression_eine_variable", "2027-11/2028-10", "2028-11-01", null,
                "0.2685", "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");

        uhr(Instant.parse("2029-02-10T09:00:00Z"));
        Antwort a = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/wirkung", null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        JsonNode r = a.body();
        assertThat(r.get("monate_text").asText()).isEqualTo("8 von 12");
        assertThat(r.get("vorlaeufig").asBoolean()).isFalse();
        assertThat(r.at("/summe/delta_prozent").asText()).isEqualTo("-2.4");
        assertThat(r.get("nicht_gezaehlt").findValuesAsText("grund")).containsExactly("umsetzungsmonat",
                "variable_ausserhalb", "basis_nach_umsetzung", "basis_nach_umsetzung", "basis_nach_umsetzung");
        JsonNode november = r.get("monate").get(10);
        assertThat(november.get("periode").asText()).isEqualTo("2028-11");
        assertThat(november.get("endgueltig").asBoolean()).isTrue();
        assertThat(november.get("gezaehlt").asBoolean()).isFalse();
        assertThat(november.get("grund").asText()).isEqualTo("basis_nach_umsetzung");
        assertThat(november.at("/vergleich/bereinigt/fassung/fassung").asInt()).isEqualTo(3);
        assertThat(november.get("satz").asText()).isEqualTo("November 2028: nicht bewertbar — die Bezugsbasis BB-0001, "
                + "Fassung 3 hat eine Referenzperiode (November 2027 bis Oktober 2028), die nach der Umsetzung endet; sie "
                + "enthielte die Maßnahme.");
        assertThat(r.get("satz").asText()).contains("(Februar 2028 bis Januar 2029, 8 von 12 Monaten; März 2028 nicht "
                + "bewertbar: Produktionsmenge Spritzguss außerhalb der Bezugsbasis; November 2028 nicht bewertbar: ");
    }

    /**
     * M4/R7: ohne Messgrundlage nur der Satz, keine Zahl; geplant noch keine Nachher-Monate; der Zaun wie IP-10 —
     * außerhalb 404, der Bedienberechtigte liest am eigenen Standort.
     */
    @Test
    void wirkungOhneMessgrundlageVorDerUmsetzungUndZaun() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
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
        Antwort ohne = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(ohne.status()).as(ohne.text()).isEqualTo(201);
        String ohneId = ohne.body().get("id").asText();
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + ohneId + "/umgesetzt", Map.of("am", "2028-01-19",
                "begruendung", "Leckagen geortet und abgedichtet.")).status()).isEqualTo(200);
        uhr(Instant.parse("2028-11-15T09:00:00Z"));
        Antwort a = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + ohneId + "/wirkung", null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        JsonNode r = a.body();
        assertThat(r.get("grund").asText()).isEqualTo("ohne_messgrundlage");
        assertThat(r.get("satz").asText()).isEqualTo(ohne.body().at("/ohne_messgrundlage/satz").asText())
                .contains("ohne Messgrundlage — Wirkung nicht messbar");
        for (String feld : List.of("summe", "monate_text", "monate_bewertbar", "vorlaeufig", "nachher_von")) {
            assertThat(r.get(feld).isNull()).as(feld).isTrue();
        }
        assertThat(r.get("monate")).isEmpty();
        assertThat(r.get("nicht_gezaehlt")).isEmpty();
        assertThat(a.text()).doesNotContainPattern("\\d+,\\d %");

        uhr(ANGELEGT);
        Antwort geplant = ruf(w, "ines", HttpMethod.POST, PFAD, mitMessgrundlage(w, RU.get("M-2028-0001")));
        assertThat(geplant.status()).as(geplant.text()).isEqualTo(201);
        String geplantId = geplant.body().get("id").asText();
        JsonNode vorher = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + geplantId + "/wirkung", null).body();
        assertThat(vorher.get("grund").asText()).isEqualTo("nicht_umgesetzt");
        assertThat(vorher.get("satz").isNull()).isTrue();
        assertThat(vorher.get("monate")).isEmpty();
        assertThat(vorher.get("summe").isNull()).isTrue();

        for (String pfad : List.of(PFAD + "/" + geplantId + "/wirkung", PFAD + "/" + UUID.randomUUID() + "/wirkung",
                PFAD + "/kein-id/wirkung", PFAD + "/" + geplantId + "/wirkung?monate=37")) {
            Antwort x = ruf(fremd, "ines", HttpMethod.GET, pfad, null);
            assertThat(x.status()).as(pfad + " " + x.text()).isEqualTo(404);
        }
        assertThat(ruf(w, "murat", HttpMethod.GET, PFAD + "/" + geplantId + "/wirkung", null).status()).isEqualTo(200);
    }

    // ================================================================================ Bewertung (IP-12, WK6)

    /**
     * R6 (WK6, E6 = A): am 15.11.2028 sagt Ines Kaltenbach „belegt“ mit Begründung — Stand Nr. 1 mit der Kopie der
     * Wirkung in der Form der Referenzdatei 1.9 ({@code bewertungen[0].kopie}) und genau deren Prüfsumme; ohne Stand ist
     * {@code bewertung} {@code null}. Stand Nr. 2 am selben Tag hat eine byte-gleiche Kopie; Nr. 1 bleibt unverändert.
     * Vor der Umsetzung 409; ein Ergebnis, das es nicht gibt, 400; zu kurze Begründung 422.
     */
    @Test
    void r6StandNr1BelegtMitPruefsummeUndNr2() throws Exception {
        Welt w = welt();
        String id = umgesetzteMassnahme(w)[0];
        nachher(w, "2028-01", "2028-10");
        uhr(Instant.parse("2028-11-15T09:00:00Z"));
        JsonNode ref = RU.get("M-2028-0001").at("/bewertungen/0");

        JsonNode ohne = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body();
        assertThat(ohne.get("zustand").asText()).isEqualTo("umgesetzt");
        assertThat(ohne.get("bewertung").isNull()).isTrue();
        assertThat(ohne.get("bewertung_antrag").isNull()).isTrue();
        Antwort leer = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/bewertungen", null);
        assertThat(leer.status()).as(leer.text()).isEqualTo(200);
        assertThat(leer.body().get("bewertungen")).isEmpty();

        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/bewertungen", Map.of("ergebnis", "gewirkt",
                "begruendung", ref.get("begruendung").asText())).status()).isEqualTo(400);
        Antwort kurz = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/bewertungen", Map.of("ergebnis", "belegt",
                "begruendung", "stimmt"));
        assertThat(kurz.status()).as(kurz.text()).isEqualTo(422);
        assertThat(kurz.body().get("code").asText()).isEqualTo("begruendung_fehlt");

        Antwort a = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/bewertungen", Map.of("ergebnis", "belegt",
                "begruendung", ref.get("begruendung").asText()));
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        assertThat(a.body().get("zustand").asText()).isEqualTo("bewertet");
        JsonNode b = a.body().get("bewertung");
        assertThat(b.get("stand_nr").asInt()).isEqualTo(ref.get("nr").asInt()).isEqualTo(1);
        assertThat(b.get("status").asText()).isEqualTo("bewertet");
        assertThat(b.get("ergebnis").asText()).isEqualTo("belegt");
        assertThat(b.get("vieraugen").asBoolean()).isFalse();
        assertThat(b.at("/person/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(b.get("entscheidung").isNull()).isTrue();
        assertThat(b.get("kopie").asText()).isEqualTo(BerichtRegeln.kanonisch(ref.get("kopie")));
        assertThat(b.get("pruefsumme").asText()).isEqualTo(ref.get("pruefsumme").asText());
        assertThat(b.get("satz").asText()).isEqualTo("Belegt von Ines Kaltenbach am 15.11.2028: ‚"
                + ref.get("begruendung").asText() + "‘ Beobachtet: 2,4 % weniger (8 von 12 Monaten). Stand Nr. 1, "
                + "Prüfsumme 4635…");
        assertThat(a.body().get("bewertung_antrag").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT bericht_pruefsumme(wirkung) = pruefsumme FROM massnahme_bewertung "
                + "WHERE massnahme_id = ?", Boolean.class, UUID.fromString(id))).isTrue();
        JsonNode letzte = a.body().get("verlauf").get(a.body().get("verlauf").size() - 1);
        assertThat(letzte.get("art").asText()).isEqualTo("massnahme_bewertet");
        assertThat(letzte.at("/neu/pruefsumme").asText()).isEqualTo(ref.get("pruefsumme").asText());
        assertThat(letzte.at("/neu/stand_nr").asInt()).isEqualTo(1);
        assertThat(letzte.get("begruendung").asText()).isEqualTo(ref.get("begruendung").asText());
        String nr1 = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/bewertungen", null).body().at("/bewertungen/0")
                .toString();

        // Stand Nr. 2 am selben Tag: die Kopie ist byte-gleich (kein Abrufzeitpunkt darin), Nr. 1 bleibt, wie sie war.
        Antwort zwei = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/bewertungen", Map.of("ergebnis",
                "nicht_belegt", "begruendung", "Zur Probe: ein zweiter Stand am selben Tag."));
        assertThat(zwei.status()).as(zwei.text()).isEqualTo(201);
        assertThat(zwei.body().at("/bewertung/stand_nr").asInt()).isEqualTo(2);
        assertThat(zwei.body().at("/bewertung/ergebnis").asText()).isEqualTo("nicht_belegt");
        assertThat(zwei.body().at("/bewertung/satz").isNull()).as("§5.9 hat keinen Satz für nicht belegt").isTrue();
        assertThat(zwei.body().at("/bewertung/kopie").asText()).isEqualTo(b.get("kopie").asText());
        assertThat(zwei.body().at("/bewertung/pruefsumme").asText()).isEqualTo(ref.get("pruefsumme").asText());
        JsonNode alle = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/bewertungen", null).body();
        assertThat(alle.get("bewertungen")).hasSize(2);
        assertThat(alle.at("/bewertungen/0").toString()).isEqualTo(nr1);
        assertThat(alle.get("zustand").asText()).isEqualTo("bewertet");
        assertThat(a.text()).doesNotContain("hat gewirkt");

        // Vor der Umsetzung gibt es nichts zu bewerten.
        uhr(ANGELEGT);
        String geplant = ruf(w, "ines", HttpMethod.POST, PFAD, mitMessgrundlage(w, RU.get("M-2028-0001"))).body()
                .get("id").asText();
        Antwort vorher = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + geplant + "/bewertungen", Map.of("ergebnis",
                "belegt", "begruendung", ref.get("begruendung").asText()));
        assertThat(vorher.status()).as(vorher.text()).isEqualTo(409);
        assertThat(vorher.body().get("code").asText()).isEqualTo("massnahme_nicht_umgesetzt");
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme_bewertung WHERE massnahme_id = ?", Integer.class,
                UUID.fromString(geplant))).isZero();
    }

    /**
     * R7 (M4, E2 = A): M-2028-0002 ohne Messgrundlage kann nur „nicht messbar“ bewertet werden — {@code belegt} und
     * {@code nicht_belegt} 422 {@code ohne_messgrundlage}; der Stand hat keine Kopie. Ohne Recht 403 (Bearbeiter,
     * Bedienberechtigter), außerhalb der Sicht 404.
     */
    @Test
    void r7OhneMessgrundlageNurNichtMessbarRechtUndZaun() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        uhr(Instant.parse("2028-01-20T09:00:00Z"));
        JsonNode r7 = RU.get("M-2028-0002");
        JsonNode ref = r7.at("/bewertungen/0");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("titel", "Druckluft-Leckagen orten und beseitigen");
        body.put("verantwortlich", sub(w, "ines"));
        body.put("termin", r7.get("termin").asText());
        body.put("herkunft", "einsatz");
        body.put("einsatz", w.ee3().toString());
        body.put("standort", w.st1().toString());
        body.put("erwartete_wirkung_wortlaut", r7.at("/erwartete_wirkung/wortlaut").asText());
        String id = ruf(w, "ines", HttpMethod.POST, PFAD, body).body().get("id").asText();
        uhr(Instant.parse("2028-03-28T09:00:00Z"));
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/umgesetzt", Map.of("am", "2028-03-28",
                "begruendung", "Leckagen geortet und abgedichtet.")).status()).isEqualTo(200);
        uhr(Instant.parse("2028-11-20T09:00:00Z"));
        String pfad = PFAD + "/" + id + "/bewertungen";

        for (String ergebnis : List.of("belegt", "nicht_belegt")) {
            Antwort x = ruf(w, "ines", HttpMethod.POST, pfad, Map.of("ergebnis", ergebnis, "begruendung",
                    ref.get("begruendung").asText()));
            assertThat(x.status()).as(ergebnis + " " + x.text()).isEqualTo(422);
            assertThat(x.body().get("code").asText()).isEqualTo("ohne_messgrundlage");
            assertThat(x.body().get("kennzeichen").asText()).isEqualTo("ohne Messgrundlage — Wirkung nicht messbar");
        }
        Map<String, Object> nichtMessbar = Map.of("ergebnis", "nicht_messbar", "begruendung",
                ref.get("begruendung").asText());
        for (String person : List.of("peter", "murat")) {
            Antwort x = ruf(w, person, HttpMethod.POST, pfad, nichtMessbar);
            assertThat(x.status()).as(person + " " + x.text()).isEqualTo(403);
        }
        for (String p : List.of(pfad, PFAD + "/" + UUID.randomUUID() + "/bewertungen")) {
            assertThat(ruf(fremd, "ines", HttpMethod.POST, p, nichtMessbar).status()).as(p).isEqualTo(404);
            assertThat(ruf(fremd, "ines", HttpMethod.GET, p, null).status()).as(p).isEqualTo(404);
        }
        assertThat(ruf(fremd, "ines", HttpMethod.POST, pfad + "/freigeben", Map.of()).status()).isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme_bewertung WHERE massnahme_id = ?", Integer.class,
                UUID.fromString(id))).isZero();

        Antwort a = ruf(w, "ines", HttpMethod.POST, pfad, nichtMessbar);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        assertThat(a.body().get("zustand").asText()).isEqualTo("bewertet");
        JsonNode b = a.body().get("bewertung");
        assertThat(b.get("ergebnis").asText()).isEqualTo(ref.get("ergebnis").asText());
        assertThat(b.get("kopie").isNull()).isTrue();
        assertThat(b.get("pruefsumme").isNull()).isTrue();
        assertThat(b.get("satz").asText()).isEqualTo("Bewertet am 20.11.2028 von Ines Kaltenbach: nicht messbar — ‚"
                + ref.get("begruendung").asText() + "‘");
        assertThat(ruf(w, "murat", HttpMethod.GET, pfad, null).body().get("bewertungen")).hasSize(1);
    }

    /**
     * Vier-Augen nach {@code unternehmen.vieraugen_freigabe} (WK6, §5.7, Muster IP-7): bewerten ist ein Antrag; wer
     * beantragt hat, darf nicht freigeben (422 {@code vieraugen_urheber}), der Verantwortliche der Maßnahme auch nicht
     * (422 {@code vieraugen_verantwortlich}), der Bearbeiter hat das Recht nicht (403). Eine zweite Person lehnt ab,
     * ein neuer Antrag ist Nr. 2, eine zweite Person bestätigt ihn — Ergebnis, Kopie und Prüfsumme des Antrags bleiben.
     */
    @Test
    void vierAugenNichtDerUrheberNichtDerVerantwortliche() throws Exception {
        Welt w = welt();
        String a = umgesetzteMassnahme(w, "jonas")[0];
        String b = umgesetzteMassnahme(w)[0];
        nachher(w, "2028-01", "2028-10");
        uhr(Instant.parse("2028-11-15T09:00:00Z"));
        JsonNode ref = RU.get("M-2028-0001").at("/bewertungen/0");
        Map<String, Object> belegt = Map.of("ergebnis", "belegt", "begruendung", ref.get("begruendung").asText());

        Antwort aus = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + a + "/bewertungen/beantragen", belegt);
        assertThat(aus.status()).as(aus.text()).isEqualTo(409);
        assertThat(aus.body().get("code").asText()).isEqualTo("vieraugen_aus");
        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE tenant_id = ?", w.mandant());
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + a + "/bewertungen", belegt).body().get("code")
                .asText()).isEqualTo("vieraugen_beantragen");
        assertThat(ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + a + "/bewertungen/freigeben", Map.of()).body()
                .get("code").asText()).isEqualTo("bewertung_nicht_beantragt");

        Antwort antrag = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + a + "/bewertungen/beantragen", belegt);
        assertThat(antrag.status()).as(antrag.text()).isEqualTo(201);
        assertThat(antrag.body().get("zustand").asText()).isEqualTo("umgesetzt");
        assertThat(antrag.body().get("bewertung").isNull()).isTrue();
        assertThat(antrag.body().at("/bewertung_antrag/status").asText()).isEqualTo("beantragt");
        assertThat(antrag.body().at("/bewertung_antrag/vieraugen").asBoolean()).isTrue();
        assertThat(antrag.body().at("/bewertung_antrag/satz").isNull()).isTrue();
        assertThat(antrag.body().at("/bewertung_antrag/pruefsumme").asText()).isEqualTo(ref.get("pruefsumme").asText());
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + a + "/bewertungen/beantragen", belegt).body()
                .get("code").asText()).isEqualTo("bewertung_beantragt");

        Antwort selbst = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + a + "/bewertungen/freigeben", Map.of());
        assertThat(selbst.status()).as(selbst.text()).isEqualTo(422);
        assertThat(selbst.body().get("code").asText()).isEqualTo("vieraugen_urheber");
        for (String schritt : List.of("freigeben", "ablehnen")) {
            Antwort v = ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + a + "/bewertungen/" + schritt,
                    Map.of("begruendung", "Ich bin selbst verantwortlich."));
            assertThat(v.status()).as(schritt + " " + v.text()).isEqualTo(422);
            assertThat(v.body().get("code").asText()).isEqualTo("vieraugen_verantwortlich");
        }
        assertThat(ruf(w, "peter", HttpMethod.POST, PFAD + "/" + a + "/bewertungen/freigeben", Map.of()).status())
                .isEqualTo(403);
        assertThat(root.queryForObject("SELECT status FROM massnahme_bewertung WHERE massnahme_id = ?", String.class,
                UUID.fromString(a))).isEqualTo("beantragt");

        // M-2028-0002 (verantwortlich Murat Demirci): Ines beantragt, Jonas lehnt ab, Jonas beantragt, Ines bestätigt.
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + b + "/bewertungen/beantragen", belegt).status())
                .isEqualTo(201);
        assertThat(ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + b + "/bewertungen/ablehnen", Map.of()).body()
                .get("code").asText()).isEqualTo("begruendung_fehlt");
        Antwort ab = ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + b + "/bewertungen/ablehnen",
                Map.of("begruendung", "Bitte erst die Laufzeiten der Steuerung beilegen."));
        assertThat(ab.status()).as(ab.text()).isEqualTo(200);
        assertThat(ab.body().get("zustand").asText()).isEqualTo("umgesetzt");
        assertThat(ab.body().get("bewertung_antrag").isNull()).isTrue();
        JsonNode abgelehnt = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + b + "/bewertungen", null).body()
                .at("/bewertungen/0");
        assertThat(abgelehnt.get("status").asText()).isEqualTo("abgelehnt");
        assertThat(abgelehnt.at("/entscheidung/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(abgelehnt.get("entscheidungs_begruendung").asText()).startsWith("Bitte erst");

        assertThat(ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + b + "/bewertungen/beantragen", belegt).status())
                .isEqualTo(201);
        assertThat(ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + b + "/bewertungen/freigeben", Map.of()).body()
                .get("code").asText()).isEqualTo("vieraugen_urheber");
        Antwort frei = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + b + "/bewertungen/freigeben", Map.of());
        assertThat(frei.status()).as(frei.text()).isEqualTo(200);
        JsonNode m = frei.body();
        assertThat(m.get("zustand").asText()).isEqualTo("bewertet");
        assertThat(m.at("/bewertung/stand_nr").asInt()).isEqualTo(2);
        assertThat(m.at("/bewertung/status").asText()).isEqualTo("bewertet");
        assertThat(m.at("/bewertung/person/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(m.at("/bewertung/entscheidung/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(m.at("/bewertung/pruefsumme").asText()).isEqualTo(ref.get("pruefsumme").asText());
        assertThat(m.at("/bewertung/satz").asText()).startsWith("Belegt von Jonas Wendlinger am 15.11.2028");
        assertThat(m.get("bewertung_antrag").isNull()).isTrue();
        assertThat(m.get("verlauf")).extracting(e -> e.get("art").asText()).containsExactly("massnahme_angelegt",
                "massnahme_umgesetzt", "bewertung_beantragt", "bewertung_abgelehnt", "bewertung_beantragt",
                "massnahme_bewertet");
        assertThat(ruf(w, "jonas", HttpMethod.POST, PFAD + "/" + b + "/bewertungen/ablehnen",
                Map.of("begruendung", "Zu spät, aber zur Probe.")).body().get("code").asText())
                .isEqualTo("bewertung_nicht_beantragt");
    }

    /** M-2028-0001 wie R3: angelegt am 15.01.2028, umgesetzt am 22.01.2028 — ID, Ausgangslage, Prüfsumme. */
    private String[] umgesetzteMassnahme(Welt w) throws Exception {
        return mw.umgesetzteMassnahme(w, "murat");
    }

    private String[] umgesetzteMassnahme(Welt w, String verantwortlich) throws Exception {
        return mw.umgesetzteMassnahme(w, verantwortlich);
    }

    private void nachher(Welt w, String von, String bis) {
        mw.nachher(w, von, bis);
    }

    private UUID bz1(Welt w) {
        return mw.bz1(w);
    }

    // ================================================================================ Welt (MassnahmeWelt)

    private static Map<String, Object> mitMessgrundlage(Welt w, JsonNode r3) {
        return MassnahmeWelt.mitMessgrundlage(w, r3);
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
        return MassnahmeWelt.sub(w, person);
    }

    private void fassung(UUID t, UUID basis, int nummer, UUID bz, String methode, String referenzperiode,
            String giltAb, String giltBis, String basiswert, String koeffizienten, String streuung, String von,
            String bis) {
        mw.fassung(t, basis, nummer, bz, methode, referenzperiode, giltAb, giltBis, basiswert, koeffizienten, streuung,
                von, bis);
    }

    private void uhr(Instant jetzt) {
        mw.uhr(jetzt);
    }

    private Welt welt() throws Exception {
        return mw.welt();
    }

    private static BigDecimal zahl(JsonNode n) {
        return MassnahmeWelt.zahl(n);
    }

    private Antwort ruf(Welt w, String person, HttpMethod methode, String pfad, Object body) throws Exception {
        return mw.ruf(w, person, methode, pfad, body);
    }
}
