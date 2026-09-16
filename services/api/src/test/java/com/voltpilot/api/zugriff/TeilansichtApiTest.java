package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Teilansicht serverseitig (UEMS AP-03 IP-10): {@code /overview}, {@code /earnings}, {@code /sites},
 * {@code /devices}, {@code /edge-versions} und {@code /standorte} bilden Listen UND Summen nur über die
 * SICHTBAREN Standorte, und keine Antwort trägt eine Zahl, aus der sich ein fremder Standort ableiten ließe.
 *
 * <p>Die Abnahmefälle A1 und A2 des Konzepts, mit den Zahlen des Konzepts:
 * <ul>
 *   <li><b>A1 — Peter Hollerbach ist Bearbeiter nur für Werk Lindach (ST-2).</b> {@code /standorte} liefert nur
 *       ST-2, {@code /overview} nur AN-3, und die Summe der Antwort ist <b>9 100</b>. Nirgends erscheint
 *       <b>174 400</b> (Unternehmen ohne ST-3) oder <b>165 300</b> (die Differenz, also Werk Ahrenberg).</li>
 *   <li><b>A2 — Claudia Berger ist Leserin für zwei von drei Standorten.</b> Ihre Summe ist EXAKT die Summe
 *       ihrer zwei (128 400 + 36 900 + 9 100 = 174 400), nie die des Unternehmens (210 600), und weder Name
 *       noch Zahl des dritten Standorts erscheinen.</li>
 * </ul>
 *
 * <p>Die Zahlen des Konzepts sind Netzbezugsmengen in kWh; hier tragen sie die Speicher-Kapazität, weil das die
 * EINZIGE summierte Zahl von {@code /overview} ist, die vor diesem Paket mandantenweit entstand
 * ({@code OverviewRepository.storageTotals} ohne {@code JOIN site} — {@code asset} trägt nur die
 * Mandanten-Policy, nicht {@code site_scope}). Geprüft wird die Arithmetik, nicht die Einheit.
 *
 * <p>Dazu drei Nachweise, die das Konzept ausdrücklich verlangt:
 * {@link #keinAntwortfeldTraegtDieGesamtsumme()} durchsucht JEDES Blatt JEDER der sechs Antworten nach der
 * Gesamtsumme und nach „Gesamtsumme minus eigene"; {@link #teilansichtStehtInJederAntwort()} belegt
 * {@code teilansicht {sichtbar, gesamt}}; {@link #bestandKundenadministratorAntwortetZeichengleich()} ist der
 * Bestandsnachweis aus W11 — ein Kundenadministrator mit unternehmensweitem Geltungsbereich antwortet
 * zeichengleich zu „vorher" (der {@link ZugriffKontextLader} lädt nichts, wie vor der Durchsetzung), bis auf
 * genau das additive Feld.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class TeilansichtApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    private static final UUID KUNDENBEREICH = UUID.fromString("a3100000-0000-0000-0000-000000000001");

    /** Die Kapazitäten tragen die Zahlen aus A1: Halle 1, Halle 2, Werk Lindach — und ST-3 aus A2. */
    private static final BigDecimal HALLE_1 = new BigDecimal("128400");
    private static final BigDecimal HALLE_2 = new BigDecimal("36900");
    private static final BigDecimal LINDACH = new BigDecimal("9100");
    private static final BigDecimal NORD = new BigDecimal("36200");

    /** Werk Ahrenberg = Halle 1 + Halle 2 = 165 300 — die Zahl, die Peter NICHT ableiten können darf. */
    private static final BigDecimal AHRENBERG = HALLE_1.add(HALLE_2);
    /** Claudias zwei Standorte = 174 400 — im Konzept „Netzbezug gesamt Unternehmen" von A1. */
    private static final BigDecimal CLAUDIA = AHRENBERG.add(LINDACH);
    /** Alle drei Standorte = 210 600 — die Zahl, die NIEMAND außer dem unternehmensweiten Zugriff sieht. */
    private static final BigDecimal UNTERNEHMEN = CLAUDIA.add(NORD);

    private static final String PETER = "sub-ip10-peter";
    private static final String CLAUDIA_SUB = "sub-ip10-claudia";
    private static final String JONAS = "sub-ip10-jonas";

    private static final UUID ST_1 = UUID.fromString("a3100000-0000-0000-0000-0000000000a1");
    private static final UUID ST_2 = UUID.fromString("a3100000-0000-0000-0000-0000000000a2");
    private static final UUID ST_3 = UUID.fromString("a3100000-0000-0000-0000-0000000000a3");

    private static final UUID AN_1 = UUID.fromString("a3100000-0000-0000-0000-0000000000b1");
    private static final UUID AN_2 = UUID.fromString("a3100000-0000-0000-0000-0000000000b2");
    private static final UUID AN_3 = UUID.fromString("a3100000-0000-0000-0000-0000000000b3");
    private static final UUID AN_4 = UUID.fromString("a3100000-0000-0000-0000-0000000000b4");

    /** Die sechs Routen des Pakets. */
    private static final List<String> ROUTEN = List.of(
            "/api/v1/overview", "/api/v1/earnings", "/api/v1/sites", "/api/v1/devices",
            "/api/v1/edge-versions", "/api/v1/standorte");

    /**
     * Die Routen, deren Antwort ein OBJEKT ist und das additive Feld darum im Körper tragen kann.
     *
     * <p>Die drei übrigen ({@code /sites}, {@code /devices}, {@code /edge-versions}) antworten mit einer
     * nackten Liste und tragen {@code teilansicht} NICHT — eine benannte Abweichung von der Abnahmezeile
     * „in allen sechs Antworten belegt" (firstmate-Entscheid 16.09.2026, Option C), einzulösen mit
     * <b>AP-03 IP-12</b>. Ihre REICHWEITE prüft dieser Test trotzdem, für alle sechs: siehe
     * {@link #jedeDerSechsRoutenZeigtNurDieSichtbarenAnlagen()} und
     * {@link #keinAntwortfeldTraegtDieGesamtsumme()}.
     */
    private static final List<String> ROUTEN_MIT_FELD =
            List.of("/api/v1/overview", "/api/v1/earnings", "/api/v1/standorte");

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

    @SpyBean
    ZugriffKontextLader lader;

    /** {@code true} = „vorher": der Lader lädt nichts, der Filter reicht durch — der Stand vor der Durchsetzung. */
    private static final AtomicBoolean VORHER = new AtomicBoolean();

    private static JdbcTemplate root;
    private static boolean gesaet;

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void vorbereiten() {
        VORHER.set(false);
        doAnswer(inv -> VORHER.get() ? ZugriffKontextLader.Ergebnis.keiner() : inv.callRealMethod())
                .when(lader).laden(any(), any());
        if (!gesaet) {
            seed();
            gesaet = true;
        }
    }

    // ------------------------------------------------------------------ A1

    @Test
    void a1PeterSiehtNurWerkLindachUndKeineUnternehmenssumme() throws Exception {
        JsonNode standorte = json(PETER, "/api/v1/standorte");
        assertThat(namen(standorte.get("standorte"))).containsExactly("Werk Lindach");
        assertThat(standorte.get("nichtGezeigt")).isEmpty();
        assertThat(standorte.get("teilansicht").get("sichtbar").asInt()).isEqualTo(1);
        assertThat(standorte.get("teilansicht").get("gesamt").asInt()).isEqualTo(3);

        JsonNode overview = json(PETER, "/api/v1/overview");
        assertThat(namen(overview.get("sites"))).containsExactly("AN-3 Werk Lindach");
        JsonNode totals = overview.get("totals");
        assertThat(totals.get("sites").asInt()).isEqualTo(1);
        assertThat(new BigDecimal(totals.get("storageCapacityKwh").asText()))
                .as("die Summe ist die seines EINEN Standorts").isEqualByComparingTo(LINDACH);

        // Die Anlagen der anderen Standorte gibt es für ihn nicht - 404, nie 403 (A14).
        status(PETER, "/api/v1/sites/" + AN_1).isEqualTo(404);
        status(PETER, "/api/v1/sites/" + AN_4).isEqualTo(404);

        // Und keine der sechs Antworten nennt 174 400 oder 165 300.
        for (String route : ROUTEN) {
            assertThat(blaetter(json(PETER, route)))
                    .as("A1: " + route + " nennt weder die Unternehmenssumme noch die Differenz")
                    .doesNotContain(zahl(CLAUDIA), zahl(AHRENBERG), zahl(UNTERNEHMEN));
        }
    }

    // ------------------------------------------------------------------ A2

    @Test
    void a2ClaudiaSiehtZweiVonDreiUndGenauIhreSumme() throws Exception {
        JsonNode overview = json(CLAUDIA_SUB, "/api/v1/overview");
        assertThat(namen(overview.get("sites")))
                .containsExactlyInAnyOrder("AN-1 Halle 1", "AN-2 Halle 2", "AN-3 Werk Lindach");
        assertThat(new BigDecimal(overview.get("totals").get("storageCapacityKwh").asText()))
                .as("EXAKT die Summe ihrer zwei Standorte").isEqualByComparingTo(CLAUDIA);
        assertThat(overview.get("teilansicht").get("sichtbar").asInt()).isEqualTo(2);
        assertThat(overview.get("teilansicht").get("gesamt").asInt()).isEqualTo(3);

        JsonNode standorte = json(CLAUDIA_SUB, "/api/v1/standorte");
        assertThat(namen(standorte.get("standorte")))
                .containsExactly("Werk Ahrenberg", "Werk Lindach");

        // Name und Zahl des dritten Standorts erscheinen in keiner der sechs Antworten (nur „3 Standorte").
        for (String route : ROUTEN) {
            List<String> blaetter = blaetter(json(CLAUDIA_SUB, route));
            assertThat(blaetter).as("A2: " + route + " nennt ST-3 nicht")
                    .doesNotContain("Werk Ahrenberg Nord", "ST-3", "AN-4 Nordhalle", zahl(NORD));
            assertThat(blaetter).as("A2: " + route + " trägt keine Unternehmenssumme")
                    .doesNotContain(zahl(UNTERNEHMEN));
        }
    }

    // ------------------------------------------- die Reichweite JEDER der sechs Routen

    /**
     * Was JEDE der sechs Routen zeigt — die Zeile, an der sich „vorher wie weit, jetzt wie weit" ablesen
     * lässt. Fünf der sechs schneidet schon der Standort-Zaun (IP-5), weil ihre Liste über {@code site},
     * {@code device} oder {@code standort} läuft; {@code /overview} kam als einzige mit einer Summe daher,
     * die an ihm vorbeilief (siehe {@link #keinAntwortfeldTraegtDieGesamtsumme()}).
     */
    @Test
    void jedeDerSechsRoutenZeigtNurDieSichtbarenAnlagen() throws Exception {
        assertThat(namen(json(PETER, "/api/v1/sites"))).containsExactly("AN-3 Werk Lindach");
        assertThat(namen(json(CLAUDIA_SUB, "/api/v1/sites")))
                .containsExactlyInAnyOrder("AN-1 Halle 1", "AN-2 Halle 2", "AN-3 Werk Lindach");
        assertThat(namen(json(JONAS, "/api/v1/sites"))).hasSize(4);

        assertThat(anlagenKennungen(json(PETER, "/api/v1/devices"), "siteId")).containsExactly(AN_3.toString());
        assertThat(anlagenKennungen(json(CLAUDIA_SUB, "/api/v1/devices"), "siteId"))
                .containsExactlyInAnyOrder(AN_1.toString(), AN_2.toString(), AN_3.toString());
        assertThat(anlagenKennungen(json(JONAS, "/api/v1/devices"), "siteId")).hasSize(4);

        assertThat(anlagenKennungen(json(PETER, "/api/v1/edge-versions"), "siteId"))
                .containsExactly(AN_3.toString());
        assertThat(anlagenKennungen(json(CLAUDIA_SUB, "/api/v1/edge-versions"), "siteId"))
                .containsExactlyInAnyOrder(AN_1.toString(), AN_2.toString(), AN_3.toString());
        assertThat(anlagenKennungen(json(JONAS, "/api/v1/edge-versions"), "siteId")).hasSize(4);

        assertThat(namen(json(PETER, "/api/v1/earnings").get("sites"))).containsExactly("AN-3 Werk Lindach");
        assertThat(namen(json(PETER, "/api/v1/overview").get("sites"))).containsExactly("AN-3 Werk Lindach");
        assertThat(namen(json(PETER, "/api/v1/standorte").get("standorte"))).containsExactly("Werk Lindach");
    }

    // ------------------------------- „Totals minus eigene ≠ fremde"

    /**
     * Der eigene Nachweis aus der Paketzelle: KEIN Feld einer Antwort trägt die Gesamtsumme — also auch keine,
     * aus der sich ein fremder Standort als Differenz ergäbe. Geprüft wird jedes Blatt jeder der sechs
     * Antworten (Zahl wie Zeichenkette), für beide standortbeschränkten Personen.
     *
     * <p>Die Probe aufs Exempel steht daneben: der unternehmensweite Zugriff SIEHT die Gesamtsumme — sonst
     * prüfte dieser Test nur, dass die Zahl nirgends vorkommt, weil es sie gar nicht gibt.
     */
    @Test
    void keinAntwortfeldTraegtDieGesamtsumme() throws Exception {
        for (String sub : List.of(PETER, CLAUDIA_SUB)) {
            BigDecimal eigene = sub.equals(PETER) ? LINDACH : CLAUDIA;
            BigDecimal fremde = UNTERNEHMEN.subtract(eigene);
            for (String route : ROUTEN) {
                assertThat(blaetter(json(sub, route)))
                        .as(sub + " auf " + route + ": weder Gesamtsumme noch Rest")
                        .doesNotContain(zahl(UNTERNEHMEN), zahl(fremde));
            }
        }
        assertThat(new BigDecimal(json(JONAS, "/api/v1/overview").get("totals")
                .get("storageCapacityKwh").asText()))
                .as("Gegenprobe: unternehmensweit gibt es die Gesamtsumme sehr wohl")
                .isEqualByComparingTo(UNTERNEHMEN);
    }

    // ------------------------------------------------- teilansicht in allen sechs

    @Test
    void teilansichtStehtInJederAntwort() throws Exception {
        Map<String, Integer> erwartet = Map.of(PETER, 1, CLAUDIA_SUB, 2, JONAS, 3);
        for (Map.Entry<String, Integer> person : erwartet.entrySet()) {
            for (String route : ROUTEN_MIT_FELD) {
                JsonNode teilansicht = teilansicht(person.getKey(), route);
                assertThat(teilansicht).as(person.getKey() + " auf " + route).isNotNull();
                assertThat(teilansicht.get("sichtbar").asInt())
                        .as("sichtbar auf " + route).isEqualTo(person.getValue());
                assertThat(teilansicht.get("gesamt").asInt()).as("gesamt auf " + route).isEqualTo(3);
            }
        }
    }

    // ------------------------------------------------------ Standort-Menge an /earnings

    @Test
    void earningsNimmtEineStandortMengeStattEinerOderAller() throws Exception {
        // Ohne Auswahl: alle sichtbaren Anlagen - zeichengleich zu heute.
        assertThat(namen(json(CLAUDIA_SUB, "/api/v1/earnings").get("sites")))
                .containsExactlyInAnyOrder("AN-1 Halle 1", "AN-2 Halle 2", "AN-3 Werk Lindach");

        // EINER ihrer Standorte.
        JsonNode einer = json(CLAUDIA_SUB, "/api/v1/earnings?standort=" + ST_2);
        assertThat(namen(einer.get("sites"))).containsExactly("AN-3 Werk Lindach");
        assertThat(einer.get("teilansicht").get("sichtbar").asInt()).isEqualTo(1);
        assertThat(einer.get("teilansicht").get("gesamt").asInt()).isEqualTo(3);

        // BEIDE - eine echte Menge, nicht „eine oder alle".
        JsonNode beide = json(CLAUDIA_SUB, "/api/v1/earnings?standort=" + ST_1 + "&standort=" + ST_2);
        assertThat(namen(beide.get("sites")))
                .containsExactlyInAnyOrder("AN-1 Halle 1", "AN-2 Halle 2", "AN-3 Werk Lindach");
        assertThat(beide.get("teilansicht").get("sichtbar").asInt()).isEqualTo(2);

        // Ein Standort außerhalb des Zugriffs ist 404, nie 403 - die Existenz wird nicht bestätigt (A14).
        status(CLAUDIA_SUB, "/api/v1/earnings?standort=" + ST_3).isEqualTo(404);
        status(PETER, "/api/v1/earnings?standort=" + ST_1).isEqualTo(404);
        status(CLAUDIA_SUB, "/api/v1/earnings?standort=" + UUID.randomUUID()).isEqualTo(404);
        // Der unternehmensweite Zugriff darf jeden Standort wählen.
        assertThat(namen(json(JONAS, "/api/v1/earnings?standort=" + ST_3).get("sites")))
                .containsExactly("AN-4 Nordhalle");
    }

    // --------------------------------------------- Bestandsnachweis (W11)

    /**
     * W11: die Durchsetzung ist ab Merge scharf — möglich nur, weil jedes Bestandskonto Kundenadministrator
     * ist (E12). Der Nachweis: derselbe Aufruf einmal als unternehmensweiter Kundenadministrator und einmal
     * „vorher" (der Lader lädt nichts, die Verbindung setzt nur {@code app.tenant_id}) liefert denselben
     * Körper — bis auf genau das additive Feld {@code teilansicht}.
     */
    @Test
    void bestandKundenadministratorAntwortetZeichengleich() throws Exception {
        for (String route : ROUTEN) {
            VORHER.set(true);
            JsonNode vorher = json(JONAS, route);
            VORHER.set(false);
            JsonNode nachher = json(JONAS, route);
            assertThat(ohneTeilansicht(nachher).toString())
                    .as(route + ": zeichengleich zu vorher, bis auf das additive Feld")
                    .isEqualTo(ohneTeilansicht(vorher).toString());
            if (ROUTEN_MIT_FELD.contains(route)) {
                assertThat(teilansicht(JONAS, route)).as(route + ": und das Feld ist da").isNotNull();
            }
        }
    }

    // ------------------------------------------------------------------ Hilfen

    private JsonNode json(String sub, String pfad) throws Exception {
        MvcResult res = mvc.perform(MockMvcRequestBuilders.get(pfad).with(authentication(konto(sub))))
                .andReturn();
        assertThat(res.getResponse().getStatus()).as(sub + " auf " + pfad).isEqualTo(200);
        return MAPPER.readTree(res.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private org.assertj.core.api.AbstractIntegerAssert<?> status(String sub, String pfad) throws Exception {
        return assertThat(mvc.perform(MockMvcRequestBuilders.get(pfad).with(authentication(konto(sub))))
                .andReturn().getResponse().getStatus()).as(sub + " auf " + pfad);
    }

    /** Das Feld {@code teilansicht} einer Antwort — bei einer Liste über den Umschlag, sonst direkt. */
    private JsonNode teilansicht(String sub, String route) throws Exception {
        JsonNode antwort = json(sub, route);
        return antwort.isArray() ? null : antwort.get("teilansicht");
    }

    /** Dieselbe Antwort ohne das additive Feld — die Form, in der „vorher" und „nachher" vergleichbar sind. */
    private static JsonNode ohneTeilansicht(JsonNode antwort) {
        if (!antwort.isObject()) {
            return antwort;
        }
        ObjectNode kopie = (ObjectNode) antwort.deepCopy();
        kopie.remove("teilansicht");
        return kopie;
    }

    private static List<String> anlagenKennungen(JsonNode liste, String feld) {
        List<String> ids = new ArrayList<>();
        liste.forEach(n -> ids.add(n.get(feld).asText()));
        return ids;
    }

    private static List<String> namen(JsonNode liste) {
        List<String> namen = new ArrayList<>();
        liste.forEach(n -> namen.add(n.get("name").asText()));
        return namen;
    }

    /** Jedes Blatt einer Antwort als Zeichenkette — Zahlen kanonisch ohne nachlaufende Nullen. */
    private static List<String> blaetter(JsonNode wurzel) {
        List<String> alle = new ArrayList<>();
        sammeln(wurzel, alle);
        return alle;
    }

    private static void sammeln(JsonNode knoten, List<String> hinein) {
        if (knoten.isObject() || knoten.isArray()) {
            knoten.forEach(k -> sammeln(k, hinein));
            return;
        }
        if (knoten.isNumber()) {
            hinein.add(new BigDecimal(knoten.asText()).stripTrailingZeros().toPlainString());
            return;
        }
        if (!knoten.isNull()) {
            hinein.add(knoten.asText());
        }
    }

    private static String zahl(BigDecimal wert) {
        return wert.stripTrailingZeros().toPlainString();
    }

    private static Authentication konto(String sub) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", List.of()));
        claims.put("tenant_id", KUNDENBEREICH.toString());
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    // ------------------------------------------------------------------ Seed

    /**
     * Ein Kundenbereich nach dem Leitbeispiel: drei Standorte, vier Anlagen mit je einer Batterie, je ein Gerät
     * mit gemeldetem Edge-Stand. Peter ist Bearbeiter an ST-2, Claudia Leserin an ST-1 und ST-2, Jonas
     * Kundenadministrator (unternehmensweit).
     */
    private static void seed() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH') "
                + "ON CONFLICT DO NOTHING", KUNDENBEREICH);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                + "VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id",
                UUID.class, KUNDENBEREICH);

        standort(unternehmen, ST_1, "ST-1", "Werk Ahrenberg");
        standort(unternehmen, ST_2, "ST-2", "Werk Lindach");
        standort(unternehmen, ST_3, "ST-3", "Werk Ahrenberg Nord");

        anlage(AN_1, "AN-1 Halle 1", ST_1, HALLE_1, new BigDecimal("60"));
        anlage(AN_2, "AN-2 Halle 2", ST_1, HALLE_2, new BigDecimal("30"));
        anlage(AN_3, "AN-3 Werk Lindach", ST_2, LINDACH, new BigDecimal("10"));
        anlage(AN_4, "AN-4 Nordhalle", ST_3, NORD, new BigDecimal("20"));

        person(PETER, "bearbeiter", ST_2);
        person(CLAUDIA_SUB, "leser", ST_1);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'leser', ?, ?, 'Europe/Berlin')",
                KUNDENBEREICH, CLAUDIA_SUB, ST_2, ab());
        person(JONAS, "kundenadministrator", null);
    }

    private static void standort(UUID unternehmen, UUID id, String kurzzeichen, String name) {
        root.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin', 'aktiv')",
                id, KUNDENBEREICH, unternehmen, name, kurzzeichen);
    }

    private static void anlage(UUID id, String name, UUID standort, BigDecimal kwh, BigDecimal kw) {
        root.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')",
                id, KUNDENBEREICH, name);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2024-01-01')", KUNDENBEREICH, id, standort);
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw) "
                + "VALUES (?, ?, 'battery', ?, ?, ?)", KUNDENBEREICH, id, kwh, kw, kw);
        UUID device = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES (?, ?, ?, ?, 'gateway')",
                device, KUNDENBEREICH, id, "edge-" + name.substring(0, 4).trim().toLowerCase(java.util.Locale.ROOT));
        root.update("INSERT INTO device_edge_version (device_id, tenant_id, site_id, core_version, "
                + "palette_version, reported_at) VALUES (?, ?, ?, '1.2.3', '0.9.0', now())",
                device, KUNDENBEREICH, id);
    }

    private static void person(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", KUNDENBEREICH, sub, sub);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin')",
                KUNDENBEREICH, sub, rolle, standort, ab());
    }

    private static java.time.OffsetDateTime ab() {
        return LocalDate.parse("2024-01-01").atStartOfDay().atOffset(ZoneOffset.ofHours(1));
    }
}
