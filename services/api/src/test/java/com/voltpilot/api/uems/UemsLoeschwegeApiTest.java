package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.ocpp.OcppActionRepository;
import com.voltpilot.api.ocpp.OcppRepository;
import com.voltpilot.api.repo.AdminComponentFleetRepository;
import com.voltpilot.api.repo.OverviewRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MesskanalDto;
import com.voltpilot.api.web.dto.OcppDto;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
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
 * Die Löschwege (UEMS AP-07 IP-11, E8, AP-06 E7; Captain 13.09.2026: beim Abmelden und beim Tausch
 * geht kein Datenbestand verloren) Ende zu Ende gegen echtes Keycloak + TimescaleDB.
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li><b>A14</b> am Werk AN-1 des Referenzunternehmens (Box E-1 liest K-3 … K-6, fünf Messstellen
 *       sind gebunden): „Datenaufzeichnungen löschen" wird mit der Liste der fünf Messstellen
 *       abgelehnt und schreibt nichts; „Gerät entfernen" baut die Box aus und verliert keinen
 *       Wert (v1-Telemetrie, OCPP-Aufzeichnungen, Messwert-Strecke, Ereignisse); das Entfernen der
 *       Anlage wird mit derselben Liste abgelehnt und schreibt nichts; eine ungebundene
 *       Bestandsanlage lässt sich weiter entfernen;</li>
 *   <li>der Abmelde-Weg tut sonst dasselbe wie vorher: die Topologie zeigt nicht mehr auf die Box,
 *       die Aufkleber-Kennung ist wieder anmeldbar, jede Geräte-Route antwortet 404;</li>
 *   <li>der Mandantenzaun: fremd ist 404 auf allen drei Wegen, und nichts ändert sich;</li>
 *   <li>je umgestellter Live-Fläche: die ausgebaute Box ist in der Historie noch da und dort nicht
 *       mehr aktiv.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class UemsLoeschwegeApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";
    private static final String ENERGIE_ABGABE = "sunspec.model_203.totwhexp";
    private static final String KATALOG = "2026.08.26.3";
    private static final String AB = "2024-03-12T00:00:00+01:00";
    private static final String LADEPUNKT = "CP-HALLE-1";
    private static final UUID DEMO_KUNDENBEREICH = UUID.fromString("00000000-0000-0000-0000-000000000001");

    /** Die Tabellen, deren Zeilen einer Box das Abmelden heute nicht mehr leeren darf. */
    private static final List<String> AUFZEICHNUNGEN = List.of("telemetry",
            "ocpp_station", "ocpp_connector_state", "ocpp_protocol_event", "ocpp_connector_status_event",
            "ocpp_authorization_event", "ocpp_transaction", "ocpp_meter_sample", "ocpp_station_status_event",
            "ocpp_configuration_key", "ocpp_configuration_unknown_key", "ocpp_station_capability",
            "device_measurement_sample", "device_measurement_event", "device_measurement_point_state",
            "device_measurement_selection", "device_measurement_selection_event", "entity_observed_state",
            "device_component_apply", "messreihe_ereignis");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
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

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    OcppRepository ocpp;

    @Autowired
    OcppActionRepository ocppAktionen;

    @Autowired
    EntityObservedRepository beobachtet;

    @Autowired
    ComponentApplyRepository angewandt;

    @Autowired
    AdminComponentFleetRepository komponentenFlotte;

    @Autowired
    MesskanalService messkanaele;

    @Autowired
    MessstelleFormelWerteRepository formelWerte;

    @Autowired
    MessstelleFormelTermRepository formelTerme;

    @Autowired
    OverviewRepository uebersicht;

    @Autowired
    MessreihenBelege belege;

    @Autowired
    com.voltpilot.api.repo.ControlCertificationRepository steuerFreigaben;

    @Autowired
    com.voltpilot.api.repo.AdminFleetRepository adminFlotte;

    @Autowired
    com.voltpilot.api.repo.FleetMetricsRepository flottenMetriken;

    @Autowired
    com.voltpilot.api.repo.RolloutRepository ota;

    @Autowired
    com.voltpilot.api.repo.EdgeVersionRepository edgeVersionen;

    @Autowired
    com.voltpilot.api.repo.AdminEnrollmentRepository adminEnrollment;

    @Autowired
    com.voltpilot.api.repo.AdminProvisionedDeviceRepository adminRegistry;

    @Autowired
    com.voltpilot.api.chargers.ChargingConfigRepository ladeKonfiguration;

    @Autowired
    com.voltpilot.api.entities.EntityRegistryRepository registry;

    @Autowired
    DatenquelleRepository datenquellen;

    @Autowired
    com.voltpilot.api.enrollment.EnrollmentDeviceLookup enrollmentLookup;

    @Autowired
    com.voltpilot.api.repo.AssetRepository assets;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO = new Anrufer("demo", null);
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JsonNode referenz;
    private static JdbcTemplate root;

    /** Ein Kundenbereich mit AN-1: Box E-1 und die Komponenten K-3 … K-7 samt ihrer Mess-Selektion. */
    private record Werk(UUID tenant, Anrufer admin, UUID an1, UUID box, String ref, Map<String, UUID> komponenten) {
        UUID k(String kennzeichen) {
            return komponenten.get(kennzeichen);
        }
    }

    @BeforeAll
    static void ladeReferenz() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- A14 ------------------------------------------------------------------------------------

    /**
     * A14: Box E-1 wird abgemeldet („Gerät entfernen"). Die Werte von MS-01, MS-02, MS-05, MS-06 und
     * MS-07 bleiben und nennen die Box; die Box ist ausgebaut; Purge und das Entfernen der Anlage
     * sind gesperrt („Belege von 5 Messstellen") und schreiben nichts; eine ungebundene
     * Bestandsanlage lässt sich weiter entfernen.
     */
    @Test
    void a14_abmeldenVerliertKeinenWertUndBelegeSperrenPurgeUndAnlage() {
        Werk w = werk("A14");
        binden(w, "MS-01", "K-3", ENERGIE_BEZUG);
        binden(w, "MS-02", "K-3", ENERGIE_ABGABE);
        binden(w, "MS-05", "K-4", ENERGIE_BEZUG);
        binden(w, "MS-06", "K-5", ENERGIE_BEZUG);
        binden(w, "MS-07", "K-6", ENERGIE_BEZUG);
        aufzeichnen(w, w.box(), "K-3", ENERGIE_BEZUG);
        aufzeichnen(w, w.box(), "K-5", ENERGIE_BEZUG);
        Map<String, Long> vorher = aufzeichnungen(w.box());
        assertThat(vorher.values()).as("jede Tabelle trägt Zeilen der Box").allMatch(n -> n > 0);
        List<String> belege = List.of("MS-01", "MS-02", "MS-05", "MS-06", "MS-07");

        // Purge: abgelehnt mit Liste, kein Wasserzeichen, keine Zeile weniger.
        ResponseEntity<JsonNode> purge = rufe(HttpMethod.POST, "/api/v1/devices/" + w.box() + "/purge-data", w.admin());
        belegeImWeg(purge, belege, "Die Aufzeichnungen dieser Box sind Belege von 5 Messstellen");
        assertThat(root.queryForObject("SELECT data_purged_before FROM device WHERE id = ?", Timestamp.class, w.box()))
                .isNull();
        assertThat(aufzeichnungen(w.box())).isEqualTo(vorher);

        // Gerät entfernen: 204, die Box ist ausgebaut, kein Wert fehlt.
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.box(), w.admin()))).isEqualTo(204);
        assertThat(root.queryForMap("SELECT status, external_ref, ausgebaut_am IS NOT NULL AS ausgebaut FROM device "
                + "WHERE id = ?", w.box())).containsEntry("status", "ausgebaut").containsEntry("external_ref", w.ref())
                .containsEntry("ausgebaut", true);
        assertThat(aufzeichnungen(w.box())).as("Abmelden verliert keinen Wert").isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_sample s JOIN device d ON d.id = "
                + "s.device_id WHERE d.external_ref = ? AND s.entity_id IN (?, ?)", Long.class, w.ref(), w.k("K-3"),
                w.k("K-5"))).as("die Werte nennen die alte Box").isEqualTo(4);

        // Die Anlage (jetzt ohne angemeldete Box): abgelehnt mit derselben Liste, nichts geschrieben.
        long protokoll = anzahl("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?", w.tenant());
        ResponseEntity<JsonNode> anlage = rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an1(), w.admin());
        belegeImWeg(anlage, belege, "Die Messwerte dieser Anlage sind Belege von 5 Messstellen");
        assertThat(anzahl("SELECT count(*) FROM site WHERE id = ?", w.an1())).isOne();
        assertThat(aufzeichnungen(w.box())).isEqualTo(vorher);
        assertThat(anzahl("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?", w.tenant()))
                .isEqualTo(protokoll);

        // Eine ungebundene Bestandsanlage desselben Kundenbereichs: abmelden, dann entfernen — wie heute.
        UUID bestand = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Lager Nord') RETURNING id",
                UUID.class, w.tenant());
        UUID alteBox = box(w.tenant(), bestand, "VP-BOX-BESTAND-" + w.tenant());
        UUID zaehler = komponente(w.tenant(), bestand, alteBox, "Zähler Lager");
        auswahl(w.tenant(), bestand, alteBox, zaehler, ENERGIE_BEZUG);
        aufzeichnenRoh(w.tenant(), bestand, alteBox, zaehler, ENERGIE_BEZUG);
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + alteBox, w.admin()))).isEqualTo(204);
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/sites/" + bestand, w.admin()))).isEqualTo(204);
        assertThat(anzahl("SELECT count(*) FROM device_measurement_sample WHERE site_id = ?", bestand)).isZero();
        assertThat(anzahl("SELECT count(*) FROM device_measurement_selection WHERE site_id = ?", bestand)).isZero();
        assertThat(anzahl("SELECT count(*) FROM telemetry WHERE site_id = ?", bestand)).isZero();
        assertThat(anzahl("SELECT count(*) FROM device WHERE id = ?", alteBox)).isZero();
        assertThat(aufzeichnungen(w.box())).as("die gebundene Anlage bleibt unberührt").isEqualTo(vorher);
    }

    /** Ohne Messstellen läuft „Datenaufzeichnungen löschen" wie heute: Wasserzeichen, Telemetrie weg. */
    @Test
    void einPurgeOhneBelegeLaeuftWieHeute() {
        Werk w = werk("Purge ohne Belege");
        aufzeichnen(w, w.box(), "K-3", ENERGIE_BEZUG);
        ResponseEntity<JsonNode> purge = rufe(HttpMethod.POST, "/api/v1/devices/" + w.box() + "/purge-data", w.admin());
        assertThat(status(purge)).as(String.valueOf(purge.getBody())).isEqualTo(200);
        assertThat(root.queryForObject("SELECT data_purged_before FROM device WHERE id = ?", Timestamp.class, w.box()))
                .isNotNull();
        assertThat(anzahl("SELECT count(*) FROM telemetry WHERE device_id = ?", w.box())).isZero();
        assertThat(anzahl("SELECT count(*) FROM device_measurement_sample WHERE device_id = ?", w.box()))
                .as("die Messwert-Strecke war nie Teil des Purge").isEqualTo(2);
    }

    // ---- Der Abmelde-Weg tut sonst dasselbe ----------------------------------------------------

    @Test
    void abmeldenLoestDieTopologieUndDieKennungIstWiederAnmeldbar() {
        Werk w = werk("Topologie");
        root.update("UPDATE site SET lead_device_id = ? WHERE id = ?", w.box(), w.an1());
        UUID speicher = root.queryForObject("INSERT INTO asset (tenant_id, site_id, device_id, type, is_primary) "
                + "VALUES (?, ?, ?, 'battery', true) RETURNING id", UUID.class, w.tenant(), w.an1(), w.box());
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.box(), w.admin()))).isEqualTo(204);

        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE site_id = ? AND device_id IS NOT NULL", w.an1()))
                .isZero();
        assertThat(root.queryForObject("SELECT lead_device_id FROM site WHERE id = ?", UUID.class, w.an1())).isNull();
        assertThat(root.queryForObject("SELECT device_id FROM asset WHERE id = ?", UUID.class, speicher)).isNull();
        // Jede Geräte-Route: 404 — und die Liste kennt die Box nicht mehr.
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.box(), w.admin()))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.POST, "/api/v1/devices/" + w.box() + "/purge-data", w.admin()))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/devices/" + w.box() + "/measurement-selection", w.admin())))
                .isEqualTo(404);
        JsonNode liste = ok(rufe(HttpMethod.GET, "/api/v1/devices", w.admin()));
        List<String> ids = new ArrayList<>();
        liste.forEach(d -> ids.add(d.get("id").asText()));
        assertThat(ids).doesNotContain(w.box().toString());
        // Die Historie der ausgebauten Box bleibt lesbar.
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/devices/" + w.box() + "/measurement-selection/" + ENERGIE_BEZUG
                + "/history?range=24h", w.admin()))).isEqualTo(200);

        // Dieselbe Aufkleber-Kennung: eine neue Box, wie vorher.
        Map<String, Object> claim = new LinkedHashMap<>();
        claim.put("siteId", w.an1().toString());
        claim.put("externalRef", w.ref());
        ResponseEntity<JsonNode> neu = rufe(HttpMethod.POST, "/api/v1/devices/claim", w.admin(), claim);
        assertThat(status(neu)).as(String.valueOf(neu.getBody())).isEqualTo(201);
        assertThat(neu.getBody().get("id").asText()).isNotEqualTo(w.box().toString());
        assertThat(anzahl("SELECT count(*) FROM device WHERE external_ref = ?", w.ref())).isEqualTo(2);
    }

    @Test
    void mandantenzaun_fremdIst404UndNichtsAendertSich() {
        Werk w = werk("Zaun");
        binden(w, "MS-06", "K-5", ENERGIE_BEZUG);
        aufzeichnen(w, w.box(), "K-5", ENERGIE_BEZUG);
        Map<String, Long> vorher = aufzeichnungen(w.box());
        assertThat(status(rufe(HttpMethod.POST, "/api/v1/devices/" + w.box() + "/purge-data", DEMO))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.box(), DEMO))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an1(), DEMO))).isEqualTo(404);
        assertThat(aufzeichnungen(w.box())).isEqualTo(vorher);
        assertThat(anzahl("SELECT count(*) FROM device WHERE id = ? AND ausgebaut_am IS NULL", w.box())).isOne();
        // Die Belege eines fremden Kundenbereichs sind unsichtbar — die Liste verrät nichts.
        assertThat(als(DEMO_KUNDENBEREICH, () -> belege.derAnlage(w.an1()))).isEmpty();
        assertThat(als(DEMO_KUNDENBEREICH, () -> belege.derBox(w.box()))).isEmpty();
        assertThat(als(w.tenant(), () -> belege.derBox(w.box()))).extracting(MessreihenBelege.Beleg::kennzeichen)
                .containsExactly("MS-06");
    }

    // ---- Die Live-Flächen -------------------------------------------------------------------------

    /**
     * Box E-1 wird ausgebaut, eine Nachfolgerin liest dieselben Kanäle und denselben Ladepunkt. Je
     * Fläche: VORHER sieht sie die alte Box (die Probe beißt), NACHHER nur noch die Nachfolgerin —
     * und die Zeilen der alten Box sind weiter gespeichert.
     */
    @Test
    void jeLiveFlaeche_dieAusgebauteBoxIstGespeichertAberNichtMehrAktiv() {
        Werk w = werk("Live");
        aufzeichnen(w, w.box(), "K-3", ENERGIE_BEZUG);
        // Eine berechnete Messstelle, deren einziger Eingang K-7 nur von der alten Box gelesen wird.
        UUID berechnet = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, 'MS-09', 'Halle 1 + Verwaltung nicht zugeordnet', "
                + "'berechnet', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class,
                w.tenant());
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, entity_id, "
                + "point_key, vorzeichen, faktor) VALUES (?, ?, 1, 'messkanal', ?, ?, '+', 1)", w.tenant(), berechnet,
                w.k("K-7"), ENERGIE_BEZUG);
        auswahl(w.tenant(), w.an1(), w.box(), w.k("K-7"), ENERGIE_BEZUG);

        // Vorher: jede Fläche sieht die Box.
        assertThat(als(w.tenant(), () -> ocppAktionen.target(w.an1(), LADEPUNKT))).get()
                .extracting(OcppActionRepository.StationTarget::deviceId).isEqualTo(w.box());
        assertThat(als(w.tenant(), () -> ocpp.stations(w.an1()))).extracting(OcppDto.Station::deviceId)
                .containsExactly(w.box());
        assertThat(als(w.tenant(), () -> formelTerme.stand(berechnet, LocalDate.now()).eingerichtet())).isTrue();
        assertThat(als(w.tenant(), () -> beobachtet.forSite(w.an1()))).extracting(r -> r.deviceId()).contains(w.box());
        assertThat(als(w.tenant(), () -> angewandt.forSite(w.an1()))).isNotNull();
        assertThat(komponentenFlotte.applyPerSite()).containsKey(w.an1());
        assertThat(als(w.tenant(), () -> uebersicht.latestLivePerSite())).containsKey(w.an1());
        assertThat(als(w.tenant(), () -> ocpp.transactions(w.an1(), 50))).hasSize(2);
        assertThat(als(w.tenant(), () -> ocpp.configurations(w.an1(), null))).extracting(OcppDto.Configuration::deviceId)
                .containsExactly(w.box());
        assertThat(als(w.tenant(), () -> messkanaele.messkanaele(w.an1(), w.k("K-3"), Instant.now()).messkanaele()))
                .extracting(MesskanalDto.Messkanal::lesendeBox).containsOnly(w.box());
        assertThat(als(w.tenant(), () -> formelWerte.quelle(w.k("K-3"), ENERGIE_BEZUG))).get()
                .extracting(MessstelleFormelWerteRepository.Quelle::deviceId).isEqualTo(w.box());

        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.box(), w.admin()))).isEqualTo(204);
        Map<String, Long> gespeichert = aufzeichnungen(w.box());
        UUID nachfolgerin = box(w.tenant(), w.an1(), "VP-BOX-2027-0090-" + w.tenant());

        // OCPP: Stationen, Befehlsziel, Konfiguration, Ladevorgänge.
        assertThat(als(w.tenant(), () -> ocpp.stations(w.an1()))).as("keine Station hinter der ausgebauten Box")
                .isEmpty();
        assertThat(als(w.tenant(), () -> ocppAktionen.target(w.an1(), LADEPUNKT))).as("kein Befehlsziel").isEmpty();
        assertThat(als(w.tenant(), () -> ocpp.configurations(w.an1(), null))).isEmpty();
        List<OcppDto.Transaction> vorgaenge = als(w.tenant(), () -> ocpp.transactions(w.an1(), 50));
        assertThat(vorgaenge).as("der beendete Ladevorgang bleibt Historie, der offene läuft nicht mehr")
                .extracting(OcppDto.Transaction::transactionId).containsExactly(1);
        ocppStation(w.tenant(), w.an1(), nachfolgerin);
        assertThat(als(w.tenant(), () -> ocpp.stations(w.an1()))).extracting(OcppDto.Station::deviceId)
                .containsExactly(nachfolgerin);
        assertThat(als(w.tenant(), () -> ocppAktionen.target(w.an1(), LADEPUNKT))).get()
                .extracting(OcppActionRepository.StationTarget::deviceId).isEqualTo(nachfolgerin);

        // Komponenten-Ist-Zustand und Soll/Ist.
        assertThat(als(w.tenant(), () -> beobachtet.forSite(w.an1()))).extracting(r -> r.deviceId())
                .doesNotContain(w.box());
        assertThat(als(w.tenant(), () -> angewandt.forSite(w.an1()))).as("unbekannt, nie der Stand der alten Box")
                .isNull();
        assertThat(komponentenFlotte.applyPerSite()).doesNotContainKey(w.an1());

        // Messkanal-Auswahl: Kanäle, Live-Wert-Quelle, Formel-Eingang.
        MesskanalDto.Liste kanaele = als(w.tenant(), () -> messkanaele.messkanaele(w.an1(), w.k("K-3"), Instant.now()));
        assertThat(kanaele.messkanaele()).as("keine Kanäle der ausgebauten Box").isEmpty();
        assertThat(als(w.tenant(), () -> formelTerme.stand(berechnet, LocalDate.now()).eingerichtet()))
                .as("K-7 liest niemand mehr").isFalse();
        auswahl(w.tenant(), w.an1(), nachfolgerin, w.k("K-3"), ENERGIE_BEZUG);
        assertThat(als(w.tenant(), () -> messkanaele.messkanaele(w.an1(), w.k("K-3"), Instant.now()).messkanaele()))
                .extracting(MesskanalDto.Messkanal::lesendeBox).containsExactly(nachfolgerin);
        assertThat(als(w.tenant(), () -> formelWerte.quelle(w.k("K-3"), ENERGIE_BEZUG))).get()
                .extracting(MessstelleFormelWerteRepository.Quelle::deviceId).isEqualTo(nachfolgerin);

        // Die Live-Karte der Übersicht: kein Schnappschuss der ausgebauten Box.
        assertThat(als(w.tenant(), () -> uebersicht.latestLivePerSite())).doesNotContainKey(w.an1());
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES (now() - interval "
                + "'4 hours', ?, ?, ?, 7.5)", w.tenant(), w.an1(), nachfolgerin);
        assertThat(als(w.tenant(), () -> uebersicht.latestLivePerSite())).as("auch ein älterer Wert der Nachfolgerin "
                + "geht vor dem jüngeren der ausgebauten Box").containsKey(w.an1());

        // Und alles bleibt gespeichert.
        assertThat(aufzeichnungen(w.box())).isEqualTo(gespeichert);
        assertThat(gespeichert.get("ocpp_transaction")).isEqualTo(2);
        assertThat(gespeichert.get("entity_observed_state")).isOne();
    }

    /**
     * Die Box-Listen und -Zugänge, die {@code device} lesen: VORHER ist die Box in jeder, NACHHER in
     * keiner — und ihre Zeile samt Kennung ist weiter gespeichert.
     */
    @Test
    void jeBoxListe_dieAusgebauteBoxIstNichtMehrDabei() {
        Werk w = werk("Box-Listen");
        root.update("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, power_kw) VALUES "
                + "(now() - interval '1 minute', now(), ?, ?, ?, 2.0)", w.tenant(), w.an1(), w.box());
        root.update("INSERT INTO device_edge_version (device_id, tenant_id, site_id, core_version, palette_version, "
                + "reported_at) VALUES (?, ?, ?, '2.7.1', '0.9.0', now())", w.box(), w.tenant(), w.an1());
        root.update("INSERT INTO device_enrollment (external_ref, csr_pem, device_id, cert_pem) VALUES (?, 'csr', ?, "
                + "'cert')", w.ref(), w.box());
        root.update("INSERT INTO provisioned_device (external_ref) VALUES (?)", w.ref());
        steuerFreigaben.activate(w.box(), "test", "Probe");
        UUID speicher = root.queryForObject("INSERT INTO asset (tenant_id, site_id, type, is_primary) VALUES (?, ?, "
                + "'battery', true) RETURNING id", UUID.class, w.tenant(), w.an1());

        // Vorher: die Box ist überall dabei (die Probe beißt).
        assertThat(steuerFreigaben.listActivations()).extracting(a -> a.deviceId()).contains(w.box());
        assertThat(steuerFreigaben.candidates()).extracting(c -> c.deviceId()).contains(w.box());
        assertThat(steuerFreigaben.allClaimedDevices()).extracting(d -> d.deviceId()).contains(w.box());
        assertThat(steuerFreigaben.claimedDevice(w.box())).isPresent();
        assertThat(adminFlotte.deviceStatsPerSite().get(w.an1()).deviceCount()).isOne();
        assertThat(als(w.tenant(), () -> uebersicht.deviceStatsPerSite()).get(w.an1()).deviceCount()).isOne();
        assertThat(flottenMetriken.lastTelemetryPerSite()).containsKey(w.an1());
        assertThat(ota.fleetDevices()).extracting(d -> d.deviceId()).contains(w.box());
        assertThat(als(w.tenant(), () -> edgeVersionen.findAll())).extracting(v -> v.deviceId()).contains(w.box());
        assertThat(adminEnrollment.findPending()).extracting(e -> e.externalRef()).doesNotContain(w.ref());
        assertThat(adminRegistry.find(w.ref())).get().extracting(r -> r.claimed()).isEqualTo(true);
        assertThat(als(w.tenant(), () -> ladeKonfiguration.deviceIds(w.an1()))).containsExactly(w.box());
        assertThat(als(w.tenant(), () -> registry.siteDeviceIds(w.an1()))).containsExactly(w.box());
        assertThat(als(w.tenant(), () -> datenquellen.boxen())).extracting(DatenquelleRepository.Box::id)
                .containsExactly(w.box());
        assertThat(enrollmentLookup.findByRef(w.ref())).isPresent();
        assertThat(enrollmentLookup.allEnrolledDeviceIdentities()).extracting(d -> d.deviceId()).contains(w.box());

        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.box(), w.admin()))).isEqualTo(204);

        assertThat(steuerFreigaben.listActivations()).extracting(a -> a.deviceId()).doesNotContain(w.box());
        assertThat(steuerFreigaben.candidates()).extracting(c -> c.deviceId()).doesNotContain(w.box());
        assertThat(steuerFreigaben.allClaimedDevices()).extracting(d -> d.deviceId()).doesNotContain(w.box());
        assertThat(steuerFreigaben.claimedDevice(w.box())).isEmpty();
        assertThat(adminFlotte.deviceStatsPerSite()).doesNotContainKey(w.an1());
        assertThat(als(w.tenant(), () -> uebersicht.deviceStatsPerSite())).doesNotContainKey(w.an1());
        assertThat(flottenMetriken.lastTelemetryPerSite()).doesNotContainKey(w.an1());
        assertThat(ota.fleetDevices()).extracting(d -> d.deviceId()).doesNotContain(w.box());
        assertThat(als(w.tenant(), () -> edgeVersionen.findAll())).extracting(v -> v.deviceId()).doesNotContain(w.box());
        assertThat(adminEnrollment.findPending()).as("ein Zertifikat ohne angemeldete Box").extracting(e -> e.externalRef())
                .contains(w.ref());
        assertThat(adminRegistry.find(w.ref())).get().extracting(r -> r.claimed()).as("wieder anmeldbar").isEqualTo(false);
        assertThat(als(w.tenant(), () -> ladeKonfiguration.deviceIds(w.an1()))).isEmpty();
        assertThat(als(w.tenant(), () -> registry.siteDeviceIds(w.an1()))).isEmpty();
        assertThat(als(w.tenant(), () -> datenquellen.boxen())).isEmpty();
        assertThat(enrollmentLookup.findByRef(w.ref())).as("keine Identität, keine ACL beim Start").isEmpty();
        assertThat(enrollmentLookup.allEnrolledDeviceIdentities()).extracting(d -> d.deviceId()).doesNotContain(w.box());
        assertThat(als(w.tenant(), () -> assets.autoLinkBatteryDevice(w.an1()))).as("kein Speicher an einer ausgebauten Box")
                .isFalse();
        assertThat(root.queryForObject("SELECT device_id FROM asset WHERE id = ?", UUID.class, speicher)).isNull();

        // Gespeichert bleibt alles.
        assertThat(anzahl("SELECT count(*) FROM device_control_activation WHERE device_id = ?", w.box())).isOne();
        assertThat(anzahl("SELECT count(*) FROM device_edge_version WHERE device_id = ?", w.box())).isOne();
        assertThat(anzahl("SELECT count(*) FROM device WHERE id = ? AND external_ref = ?", w.box(), w.ref())).isOne();
    }

    // ---- Gerüst: das Referenzunternehmen ------------------------------------------------------

    private Werk werk(String zusatz) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                referenz.at("/unternehmen/name").asText() + " · " + zusatz);
        JsonNode anlage = element(referenz.get("anlagen"), "AN-1");
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage.get("name").asText(), ts(anlage.get("seit")));
        JsonNode e1 = element(referenz.get("boxen"), "E-1");
        // Eine frei geformte Kennung (weder Aufkleber noch Edge-Prüfzeichen), damit dieselbe Hardware
        // im Test über die echte Anmelde-Route wieder angemeldet werden kann; der Name ist die Referenz.
        String ref = "box-halle-1-" + t;
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, created_at) "
                + "VALUES (?, ?, ?, ?, 'claimed', ?) RETURNING id", UUID.class, t, an1, ref,
                e1.get("name").asText() + " (" + e1.get("seriennummer").asText() + ")", ts(e1.get("in_betrieb_ab")));
        Map<String, UUID> komponenten = new LinkedHashMap<>();
        for (String k : List.of("K-3", "K-4", "K-5", "K-6", "K-7")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode geraet = element(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = element(referenz.get("datenquellen"), geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode().put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt()).put("unit_id", geraet.get("modbus_geraete_id").asInt());
            String art = "K-3".equals(k) ? "grid-meter" : "modbus-generic";
            komponenten.put(k, root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                    + "entity_type, device_id, control, communication, connection_json, created_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, false, 'modbus_tcp', ?::jsonb, ?) RETURNING id", UUID.class, t, an1,
                    art, komponente.get("name").asText(), art, box, verbindung.toString(),
                    ts(komponente.get("in_betrieb_ab"))));
        }
        Werk w = new Werk(t, new Anrufer("admin", t), an1, box, ref, komponenten);
        auswahl(t, an1, box, w.k("K-3"), ENERGIE_BEZUG);
        auswahl(t, an1, box, w.k("K-3"), ENERGIE_ABGABE);
        for (String k : List.of("K-4", "K-5", "K-6")) {
            auswahl(t, an1, box, w.k(k), ENERGIE_BEZUG);
        }
        return w;
    }

    /** Eine Messstelle der Referenz anlegen und ihre Hauptgröße ab dem Einbau an den Kanal binden. */
    private void binden(Werk w, String kennzeichen, String komponente, String kanal) {
        JsonNode ms = element(referenz.get("messstellen"), kennzeichen);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        body.put("hauptgroesse", groesseAus(ms.get("hauptgroesse")));
        List<JsonNode> neben = new ArrayList<>();
        ms.get("nebengroessen").forEach(n -> neben.add(groesseAus(n)));
        body.put("nebengroessen", neben);
        ResponseEntity<JsonNode> angelegt = rufe(HttpMethod.POST, "/api/v1/messstellen", w.admin(), body);
        assertThat(status(angelegt)).as(String.valueOf(angelegt.getBody())).isEqualTo(201);
        Map<String, Object> bindung = new LinkedHashMap<>();
        bindung.put("komponente", w.k(komponente).toString());
        bindung.put("kanal", kanal);
        bindung.put("rolle", "fuehrend");
        bindung.put("gueltig_ab", AB);
        ResponseEntity<JsonNode> gebunden = rufe(HttpMethod.POST, "/api/v1/messstellen/"
                + angelegt.getBody().get("id").asText() + "/quellen", w.admin(), bindung);
        assertThat(status(gebunden)).as(String.valueOf(gebunden.getBody())).isEqualTo(201);
    }

    /** Was eine Box aufzeichnet: v1-Telemetrie, alle OCPP-Tabellen, Messwert-Strecke, Zustand, Ereignis. */
    private void aufzeichnen(Werk w, UUID box, String komponente, String kanal) {
        UUID t = w.tenant();
        UUID site = w.an1();
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "(now() - interval '2 hours', ?, ?, ?, 3.1), (now() - interval '1 hour', ?, ?, ?, 3.3) "
                + "ON CONFLICT DO NOTHING", t, site, box, t, site, box);
        aufzeichnenRoh(t, site, box, w.k(komponente), kanal);
        if (anzahl("SELECT count(*) FROM ocpp_station WHERE device_id = ?", box) == 0) {
            ocppStation(t, site, box);
            String ereignis = UUID.randomUUID().toString();
            root.update("INSERT INTO ocpp_protocol_event (occurred_at, event_id, tenant_id, site_id, device_id, "
                    + "charge_point_id, direction, message_type, action, payload) VALUES (now(), ?::uuid, ?, ?, ?, ?, "
                    + "'internal', 'Event', 'Seed', '{}')", ereignis, t, site, box, LADEPUNKT);
            root.update("INSERT INTO ocpp_connector_status_event (occurred_at, event_id, tenant_id, site_id, device_id, "
                    + "charge_point_id, connector_id, status, error_code) VALUES (now(), ?::uuid, ?, ?, ?, ?, 1, "
                    + "'Charging', 'NoError')", ereignis, t, site, box, LADEPUNKT);
            root.update("INSERT INTO ocpp_authorization_event (occurred_at, event_id, tenant_id, site_id, device_id, "
                    + "charge_point_id, correlation_id, id_tag_ref) VALUES (now(), ?::uuid, ?, ?, ?, ?, 'seed', "
                    + "'tagref_halle')", ereignis, t, site, box, LADEPUNKT);
            // Ein beendeter (1) und ein offener (2) Ladevorgang.
            root.update("INSERT INTO ocpp_transaction (device_id, charge_point_id, transaction_id, tenant_id, site_id, "
                    + "connector_id, started_at, stopped_at, meter_start, meter_stop, start_id_tag_ref, "
                    + "transaction_data, updated_at) VALUES (?, ?, 1, ?, ?, 1, now() - interval '5 hours', "
                    + "now() - interval '4 hours', 100, 900, 'tagref_halle', '[]', now())", box, LADEPUNKT, t, site);
            root.update("INSERT INTO ocpp_transaction (device_id, charge_point_id, transaction_id, tenant_id, site_id, "
                    + "connector_id, started_at, meter_start, start_id_tag_ref, transaction_data, updated_at) "
                    + "VALUES (?, ?, 2, ?, ?, 1, now() - interval '30 minutes', 900, 'tagref_halle', '[]', now())",
                    box, LADEPUNKT, t, site);
            root.update("INSERT INTO ocpp_meter_sample (sampled_at, event_id, meter_value_index, sampled_value_index, "
                    + "tenant_id, site_id, device_id, charge_point_id, connector_id, source, point_key, measurand, "
                    + "context, value_format, phase, location, unit, value_text) VALUES (now(), ?::uuid, 0, 0, ?, ?, ?, "
                    + "?, 1, 'MeterValues', 'seed-point', 'Power.Active.Import', 'Sample.Periodic', 'Raw', 'L1', "
                    + "'Outlet', 'W', '1')", ereignis, t, site, box, LADEPUNKT);
            root.update("INSERT INTO ocpp_station_status_event (occurred_at, event_id, tenant_id, site_id, device_id, "
                    + "charge_point_id, status_kind, status) VALUES (now(), ?::uuid, ?, ?, ?, ?, 'diagnostics', 'Idle')",
                    ereignis, t, site, box, LADEPUNKT);
            root.update("INSERT INTO ocpp_configuration_key (device_id, charge_point_id, configuration_key, tenant_id, "
                    + "site_id, value, readonly, reported_at) VALUES (?, ?, 'MeterValueSampleInterval', ?, ?, '60', false, "
                    + "now())", box, LADEPUNKT, t, site);
            root.update("INSERT INTO ocpp_configuration_unknown_key (device_id, charge_point_id, configuration_key, "
                    + "tenant_id, site_id, reported_at) VALUES (?, ?, 'Vendor.Seed', ?, ?, now())", box, LADEPUNKT, t, site);
            root.update("INSERT INTO entity_observed_state (device_id, entity_id, tenant_id, site_id, source, "
                    + "entity_type, health, label) VALUES (?, ?, ?, ?, 'registry', 'grid-meter', 'ok', 'Netzzähler')",
                    box, w.k("K-3").toString(), t, site);
            root.update("INSERT INTO device_component_apply (device_id, tenant_id, site_id, authority, applied_revision, "
                    + "applied_at) VALUES (?, ?, ?, 'portal', 'r1', now())", box, t, site);
            root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, site_id, kennungen, "
                    + "device_id, nutzlast, aus_bestand) VALUES (now(), ?, ?, 'data_gap', 'box', ?, "
                    + "jsonb_build_object('box', ?::text), ?, '{\"erkannt_aus\":\"verdraengung\"}', true)", t,
                    UUID.randomUUID(), site, box.toString(), box);
        }
    }

    private static void ocppStation(UUID t, UUID site, UUID box) {
        root.update("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, connected, updated_at) "
                + "VALUES (?, ?, ?, ?, true, now())", box, LADEPUNKT, t, site);
        root.update("INSERT INTO ocpp_connector_state (device_id, charge_point_id, connector_id, tenant_id, site_id, "
                + "status, error_code, reported_at) VALUES (?, ?, 1, ?, ?, 'Charging', 'NoError', now())", box, LADEPUNKT,
                t, site);
        root.update("INSERT INTO ocpp_station_capability (device_id, charge_point_id, feature_profile, tenant_id, "
                + "site_id, reported_at) VALUES (?, ?, 'SmartCharging', ?, ?, now())", box, LADEPUNKT, t, site);
    }

    /** Zwei Rohwerte, ein Ereignis, der letzte Stand und ein Eintrag der Auswahl-Historie. */
    private static void aufzeichnenRoh(UUID t, UUID site, UUID box, UUID komponente, String kanal) {
        Instant jetzt = Instant.now().minusSeconds(600);
        for (int i = 0; i < 2; i++) {
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                    + "aggregation_kind, gap, dropped_samples, entity_id) VALUES (?, now(), ?, ?, ?, ?, 10005, 1000.5, "
                    + "'good', ?, ?, 'counter', false, 0, ?)", Timestamp.from(jetzt.plusSeconds(60L * i)), t, site, box,
                    kanal, KATALOG, System.nanoTime() % 1_000_000_000L + i, komponente);
        }
        root.update("INSERT INTO device_measurement_event (occurred_at, tenant_id, site_id, device_id, point_key, "
                + "event_kind, catalog_version, edge_sequence) VALUES (now(), ?, ?, ?, ?, 'state_change', ?, ?)", t, site,
                box, kanal, KATALOG, System.nanoTime() % 1_000_000_000L);
        root.update("INSERT INTO device_measurement_point_state (tenant_id, site_id, device_id, point_key, "
                + "first_read_at, last_read_at, edge_sequence, raw_numeric, quality, catalog_version) VALUES (?, ?, ?, ?, "
                + "now(), now(), 1, 10005, 'good', ?) ON CONFLICT DO NOTHING", t, site, box, kanal, KATALOG);
        root.update("INSERT INTO device_measurement_selection_event (tenant_id, site_id, device_id, point_key, "
                + "desired_revision, idempotency_key, requested_enabled, requested_cadence_s, enabled_at, "
                + "catalog_version, actor, apply_status, retention_class, raw_retention_days, long_term_strategy) "
                + "VALUES (?, ?, ?, ?, (SELECT count(*) + 1 FROM device_measurement_selection_event WHERE device_id = ?), "
                + "?, true, 60, now(), ?, 'test', 'pending_edge', 'energy_counter', 90, 'fifteen_minute')", t, site, box,
                kanal, box, UUID.randomUUID(), KATALOG);
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "(now() - interval '3 hours', ?, ?, ?, 1.0) ON CONFLICT DO NOTHING", t, site, box);
    }

    private static void auswahl(UUID t, UUID site, UUID box, UUID komponente, String kanal) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute') ON CONFLICT DO NOTHING", t, site, box, komponente,
                kanal, KATALOG);
    }

    private static UUID box(UUID t, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, site, ref);
    }

    private static UUID komponente(UUID t, UUID site, UUID box, String name) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, device_id, role, label, "
                + "entity_type) VALUES (?, ?, ?, 'grid-meter', ?, 'grid-meter') RETURNING id", UUID.class, t, site, box,
                name);
    }

    /** Die Zeilen der Box je Tabelle — der Vergleich vorher/nachher ist der Beweis „kein Wert fehlt". */
    private static Map<String, Long> aufzeichnungen(UUID box) {
        Map<String, Long> aus = new LinkedHashMap<>();
        for (String tabelle : AUFZEICHNUNGEN) {
            aus.put(tabelle, anzahl("SELECT count(*) FROM " + tabelle + " WHERE device_id = ?", box));
        }
        return aus;
    }

    private static void belegeImWeg(ResponseEntity<JsonNode> r, List<String> kennzeichen, String satz) {
        assertThat(status(r)).as(String.valueOf(r.getBody())).isEqualTo(409);
        assertThat(r.getBody().get("code").asText()).isEqualTo(BelegeImWeg.CODE);
        assertThat(r.getBody().get("message").asText()).startsWith(satz).contains("MS-01 Netzbezug Halle 1");
        List<String> liste = new ArrayList<>();
        r.getBody().get("messstellen").forEach(m -> {
            assertThat(m.get("id").asText()).isNotBlank();
            assertThat(m.get("name").asText()).isNotBlank();
            liste.add(m.get("kennzeichen").asText());
        });
        assertThat(liste).containsExactlyElementsOf(kennzeichen);
    }

    // ---- Gerüst: Anfragen -------------------------------------------------------------------------

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
        return rest.exchange(java.net.URI.create("http://localhost:" + port + pfad), methode, entity, JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        return r.getBody();
    }

    private static int status(ResponseEntity<JsonNode> r) {
        return r.getStatusCode().value();
    }

    private String token(String benutzer) {
        Token t = TOKENS.get(benutzer);
        if (t != null && System.currentTimeMillis() - t.geholt() < 5 * 60_000) {
            return t.wert();
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", benutzer);
        form.add("password", benutzer);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        String wert = (String) body.get("access_token");
        TOKENS.put(benutzer, new Token(wert, System.currentTimeMillis()));
        return wert;
    }

    // ---- Gerüst: Datenbank --------------------------------------------------------------------------

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static JsonNode groesseAus(JsonNode g) {
        ObjectNode n = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }

    private static Timestamp ts(JsonNode n) {
        return Timestamp.from(OffsetDateTime.parse(n.asText()).toInstant());
    }

}
