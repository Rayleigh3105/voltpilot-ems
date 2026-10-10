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
import java.sql.Connection;
import java.sql.Date;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZoneOffset;
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
import org.springframework.beans.factory.annotation.Qualifier;
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
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Anstoß am Vorgang (UEMS AP-18 IP-17, M5, Z5, §5.6, §5.7, R12) an der Datenbank: Pfad 1 in der Transaktion der
 * Kaskade, Pfad 2 im Struktur-Läufer, die Antwort einer Person über {@code POST …/anstoesse/{aid}/antwort}.
 *
 * <p>Die Welt ist die von {@code MassnahmeApiTest} (Referenzdatei 1.9: KZ-0004 × BB-0001 Fassung 2, M-2028-0001 mit der
 * Ausgangslage Dezember 2027 — 78 000 kWh, Version 1, 12,9 % mehr als erwartet). Die Kaskade schreibt — wie
 * {@code VerbesserungNahtTest} — Version 2 des Kennzahl-Monats in der Verbindung der Verwaltungsrolle und ruft die Naht
 * dort, wie {@link KennzahlKaskade} es direkt nach dem Bezugsbasis-Anstoß tut (dass sie es tut, hält
 * {@code UemsVerbesserungFlagArchitekturTest} fest). K-2028-0001: MS-20 Dezember 2027 78 000 → 77 400 kWh.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VorgangAnstossApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/massnahmen";
    private static final Instant ANGELEGT = Instant.parse("2028-01-15T09:00:00Z");
    private static final Instant UMGESETZT = Instant.parse("2028-01-22T09:00:00Z");
    private static final Instant MAERZ = Instant.parse("2028-03-15T09:00:00Z");
    private static final Map<String, JsonNode> RU = referenz();
    private static final Map<String, JsonNode> FAELLE = faelle();
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    /** R12: K-2028-0001 freigegeben am 03.04.2028 09:20 — die Kaskade; Ines antwortet am 05.04.2028. */
    private static final Instant KASKADE = Instant.parse("2028-04-03T07:20:00Z");
    private static final Instant ANTWORT = Instant.parse("2028-04-05T08:00:00Z");
    private static final JsonNode R12 = RU.get("M-2028-0001").at("/anstoesse/0");
    private static final String K = R12.get("anlass_kennung").asText();
    private static final String BEGRUENDUNG = R12.at("/antwort/begruendung").asText();

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

    @Autowired
    VerbesserungNaht naht;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID st1, UUID st2, UUID kz4, UUID ee3) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @FunctionalInterface
    private interface Schritt {
        void fahren(Connection con) throws SQLException;
    }

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
        ReflectionTestUtils.setField(naht, "eingeschaltet", true);
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    /**
     * R12: K-2028-0001 macht Dezember 2027 zu Version 2 → genau EIN Anstoß {@code ausgangslage_korrigiert} an
     * M-2028-0001 (nicht an der verworfenen Maßnahme mit derselben Ausgangslage); ein zweiter Lauf setzt keinen zweiten;
     * die Ausgangslage bleibt byte-gleich (Version 1). Ines antwortet „bleibt“ mit Begründung — einmalig; Begründung,
     * Art, Recht (403) und Zaun (404) werden geprüft.
     */
    @Test
    void r12AusgangslageKorrigiertGenauEinAnstossUndBleibt() throws Exception {
        Welt w = welt();
        String[] m = umgesetzteMassnahme(w);
        String id = m[0];
        uhr(ANGELEGT);
        Map<String, Object> zweite = mitMessgrundlage(w, RU.get("M-2028-0001"));
        zweite.put("titel", "Verworfen an derselben Ausgangslage");
        zweite.put("herkunft", "von_hand");
        zweite.remove("herkunft_kennung");
        String verworfen = ruf(w, "ines", HttpMethod.POST, PFAD, zweite).body().get("id").asText();
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + verworfen + "/verwerfen",
                Map.of("begruendung", "Doppelt angelegt, M-2028-0001 gilt.")).status()).isEqualTo(200);

        uhr(KASKADE);
        assertThat(kaskade(w, "2027-12-01", "77400", "250000")).singleElement().satisfies(g -> {
            assertThat(g.massnahme()).isEqualTo(UUID.fromString(id));
            assertThat(g.art()).isEqualTo("ausgangslage_korrigiert").isEqualTo(R12.get("art").asText());
            assertThat(g.anlassKennung()).isEqualTo("K-2028-0001");
        });
        assertThat(kaskade(w, "2027-12-01", null, null)).as("zweiter Lauf derselben Korrektur").isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM vorgang_anstoss WHERE tenant_id = ?", Integer.class,
                w.mandant())).isOne();

        JsonNode a = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body();
        assertThat(a.at("/messgrundlage/ausgangslage").asText()).as("byte-gleich").isEqualTo(m[1]);
        assertThat(a.at("/messgrundlage/pruefsumme").asText()).isEqualTo(m[2]);
        assertThat(a.at("/messgrundlage/ausgangslage_inhalt/vergleich/0/bereinigt/gemessen/version").asInt()).isEqualTo(1);
        assertThat(a.at("/messgrundlage/ausgangslage_inhalt/vergleich/0/bereinigt/delta_prozent").asText())
                .isEqualTo("12.9");
        assertThat(a.get("anstoesse")).hasSize(1);
        JsonNode an = a.at("/anstoesse/0");
        assertThat(an.get("art").asText()).isEqualTo("ausgangslage_korrigiert");
        assertThat(an.get("anlass_kennung").asText()).isEqualTo(K);
        assertThat(an.get("zustand").asText()).isEqualTo("offen");
        assertThat(an.get("antwort").isNull()).isTrue();
        assertThat(Instant.parse(an.get("angestossen_am").asText())).isEqualTo(KASKADE);
        JsonNode gesetzt = a.get("verlauf").get(a.get("verlauf").size() - 1);
        assertThat(gesetzt.get("art").asText()).isEqualTo("anstoss_gesetzt");
        assertThat(gesetzt.get("person").asText()).isEqualTo("VoltPilot (Kaskade)");
        assertThat(gesetzt.at("/neu/kennzahl").asText()).isEqualTo("KZ-0004");
        assertThat(gesetzt.at("/neu/monate/0/monat").asText()).isEqualTo("2027-12");
        assertThat(gesetzt.at("/neu/monate/0/version_zitiert").asInt()).isEqualTo(1);
        assertThat(gesetzt.at("/neu/monate/0/version_gueltig").asInt()).isEqualTo(2);
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/" + verworfen, null).body().get("anstoesse")).isEmpty();

        String pfad = PFAD + "/" + id + "/anstoesse/" + an.get("id").asText() + "/antwort";
        uhr(ANTWORT);
        Antwort ohne = ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "bleibt"));
        assertThat(ohne.status()).as(ohne.text()).isEqualTo(422);
        assertThat(ohne.body().get("code").asText()).isEqualTo("begruendung_fehlt");
        assertThat(ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "vergessen")).status()).isEqualTo(400);
        Antwort passt = ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "neu_bewertet", "ergebnis", "belegt",
                "begruendung", BEGRUENDUNG));
        assertThat(passt.status()).as(passt.text()).isEqualTo(422);
        assertThat(passt.body().get("code").asText()).isEqualTo("antwort_passt_nicht");
        Map<String, Object> bleibt = Map.of("antwort", "bleibt", "begruendung", BEGRUENDUNG);
        assertThat(ruf(w, "murat", HttpMethod.POST, pfad, bleibt).status()).as("BD: kein verwalten").isEqualTo(403);
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/anstoesse/" + UUID.randomUUID() + "/antwort",
                bleibt).status()).as("Anstoß eines anderen Vorgangs").isEqualTo(404);
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + verworfen + "/anstoesse/" + an.get("id").asText()
                + "/antwort", bleibt).status()).as("am falschen Vorgang").isEqualTo(404);
        Welt fremd = welt();
        uhr(ANTWORT);
        assertThat(ruf(fremd, "ines", HttpMethod.POST, pfad, bleibt).status()).as("fremder Kundenbereich").isEqualTo(404);

        Antwort b = ruf(w, "ines", HttpMethod.POST, pfad, bleibt);
        assertThat(b.status()).as(b.text()).isEqualTo(200);
        JsonNode beantwortet = b.body().at("/anstoesse/0");
        assertThat(beantwortet.get("zustand").asText()).isEqualTo("beantwortet");
        assertThat(beantwortet.get("antwort").asText()).isEqualTo("bleibt");
        assertThat(beantwortet.get("antwort_begruendung").asText()).isEqualTo(BEGRUENDUNG);
        assertThat(beantwortet.get("beantwortet_von").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(Instant.parse(beantwortet.get("beantwortet_am").asText())).isEqualTo(ANTWORT);
        assertThat(b.body().at("/messgrundlage/ausgangslage").asText()).isEqualTo(m[1]);
        assertThat(b.body().at("/messgrundlage/pruefsumme").asText()).isEqualTo(m[2]);
        JsonNode letzte = b.body().get("verlauf").get(b.body().get("verlauf").size() - 1);
        assertThat(letzte.get("art").asText()).isEqualTo("anstoss_beantwortet");
        assertThat(letzte.get("begruendung").asText()).isEqualTo(BEGRUENDUNG);
        assertThat(letzte.at("/neu/antwort").asText()).isEqualTo("bleibt");

        Antwort zweimal = ruf(w, "ines", HttpMethod.POST, pfad, bleibt);
        assertThat(zweimal.status()).as(zweimal.text()).isEqualTo(409);
        assertThat(zweimal.body().get("code").asText()).isEqualTo("anstoss_beantwortet");
    }

    /**
     * R12 „andere Antwort“: {@code neu_kopiert} — die Ausgangslage neu aus dem Leser (Version 2, +12,0 %), neue
     * Prüfsumme; die alte Kopie mit ihrer Prüfsumme steht in der Protokollzeile.
     */
    @Test
    void r12NeuKopiertNeuePruefsummeDieAlteImProtokoll() throws Exception {
        Welt w = welt();
        String[] m = umgesetzteMassnahme(w);
        String id = m[0];
        uhr(KASKADE);
        assertThat(kaskade(w, "2027-12-01", "77400", "250000")).hasSize(1);
        String aid = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body().at("/anstoesse/0/id").asText();

        uhr(ANTWORT);
        Antwort k = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/anstoesse/" + aid + "/antwort",
                Map.of("antwort", "neu_kopiert"));
        assertThat(k.status()).as(k.text()).isEqualTo(200);
        JsonNode mg = k.body().get("messgrundlage");
        String neu = mg.get("pruefsumme").asText();
        assertThat(neu).isNotEqualTo(m[2]).isEqualTo(BerichtRegeln.pruefsumme(mg.get("ausgangslage").asText()));
        assertThat(root.queryForObject("SELECT bericht_pruefsumme(ausgangslage) FROM massnahme WHERE id = ?",
                String.class, UUID.fromString(id))).isEqualTo(neu);
        JsonNode dezember = mg.at("/ausgangslage_inhalt/vergleich/0");
        assertThat(dezember.get("periode").asText()).isEqualTo("2027-12");
        assertThat(dezember.at("/bereinigt/gemessen/version").asInt()).isEqualTo(2);
        assertThat(zahl(dezember.at("/bereinigt/gemessen/wert"))).isEqualByComparingTo("77400");
        assertThat(zahl(dezember.at("/bereinigt/delta_prozent"))).isEqualByComparingTo("12.0");
        assertThat(dezember.at("/bereinigt/urteil").asText()).isEqualTo("schlechter");
        assertThat(mg.at("/ausgangslage_inhalt/monate").asText()).isEqualTo("2027-12");
        assertThat(mg.get("fassung").asInt()).isEqualTo(2);
        assertThat(k.body().at("/anstoesse/0/antwort").asText()).isEqualTo("neu_kopiert");
        JsonNode letzte = k.body().get("verlauf").get(k.body().get("verlauf").size() - 1);
        assertThat(letzte.get("art").asText()).isEqualTo("anstoss_beantwortet");
        assertThat(letzte.at("/alt/ausgangslage").asText()).as("die alte Kopie im Protokoll").isEqualTo(m[1]);
        assertThat(letzte.at("/alt/ausgangslage_pruefsumme").asText()).isEqualTo(m[2]);
        assertThat(letzte.at("/neu/ausgangslage_pruefsumme").asText()).isEqualTo(neu);
    }

    /**
     * Ein Bewertungs-Stand (IP-12) und eine Ziel-Bewertung (IP-7) zitieren Februar 2028 → je ein Anstoß
     * {@code bewertung_korrigiert}; die Ausgangslage (Dezember 2027) ist nicht betroffen. Am Ziel passt nur „bleibt“ (Z5:
     * die Bewertung wird nie zurückgenommen); an der Maßnahme führt „neu bewertet“ in den Stand Nr. 2 von IP-12.
     */
    @Test
    void bewertungKorrigiertAnStandUndZiel() throws Exception {
        Welt w = welt();
        uhr(Instant.parse("2027-12-20T09:00:00Z"));
        Antwort z = ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele", ziel(w));
        assertThat(z.status()).as(z.text()).isEqualTo(201);
        String ez = z.body().get("id").asText();
        String id = umgesetzteMassnahme(w)[0];
        nachher(w, "2028-01", "2029-01");
        uhr(Instant.parse("2029-01-15T09:00:00Z"));
        JsonNode ref = RU.get("M-2028-0001").at("/bewertungen/0");
        Antwort s = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/bewertungen", Map.of("ergebnis", "belegt",
                "begruendung", ref.get("begruendung").asText()));
        assertThat(s.status()).as(s.text()).isEqualTo(201);
        String standPruefsumme = s.body().at("/bewertung/pruefsumme").asText();
        Antwort zb = ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele/" + ez + "/bewerten", Map.of("ergebnis",
                "verfehlt", "begruendung", "2,7 % statt 5 % weniger über elf bewertbare Monate."));
        assertThat(zb.status()).as(zb.text()).isEqualTo(200);
        String zielPruefsumme = zb.body().at("/bewertung/pruefsumme").asText();

        uhr(Instant.parse("2029-01-20T09:00:00Z"));
        JsonNode feb = FAELLE.get("R5").at("/gegeben/je_monat/2028-02");
        List<VorgangAnstoss.Gesetzt> g = kaskade(w, "2028-02-01",
                String.valueOf(feb.get("kwh").asInt() - 500), feb.get("kg").asText());
        assertThat(g).extracting(VorgangAnstoss.Gesetzt::art).containsExactly("bewertung_korrigiert",
                "bewertung_korrigiert");
        assertThat(g).extracting(x -> x.massnahme() == null ? "ziel" : "massnahme")
                .containsExactlyInAnyOrder("massnahme", "ziel");
        assertThat(kaskade(w, "2028-02-01", null, null)).isEmpty();

        // Am Ziel: nur „bleibt“; die Kopie der Bewertung bleibt.
        JsonNode ziel = ruf(w, "ines", HttpMethod.GET, "/api/v1/energieziele/" + ez, null).body();
        assertThat(ziel.get("anstoesse")).hasSize(1);
        assertThat(ziel.at("/anstoesse/0/art").asText()).isEqualTo("bewertung_korrigiert");
        assertThat(ziel.at("/anstoesse/0/anlass_kennung").asText()).isEqualTo(K);
        String zielPfad = "/api/v1/energieziele/" + ez + "/anstoesse/" + ziel.at("/anstoesse/0/id").asText()
                + "/antwort";
        Antwort nie = ruf(w, "ines", HttpMethod.POST, zielPfad, Map.of("antwort", "neu_bewertet", "ergebnis",
                "verfehlt", "begruendung", BEGRUENDUNG));
        assertThat(nie.status()).as(nie.text()).isEqualTo(422);
        assertThat(nie.body().get("code").asText()).isEqualTo("antwort_passt_nicht");
        Antwort zbleibt = ruf(w, "ines", HttpMethod.POST, zielPfad, Map.of("antwort", "bleibt", "begruendung",
                "Februar ändert sich um 500 kWh; das Ergebnis verfehlt bleibt."));
        assertThat(zbleibt.status()).as(zbleibt.text()).isEqualTo(200);
        assertThat(zbleibt.body().at("/anstoesse/0/zustand").asText()).isEqualTo("beantwortet");
        assertThat(zbleibt.body().at("/bewertung/pruefsumme").asText()).isEqualTo(zielPruefsumme);
        assertThat(zbleibt.body().get("verlauf").get(zbleibt.body().get("verlauf").size() - 1).get("art").asText())
                .isEqualTo("anstoss_beantwortet");

        // An der Maßnahme: „neu bewertet“ → Stand Nr. 2 über IP-12; Stand Nr. 1 bleibt.
        JsonNode m = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body();
        assertThat(m.get("anstoesse")).hasSize(1);
        assertThat(m.at("/anstoesse/0/art").asText()).isEqualTo("bewertung_korrigiert");
        JsonNode gesetzt = m.get("verlauf").get(m.get("verlauf").size() - 1);
        assertThat(gesetzt.at("/neu/staende/0").asInt()).isEqualTo(1);
        assertThat(gesetzt.at("/neu/monate/0/monat").asText()).isEqualTo("2028-02");
        String pfad = PFAD + "/" + id + "/anstoesse/" + m.at("/anstoesse/0/id").asText() + "/antwort";
        assertThat(ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "neu_kopiert")).status()).isEqualTo(422);
        assertThat(ruf(w, "peter", HttpMethod.POST, pfad, Map.of("antwort", "neu_bewertet", "ergebnis", "belegt",
                "begruendung", BEGRUENDUNG)).status()).as("Bearbeiter: kein abschliessen").isEqualTo(403);
        assertThat(ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "neu_bewertet", "begruendung", BEGRUENDUNG))
                .status()).as("ohne Ergebnis").isEqualTo(400);
        Antwort nb = ruf(w, "ines", HttpMethod.POST, pfad, Map.of("antwort", "neu_bewertet", "ergebnis", "belegt",
                "begruendung", ref.get("begruendung").asText()));
        assertThat(nb.status()).as(nb.text()).isEqualTo(200);
        assertThat(nb.body().at("/bewertung/stand_nr").asInt()).isEqualTo(2);
        assertThat(nb.body().at("/anstoesse/0/antwort").asText()).isEqualTo("neu_bewertet");
        JsonNode letzte = nb.body().get("verlauf").get(nb.body().get("verlauf").size() - 1);
        assertThat(letzte.get("art").asText()).isEqualTo("anstoss_beantwortet");
        assertThat(letzte.at("/neu/stand_nr").asInt()).isEqualTo(2);
        assertThat(nb.body().get("verlauf").get(nb.body().get("verlauf").size() - 2).get("art").asText())
                .isEqualTo("massnahme_bewertet");
        JsonNode staende = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id + "/bewertungen", null).body()
                .get("bewertungen");
        assertThat(staende).hasSize(2);
        assertThat(staende.get(0).get("pruefsumme").asText()).as("Stand Nr. 1 byte-gleich").isEqualTo(standPruefsumme);
        assertThat(staende.get(1).get("kopie").asText()).as("Stand Nr. 2 liest Version 2").contains("\"version\":2");
    }

    /**
     * Pfad 2, Basis beendet (Route AP-17 + Struktur-Läufer): {@code messgrundlage_beendet} an der umgesetzten und der
     * geplanten Maßnahme und am offenen Ziel — nicht an der verworfenen Maßnahme; ein zweiter Takt setzt keinen
     * zweiten. Die Antwort am Ziel: „bleibt“.
     */
    @Test
    void pfad2BasisBeendetStoesstMassnahmenUndZielAn() throws Exception {
        Welt w = welt();
        uhr(Instant.parse("2027-12-20T09:00:00Z"));
        String ez = ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele", ziel(w)).body().get("id").asText();
        String umgesetzt = umgesetzteMassnahme(w)[0];
        String[] weitere = weitereMassnahmen(w);
        beenden(w);
        StrukturAenderungLaeufer laeufer = laeufer();
        assertThat(laeufer.lauf(Instant.parse("2028-07-10T09:05:00Z")).gescheitert()).isEmpty();
        assertThat(laeufer.lauf(Instant.parse("2028-07-10T09:10:00Z")).gescheitert()).isEmpty();

        for (String id : List.of(umgesetzt, weitere[0])) {
            JsonNode m = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body();
            assertThat(m.get("anstoesse")).as(m.get("kennzeichen").asText()).hasSize(1);
            assertThat(m.at("/anstoesse/0/art").asText()).isEqualTo("messgrundlage_beendet");
            assertThat(m.at("/anstoesse/0/anlass_kennung").asText()).isEqualTo("BB-0001/beendet");
            JsonNode gesetzt = m.get("verlauf").get(m.get("verlauf").size() - 1);
            assertThat(gesetzt.get("art").asText()).isEqualTo("anstoss_gesetzt");
            assertThat(gesetzt.get("person").asText()).isEqualTo("VoltPilot (Struktur-Läufer)");
        }
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/" + weitere[1], null).body().get("anstoesse"))
                .as("verworfen").isEmpty();
        JsonNode ziel = ruf(w, "ines", HttpMethod.GET, "/api/v1/energieziele/" + ez, null).body();
        assertThat(ziel.get("anstoesse")).hasSize(1);
        assertThat(ziel.at("/anstoesse/0/art").asText()).isEqualTo("messgrundlage_beendet");
        assertThat(root.queryForObject("SELECT count(*) FROM vorgang_anstoss WHERE tenant_id = ?", Integer.class,
                w.mandant())).isEqualTo(3);

        String mPfad = PFAD + "/" + umgesetzt + "/anstoesse/" + ruf(w, "ines", HttpMethod.GET, PFAD + "/" + umgesetzt,
                null).body().at("/anstoesse/0/id").asText() + "/antwort";
        assertThat(ruf(w, "ines", HttpMethod.POST, mPfad, Map.of("antwort", "neu_kopiert")).body().get("code").asText())
                .isEqualTo("antwort_passt_nicht");
        Antwort zb = ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele/" + ez + "/anstoesse/"
                + ziel.at("/anstoesse/0/id").asText() + "/antwort", Map.of("antwort", "bleibt", "begruendung",
                        "Das Ziel 2028 läuft auf der beendeten Basis zu Ende."));
        assertThat(zb.status()).as(zb.text()).isEqualTo(200);
        assertThat(zb.body().at("/anstoesse/0/antwort").asText()).isEqualTo("bleibt");
    }

    /**
     * Pfad 2, Fassung n + 1 (WK4): Fassung 3 mit Referenzperiode November 2027 bis Oktober 2028 endet nach der Umsetzung
     * (Januar 2028) → {@code messgrundlage_neu_gefasst} an der umgesetzten Maßnahme und am offenen Ziel; die geplante
     * Maßnahme (keine Umsetzung) und die verworfene nicht.
     */
    @Test
    void pfad2FassungNachDerUmsetzungStoesstAn() throws Exception {
        Welt w = welt();
        uhr(Instant.parse("2027-12-20T09:00:00Z"));
        String ez = ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele", ziel(w)).body().get("id").asText();
        String umgesetzt = umgesetzteMassnahme(w)[0];
        String[] weitere = weitereMassnahmen(w);
        UUID bb1 = root.queryForObject("SELECT id FROM bezugsbasis WHERE tenant_id = ? AND kennzeichen = 'BB-0001'",
                UUID.class, w.mandant());
        root.update("UPDATE bezugsbasis_fassung SET gilt_bis = '2028-10-31', beendet_am = now(), beendet_grund = "
                + "'Fassung 3 mit der jüngsten Referenzperiode.' WHERE bezugsbasis_id = ? AND fassung = 2", bb1);
        fassung(w.mandant(), bb1, 3, bz1(w), "regression_eine_variable", "2027-11/2028-10", "2028-11-01", null,
                "0.2685", "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        root.update("INSERT INTO bezugsbasis_aenderung (tenant_id, bezugsbasis_id, fassung, art, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 3, 'fassung_freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde')", w.mandant(), bb1);
        assertThat(laeufer().lauf(Instant.parse("2028-11-20T09:00:00Z")).gescheitert()).isEmpty();

        JsonNode m = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + umgesetzt, null).body();
        assertThat(m.get("anstoesse")).hasSize(1);
        assertThat(m.at("/anstoesse/0/art").asText()).isEqualTo("messgrundlage_neu_gefasst");
        assertThat(m.at("/anstoesse/0/anlass_kennung").asText()).isEqualTo("BB-0001/Fassung-3");
        JsonNode gesetzt = m.get("verlauf").get(m.get("verlauf").size() - 1);
        assertThat(gesetzt.at("/neu/referenzperiode").asText()).isEqualTo("2027-11/2028-10");
        for (String id : weitere) {
            assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body().get("anstoesse")).isEmpty();
        }
        JsonNode ziel = ruf(w, "ines", HttpMethod.GET, "/api/v1/energieziele/" + ez, null).body();
        assertThat(ziel.at("/anstoesse/0/art").asText()).isEqualTo("messgrundlage_neu_gefasst");
        assertThat(root.queryForObject("SELECT count(*) FROM vorgang_anstoss WHERE tenant_id = ?", Integer.class,
                w.mandant())).isEqualTo(2);
    }

    /**
     * Schalter aus (§5.8, NW-5): die Kaskade bildet Version 2 trotzdem, der Struktur-Läufer liest die Zeile
     * (Wasserzeichen) — aber kein Anstoß; wieder an, holt nichts nach.
     */
    @Test
    void schalterAusNichts() throws Exception {
        Welt w = welt();
        String id = umgesetzteMassnahme(w)[0];
        ReflectionTestUtils.setField(naht, "eingeschaltet", false);
        uhr(KASKADE);
        assertThat(kaskade(w, "2027-12-01", "77400", "250000")).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE kennzahl_id = ? AND periode_art = "
                + "'monat' AND periode_von = '2027-12-01' AND version = 2", Integer.class, w.kz4()))
                .as("der Wert entsteht trotzdem").isOne();
        beenden(w);
        assertThat(laeufer().lauf(Instant.parse("2028-07-10T09:05:00Z")).gescheitert()).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_struktur_gelesen g JOIN bezugsbasis_aenderung a "
                + "ON g.protokoll = 'bezugsbasis_aenderung' AND g.eintrag_id = a.id WHERE a.tenant_id = ?",
                Integer.class, w.mandant())).as("gelesen").isOne();

        ReflectionTestUtils.setField(naht, "eingeschaltet", true);
        assertThat(laeufer().lauf(Instant.parse("2028-07-10T09:10:00Z")).gescheitert()).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM vorgang_anstoss WHERE tenant_id = ?", Integer.class,
                w.mandant())).as("nichts nachgeholt").isZero();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body().get("anstoesse")).isEmpty();
    }

    // ================================================================================ Kaskade und Läufer

    /**
     * Die Kaskade von K-2028-0001 in der Verbindung der Verwaltungsrolle: Version 2 des Monats (ohne {@code kwh}: keine
     * neue Zeile, ein zweiter Lauf) und die Naht, wie {@link KennzahlKaskade} sie ruft.
     */
    private List<VorgangAnstoss.Gesetzt> kaskade(Welt w, String monat, String kwh, String kg) throws SQLException {
        Instant jetzt = kennzahlen.jetzt();
        LocalDate von = LocalDate.parse(monat);
        KennzahlLauf.Neu v2 = new KennzahlLauf.Neu(w.kz4(), "KZ-0004", "monat", von, von.plusMonths(1).minusDays(1),
                ZONE, 2);
        List<List<VorgangAnstoss.Gesetzt>> aus = new ArrayList<>();
        inTransaktion(con -> {
            if (kwh != null) {
                version2(con, w, von, kwh, kg, jetzt);
            }
            aus.add(naht.anstossen(con, w.mandant(), K, List.of(v2), jetzt));
        });
        return aus.get(0);
    }

    private StrukturAenderungLaeufer laeufer() {
        StrukturAenderungLaeufer laeufer = new StrukturAenderungLaeufer(admin, new BerichteNaht.Keine(), 200);
        BezugsbasisAnstoss anstoss = BezugsbasisAnstoss.mitSchalter(true);
        anstoss.verbesserung(naht);
        laeufer.bezugsbasis(anstoss);
        return laeufer;
    }

    /** BB-0001 endet über die Route von AP-17 (Muster EnergiezielApiTest). */
    private void beenden(Welt w) throws Exception {
        uhr(Instant.parse("2028-07-10T09:00:00Z"));
        UUID basis = root.queryForObject("SELECT id FROM bezugsbasis WHERE tenant_id = ?", UUID.class, w.mandant());
        Antwort ende = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen/" + w.kz4() + "/bezugsbasen/" + basis
                + "/beenden", Map.of("tag", "2028-07-31", "grund", "struktur_geaendert",
                        "begruendung", "Anbau Halle 2 ändert die Struktur"));
        assertThat(ende.status()).as(ende.text()).isEqualTo(200);
    }

    /** Eine geplante und eine verworfene Maßnahme an derselben Messgrundlage — IDs in dieser Reihenfolge. */
    private String[] weitereMassnahmen(Welt w) throws Exception {
        uhr(ANGELEGT);
        String[] ids = new String[2];
        for (int i = 0; i < 2; i++) {
            Map<String, Object> b = mitMessgrundlage(w, RU.get("M-2028-0001"));
            b.put("titel", i == 0 ? "Geplant an derselben Basis" : "Verworfen an derselben Basis");
            b.put("herkunft", "von_hand");
            b.remove("herkunft_kennung");
            Antwort a = ruf(w, "ines", HttpMethod.POST, PFAD, b);
            assertThat(a.status()).as(a.text()).isEqualTo(201);
            ids[i] = a.body().get("id").asText();
        }
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD + "/" + ids[1] + "/verwerfen",
                Map.of("begruendung", "Doppelt angelegt, M-2028-0001 gilt.")).status()).isEqualTo(200);
        return ids;
    }

    private static Map<String, Object> ziel(Welt w) {
        JsonNode ez = referenzZiel();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzahl", w.kz4().toString());
        m.put("zielwert_prozent", ez.get("zielwert_prozent").decimalValue());
        m.put("zielperiode", ez.get("zielperiode").asText());
        m.put("wortlaut", ez.get("wortlaut").asText());
        m.put("begruendung", ez.get("begruendung").asText());
        return m;
    }

    private static JsonNode referenzZiel() {
        try {
            return MAPPER.readTree(java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                    "uems-referenzunternehmen.json").toFile()).get("energieziele").get(0);
        } catch (java.io.IOException x) {
            throw new IllegalStateException(x);
        }
    }

    private void inTransaktion(Schritt schritt) throws SQLException {
        admin.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                schritt.fahren(con);
                con.commit();
                return null;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("Transaktion abgebrochen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    /** Version 2 eines endgültigen Monats, wie die Kaskade sie schreibt (Anlass K-2028-0001), in {@code con}. */
    private static void version2(Connection con, Welt w, LocalDate von, String zaehlerText, String nennerText,
            Instant am) throws SQLException {
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        try (var ps = con.prepareStatement("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, "
                + "periode_bis, zeitzone, version, wert, zaehler, nenner, menge_zustand, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) SELECT tenant_id, kennzahl_id, "
                + "periode_art, periode_von, periode_bis, zeitzone, 2, ?, ?, ?, menge_zustand, kennzeichen, zustand, "
                + "endgueltig_ab, definition_fassung_id, ?, 'eingang', 'K-2028-0001' FROM kennzahl_wert "
                + "WHERE tenant_id = ? AND kennzahl_id = ? AND periode_art = 'monat' AND periode_von = ? AND version = 1")) {
            ps.setBigDecimal(1, zaehler.divide(nenner, 20, RoundingMode.HALF_UP));
            ps.setBigDecimal(2, zaehler);
            ps.setBigDecimal(3, nenner);
            ps.setTimestamp(4, Timestamp.from(am));
            ps.setObject(5, w.mandant());
            ps.setObject(6, w.kz4());
            ps.setDate(7, Date.valueOf(von));
            assertThat(ps.executeUpdate()).isOne();
        }
    }

    /** M-2028-0001 wie R3: angelegt am 15.01.2028, umgesetzt am 22.01.2028 — ID, Ausgangslage, Prüfsumme. */
    private String[] umgesetzteMassnahme(Welt w) throws Exception {
        return umgesetzteMassnahme(w, "murat");
    }

    /** Wie {@link #umgesetzteMassnahme(Welt)}, mit einer anderen verantwortlichen Person. */
    private String[] umgesetzteMassnahme(Welt w, String verantwortlich) throws Exception {
        JsonNode r3 = RU.get("M-2028-0001");
        uhr(ANGELEGT);
        Map<String, Object> body = mitMessgrundlage(w, r3);
        body.put("verantwortlich", sub(w, verantwortlich));
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        String id = neu.body().get("id").asText();
        uhr(UMGESETZT);
        Antwort um = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/umgesetzt", Map.of("am", "2028-01-22",
                "begruendung", r3.get("verlauf").get(1).get("begruendung").asText()));
        assertThat(um.status()).as(um.text()).isEqualTo(200);
        return new String[] {id, neu.body().at("/messgrundlage/ausgangslage").asText(),
                neu.body().at("/messgrundlage/pruefsumme").asText()};
    }

    /** Die Monate der Referenzdatei 1.9: Januar 2028 aus R6, Februar 2028 bis Januar 2029 aus R5 (kWh, kg). */
    private static void nachher(Welt w, String von, String bis) {
        UUID bz = bz1(w);
        for (YearMonth m = YearMonth.parse(von); !m.isAfter(YearMonth.parse(bis)); m = m.plusMonths(1)) {
            JsonNode n = m.equals(YearMonth.of(2028, 1)) ? FAELLE.get("R6").at("/gegeben/januar_2028")
                    : FAELLE.get("R5").at("/gegeben/je_monat/" + m);
            monat(w.mandant(), w.kz4(), bz, m.atDay(1).toString(), n.get("kwh").asText(), n.get("kg").asText());
        }
    }

    private static UUID bz1(Welt w) {
        return root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = 'BZ-1'",
                UUID.class, w.mandant());
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

    /** {@code abnahmefaelle_ap18.faelle[]} der Referenzdatei 1.9 nach Fall (R5, R6). */
    private static Map<String, JsonNode> faelle() {
        try {
            JsonNode datei = MAPPER.readTree(java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                    "uems-referenzunternehmen.json").toFile());
            Map<String, JsonNode> m = new LinkedHashMap<>();
            datei.at("/abnahmefaelle_ap18/faelle").forEach(n -> m.put(n.get("fall").asText(), n));
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
            {"murat", "Murat Demirci", "bedienberechtigt", "aktiv"}, {"olga", "Olga Alt", null, "entfernt"},
            {"jonas", "Jonas Wendlinger", null, "aktiv"}};
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
            "murat", "Murat Demirci", "olga", "Olga Alt", "jonas", "Jonas Wendlinger");

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
