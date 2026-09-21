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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
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
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Eine Anlage einem Standort zuordnen oder umziehen (UEMS AP-02 IP-11, T6) Ende zu Ende gegen
 * echtes Keycloak + TimescaleDB — die SCHARFE Fassung von A11: nicht „es geht nichts kaputt",
 * sondern gezählt.
 *
 * <ul>
 *   <li><b>Kein Regelkreis ändert sich (A11):</b> JEDER MQTT-Sender der Anwendung ist hier ein
 *       Mock ({@link #jederMqttSenderIstGezaehlt} hält die Liste ehrlich), und nach dem Eintrag hat
 *       keiner eine einzige Interaktion — keine Konfiguration, kein Override, kein Befehl, kein
 *       Topic. Dazu der Inhalt JEDER Tabelle vorher und nachher: außer {@code anlage_standort}
 *       und {@code ort_aenderung} ändert sich keine Zeile — Box ({@code device}), Topics (sie
 *       tragen {@code site}/{@code device}, beide unverändert), Freigaben, Betriebsmodell,
 *       Overrides, Ladepark-Rahmen ({@code site_charging_config}), Fahrpläne
 *       ({@code schedule}), Funktionen und Messstellen.</li>
 *   <li><b>Vorschau = Wirkung:</b> die Vorschau schreibt nichts (ganze Datenbank gleich) und
 *       kündigt genau die Zuordnungen, Fakten und Folgen an, die der Eintrag danach meldet und
 *       die das Standort-Lesemodell an jedem Grenztag zeigt.</li>
 *   <li><b>Zeitpunkt:</b> ein „gültig ab" in der Zukunft wirkt erst dann — bis zum Vortag zählt
 *       der alte Standort, auch in {@code GET /sites/{id}}; ein Tag in der Vergangenheit ist
 *       rückwirkend und trägt es sichtbar.</li>
 *   <li><b>Protokoll:</b> je ein Eintrag an der Anlage, am neuen und am bisherigen Standort, mit
 *       Urheber und Begründung; die erste Zuordnung hat keinen bisherigen.</li>
 *   <li><b>Ablehnungen:</b> die Gründe des Ortsbaum-Vertrags mit Status und Satz, fremde Anlage
 *       404 — und keine schreibt etwas.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AnlageUmzugApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    /** Die Tabellen, die eine Zuordnung schreiben darf — und keine sonst. */
    private static final List<String> GESCHRIEBEN = List.of("anlage_standort", "ort_aenderung");

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

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    ApplicationContext context;

    @Autowired
    AnlageUmzugService umzugService;

    private static JdbcTemplate root;
    private static final Map<String, String> TOKENS = new ConcurrentHashMap<>();

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private static final Anrufer DEMO = new Anrufer("demo", null);
    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        umzugService.uhrStellen(Clock.systemUTC());
    }

    // ---- A11: kein Regelkreis ändert sich --------------------------------------------------

    @Test
    void a11DieZuordnungAendertKeinenRegelkreisUndSendetNichts() {
        Welt w = ahrenberg();
        // Box E-2 und der Ladepark-Rahmen von 200 kW: sie sind da — und bleiben, wie sie sind.
        root.update("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) VALUES (?,?,?,?,?)",
                w.tenant(), UUID.fromString(w.anlage()), "VP-E2-" + w.tenant().toString().substring(0, 8), "gateway",
                "claimed");
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw) VALUES (?,?,?)",
                UUID.fromString(w.anlage()), w.tenant(), 200.0);
        uhr("2027-02-20T10:00:00+01:00");

        Map<String, String> ganzVorher = Bestandsschutz.fingerabdruck(root, List.of());
        ResponseEntity<JsonNode> v = rufe(HttpMethod.GET, "/sites/" + w.anlage() + "/standort/vorschau?standortId="
                + w.nord() + "&gueltigAb=2027-03-01", w.wer(), null);
        assertThat(v.getStatusCode().value()).as(String.valueOf(v.getBody())).isEqualTo(200);
        assertThat(Bestandsschutz.abweichungen(ganzVorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("die Vorschau schreibt nichts").isEmpty();
        JsonNode vorschau = v.getBody();
        assertThat(texte(vorschau.get("bleibt"))).containsExactly("box", "topics", "freigaben", "betriebsmodell",
                "ladepark_rahmen", "fahrplaene", "messstellen");
        assertThat(vorschau.get("befehle").asInt()).isZero();
        assertThat(vorschau.get("boxen").asInt()).isEqualTo(1);

        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, GESCHRIEBEN);
        Mockito.clearInvocations(sender().values().toArray());
        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(),
                Map.of("standortId", w.nord(), "gueltigAb", "2027-03-01"));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);

        // Gezählt, nicht vermutet: kein Sender hat irgendetwas bekommen.
        Map<String, Integer> aufrufe = new LinkedHashMap<>();
        sender().forEach((name, mock) -> aufrufe.put(name, Mockito.mockingDetails(mock).getInvocations().size()));
        assertThat(aufrufe).as("Aufrufe je MQTT-Sender nach der Zuordnung").hasSize(12)
                .allSatisfy((name, n) -> assertThat(n).as(name).isZero());
        assertThat(r.getBody().get("befehle").asInt()).isZero();
        // Und in der Datenbank ändern sich nur Zuordnung und Protokoll.
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, GESCHRIEBEN)))
                .as("außer anlage_standort und ort_aenderung ändert die Zuordnung keine Tabelle").isEmpty();

        LocalDate angelegt = w.angelegt();
        assertThat(zuordnungen(w.anlage())).containsExactly(
                List.of(w.werk(), angelegt.toString(), "2027-02-28"),
                List.of(w.nord(), "2027-03-01", "offen"));

        // Ab 01.03.2027 zählt Werk Ahrenberg Nord „1 Anlage", Werk Ahrenberg keine mehr.
        JsonNode feb = rufe(HttpMethod.GET, "/standorte?stichtag=2027-02-28", w.wer(), null).getBody();
        JsonNode mar = rufe(HttpMethod.GET, "/standorte?stichtag=2027-03-01", w.wer(), null).getBody();
        assertThat(anlagen(feb, w.werk())).containsExactly(w.anlage());
        assertThat(anlagen(feb, w.nord())).isEmpty();
        assertThat(anlagen(mar, w.werk())).isEmpty();
        assertThat(anlagen(mar, w.nord())).containsExactly(w.anlage());
        assertThat(standort(mar, w.nord()).get("anlagenZahl").asInt()).isEqualTo(1);
    }

    /** N2: Nur die erste Zuordnung stößt für eine Bestandsanlage sofort denselben Umstieg wie der Läufer an. */
    @Test
    void ersteZuordnungEinerBestandsanlageErzeugtSofortDieTeilnahme() {
        OhneStandort w = ohneStandort("Bestand");
        root.update("INSERT INTO site_profile_state (site_id, profile, state, tenant_id, updated_at) "
                + "VALUES (?::uuid, 'lastspitzenkappung', 'an', ?, now())", w.anlage(), w.tenant());
        LocalDate ersterTag = LocalDate.now(BERLIN).plusDays(14);

        ResponseEntity<JsonNode> erste = rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(),
                Map.of("standortId", w.werk(), "gueltigAb", ersterTag.toString()));
        assertThat(erste.getStatusCode().value()).as(String.valueOf(erste.getBody())).isEqualTo(200);
        assertThat(erste.getBody().path("steuern").path("zustand").asText()).isEqualTo("aktiv");
        assertThat(root.queryForObject("SELECT count(*) FROM funktion_teilnahme WHERE tenant_id = ?", Long.class,
                w.tenant())).isOne();
        UUID funktion = root.queryForObject("SELECT funktion_id FROM funktion_teilnahme WHERE site_id = ?::uuid",
                UUID.class, w.anlage());

        ResponseEntity<JsonNode> spaeter = rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(),
                Map.of("standortId", w.nord(), "gueltigAb", ersterTag.plusDays(1).toString()));
        assertThat(spaeter.getStatusCode().value()).as(String.valueOf(spaeter.getBody())).isEqualTo(200);
        assertThat(root.queryForList("SELECT funktion_id FROM funktion_teilnahme WHERE site_id = ?::uuid",
                UUID.class, w.anlage())).containsExactly(funktion);
    }

    /** Eine neu angelegte Anlage ohne Bestandsfakten bleibt beim Steuern-/Messen-Assistenten. */
    @Test
    void neueAnlageBekommtDurchDieErsteZuordnungKeineTeilnahme() {
        OhneStandort w = ohneStandort("Neu");

        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(),
                Map.of("standortId", w.werk()));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        assertThat(r.getBody().path("steuern").isMissingNode() || r.getBody().path("steuern").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM funktion_teilnahme WHERE site_id = ?::uuid", Long.class,
                w.anlage())).isZero();
    }

    /**
     * Jede Klasse, die über MQTT SENDET, ist ein Sender dieses Tests: der Quelltext ist die Liste
     * (Paho-Import und {@code .publish(}), der Spring-Kontext muss für jede einen Mock tragen. Kommt ein neuer Sender
     * dazu, fällt dieser Test, bevor A11 still weniger zählt, als die Anwendung sendet.
     */
    @Test
    void jederMqttSenderIstGezaehlt() throws IOException {
        List<String> imQuelltext;
        try (Stream<Path> dateien = Files.walk(Path.of("src", "main", "java"))) {
            imQuelltext = dateien.filter(p -> p.toString().endsWith(".java"))
                    // Wer MQTT importiert UND sendet — die Listener empfangen nur.
                    .filter(p -> inhalt(p).contains("import org.eclipse.paho") && inhalt(p).contains(".publish("))
                    .map(p -> p.getFileName().toString().replace(".java", ""))
                    .sorted().toList();
        }
        assertThat(imQuelltext).containsExactlyInAnyOrderElementsOf(sender().keySet());
        sender().forEach((name, mock) -> assertThat(Mockito.mockingDetails(mock).isMock()).as(name).isTrue());
        for (Object mock : sender().values()) {
            List<Object> beans = new ArrayList<>(context.getBeansOfType(
                    Mockito.mockingDetails(mock).getMockCreationSettings().getTypeToMock()).values());
            assertThat(beans).as("genau eine Bean je Sender, und sie ist der Mock").containsExactly(mock);
        }
    }

    // ---- Vorschau = Wirkung ------------------------------------------------------------------

    @Test
    void wasDieVorschauAnkuendigtTrittEin() {
        Welt w = ahrenberg();
        uhr("2027-02-20T10:00:00+01:00");
        // Schon geplant: ab 01.06.2027 gehört Halle 2 zu Werk Ahrenberg Nord.
        assertThat(rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(),
                Map.of("standortId", w.nord(), "gueltigAb", "2027-06-01")).getStatusCode().value()).isEqualTo(200);
        String lindach = neuerStandort(w.wer(), "Werk Lindach");

        String vorschauPfad = "/sites/" + w.anlage() + "/standort/vorschau?standortId=" + lindach
                + "&gueltigAb=2027-03-01";
        JsonNode vorschau = rufe(HttpMethod.GET, vorschauPfad, w.wer(), null).getBody();
        assertThat(vorschau.at("/bisher/id").asText()).isEqualTo(w.werk());
        assertThat(vorschau.at("/neu/id").asText()).isEqualTo(lindach);
        assertThat(vorschau.get("gueltigBis").asText()).as("erbt das Ende der laufenden").isEqualTo("2027-05-31");
        assertThat(vorschau.at("/danach/id").asText()).isEqualTo(w.nord());
        assertThat(vorschau.at("/rueckwirkung/art").asText()).isEqualTo("geplant");
        assertThat(vorschau.get("protokoll")).isEmpty();

        JsonNode eintrag = rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(),
                Map.of("standortId", lindach, "gueltigAb", "2027-03-01")).getBody();
        for (String feld : List.of("anlageId", "anlageName", "bisher", "neu", "gueltigAb", "gueltigBis", "danach",
                "rueckwirkung", "zuordnungen", "bleibt", "boxen", "netzanschluss", "steuern", "befehle")) {
            assertThat(eintrag.get(feld)).as(feld).isEqualTo(vorschau.get(feld));
        }
        assertThat(eintrag.get("protokoll")).hasSize(3);

        // Die angekündigten Zuordnungen sind die gespeicherten — und das Lesemodell zeigt jede an ihrem ersten Tag.
        List<List<String>> angekuendigt = new ArrayList<>();
        for (JsonNode z : vorschau.get("zuordnungen")) {
            String bis = z.get("gueltigBis").isNull() ? "offen" : z.get("gueltigBis").asText();
            angekuendigt.add(List.of(z.at("/standort/id").asText(), z.get("gueltigAb").asText(), bis));
            JsonNode amTag = rufe(HttpMethod.GET, "/standorte?stichtag=" + z.get("gueltigAb").asText(), w.wer(), null)
                    .getBody();
            assertThat(anlagen(amTag, z.at("/standort/id").asText())).as(z.toString()).contains(w.anlage());
        }
        assertThat(zuordnungen(w.anlage())).containsExactlyElementsOf(angekuendigt);
        assertThat(angekuendigt).containsExactly(
                List.of(w.werk(), w.angelegt().toString(), "2027-02-28"),
                List.of(lindach, "2027-03-01", "2027-05-31"),
                List.of(w.nord(), "2027-06-01", "offen"));
    }

    // ---- Zeitpunkt ---------------------------------------------------------------------------

    @Test
    void gueltigAbInDerZukunftWirktErstDannUndInDerVergangenheitRueckwirkend() {
        Welt w = ahrenberg();
        LocalDate heute = w.angelegt();
        LocalDate ab = heute.plusDays(10);
        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(),
                Map.of("standortId", w.nord(), "gueltigAb", ab.toString()));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        assertThat(r.getBody().at("/rueckwirkung/art").asText()).isEqualTo("geplant");
        assertThat(r.getBody().at("/rueckwirkung/tage").asLong()).isEqualTo(10);

        // Heute gehört sie noch zu Werk Ahrenberg — in der Anlage selbst und in der Liste.
        JsonNode site = rufe(HttpMethod.GET, "/sites/" + w.anlage(), w.wer(), null).getBody();
        assertThat(site.at("/standort/id").asText()).isEqualTo(w.werk());
        assertThat(anlagen(rufe(HttpMethod.GET, "/standorte", w.wer(), null).getBody(), w.werk()))
                .containsExactly(w.anlage());
        JsonNode vortag = rufe(HttpMethod.GET, "/standorte?stichtag=" + ab.minusDays(1), w.wer(), null).getBody();
        JsonNode erster = rufe(HttpMethod.GET, "/standorte?stichtag=" + ab, w.wer(), null).getBody();
        assertThat(anlagen(vortag, w.werk())).containsExactly(w.anlage());
        assertThat(anlagen(vortag, w.nord())).isEmpty();
        assertThat(anlagen(erster, w.nord())).containsExactly(w.anlage());
        assertThat(anlagen(erster, w.werk())).isEmpty();

        // Rückwirkend: die Anlage hing schon seit 40 Tagen am Werk, das Nordwerk gibt es seit 60.
        Welt z = ahrenberg();
        root.update("UPDATE anlage_standort SET gueltig_ab = ? WHERE site_id = ?::uuid", heute.minusDays(40), z.anlage());
        root.update("UPDATE standort SET created_at = created_at - interval '60 days' WHERE id = ?::uuid", z.nord());
        long vor = maxEintrag(z.tenant());
        ResponseEntity<JsonNode> rw = rufe(HttpMethod.PUT, "/sites/" + z.anlage() + "/standort", z.wer(),
                Map.of("standortId", z.nord(), "gueltigAb", heute.minusDays(14).toString()));
        assertThat(rw.getStatusCode().value()).as(String.valueOf(rw.getBody())).isEqualTo(200);
        assertThat(rw.getBody().at("/rueckwirkung/art").asText()).isEqualTo("rueckwirkend");
        assertThat(rw.getBody().at("/rueckwirkung/abzeichen").asText()).isEqualTo("rückwirkend (14 Tage)");
        assertThat(root.queryForList("SELECT rueckwirkend FROM ort_aenderung WHERE tenant_id = ? AND id > ?",
                Boolean.class, z.tenant(), vor)).hasSize(3).containsOnly(true);
        assertThat(rufe(HttpMethod.GET, "/sites/" + z.anlage(), z.wer(), null).getBody().at("/standort/id").asText())
                .isEqualTo(z.nord());
    }

    // ---- Protokoll ---------------------------------------------------------------------------

    @Test
    void jeEinEintragAnDerAnlageUndAnJedemStandortMitUrheberUndBegruendung() {
        // Ein Kunde selbst (demo2, eine Anlage ohne Standort): erst zuordnen, dann umziehen.
        JsonNode anlagen = rufe(HttpMethod.GET, "/sites", DEMO2, null).getBody().path("eintraege");
        assertThat(anlagen.isArray()).as("Die Anlagenliste trägt den Teilansicht-Umschlag").isTrue();
        assertThat(anlagen).isNotEmpty();
        String anlage = anlagen.get(0).get("id").asText();
        UUID tenant = UUID.fromString(anspruch("demo2").get("tenant_id").asText());
        String werk = neuerStandort(DEMO2, "Hof Sonnenfeld");
        String scheune = neuerStandort(DEMO2, "Hof Sonnenfeld Scheune");
        String sub = anspruch("demo2").get("sub").asText();

        long vor = maxEintrag(tenant);
        ResponseEntity<JsonNode> erste = rufe(HttpMethod.PUT, "/sites/" + anlage + "/standort", DEMO2,
                Map.of("standortId", werk, "begruendung", "  Bestand: die Anlage steht am Hof.  "));
        assertThat(erste.getStatusCode().value()).as(String.valueOf(erste.getBody())).isEqualTo(200);
        assertThat(erste.getBody().get("bisher").isNull()).isTrue();
        List<Map<String, Object>> e1 = eintraegeNach(tenant, vor);
        assertThat(e1).extracting(m -> m.get("objekt_art") + "/" + m.get("objekt_id"))
                .containsExactly("anlage/" + anlage, "standort/" + werk);
        assertThat(e1).allSatisfy(m -> {
            assertThat(m.get("art")).isEqualTo("verschoben");
            assertThat(m.get("actor_sub")).isEqualTo(sub);
            assertThat((String) m.get("actor_name")).isNotBlank().doesNotStartWith("VoltPilot");
            assertThat(json(m.get("neu")).get("begruendung").asText()).isEqualTo("Bestand: die Anlage steht am Hof.");
        });

        String morgen = LocalDate.now(BERLIN).plusDays(1).toString();
        vor = maxEintrag(tenant);
        ResponseEntity<JsonNode> zweite = rufe(HttpMethod.PUT, "/sites/" + anlage + "/standort", DEMO2,
                Map.of("standortId", scheune, "gueltigAb", morgen, "begruendung", "Die Anlage zieht in die Scheune."));
        assertThat(zweite.getStatusCode().value()).as(String.valueOf(zweite.getBody())).isEqualTo(200);
        List<Map<String, Object>> e2 = eintraegeNach(tenant, vor);
        assertThat(e2).extracting(m -> m.get("objekt_art") + "/" + m.get("objekt_id"))
                .containsExactly("anlage/" + anlage, "standort/" + scheune, "standort/" + werk);
        assertThat(e2).allSatisfy(m -> {
            assertThat(m.get("actor_sub")).isEqualTo(sub);
            assertThat(m.get("gilt_ab")).isEqualTo(morgen);
            assertThat(json(m.get("neu")).get("begruendung").asText()).isEqualTo("Die Anlage zieht in die Scheune.");
        });
        assertThat(json(e2.get(0).get("alt")).get("standort_id").asText()).isEqualTo(werk);
        assertThat(json(e2.get(0).get("neu")).get("standort_id").asText()).isEqualTo(scheune);
        assertThat(json(e2.get(1).get("neu")).get("richtung").asText()).isEqualTo("hinzu");
        assertThat(json(e2.get(2).get("neu")).get("richtung").asText()).isEqualTo("hinaus");
        assertThat(zweite.getBody().get("protokoll")).extracting(p -> p.get("id").asLong())
                .containsExactlyElementsOf(e2.stream().map(m -> ((Number) m.get("id")).longValue()).toList());

        // Der Sachverhalt steht im Änderungsprotokoll mit dem Satz je Seite.
        assertThat(e2).extracting(m -> AenderungSatz.satz((String) m.get("objekt_art"), "verschoben",
                json(m.get("alt")), json(m.get("neu")), null)).containsExactly(
                "Standort zugeordnet: Hof Sonnenfeld Scheune (" + kurzzeichen(scheune) + ")",
                "Anlage zugeordnet: " + json(e2.get(1).get("neu")).get("anlage_name").asText(),
                "Anlage zieht um: " + json(e2.get(2).get("neu")).get("anlage_name").asText()
                        + " → Hof Sonnenfeld Scheune");

        // Ein anderer Kundenbereich sieht die Anlage nicht: 404, nie 403 — weder Vorschau noch Eintrag.
        abgelehnt(rufe(HttpMethod.GET, "/sites/" + anlage + "/standort/vorschau?standortId=" + scheune, DEMO, null),
                404, "nicht_gefunden");
        abgelehnt(rufe(HttpMethod.PUT, "/sites/" + anlage + "/standort", DEMO, Map.of("standortId", scheune)),
                404, "nicht_gefunden");
    }

    // ---- Ablehnungen ---------------------------------------------------------------------------

    @Test
    void dieGruendeDesVertragsMitSatzUndKeinerSchreibtEtwas() {
        Welt w = ahrenberg();
        uhr("2027-02-20T10:00:00+01:00");
        String anlage = "/sites/" + w.anlage() + "/standort";
        long eintraege = maxEintrag(w.tenant());
        List<List<String>> zuordnungenVorher = zuordnungen(w.anlage());

        beideAbgelehnt(w, Map.of("standortId", w.werk(), "gueltigAb", "2027-03-01"), 400,
                "ziel_ist_bisheriger_eltern", "standortId", "Werk Ahrenberg – Halle 2 ist bereits Werk Ahrenberg zugeordnet.");
        beideAbgelehnt(w, Map.of("standortId", w.nord(), "gueltigAb", w.angelegt().minusDays(5).toString()), 422,
                "vor_dem_ersten_intervall", "gueltigAb", "Werk Ahrenberg – Halle 2 gibt es im Portal erst seit "
                        + OrtsbaumAbleitung.datumText(w.angelegt()) + ". Wählen Sie ein Datum ab dem "
                        + OrtsbaumAbleitung.datumText(w.angelegt())
                        + " — oder ersetzen Sie die Zuordnung ab Beginn (Korrektur).");
        beideAbgelehnt(w, Map.of("standortId", UUID.randomUUID().toString(), "gueltigAb", "2027-03-01"), 400,
                "anfrage_ungueltig", "standortId", "Diesen Standort gibt es nicht.");
        abgelehnt(rufe(HttpMethod.PUT, anlage, w.wer(), Map.of("gueltigAb", "2027-03-01")), 400, "anfrage_ungueltig",
                "feld", "standortId");
        abgelehnt(rufe(HttpMethod.PUT, anlage, w.wer(), Map.of("standortId", w.nord(), "kommando", "an")), 400,
                "anfrage_ungueltig", "feld", "kommando");
        abgelehnt(rufe(HttpMethod.PUT, anlage, w.wer(), Map.of("standortId", w.nord(), "gueltigAb", "2027-02-30")),
                400, "anfrage_ungueltig", "feld", "gueltigAb");
        abgelehnt(rufe(HttpMethod.PUT, anlage, w.wer(), Map.of("standortId", w.nord(), "begruendung", "x".repeat(501))),
                400, "anfrage_ungueltig", "feld", "begruendung");
        abgelehnt(rufe(HttpMethod.GET, anlage + "/vorschau?standortId=kein-uuid", w.wer(), null), 400,
                "anfrage_ungueltig", "feld", "standortId");
        abgelehnt(rufe(HttpMethod.PUT, "/sites/" + UUID.randomUUID() + "/standort", w.wer(),
                Map.of("standortId", w.nord())), 404, "nicht_gefunden");
        assertThat(maxEintrag(w.tenant())).as("keine Ablehnung schreibt ins Protokoll").isEqualTo(eintraege);
        assertThat(zuordnungen(w.anlage())).as("keine Ablehnung ändert eine Zuordnung").isEqualTo(zuordnungenVorher);

        // Zweimal derselbe Tag (Überlappung): 409 mit dem Satz des Vertrags.
        assertThat(rufe(HttpMethod.PUT, anlage, w.wer(), Map.of("standortId", w.nord(), "gueltigAb", "2027-03-01"))
                .getStatusCode().value()).isEqualTo(200);
        // Das Anlegen des Standorts schreibt selbst einen Eintrag — erst danach zählt die Ablehnung.
        String lindach = neuerStandort(w.wer(), "Werk Lindach");
        eintraege = maxEintrag(w.tenant());
        beideAbgelehnt(w, Map.of("standortId", lindach, "gueltigAb", "2027-03-01"), 409, "gleicher_tag", "gueltigAb",
                "Für den 01.03.2027 gibt es schon eine Zuordnung (Werk Ahrenberg Nord). Ändern Sie diese, statt eine "
                        + "zweite anzulegen.");
        assertThat(maxEintrag(w.tenant())).isEqualTo(eintraege);
    }

    // ---- Gerüst ------------------------------------------------------------------------------

    /** Ein Kundenbereich mit Werk Ahrenberg und Werk Ahrenberg Nord; Halle 2 heute am Werk angelegt. */
    private record Welt(UUID tenant, Anrufer wer, String werk, String nord, String anlage, LocalDate angelegt) {}

    private record OhneStandort(UUID tenant, Anrufer wer, String werk, String nord, String anlage) {}

    private Welt ahrenberg() {
        ResponseEntity<JsonNode> t = rufe(HttpMethod.POST, "/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", "Kunststoffwerk Ahrenberg GmbH"));
        assertThat(t.getStatusCode().value()).as(String.valueOf(t.getBody())).isEqualTo(201);
        UUID tenant = UUID.fromString(t.getBody().get("id").asText());
        Anrufer wer = new Anrufer("admin", tenant);
        String werk = neuerStandort(wer, "Werk Ahrenberg");
        String nord = neuerStandort(wer, "Werk Ahrenberg Nord");
        ResponseEntity<JsonNode> s = rufe(HttpMethod.POST, "/sites", wer,
                Map.of("name", "Werk Ahrenberg – Halle 2", "standortId", werk));
        assertThat(s.getStatusCode().value()).as(String.valueOf(s.getBody())).isEqualTo(201);
        LocalDate angelegt = LocalDate.now(BERLIN);
        return new Welt(tenant, wer, werk, nord, s.getBody().get("id").asText(), angelegt);
    }

    private OhneStandort ohneStandort(String art) {
        ResponseEntity<JsonNode> t = rufe(HttpMethod.POST, "/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", art + " ohne Standort GmbH"));
        assertThat(t.getStatusCode().value()).as(String.valueOf(t.getBody())).isEqualTo(201);
        UUID tenant = UUID.fromString(t.getBody().get("id").asText());
        Anrufer wer = new Anrufer("admin", tenant);
        ResponseEntity<JsonNode> s = rufe(HttpMethod.POST, "/sites", wer, Map.of("name", art + " Halle"));
        assertThat(s.getStatusCode().value()).as(String.valueOf(s.getBody())).isEqualTo(201);
        String werk = neuerStandort(wer, art + " Werk");
        String nord = neuerStandort(wer, art + " Werk Nord");
        return new OhneStandort(tenant, wer, werk, nord, s.getBody().get("id").asText());
    }

    private String neuerStandort(Anrufer wer, String name) {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte", wer,
                Map.of("name", name, "zeitzone", "Europe/Berlin",
                        "adresse", Map.of("strasse", "Gewerbering 7", "ort", "Ahrenberg", "land", "DE")));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody().get("id").asText();
    }

    private void uhr(String zeitpunkt) {
        umzugService.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), ZoneOffset.UTC));
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
        return m;
    }

    /** Vorschau UND Eintrag lehnen gleich ab: Status, Code, Feld, Satz. */
    private void beideAbgelehnt(Welt w, Map<String, Object> body, int status, String code, String feld, String satz) {
        StringBuilder q = new StringBuilder("/sites/" + w.anlage() + "/standort/vorschau?standortId=" + body.get("standortId"));
        if (body.containsKey("gueltigAb")) {
            q.append("&gueltigAb=").append(body.get("gueltigAb"));
        }
        for (ResponseEntity<JsonNode> r : List.of(rufe(HttpMethod.GET, q.toString(), w.wer(), null),
                rufe(HttpMethod.PUT, "/sites/" + w.anlage() + "/standort", w.wer(), body))) {
            abgelehnt(r, status, code, "feld", feld);
            assertThat(r.getBody().get("message").asText()).isEqualTo(satz);
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

    private JsonNode anspruch(String benutzer) {
        return json(new String(Base64.getUrlDecoder().decode(token(benutzer).split("\\.")[1]), StandardCharsets.UTF_8));
    }

    private static JsonNode json(Object text) {
        if (text == null) {
            return null;
        }
        try {
            return MAPPER.readTree(text.toString());
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String inhalt(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    /** Die Zuordnungen der Anlage aus der Datenbank: [Standort, ab, bis|offen], aufgehobene ausgenommen. */
    private static List<List<String>> zuordnungen(String anlage) {
        return root.query("SELECT standort_id::text, gueltig_ab::text, coalesce(gueltig_bis::text, 'offen') "
                + "FROM anlage_standort WHERE site_id = ?::uuid AND aufgehoben_am IS NULL ORDER BY gueltig_ab",
                (rs, n) -> List.of(rs.getString(1), rs.getString(2), rs.getString(3)), anlage);
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

    private static long maxEintrag(UUID tenant) {
        return root.queryForObject("SELECT coalesce(max(id), 0) FROM ort_aenderung WHERE tenant_id = ?", Long.class,
                tenant);
    }

    private static List<Map<String, Object>> eintraegeNach(UUID tenant, long id) {
        return root.queryForList("SELECT id, objekt_art, objekt_id::text AS objekt_id, art, alt::text AS alt, "
                + "neu::text AS neu, gilt_ab::text AS gilt_ab, rueckwirkend, actor_sub, actor_name "
                + "FROM ort_aenderung WHERE tenant_id = ? AND id > ? ORDER BY id", tenant, id);
    }

    private static String kurzzeichen(String standort) {
        return root.queryForObject("SELECT kurzzeichen FROM standort WHERE id = ?::uuid", String.class, standort);
    }
}
