package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargingBoostPublisher;
import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.consumers.ConsumerOverridePublisher;
import com.voltpilot.api.control.ControlCertificationPublisher;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.ota.OtaTargetPublisher;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.registerwrite.RegisterWritePublisher;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Ein Gebäude oder einen Bereich verschieben (UEMS AP-02 IP-12, V1–V4) Ende zu Ende gegen echtes
 * Keycloak + TimescaleDB. Die Welt ist Halle 2 des Referenzunternehmens Ahrenberg (Fassung 1.1):
 * Werk Ahrenberg mit Anlage „Werk Ahrenberg – Halle 2“ (Box, Netzanschluss NA-2), Halle 2 (G-2)
 * mit ihren drei Bereichen und den Messstellen MS-10 … MS-15 an den Orten der Referenz — MS-14
 * direkt am Standort —, dazu Werk Ahrenberg Nord.
 *
 * <ul>
 *   <li><b>A13 scharf:</b> je eine Zusicherung für JEDES Ding, das mitzieht (drei Bereiche, fünf
 *       abgeleitete Messstellen) und für JEDES, das bleibt (Anlage, Netzanschluss, MS-14) — gezählt,
 *       und jede an dem Weg, auf dem es der Kunde später liest (Ortsbaum, Standort der Messstelle am
 *       Tag, Standort-Lesemodell, Netzanschlüsse). Dazu: jeder MQTT-Sender ist ein Mock und hat nach
 *       dem Eintrag 0 Aufrufe, und außer {@code ort_zuordnung}/{@code ort_aenderung} ändert sich keine
 *       Zeile irgendeiner Tabelle.</li>
 *   <li><b>Vorschau = Wirkung:</b> die Vorschau schreibt nichts (ganze Datenbank gleich) und kündigt
 *       genau die Zuordnungen, Folgen und Fakten an, die der Eintrag danach meldet und die „Stand am“
 *       an jedem ersten Tag zeigt.</li>
 *   <li><b>Zeitpunkt:</b> Zukunft = geplant (bis zum Vortag alles beim Alten, mit Abzeichen),
 *       Vergangenheit = rückwirkend gekennzeichnet (Antwort UND Protokoll), vor dem Beginn = 422 mit
 *       dem Satz des Vertrags.</li>
 *   <li><b>Ablehnungen:</b> die Gründe des Vertrags mit Status, Feld und Satz — Vorschau und Eintrag
 *       gleich, fremder Ort 404 (A14) — und keine schreibt etwas.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
// Diese Bestandsvorrichtung legt Orte mit dem alten Plattform-Testkonto an.
// Der Produktionsstandard bleibt geschlossen; UnterstuetzungApiTest prüft ihn ohne Ausnahme.
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "voltpilot.uems.unterstuetzung.umschalter-enabled=true")
class OrtVerschiebenApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    /** Die Tabellen, die ein Verschieben schreiben darf — und keine sonst. */
    private static final List<String> GESCHRIEBEN = List.of("ort_zuordnung", "ort_aenderung");
    private static final List<String> HALLE_2_MESSSTELLEN = List.of("MS-10", "MS-11", "MS-12", "MS-13", "MS-14", "MS-15");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer(
            "quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

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

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    // ---- Jeder MQTT-Sender der Anwendung, gezählt ------------------------------------------

    @MockBean EntityRegistryPublisher entityRegistryPublisher;
    @MockBean ProbePublisher probePublisher;
    @MockBean ChargingConfigPublisher chargingConfigPublisher;
    @MockBean ChargingBoostPublisher chargingBoostPublisher;
    @MockBean RegisterWritePublisher registerWritePublisher;
    @MockBean FlowDeploymentPublisher flowDeploymentPublisher;
    @MockBean ControlCertificationPublisher controlCertificationPublisher;
    @MockBean OtaTargetPublisher otaTargetPublisher;
    @MockBean ProvisioningPublisher provisioningPublisher;
    @MockBean MeasurementConfigPublisher measurementConfigPublisher;
    @MockBean ConsumerOverridePublisher consumerOverridePublisher;
    @MockBean VerbundAnteilePublisher verbundAnteilePublisher;
    @MockBean SprungprobePublisher sprungprobePublisher;

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    ApplicationContext context;

    @Autowired
    OrtVerschiebenService verschiebenService;

    private static JdbcTemplate root;
    private static JsonNode referenz;
    private static final Map<String, String> TOKENS = new ConcurrentHashMap<>();

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);

    @BeforeAll
    static void verbinden() throws IOException {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        referenz = MAPPER.readTree(REFERENZ.toFile());
    }

    @AfterEach
    void aufraeumen() {
        verschiebenService.uhrStellen(Clock.systemUTC());
    }

    // ---- A13: nichts Elektrisches und nichts direkt am Standort Hängendes zieht mit ------------

    @Test
    void a13VerschiebenZiehtNichtsElektrischesUndNichtsDirektAmStandortHaengendesMit() {
        Welt w = ahrenberg(true);
        uhr("2027-02-20T10:00:00+01:00");

        Map<String, String> ganzVorher = Bestandsschutz.fingerabdruck(root, List.of());
        JsonNode v = ok(rufe(HttpMethod.GET, vorschau(w.ort("G-2"), w.nord(), "2027-03-01"), w.wer(), null));
        assertThat(Bestandsschutz.abweichungen(ganzVorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("die Vorschau schreibt nichts").isEmpty();
        JsonNode f = v.get("folgen");
        assertThat(werte(f.get("ziehenMit"), "kurzzeichen")).containsExactly("B-3", "B-4", "B-5");
        assertThat(werte(f.get("messstellenWechselnStandort"), "kennzeichen"))
                .containsExactly("MS-10", "MS-11", "MS-12", "MS-13", "MS-15");
        assertThat(werte(f.get("bleibenAnlagen"), "id")).containsExactly(w.anlage());
        assertThat(f.at("/bleibenAnlagen/0/standort/id").asText()).isEqualTo(w.werk());
        assertThat(werte(f.get("bleibenNetzanschluesse"), "kennzeichen")).containsExactly("NA-2");
        assertThat(f.at("/bleibenNetzanschluesse/0/id").asText()).isEqualTo(w.na2());
        assertThat(werte(f.get("bleibenMessstellen"), "kennzeichen")).containsExactly("MS-14");
        assertThat(f.at("/bleibenMessstellen/0/ort/art").asText()).as("MS-14 hängt direkt am Standort").isEqualTo("standort");
        assertThat(f.at("/bleibenMessstellen/0/ort/id").asText()).isEqualTo(w.werk());
        assertThat(v.get("befehle").asInt()).isZero();

        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, GESCHRIEBEN);
        Mockito.clearInvocations(sender().values().toArray());
        ok(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", w.wer(),
                Map.of("zielId", w.nord(), "gueltigAb", "2027-03-01")));

        // Gezählt, nicht vermutet: kein Sender hat irgendetwas bekommen …
        Map<String, Integer> aufrufe = new LinkedHashMap<>();
        sender().forEach((name, mock) -> aufrufe.put(name, Mockito.mockingDetails(mock).getInvocations().size()));
        assertThat(aufrufe).as("Aufrufe je MQTT-Sender nach dem Verschieben").hasSize(13)
                .allSatisfy((name, n) -> assertThat(n).as(name).isZero());
        // … und außer der Zuordnung und dem Protokoll ändert sich keine Zeile: Anlage, Anlagen-Zuordnung, Box,
        // Netzanschluss und seine Bindung, Messstellen mit Ort und Stellung, Bereiche mit ihren Zuordnungen.
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, GESCHRIEBEN)))
                .as("außer ort_zuordnung und ort_aenderung ändert das Verschieben keine Tabelle").isEmpty();
        assertThat(root.queryForList("SELECT DISTINCT ort_id::text FROM ort_zuordnung WHERE tenant_id = ? "
                + "AND created_at > now() - interval '1 minute' AND gueltig_ab = '2027-03-01'", String.class, w.tenant()))
                .as("die einzige neue Zuordnung ist die des Gebäudes").containsExactly(w.ort("G-2"));

        JsonNode werkFeb = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/orte?stichtag=2027-02-28", w.wer(), null));
        JsonNode werkMrz = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/orte?stichtag=2027-03-01", w.wer(), null));
        JsonNode nordMrz = ok(rufe(HttpMethod.GET, "/standorte/" + w.nord() + "/orte?stichtag=2027-03-01", w.wer(), null));
        assertThat(werte(werkMrz.get("gebaeude"), "kurzzeichen")).containsExactly("G-1");

        // Mitziehen — je Ding eine Zusicherung am Weg, auf dem man es liest.
        int mitgezogen = 0;
        for (String b : List.of("B-3", "B-4", "B-5")) {
            assertThat(werte(gebaeude(werkFeb, "G-2").get("bereiche"), "kurzzeichen")).as(b + " bis 28.02.").contains(b);
            assertThat(werte(gebaeude(nordMrz, "G-2").get("bereiche"), "kurzzeichen")).as(b + " ab 01.03.").contains(b);
            mitgezogen++;
        }
        for (String ms : List.of("MS-10", "MS-11", "MS-12", "MS-13", "MS-15")) {
            JsonNode feb = standortDerMessstelle(w, ms, "2027-02-28");
            JsonNode mrz = standortDerMessstelle(w, ms, "2027-03-01");
            assertThat(feb.get("standort_id").asText()).as(ms + " bis 28.02.").isEqualTo(w.werk());
            assertThat(mrz.get("standort_id").asText()).as(ms + " ab 01.03. (abgeleitet)").isEqualTo(w.nord());
            assertThat(mrz.get("ort").asText()).as(ms + " bleibt an ihrem Ort").isEqualTo(feb.get("ort").asText());
            mitgezogen++;
        }
        assertThat(mitgezogen).as("drei Bereiche und fünf abgeleitete Messstellen").isEqualTo(8);

        // Bleiben — je Ding eine Zusicherung.
        int geblieben = 0;
        JsonNode standorteMrz = ok(rufe(HttpMethod.GET, "/standorte?stichtag=2027-03-01", w.wer(), null));
        assertThat(anlagen(standorteMrz, w.werk())).as("die Anlage bleibt bei Werk Ahrenberg").containsExactly(w.anlage());
        assertThat(anlagen(standorteMrz, w.nord())).isEmpty();
        geblieben++;
        JsonNode netzWerk = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/netzanschluesse", w.wer(), null));
        JsonNode netzNord = ok(rufe(HttpMethod.GET, "/standorte/" + w.nord() + "/netzanschluesse", w.wer(), null));
        assertThat(werte(netzWerk.get("netzanschluesse"), "kennzeichen")).as("NA-2 bleibt am Standort").containsExactly("NA-2");
        assertThat(netzWerk.at("/netzanschluesse/0/anlagen/0/anlage/id").asText()).isEqualTo(w.anlage());
        assertThat(netzNord.get("netzanschluesse")).isEmpty();
        geblieben++;
        JsonNode ms14 = standortDerMessstelle(w, "MS-14", "2027-03-01");
        assertThat(ms14.get("standort_id").asText()).as("MS-14 hängt direkt am Standort und bleibt").isEqualTo(w.werk());
        assertThat(ms14.get("ort_art").asText()).isEqualTo("standort");
        geblieben++;
        assertThat(geblieben).as("Anlage, Netzanschluss, direkt hängende Messstelle").isEqualTo(3);
    }

    // ---- Vorschau = Wirkung ------------------------------------------------------------------

    @Test
    void wasDieVorschauAnkuendigtTrittEinUndSieSchreibtNichts() {
        Welt w = ahrenberg(true);
        uhr("2027-02-20T10:00:00+01:00");
        // Schon geplant: ab 01.06.2027 gehört Halle 2 zu Werk Ahrenberg Nord.
        ok(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", w.wer(),
                Map.of("zielId", w.nord(), "gueltigAb", "2027-06-01")));
        // V4: heute steht Halle 2 weiter bei Werk Ahrenberg — mit dem Abzeichen „ab 01.06.2027 → Werk Ahrenberg Nord“.
        JsonNode heute = gebaeude(ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/orte", w.wer(), null)), "G-2");
        assertThat(heute.get("gueltigBis").asText()).isEqualTo("2027-05-31");
        assertThat(heute.at("/danach/ab").asText()).isEqualTo("2027-06-01");
        assertThat(heute.at("/danach/elternId").asText()).isEqualTo(w.nord());
        assertThat(heute.at("/danach/elternName").asText()).isEqualTo("Werk Ahrenberg Nord");
        String lindach = neuerStandort(w.wer(), "Werk Lindach");

        String pfad = vorschau(w.ort("G-2"), lindach, "2027-03-01");
        Map<String, String> ganzVorher = Bestandsschutz.fingerabdruck(root, List.of());
        JsonNode v = ok(rufe(HttpMethod.GET, pfad, w.wer(), null));
        assertThat(ok(rufe(HttpMethod.GET, pfad, w.wer(), null))).as("zweimal gleich").isEqualTo(v);
        assertThat(Bestandsschutz.abweichungen(ganzVorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("die Vorschau schreibt nichts").isEmpty();
        assertThat(v.at("/bisher/id").asText()).isEqualTo(w.werk());
        assertThat(v.at("/neu/id").asText()).isEqualTo(lindach);
        assertThat(v.get("gueltigBis").asText()).as("erbt das Ende der laufenden").isEqualTo("2027-05-31");
        assertThat(v.at("/danach/id").asText()).isEqualTo(w.nord());
        assertThat(v.at("/rueckwirkung/art").asText()).isEqualTo("geplant");
        assertThat(v.get("protokoll")).isEmpty();

        long vor = maxEintrag(w.tenant());
        JsonNode e = ok(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", w.wer(),
                Map.of("zielId", lindach, "gueltigAb", "2027-03-01", "begruendung", "Übernahme Gewerbering 9")));
        for (String feld : List.of("ortId", "art", "kurzzeichen", "name", "bisher", "bisherStandort", "neu",
                "neuStandort", "gueltigAb", "gueltigBis", "danach", "rueckwirkung", "rueckwirkendBetroffen",
                "zuordnungen", "folgen", "befehle")) {
            assertThat(e.get(feld)).as(feld).isEqualTo(v.get(feld));
        }
        // Genau EIN Protokolleintrag, am Gebäude — und die Antwort nennt Zeit, was, gilt ab und wer (V4).
        List<Map<String, Object>> neu = root.queryForList("SELECT objekt_art, objekt_id::text AS objekt_id, art, "
                + "gilt_ab::text AS gilt_ab, rueckwirkend FROM ort_aenderung WHERE tenant_id = ? AND id > ?", w.tenant(), vor);
        assertThat(neu).hasSize(1);
        assertThat(neu.get(0)).containsEntry("objekt_art", "gebaeude").containsEntry("objekt_id", w.ort("G-2"))
                .containsEntry("art", "verschoben").containsEntry("gilt_ab", "2027-03-01").containsEntry("rueckwirkend", false);
        JsonNode p = e.at("/protokoll/0");
        assertThat(e.get("protokoll")).hasSize(1);
        assertThat(p.get("text").asText()).isEqualTo("Gebäude verschoben: Werk Ahrenberg → Werk Lindach ("
                + kurzzeichen(lindach) + ")");
        assertThat(p.get("giltAb").asText()).isEqualTo("2027-03-01");
        assertThat(p.get("wer").asText()).isNotBlank();
        assertThat(p.get("eingetragenAm").asText()).isNotBlank();
        assertThat(e.get("begruendung").asText()).isEqualTo("Übernahme Gewerbering 9");

        // Die angekündigten Zuordnungen sind die gespeicherten — und „Stand am“ zeigt jede an ihrem ersten Tag.
        List<List<String>> angekuendigt = new ArrayList<>();
        for (JsonNode z : v.get("zuordnungen")) {
            String bis = z.get("gueltigBis").isNull() ? "offen" : z.get("gueltigBis").asText();
            angekuendigt.add(List.of(z.at("/eltern/id").asText(), z.get("gueltigAb").asText(), bis));
            JsonNode amTag = ok(rufe(HttpMethod.GET, "/standorte/" + z.at("/eltern/id").asText() + "/orte?stichtag="
                    + z.get("gueltigAb").asText(), w.wer(), null));
            assertThat(werte(amTag.get("gebaeude"), "kurzzeichen")).as(z.toString()).contains("G-2");
        }
        assertThat(zuordnungen(w.ort("G-2"))).containsExactlyElementsOf(angekuendigt);
        assertThat(angekuendigt).containsExactly(
                List.of(w.werk(), w.heute().toString(), "2027-02-28"),
                List.of(lindach, "2027-03-01", "2027-05-31"),
                List.of(w.nord(), "2027-06-01", "offen"));
        // Die angekündigten Folgen treten ein: MS-10 zählt am 01.03. bei Werk Lindach, MS-14 weiter bei Werk Ahrenberg.
        assertThat(werte(v.at("/folgen/messstellenWechselnStandort"), "kennzeichen")).contains("MS-10");
        assertThat(standortDerMessstelle(w, "MS-10", "2027-03-01").get("standort_id").asText()).isEqualTo(lindach);
        assertThat(werte(v.at("/folgen/bleibenMessstellen"), "kennzeichen")).containsExactly("MS-14");
        assertThat(standortDerMessstelle(w, "MS-14", "2027-03-01").get("standort_id").asText()).isEqualTo(w.werk());
    }

    @Test
    void einBereichInnerhalbDesStandortsHatKeineFolgenUndHaengtDanachAmNeuenGebaeude() {
        Welt w = ahrenberg(true);
        uhr("2027-02-20T10:00:00+01:00");
        JsonNode v = ok(rufe(HttpMethod.GET, vorschau(w.ort("B-5"), w.ort("G-1"), "2027-03-01"), w.wer(), null));
        for (String liste : List.of("ziehenMit", "messstellenWechselnStandort", "bleibenAnlagen",
                "bleibenNetzanschluesse", "bleibenMessstellen")) {
            assertThat(v.get("folgen").get(liste)).as(liste).isEmpty();
        }
        assertThat(v.at("/neuStandort/id").asText()).isEqualTo(w.werk());
        JsonNode e = ok(rufe(HttpMethod.POST, "/orte/" + w.ort("B-5") + "/verschieben", w.wer(),
                Map.of("zielId", w.ort("G-1"), "gueltigAb", "2027-03-01")));
        assertThat(e.at("/protokoll/0/text").asText()).isEqualTo("Bereich verschoben: Halle 2 → Halle 1 (G-1)");
        JsonNode mrz = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/orte?stichtag=2027-03-01", w.wer(), null));
        assertThat(werte(gebaeude(mrz, "G-1").get("bereiche"), "kurzzeichen")).containsExactly("B-5");
        assertThat(werte(gebaeude(mrz, "G-2").get("bereiche"), "kurzzeichen")).containsExactly("B-3", "B-4");
        assertThat(standortDerMessstelle(w, "MS-13", "2027-03-01").get("standort_id").asText()).isEqualTo(w.werk());
        // Die Zielliste des Bereichs (V2): Gebäude und Standorte, nie ein Bereich, nie der bisherige Elternknoten.
        JsonNode heute = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/orte", w.wer(), null));
        JsonNode ziele = bereich(gebaeude(heute, "G-2"), "B-3").at("/aktionen/verschieben/ziele");
        assertThat(werte(ziele, "id")).contains(w.werk(), w.nord(), w.ort("G-1")).doesNotContain(w.ort("G-2"));
        assertThat(werte(ziele, "art")).containsOnly("standort", "gebaeude");
        JsonNode halle2 = gebaeude(heute, "G-2").at("/aktionen/verschieben");
        assertThat(halle2.get("erlaubt").asBoolean()).isTrue();
        assertThat(werte(halle2.get("ziele"), "id")).as("der bisherige Standort steht nicht zur Wahl").containsExactly(w.nord());
    }

    // ---- Zeitpunkt ---------------------------------------------------------------------------

    @Test
    void zukunftGeplantVergangenheitRueckwirkendGekennzeichnetVorDemBeginnAbgelehntMitGrund() {
        // Zukunft: bis zum Vortag bleibt alles, wie es ist.
        Welt w = ahrenberg(false);
        LocalDate heute = w.heute();
        LocalDate ab = heute.plusDays(10);
        JsonNode geplant = ok(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", w.wer(),
                Map.of("zielId", w.nord(), "gueltigAb", ab.toString())));
        assertThat(geplant.at("/rueckwirkung/art").asText()).isEqualTo("geplant");
        assertThat(geplant.at("/rueckwirkung/tage").asLong()).isEqualTo(10);
        assertThat(geplant.get("rueckwirkendBetroffen").isNull()).isTrue();
        assertThat(geplant.at("/protokoll/0/rueckwirkend").asBoolean()).isFalse();
        JsonNode werkHeute = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/orte", w.wer(), null));
        assertThat(gebaeude(werkHeute, "G-2").at("/danach/ab").asText()).isEqualTo(ab.toString());
        assertThat(werte(ok(rufe(HttpMethod.GET, "/standorte/" + w.nord() + "/orte?stichtag=" + ab.minusDays(1),
                w.wer(), null)).get("gebaeude"), "kurzzeichen")).isEmpty();
        assertThat(werte(ok(rufe(HttpMethod.GET, "/standorte/" + w.nord() + "/orte?stichtag=" + ab, w.wer(), null))
                .get("gebaeude"), "kurzzeichen")).containsExactly("G-2");

        // Vergangenheit: Halle 2 hängt seit 40 Tagen am Werk, das Nordwerk gibt es seit 60.
        Welt z = ahrenberg(false);
        root.update("UPDATE ort_zuordnung SET gueltig_ab = ? WHERE ort_id = ?::uuid", heute.minusDays(40), z.ort("G-2"));
        root.update("UPDATE standort SET created_at = created_at - interval '60 days' WHERE id = ?::uuid", z.nord());
        long vor = maxEintrag(z.tenant());
        JsonNode rw = ok(rufe(HttpMethod.POST, "/orte/" + z.ort("G-2") + "/verschieben", z.wer(),
                Map.of("zielId", z.nord(), "gueltigAb", heute.minusDays(14).toString())));
        assertThat(rw.at("/rueckwirkung/art").asText()).isEqualTo("rueckwirkend");
        assertThat(rw.at("/rueckwirkung/abzeichen").asText()).isEqualTo("rückwirkend (14 Tage)");
        assertThat(rw.at("/rueckwirkendBetroffen/von").asText()).isEqualTo(heute.minusDays(14).toString());
        assertThat(rw.at("/rueckwirkendBetroffen/bis").asText()).isEqualTo(heute.minusDays(1).toString());
        assertThat(rw.at("/protokoll/0/rueckwirkend").asBoolean()).isTrue();
        assertThat(root.queryForList("SELECT rueckwirkend FROM ort_aenderung WHERE tenant_id = ? AND id > ?",
                Boolean.class, z.tenant(), vor)).containsExactly(true);
        assertThat(werte(ok(rufe(HttpMethod.GET, "/standorte/" + z.nord() + "/orte", z.wer(), null)).get("gebaeude"),
                "kurzzeichen")).containsExactly("G-2");

        // Vor dem Beginn: abgelehnt mit dem Satz des Vertrags — Vorschau und Eintrag gleich, nichts geschrieben.
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        beideAbgelehnt(z, "G-2", z.nord(), heute.minusDays(50).toString(), 422, "vor_dem_ersten_intervall", "gueltigAb",
                "Halle 2 gibt es im Portal erst seit " + DATUM.format(heute.minusDays(40)) + ". Wählen Sie ein Datum ab dem "
                        + DATUM.format(heute.minusDays(40)));
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    // ---- Ablehnungen -------------------------------------------------------------------------

    @Test
    void dieGruendeDesVertragsMitSatzUndKeinerSchreibtEtwas() throws IOException {
        // A14 braucht einen bestehenden fremden Kundenbereich. Ohne ihn prüft der Filter
        // den Kontenentzug (401), bevor die Route den fremden Ort verbergen kann (404).
        JsonNode ansprueche = MAPPER.readTree(Base64.getUrlDecoder().decode(token(DEMO2.benutzer()).split("\\.")[1]));
        UUID fremderKundenbereich = UUID.fromString(ansprueche.get("tenant_id").asText());
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", fremderKundenbereich, "Fremder Kundenbereich");
        assertThat(ok(rufe(HttpMethod.GET, "/me", DEMO2, null)).at("/kundenbereich/id").asText())
                .isEqualTo(fremderKundenbereich.toString());
        Welt w = ahrenberg(false);
        String heute = w.heute().toString();
        String morgen = w.heute().plusDays(1).toString();
        // Werk Ahrenberg Nord hat schon eine eigene „Halle 2“.
        String nordHalle2 = neuerOrt(w, w.nord(), "gebaeude", "Halle 2", "G-7", null);
        String lindach = neuerStandort(w.wer(), "Werk Lindach");
        root.update("UPDATE ort_zuordnung SET gueltig_ab = ? WHERE ort_id = ?::uuid", w.heute().minusDays(40), w.ort("G-2"));

        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        beideAbgelehnt(w, "G-2", w.werk(), morgen, 400, "ziel_ist_bisheriger_eltern", "zielId",
                "Halle 2 hängt bereits an Werk Ahrenberg.");
        beideAbgelehnt(w, "G-2", w.ort("G-1"), morgen, 400, "ziel_art_unzulaessig", "zielId",
                "Ein Gebäude kann nur an einem Standort hängen.");
        beideAbgelehnt(w, "B-5", w.ort("B-3"), morgen, 400, "ziel_art_unzulaessig", "zielId",
                "Ein Bereich kann nur an einem Gebäude oder direkt an einem Standort hängen.");
        beideAbgelehnt(w, "G-2", w.nord(), morgen, 409, "name_belegt", null,
                "Diesen Namen gibt es hier schon: Halle 2 (G-7). Wählen Sie einen anderen Namen — oder öffnen Sie Halle 2.");
        beideAbgelehnt(w, "G-2", lindach, w.heute().minusDays(5).toString(), 422, "ziel_gab_es_noch_nicht", "gueltigAb",
                "Werk Lindach gibt es im Portal erst seit " + DATUM.format(w.heute()) + ". Wählen Sie ein Datum ab dem "
                        + DATUM.format(w.heute()) + ".");
        abgelehnt(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", w.wer(), Map.of("gueltigAb", morgen)),
                400, "anfrage_ungueltig", "feld", "zielId");
        abgelehnt(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", w.wer(),
                Map.of("zielId", lindach, "gilt_ab", morgen)), 400, "anfrage_ungueltig");
        // A14: ein fremder Ort ist 404 — für die Vorschau wie für den Eintrag.
        assertThat(rufe(HttpMethod.GET, vorschau(w.ort("G-2"), lindach, morgen), DEMO2, null).getStatusCode().value())
                .isEqualTo(404);
        assertThat(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", DEMO2,
                Map.of("zielId", lindach, "gueltigAb", morgen)).getStatusCode().value()).isEqualTo(404);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("keine Ablehnung schreibt etwas").isEmpty();

        // Zweimal am selben Tag: der zweite ist 409 mit dem Weg „ändern statt zweite anlegen“.
        ok(rufe(HttpMethod.POST, "/orte/" + w.ort("G-2") + "/verschieben", w.wer(), Map.of("zielId", lindach, "gueltigAb", heute)));
        beideAbgelehnt(w, "G-2", w.werk(), heute, 409, "gleicher_tag", "gueltigAb",
                "Für den " + DATUM.format(w.heute()) + " gibt es schon eine Zuordnung (Werk Lindach). Ändern Sie diese, "
                        + "statt eine zweite anzulegen.");
        assertThat(nordHalle2).isNotBlank();
    }

    /**
     * Jede Klasse, die über MQTT SENDET, ist ein Sender dieses Tests (wie in {@code AnlageUmzugApiTest}): kommt ein
     * neuer dazu, fällt dieser Test, bevor A13 still weniger zählt, als die Anwendung sendet.
     */
    @Test
    void jederMqttSenderIstGezaehlt() throws IOException {
        List<String> imQuelltext;
        try (Stream<Path> dateien = Files.walk(Path.of("src", "main", "java"))) {
            imQuelltext = dateien.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> inhalt(p).contains("import org.eclipse.paho") && inhalt(p).contains(".publish("))
                    .map(p -> p.getFileName().toString().replace(".java", ""))
                    .sorted().toList();
        }
        assertThat(imQuelltext).containsExactlyInAnyOrderElementsOf(sender().keySet());
        for (Object mock : sender().values()) {
            List<Object> beans = new ArrayList<>(context.getBeansOfType(
                    Mockito.mockingDetails(mock).getMockCreationSettings().getTypeToMock()).values());
            assertThat(beans).as("genau eine Bean je Sender, und sie ist der Mock").containsExactly(mock);
        }
    }

    // ---- Welt -----------------------------------------------------------------------------------

    private record Welt(UUID tenant, Anrufer wer, String werk, String nord, String anlage, String na2,
            Map<String, String> orte, Map<String, String> messstellen, LocalDate heute) {

        String ort(String kurzzeichen) {
            return java.util.Objects.requireNonNull(orte.get(kurzzeichen), kurzzeichen);
        }
    }

    /** Halle 2 des Referenzunternehmens, heute angelegt; {@code mitMessstellen}: MS-10 … MS-15 an ihren Orten. */
    private Welt ahrenberg(boolean mitMessstellen) {
        ResponseEntity<JsonNode> t = rufe(HttpMethod.POST, "/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", "Kunststoffwerk Ahrenberg GmbH"));
        assertThat(t.getStatusCode().value()).as(String.valueOf(t.getBody())).isEqualTo(201);
        UUID tenant = UUID.fromString(t.getBody().get("id").asText());
        Anrufer wer = new Anrufer("admin", tenant);
        LocalDate heute = LocalDate.now(BERLIN);
        String werk = neuerStandort(wer, "Werk Ahrenberg");
        String nord = neuerStandort(wer, "Werk Ahrenberg Nord");
        String anlage = ok201(rufe(HttpMethod.POST, "/sites", wer,
                Map.of("name", "Werk Ahrenberg – Halle 2", "standortId", werk))).get("id").asText();
        // Box E-2: sie ist da — und bleibt, wie sie ist.
        root.update("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) VALUES (?,?,?,?,?)",
                tenant, UUID.fromString(anlage), "VP-E2-" + tenant.toString().substring(0, 8), "gateway", "claimed");
        Map<String, Object> na = new LinkedHashMap<>();
        na.put("kennzeichen", "NA-2");
        na.put("name", "Anschluss Halle 2");
        na.put("malo", "47110000002");
        na.put("netzbetreiber", "Netzgesellschaft Ahrental (fiktiv)");
        na.put("anschluss_kva", "400");
        na.put("vereinbart_kw", "320");
        na.put("messung", "RLM");
        String na2 = ok201(rufe(HttpMethod.POST, "/standorte/" + werk + "/netzanschluesse", wer, na)).get("id").asText();
        ok201(rufe(HttpMethod.POST, "/standorte/" + werk + "/netzanschluesse/" + na2 + "/anlagen", wer,
                Map.of("anlage_id", anlage, "gueltig_ab", heute.toString())));

        Welt w = new Welt(tenant, wer, werk, nord, anlage, na2, new LinkedHashMap<>(), new LinkedHashMap<>(), heute);
        w.orte().put("G-1", neuerOrt(w, werk, "gebaeude", "Halle 1", "G-1", null));
        w.orte().put("G-2", neuerOrt(w, werk, "gebaeude", "Halle 2", "G-2", null));
        w.orte().put("B-3", neuerOrt(w, werk, "bereich", "Halle 2 Montage", "B-3", w.ort("G-2")));
        w.orte().put("B-4", neuerOrt(w, werk, "bereich", "Halle 2 Spritzguss", "B-4", w.ort("G-2")));
        w.orte().put("B-5", neuerOrt(w, werk, "bereich", "Halle 2 Lager", "B-5", w.ort("G-2")));
        if (!mitMessstellen) {
            return w;
        }
        String werkKz = kurzzeichen(werk);
        for (String kz : HALLE_2_MESSSTELLEN) {
            JsonNode m = referenzMessstelle(kz);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("kennzeichen", kz);
            body.put("name", m.get("name").asText());
            body.put("art", m.get("art").asText());
            body.put("medium", m.get("medium").asText());
            body.put("hauptgroesse", groesse(m.get("hauptgroesse")));
            List<Map<String, String>> neben = new ArrayList<>();
            m.get("nebengroessen").forEach(n -> neben.add(groesse(n)));
            body.put("nebengroessen", neben);
            String id = ok201(rufe(HttpMethod.POST, "/messstellen", wer, body)).get("id").asText();
            w.messstellen().put(kz, id);
            String ort = m.at("/ort/kennzeichen").asText();
            ok(rufe(HttpMethod.PUT, "/messstellen/" + id + "/ort", wer,
                    Map.of("kennzeichen", "ST-1".equals(ort) ? werkKz : ort, "gueltig_ab", heute.toString())));
        }
        // Erst der Hauptzähler, dann die, die auf ihn zeigen — alle an der Anlage „Werk Ahrenberg – Halle 2“.
        for (String kz : HALLE_2_MESSSTELLEN) {
            JsonNode s = referenzMessstelle(kz).at("/elektrische_stellung/0");
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("anlage", anlage);
            body.put("stellung", s.get("stellung").asText());
            body.put("unterzaehler_von", s.get("unterzaehler_von").isNull() ? null : s.get("unterzaehler_von").asText());
            body.put("gueltig_ab", heute.toString());
            ok(rufe(HttpMethod.PUT, "/messstellen/" + w.messstellen().get(kz) + "/stellung", wer, body));
        }
        return w;
    }

    private static JsonNode referenzMessstelle(String kz) {
        for (JsonNode m : referenz.get("messstellen")) {
            if (m.get("kennzeichen").asText().equals(kz)) {
                return m;
            }
        }
        throw new AssertionError("keine Messstelle " + kz + " in der Referenz");
    }

    private static Map<String, String> groesse(JsonNode g) {
        Map<String, String> n = new LinkedHashMap<>();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }

    private String neuerStandort(Anrufer wer, String name) {
        return ok201(rufe(HttpMethod.POST, "/standorte", wer,
                Map.of("name", name, "zeitzone", "Europe/Berlin",
                        "adresse", Map.of("strasse", "Gewerbering 7", "ort", "Ahrenberg", "land", "DE"))))
                .get("id").asText();
    }

    private String neuerOrt(Welt w, String standort, String art, String name, String kz, String eltern) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("art", art);
        body.put("name", name);
        body.put("kurzzeichen", kz);
        body.put("gueltigAb", w.heute().toString());
        if (eltern != null) {
            body.put("elternId", eltern);
        }
        return ok201(rufe(HttpMethod.POST, "/standorte/" + standort + "/orte", w.wer(), body)).get("id").asText();
    }

    private JsonNode standortDerMessstelle(Welt w, String kz, String am) {
        return ok(rufe(HttpMethod.GET, "/messstellen/" + w.messstellen().get(kz) + "/standort?am=" + am, w.wer(), null));
    }

    private void uhr(String zeitpunkt) {
        verschiebenService.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), ZoneOffset.UTC));
    }

    private static String vorschau(String ort, String ziel, String ab) {
        return "/orte/" + ort + "/verschieben/vorschau?zielId=" + ziel + "&gueltigAb=" + ab;
    }

    private Map<String, Object> sender() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("EntityRegistryPublisher", entityRegistryPublisher);
        m.put("ProbePublisher", probePublisher);
        m.put("ChargingConfigPublisher", chargingConfigPublisher);
        m.put("ChargingBoostPublisher", chargingBoostPublisher);
        m.put("RegisterWritePublisher", registerWritePublisher);
        m.put("FlowDeploymentPublisher", flowDeploymentPublisher);
        m.put("ControlCertificationPublisher", controlCertificationPublisher);
        m.put("OtaTargetPublisher", otaTargetPublisher);
        m.put("ProvisioningPublisher", provisioningPublisher);
        m.put("MeasurementConfigPublisher", measurementConfigPublisher);
        m.put("ConsumerOverridePublisher", consumerOverridePublisher);
        m.put("VerbundAnteilePublisher", verbundAnteilePublisher);
        m.put("SprungprobePublisher", sprungprobePublisher);
        return m;
    }

    /** Vorschau UND Eintrag lehnen gleich ab: Status, Code, Feld, Satz. */
    private void beideAbgelehnt(Welt w, String ort, String ziel, String ab, int status, String code, String feld,
            String satzAnfang) {
        for (ResponseEntity<JsonNode> r : List.of(rufe(HttpMethod.GET, vorschau(w.ort(ort), ziel, ab), w.wer(), null),
                rufe(HttpMethod.POST, "/orte/" + w.ort(ort) + "/verschieben", w.wer(),
                        Map.of("zielId", ziel, "gueltigAb", ab)))) {
            if (feld == null) {
                abgelehnt(r, status, code);
            } else {
                abgelehnt(r, status, code, "feld", feld);
            }
            assertThat(r.getBody().get("message").asText()).startsWith(satzAnfang);
        }
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token(wer.benutzer()));
        if (wer.kundenbereich() != null) {
            headers.set("X-Tenant-Id", wer.kundenbereich().toString());
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange("http://localhost:" + port + "/api/v1" + pfad, methode, entity, JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        return r.getBody();
    }

    private static JsonNode ok201(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code, String fakt, String wert) {
        abgelehnt(r, status, code);
        assertThat(r.getBody().get(fakt).asText()).isEqualTo(wert);
    }

    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(status);
        assertThat(r.getBody().get("code").asText()).isEqualTo(code);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(OrtAbgelehnt.CODES).contains(code);
    }

    private String token(String benutzer) {
        return TOKENS.computeIfAbsent(benutzer, b -> {
            MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
            form.add("grant_type", "password");
            form.add("client_id", "voltpilot-api");
            form.add("client_secret", "voltpilot-api-dev-secret");
            form.add("username", b);
            form.add("password", b);
            form.add("scope", "openid");
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
            @SuppressWarnings("unchecked")
            Map<String, Object> antwort = new TestRestTemplate().postForObject(
                    KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                    new HttpEntity<>(form, headers), Map.class);
            assertThat(antwort).as("token response").containsKey("access_token");
            return (String) antwort.get("access_token");
        });
    }

    private static String inhalt(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> werte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.get(feld).asText()));
        return aus;
    }

    private static JsonNode gebaeude(JsonNode baum, String kz) {
        for (JsonNode g : baum.get("gebaeude")) {
            if (g.get("kurzzeichen").asText().equals(kz)) {
                return g;
            }
        }
        throw new AssertionError("Gebäude " + kz + " fehlt in " + baum);
    }

    private static JsonNode bereich(JsonNode gebaeude, String kz) {
        for (JsonNode b : gebaeude.get("bereiche")) {
            if (b.get("kurzzeichen").asText().equals(kz)) {
                return b;
            }
        }
        throw new AssertionError("Bereich " + kz + " fehlt in " + gebaeude);
    }

    private static JsonNode standort(JsonNode antwort, String id) {
        for (JsonNode s : antwort.get("standorte")) {
            if (s.get("id").asText().equals(id)) {
                return s;
            }
        }
        throw new AssertionError("Standort " + id + " fehlt in " + antwort);
    }

    private static List<String> anlagen(JsonNode antwort, String standortId) {
        List<String> aus = new ArrayList<>();
        standort(antwort, standortId).get("anlagen").forEach(a -> aus.add(a.get("id").asText()));
        return aus;
    }

    /** Die Zuordnungen des Orts aus der Datenbank: [Eltern, ab, bis|offen], aufgehobene ausgenommen. */
    private static List<List<String>> zuordnungen(String ort) {
        return root.query("SELECT coalesce(eltern_standort_id, eltern_ort_id)::text, gueltig_ab::text, "
                + "coalesce(gueltig_bis::text, 'offen') FROM ort_zuordnung WHERE ort_id = ?::uuid "
                + "AND aufgehoben_am IS NULL ORDER BY gueltig_ab",
                (rs, n) -> List.of(rs.getString(1), rs.getString(2), rs.getString(3)), ort);
    }

    private static long maxEintrag(UUID tenant) {
        return root.queryForObject("SELECT coalesce(max(id), 0) FROM ort_aenderung WHERE tenant_id = ?", Long.class,
                tenant);
    }

    private static String kurzzeichen(String standort) {
        return root.queryForObject("SELECT kurzzeichen FROM standort WHERE id = ?::uuid", String.class, standort);
    }
}
