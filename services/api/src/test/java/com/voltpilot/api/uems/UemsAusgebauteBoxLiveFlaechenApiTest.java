package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.metrics.ConsumerMetrics;
import com.voltpilot.api.repo.AdminComponentFleetRepository;
import com.voltpilot.api.repo.AdminFleetRepository;
import com.voltpilot.api.repo.ConsumerMetricsRepository;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
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
 * Das Folgepaket der Löschwege (UEMS AP-07 IP-11): die 19 Live-Leser auf Herzschlag-Tabellen OHNE
 * Fremdschlüssel auf die Box. Das Abmelden hat diese Tabellen nie geräumt — die Flächen zeigten eine
 * abgemeldete Box also schon vor IP-11 als aktuell. Ein bestehender Mangel, keine Regression.
 *
 * <p>Regel (Captain 13.09.2026: „Ich will, dass nichts verloren geht, wenn eine Box ausgetauscht
 * wird."): die Daten bleiben, aber eine ausgebaute Box erscheint auf keiner Live-Fläche als aktiv —
 * gefiltert über ihren ZUSTAND, nie durch Löschen.
 *
 * <p>Je Fläche aus der Kundensicht (die Route, wo es eine gibt, sonst derselbe Leser, den Route oder
 * Push rufen): VORHER zeigt sie die alte Box — die Probe beißt —, NACH dem Abmelden über die echte
 * Route nicht mehr; wo eine Nachfolgerin meldet, zeigt die Fläche sie, auch wenn die Zeile der alten
 * Box die jüngere ist oder nach Box-Kennung zuerst käme. Und jede Zeile der alten Box ist weiter
 * gespeichert. Nr. 19, der Befehlsverlauf: die offene Periode der alten Box wird beim Ausbau
 * BEENDET, nicht versteckt — sie bleibt im Verlauf.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class UemsAusgebauteBoxLiveFlaechenApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String LADEPUNKT = "CP-HALLE-1";

    /** Die Herzschlag-Tabellen, deren Zeilen einer Box das Abmelden nicht leeren darf. */
    private static final List<String> HERZSCHLAG = List.of("device_charging_budget", "device_charge_point",
            "device_charge_connector", "device_curtailment_status", "device_curtailment_unit",
            "device_control_status", "consumer_runtime_status", "device_source_status", "flow_device_ack",
            "flow_node_status", "device_edge_version", "device_update_status", "device_command_log");

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
    EntityRegistryRepository registry;

    @Autowired
    EntityRegistryService registryDienst;

    @Autowired
    AdminFleetRepository adminFlotte;

    @Autowired
    AdminComponentFleetRepository komponentenFlotte;

    @Autowired
    ConsumerMetricsRepository verbraucherMetriken;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JdbcTemplate root;

    /**
     * Ein Kundenbereich mit einer Anlage, der alten Box und ihrer Nachfolgerin. Die Kennung der alten
     * Box sortiert VOR der Nachfolgerin — ein Leser, der nach Box-Kennung die erste Zeile nimmt, träfe
     * ohne den Filter die alte.
     */
    private record Werk(UUID tenant, Anrufer admin, UUID site, UUID alt, UUID nach) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- Nr. 1–5: Ladepunkte ------------------------------------------------------------------------

    @Test
    void jeLadepunktFlaeche_dieAusgebauteBoxIstGespeichertAberNichtMehrAktiv() {
        Werk w = werk("Ladepunkte");
        UUID wallbox = komponente(w, "ev-charger", "Wallbox Halle 1");
        budget(w, w.alt(), 11.0, "{\"lastmanagement\":\"aktiv\"}");
        saeule(w, w.alt(), wallbox, "eigen", true, "tagref_0a1b2c3d");

        // Vorher: jede Fläche sieht die alte Box.
        JsonNode laden = ok(rufe(HttpMethod.GET, anlage(w) + "/chargers", w.admin()));
        assertThat(laden.at("/budget/deviceId").asText()).isEqualTo(w.alt().toString());
        assertThat(laden.at("/chargers/0/connectors/0/tagRef").asText()).isEqualTo("tagref_0a1b2c3d");
        assertThat(ok(rufe(HttpMethod.GET, anlage(w) + "/ocpp/control", w.admin())).at("/observed/0/deviceId")
                .asText()).isEqualTo(w.alt().toString());
        assertThat(verbindung(w, wallbox)).isEqualTo("eigen");
        assertThat(als(w.tenant(), () -> registry.chargePointIdsByEntity(w.site()))).containsEntry(wallbox, LADEPUNKT);
        assertThat(als(w.tenant(), () -> registryDienst.istGebundenerLadepunkt(w.site(), wallbox))).isTrue();
        assertThat(stationBox(w)).isEqualTo(w.alt().toString());

        Map<String, Long> gespeichert = abmelden(w);

        // Nachher: die alte Box lädt nirgends mehr, hat kein Budget, keinen Steuerstatus, keine Säule.
        laden = ok(rufe(HttpMethod.GET, anlage(w) + "/chargers", w.admin()));
        assertThat(leer(laden.path("budget"))).as("kein Budget - nie das der alten Box").isTrue();
        assertThat(laden.get("chargers")).as("keine Säule der alten Box, keine Karte „lädt gerade“").isEmpty();
        assertThat(ok(rufe(HttpMethod.GET, anlage(w) + "/ocpp/control", w.admin())).get("observed")).isEmpty();
        assertThat(verbindung(w, wallbox)).as("keine Verbindung Ladepunkt ↔ alte Box im Anlagenbild").isNull();
        assertThat(als(w.tenant(), () -> registry.chargePointIdsByEntity(w.site()))).as("Push/Steuerart").isEmpty();
        assertThat(als(w.tenant(), () -> registryDienst.istGebundenerLadepunkt(w.site(), wallbox))).isFalse();
        assertThat(stationBox(w)).as("die alte Box ist keine Station-Box mehr").isNull();

        // Die Nachfolgerin meldet dieselbe Säule an derselben Komponente — ihr Budget geht vor, obwohl die
        // alte Box nach Kennung zuerst käme (get(0)), und ihr Stecker lädt nicht.
        budget(w, w.nach(), 22.0, "{\"lastmanagement\":\"inaktiv\"}");
        saeule(w, w.nach(), wallbox, "haus", false, null);
        laden = ok(rufe(HttpMethod.GET, anlage(w) + "/chargers", w.admin()));
        assertThat(laden.at("/budget/deviceId").asText()).isEqualTo(w.nach().toString());
        assertThat(laden.at("/budget/budgetKw").asDouble()).isEqualTo(22.0);
        assertThat(laden.get("chargers")).hasSize(1);
        assertThat(laden.at("/chargers/0/deviceId").asText()).isEqualTo(w.nach().toString());
        assertThat(laden.at("/chargers/0/connectors/0/charging").asBoolean()).isFalse();
        assertThat(leer(laden.at("/chargers/0/connectors/0/tagRef"))).isTrue();
        JsonNode beobachtet = ok(rufe(HttpMethod.GET, anlage(w) + "/ocpp/control", w.admin())).get("observed");
        assertThat(beobachtet).hasSize(1);
        assertThat(beobachtet.at("/0/deviceId").asText()).isEqualTo(w.nach().toString());
        assertThat(verbindung(w, wallbox)).isEqualTo("haus");
        assertThat(stationBox(w)).as("genau EINE Station - die der Nachfolgerin").isEqualTo(w.nach().toString());

        assertThat(zeilen(w.alt())).isEqualTo(gespeichert);
        assertThat(gespeichert.get("device_charge_connector")).isOne();
    }

    // ---- Nr. 6–10 und 19: Steuerung, Abregelung, Befehlsverlauf ------------------------------------

    @Test
    void jeSteuerFlaeche_dieAusgebauteBoxIstGespeichertAberNichtMehrAktivUndIhrLaufenEndet() {
        Werk w = werk("Steuerung");
        Werk fremd = werk("Steuerung fremd");
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        steuerstatus(w, w.alt(), jetzt.minusSeconds(60));
        steuerstatus(w, w.nach(), jetzt.minusSeconds(600));
        abregelung(w, w.alt(), jetzt.minusSeconds(60), "wr-alt");
        abregelung(w, w.nach(), jetzt.minusSeconds(600), "wr-nach");
        // Eine vor IP-11 abgemeldete Box: ihre Zeile in device gibt es nicht mehr, ihr Bericht ist der jüngste.
        UUID geloescht = UUID.randomUUID();
        steuerstatus(w, geloescht, jetzt);
        abregelung(w, geloescht, jetzt, "wr-geloescht");
        long laeuft = periode(w, w.alt(), "batterie", jetzt.minusSeconds(1800), null, jetzt.minusSeconds(120));
        long vorbei = periode(w, w.alt(), "abregelung", jetzt.minusSeconds(3000), jetzt.minusSeconds(2400),
                jetzt.minusSeconds(2400));
        long laeuftNach = periode(w, w.nach(), "batterie", jetzt.minusSeconds(300), null, jetzt.minusSeconds(30));
        long laeuftFremd = periode(fremd, fremd.alt(), "batterie", jetzt.minusSeconds(1800), null,
                jetzt.minusSeconds(120));

        // Vorher: der jüngste Bericht einer vorhandenen Box ist der der alten Box.
        assertThat(ok(rufe(HttpMethod.GET, anlage(w) + "/control-status", w.admin())).get("deviceId").asText())
                .isEqualTo(w.alt().toString());
        JsonNode abgeregelt = ok(rufe(HttpMethod.GET, anlage(w) + "/curtailment-status", w.admin()));
        assertThat(abgeregelt.get("deviceId").asText()).isEqualTo(w.alt().toString());
        assertThat(abgeregelt.at("/perUnit/0/sourceId").asText()).isEqualTo("wr-alt");
        assertThat(adminFlotte.controlPerSite().get(w.site()).deviceId()).isEqualTo(w.alt());
        assertThat(adminFlotte.curtailmentPerSite().get(w.site()).deviceId()).isEqualTo(w.alt());
        assertThat(komponentenFlotte.controlPerSite().get(w.site()).checkedAt()).isEqualTo(jetzt.minusSeconds(60));
        JsonNode verlauf = verlauf(w);
        assertThat(leer(eintrag(verlauf, laeuft).path("endedAt"))).as("die Anweisung der alten Box läuft").isTrue();
        assertThat(verlauf.at("/control/deviceId").asText()).isEqualTo(w.alt().toString());

        // Der Mandantenzaun: ein fremder Kundenbereich baut die Box nicht aus und beendet nichts.
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.alt(), fremd.admin()))).isEqualTo(404);
        assertThat(endeInDerDatenbank(laeuft)).isNull();

        Map<String, Long> gespeichert = abmelden(w);

        // Nachher: jede Fläche zeigt die Nachfolgerin, obwohl ihr Bericht der ältere ist.
        assertThat(ok(rufe(HttpMethod.GET, anlage(w) + "/control-status", w.admin())).get("deviceId").asText())
                .isEqualTo(w.nach().toString());
        abgeregelt = ok(rufe(HttpMethod.GET, anlage(w) + "/curtailment-status", w.admin()));
        assertThat(abgeregelt.get("deviceId").asText()).isEqualTo(w.nach().toString());
        assertThat(abgeregelt.at("/perUnit/0/sourceId").asText()).isEqualTo("wr-nach");
        assertThat(adminFlotte.controlPerSite().get(w.site()).deviceId()).isEqualTo(w.nach());
        assertThat(adminFlotte.curtailmentPerSite().get(w.site()).deviceId()).isEqualTo(w.nach());
        assertThat(komponentenFlotte.controlPerSite().get(w.site()).checkedAt()).isEqualTo(jetzt.minusSeconds(600));

        // Nr. 19: die offene Periode der alten Box ist BEENDET - an ihrem letzten Beleg, und sie bleibt im Verlauf.
        verlauf = verlauf(w);
        assertThat(verlauf.at("/control/deviceId").asText()).isEqualTo(w.nach().toString());
        assertThat(verlauf.at("/curtailment/deviceId").asText()).isEqualTo(w.nach().toString());
        assertThat(leer(eintrag(verlauf, laeuft).path("endedAt"))).as("die Anweisung der alten Box läuft nicht mehr")
                .isFalse();
        assertThat(Instant.parse(eintrag(verlauf, laeuft).get("endedAt").asText()))
                .as("beendet am letzten Herzschlag").isEqualTo(jetzt.minusSeconds(120));
        assertThat(Instant.parse(eintrag(verlauf, laeuft).get("startedAt").asText())).isEqualTo(jetzt.minusSeconds(1800));
        assertThat(Instant.parse(eintrag(verlauf, vorbei).get("endedAt").asText())).isEqualTo(jetzt.minusSeconds(2400));
        assertThat(leer(eintrag(verlauf, laeuftNach).path("endedAt"))).as("die Nachfolgerin läuft weiter").isTrue();
        assertThat(endeInDerDatenbank(laeuftFremd)).as("der fremde Kundenbereich bleibt unberührt").isNull();

        assertThat(zeilen(w.alt())).isEqualTo(gespeichert);
        assertThat(gespeichert.get("device_command_log")).isEqualTo(2);
    }

    // ---- Nr. 11–14 und 20: Verbraucher und Datenquellen --------------------------------------------

    @Test
    void jeVerbraucherUndQuellenFlaeche_dieAusgebauteBoxIstGespeichertAberNichtMehrAktiv() {
        Werk w = werk("Verbraucher");
        UUID heizstab = komponente(w, "heating-rod", "Heizstab Lager");
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES (?, ?, ?, 'on_off', 3.0)", heizstab, w.tenant(), w.site());
        laufzeit(w, w.alt(), heizstab, "on", "ausbau-probe-" + w.tenant());
        quelle(w, w.alt(), "inverter", "primary", "ok");
        quelle(w, w.alt(), "src-heizstab", "source", "ok");

        // Vorher.
        assertThat(entitaeten(ok(rufe(HttpMethod.GET, anlage(w) + "/consumer-status", w.admin()))))
                .containsExactly(heizstab.toString());
        assertThat(status(rufe(HttpMethod.GET, anlage(w) + "/consumers/" + heizstab + "/status", w.admin())))
                .isEqualTo(200);
        assertThat(texte(ok(rufe(HttpMethod.GET, anlage(w) + "/sources", w.admin())), "deviceId"))
                .containsOnly(w.alt().toString()).hasSize(2);
        assertThat(texte(ok(rufe(HttpMethod.GET, anlage(w) + "/consumer-options", w.admin())).get("reportedSources"),
                "sourceId")).containsExactly("src-heizstab");
        assertThat(adminFlotte.sourceCountsPerSite().get(w.site()).total()).isEqualTo(2);
        assertThat(metrikGrund(w)).as("Metrik: der Heizstab ist bestätigt „an“").isTrue();

        Map<String, Long> gespeichert = abmelden(w);

        // Nachher: kein Laufzeitstatus, keine Quelle, kein Zähler aus der alten Box.
        assertThat(ok(rufe(HttpMethod.GET, anlage(w) + "/consumer-status", w.admin()))).isEmpty();
        assertThat(status(rufe(HttpMethod.GET, anlage(w) + "/consumers/" + heizstab + "/status", w.admin())))
                .as("Zustand nicht bestätigt - nie der der alten Box").isEqualTo(204);
        assertThat(ok(rufe(HttpMethod.GET, anlage(w) + "/sources", w.admin()))).isEmpty();
        assertThat(ok(rufe(HttpMethod.GET, anlage(w) + "/consumer-options", w.admin())).get("reportedSources"))
                .isEmpty();
        assertThat(adminFlotte.sourceCountsPerSite()).doesNotContainKey(w.site());
        assertThat(metrikGrund(w)).isFalse();

        // Die Nachfolgerin meldet dieselbe Quelle — nur sie zählt.
        quelle(w, w.nach(), "src-heizstab", "source", "stale");
        JsonNode quellen = ok(rufe(HttpMethod.GET, anlage(w) + "/sources", w.admin()));
        assertThat(texte(quellen, "deviceId")).containsExactly(w.nach().toString());
        assertThat(adminFlotte.sourceCountsPerSite().get(w.site()).stale()).isOne();
        assertThat(adminFlotte.sourceCountsPerSite().get(w.site()).total()).isOne();

        assertThat(zeilen(w.alt())).isEqualTo(gespeichert);
        assertThat(gespeichert.get("device_source_status")).isEqualTo(2);
        assertThat(gespeichert.get("consumer_runtime_status")).isOne();
    }

    // ---- Nr. 15–18: Flows und Software-Stand -------------------------------------------------------

    @Test
    void jeFlowUndSoftwareFlaeche_dieAusgebauteBoxIstGespeichertAberNichtMehrAktiv() {
        Werk w = werk("Flows");
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        UUID flow = UUID.randomUUID();
        root.update("INSERT INTO flow_device_ack (device_id, flow_id, tenant_id, site_id, flow_version, state, "
                + "reported_at) VALUES (?, ?, ?, ?, 3, 'active', now())", w.alt(), flow, w.tenant(), w.site());
        root.update("INSERT INTO flow_node_status (device_id, flow_id, node_id, tenant_id, site_id, state, "
                + "reported_at) VALUES (?, ?, 'n1', ?, ?, 'active', now())", w.alt(), flow, w.tenant(), w.site());
        softwarestand(w, w.alt(), "2.7.1", "edge-2026.08.0", jetzt);

        // Vorher.
        JsonNode live = ok(rufe(HttpMethod.GET, "/api/v1/sites/" + w.site() + "/flow-node-status", w.admin()));
        assertThat(live.get("acks")).hasSize(1);
        assertThat(live.get("nodes")).hasSize(1);
        assertThat(adminFlotte.edgeVersionPerSite().get(w.site()).coreVersion()).isEqualTo("2.7.1");
        assertThat(adminFlotte.updateStatusPerSite().get(w.site()).version()).isEqualTo("edge-2026.08.0");

        Map<String, Long> gespeichert = abmelden(w);

        // Nachher: kein Flow „auf der Box aktiv“, kein Knoten grün, kein Software-Stand der alten Box.
        live = ok(rufe(HttpMethod.GET, "/api/v1/sites/" + w.site() + "/flow-node-status", w.admin()));
        assertThat(live.get("acks")).isEmpty();
        assertThat(live.get("nodes")).isEmpty();
        assertThat(adminFlotte.edgeVersionPerSite()).doesNotContainKey(w.site());
        assertThat(adminFlotte.updateStatusPerSite()).doesNotContainKey(w.site());

        // Die Nachfolgerin meldet einen ÄLTEREN Stand — er ist der Stand der Anlage.
        softwarestand(w, w.nach(), "2.8.0", "edge-2026.09.0", jetzt.minusSeconds(3600));
        assertThat(adminFlotte.edgeVersionPerSite().get(w.site()).coreVersion()).isEqualTo("2.8.0");
        assertThat(adminFlotte.updateStatusPerSite().get(w.site()).version()).isEqualTo("edge-2026.09.0");

        assertThat(zeilen(w.alt())).isEqualTo(gespeichert);
        assertThat(gespeichert.get("flow_node_status")).isOne();
    }

    // ---- Gerüst: Bestand ------------------------------------------------------------------------------

    private Werk werk(String zusatz) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Kunststoffwerk Ahrenberg GmbH · " + zusatz);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg') RETURNING id",
                UUID.class, t);
        String rest = UUID.randomUUID().toString().substring(8);
        UUID alt = UUID.fromString("00000000" + rest);
        UUID nach = UUID.fromString("ffffffff" + rest);
        for (UUID box : List.of(alt, nach)) {
            root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, ?, 'claimed')",
                    box, t, site, "box-" + box);
        }
        return new Werk(t, new Anrufer("admin", t), site, alt, nach);
    }

    private static UUID komponente(Werk w, String art, String name) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type) "
                + "VALUES (?, ?, ?, ?, ?) RETURNING id", UUID.class, w.tenant(), w.site(), art, name, art);
    }

    private static void budget(Werk w, UUID box, double budgetKw, String ocppStatus) {
        root.update("INSERT INTO device_charging_budget (device_id, tenant_id, site_id, enabled, budget_kw, "
                + "ocpp_control_status, reported_at) VALUES (?, ?, ?, true, ?, ?::jsonb, now())", box, w.tenant(),
                w.site(), budgetKw, ocppStatus);
    }

    private static void saeule(Werk w, UUID box, UUID komponente, String anschluss, boolean laedt, String karte) {
        root.update("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, connected, "
                + "connection, entity_id, reported_at) VALUES (?, ?, ?, ?, true, ?, ?, now())", box, LADEPUNKT,
                w.tenant(), w.site(), anschluss, komponente);
        root.update("INSERT INTO device_charge_connector (device_id, charge_point_id, connector_id, tenant_id, site_id, "
                + "status, charging, tag_ref, reported_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, now())", box, LADEPUNKT,
                w.tenant(), w.site(), laedt ? "Charging" : "Available", laedt, karte);
    }

    private static void steuerstatus(Werk w, UUID box, Instant geprueft) {
        root.update("INSERT INTO device_control_status (device_id, tenant_id, site_id, commanded_kw, confirmed_kw, "
                + "all_match, control_enabled, certified, cert_source, checked_at) VALUES (?, ?, ?, -4.0, -4.0, true, "
                + "true, true, 'platform', ?)", box, w.tenant(), w.site(), Timestamp.from(geprueft));
    }

    private static void abregelung(Werk w, UUID box, Instant geprueft, String einheit) {
        root.update("INSERT INTO device_curtailment_status (device_id, tenant_id, site_id, units, certified_units, "
                + "control_enabled, active, possible_override, checked_at) VALUES (?, ?, ?, 1, 1, true, true, false, ?)",
                box, w.tenant(), w.site(), Timestamp.from(geprueft));
        root.update("INSERT INTO device_curtailment_unit (device_id, source_id, tenant_id, site_id, certified) "
                + "VALUES (?, ?, ?, ?, true)", box, einheit, w.tenant(), w.site());
    }

    private static long periode(Werk w, UUID box, String strom, Instant beginn, Instant ende, Instant zuletzt) {
        return root.queryForObject("INSERT INTO device_command_log (tenant_id, site_id, device_id, stream, kind, "
                + "started_at, ended_at, last_seen_at, mode, commanded_kw_first, source) VALUES (?, ?, ?, ?, 'periode', "
                + "?, ?, ?, 'halten', -4.0, 'cloud_abgeleitet') RETURNING id", Long.class, w.tenant(), w.site(), box,
                strom, Timestamp.from(beginn), ende == null ? null : Timestamp.from(ende), Timestamp.from(zuletzt));
    }

    private static void laufzeit(Werk w, UUID box, UUID komponente, String zustand, String grund) {
        root.update("INSERT INTO consumer_runtime_status (entity_id, tenant_id, site_id, device_id, state, reason_code, "
                + "confirmed, reported_at) VALUES (?, ?, ?, ?, ?, ?, true, now())", komponente, w.tenant(), w.site(), box,
                zustand, grund);
    }

    private static void quelle(Werk w, UUID box, String kennung, String art, String gesundheit) {
        root.update("INSERT INTO device_source_status (device_id, source_id, tenant_id, site_id, kind, role, label, "
                + "load_kw, health, reported_at) VALUES (?, ?, ?, ?, ?, 'consumer', ?, 2.0, ?, now())", box, kennung,
                w.tenant(), w.site(), art, kennung, gesundheit);
    }

    private static void softwarestand(Werk w, UUID box, String core, String version, Instant gemeldet) {
        root.update("INSERT INTO device_edge_version (device_id, tenant_id, site_id, core_version, palette_version, "
                + "reported_at) VALUES (?, ?, ?, ?, '0.9.0', ?)", box, w.tenant(), w.site(), core,
                Timestamp.from(gemeldet));
        root.update("INSERT INTO device_update_status (device_id, tenant_id, site_id, version, backend, current_version, "
                + "state, reported_at) VALUES (?, ?, ?, ?, 'compose', ?, 'idle', ?)", box, w.tenant(), w.site(), version,
                version, Timestamp.from(gemeldet));
    }

    /** Die alte Box über die echte Route abmelden; zurück kommen ihre Zeilen je Herzschlag-Tabelle von VORHER. */
    private Map<String, Long> abmelden(Werk w) {
        Map<String, Long> vorher = zeilen(w.alt());
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.alt(), w.admin()))).isEqualTo(204);
        assertThat(root.queryForObject("SELECT ausgebaut_am IS NOT NULL FROM device WHERE id = ?", Boolean.class,
                w.alt())).isTrue();
        return vorher;
    }

    /** Die Zeilen der Box je Herzschlag-Tabelle — gleich vorher/nachher heißt: nichts ist verloren. */
    private static Map<String, Long> zeilen(UUID box) {
        Map<String, Long> aus = new LinkedHashMap<>();
        for (String tabelle : HERZSCHLAG) {
            aus.put(tabelle, root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE device_id = ?",
                    Long.class, box));
        }
        return aus;
    }

    private static Instant endeInDerDatenbank(long periode) {
        Timestamp ende = root.queryForObject("SELECT ended_at FROM device_command_log WHERE id = ?", Timestamp.class,
                periode);
        return ende == null ? null : ende.toInstant();
    }

    // ---- Gerüst: Kundensicht --------------------------------------------------------------------------

    private static String anlage(Werk w) {
        return "/api/v1/sites/" + w.site();
    }

    /** Die Verbindung der Säule im Anlagenbild ({@code GET …/topology}). */
    private String verbindung(Werk w, UUID komponente) {
        for (JsonNode e : ok(rufe(HttpMethod.GET, anlage(w) + "/topology", w.admin())).get("entities")) {
            if (komponente.toString().equals(e.get("id").asText())) {
                return leer(e.path("connection")) ? null : e.get("connection").asText();
            }
        }
        throw new AssertionError("Komponente fehlt im Anlagenbild: " + komponente);
    }

    /** Die Box der Ladepunkt-Station in der Vorschlagsliste der Datenquellen, oder {@code null}. */
    private String stationBox(Werk w) {
        JsonNode liste = ok(rufe(HttpMethod.GET, anlage(w) + "/data-sources/vorschlag", w.admin()));
        for (JsonNode v : liste.get("vorschlaege")) {
            if ("ocpp".equals(v.path("protokoll").asText())) {
                return v.at("/box/id").asText();
            }
        }
        return null;
    }

    private JsonNode verlauf(Werk w) {
        return ok(rufe(HttpMethod.GET, anlage(w) + "/command-history?range=week", w.admin()));
    }

    private static JsonNode eintrag(JsonNode verlauf, long id) {
        for (JsonNode e : verlauf.get("entries")) {
            if (e.path("id").asLong() == id) {
                return e;
            }
        }
        throw new AssertionError("Periode " + id + " fehlt im Verlauf: " + verlauf.get("entries"));
    }

    private boolean metrikGrund(Werk w) {
        String grund = "ausbau-probe-" + w.tenant();
        return verbraucherMetriken.consumers().stream().map(ConsumerMetrics.ConsumerRow::reasonCode)
                .anyMatch(grund::equals);
    }

    private static boolean leer(JsonNode n) {
        return n.isNull() || n.isMissingNode();
    }

    private static List<String> entitaeten(JsonNode liste) {
        return texte(liste, "entityId");
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(e -> aus.add(e.get(feld).asText()));
        return aus;
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token(wer.benutzer()));
        if (wer.kundenbereich() != null) {
            headers.set("X-Tenant-Id", wer.kundenbereich().toString());
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        return rest.exchange(java.net.URI.create("http://localhost:" + port + pfad), methode,
                new HttpEntity<>(headers), JsonNode.class);
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

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }
}
