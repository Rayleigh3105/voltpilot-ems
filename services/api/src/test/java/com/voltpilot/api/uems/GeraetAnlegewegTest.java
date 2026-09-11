package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.SQLException;
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
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Anlege-Weg des Geräts (UEMS AP-04 IP-10, Nacharbeit; Migration V20260911240000) Ende zu
 * Ende gegen echtes Keycloak + TimescaleDB: jede NEU angelegte gerätetragende Komponente hat
 * nach dem Commit genau ein laufendes Gerät — genau das, das die Bestands-Ableitung
 * {@code uems_geraete_ableiten()} ihr gäbe.
 *
 * <p>Bewiesen wird je öffentlicher Route hinter den fünf Anlege-Stellen
 * ({@code EntityRegistryRepository.createBatteryHybridPoint / createComposedPoint /
 * createEntityPoint / createAdoptedPoint}, {@code MeasurementPointRepository.create}): genau ein
 * laufendes Gerät je Komponente, danach legt die Bestands-Ableitung als Eigner NICHTS mehr an
 * (der Beweis „eine Regel"). Dazu: die Geschwister eines Hybrid-Wechselrichters hängen in beiden
 * Anlege-Reihenfolgen einer Transaktion an seinem Einbau; die Regel läuft unter der RLS der
 * App-Rolle und tut für einen fremden Kundenbereich nichts; die Bestands-Ableitung bleibt der
 * App-Rolle verwehrt; Löschen nimmt nur die Speisung mit; das Messkanal-Read-Model zeigt das
 * Gerät einer neuen und einer Bestandskomponente und {@code null} ohne laufende Speisung.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class GeraetAnlegewegTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String GENERIC = "builtin:generic_modbus:sunspec";
    private static final ObjectMapper MAPPER = new ObjectMapper();

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

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    /** Die App-Rolle unter RLS (TenantAwareDataSource) — dieselbe, die jede Route benutzt. */
    @Autowired
    JdbcTemplate app;

    @Autowired
    PlatformTransactionManager transaktionen;

    @Autowired
    ComponentConnectionReceipts receipts;

    private static final Map<String, String> TOKENS = new ConcurrentHashMap<>();
    /** Der Eigner der Migrationen (ohne RLS) — er ruft die Bestands-Ableitung. */
    private static JdbcTemplate root;

    /** Ein Kundenbereich mit einer Anlage. */
    private record Kunde(UUID tenant, UUID site) {}

    @BeforeAll
    static void eigner() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- MeasurementPointRepository.create -----------------------------------------------

    /** Die Messpunkt-Route: jede neue Quelle bekommt ihr eigenes Gerät nach der Regel. */
    @Test
    void dieMesspunktRouteGibtJederNeuenQuelleIhrGeraet() {
        Kunde k = neuerKunde("Anlegeweg Messpunkt");
        ok(post("/api/v1/sites/" + k.site() + "/measurement-points", Map.of("role", "pv-generation",
                "label", "Carport", "brand", " SMA ", "model", "Sunny Tripower 10.0", "capacityKwp", 10), k));
        ok(post("/api/v1/sites/" + k.site() + "/measurement-points",
                Map.of("role", "consumer", "label", "Sauna"), k));

        Map<String, Object> carport = geraetVon(komponente(k, "Carport"));
        assertThat(carport.get("geraeteart")).isEqualTo("wechselrichter");
        assertThat(carport.get("hersteller")).isEqualTo("SMA");
        assertThat(carport.get("typ")).isEqualTo("Sunny Tripower 10.0");
        assertThat(carport.get("seriennummer")).as("nicht erhoben — nie erfunden").isNull();
        assertThat(carport.get("geraete_id")).isNull();
        assertThat(carport.get("kennzeichen")).isEqualTo("GR-1");
        assertThat(carport.get("einbau_kennzeichen")).isEqualTo("GR-1");
        assertThat(carport.get("aus_bestand")).as("eingebaut_am ist der Verlaufsbeginn").isEqualTo(true);
        assertThat(carport.get("created_by")).as("VoltPilot selbst").isNull();
        assertThat(carport.get("site_id")).isEqualTo(k.site());
        assertThat(carport.get("ausgebaut_am")).isNull();
        assertThat(carport.get("data_source_id")).isNull();
        assertThat(carport.get("bezeichnung")).isNull();
        assertThat(beginntMitDerAnlage(komponente(k, "Carport"))).isTrue();

        Map<String, Object> sauna = geraetVon(komponente(k, "Sauna"));
        assertThat(sauna.get("geraeteart")).isEqualTo("sonstiges");
        assertThat(sauna.get("kennzeichen")).isEqualTo("GR-2");
        nachlaufLegtNichtsAn();
    }

    // ---- createBatteryHybridPoint + createComposedPoint ----------------------------------

    /**
     * Claim und Bootstrap: der Hybrid-Wechselrichter und seine komponierten Geschwister
     * (Netzzähler, Hausverbrauch) sind EIN Gerät — mit dem Kennzeichen GR-1.
     */
    @Test
    void claimUndBootstrapGebenDemWechselrichterUndSeinenGeschwisternEinGeraet() {
        Kunde k = neuerKunde("Anlegeweg Hybrid");
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES (?, ?, 'battery', 10, 5, 5, 92)",
                k.tenant(), k.site());
        claim(k);
        ok(post("/api/v1/admin/sites/" + k.site() + "/v2-entities/bootstrap", Map.of(), k));

        Map<String, UUID> arten = arten(k);
        assertThat(arten).containsOnlyKeys("battery-hybrid", "grid-meter", "house-load");
        Map<String, Object> hybrid = geraetVon(arten.get("battery-hybrid"));
        assertThat(geraetVon(arten.get("grid-meter")).get("id")).isEqualTo(hybrid.get("id"));
        assertThat(geraetVon(arten.get("house-load")).get("id")).isEqualTo(hybrid.get("id"));
        assertThat(hybrid.get("geraeteart")).isEqualTo("wechselrichter");
        assertThat(hybrid.get("kennzeichen")).isEqualTo("GR-1");
        assertThat(geraete(k)).isOne();

        // Ein zweiter Bootstrap legt keine Komponente an — und also kein Gerät.
        ok(post("/api/v1/admin/sites/" + k.site() + "/v2-entities/bootstrap", Map.of(), k));
        assertThat(geraete(k)).isOne();
        nachlaufLegtNichtsAn();
    }

    /**
     * Ohne Speicher komponiert der Claim Netzzähler und Hausverbrauch allein — ohne
     * Wechselrichter wird nichts zusammengelegt. Kommt der Speicher SPÄTER, bekommt er sein
     * eigenes Gerät: die Regel sieht jeden Commit für sich und gruppiert nie um (das wäre ein
     * Austausch) — genau das täte auch die Bestands-Ableitung.
     */
    @Test
    void ohneSpeicherHatJederKomponierteZaehlerSeinGeraetUndEinSpaeterSpeicherBekommtEinEigenes() {
        Kunde k = neuerKunde("Anlegeweg ohne Speicher");
        claim(k);
        ok(post("/api/v1/admin/sites/" + k.site() + "/v2-entities/bootstrap", Map.of(), k));
        Map<String, UUID> arten = arten(k);
        assertThat(arten).containsOnlyKeys("grid-meter", "house-load");
        Map<String, Object> netz = geraetVon(arten.get("grid-meter"));
        Map<String, Object> haus = geraetVon(arten.get("house-load"));
        assertThat(netz.get("id")).isNotEqualTo(haus.get("id"));
        assertThat(netz.get("geraeteart")).isEqualTo("zaehler");
        assertThat(haus.get("geraeteart")).isEqualTo("sonstiges");

        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES (?, ?, 'battery', 10, 5, 5, 92)",
                k.tenant(), k.site());
        ok(post("/api/v1/admin/sites/" + k.site() + "/v2-entities/bootstrap", Map.of(), k));
        Map<String, Object> hybrid = geraetVon(arten(k).get("battery-hybrid"));
        assertThat(hybrid.get("id")).isNotIn(netz.get("id"), haus.get("id"));
        assertThat(geraetVon(arten.get("grid-meter")).get("id")).isEqualTo(netz.get("id"));
        assertThat(geraete(k)).isEqualTo(3);
        nachlaufLegtNichtsAn();
    }

    // ---- createEntityPoint + createAdoptedPoint -------------------------------------------

    /** Die Admin-Anlage eines Typs und die Übernahme einer gemeldeten Quelle. */
    @Test
    void dieAnlageEinesTypsUndDieUebernahmeEinerQuelleGebenJeEinGeraet() {
        Kunde k = neuerKunde("Anlegeweg Entitäten");
        JsonNode wallbox = ok(post("/api/v1/admin/sites/" + k.site() + "/v2-entities",
                Map.of("entityType", "wallbox", "label", "Wallbox Carport", "maxPowerKw", 11), k));
        Map<String, Object> lade = geraetVon(UUID.fromString(wallbox.get("id").asText()));
        assertThat(lade.get("geraeteart")).isEqualTo("ladestation");
        assertThat(lade.get("kennzeichen")).isEqualTo("GR-1");

        JsonNode dach = ok(post("/api/v1/admin/sites/" + k.site() + "/v2-entities/adopt",
                Map.of("sourceId", "src-anlegeweg-dach", "entityType", "producer", "label", "Dach Süd"), k));
        Map<String, Object> wr = geraetVon(UUID.fromString(dach.get("id").asText()));
        assertThat(wr.get("geraeteart")).isEqualTo("wechselrichter");
        assertThat(wr.get("kennzeichen")).isEqualTo("GR-2");
        nachlaufLegtNichtsAn();
    }

    // ---- MeasurementPointRepository.create über den Anlege-Assistenten -------------------

    /**
     * Der Anlege-Assistent schreibt die Anbindung erst NACH der Zeile, in derselben Transaktion —
     * das Gerät sieht den Endstand: die Geräte-ID 3 kommt aus der Verbindung.
     */
    @Test
    void derAssistentGibtDerKomponenteDasGeraetMitDerAnbindungAusDerselbenTransaktion() {
        Kunde k = neuerKunde("Anlegeweg Assistent");
        claim(k);
        Map<String, Object> verbindung = new LinkedHashMap<>();
        verbindung.put("ip", "192.168.0.41");
        verbindung.put("port", 502);
        verbindung.put("unit_id", 3);
        receipts.record(k.site(), GENERIC, 1, verbindung);
        ok(post("/api/v1/sites/" + k.site() + "/components",
                Map.of("templateRef", GENERIC, "role", "pv-generation", "connection", verbindung), k));

        UUID pv = root.queryForObject("SELECT id FROM measurement_point WHERE site_id = ? "
                + "AND brand = 'generic_modbus'", UUID.class, k.site());
        Map<String, Object> g = geraetVon(pv);
        assertThat(g.get("geraeteart")).isEqualTo("wechselrichter");
        assertThat(g.get("hersteller")).isEqualTo("generic_modbus");
        assertThat(g.get("typ")).isEqualTo("sunspec");
        assertThat(g.get("geraete_id")).isEqualTo(3);
        assertThat(g.get("seriennummer")).isNull();
        nachlaufLegtNichtsAn();
    }

    // ---- Die Gruppierung in einer Transaktion (App-Rolle) ---------------------------------

    /**
     * Zur Commit-Zeit, nicht beim INSERT: vor dem Commit gibt es noch kein Gerät, danach hängen
     * die Geschwister am Einbau ihres Wechselrichters — ob er vor oder nach ihnen angelegt wurde.
     * Das Gerät trägt in beiden Fällen die Angaben des Wechselrichters.
     */
    @Test
    void hybridGeschwisterHaengenInBeidenAnlegeReihenfolgenAmSelbenEinbau() {
        Kunde k = neuerKunde("Anlegeweg Reihenfolge");
        UUID boxA = box(k);
        UUID boxB = box(k);

        List<UUID> wZuerst = alsApp(k, () -> {
            UUID w = appKomponente(k, boxA, "battery-hybrid", "Deye", "SUN-12K-SG04LP3-EU");
            UUID s = appKomponente(k, boxA, "house-load", null, null);
            assertThat(app.queryForObject("SELECT count(*) FROM geraet", Long.class))
                    .as("vor dem Commit").isZero();
            return List.of(w, s);
        });
        List<UUID> geschwisterZuerst = alsApp(k, () -> {
            UUID s = appKomponente(k, boxB, "house-load", null, null);
            UUID n = appKomponente(k, boxB, "grid-meter", null, null);
            UUID w = appKomponente(k, boxB, "battery-hybrid", "Deye", "SUN-12K-SG04LP3-EU");
            return List.of(w, s, n);
        });

        for (List<UUID> gruppe : List.of(wZuerst, geschwisterZuerst)) {
            Map<String, Object> w = geraetVon(gruppe.get(0));
            for (UUID geschwister : gruppe.subList(1, gruppe.size())) {
                assertThat(geraetVon(geschwister).get("id")).isEqualTo(w.get("id"));
            }
            assertThat(w.get("geraeteart")).isEqualTo("wechselrichter");
            assertThat(w.get("hersteller")).isEqualTo("Deye");
            assertThat(w.get("typ")).isEqualTo("SUN-12K-SG04LP3-EU");
        }
        assertThat(geraete(k)).isEqualTo(2);
        nachlaufLegtNichtsAn();
    }

    // ---- Zaun und Rechte ------------------------------------------------------------------

    /**
     * Die Regel läuft als Aufrufer unter der RLS: für die Komponente eines fremden
     * Kundenbereichs tut sie nichts, und was sie im eigenen anlegt, sieht kein anderer. Die
     * Schleife über alle Mandanten bleibt der App-Rolle verwehrt; die Bestandskomponente holt
     * der Eigner nach derselben Regel nach.
     */
    @Test
    void dieRegelLaeuftUnterDerRlsUndDieBestandsAbleitungBleibtDemEigner() {
        Kunde a = neuerKunde("Anlegeweg Zaun A");
        Kunde b = neuerKunde("Anlegeweg Zaun B");
        UUID fremd = bestandsKomponente(b, null, "{\"ip\":\"10.0.0.4\",\"port\":502,\"unit_id\":4}");
        assertThat(laufende(fremd)).isEmpty();

        assertThat(alsApp(a, () -> app.queryForObject("SELECT uems_geraet_ableiten_fuer(?)", Integer.class,
                fremd))).isZero();
        assertThat(laufende(fremd)).isEmpty();
        UUID eigene = alsApp(a, () -> appKomponente(a, null, "modbus-generic", null, null));
        assertThat(geraetVon(eigene).get("kennzeichen")).isEqualTo("GR-1");
        assertThat(alsApp(b, () -> app.queryForObject("SELECT count(*) FROM geraet", Long.class))).isZero();
        assertThat(alsApp(b, () -> app.queryForObject("SELECT count(*) FROM geraet_komponente", Long.class)))
                .isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM geraet_kennzeichen_seq WHERE tenant_id = ?",
                Long.class, b.tenant())).isZero();

        assertThat(sqlStateVon(() -> alsApp(a, () -> app.queryForObject("SELECT uems_geraete_ableiten()",
                Integer.class)))).isEqualTo("42501");
        for (String rolle : List.of(APP_USER, "voltpilot_admin")) {
            assertThat(darf(rolle, "uems_geraet_ableiten_fuer(uuid)")).as(rolle).isTrue();
            assertThat(darf(rolle, "uems_geraete_ableiten()")).as(rolle).isFalse();
        }
        // PUBLIC ist entzogen: eine Rolle ohne eigenes Recht darf keine der beiden.
        assertThat(darf("pg_read_all_data", "uems_geraet_ableiten_fuer(uuid)")).isFalse();
        assertThat(root.queryForList("SELECT proname FROM pg_proc WHERE proname IN "
                + "('uems_geraet_ableiten_fuer', 'uems_geraete_ableiten', 'uems_geraet_anlegen') AND prosecdef",
                String.class)).as("alle laufen als Aufrufer").isEmpty();

        assertThat(root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class)).isOne();
        Map<String, Object> bestand = geraetVon(fremd);
        assertThat(bestand.get("geraeteart")).isEqualTo("zaehler");
        assertThat(bestand.get("geraete_id")).isEqualTo(4);
        assertThat(bestand.get("kennzeichen")).as("zählt im eigenen Kundenbereich").isEqualTo("GR-1");
        nachlaufLegtNichtsAn();
    }

    // ---- Löschen --------------------------------------------------------------------------

    /** Eine gelöschte Komponente nimmt ihre Speisung mit (CASCADE) — das Gerät bleibt. */
    @Test
    void eineGeloeschteKomponenteNimmtNurIhreSpeisungMit() {
        Kunde k = neuerKunde("Anlegeweg Löschen");
        ok(post("/api/v1/sites/" + k.site() + "/measurement-points",
                Map.of("role", "consumer", "label", "Sauna"), k));
        UUID sauna = komponente(k, "Sauna");
        Object geraet = geraetVon(sauna).get("id");

        ResponseEntity<JsonNode> weg = aufruf(HttpMethod.DELETE,
                "/api/v1/sites/" + k.site() + "/measurement-points/" + sauna, null, k);
        assertThat(weg.getStatusCode().is2xxSuccessful()).as(String.valueOf(weg.getBody())).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM geraet_komponente WHERE entity_id = ?",
                Long.class, sauna)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM geraet WHERE id = ? AND ausgebaut_am IS NULL",
                Long.class, geraet)).isOne();
        nachlaufLegtNichtsAn();
    }

    // ---- Das Messkanal-Read-Model ---------------------------------------------------------

    /**
     * Das Read-Model zeigt je Kanal das Gerät der laufenden Speisung: für eine neu angelegte und
     * für eine Bestandskomponente — und {@code null}, wenn keine Speisung läuft.
     */
    @Test
    void derMesskanalZeigtDasGeraetEinerNeuenUndEinerBestandskomponente() {
        Kunde k = neuerKunde("Anlegeweg Messkanal");
        UUID box = box(k);
        UUID bestand = bestandsKomponente(k, box, "{\"ip\":\"10.0.0.5\",\"port\":502,\"unit_id\":5}");
        assertThat(root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class)).isOne();
        UUID neu = alsApp(k, () -> appKomponente(k, box, "modbus-generic", "Janitza", "UMG 604"));
        UUID ohne = alsApp(k, () -> app.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, "
                + "entity_type, device_id, control, created_at) VALUES (?, ?, 'modbus-generic', 'modbus-generic', "
                + "?, false, now() - interval '1 day') RETURNING id", UUID.class, k.tenant(), k.site(), box));
        // Die Speisung von `ohne` ist beendet: ihr Zeitraum liegt ganz in der Vergangenheit.
        root.update("UPDATE geraet_komponente SET gueltig_bis = gueltig_ab + interval '1 hour' WHERE entity_id = ?",
                ohne);

        for (UUID komponente : List.of(bestand, neu)) {
            auswahl(k, box, komponente);
            Map<String, Object> g = geraetVon(komponente);
            JsonNode kanal = messkanal(k, komponente);
            assertThat(kanal.get("geraet").get("id").asText()).isEqualTo(g.get("id").toString());
            assertThat(kanal.get("geraet").get("geraet").asText()).isEqualTo(g.get("kennzeichen"));
            assertThat(kanal.get("geraet").get("einbau").asText()).isEqualTo(g.get("einbau_kennzeichen"));
            assertThat(kanal.get("geraet").get("seriennummer").isNull()).isTrue();
            assertThat(kanal.get("geraet").size()).isEqualTo(4);
        }
        assertThat(messkanal(k, bestand).at("/geraet/geraet").asText()).isEqualTo("GR-1");
        assertThat(messkanal(k, neu).at("/geraet/geraet").asText()).isEqualTo("GR-2");

        auswahl(k, box, ohne);
        assertThat(messkanal(k, ohne).get("geraet").isNull()).as("keine laufende Speisung — nie geraten")
                .isTrue();
        nachlaufLegtNichtsAn();
    }

    // ---- Gerüst: Daten --------------------------------------------------------------------

    private static Kunde neuerKunde(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, ?, 'DE-LU') "
                + "RETURNING id", UUID.class, tenant, name);
        return new Kunde(tenant, site);
    }

    private static UUID box(Kunde k) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, 'inverter', 'claimed') RETURNING id", UUID.class, k.tenant(), k.site(),
                "VP-ANLEGEWEG-" + UUID.randomUUID());
    }

    /**
     * Eine Komponente von VOR dem Anlege-Weg: angelegt, während der Trigger ruht — sie hat kein
     * Gerät, bis die Bestands-Ableitung sie nachholt.
     */
    private static UUID bestandsKomponente(Kunde k, UUID box, String verbindung) {
        DataSourceTransactionManager tm = new DataSourceTransactionManager(root.getDataSource());
        return new TransactionTemplate(tm).execute(s -> {
            root.execute("ALTER TABLE measurement_point DISABLE TRIGGER uems_geraet_anlegen");
            UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, "
                    + "device_id, control, communication, connection_json) VALUES (?, ?, 'modbus-generic', "
                    + "'modbus-generic', ?, false, 'modbus_tcp', ?::jsonb) RETURNING id", UUID.class, k.tenant(),
                    k.site(), box, verbindung);
            root.execute("ALTER TABLE measurement_point ENABLE TRIGGER uems_geraet_anlegen");
            return id;
        });
    }

    /** Eine Komponente, angelegt von der App-Rolle — innerhalb der laufenden Transaktion. */
    private UUID appKomponente(Kunde k, UUID box, String art, String marke, String modell) {
        return app.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, device_id, "
                + "control, brand, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(),
                k.site(), art, art, box, "battery-hybrid".equals(art), marke, modell);
    }

    /** Eine Transaktion der App-Rolle im Kundenbereich von {@code k}. */
    private <T> T alsApp(Kunde k, Supplier<T> arbeit) {
        TenantContext.set(k.tenant());
        try {
            return new TransactionTemplate(transaktionen).execute(s -> arbeit.get());
        } finally {
            TenantContext.clear();
        }
    }

    private static void auswahl(Kunde k, UUID box, UUID komponente) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, "
                + "'sunspec.model_203.totwhimp', true, 10, 1, now(), '2026.08.26.3', 'test', 'pending_edge', "
                + "'energy_counter', 'fifteen_minute')", k.tenant(), k.site(), box, komponente);
    }

    private static UUID komponente(Kunde k, String label) {
        return root.queryForObject("SELECT id FROM measurement_point WHERE site_id = ? AND label = ?",
                UUID.class, k.site(), label);
    }

    /** Die Komponenten der Anlage je Art (Typ, sonst Rolle). */
    private static Map<String, UUID> arten(Kunde k) {
        Map<String, UUID> m = new LinkedHashMap<>();
        root.query("SELECT id, coalesce(entity_type, role) AS art FROM measurement_point WHERE site_id = ? "
                + "ORDER BY created_at, id", rs -> {
                    assertThat(m.put(rs.getString("art"), rs.getObject("id", UUID.class)))
                            .as("je Art eine Komponente").isNull();
                }, k.site());
        return m;
    }

    /** Die laufenden Speisungen der Komponente mit ihrem Gerät. */
    private static List<Map<String, Object>> laufende(UUID komponente) {
        return root.queryForList("SELECT g.* FROM geraet_komponente v JOIN geraet g ON g.id = v.geraet_id "
                + "WHERE v.entity_id = ? AND v.gueltig_bis IS NULL", komponente);
    }

    /** Das EINE laufende Gerät der Komponente. */
    private static Map<String, Object> geraetVon(UUID komponente) {
        List<Map<String, Object>> l = laufende(komponente);
        assertThat(l).as("genau ein laufendes Gerät für " + komponente).hasSize(1);
        return l.get(0);
    }

    /** Einbau und Speisung beginnen mit der Anlage der Komponente, auf die Minute. */
    private static boolean beginntMitDerAnlage(UUID komponente) {
        return root.queryForObject("SELECT g.eingebaut_am = date_trunc('minute', mp.created_at AT TIME ZONE 'UTC') "
                + "AT TIME ZONE 'UTC' AND v.gueltig_ab = g.eingebaut_am FROM measurement_point mp "
                + "JOIN geraet_komponente v ON v.entity_id = mp.id JOIN geraet g ON g.id = v.geraet_id "
                + "WHERE mp.id = ?", Boolean.class, komponente);
    }

    private static long geraete(Kunde k) {
        return root.queryForObject("SELECT count(*) FROM geraet WHERE tenant_id = ?", Long.class, k.tenant());
    }

    /** Der Beweis „eine Regel": die Bestands-Ableitung findet nichts mehr zu tun. */
    private static void nachlaufLegtNichtsAn() {
        assertThat(root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class))
                .as("die Bestands-Ableitung legt nach dem Anlege-Weg nichts mehr an").isZero();
    }

    private static boolean darf(String rolle, String funktion) {
        return root.queryForObject("SELECT has_function_privilege(?, ?, 'EXECUTE')", Boolean.class, rolle,
                funktion);
    }

    private static String sqlStateVon(Runnable r) {
        try {
            r.run();
        } catch (DataAccessException e) {
            Throwable t = e;
            while (t != null && !(t instanceof SQLException)) {
                t = t.getCause();
            }
            return t == null ? null : ((SQLException) t).getSQLState();
        }
        throw new AssertionError("erwartet: abgelehnt");
    }

    // ---- Gerüst: Schnittstelle ------------------------------------------------------------

    private void claim(Kunde k) {
        ResponseEntity<JsonNode> r = post("/api/v1/devices/claim", Map.of("siteId", k.site().toString(),
                "externalRef", "anlegeweg-" + UUID.randomUUID(), "kind", "inverter"), k);
        assertThat(r.getStatusCode().is2xxSuccessful()).as(String.valueOf(r.getBody())).isTrue();
    }

    private JsonNode messkanal(Kunde k, UUID komponente) {
        JsonNode liste = ok(aufruf(HttpMethod.GET, "/api/v1/sites/" + k.site() + "/komponenten/" + komponente
                + "/messkanaele", null, k));
        assertThat(liste.get("messkanaele")).hasSize(1);
        return liste.get("messkanaele").get(0);
    }

    private ResponseEntity<JsonNode> post(String pfad, Object rumpf, Kunde k) {
        return aufruf(HttpMethod.POST, pfad, rumpf, k);
    }

    /** Als Plattform-Admin mit gewähltem Kundenbereich. */
    private ResponseEntity<JsonNode> aufruf(HttpMethod methode, String pfad, Object rumpf, Kunde k) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token("admin"));
        headers.set("X-Tenant-Id", k.tenant().toString());
        headers.setContentType(MediaType.APPLICATION_JSON);
        return rest.exchange("http://localhost:" + port + pfad, methode, new HttpEntity<>(rumpf, headers),
                JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().is2xxSuccessful()).as(r.getStatusCode() + " " + r.getBody()).isTrue();
        return r.getBody();
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
            Map<String, Object> body = new TestRestTemplate().postForObject(
                    KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                    new HttpEntity<>(form, headers), Map.class);
            assertThat(body).as("token response").containsKey("access_token");
            return (String) body.get("access_token");
        });
    }
}
