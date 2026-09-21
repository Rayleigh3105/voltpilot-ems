package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
 * NW-6 im Kleinen (AP-14 IP-18, Kasten E11): „Geht der ganze Weg Box → Alarm-Kennzahl?“ — mit der
 * Einrichtung aus Drehbuch §14.1/§14.2, vollständig über die Produktwege eines echten Messkunden.
 *
 * <p><b>Höhe dieses Laufs.</b> api, Writer und ingest sind getrennte Maven-Module; aus dem api-Modul ist
 * weder der Writer noch ingest startbar (dieselbe Naht wie NW-4, {@code UemsMesskundenLaufAbnahmeTest}).
 * Echt sind hier: jede Einrichtungs-Route (Kundenbereich über die Plattformverwaltung, Standort, zwei
 * Anlagen „nur messen“, Funktion „Messen“, zwei Boxen über {@code POST /api/v1/devices/claim} wie
 * {@code provision-device.sh}, je Halle die Registerlesung des Modbus-Baukastens und je Messstelle ein
 * Baukasten-Zähler, je Messstelle „Eigenen Messwert hinzufügen“, „Vorschlag übernehmen“ für Datenquelle
 * und Zuständigkeit), das Dokument, das die Plattform der Box zustellt ({@code MeasurementConfigPublisher},
 * ohne Broker), die Annahme der Quittung ({@code MeasurementConfigStatusListener.handle}) und der Probe-
 * Antwort ({@code ProbeResultListener.handle}), der Lücken-Melder, der UEMS-Sammler samt Scrape und der
 * Flotten-Sammler mit dem Schalter.
 *
 * <p><b>Die Box-Seite</b> ist der echte Dauerläufer: Lesung, Quittung und Umschläge stehen in
 * {@code tools/edge-simulator/abnahme/dauerlaeufer-nw6.json}, erzeugt von {@code probe_antwort},
 * {@code auswahl_lernen} und {@code umschlag} (gebunden über die sha256). Der Lauf prüft zuerst, dass die
 * Plattform der Box genau das zustellt, was die Vorlage dem Simulator gezeigt hat (Register, Typ, Skala,
 * Komponente), und setzt dann die vergebenen Kennungen und Schlüssel ein. NICHT durchlaufen: MQTT, ingest
 * und der Writer — die Zeilen entstehen an der Naht so, wie der echte Writer sie mit diesen Umschlägen und
 * einer quittierten Auswahl schreibt ({@code DauerlaeuferWriterNahtTest}); dass ingest die Umschläge
 * unverändert weiterreicht, belegt {@code DauerlaeuferVorlageAnnahmeTest}.
 *
 * <p><b>Warum der Simulator lernt</b> (PR 999, als Zusicherung stehen gelassen): die festen Schlüssel der
 * AP-07-Szenarien nimmt die Katalog-Route mit 400 ab, und „Eigenen Messwert hinzufügen“ vergibt den
 * Schlüssel selbst ({@code custom.<32 Hex>}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(classes = ApiApplication.class)
@AutoConfigureMockMvc
@Import(DauerlaeuferGanzerWegDbTest.Fakes.class)
class DauerlaeuferGanzerWegDbTest {

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

    @Test
    void nw6DieEinrichtungUeberDieProduktwegeLiefertJedenWertBisZurAlarmKennzahl() throws Exception {
        JsonNode vorlage = vorlage();
        Map<String, JsonNode> einrichtung = new LinkedHashMap<>();
        vorlage.path("einrichtung").forEach(e -> einrichtung.put(e.path("box").asText(), e));

        // ============================== §14.1 — Kundenbereich über die Plattformverwaltung
        Antwort angelegt = ok(ruf(true, HttpMethod.POST, "/api/v1/admin/tenants",
                Map.of("name", "VoltPilot Dauerläufer (intern)")), 201);
        kb = UUID.fromString(angelegt.body().path("id").asText());
        assertThat(kb.toString()).as("die Plattform vergibt die Kennung, klein und kanonisch")
                .isEqualTo(angelegt.body().path("id").asText().toLowerCase());

        // ============================== §14.2 Schritt 1 — Standort, zwei Anlagen „nur messen“, Messen
        Map<String, Object> adresse = new LinkedHashMap<>();
        adresse.put("strasse", "Werkstraße 1");
        adresse.put("plz", null);
        adresse.put("ort", "Ahrenberg");
        adresse.put("land", "DE");
        UUID standort = id(ok(ruf(false, HttpMethod.POST, "/api/v1/standorte", Map.of("name", "Werk Dauerläufer",
                "zeitzone", "Europe/Berlin", "adresse", adresse)), 201));
        Map<String, UUID> anlagen = new LinkedHashMap<>();
        anlagen.put("E-1", id(ok(ruf(false, HttpMethod.POST, "/api/v1/sites",
                Map.of("name", "AN-1 (Halle 1)", "standortId", standort.toString())), 201)));
        anlagen.put("E-2", id(ok(ruf(false, HttpMethod.POST, "/api/v1/sites",
                Map.of("name", "AN-2 (Halle 2)", "standortId", standort.toString())), 201)));
        Antwort messen = ruf(false, HttpMethod.PUT, "/api/v1/standorte/" + standort + "/funktionen/messen",
                Map.of("aktion", "einrichten"));
        assertThat(messen.status()).as(messen.text()).isIn(200, 201);

        // ============================== §14.2 Schritt 2 — zwei Boxen anmelden, wie provision-device.sh
        Map<String, UUID> boxen = new LinkedHashMap<>();
        for (String code : anlagen.keySet()) {
            boxen.put(code, id(ok(ruf(false, HttpMethod.POST, "/api/v1/devices/claim", Map.of(
                    "siteId", anlagen.get(code).toString(),
                    "externalRef", "dauerlaeufer-" + code.toLowerCase().replace("-", ""))), 201)));
        }
        // Vorlage-Kennung → die Kennung, die die Plattform eben vergeben hat.
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

        // ============================== §14.2 Schritt 3 — je Halle der Zähler im Modbus-Baukasten
        // Erst EINE Registerlesung (die Box antwortet, das ist der Verbindungsbeleg), dann je Messstelle ein Gerät.
        Map<String, UUID> komponente = new LinkedHashMap<>();
        Map<String, String> boxDer = new LinkedHashMap<>();
        for (JsonNode b : vorlage.path("boxen")) {
            String code = b.path("code").asText();
            JsonNode gw = b.path("gateway");
            Map<String, Object> verbindung = Map.of("host", gw.path("host").asText(),
                    "port", gw.path("port").asInt(), "unitId", gw.path("unit_id").asInt());
            JsonNode erste = b.path("messstellen").get(0);
            Antwort gelesen = ok(ruf(false, HttpMethod.POST, "/api/v1/sites/" + anlagen.get(code)
                    + "/components/custom/read", Map.of("deviceId", boxen.get(code).toString(),
                    "connection", verbindung, "channel", kanal(einrichtung.get(code), erste))), 200);
            assertThat(gelesen.body().path("ok").asBoolean()).as(gelesen.text()).isTrue();
            assertThat(gelesen.body().path("raw").asLong()).as("der Zählerstand, den der Simulator liest")
                    .isEqualTo(einrichtung.get(code).at("/lesung/antwort/results/0/raw").asLong());
            for (JsonNode m : b.path("messstellen")) {
                String ms = m.path("messstelle").asText();
                Antwort a = ruf(false, HttpMethod.POST, "/api/v1/sites/" + anlagen.get(code) + "/components/custom",
                        Map.of("label", ms, "connection", verbindung,
                                "channels", List.of(kanal(einrichtung.get(code), m))));
                assertThat(a.status()).as(ms + ": " + a.text()).isEqualTo(200);
                komponente.put(ms, root.queryForObject("SELECT id FROM measurement_point "
                        + "WHERE tenant_id = ? AND site_id = ? AND label = ?", UUID.class, kb, anlagen.get(code), ms));
                boxDer.put(ms, code);
                ersetzt.put(m.path("entity_id").asText(), komponente.get(ms).toString());
            }
        }
        assertThat(komponente).hasSize(9);
        assertThat(box.lesungen).as("eine Lesung je Halle").isEqualTo(2);

        // --- BEFUND 1 (PR 999): die festen Schlüssel der AP-07-Szenarien nimmt die Katalog-Route nicht an.
        for (JsonNode b : vorlage.path("boxen")) {
            UUID an = boxen.get(b.path("code").asText());
            for (JsonNode m : b.path("messstellen")) {
                Antwort a = ruf(false, HttpMethod.PUT, "/api/v1/devices/" + an + "/measurement-selection/"
                        + m.path("szenario_schluessel").asText() + "?entityId="
                        + komponente.get(m.path("messstelle").asText()), Map.of("expectedRevision", revision(an),
                        "idempotencyKey", UUID.randomUUID().toString(), "enabled", true));
                assertThat(a.status()).as(m + ": " + a.text()).isEqualTo(400);
                assertThat(a.text()).contains("Dieser Katalog-Messpunkt ist nicht lesbar oder unbekannt.");
            }
        }

        // ============================== §14.2 Schritt 4 — je Messstelle „Eigenen Messwert hinzufügen“
        // --- BEFUND 2 (PR 999): die Plattform vergibt den Schlüssel selbst — darum lernt ihn der Simulator.
        Map<String, String> schluessel = new LinkedHashMap<>();
        for (JsonNode b : vorlage.path("boxen")) {
            String code = b.path("code").asText();
            UUID an = boxen.get(code);
            for (JsonNode m : b.path("messstellen")) {
                String ms = m.path("messstelle").asText();
                ObjectNode definition = definition(einrichtung.get(code), m).deepCopy();
                definition.remove("requestCostMs"); // ergänzt die Plattform
                Antwort eigen = ok(ruf(false, HttpMethod.POST, "/api/v1/devices/" + an
                        + "/measurement-selection/custom?entityId=" + komponente.get(ms), Map.of(
                        "expectedRevision", revision(an), "idempotencyKey", UUID.randomUUID().toString(),
                        "definition", MAPPER.convertValue(definition, Map.class))), 200);
                List<String> neu = new ArrayList<>();
                eigen.body().path("selections").forEach(s -> neu.add(s.path("pointKey").asText()));
                neu.removeAll(schluessel.values());
                assertThat(neu).hasSize(1).allMatch(k -> k.matches("custom\\.[0-9a-f]{32}"))
                        .doesNotContain(m.path("szenario_schluessel").asText(), m.path("point_key").asText());
                schluessel.put(ms, neu.get(0));
                ersetzt.put(m.path("point_key").asText(), neu.get(0));
            }
        }
        assertThat(schluessel).hasSize(9);

        // ============================== §14.2 Schritt 5 — die Zustellung an die Box und ihre Quittung
        MeasurementConfigStatusListener quittungen =
                new MeasurementConfigStatusListener("tcp://127.0.0.1:9", "", "", auswahlRepository, MAPPER);
        for (String code : boxen.keySet()) {
            JsonNode e = einrichtung.get(code);
            JsonNode zugestellt = MAPPER.readTree(ZustellungOhneBroker.dokument(auswahlRepository, auswahlService,
                    kadenzen, MAPPER, kb, boxen.get(code)));
            JsonNode gezeigt = ersetzen(e.at("/auswahl/nutzlast"), ersetzt);
            assertThat(zugestellt.path("revision").asLong()).as("eine Revision je eigenem Messwert")
                    .isEqualTo(gezeigt.path("revision").asLong());
            for (String feld : List.of("tenant_id", "site_id", "device_id")) {
                assertThat(zugestellt.path(feld).asText()).isEqualTo(gezeigt.path(feld).asText());
            }
            assertThat(lernfelder(zugestellt)).as("die Plattform stellt zu, was der Simulator gelernt hat")
                    .isEqualTo(lernfelder(gezeigt));
            JsonNode quittung = ersetzen(e.at("/quittung/nutzlast"), ersetzt);
            assertThat(quittung.path("accepted")).hasSize(zugestellt.path("selections").size());
            assertThat(quittungen.handle(ersetzen(e.at("/quittung/topic"), ersetzt).asText(),
                    MAPPER.writeValueAsBytes(quittung))).as("die Quittung des Simulators, angenommen").isTrue();
        }
        Instant quittiert = Instant.parse(einrichtung.get("E-1").at("/quittung/nutzlast/applied_at").asText());
        assertThat(root.queryForList("SELECT apply_status FROM device_measurement_selection WHERE tenant_id = ?",
                String.class, kb)).hasSize(9).containsOnly("applied");
        assertThat(zahl("SELECT count(*) FROM device_measurement_selection WHERE tenant_id = ? AND applied_at = ?",
                kb, Timestamp.from(quittiert))).as("applied_at kommt aus der Quittung, nicht aus dem ersten Wert")
                .isEqualTo(9);

        // ============================== §14.2 Schritt 6 — Datenquelle und Zuständigkeit: „Vorschlag übernehmen“
        for (String code : anlagen.keySet()) {
            String basis = "/api/v1/sites/" + anlagen.get(code) + "/data-sources/vorschlag";
            Antwort liste = ok(ruf(false, HttpMethod.GET, basis, null), 200);
            JsonNode vorschlaege = liste.body().path("vorschlaege");
            assertThat(vorschlaege).as("ein Gateway je Halle, eine Quelle: " + liste.text()).hasSize(1);
            assertThat(vorschlaege.at("/0/box/id").asText()).isEqualTo(boxen.get(code).toString());
            Antwort uebernommen = ruf(false, HttpMethod.POST, basis + "/uebernehmen", alle(vorschlaege));
            assertThat(uebernommen.status()).as(uebernommen.text()).isIn(200, 201);
        }
        assertThat(zahl("SELECT count(*) FROM measurement_point WHERE tenant_id = ? AND data_source_id IS NOT NULL",
                kb)).as("jede Komponente trägt ihre Datenquelle (HerkunftNachschlag)").isEqualTo(9);
        assertThat(root.queryForList("SELECT a.device_id FROM data_source_assignment a JOIN data_source q "
                + "ON q.id = a.data_source_id WHERE q.tenant_id = ? ORDER BY a.device_id", UUID.class, kb))
                .as("je Box die Zuständigkeit — sonst wäre sie Spiegel").containsExactlyInAnyOrderElementsOf(
                        boxen.values());

        // --- Eingerichtet, aber noch kein Wert: kein Alter, aber zustand="nie" — daran hängt gitops PR 37.
        MutableUhr uhr = new MutableUhr(NOW.minus(Duration.ofMinutes(10)));
        melder.lauf(uhr.instant());
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        UemsMetricsCollector sammler = new UemsMetricsCollector(new UemsMetricsRepository(admin),
                new UemsLaeuferMelder(registry), new MockEnvironment(), registry, uhr);
        sammler.collect();
        String alter = UemsMetricsCollector.MESSWERT_ALTER + "{tenant=\"" + kb + "\"}";
        String nie = UemsMetricsCollector.MESSWERT_ZUSTAND + "{tenant=\"" + kb + "\",zustand=\"nie\"}";
        assertThat(zeile(registry.scrape(), alter)).as("vor dem ersten Wert: kein Alter").isNull();
        assertThat(wert(registry.scrape(), nie)).as("…aber die nie-Reihe steht auf 1").isEqualTo(1.0);

        // ============================== Naht zum Writer: die Zeilen, die er mit quittierter Auswahl schreibt
        // Genau die Zeilen, die DauerlaeuferWriterNahtTest am echten Writer sieht: JEDER Wert, auch der erste
        // je Schlüssel, mit Komponente, Fassung und Rolle „beobachtung“. Werte Zahl für Zahl aus den
        // Umschlägen des Dauerläufers; Kennungen und Schlüssel die, die die Plattform eben vergeben hat.
        List<Object[]> zeilen = new ArrayList<>();
        for (JsonNode z : vorlage.path("zustellungen")) {
            JsonNode n = ersetzen(z.path("nutzlast"), ersetzt);
            String code = z.path("box").asText();
            assertThat(ersetzen(z.path("topic"), ersetzt).asText()).isEqualTo("ems/" + kb + "/" + anlagen.get(code)
                    + "/" + boxen.get(code) + "/v2/measurement-samples");
            for (JsonNode s : n.path("samples")) {
                String ms = messstelle(schluessel, s.path("point_key").asText());
                // Die Fassung, die der Writer findet: die Revision der quittierten Auswahlzeile (HerkunftNachschlag).
                long fassung = zahl("SELECT desired_revision FROM device_measurement_selection WHERE device_id = ? "
                        + "AND point_key = ? AND applied_at IS NOT NULL", boxen.get(code), s.path("point_key").asText());
                Instant messzeit = Instant.parse(s.path("observed_at").asText());
                zeilen.add(new Object[] {Timestamp.from(messzeit), Timestamp.from(messzeit.plus(EINGANG)), kb,
                        anlagen.get(code), boxen.get(code), s.path("point_key").asText(), s.path("raw").decimalValue(),
                        s.path("decoded").decimalValue(), s.path("quality").asText(), n.path("catalog_version").asText(),
                        n.path("sequence").asLong(), komponente.get(ms), fassung});
            }
        }
        assertThat(zeilen).hasSize(5 * 9);
        root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, entity_id, "
                + "applied_revision, aggregation_kind, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, "
                + "?, ?, ?, ?, ?, ?::uuid, ?, 'counter', 'counter', 'beobachtung', 'direkt', 2)", zeilen);

        // ============================== NW-6 (1): der Melder schreibt seinen Stand, das Alter ist klein
        uhr.stellen(NOW.plus(Duration.ofSeconds(90)));
        melder.lauf(uhr.instant());
        Instant juengster = Instant.parse("2026-11-03T09:59:00Z").plus(EINGANG);
        assertThat(root.queryForList("SELECT zuletzt FROM messreihe_luecke_stand WHERE tenant_id = ? AND art = 'box' "
                + "ORDER BY device_id", Timestamp.class, kb)).extracting(Timestamp::toInstant)
                .as("je Box ein Stand").containsExactly(juengster, juengster);
        sammler.collect();
        assertThat(wert(registry.scrape(), alter)).as("Dauerbetrieb: frisch")
                .isEqualTo(Duration.between(juengster, uhr.instant()).toSeconds()).isLessThan(STUMM_S);
        assertThat(wert(registry.scrape(), nie)).as("nie ist vorbei").isZero();
        assertThat(registry.scrape()).as("PR 37 vergleicht das Etikett wörtlich: kanonisch, klein")
                .contains("tenant=\"" + kb.toString().toLowerCase() + "\"");

        // ============================== NW-6 (2): Zufuhr angehalten, die Uhr 16 Minuten weiter — nicht gewartet
        uhr.stellen(uhr.instant().plus(Duration.ofMinutes(16)));
        melder.lauf(uhr.instant());
        sammler.collect();
        assertThat(wert(registry.scrape(), alter)).as("über der Grenze von VoltPilotDauerlaeuferStumm")
                .isEqualTo(Duration.between(juengster, uhr.instant()).toSeconds()).isGreaterThan(STUMM_S);

        // ============================== NW-6 (3): mit Schalter fehlt er in jeder Flottenkennzahl
        String ohne = flotte(Optional.empty());
        String mit = flotte(Dauerlaeufer.kennung(kb.toString().toUpperCase()));
        for (UUID anlage : anlagen.values()) {
            assertThat(ohne).as("ohne Schalter zählt er mit — der Ausschluss ist nicht leer")
                    .contains("site=\"" + anlage + "\"");
        }
        assertThat(wert(mit, FleetMetricsCollector.SITES + " "))
                .as("der Nenner verliert genau die zwei echten Anlagen des Dauerläufers")
                .isEqualTo(wert(ohne, FleetMetricsCollector.SITES + " ") - 2);
        assertThat(mit.lines().filter(l -> l.startsWith("voltpilot_site")))
                .isNotEmpty()
                .noneMatch(l -> l.contains(kb.toString()))
                .noneMatch(l -> anlagen.values().stream().anyMatch(a -> l.contains(a.toString())));
        assertThat(wert(registry.scrape(), alter)).as("das Messkunden-Alter bleibt sichtbar").isGreaterThan(STUMM_S);
    }

    // ---------------------------------------------------------------------------------------------

    private BoxAusDerVorlage box;

    /**
     * Die Box-Seite der Registerlesung: was der Dauerläufer auf genau diese Anfrage antwortet
     * ({@code einrichtung[].lesung} der Vorlage), mit den vergebenen Kennungen, eingespielt über den
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
            assertThat(ops).hasSize(1);
            ProbeRequest.Op op = ops.get(0);
            assertThat(List.of(op.id(), op.host(), op.port(), op.unitId(), op.registerKind(), op.address(),
                    op.dataType(), op.wordOrder(), op.scale(), op.offset())).as("die Anfrage der Vorlage")
                    .isEqualTo(List.of(gezeigt.path("id").asText(), gezeigt.path("host").asText(),
                            gezeigt.path("port").asInt(), gezeigt.path("unit_id").asInt(),
                            gezeigt.path("register_kind").asText(), gezeigt.path("address").asInt(),
                            gezeigt.path("data_type").asText(), gezeigt.path("word_order").asText(),
                            gezeigt.path("scale").asDouble(), gezeigt.path("offset").asDouble()));
            ObjectNode antwort = (ObjectNode) ersetzen(einrichtung.get(code).at("/lesung/antwort"), ersetzt);
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

    /** Wie das Portal: jeden Vorschlag so bestätigen, wie die Liste ihn zeigt. */
    private static Map<String, Object> alle(JsonNode vorschlaege) {
        List<Map<String, Object>> v = new ArrayList<>();
        for (JsonNode x : vorschlaege) {
            List<String> komponenten = new ArrayList<>();
            x.path("komponenten").forEach(k -> komponenten.add((k.isObject() ? k.get("id") : k).asText()));
            Map<String, Object> b = new LinkedHashMap<>();
            b.put("device_id", x.at("/box/id").asText());
            b.put("protokoll", x.path("protokoll").asText());
            b.put("adresse", x.path("adresse").asText());
            b.put("komponenten", komponenten);
            v.add(b);
        }
        return Map.of("vorschlaege", v);
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
