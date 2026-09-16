package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
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
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Zeitraum;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.yaml.snakeyaml.Yaml;

/**
 * Das Änderungsprotokoll der Ortsstruktur (UEMS AP-02 IP-14) Ende zu Ende gegen echtes Keycloak +
 * TimescaleDB: je Gebäude/Bereich, je Standort EINSCHLIESSLICH seiner Kinder und
 * Anlagen-Zuordnungen, und die Zeitraum-Abfrage des Unternehmens über die GÜLTIGKEIT — die
 * Schnittstelle, aus der AP-12 die Revision eines freigegebenen Berichts macht.
 *
 * <p>Die Welt ist Halle 2 des Referenzunternehmens Ahrenberg, mit genau den Zeitpunkten des
 * Reports: Werk Ahrenberg und Werk Ahrenberg Nord, am 01.10.2026 Halle 1, Halle 2 (3 100 m²) und
 * der Bereich Halle 2 Montage; am 15.01.2027 die Fläche 3 400 m² ab 01.01.2027 (A3, rückwirkend);
 * am 20.02.2027 zieht die Anlage nach Nord ab 01.03.2027 (geplant, das Muster von A1); am
 * 10.03.2027 wird Halle 2 nach Nord verschoben, gültig ab 01.02.2027 (A2, rückwirkend 37 Tage);
 * am 20.05.2027 die Fläche 3 600 m² ab 01.06.2027 (angekündigt) — da hängt Halle 2 schon an Nord.
 *
 * <ul>
 *   <li><b>A2:</b> {@code GET /unternehmen/aenderungen?von=2027-02-01&bis=2027-02-28&achse=gueltigkeit}
 *       liefert den rückwirkenden Umzug mit seinem Kennzeichen — und die März-Abfrage ebenso, weil
 *       seine Gültigkeit hineinreicht (auf der Wirkungs-Achse stünde er dort nicht).</li>
 *   <li><b>Vertrag:</b> für JEDEN Orts-Eintrag und sechs Zeiträume ist „geliefert" genau
 *       {@code reicht_in_zeitraum} des Ortsbaum-Vertrags ({@link OrtsbaumAbleitung#rueckwirkung}).</li>
 *   <li><b>A3:</b> der Flächen-Eintrag erscheint am Gebäude mit „3.100 m² → 3.400 m²", rückwirkend,
 *       und gilt bis zum Vortag der nächsten Fläche.</li>
 *   <li><b>Vollständigkeit am Standort:</b> Kinder und Anlagen-Zuordnungen stehen dabei — jedes aus
 *       seiner Zeit an diesem Standort, ein Umzug bei beiden, der Umzug einer Anlage nur einmal.</li>
 *   <li><b>Zaun und Anfrage:</b> fremd ist 404; die Gültigkeit liest nur Tage; die Antwort trägt
 *       genau die Felder der OpenAPI.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
// Diese Bestandsvorrichtung legt Orte mit dem alten Plattform-Testkonto an.
// Der Produktionsstandard bleibt geschlossen; UnterstuetzungApiTest prüft ihn ohne Ausnahme.
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "voltpilot.uems.unterstuetzung.umschalter-enabled=true")
class OrtAenderungenApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");

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

    // Kein Sender soll etwas tun — die Schreibwege der Vorrichtung sind die bestehenden.
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

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    StandortService standortService;

    @Autowired
    OrtService ortService;

    @Autowired
    OrtVerschiebenService verschiebenService;

    @Autowired
    AnlageUmzugService umzugService;

    @Autowired
    AnlageStandortService anlageStandortService;

    private static Map<String, Object> schemas;
    private static final Map<String, String> TOKENS = new ConcurrentHashMap<>();

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);

    private record Welt(Anrufer wer, String werk, String nord, String halle1, String halle2, String montage,
            String anlage) {}

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void ladeVertrag() throws IOException {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
    }

    @AfterEach
    void uhrZurueck() {
        uhr(Clock.systemUTC());
    }

    // ---- A2: die Zeitraum-Abfrage über die Gültigkeit -----------------------------------------

    @Test
    void a2DieZeitraumAbfrageLiefertDenRueckwirkendenUmzugMitSeinemKennzeichen() {
        Welt w = ahrenberg();

        JsonNode februar = gueltigkeit(w, "2027-02-01", "2027-02-28");
        assertThat(februar.get("achse").asText()).isEqualTo("gueltigkeit");
        assertThat(OffsetDateTime.parse(februar.get("von").asText()).toInstant())
                .isEqualTo(LocalDate.parse("2027-02-01").atStartOfDay(BERLIN).toInstant());
        assertThat(OffsetDateTime.parse(februar.get("bis").asText()).toInstant())
                .as("der letzte Tag zählt mit — die Antwort bleibt halboffen")
                .isEqualTo(LocalDate.parse("2027-03-01").atStartOfDay(BERLIN).toInstant());

        JsonNode umzug = einer(februar, am(w.halle2(), "verschoben", "2027-02-01"));
        assertThat(umzug.get("zeitform").asText()).as("das Kennzeichen „rückwirkend“").isEqualTo("rueckwirkend");
        assertThat(umzug.get("gilt_bis").isNull()).as("offen — Halle 2 hängt bis heute an Nord").isTrue();
        assertThat(umzug.get("text").asText()).startsWith("Gebäude verschoben: ").contains("Werk Ahrenberg Nord");
        String id = umzug.get("id").asText();

        // Die Abfrage des Reports wörtlich (ohne Achse, Vorgabe „wirkung“) nennt ihn für den Februar ebenso.
        assertThat(ids(ok(rufe(HttpMethod.GET, "/unternehmen/aenderungen?von=2027-02-01&bis=2027-02-28", w.wer()))))
                .contains(id);
        // Der März: der Umzug REICHT hinein — AP-12 muss auch einen freigegebenen März-Bericht anstoßen können.
        assertThat(ids(gueltigkeit(w, "2027-03-01", "2027-03-31"))).contains(id);
        assertThat(ids(ok(rufe(HttpMethod.GET, "/unternehmen/aenderungen?von=2027-03-01&bis=2027-04-01", w.wer()))))
                .as("auf der Wirkungs-Achse fehlt er im März — genau deshalb die Gültigkeit").doesNotContain(id);
        assertThat(ids(gueltigkeit(w, "2027-01-01", "2027-01-31"))).doesNotContain(id);

        // Das Muster von A1: der geplante Umzug der Anlage lässt den Februar unberührt und reicht in den März.
        JsonNode geplant = einer(gueltigkeit(w, "2027-03-01", "2027-03-31"), am(w.anlage(), "verschoben", "2027-03-01"));
        assertThat(geplant.get("zeitform").asText()).isEqualTo("angekuendigt");
        assertThat(ids(februar)).doesNotContain(geplant.get("id").asText());
    }

    @Test
    void geliefertIstGenauReichtInZeitraumDesOrtsbaumVertrags() {
        Welt w = ahrenberg();
        List<JsonNode> orts = eintraege(ok(rufe(HttpMethod.GET, "/unternehmen/aenderungen?limit=500", w.wer())))
                .stream().filter(e -> "ort".equals(e.get("quelle").asText())).toList();
        assertThat(orts).hasSizeGreaterThanOrEqualTo(9);
        String[][] zeitraeume = {
                {"2026-12-01", "2026-12-31"}, {"2027-01-01", "2027-01-31"}, {"2027-02-01", "2027-02-28"},
                {"2027-03-01", "2027-03-31"}, {"2027-06-01", "2027-06-30"}, {"2027-07-01", "2027-07-31"}};
        int gepruef = 0;
        for (String[] z : zeitraeume) {
            Zeitraum zeitraum = new Zeitraum(LocalDate.parse(z[0]), LocalDate.parse(z[1]));
            Set<String> geliefert = ids(gueltigkeit(w, z[0], z[1]));
            for (JsonNode e : orts) {
                LocalDate bis = e.get("gilt_bis").isNull() ? null : LocalDate.parse(e.get("gilt_bis").asText());
                boolean reicht = OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                        OffsetDateTime.parse(e.get("eingetragen_am").asText()), tag(e.get("gilt_ab")), bis, BERLIN,
                        zeitraum)).reichtInZeitraum();
                assertThat(geliefert.contains(e.get("id").asText()))
                        .as("%s %s gilt %s–%s im Zeitraum %s–%s", e.get("art").asText(), e.get("text").asText(),
                                tag(e.get("gilt_ab")), bis, z[0], z[1])
                        .isEqualTo(reicht);
                gepruef++;
            }
        }
        assertThat(gepruef).isEqualTo(orts.size() * zeitraeume.length);
    }

    // ---- A3: der Flächen-Eintrag -------------------------------------------------------------

    @Test
    void a3DerFlaechenEintragErscheintAmGebaeudeMitSeinerGueltigkeit() {
        Welt w = ahrenberg();
        JsonNode halle2 = ok(rufe(HttpMethod.GET, "/orte/" + w.halle2() + "/aenderungen", w.wer()));
        assertThat(eintraege(halle2)).as("nur die eigenen Einträge — nicht die des Bereichs")
                .allSatisfy(e -> assertThat(e.at("/bezug/id").asText()).isEqualTo(w.halle2()));
        assertThat(eintraege(halle2).stream().map(e -> e.get("art").asText()).toList())
                .containsExactlyInAnyOrder("angelegt", "flaeche_geaendert", "verschoben", "flaeche_geaendert");

        JsonNode anbau = einer(halle2, am(w.halle2(), "flaeche_geaendert", "2027-01-01"));
        assertThat(anbau.get("text").asText()).isEqualTo("Bezugsfläche geändert: 3.100 m² → 3.400 m²");
        assertThat(anbau.get("zeitform").asText()).isEqualTo("rueckwirkend");
        assertThat(anbau.get("gilt_bis").asText()).as("bis zum Vortag der nächsten Fläche").isEqualTo("2027-05-31");
        assertThat(anbau.at("/bezug/kennzeichen").asText()).isEqualTo("G-2");

        JsonNode spaeter = einer(halle2, am(w.halle2(), "flaeche_geaendert", "2027-06-01"));
        assertThat(spaeter.get("text").asText()).isEqualTo("Bezugsfläche geändert: 3.400 m² → 3.600 m²");
        assertThat(spaeter.get("zeitform").asText()).isEqualTo("angekuendigt");
        assertThat(spaeter.get("gilt_bis").isNull()).isTrue();

        String id = anbau.get("id").asText();
        assertThat(ids(gueltigkeit(w, "2026-12-01", "2026-12-31"))).as("Dezember: 3 100 m² unverändert").doesNotContain(id);
        assertThat(ids(gueltigkeit(w, "2027-01-01", "2027-01-31"))).contains(id);
        assertThat(ids(gueltigkeit(w, "2027-07-01", "2027-07-31")))
                .doesNotContain(id).contains(spaeter.get("id").asText());
    }

    // ---- Vollständigkeit am Standort -----------------------------------------------------------

    @Test
    void amStandortStehenKinderUndAnlagenZuordnungenJeweilsAusIhrerZeit() {
        Welt w = ahrenberg();

        JsonNode werk = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/aenderungen?limit=500", w.wer()));
        einer(werk, bezugArt(w.werk(), "angelegt"));
        einer(werk, bezugArt(w.halle1(), "angelegt"));
        einer(werk, bezugArt(w.halle2(), "angelegt"));
        einer(werk, bezugArt(w.montage(), "angelegt"));
        einer(werk, am(w.halle2(), "flaeche_geaendert", "2027-01-01"));
        einer(werk, am(w.halle2(), "verschoben", "2027-02-01"));
        JsonNode anlageAngelegt = einer(werk, bezugArt(w.anlage(), "verschoben"));
        assertThat(anlageAngelegt.get("text").asText()).startsWith("Standort zugeordnet: Werk Ahrenberg");
        JsonNode hinaus = einer(werk, e -> w.werk().equals(e.at("/bezug/id").asText())
                && w.anlage().equals(e.at("/neu/anlage_id").asText()));
        assertThat(hinaus.at("/neu/richtung").asText()).isEqualTo("hinaus");
        assertThat(eintraege(werk)).as("Werk Ahrenberg: genau diese acht — nichts aus der Zeit bei Nord, der Umzug "
                + "der Anlage nur einmal").hasSize(8);

        JsonNode nord = ok(rufe(HttpMethod.GET, "/standorte/" + w.nord() + "/aenderungen?limit=500", w.wer()));
        einer(nord, bezugArt(w.nord(), "angelegt"));
        einer(nord, am(w.halle2(), "verschoben", "2027-02-01"));
        einer(nord, am(w.halle2(), "flaeche_geaendert", "2027-06-01"));
        JsonNode hinzu = einer(nord, e -> w.nord().equals(e.at("/bezug/id").asText())
                && w.anlage().equals(e.at("/neu/anlage_id").asText()));
        assertThat(hinzu.at("/neu/richtung").asText()).isEqualTo("hinzu");
        assertThat(eintraege(nord)).noneMatch(e -> w.anlage().equals(e.at("/bezug/id").asText()));
        assertThat(eintraege(nord)).hasSize(4);

        // Seitenweise: dieselben Einträge in derselben Reihenfolge, keiner doppelt, keiner übersprungen.
        List<String> alle = new ArrayList<>(ids(werk));
        List<String> geblaettert = new ArrayList<>();
        String nach = null;
        for (int seite = 0; seite < 10; seite++) {
            JsonNode s = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/aenderungen?limit=3"
                    + (nach == null ? "" : "&nach=" + nach), w.wer()));
            geblaettert.addAll(ids(s));
            nach = s.get("weiter").isNull() ? null : s.get("weiter").asText();
            if (nach == null) {
                break;
            }
        }
        assertThat(geblaettert).containsExactlyElementsOf(alle);
    }

    // ---- Zaun und Anfrage ------------------------------------------------------------------------

    @Test
    void fremdIst404NieB403() {
        Welt w = ahrenberg();
        Anrufer fremd = new Anrufer("admin", kundenbereich("Fremdfirma GmbH"));
        assertThat(rufe(HttpMethod.GET, "/orte/" + w.halle2() + "/aenderungen", fremd).getStatusCode().value())
                .isEqualTo(404);
        assertThat(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/aenderungen", fremd).getStatusCode().value())
                .isEqualTo(404);
        Set<String> ahrenberg = Set.of(w.werk(), w.nord(), w.halle1(), w.halle2(), w.montage(), w.anlage());
        assertThat(eintraege(ok(rufe(HttpMethod.GET, "/unternehmen/aenderungen?achse=gueltigkeit", fremd))))
                .as("der fremde Kundenbereich sieht nur sich selbst")
                .noneMatch(e -> ahrenberg.contains(e.at("/bezug/id").asText()));
        assertThat(rufe(HttpMethod.GET, "/orte/" + UUID.randomUUID() + "/aenderungen", w.wer()).getStatusCode().value())
                .isEqualTo(404);
        assertThat(rufe(HttpMethod.GET, "/standorte/" + UUID.randomUUID() + "/aenderungen", w.wer())
                .getStatusCode().value()).isEqualTo(404);
        // Ein Standort ist kein Gebäude: der Ort-Weg kennt ihn nicht.
        assertThat(rufe(HttpMethod.GET, "/orte/" + w.werk() + "/aenderungen", w.wer()).getStatusCode().value())
                .isEqualTo(404);
    }

    @Test
    void dieGueltigkeitLiestNurTageUndDieAntwortTraegtDieFelderDerOpenApi() {
        Welt w = ahrenberg();
        String pfad = "/orte/" + w.halle2() + "/aenderungen";
        anfrage(rufe(HttpMethod.GET, pfad + "?achse=gueltigkeit&von=gestern", w.wer()), "von");
        anfrage(rufe(HttpMethod.GET, pfad + "?achse=gueltigkeit&bis=2027-02-28T10:00", w.wer()), "bis");
        anfrage(rufe(HttpMethod.GET, pfad + "?achse=gueltigkeit&von=2027-02-10&bis=2027-02-09", w.wer()), "bis");
        anfrage(rufe(HttpMethod.GET, pfad + "?achse=irgendwas", w.wer()), "achse");
        JsonNode einTag = ok(rufe(HttpMethod.GET, pfad + "?achse=gueltigkeit&von=2027-02-01&bis=2027-02-01", w.wer()));
        assertThat(eintraege(einTag)).anyMatch(am(w.halle2(), "verschoben", "2027-02-01"));

        JsonNode antwort = ok(rufe(HttpMethod.GET, pfad, w.wer()));
        assertThat(felder(antwort)).containsExactlyInAnyOrderElementsOf(eigenschaften("Protokoll"));
        assertThat(felder(antwort.at("/eintraege/0"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("ProtokollEintrag"));
        JsonNode standort = ok(rufe(HttpMethod.GET, "/standorte/" + w.werk() + "/aenderungen", w.wer()));
        assertThat(felder(standort.at("/eintraege/0"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("ProtokollEintrag"));
    }

    // ---- Die Welt ------------------------------------------------------------------------------

    /** Halle 2 des Referenzunternehmens mit den Zeitpunkten aus A1–A3 (siehe Kopf). */
    private Welt ahrenberg() {
        uhr("2026-10-01T09:00:00+02:00");
        Anrufer wer = new Anrufer("admin", kundenbereich("Kunststoffwerk Ahrenberg GmbH"));
        String werk = neuerStandort(wer, "Werk Ahrenberg");
        String nord = neuerStandort(wer, "Werk Ahrenberg Nord");
        String anlage = ok201(rufe(HttpMethod.POST, "/sites", wer,
                Map.of("name", "Werk Ahrenberg – Halle 2", "standortId", werk))).get("id").asText();
        String halle1 = neuerOrt(wer, werk, "gebaeude", "Halle 1", "G-1", null, 4200);
        String halle2 = neuerOrt(wer, werk, "gebaeude", "Halle 2", "G-2", null, 3100);
        String montage = neuerOrt(wer, werk, "bereich", "Halle 2 Montage", "B-3", halle2, null);

        uhr("2027-01-15T10:00:00+01:00");
        ok(rufe(HttpMethod.PUT, "/orte/" + halle2 + "/flaeche", wer, Map.of("m2", 3400, "gueltigAb", "2027-01-01")));

        uhr("2027-02-20T10:11:00+01:00");
        ok(rufe(HttpMethod.PUT, "/sites/" + anlage + "/standort", wer,
                Map.of("standortId", nord, "gueltigAb", "2027-03-01")));

        uhr("2027-03-10T09:30:00+01:00");
        ok(rufe(HttpMethod.POST, "/orte/" + halle2 + "/verschieben", wer,
                Map.of("zielId", nord, "gueltigAb", "2027-02-01")));

        uhr("2027-05-20T10:00:00+02:00");
        ok(rufe(HttpMethod.PUT, "/orte/" + halle2 + "/flaeche", wer, Map.of("m2", 3600, "gueltigAb", "2027-06-01")));
        return new Welt(wer, werk, nord, halle1, halle2, montage, anlage);
    }

    private UUID kundenbereich(String name) {
        ResponseEntity<JsonNode> t = rufe(HttpMethod.POST, "/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", name));
        assertThat(t.getStatusCode().value()).as(String.valueOf(t.getBody())).isEqualTo(201);
        return UUID.fromString(t.getBody().get("id").asText());
    }

    private String neuerStandort(Anrufer wer, String name) {
        return ok201(rufe(HttpMethod.POST, "/standorte", wer,
                Map.of("name", name, "zeitzone", "Europe/Berlin",
                        "adresse", Map.of("strasse", "Gewerbering 7", "ort", "Ahrenberg", "land", "DE"))))
                .get("id").asText();
    }

    private String neuerOrt(Anrufer wer, String standort, String art, String name, String kz, String eltern,
            Integer m2) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("art", art);
        body.put("name", name);
        body.put("kurzzeichen", kz);
        body.put("gueltigAb", "2026-10-01");
        if (eltern != null) {
            body.put("elternId", eltern);
        }
        if (m2 != null) {
            body.put("flaecheM2", m2);
        }
        return ok201(rufe(HttpMethod.POST, "/standorte/" + standort + "/orte", wer, body)).get("id").asText();
    }

    private void uhr(String zeitpunkt) {
        uhr(Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), ZoneOffset.UTC));
    }

    private void uhr(Clock c) {
        standortService.uhrStellen(c);
        ortService.uhrStellen(c);
        verschiebenService.uhrStellen(c);
        umzugService.uhrStellen(c);
        anlageStandortService.uhrStellen(c);
    }

    // ---- Lesen ---------------------------------------------------------------------------------

    private JsonNode gueltigkeit(Welt w, String von, String bis) {
        return ok(rufe(HttpMethod.GET, "/unternehmen/aenderungen?achse=gueltigkeit&limit=500&von=" + von
                + "&bis=" + bis, w.wer()));
    }

    private static List<JsonNode> eintraege(JsonNode protokoll) {
        List<JsonNode> out = new ArrayList<>();
        protokoll.get("eintraege").forEach(out::add);
        return out;
    }

    private static Set<String> ids(JsonNode protokoll) {
        Set<String> out = new LinkedHashSet<>();
        protokoll.get("eintraege").forEach(e -> out.add(e.get("id").asText()));
        return out;
    }

    private static LocalDate tag(JsonNode zeitpunkt) {
        return OffsetDateTime.parse(zeitpunkt.asText()).atZoneSameInstant(BERLIN).toLocalDate();
    }

    private static Predicate<JsonNode> bezugArt(String bezugId, String art) {
        return e -> bezugId.equals(e.at("/bezug/id").asText()) && art.equals(e.get("art").asText());
    }

    private static Predicate<JsonNode> am(String bezugId, String art, String giltAb) {
        return bezugArt(bezugId, art).and(e -> tag(e.get("gilt_ab")).toString().equals(giltAb));
    }

    /** Genau EIN Eintrag passt — sonst ist der Umfang falsch (fehlt oder doppelt). */
    private static JsonNode einer(JsonNode protokoll, Predicate<JsonNode> passt) {
        List<JsonNode> treffer = eintraege(protokoll).stream().filter(passt).toList();
        assertThat(treffer).as(protokoll.get("eintraege").toPrettyString()).hasSize(1);
        return treffer.get(0);
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer) {
        return rufe(methode, pfad, wer, null);
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

    private static void anfrage(ResponseEntity<JsonNode> r, String feld) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(400);
        assertThat(r.getBody().get("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(r.getBody().get("feld").asText()).isEqualTo(feld);
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

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as(name).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    private static List<String> felder(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
