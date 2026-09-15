package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
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
 * Die Vorschlagsliste der BESTANDSÜBERNAHME je Standort (UEMS AP-04 IP-16, Abnahme A9) gegen die
 * echte Kette: Sicherheit, RLS, Flyway-Schema, die Regeln beider Zwillinge und die Schreibwege der
 * Messstellen-Schnittstelle.
 *
 * <p>Die Anlage ist Halle 1 des Referenzunternehmens: der Hybrid-Wechselrichter K-1 (PV-Leistung,
 * Netzleistung, Speicherleistung, Ladestand und die Attribut-Kanäle {@code soc_source_code} /
 * {@code bms_soc_pct}), der Netzzähler K-3 (Wirkenergie Bezug/Abgabe als Zählerstand, dazu seine
 * Vorzeichen-Leistung), die vier Unterzähler K-4…K-7 und der abgeleitete Hausverbrauch.
 *
 * <p><b>Was bewiesen wird (A9):</b> genau acht Vorschläge, nie ein Attribut-Kanal; vor dem
 * Bestätigen existiert keine Messstelle; nach „Alle übernehmen“ acht Messstellen mit einer Bindung
 * ab 12.03.2024 (rückwirkend, Herkunft „Bestandsübernahme“); die Anlage — Komponenten, Geräte,
 * Mess-Selektion, Reihen, Anlagen-Antworten und die Pushes an die Box — ist vor dem GET, nach dem
 * GET und nach der Übernahme byte-gleich; der zweite Aufruf der Liste ist leer und sagt es.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessstelleVorschlagApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    /** Der Beginn des Verlaufs von Halle 1 (Referenzunternehmen: 12.03.2024). */
    private static final String AB = "2024-03-12T00:00:00+01:00";

    private static final String PV = "fronius_solar_api.pv-power";
    private static final String NETZLEISTUNG = "fronius_solar_api.grid-power";
    private static final String SPEICHERLEISTUNG = "kaco_http_hybrid.battery-power";
    private static final String LADESTAND = "fronius_solar_api.battery-soc";
    private static final String SOC_HERKUNFT = "soc_source_code";
    private static final String BMS = "bms_soc_pct";
    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";
    private static final String ENERGIE_ABGABE = "sunspec.model_203.totwhexp";
    private static final String LEISTUNG_VORZEICHEN = "sunspec.model_203.w";

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

    /** Die Zustellung an die Box — der Beweis „dieselben Pushes“ liest, was ankäme. */
    @MockBean
    EntityRegistryPublisher registryPublisher;

    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MockMvc mvc;

    @Autowired
    EntityRegistryService registry;

    @Autowired
    FlowActivationService flows;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        reset(registryPublisher, flowPublisher);
    }

    // ================================================================== A9

    @Test
    void a9AchtVorschlaegeNieEinAttributKanalUndDieUebernahmeAbVerlaufsbeginn() throws Exception {
        Welt w = halle1();
        Abdruck vorher = abdruck(w);

        JsonNode liste = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null));
        assertThat(abdruck(w)).as("das GET schreibt nichts").isEqualTo(vorher);
        assertThat(alle(w.jonas, "/api/v1/messstellen").get("messstellen"))
                .as("vor dem Bestätigen gibt es keine Messstelle").isEmpty();

        JsonNode v = liste.get("vorschlaege");
        assertThat(v).as("genau acht Vorschläge (§5.15)").hasSize(8);
        assertThat(kennzeichen(v)).containsExactly("MS-0001", "MS-0002", "MS-0003", "MS-0004",
                "MS-0005", "MS-0006", "MS-0007", "MS-0008");
        assertThat(zeile(v, 0)).extracting("komponente", "kanal", "groesse", "richtung", "wertart",
                        "stellung", "ort", "ab")
                .containsExactly(w.k("K-3").toString(), ENERGIE_BEZUG, "Wirkenergie", "Bezug",
                        "Zählerstand", "Hauptzähler", "ST-1", AB);
        assertThat(zeile(v, 1)).extracting("kanal", "richtung", "stellung")
                .containsExactly(ENERGIE_ABGABE, "Abgabe", "Hauptzähler");
        assertThat(zeile(v, 2)).extracting("komponente", "kanal", "richtung", "wertart", "stellung")
                .containsExactly(w.k("K-1").toString(), PV, "Erzeugung", "Intervallmenge", "Erzeuger");
        assertThat(v.get(2).at("/quelle/herleitung").asText()).isEqualTo("integration");
        assertThat(zeile(v, 3)).extracting("komponente", "kanal", "richtung", "stellung")
                .containsExactly(w.k("K-1").toString(), SPEICHERLEISTUNG, "Laden / Entladen", "Speicher");
        assertThat(v.get(3).at("/nebengroessen/0/groesse/groesse").asText()).isEqualTo("Ladestand");
        assertThat(v.get(3).at("/nebengroessen/0/quelle/kanal").asText()).isEqualTo(LADESTAND);
        for (int i = 4; i < 8; i++) {
            assertThat(zeile(v, i)).extracting("kanal", "stellung")
                    .containsExactly(ENERGIE_BEZUG, "Unterzähler");
            assertThat(v.get(i).at("/unterzaehler_von/messstelle").asText()).isEqualTo("MS-0001");
            assertThat(v.get(i).at("/unterzaehler_von/bestehend").asBoolean()).isFalse();
        }
        // Attribut-Kanäle und der abgeleitete Hausverbrauch: nie ein Vorschlag, immer mit Grund.
        assertThat(kanaele(v)).doesNotContain(SOC_HERKUNFT, BMS);
        assertThat(ausgelassen(liste, SOC_HERKUNFT)).isEqualTo("attribut_kanal");
        assertThat(ausgelassen(liste, BMS)).isEqualTo("attribut_kanal");
        assertThat(ausgelassen(liste, NETZLEISTUNG)).isEqualTo("vergleich_kandidat");
        assertThat(ausgelassen(liste, LEISTUNG_VORZEICHEN)).isEqualTo("vorzeichen_wert");
        assertThat(grundDerKomponente(liste, w.k("K-HAUS"))).isEqualTo("abgeleitet");

        // „Alle übernehmen" — genau das, was die Liste zeigt.
        JsonNode u = ok(ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen", alle(v)));
        assertThat(u.get("neu").asInt()).isEqualTo(8);
        assertThat(u.get("unveraendert").asInt()).isZero();
        assertThat(u.get("messstellen")).hasSize(8);

        JsonNode messstellen = alle(w.jonas, "/api/v1/messstellen").get("messstellen");
        assertThat(messstellen).hasSize(8);
        for (JsonNode m : messstellen) {
            assertThat(m.at("/orte/0/kennzeichen").asText()).as(m.get("kennzeichen").asText() + " Ort")
                    .isEqualTo("ST-1");
            assertThat(m.at("/fuehrende_quelle/0/gueltig_ab").asText())
                    .as(m.get("kennzeichen").asText() + " Bindung ab Verlaufsbeginn").isEqualTo(AB);
            JsonNode quellen = ok(ruf(w.jonas, HttpMethod.GET,
                    "/api/v1/messstellen/" + m.get("id").asText() + "/quellen", null));
            JsonNode fuehrend = quellen.at("/groessen/0/fuehrend");
            assertThat(fuehrend.get("herkunft").asText()).as("Herkunft der Bindung")
                    .isEqualTo("bestandsuebernahme");
            assertThat(fuehrend.get("rueckwirkend").asBoolean()).as("rückwirkend eingetragen").isTrue();
        }
        assertThat(messstellen.get(0).at("/elektrische_stellung/0/stellung").asText()).isEqualTo("Hauptzähler");
        assertThat(messstellen.get(4).at("/elektrische_stellung/0/unterzaehler_von").asText())
                .isEqualTo("MS-0001");
        assertThat(messstellen.get(3).at("/nebengroessen/0/groesse").asText()).isEqualTo("Ladestand");

        // An der Anlage hat sich nichts geändert — dieselben Zeilen, Antworten und Pushes.
        assertThat(abdruck(w)).as("nach der Übernahme: die Anlage ist byte-gleich").isEqualTo(vorher);

        // Zweiter Aufruf: nichts mehr zu übernehmen, und die Fläche sagt es.
        JsonNode zweite = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null));
        assertThat(zweite.get("vorschlaege")).isEmpty();
        assertThat(zweite.get("leer").asText()).isEqualTo("alle_zugeordnet");
        assertThat(zweite.get("text").asText())
                .isEqualTo("Alle Komponenten von Werk Ahrenberg sind Messstellen zugeordnet.");
    }

    @Test
    void einZweiterAufrufDerUebernahmeLegtNichtsAn() throws Exception {
        Welt w = halle1();
        JsonNode v = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null)).get("vorschlaege");
        ok(ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen", alle(v)));
        Abdruck nachher = abdruck(w);
        int messstellen = alle(w.jonas, "/api/v1/messstellen").get("messstellen").size();

        JsonNode nochmal = ok(ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen", alle(v)));
        assertThat(nochmal.get("neu").asInt()).as("nichts Neues").isZero();
        assertThat(nochmal.get("unveraendert").asInt()).isEqualTo(8);
        assertThat(alle(w.jonas, "/api/v1/messstellen").get("messstellen")).hasSize(messstellen);
        assertThat(abdruck(w)).isEqualTo(nachher);
    }

    @Test
    void derKundeUebernimmtNurEinenTeilUndBenenntUm() throws Exception {
        Welt w = halle1();
        JsonNode v = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null)).get("vorschlaege");

        // Nur der Bezug des Netzzählers und der Unterzähler Verwaltung — mit eigenen Namen.
        List<Map<String, Object>> gewaehlt = new ArrayList<>();
        gewaehlt.add(bestaetigt(v.get(0), "Netzbezug Halle 1"));
        gewaehlt.add(bestaetigt(v.get(4), "Verwaltung gesamt"));
        JsonNode u = ok(ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen",
                Map.of("vorschlaege", gewaehlt)));
        assertThat(u.get("neu").asInt()).isEqualTo(2);
        assertThat(namen(u.get("messstellen"))).containsExactly("Netzbezug Halle 1", "Verwaltung gesamt");
        assertThat(kennzeichen(u.get("messstellen"))).containsExactly("MS-0001", "MS-0002");
        assertThat(u.get("messstellen").get(1).at("/elektrische_stellung/0/unterzaehler_von").asText())
                .as("der Unterzähler hängt am eben angelegten Hauptzähler").isEqualTo("MS-0001");

        // Die abgewählten Zeilen bleiben Vorschläge — mit den nächsten freien Kennzeichen.
        JsonNode zweite = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null));
        assertThat(zweite.get("vorschlaege")).hasSize(6);
        assertThat(kennzeichen(zweite.get("vorschlaege")).get(0)).isEqualTo("MS-0003");
        assertThat(zweite.get("vorschlaege").get(0).at("/quelle/kanal").asText()).isEqualTo(ENERGIE_ABGABE);
        for (JsonNode z : zweite.get("vorschlaege")) {
            if ("Unterzähler".equals(z.path("stellung").asText())) {
                assertThat(z.at("/unterzaehler_von/messstelle").asText()).isEqualTo("MS-0001");
                assertThat(z.at("/unterzaehler_von/bestehend").asBoolean())
                        .as("jetzt hängt er an einer BESTEHENDEN Messstelle").isTrue();
            }
        }
    }

    @Test
    void einGeaenderterVorschlagIst409UndSchreibtNichts() throws Exception {
        Welt w = halle1();
        JsonNode v = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null)).get("vorschlaege");
        Abdruck vorher = abdruck(w);

        Map<String, Object> b = bestaetigt(v.get(0), null);
        @SuppressWarnings("unchecked")
        Map<String, Object> groesse = new LinkedHashMap<>((Map<String, Object>) b.get("hauptgroesse"));
        groesse.put("wertart", "Intervallmenge");
        b.put("hauptgroesse", groesse);
        Antwort a = ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen",
                Map.of("vorschlaege", List.of(b)));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.body().get("code").asText()).isEqualTo("vorschlag_geaendert");
        assertThat(alle(w.jonas, "/api/v1/messstellen").get("messstellen")).isEmpty();
        assertThat(abdruck(w)).isEqualTo(vorher);

        // Und eine Zeile, deren Messwert es nicht (mehr) gibt: derselbe Code.
        Map<String, Object> fremd = bestaetigt(v.get(0), null);
        fremd.put("kanal", "sunspec.model_203.phv");
        Antwort b2 = ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen",
                Map.of("vorschlaege", List.of(fremd)));
        assertThat(b2.status()).isEqualTo(409);
        assertThat(b2.body().get("code").asText()).isEqualTo("vorschlag_geaendert");
    }

    @Test
    void einUnterzaehlerOhneSeinenHauptzaehlerIstAbgelehnt() throws Exception {
        Welt w = halle1();
        JsonNode v = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null)).get("vorschlaege");

        Antwort a = ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen",
                Map.of("vorschlaege", List.of(bestaetigt(v.get(4), null))));
        assertThat(a.status()).isEqualTo(422);
        assertThat(a.body().get("code").asText()).isEqualTo("stellung_ungueltig");
        assertThat(a.body().get("grund").asText()).isEqualTo("bezug_fehlt");
        assertThat(alle(w.jonas, "/api/v1/messstellen").get("messstellen"))
                .as("nichts ist geschrieben").isEmpty();
    }

    @Test
    void einFremderStandortIst404NieEine403() throws Exception {
        Welt a = halle1();
        Welt b = halle1();
        JsonNode v = ok(ruf(a.jonas, HttpMethod.GET, vorschlag(a), null)).get("vorschlaege");

        assertThat(ruf(b.jonas, HttpMethod.GET, vorschlag(a), null).status()).isEqualTo(404);
        assertThat(ruf(b.jonas, HttpMethod.POST, vorschlag(a) + "/uebernehmen", alle(v)).status())
                .isEqualTo(404);
        assertThat(alle(b.jonas, "/api/v1/messstellen").get("messstellen")).isEmpty();
        assertThat(alle(a.jonas, "/api/v1/messstellen").get("messstellen")).isEmpty();
    }

    // ====================================================== AP-01 IP-9b

    /**
     * Schritt 3 des Assistenten „Messen & Auswerten“ speichert über diese Route (AP-01 IP-9b): der
     * Vorschlag für den WAGO-Controller C-1 von Halle 2 ergibt vier Messstellen, und je Anlage gibt es
     * danach GENAU EINEN Hauptzähler — ein zweiter über die AP-04-Route ist 409 mit dem Satz, den der
     * Messstellen-Dialog (PR 788) schon zeigt.
     */
    @Test
    void wagoC1ErgibtVierMessstellenUndGenauEinenHauptzaehlerJeAnlage() throws Exception {
        Welt w = halle2();
        JsonNode v = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null)).get("vorschlaege");
        assertThat(v).as("vier Energiekarten, vier Vorschläge").hasSize(4);
        assertThat(kennzeichen(v)).containsExactly("MS-0001", "MS-0002", "MS-0003", "MS-0004");
        assertThat(zeile(v, 0)).extracting("komponente", "kanal", "groesse", "richtung", "stellung", "ort")
                .containsExactly(w.k("K-8.1").toString(), ENERGIE_BEZUG, "Wirkenergie", "Bezug", "Hauptzähler", "ST-1");
        for (int i = 1; i < 4; i++) {
            assertThat(zeile(v, i)).extracting("komponente", "kanal", "stellung")
                    .containsExactly(w.k("K-8." + (i + 1)).toString(), ENERGIE_BEZUG, "Unterzähler");
            assertThat(v.get(i).at("/unterzaehler_von/messstelle").asText()).isEqualTo("MS-0001");
            assertThat(v.get(i).at("/unterzaehler_von/bestehend").asBoolean()).isFalse();
        }
        for (JsonNode z : v) {
            assertThat(java.time.OffsetDateTime.parse(z.get("ab").asText()).toInstant())
                    .as("Beginn der Speisung von C-1").isEqualTo(HALLE2_AB.toInstant());
        }

        // Übernommen mit den Namen der Referenzdatei (MS-10 … MS-13).
        List<String> namen = List.of("Netzbezug Halle 2", "Spritzguss SG07–SG10", "Montage Linie M1",
                "Lager Halle 2 (Allgemein)");
        List<Map<String, Object>> bestaetigt = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            bestaetigt.add(bestaetigt(v.get(i), namen.get(i)));
        }
        JsonNode u = ok(ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen", Map.of("vorschlaege", bestaetigt)));
        assertThat(u.get("neu").asInt()).isEqualTo(4);
        assertThat(hauptzaehler(w)).as("genau ein Hauptzähler an Halle 2").containsExactly("MS-0001 Netzbezug Halle 2");

        // Ein zweiter Hauptzähler derselben Anlage über die AP-04-Route: abgelehnt, mit dem Satz aus PR 788.
        String spritzguss = idVon(alle(w.jonas, "/api/v1/messstellen").get("messstellen"), "MS-0002");
        String heute = java.time.LocalDate.now(BERLIN).toString();
        Antwort zweiter = ruf(w.jonas, HttpMethod.PUT, "/api/v1/messstellen/" + spritzguss + "/stellung",
                Map.of("anlage", w.anlage().toString(), "stellung", "Hauptzähler", "gueltig_ab", heute));
        assertThat(zweiter.status()).as("Antwort " + zweiter.body()).isEqualTo(409);
        assertThat(zweiter.body().get("code").asText()).isEqualTo("hauptzaehler_vorhanden");
        assertThat(zweiter.body().get("message").asText()).isEqualTo("Werk Ahrenberg – Halle 2 hat bereits einen "
                + "Hauptzähler: MS-0001 Netzbezug Halle 2. Wählen Sie „Unterzähler von MS-0001“ oder ändern Sie MS-0001.");
        assertThat(hauptzaehler(w)).as("nach der Ablehnung weiter genau einer").containsExactly("MS-0001 Netzbezug Halle 2");

        JsonNode danach = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null));
        assertThat(danach.get("vorschlaege")).as("kein zweiter Vorschlag").isEmpty();
        assertThat(danach.get("leer").asText()).isEqualTo("alle_zugeordnet");
    }

    /**
     * Hat Halle 2 schon einen Hauptzähler (von Hand angelegt, noch ohne Quelle), wird EK-1 kein zweiter:
     * sie steht als Kandidat für eine Vergleichsquelle unter den ausgelassenen Messwerten, und die drei
     * übrigen Karten hängen als Unterzähler am BESTEHENDEN — nach der Übernahme bleibt es bei einem.
     */
    @Test
    void einBestehenderHauptzaehlerBleibtDerEinzigeUndDieKartenHaengenAnIhm() throws Exception {
        Welt w = halle2();
        String tag = HALLE2_AB.toLocalDate().toString();
        JsonNode ms10 = ok(ruf(w.jonas, HttpMethod.POST, "/api/v1/messstellen", Map.of(
                "kennzeichen", "MS-10", "name", "Netzbezug Halle 2", "art", "gemessen", "medium", "Strom",
                "hauptgroesse", Map.of("groesse", "Wirkenergie", "richtung", "Bezug", "einheit", "kWh",
                        "wertart", "Zählerstand"),
                "nebengroessen", List.of())));
        String id = ms10.get("id").asText();
        ok(ruf(w.jonas, HttpMethod.PUT, "/api/v1/messstellen/" + id + "/ort",
                Map.of("kennzeichen", "ST-1", "gueltig_ab", tag)));
        ok(ruf(w.jonas, HttpMethod.PUT, "/api/v1/messstellen/" + id + "/stellung",
                Map.of("anlage", w.anlage().toString(), "stellung", "Hauptzähler", "gueltig_ab", tag)));

        JsonNode liste = ok(ruf(w.jonas, HttpMethod.GET, vorschlag(w), null));
        JsonNode v = liste.get("vorschlaege");
        assertThat(v).as("EK-1 wird kein zweiter Hauptzähler").hasSize(3);
        assertThat(ausgelassen(liste, ENERGIE_BEZUG)).isEqualTo("vergleich_kandidat");
        for (JsonNode z : v) {
            assertThat(z.get("stellung").asText()).isEqualTo("Unterzähler");
            assertThat(z.at("/unterzaehler_von/messstelle").asText()).isEqualTo("MS-10");
            assertThat(z.at("/unterzaehler_von/bestehend").asBoolean()).isTrue();
        }

        JsonNode u = ok(ruf(w.jonas, HttpMethod.POST, vorschlag(w) + "/uebernehmen", alle(v)));
        assertThat(u.get("neu").asInt()).isEqualTo(3);
        assertThat(hauptzaehler(w)).as("genau ein Hauptzähler an Halle 2").containsExactly("MS-10 Netzbezug Halle 2");
        int unterzaehler = 0;
        for (JsonNode z : alle(w.jonas, "/api/v1/messstellen").get("register")) {
            JsonNode s = z.get("elektrische_stellung");
            if (s != null && !s.isNull() && "Unterzähler".equals(s.get("stellung").asText())) {
                assertThat(s.get("unterzaehler_von").asText()).isEqualTo("MS-10");
                unterzaehler++;
            }
        }
        assertThat(unterzaehler).isEqualTo(3);
    }

    /** „MS-0001 Netzbezug Halle 2“ je Hauptzähler der Anlage im Register von heute. */
    private List<String> hauptzaehler(Welt w) throws Exception {
        List<String> out = new ArrayList<>();
        for (JsonNode z : alle(w.jonas, "/api/v1/messstellen").get("register")) {
            JsonNode s = z.get("elektrische_stellung");
            if (s != null && !s.isNull() && "Hauptzähler".equals(s.get("stellung").asText())
                    && w.anlage().toString().equals(s.get("anlage").asText())) {
                out.add(z.get("kennzeichen").asText() + " " + z.get("name").asText());
            }
        }
        return out;
    }

    private static String idVon(JsonNode messstellen, String kennzeichen) {
        for (JsonNode m : messstellen) {
            if (kennzeichen.equals(m.get("kennzeichen").asText())) {
                return m.get("id").asText();
            }
        }
        throw new AssertionError(kennzeichen + " gibt es nicht");
    }

    // ============================================================ die Welt

    /** Ein Kundenbereich mit Standort ST-1, Anlage AN-1, Box E-1 und den Komponenten K-1…K-7. */
    private record Welt(UUID mandant, UUID standort, UUID anlage, UUID box, Map<String, UUID> komponenten,
            Wer jonas) {
        UUID k(String kennzeichen) {
            return komponenten.get(kennzeichen);
        }
    }

    private Welt halle1() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Kunststoffwerk Ahrenberg GmbH #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, ?) RETURNING id",
                UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, "
                + "kurzzeichen, zeitzone, zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', "
                + "'aktiv') RETURNING id", UUID.class, t, u);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Werk Ahrenberg – Halle 1', ?::timestamptz) RETURNING id", UUID.class, t, AB);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?::date)", t, anlage, standort, "2024-03-12");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box Halle 1', 'claimed', ?::timestamptz) RETURNING id",
                UUID.class, t, anlage, "E-1-" + nr, AB);

        Map<String, UUID> k = new LinkedHashMap<>();
        k.put("K-1", komponente(t, anlage, box, "Hybrid-Wechselrichter 100 kW", "battery-hybrid",
                "{\"ip\":\"10.11.0.10\",\"port\":502,\"unit_id\":1}", "power_kw", "2024-03-12T00:00:01+01:00"));
        k.put("K-3", komponente(t, anlage, box, "Netzzähler Halle 1", "grid-meter",
                "{\"ip\":\"10.11.0.20\",\"port\":502,\"unit_id\":2}", "power_kw", "2024-03-12T00:00:02+01:00"));
        k.put("K-4", komponente(t, anlage, box, "Unterzähler Verwaltung", "modbus-generic",
                "{\"ip\":\"10.11.0.30\",\"port\":502,\"unit_id\":1}", null, "2024-03-12T00:00:03+01:00"));
        k.put("K-5", komponente(t, anlage, box, "Unterzähler Spritzguss SG01–SG06", "modbus-generic",
                "{\"ip\":\"10.11.0.30\",\"port\":502,\"unit_id\":2}", null, "2024-03-12T00:00:04+01:00"));
        k.put("K-6", komponente(t, anlage, box, "Unterzähler Druckluft", "modbus-generic",
                "{\"ip\":\"10.11.0.30\",\"port\":502,\"unit_id\":3}", null, "2024-03-12T00:00:05+01:00"));
        k.put("K-7", komponente(t, anlage, box, "Unterzähler Kühlung", "modbus-generic",
                "{\"ip\":\"10.11.0.30\",\"port\":502,\"unit_id\":4}", null, "2024-03-12T00:00:06+01:00"));
        // Der Hausverbrauch ist eine Ableitung der Box (komponiert, ohne eigenen Namen).
        k.put("K-HAUS", root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, source_kind, capabilities, created_at) VALUES (?, ?, "
                + "'house-load', NULL, 'house-load', ?, false, 'composed', ?::jsonb, ?::timestamptz) "
                + "RETURNING id", UUID.class, t, anlage, box,
                "{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}", "2024-03-12T00:00:07+01:00"));

        kanaele(t, anlage, box, k.get("K-1"), PV, NETZLEISTUNG, SPEICHERLEISTUNG, LADESTAND, SOC_HERKUNFT, BMS);
        kanaele(t, anlage, box, k.get("K-3"), ENERGIE_BEZUG, ENERGIE_ABGABE, LEISTUNG_VORZEICHEN);
        for (String kz : List.of("K-4", "K-5", "K-6", "K-7")) {
            kanaele(t, anlage, box, k.get(kz), ENERGIE_BEZUG, LEISTUNG_VORZEICHEN);
        }
        // Ein Stück gemessener Verlauf — er gehört der Komponente und bleibt ihr (A9).
        root.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, "
                + "channel, value) VALUES ('2026-09-01T10:00:00+02:00', '2026-09-01T10:00:05+02:00', ?, ?, ?, "
                + "?, 'power_kw', 312.4)", t, anlage, box, k.get("K-3").toString());
        return new Welt(t, standort, anlage, box, k,
                new Wer("sub-jonas-" + t, "Jonas Wendlinger", false, t));
    }

    private static final java.time.ZoneId BERLIN = java.time.ZoneId.of("Europe/Berlin");

    /**
     * Der Beginn von C-1 in diesem Lauf. Die Referenzdatei datiert ihn auf den 01.10.2026; der Test läuft
     * an der echten Uhr, und eine Speisung, die erst beginnt, ist keine laufende (ein Vorschlag beginnt nie
     * davor) — darum eine Woche vor heute, 00:00 am Standort.
     */
    private static final java.time.ZonedDateTime HALLE2_AB = java.time.ZonedDateTime.now(BERLIN).minusDays(7)
            .truncatedTo(java.time.temporal.ChronoUnit.DAYS);

    /**
     * Ein Kundenbereich mit Standort ST-1 und der Anlage Halle 2 (AN-2): Box Halle 2 (E-2) und der
     * WAGO-Controller C-1 mit den Energiekarten K-8.1 (Hauptmessung) … K-8.4 — Namen aus der Referenzdatei.
     */
    private Welt halle2() {
        int nr = NR.incrementAndGet();
        String ab = HALLE2_AB.toOffsetDateTime().toString();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Kunststoffwerk Ahrenberg GmbH #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, ?) RETURNING id",
                UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, "
                + "kurzzeichen, zeitzone, zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', "
                + "'aktiv') RETURNING id", UUID.class, t, u);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Werk Ahrenberg – Halle 2', ?::timestamptz) RETURNING id", UUID.class, t, ab);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?::date)", t, anlage, standort, HALLE2_AB.toLocalDate().toString());
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box Halle 2', 'claimed', ?::timestamptz) RETURNING id",
                UUID.class, t, anlage, "VP-BOX-2026-0482-" + nr, ab);

        Map<String, UUID> k = new LinkedHashMap<>();
        k.put("K-8.1", komponente(t, anlage, box, "Zähler Energiekarte EK-1 (Hauptmessung Halle 2)", "grid-meter",
                "{\"ip\":\"192.168.20.30\",\"port\":502,\"unit_id\":1}", "power_kw",
                HALLE2_AB.plusSeconds(1).toOffsetDateTime().toString()));
        k.put("K-8.2", komponente(t, anlage, box, "Zähler Energiekarte EK-2 (Spritzguss SG07–SG10)", "modbus-generic",
                "{\"ip\":\"192.168.20.30\",\"port\":502,\"unit_id\":2}", null,
                HALLE2_AB.plusSeconds(2).toOffsetDateTime().toString()));
        k.put("K-8.3", komponente(t, anlage, box, "Zähler Energiekarte EK-3 (Montage M1)", "modbus-generic",
                "{\"ip\":\"192.168.20.30\",\"port\":502,\"unit_id\":3}", null,
                HALLE2_AB.plusSeconds(3).toOffsetDateTime().toString()));
        k.put("K-8.4", komponente(t, anlage, box, "Zähler Energiekarte EK-4 (Lager Halle 2)", "modbus-generic",
                "{\"ip\":\"192.168.20.30\",\"port\":502,\"unit_id\":4}", null,
                HALLE2_AB.plusSeconds(4).toOffsetDateTime().toString()));
        for (String kz : List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4")) {
            kanaele(t, anlage, box, k.get(kz), ENERGIE_BEZUG, LEISTUNG_VORZEICHEN);
        }
        return new Welt(t, standort, anlage, box, k, new Wer("sub-jonas-" + t, "Jonas Wendlinger", false, t));
    }

    private UUID komponente(UUID tenant, UUID anlage, UUID box, String name, String art, String verbindung,
            String kanal, String erstellt) {
        String faehigkeiten = kanal == null ? null
                : "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}";
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, communication, connection_json, capabilities, created_at) "
                + "VALUES (?, ?, ?, ?, ?, ?, false, 'modbus_tcp', ?::jsonb, ?::jsonb, ?::timestamptz) "
                + "RETURNING id", UUID.class, tenant, anlage, art, name, art, box, verbindung, faehigkeiten,
                erstellt);
    }

    /** Die Mess-Selektion der Komponente: genau diese Kanäle liest ihre Box (IP-9). */
    private void kanaele(UUID tenant, UUID anlage, UUID box, UUID komponente, String... kanaele) {
        for (String kanal : kanaele) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                    + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, "
                    + "changed_by, apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, "
                    + "true, 60, 1, now(), '2026.08.26.3', 'test', 'pending_edge', 'energy_counter', "
                    + "'fifteen_minute') ON CONFLICT DO NOTHING", tenant, anlage, box, komponente, kanal);
        }
    }

    // ====================================================== die Gleichheit

    /**
     * Was die Übernahme NICHT anfassen darf: die Zeilen der Anlage (Komponenten, Mess-Selektion,
     * Geräte, Speisungen, Reihen, Box), die Antworten, die der Kunde sieht, und die zwei Pushes,
     * die die Box bekäme.
     */
    private record Abdruck(String zeilen, String entities, String komponenten, String topologie,
            String registry, UUID registryBox, String flow, UUID flowBox) {}

    private Abdruck abdruck(Welt w) throws Exception {
        String zeilen = root.queryForObject("""
                SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
                    SELECT 'mp:' || mp::text FROM measurement_point mp
                    UNION ALL SELECT 'sel:' || s::text FROM device_measurement_selection s
                    UNION ALL SELECT 'geraet:' || g::text FROM geraet g
                    UNION ALL SELECT 'speisung:' || v::text FROM geraet_komponente v
                    UNION ALL SELECT 'site:' || t::text FROM site t
                    UNION ALL SELECT 'device:' || d::text FROM device d
                    UNION ALL SELECT 'reihe:' || r::text FROM telemetry_v2 r
                    UNION ALL SELECT 'rolle:' || e::text FROM entity_role_assignment e
                ) t(x)
                """, String.class);
        Pushes p = pushes(w);
        return new Abdruck(zeilen,
                antwort(w, "/entities"), antwort(w, "/components"), antwort(w, "/topology"),
                p.registry(), p.registryBox(), p.flow(), p.flowBox());
    }

    /**
     * Eine Antwort der Anlage ohne ihre Uhr: die Zeitstempel der Zustellung (Revision, Stand des
     * Pushes) laufen mit jedem Aufruf weiter — was sie TRAGEN, muss gleich bleiben.
     */
    private String antwort(Welt w, String pfad) throws Exception {
        return ohneUhr(ok(ruf(w.jonas, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + pfad, null))).toString();
    }

    private static final List<String> UHR = List.of("revision", "sollRevision", "istRevision", "composedAt",
            "publishedAt", "published_at", "deployedAt", "deployed_at", "reportedAt", "reportedRevision",
            "observedAt", "health");

    private static JsonNode ohneUhr(JsonNode n) {
        if (n.isObject()) {
            ObjectNode o = (ObjectNode) n;
            UHR.forEach(o::remove);
            o.fields().forEachRemaining(e -> ohneUhr(e.getValue()));
        } else if (n.isArray()) {
            n.forEach(MessstelleVorschlagApiTest::ohneUhr);
        }
        return n;
    }

    private record Pushes(String registry, UUID registryBox, String flow, UUID flowBox) {}

    private Pushes pushes(Welt w) throws Exception {
        reset(registryPublisher, flowPublisher);
        when(registryPublisher.publishRegistry(any(), any(), any(), any())).thenReturn(true);
        when(flowPublisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
        TenantContext.set(w.mandant());
        try {
            registry.pushRegistryBestEffort(w.anlage());
            flows.republishForSite(w.anlage());
            ArgumentCaptor<UUID> rBox = ArgumentCaptor.forClass(UUID.class);
            ArgumentCaptor<byte[]> rPush = ArgumentCaptor.forClass(byte[].class);
            verify(registryPublisher).publishRegistry(eq(w.mandant()), eq(w.anlage()), rBox.capture(),
                    rPush.capture());
            ArgumentCaptor<UUID> fBox = ArgumentCaptor.forClass(UUID.class);
            ArgumentCaptor<byte[]> fPush = ArgumentCaptor.forClass(byte[].class);
            verify(flowPublisher).publishDeployment(eq(w.mandant()), eq(w.anlage()), fBox.capture(),
                    fPush.capture());
            return new Pushes(ohne(rPush.getValue(), "revision", "published_at"), rBox.getValue(),
                    ohne(fPush.getValue(), "deployed_at"), fBox.getValue());
        } finally {
            TenantContext.clear();
        }
    }

    private static String ohne(byte[] push, String... zeitstempel) throws IOException {
        ObjectNode n = (ObjectNode) MAPPER.readTree(push);
        for (String z : zeitstempel) {
            n.remove(z);
        }
        return n.toString();
    }

    // =========================================================== das Gerüst

    /** Die Bestätigung von allem, was die Liste zeigt — genau so, wie sie es zeigt. */
    private static Map<String, Object> alle(JsonNode vorschlaege) {
        List<Map<String, Object>> v = new ArrayList<>();
        vorschlaege.forEach(z -> v.add(bestaetigt(z, null)));
        return Map.of("vorschlaege", v);
    }

    /** Eine Zeile zurück, wie das GET sie gezeigt hat; {@code name} überschreibt den Vorschlag. */
    private static Map<String, Object> bestaetigt(JsonNode z, String name) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("komponente", z.get("komponente").asText());
        b.put("kanal", z.at("/quelle/kanal").asText());
        b.put("hauptgroesse", MAPPER.convertValue(z.get("hauptgroesse"), Map.class));
        b.put("nebengroessen", MAPPER.convertValue(z.get("nebengroessen"), List.class));
        b.put("stellung", z.get("stellung").isNull() ? null : z.get("stellung").asText());
        b.put("ab", z.get("ab").asText());
        if (name != null) {
            b.put("name", name);
        }
        return b;
    }

    private static List<String> kennzeichen(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(z -> out.add(z.get("kennzeichen").asText()));
        return out;
    }

    private static List<String> namen(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(z -> out.add(z.get("name").asText()));
        return out;
    }

    private static List<String> kanaele(JsonNode vorschlaege) {
        List<String> out = new ArrayList<>();
        vorschlaege.forEach(z -> out.add(z.at("/quelle/kanal").asText()));
        return out;
    }

    /** Die Felder einer Zeile, die §5.15 nennt — in der Reihenfolge der Tabelle. */
    private static Map<String, Object> zeile(JsonNode vorschlaege, int i) {
        JsonNode z = vorschlaege.get(i);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("komponente", z.get("komponente").asText());
        m.put("kanal", z.at("/quelle/kanal").asText());
        m.put("groesse", z.at("/hauptgroesse/groesse").asText());
        m.put("richtung", z.at("/hauptgroesse/richtung").asText());
        m.put("wertart", z.at("/hauptgroesse/wertart").asText());
        m.put("stellung", z.get("stellung").asText());
        m.put("ort", z.get("ort").asText());
        m.put("ab", z.get("ab").asText());
        return m;
    }

    private static String ausgelassen(JsonNode liste, String kanal) {
        for (JsonNode a : liste.get("ausgelassen")) {
            if (kanal.equals(a.path("kanal").asText(null))) {
                return a.get("grund").asText();
            }
        }
        throw new AssertionError("„" + kanal + "“ steht nicht unter den ausgelassenen Messwerten");
    }

    private static String grundDerKomponente(JsonNode liste, UUID komponente) {
        for (JsonNode a : liste.get("ausgelassen")) {
            if (komponente.toString().equals(a.path("komponente").asText()) && a.path("kanal").isNull()) {
                return a.get("grund").asText();
            }
        }
        throw new AssertionError(komponente + " steht nicht unter den ausgelassenen Komponenten");
    }

    private static String vorschlag(Welt w) {
        return "/api/v1/standorte/" + w.standort() + "/messstellen-vorschlag";
    }

    private JsonNode alle(Wer wer, String pfad) throws Exception {
        return ok(ruf(wer, HttpMethod.GET, pfad, null));
    }

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as("Antwort " + a.body()).isBetween(200, 299);
        return a.body();
    }

    private record Wer(String sub, String name, boolean plattform, UUID kundenbereich) {}

    private record Antwort(int status, JsonNode body) {}

    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    j.claim("name", wer.name());
                    j.claim("tenant_id", wer.kundenbereich().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(),
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
