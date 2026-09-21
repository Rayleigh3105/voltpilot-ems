package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.ApiApplication;
import com.voltpilot.api.flows.FlowCompilerHttp;
import com.voltpilot.api.measurement.MeasurementConfigStatusListener;
import com.voltpilot.api.measurement.MeasurementSelectionRepository;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.measurement.ZustellungOhneBroker;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeRegistry;
import com.voltpilot.api.probe.ProbeRequest;
import com.voltpilot.api.probe.ProbeResultListener;
import com.voltpilot.api.repo.FleetMetricsRepository;
import com.voltpilot.api.repo.UemsMetricsRepository;
import com.voltpilot.api.uems.ErwarteteKadenz;
import com.voltpilot.api.uems.KennzahlAufrufer;
import com.voltpilot.api.uems.KorrekturRechte;
import com.voltpilot.api.uems.LueckenMelder;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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
 * Abnahme AP-14 „Ein neuer reiner Messkunde kann den vollständigen Weg von der Datenquelle bis zum Bericht
 * nutzen" — ÜBER DAS PORTAL (Paket {@code vp-uems-messen-assistent-datenquelle-vorschlag}, Untersuchung
 * {@code vp-uems-messkunde-portalweg-datenquelle}, 21.09.2026). Die Untersuchung hat belegt, dass kein
 * Portal-Aufruf eine Komponente mit einer Datenquelle verknüpfte: der Writer schrieb jeden Wert ohne
 * {@code entity_id}, Reihe, Werte-Karte und Bericht blieben leer.
 *
 * <p><b>Nur Routen, die das Portal ruft.</b> Jede Route dieses Laufs steht in {@link #PORTAL_ROUTEN} und
 * muss in {@code frontend/portal/src/api.ts} vorkommen — ohne Messen-Assistent Schritt 2
 * ({@code DatenquelleVorschlagListe}) ist der Lauf darum rot. Einzige Ausnahme ist der Kundenbereich, der
 * bei der Registrierung entsteht ({@code POST /api/v1/admin/tenants}, Plattformverwaltung).
 *
 * <p><b>Zwei Anlagen, zwei Fälle.</b> E-1: der Kunde übernimmt in Schritt 2 den Vorschlag (neue Quelle).
 * E-2: der Kunde hat vorher „Datenquelle anlegen" gedrückt (Quelle + Zuständigkeit, keine Komponente);
 * der Vorschlag ist dann {@code adresse_an_box_vergeben}, und „Zu DQ-n hinzufügen" hängt die Komponenten
 * an die vorhandene Quelle ({@code datenquelle_id}) — früher 409, 0 Komponenten.
 *
 * <p><b>Höhe.</b> Die Bühne ist die von {@code DauerlaeuferGanzerWegDbTest}: Testcontainers mit TimescaleDB,
 * ganzes Flyway-Schema, api als Spring-Anwendung, MockMvc mit dem JWT des Kunden; die Box antwortet aus der
 * geprüften Vorlage {@code tools/edge-simulator/abnahme/dauerlaeufer-nw6.json} über den echten
 * {@code ProbeResultListener}, quittiert über den echten {@code MeasurementConfigStatusListener}. NICHT
 * durchlaufen: MQTT, ingest und der Writer — der Writer ist aus dem api-Modul nicht startbar; {@link
 * #schreibweg} stellt seine Nachschläge und sein Urteil nach. Echt laufen Lücken-Melder, Verdichtung,
 * Werte-Route und UEMS-Metrik.
 *
 * <p><b>Schnitt 2 (Paket {@code vp-uems-baukasten-messwert-groesse}):</b> der eigene Messwert von MS-06
 * trägt die Antwort auf „Was misst dieser Wert?" ({@code measures}: Energie-Zählerstand – Bezug). Er
 * bekommt über den Messstellen-Vorschlag eine Messstelle, seine Werte führen, die Werte-Karte zeigt eine
 * Menge. Die übrigen acht eigenen Messwerte bleiben OHNE Angabe, was sie waren: Beobachtung, im Vorschlag
 * ausgelassen mit {@code keine_messgroesse}. Die erste Messstelle des Assistenten hängt weiter am
 * Katalog-Kanal von MS-05.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(classes = ApiApplication.class)
@AutoConfigureMockMvc
@Import(PortalwegMesskundeAbnahmeTest.Fakes.class)
class PortalwegMesskundeAbnahmeTest {

    /**
     * Die flowc-Naht wie in {@code SelfBuildComponentApiTest}: der Baukasten baut beim Anlegen den Lese-Plan
     * über den flowc-Sidecar; hier kommt das Vertrags-Artefakt zurück. Der Sidecar ist nicht Teil der Box.
     */
    @TestConfiguration
    static class Fakes {
        @Bean
        FlowCompilerHttp flowCompilerHttp() throws IOException {
            String artefakt = Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "examples",
                    "flow-artifact.valid.artifact.json"));
            return (uri, body) -> new FlowCompilerHttp.Response(200, artefakt);
        }
    }

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final Path VORLAGE =
            Path.of("..", "..", "tools", "edge-simulator", "abnahme", "dauerlaeufer-nw6.json");

    /** Das „Jetzt“ der Vorlage: ihr letzter Takt liegt eine Minute davor. */
    private static final Instant NOW = Instant.parse("2026-11-03T10:00:00Z");
    /** ingest stempelt den Eingang; wie NW-4 zwei Sekunden nach der Messzeit. */
    private static final Duration EINGANG = Duration.ofSeconds(2);
    /** Die Schwelle von {@code VoltPilotDauerlaeuferStumm}: mehr als 15 Minuten ohne Messwert. */
    private static final double STUMM_S = 900;

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
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    /** Der ECHTE Lücken-Melder; sein Takt ist im Testlauf aus, der Lauf ruft ihn mit der eigenen Uhr. */
    @Autowired
    LueckenMelder melder;

    @MockBean
    KennzahlAufrufer aufrufer;

    /** Die Probe verlässt die api über MQTT; hier antwortet die Box aus der Vorlage (siehe {@link #box}). */
    @MockBean
    ProbePublisher probePublisher;

    @Autowired
    ProbeRegistry probeRegistry;

    @Autowired
    MeasurementSelectionRepository auswahlRepository;

    @Autowired
    MeasurementSelectionService auswahlService;

    @Autowired
    ErwarteteKadenz kadenzen;

    private final Map<String, Benutzer> personen = new LinkedHashMap<>();
    private JdbcTemplate root;
    private JdbcTemplate admin;
    private UUID kb;

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeEach
    void rechte() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        doAnswer(inv -> {
            ProtokollAkteur a = inv.getArgument(0);
            Benutzer b = personen.get(a.sub());
            return b != null ? b : KorrekturRechte.benutzer(a);
        }).when(aufrufer).benutzer(any());
        personen.put("kc-dauerlaeufer", new Benutzer("kc-dauerlaeufer", "Dauerläufer-Benutzer",
                Konto.vonCode("benutzer"), KontoZustand.AKTIV, List.of(new Zuweisung(
                        Rolle.vonCode("kundenadministrator"), null, null, null, Instant.EPOCH, null, null))));
    }

    /** Was an einer Stelle beobachtet wurde — als eine Zeile „BEFUND|…“ im Surefire-Ausgabe-Log. */
    private static void befund(String was, Object wert) {
        System.out.println("BEFUND|" + was + "|" + wert);
    }

    /**
     * Der Portal-Weg eines reinen Messkunden — GENAU die Aufrufe, die die Portal-Flächen nach diesem Paket
     * absetzen, und keine Route, die das Portal nicht ruft. Zugesichert: (1) alle Zähler tragen eine Quelle
     * und eine Zuständigkeit ihrer Box, (2) das Urteil des Writers ist für jeden Wert {@code fuehrend} oder
     * {@code beobachtung}, (3) der Lücken-Melder schreibt Reihen, die Verdichtung Viertelstunden, (4) die
     * Werte-Karte der Assistenten-Messstelle zeigt eine Menge, (5) „Datenquelle vorher angelegt" endet
     * nicht in 409.
     */
    @Test
    void portalwegEinesReinenMesskunden() throws Exception {
        String portal = Files.readString(Path.of("..", "..", "frontend", "portal", "src", "api.ts"));
        for (String route : PORTAL_ROUTEN) {
            assertThat(portal).as("Das Portal ruft " + route + " (api.ts) — sonst spielt dieser Lauf einen Umweg")
                    .contains(route);
        }

        JsonNode vorlage = vorlage();
        Map<String, JsonNode> einrichtung = new LinkedHashMap<>();
        vorlage.path("einrichtung").forEach(e -> einrichtung.put(e.path("box").asText(), e));

        // Kein Portal-Schritt des Kunden: der Kundenbereich entsteht bei der Registrierung.
        kb = id(ok(ruf(true, HttpMethod.POST, "/api/v1/admin/tenants",
                Map.of("name", "Portal-Messkunde (Nachstellung)")), 201));

        // PORTAL — Standort und zwei Anlagen „nur messen“ (AnlageFlow.tsx:586 → api.ts:7625).
        Map<String, Object> adresse = new LinkedHashMap<>();
        adresse.put("strasse", "Werkstraße 1");
        adresse.put("plz", null);
        adresse.put("ort", "Ahrenberg");
        adresse.put("land", "DE");
        UUID standort = id(ok(ruf(false, HttpMethod.POST, "/api/v1/standorte", Map.of("name", "Werk Portal",
                "zeitzone", "Europe/Berlin", "adresse", adresse)), 201));
        Map<String, UUID> anlagen = new LinkedHashMap<>();
        anlagen.put("E-1", id(ok(ruf(false, HttpMethod.POST, "/api/v1/sites",
                Map.of("name", "AN-1 (Halle 1)", "standortId", standort.toString())), 201)));
        anlagen.put("E-2", id(ok(ruf(false, HttpMethod.POST, "/api/v1/sites",
                Map.of("name", "AN-2 (Halle 2)", "standortId", standort.toString())), 201)));

        // PORTAL — Messen-Assistent Schritt 1 (MessenAssistent.tsx:360 → api.ts:8498).
        ok(ruf(false, HttpMethod.PUT, "/api/v1/standorte/" + standort + "/funktionen/messen",
                Map.of("aktion", "einrichten")), 200);

        // PORTAL — Box anmelden (AnlageFlow.tsx:1828 / DeviceDrawers.tsx:100 → api.ts:7650).
        Map<String, UUID> boxen = new LinkedHashMap<>();
        for (String code : anlagen.keySet()) {
            boxen.put(code, id(ok(ruf(false, HttpMethod.POST, "/api/v1/devices/claim", Map.of(
                    "siteId", anlagen.get(code).toString(),
                    "externalRef", "dauerlaeufer-" + code.toLowerCase().replace("-", ""))), 201)));
        }
        Map<String, String> ersetzt = new LinkedHashMap<>();
        ersetzt.put(vorlage.path("tenant_id").asText(), kb.toString());
        for (JsonNode b : vorlage.path("boxen")) {
            ersetzt.put(b.path("site_id").asText(), anlagen.get(b.path("code").asText()).toString());
            ersetzt.put(b.path("device_id").asText(), boxen.get(b.path("code").asText()).toString());
        }
        box = new BoxAusDerVorlage(einrichtung, boxen, ersetzt);
        doAnswer(inv -> box.lesen(inv.getArgument(0), inv.getArgument(1), inv.getArgument(2),
                inv.getArgument(3), inv.getArgument(6))).when(probePublisher)
                .publish(any(), any(), any(), any(), any(), any(), any());

        // PORTAL — Zähler im Modbus-Baukasten (SelbstbauAssistent.tsx:138 read, :159 anlegen).
        Map<String, UUID> komponente = new LinkedHashMap<>();
        Map<String, String> boxDer = new LinkedHashMap<>();
        for (JsonNode b : vorlage.path("boxen")) {
            String code = b.path("code").asText();
            JsonNode gw = b.path("gateway");
            Map<String, Object> verbindung = Map.of("host", gw.path("host").asText(),
                    "port", gw.path("port").asInt(), "unitId", gw.path("unit_id").asInt());
            ok(ruf(false, HttpMethod.POST, "/api/v1/sites/" + anlagen.get(code) + "/components/custom/read",
                    Map.of("deviceId", boxen.get(code).toString(), "connection", verbindung,
                            "channel", kanal(einrichtung.get(code), b.path("messstellen").get(0)))), 200);
            for (JsonNode m : b.path("messstellen")) {
                String ms = m.path("messstelle").asText();
                ok(ruf(false, HttpMethod.POST, "/api/v1/sites/" + anlagen.get(code) + "/components/custom",
                        Map.of("label", ms, "connection", verbindung,
                                "channels", List.of(kanal(einrichtung.get(code), m)))), 200);
                komponente.put(ms, root.queryForObject("SELECT id FROM measurement_point "
                        + "WHERE tenant_id = ? AND site_id = ? AND label = ?", UUID.class, kb, anlagen.get(code), ms));
                ersetzt.put(m.path("entity_id").asText(), komponente.get(ms).toString());
                boxDer.put(ms, code);
            }
        }
        assertThat(komponente).as("Baukasten-Zähler der Vorlage").hasSize(9);

        // PORTAL — „Eigenen Messwert hinzufügen“ (BeobachteteRegister.tsx:558 → api.ts:7162).
        Map<String, String> schluessel = new LinkedHashMap<>();
        for (JsonNode b : vorlage.path("boxen")) {
            String code = b.path("code").asText();
            UUID an = boxen.get(code);
            for (JsonNode m : b.path("messstellen")) {
                String ms = m.path("messstelle").asText();
                ObjectNode definition = definition(einrichtung.get(code), m).deepCopy();
                definition.remove("requestCostMs");
                if (MIT_ANGABE.equals(ms)) {
                    // „Was misst dieser Wert?" → Energie-Zählerstand – Bezug (eigenerMesswert.ts).
                    definition.putObject("measures").put("quantity", "active_energy").put("direction", "import")
                            .put("aggregationKind", "counter");
                }
                Antwort eigen = ok(ruf(false, HttpMethod.POST, "/api/v1/devices/" + an
                        + "/measurement-selection/custom?entityId=" + komponente.get(ms), Map.of(
                        "expectedRevision", revision(an), "idempotencyKey", UUID.randomUUID().toString(),
                        "definition", MAPPER.convertValue(definition, Map.class))), 200);
                List<String> neu = new ArrayList<>();
                eigen.body().path("selections").forEach(s -> neu.add(s.path("pointKey").asText()));
                neu.removeAll(schluessel.values());
                schluessel.put(ms, neu.get(0));
                ersetzt.put(m.path("point_key").asText(), neu.get(0));
            }
        }

        // BOX — Zustellung und Quittung (wie DauerlaeuferGanzerWegDbTest; kein Broker).
        MeasurementConfigStatusListener quittungen =
                new MeasurementConfigStatusListener("tcp://127.0.0.1:9", "", "", auswahlRepository, MAPPER);
        for (String code : boxen.keySet()) {
            JsonNode e = einrichtung.get(code);
            ZustellungOhneBroker.dokument(auswahlRepository, auswahlService, kadenzen, MAPPER, kb, boxen.get(code));
            quittungen.handle(ersetzen(e.at("/quittung/topic"), ersetzt).asText(),
                    MAPPER.writeValueAsBytes(ersetzen(e.at("/quittung/nutzlast"), ersetzt)));
        }
        assertThat(zahl("SELECT count(*) FROM device_measurement_selection WHERE tenant_id = ? "
                + "AND apply_status = 'applied'", kb)).as("Auswahl quittiert").isEqualTo(9);

        // PORTAL — ein Katalog-Messwert MIT Größe an MS-05 (BeobachteteRegister.tsx → api.ts, PUT
        // …/measurement-selection/{key}): sunspec.model_203.totwhimp = Wirkenergie Bezug. Er trägt die Messstelle
        // des Assistenten (Schritt 3); ein eigener Messwert des Baukastens trägt keine Größe (nicht im Umfang).
        UUID e1 = boxen.get("E-1");
        ok(ruf(false, HttpMethod.PUT, "/api/v1/devices/" + e1
                + "/measurement-selection/sunspec.model_203.totwhimp?entityId=" + komponente.get("MS-05"),
                Map.of("expectedRevision", revision(e1), "idempotencyKey", UUID.randomUUID().toString(),
                        "enabled", true)), 200);
        Map<String, String> zusatz = Map.of("MS-05", "sunspec.model_203.totwhimp");

        // BOX — E-1 bekommt die neue Revision zugestellt und quittiert sie samt Katalog-Kanal (die Vorlage
        // quittiert nur ihre vier eigenen Messwerte; die Box quittiert jede Revision, die sie anwendet).
        ZustellungOhneBroker.dokument(auswahlRepository, auswahlService, kadenzen, MAPPER, kb, e1);
        ObjectNode zweite = (ObjectNode) ersetzen(einrichtung.get("E-1").at("/quittung/nutzlast"), ersetzt);
        ((ArrayNode) zweite.path("accepted")).add("sunspec.model_203.totwhimp");
        zweite.put("revision", revision(e1));
        quittungen.handle(ersetzen(einrichtung.get("E-1").at("/quittung/topic"), ersetzt).asText(),
                MAPPER.writeValueAsBytes(zweite));
        assertThat(zahl("SELECT count(*) FROM device_measurement_selection WHERE device_id = ? "
                + "AND point_key = 'sunspec.model_203.totwhimp' AND apply_status = 'applied'", e1))
                .as("Katalog-Kanal quittiert").isEqualTo(1);

        // PORTAL — Messen-Assistent Schritt 2, NUR E-2 vorher: der Knopf „Datenquelle anlegen"
        // (MessenAssistent.tsx → DatenquelleAnlegen.tsx: anlegen, prüfen, Zuständigkeit).
        UUID handQuelle;
        {
            UUID an = anlagen.get("E-2");
            JsonNode gw = vorlage.path("boxen").get(1).path("gateway");
            Map<String, Object> dq = new LinkedHashMap<>();
            dq.put("name", "Gateway Halle 2");
            dq.put("protokoll", "modbus_tcp");
            dq.put("adresse", gw.path("host").asText() + ":" + gw.path("port").asInt());
            dq.put("geraete_ids", List.of(gw.path("unit_id").asInt()));
            dq.put("netz", "VLAN 20");
            dq.put("mehrere_leser", false);
            dq.put("steuerquelle", false);
            dq.put("kadenz_s", 60);
            dq.put("device_id", boxen.get("E-2").toString());
            handQuelle = id(ok(ruf(false, HttpMethod.POST, "/api/v1/sites/" + an + "/data-sources", dq), 201));
            ok(ruf(false, HttpMethod.POST, "/api/v1/sites/" + an + "/data-sources/" + handQuelle
                    + "/reachability-check", Map.of("device_id", boxen.get("E-2").toString(),
                    "unit_id", gw.path("unit_id").asInt(), "register", 500)), 200);
            ok(ruf(false, HttpMethod.POST, "/api/v1/sites/" + an + "/data-sources/" + handQuelle
                    + "/assignments", Map.of("device_id", boxen.get("E-2").toString())), 201);
        }

        // PORTAL — Messen-Assistent Schritt 2: die Datenquellen-Vorschlagsliste je Anlage
        // (DatenquelleVorschlagListe.tsx → api.ts datenquellenVorschlag/datenquellenVorschlagUebernehmen; Anfrage
        // wie datenquelleVorschlag.ts: „Übernehmen" bestätigt die freien Zeilen so, wie die Liste sie zeigt,
        // „Zu DQ-n hinzufügen" je gesperrter Zeile mit ihrem Ziel).
        Map<String, JsonNode> schritt2 = new LinkedHashMap<>();
        for (String code : anlagen.keySet()) {
            String basis = "/api/v1/sites/" + anlagen.get(code) + "/data-sources/vorschlag";
            JsonNode liste2 = ok(ruf(false, HttpMethod.GET, basis, null), 200).body();
            befund(code + " Datenquellen-Vorschlag", liste2.path("vorschlaege").size() + " Vorschläge, ausgelassen "
                    + liste2.path("ausgelassen").size());
            List<Map<String, Object>> frei = new ArrayList<>();
            for (JsonNode v : liste2.path("vorschlaege")) {
                if (v.path("grund").isNull()) {
                    frei.add(bestaetigt(v, null));
                } else {
                    assertThat(v.path("ziel").isObject()).as(code + ": gesperrt ohne Ausweg " + v).isTrue();
                    schritt2.put(code + " hinzufügen", ok(ruf(false, HttpMethod.POST, basis + "/uebernehmen",
                            Map.of("vorschlaege", List.of(bestaetigt(v, v.at("/ziel/id").asText())))), 200).body());
                }
            }
            if (!frei.isEmpty()) {
                schritt2.put(code + " übernehmen", ok(ruf(false, HttpMethod.POST, basis + "/uebernehmen",
                        Map.of("vorschlaege", frei)), 200).body());
            }
        }
        befund("Schritt 2", schritt2);
        assertThat(schritt2.get("E-1 übernehmen").path("neu").asInt()).as("E-1 neue Quelle").isEqualTo(1);
        // (5) „Datenquelle vorher angelegt": die Komponenten hängen an DQ-1 — kein 409, keine zweite Quelle.
        assertThat(schritt2).as("E-2 kennt nur den Ausweg an die Handquelle").doesNotContainKey("E-2 übernehmen");
        JsonNode e2 = schritt2.get("E-2 hinzufügen");
        assertThat(e2).as("E-2: Zu DQ-1 hinzufügen").isNotNull();
        assertThat(e2.path("angehaengt").asInt()).isEqualTo(1);
        assertThat(e2.at("/datenquellen/0/id").asText()).isEqualTo(handQuelle.toString());

        // PORTAL — Messen-Assistent Schritt 3: Messstellen-Vorschlag übernehmen (Anfrage wie
        // messenAssistent.ts uebernehmenAnfrage — jede Zeile so, wie die Liste sie zeigt).
        Antwort liste = ok(ruf(false, HttpMethod.GET, "/api/v1/standorte/" + standort + "/messstellen-vorschlag",
                null), 200);
        befund("Messstellen-Vorschlag", liste.body());
        // Schnitt 2: der eigene Messwert MIT Angabe steht im Vorschlag; die ohne Angabe bleiben ausgelassen
        // wie vor dem Paket (keine_messgroesse).
        List<String> vorgeschlagen = new ArrayList<>();
        liste.body().path("vorschlaege").forEach(v -> vorgeschlagen.add(v.at("/quelle/kanal").asText()));
        assertThat(vorgeschlagen).as("Vorschlag").contains(schluessel.get(MIT_ANGABE), "sunspec.model_203.totwhimp");
        Map<String, String> ausgelassen = new LinkedHashMap<>();
        liste.body().path("ausgelassen").forEach(a -> ausgelassen.put(a.path("kanal").asText(), a.path("grund").asText()));
        for (Map.Entry<String, String> e : schluessel.entrySet()) {
            if (!MIT_ANGABE.equals(e.getKey())) {
                assertThat(ausgelassen.get(e.getValue())).as(e.getKey() + " ohne Angabe").isEqualTo("keine_messgroesse");
            }
        }
        List<Map<String, Object>> gewaehlt = new ArrayList<>();
        for (JsonNode v : liste.body().path("vorschlaege")) {
            Map<String, Object> z = new LinkedHashMap<>();
            z.put("komponente", v.path("komponente").asText());
            z.put("kanal", v.at("/quelle/kanal").asText());
            z.put("hauptgroesse", MAPPER.convertValue(v.path("hauptgroesse"), Object.class));
            z.put("nebengroessen", MAPPER.convertValue(v.path("nebengroessen"), Object.class));
            z.put("stellung", v.path("stellung").isNull() ? null : v.path("stellung").asText());
            z.put("ab", v.path("ab").isNull() ? null : v.path("ab").asText());
            gewaehlt.add(z);
        }
        Antwort uebernommen = ok(ruf(false, HttpMethod.POST, "/api/v1/standorte/" + standort
                + "/messstellen-vorschlag/uebernehmen", Map.of("vorschlaege", gewaehlt)), 200);
        String assistentMs = uebernommen.body().path("messstellen").path(0).path("kennzeichen").asText();
        assertThat(assistentMs).as("Messstelle aus dem Assistenten").isNotBlank();
        List<String> baukastenMs = root.queryForList("SELECT m.kennzeichen FROM messstelle_quelle q "
                + "JOIN messstelle m ON m.id = q.messstelle_id WHERE q.entity_id = ? AND q.kanal = ?",
                String.class, komponente.get(MIT_ANGABE), schluessel.get(MIT_ANGABE));
        befund("Messstelle des Baukasten-Zählers mit Angabe", baukastenMs);
        assertThat(baukastenMs).as("der Baukasten-Zähler mit Angabe bekommt EINE Messstelle").hasSize(1);

        // ============================== nach dem Portal-Weg: die Werte der Box
        // (1) Jeder Zähler trägt eine Quelle, und die liest seine Box zu den Messzeiten der Vorlage (die
        // Zuständigkeit beginnt an der nächsten vollen Minute der echten Uhr; die Vorlage misst am 03.11.2026).
        Timestamp messzeit = Timestamp.from(NOW.minus(Duration.ofHours(1)));
        for (Map.Entry<String, UUID> k : komponente.entrySet()) {
            UUID box = boxen.get(boxDer.get(k.getKey()));
            assertThat(zahl("SELECT count(*) FROM measurement_point mp JOIN data_source_assignment a "
                    + "ON a.data_source_id = mp.data_source_id WHERE mp.id = ? AND a.device_id = ? "
                    + "AND a.effective_from <= ? AND (a.effective_to IS NULL OR a.effective_to > ?)",
                    k.getValue(), box, messzeit, messzeit))
                    .as(k.getKey() + ": Quelle mit Zuständigkeit von " + boxDer.get(k.getKey())).isEqualTo(1);
        }
        MutableUhr uhr = new MutableUhr(NOW.minus(Duration.ofMinutes(10)));
        melder.lauf(uhr.instant());
        // (2) Das Urteil des Writers: für jeden Wert führend oder Beobachtung — nie ohne Herkunft.
        Map<String, Long> urteile = schreibweg(vorlage, anlagen, boxen, schluessel, zusatz, Duration.ZERO);
        befund("Writer-Urteil je Wert", urteile);
        assertThat(urteile.keySet()).as("Urteile " + urteile)
                .isSubsetOf("fuehrend", "beobachtung", "katalog:fuehrend", "katalog:beobachtung");
        assertThat(urteile.values().stream().mapToLong(Long::longValue).sum()).isEqualTo(50);
        assertThat(urteile.get("katalog:fuehrend")).as("die Assistenten-Messstelle führt").isEqualTo(5);
        assertThat(urteile.get("fuehrend")).as("der Baukasten-Zähler mit Angabe führt").isEqualTo(5);
        assertThat(urteile.get("beobachtung")).as("die acht ohne Angabe bleiben Beobachtung").isEqualTo(40);
        // (3) Lücken-Melder: eine Reihe je Zähler; Verdichtung: Viertelstunden.
        uhr.stellen(NOW.plus(Duration.ofSeconds(90)));
        melder.lauf(uhr.instant());
        assertThat(zahl("SELECT count(*) FROM messreihe_luecke_stand WHERE tenant_id = ? AND art = 'reihe'", kb))
                .as("Lücken-Melder: Reihen").isGreaterThan(0);
        assertThat(verdichtet(uhr.instant())).as("Viertelstunden der Messreihe").isGreaterThan(0);
        // (4) Die Werte-Karte der Assistenten-Messstelle zeigt eine Menge — in den Viertelstunden des Tages
        // (den Tag bildet erst der Tageslauf; ohne ihn sagt die Karte ehrlich „noch nicht gebildet“).
        JsonNode werte = ok(ruf(false, HttpMethod.GET, "/api/v1/messstellen/" + assistentMs
                + "/werte?raster=viertelstunde&von=2026-11-03&bis=2026-11-03", null), 200).body();
        List<JsonNode> mitMenge = new ArrayList<>();
        werte.path("werte").forEach(w -> {
            if (w.path("menge").isNumber()) {
                mitMenge.add(w);
            }
        });
        befund("Werte an der Assistenten-Messstelle", mitMenge.size() + " Viertelstunden mit Menge, erste "
                + (mitMenge.isEmpty() ? werte.path("werte").path(0) : mitMenge.get(0)));
        assertThat(mitMenge).as("Viertelstunden der Werte-Karte mit Menge").isNotEmpty();
        assertThat(mitMenge.get(0).path("erhalten").asInt()).as("erhaltene Werte").isGreaterThan(0);
        JsonNode baukastenWerte = ok(ruf(false, HttpMethod.GET, "/api/v1/messstellen/" + baukastenMs.get(0)
                + "/werte?raster=viertelstunde&von=2026-11-03&bis=2026-11-03", null), 200).body();
        List<JsonNode> baukastenMenge = new ArrayList<>();
        baukastenWerte.path("werte").forEach(w -> {
            if (w.path("menge").isNumber()) {
                baukastenMenge.add(w);
            }
        });
        befund("Werte am Baukasten-Zähler mit Angabe", baukastenMenge.size() + " Viertelstunden mit Menge, erste "
                + (baukastenMenge.isEmpty() ? baukastenWerte.path("werte").path(0) : baukastenMenge.get(0)));
        assertThat(baukastenMenge).as("Werte-Karte des Baukasten-Zählers mit Menge").isNotEmpty();
        // (5) Nach der Übernahme gehören die Werte zur Reihe: weder das Register noch die Werte-Karte sagen
        // „noch keiner Messreihe zugeordnet“ (Messstelle liefert Daten ehrlich).
        assertThat(werte.path("zuordnung").isNull()).as("Werte-Karte ohne zuordnung").isTrue();
        JsonNode reg = ok(ruf(false, HttpMethod.GET, "/api/v1/messstellen?stichtag=" + uhr.instant(), null), 200)
                .body();
        List<JsonNode> zeile = new ArrayList<>();
        reg.path("register").forEach(z -> {
            if (assistentMs.equals(z.path("kennzeichen").asText())) {
                zeile.add(z);
            }
        });
        befund("Register der Assistenten-Messstelle", zeile);
        assertThat(zeile).hasSize(1);
        assertThat(zeile.get(0).path("beobachtung").has("zuordnung")).as("Register ohne zuordnung").isFalse();
        assertThat(zeile.get(0).at("/beobachtung/zustand").asText()).isIn("liefert", "liefert_nicht_seit");
        String metrik = metrik(uhr);
        befund("Messkunden-Metrik", metrik);
        assertThat(metrik).as("Messkunde nicht mehr „nie“").contains("zustand=\"nie\"} 0.0");
    }

    /** Der eigene Messwert, dem der Kunde sagt, was er misst (Schnitt 2); alle anderen bleiben ohne Angabe. */
    private static final String MIT_ANGABE = "MS-06";

    /** Die Routen dieses Laufs, so wie {@code api.ts} sie ruft — ohne sie spielte der Lauf einen Umweg. */
    private static final List<String> PORTAL_ROUTEN = List.of("'/api/v1/standorte'", "/api/v1/sites`",
            "/funktionen/messen`", "/api/v1/devices/claim'", "/components/custom/read`", "/components/custom`",
            "/measurement-selection/custom", "/measurement-selection${entityId",
            "/measurement-selection/${encodeURIComponent(pointKey)}", "/data-sources`", "/reachability-check`", "/assignments`",
            "/data-sources/vorschlag`", "/data-sources/vorschlag/uebernehmen`", "/messstellen-vorschlag`",
            "/messstellen-vorschlag/uebernehmen`", "/werte");

    /** Wie das Portal ({@code datenquelleVorschlag.ts}): eine Zeile so bestätigen, wie die Liste sie zeigt. */
    private static Map<String, Object> bestaetigt(JsonNode v, String ziel) {
        List<String> komponenten = new ArrayList<>();
        v.path("komponenten").forEach(k -> komponenten.add(k.path("id").asText()));
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("device_id", v.at("/box/id").asText());
        b.put("protokoll", v.path("protokoll").asText());
        b.put("adresse", v.path("adresse").asText());
        b.put("komponenten", komponenten);
        if (ziel != null) {
            b.put("datenquelle_id", ziel);
        }
        return b;
    }

    /**
     * Der Writer, nachgestellt (er ist aus dem api-Modul nicht startbar): je Wert der Vorlage GENAU seine
     * Nachschläge — Reihe {@code HerkunftNachschlag.java:153-165} wörtlich, {@code uems()} :105-108, Einbau,
     * Fassung, Zuständigkeit, Bindung — und das Urteil {@code MesswertHerkunft.java:437-461}; geschrieben wird
     * die Zeile wie {@code MeasurementWriteRepository.java:249-269} (ohne Herkunft alle sieben Spalten NULL).
     */
    private Map<String, Long> schreibweg(JsonNode vorlage, Map<String, UUID> anlagen, Map<String, UUID> boxen,
            Map<String, String> schluessel, Map<String, String> zusatz, Duration versatz) {
        Map<String, Long> urteile = new LinkedHashMap<>();
        for (JsonNode z : vorlage.path("zustellungen")) {
            String code = z.path("box").asText();
            UUID dev = boxen.get(code);
            JsonNode n = z.path("nutzlast");
            for (JsonNode s : n.path("samples")) {
                String alt = s.path("point_key").asText();
                String msName = vorlage.path("boxen").findValues("messstellen").stream()
                        .flatMap(x -> java.util.stream.StreamSupport.stream(x.spliterator(), false))
                        .filter(m -> m.path("point_key").asText().equals(alt)).findFirst().orElseThrow()
                        .path("messstelle").asText();
                List<String> pks = new ArrayList<>(List.of(schluessel.get(msName)));
                if (zusatz.containsKey(msName)) {
                    pks.add(zusatz.get(msName));
                }
                for (String pk : pks) {
                Instant messzeit = Instant.parse(s.path("observed_at").asText()).plus(versatz);
                List<Map<String, Object>> reihe = root.queryForList(
                        "WITH a AS (SELECT count(*) AS n, count(entity_id) AS ne, "
                                + "(array_agg(entity_id))[1] AS eid FROM device_measurement_selection "
                                + "WHERE device_id=? AND point_key IN (?,?)) "
                                + "SELECT CASE WHEN a.n=1 AND a.ne=1 THEN a.eid END AS entity_id, "
                                + "mp.data_source_id, ds.kadenz_s FROM a "
                                + "LEFT JOIN measurement_point mp ON a.n=1 AND a.ne=1 AND mp.id=a.eid "
                                + "LEFT JOIN data_source ds ON ds.id=mp.data_source_id", dev, pk, pk);
                UUID entity = (UUID) reihe.get(0).get("entity_id");
                UUID quelle = (UUID) reihe.get(0).get("data_source_id");
                String urteil;
                String rolle = null;
                Long fassung = null;
                if (entity == null || quelle == null) {
                    urteil = "ohne_herkunft(uems=false: entity=" + (entity != null) + ",datenquelle=" + (quelle != null) + ")";
                } else {
                    long einbau = zahl("SELECT count(*) FROM geraet_komponente WHERE entity_id = ? AND gueltig_ab <= ? "
                            + "AND (gueltig_bis IS NULL OR gueltig_bis > ?)", entity, Timestamp.from(messzeit),
                            Timestamp.from(messzeit));
                    List<Long> f = root.queryForList("SELECT desired_revision FROM device_measurement_selection "
                            + "WHERE device_id = ? AND point_key = ? AND applied_at IS NOT NULL AND applied_at <= ?",
                            Long.class, dev, pk, Timestamp.from(messzeit));
                    fassung = f.isEmpty() ? null : f.get(0);
                    List<UUID> zustaendig = root.queryForList("SELECT device_id FROM data_source_assignment "
                            + "WHERE data_source_id = ? AND effective_from <= ? AND (effective_to IS NULL "
                            + "OR effective_to > ?)", UUID.class, quelle, Timestamp.from(messzeit),
                            Timestamp.from(messzeit));
                    List<String> bindung = root.queryForList("SELECT rolle FROM messstelle_quelle WHERE entity_id = ? "
                            + "AND kanal = ? AND gueltig_ab <= ? AND (gueltig_bis IS NULL OR gueltig_bis > ?)",
                            String.class, entity, pk, Timestamp.from(messzeit), Timestamp.from(messzeit));
                    if (einbau == 0 || fassung == null) {
                        urteil = "abgewiesen(einbau=" + einbau + ",fassung=" + fassung + ")";
                    } else if (zustaendig.isEmpty() || !zustaendig.get(0).equals(dev)) {
                        urteil = rolle = "spiegel";
                    } else {
                        rolle = bindung.isEmpty() ? "beobachtung"
                                : "fuehrend".equals(bindung.get(0)) ? "fuehrend" : "vergleich";
                        urteil = rolle;
                    }
                }
                urteile.merge((pk.startsWith("sunspec") ? "katalog:" : "") + urteil, 1L, Long::sum);
                boolean mitHerkunft = rolle != null;
                root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                        + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, entity_id, "
                        + "applied_revision, aggregation_kind, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, "
                        + "?, ?, ?, ?, ?, ?, ?, ?, ?, 'counter', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                        Timestamp.from(messzeit), Timestamp.from(messzeit.plus(EINGANG)), kb, anlagen.get(code), dev,
                        pk, s.path("raw").decimalValue(), s.path("decoded").decimalValue(), s.path("quality").asText(),
                        n.path("catalog_version").asText(), n.path("sequence").asLong(),
                        mitHerkunft ? entity : null, mitHerkunft ? fassung : null, mitHerkunft ? "counter" : null,
                        rolle, mitHerkunft ? "direkt" : null, mitHerkunft ? 2 : null);
                }
            }
        }
        return urteile;
    }

    /** Die Verdichtung wie im Betrieb (UemsMesskundenLaufAbnahmeTest#kette): wie viele Viertelstunden stehen? */
    private long verdichtet(Instant jetzt) {
        com.voltpilot.api.uems.ViertelstundeVerdichter v = new com.voltpilot.api.uems.ViertelstundeVerdichter(admin,
                new com.voltpilot.api.measurement.MeasurementCatalog(MAPPER),
                new com.voltpilot.api.uems.SpaetankunftMelder(), 500, 40, 200_000);
        for (int i = 0; i < 400; i++) {
            com.voltpilot.api.uems.ViertelstundeVerdichter.Lauf l = v.lauf(jetzt);
            if (l.rueckrechnungFertig() && zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit") == 0) {
                break;
            }
        }
        return zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE tenant_id = ?", kb);
    }

    /** Was die Messstellen-Seite des Portals zeigt: je Messstelle Kennzeichen und Beobachtung (Zustand · Satz). */
    private List<String> register(String stichtag) throws Exception {
        Antwort r = ruf(false, HttpMethod.GET, "/api/v1/messstellen?stichtag=" + stichtag, null);
        List<String> out = new ArrayList<>();
        out.add("status=" + r.status());
        JsonNode liste = r.body().path("register");
        for (JsonNode m : liste) {
            out.add(m.path("kennzeichen").asText() + " quelle=" + m.at("/quelle/stand").asText() + " beobachtung="
                    + m.path("beobachtung") + " letzter_wert=" + m.path("letzter_wert"));
        }
        if (out.size() == 1) {
            out.add(r.text().length() > 600 ? r.text().substring(0, 600) : r.text());
        }
        return out;
    }

    private String metrik(Clock uhr) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new UemsMetricsCollector(new UemsMetricsRepository(admin), new UemsLaeuferMelder(registry),
                new MockEnvironment(), registry, uhr).collect();
        String s = registry.scrape();
        return "alter=" + zeile(s, UemsMetricsCollector.MESSWERT_ALTER + "{tenant=\"" + kb + "\"}")
                + " nie=" + zeile(s, UemsMetricsCollector.MESSWERT_ZUSTAND + "{tenant=\"" + kb + "\",zustand=\"nie\"}");
    }

    private BoxAusDerVorlage box;

    /**
     * Die Box-Seite der Registerlesung aus der Vorlage, eingespielt über den
     * echten {@link ProbeResultListener}. Die Anfrage muss Feld für Feld die der Vorlage sein.
     */
    private final class BoxAusDerVorlage {
        private final Map<String, JsonNode> einrichtung;
        private final Map<String, UUID> boxen;
        private final Map<String, String> ersetzt;
        private final ProbeResultListener antworten = new ProbeResultListener("tcp://127.0.0.1:9", "", "",
                probeRegistry);
        int lesungen;

        BoxAusDerVorlage(Map<String, JsonNode> einrichtung, Map<String, UUID> boxen, Map<String, String> ersetzt) {
            this.einrichtung = einrichtung;
            this.boxen = boxen;
            this.ersetzt = ersetzt;
        }

        Object lesen(UUID tenant, UUID site, UUID device, String requestId, List<ProbeRequest.Op> ops)
                throws Exception {
            String code = boxen.entrySet().stream().filter(e -> e.getValue().equals(device)).findFirst()
                    .orElseThrow().getKey();
            JsonNode gezeigt = einrichtung.get(code).at("/lesung/anfrage/ops/0");
            ProbeRequest.Op op = ops.get(0);
            befund("Box-Probe " + code, op.id() + " " + op.host() + ":" + op.port() + " reg " + op.address());
            ObjectNode antwort = (ObjectNode) ersetzen(einrichtung.get(code).at("/lesung/antwort"), ersetzt);
            ((ObjectNode) antwort.path("results").get(0)).put("id", op.id());
            antwort.put("request_id", requestId);
            antworten.handle(ersetzen(einrichtung.get(code).at("/lesung/antwort_topic"), ersetzt).asText(),
                    MAPPER.writeValueAsBytes(antwort));
            lesungen++;
            return null;
        }
    }

    /** Ein Kanal des Baukastens — dieselben Zahlen, die der Betreiber bei „Eigenen Messwert“ einträgt. */
    private static Map<String, Object> kanal(JsonNode einrichtung, JsonNode messstelle) {
        JsonNode d = definition(einrichtung, messstelle);
        Map<String, Object> k = new LinkedHashMap<>();
        k.put("label", messstelle.path("name").asText());
        k.put("unit", d.path("unit").asText());
        k.put("registerKind", "input");
        k.put("address", d.path("address").asInt());
        k.put("dataType", "u32");
        k.put("wordOrder", "big");
        k.put("scale", d.path("scale").asDouble());
        k.put("offset", 0.0);
        return k;
    }

    /** Die Definition, die die Vorlage dem Simulator für diese Messstelle zugestellt hat. */
    private static JsonNode definition(JsonNode einrichtung, JsonNode messstelle) {
        for (JsonNode s : einrichtung.at("/auswahl/nutzlast/selections")) {
            if (s.path("entity_id").asText().equals(messstelle.path("entity_id").asText())) {
                return s.path("definition");
            }
        }
        throw new AssertionError("keine Definition für " + messstelle);
    }

    /** Die Felder, nach denen {@code auswahl_lernen} annimmt — und die Komponente. */
    private static List<String> lernfelder(JsonNode dokument) {
        List<String> out = new ArrayList<>();
        for (JsonNode s : dokument.path("selections")) {
            JsonNode d = s.path("definition");
            out.add(String.join("|", s.path("point_key").asText(), s.path("cadence_s").asText(),
                    s.path("entity_id").asText(), d.path("sourceKind").asText(), d.path("address").asText(),
                    d.path("valueType").asText(), d.path("endian").asText(), d.path("scale").asText(),
                    d.path("requestCostMs").asText()));
        }
        out.sort(null);
        return out;
    }

    /** Setzt die vergebenen Kennungen und Schlüssel in ein Stück Vorlage ein — wörtlich, Zeichen für Zeichen. */
    private static JsonNode ersetzen(JsonNode knoten, Map<String, String> ersetzt) throws Exception {
        String text = MAPPER.writeValueAsString(knoten);
        for (Map.Entry<String, String> e : ersetzt.entrySet()) {
            text = text.replace(e.getKey(), e.getValue());
        }
        return MAPPER.readTree(text);
    }

    private static String messstelle(Map<String, String> schluessel, String pointKey) {
        return schluessel.entrySet().stream().filter(e -> e.getValue().equals(pointKey)).findFirst()
                .orElseThrow(() -> new AssertionError("nicht zugestellt: " + pointKey)).getKey();
    }

    /** Die Vorlage des Simulators — nur geglaubt, wenn ihre Bytes zur danebenliegenden Summe passen. */
    private static JsonNode vorlage() throws Exception {
        byte[] bytes = Files.readAllBytes(VORLAGE);
        String summe = Files.readString(Path.of(VORLAGE + ".sha256"), StandardCharsets.UTF_8).strip();
        assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                .as("Vorlage von Hand geändert? `make abnahme` in tools/edge-simulator").isEqualTo(summe);
        return MAPPER.readTree(bytes);
    }

    private long revision(UUID box) throws Exception {
        return ok(ruf(false, HttpMethod.GET, "/api/v1/devices/" + box + "/measurement-selection", null), 200)
                .body().path("desiredRevision").asLong();
    }

    private String flotte(Optional<UUID> dauerlaeufer) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new FleetMetricsCollector(new FleetMetricsRepository(admin), registry,
                Clock.fixed(NOW, ZoneOffset.UTC), dauerlaeufer).collect();
        return registry.scrape();
    }

    private long zahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static UUID id(Antwort a) {
        return UUID.fromString(a.body().path("id").asText());
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.text()).isEqualTo(status);
        return a;
    }

    /** {@code plattform}: die Plattformverwaltung (§14.1); sonst der Benutzer im Dauerläufer (§14.2). */
    private Antwort ruf(boolean plattform, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, URI.create(pfad))
                .with(plattform
                        ? jwt().jwt(j -> j.subject("kc-betreiber").claim("preferred_username", "Betreiber"))
                                .authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))
                        : jwt().jwt(j -> {
                            j.subject("kc-dauerlaeufer");
                            j.claim("preferred_username", "Dauerläufer-Benutzer");
                            j.claim("tenant_id", kb.toString());
                        }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(),
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text), text);
    }

    private static String zeile(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    private static double wert(String scrape, String prefix) {
        String z = zeile(scrape, prefix);
        assertThat(z).as(prefix).isNotNull();
        return Double.parseDouble(z.substring(z.lastIndexOf(' ') + 1));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource d = new PGSimpleDataSource();
        d.setUrl(POSTGRES.getJdbcUrl());
        d.setUser(user);
        d.setPassword(password);
        return d;
    }

    /** Eine Uhr, die der Test stellt — der Simulator steht, die Zeit läuft, niemand wartet. */
    private static final class MutableUhr extends Clock {
        private Instant jetzt;

        MutableUhr(Instant start) {
            this.jetzt = start;
        }

        void stellen(Instant neu) {
            jetzt = neu;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return jetzt;
        }
    }
}
