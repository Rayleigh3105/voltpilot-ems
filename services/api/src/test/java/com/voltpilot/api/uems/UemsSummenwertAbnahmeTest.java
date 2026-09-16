package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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

/** H-11: echte API/DB-Kette vom Summenwert über Karte und Cockpit bis zum Entzug.
 * Deye A1 und angenommener Netzfall A5; keine Hardware- oder Echtkunden-Nachweise. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(properties = {
        "voltpilot.uems.viertelstunde.enabled=false", "voltpilot.uems.endgueltigkeit.enabled=false",
        "voltpilot.interventions.renewal-enabled=false", "voltpilot.entities.backfill.reconcile-enabled=false",
        "voltpilot.ota.mqtt-listener-enabled=false", "voltpilot.components.adoption.reconcile-enabled=false",
        "voltpilot.metrics.fleet.enabled=false", "voltpilot.metrics.db.enabled=false" })
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsSummenwertAbnahmeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    private static final String PV1 = "deye.hybrid_3p.pv.pv1-power";
    private static final String PV2 = "deye.hybrid_3p.pv.pv2-power";
    private static final String PV3 = "deye.hybrid_3p.pv.pv3-power";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";       // Wirkenergie (Zähler)
    private static final String NETZ = "sunspec.model_203.w";               // import_export
    private static final String OHNE_RICHTUNG = "deye.hybrid_3p.generator-smartload-microinverter.generator-power";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            // Die Abnahme startet keine Timescale-Jobs parallel zu Flyway.
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

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
    }

    @Test
    void a1DeyeAnlegenStandKarteCockpitEntzugUndZeichengleicherRueckfall() throws Exception {
        Welt w = welt();
        selektion(w, OHNE_RICHTUNG);
        probe(w, PV1, 5200); probe(w, PV2, 4100); probe(w, PV3, 3100); probe(w, OHNE_RICHTUNG, 2000);
        roh(w);
        JsonNode vorher = ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200);
        var eingabe = anlegen("PV mit Gen-Port", term(w, PV1), term(w, PV2), term(w, PV3), termHaken(w, OHNE_RICHTUNG));
        eingabe.put("rolle", Map.of("entity_id", w.komponente(), "role", "pv"));
        String id = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", eingabe), 201).path("id").asText();
        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200);
        assertThat(wert.path("wert").asDouble()).isEqualTo(14.4);
        assertThat(wert.path("stand").asText()).isNotBlank();
        JsonNode karte = ok(ruf(w, HttpMethod.GET, basis(w) + "/komponenten/" + w.komponente() + "/summenwerte", null), 200);
        assertThat(karte.at("/0/rolle").asText()).isEqualTo("pv");
        assertThat(karte.at("/0/wert/wert").asDouble()).isEqualTo(14.4);
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200).at("/sites/0/live/pvKw").asDouble()).isEqualTo(14.4);
        ok(ruf(w, HttpMethod.DELETE, basis(w) + "/komponenten/" + w.komponente() + "/rollen/pv", null), 200);
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200).toString()).isEqualTo(vorher.toString());
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200).path("wert").asDouble()).isEqualTo(14.4);
        assertThat(ok(ruf(w, HttpMethod.GET, basis(w) + "/aenderungen", null), 200).toString()).contains("rolle_gesetzt", "rolle_entzogen", "PV mit Gen-Port");
    }

    @Test
    void a5NetzZaehltEinmal409SchreibtNichtsUndEntzugBeendetAlleHalterMitRueckfall() throws Exception {
        Welt w = welt();
        UUID zweites = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, control, communication) "
                + "VALUES (?, ?, 'grid-meter', 'Abgabe', 'grid-meter', ?, false, 'modbus_tcp') RETURNING id", UUID.class, w.mandant(), w.anlage(), w.box());
        // Angenommener A5-Zähler: zwei gerichtete Leistungswerte, kein Erzeugungs-Haken.
        // Richtungslose Summe ist vorgegeben; die Rechen-/Katalogprüfung der Anfrage prüft MessstelleFormelApiTest.
        UUID summe = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, wertart) "
                + "VALUES (?, 'MS-9901', 'Netz saldiert', 'berechnet', 'Strom', 'Wirkleistung', 'richtungslos', 'kW', 'Momentanwert') RETURNING id", UUID.class, w.mandant());
        for (int i = 0; i < 2; i++) root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, entity_id, point_key, vorzeichen, faktor, gilt_als_erzeugung) "
                + "VALUES (?, ?, ?, 'messkanal', ?, ?, ?, 1, false)", w.mandant(), summe, i, i == 0 ? w.komponente() : zweites, i == 0 ? PV1 : PV2, i == 0 ? "+" : "-");
        selektion(new Welt(w.mandant(), w.anlage(), w.box(), zweites), PV2);
        probe(w, PV1, 8000); probe(w, PV2, 10000);
        UUID dritte = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, control, communication) "
                + "VALUES (?, ?, 'battery-hybrid', 'Weiterer Zähler', 'battery-hybrid', ?, false, 'modbus_tcp') RETURNING id", UUID.class, w.mandant(), w.anlage(), w.box());
        roh(w);
        JsonNode vorher = ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200);
        String rollen = basis(w) + "/rollen/grid";
        ok(ruf(w, HttpMethod.PUT, rollen, Map.of("art", "gesamtwert", "quell_messstelle_id", summe)), 200);
        JsonNode wert = ok(ruf(w, HttpMethod.GET, rollen, null), 200);
        assertThat(wert.path("wert").asDouble()).isEqualTo(-2);
        assertThat(wert.path("geraete")).hasSize(2);
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200).at("/sites/0/live/gridKw").asDouble()).isEqualTo(-2);
        // Ein anderer Kanal darf die Netz-Eindeutigkeit nicht umgehen, auch bei bestehender Summe.
        String anderer = basis(w) + "/komponenten/" + dritte + "/rollen/grid";
        ok(ruf(w, HttpMethod.PUT, anderer, Map.of("art", "messkanal", "capability", "pv_power_kw")), 409);
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE site_id = ? AND role = 'grid' AND is_primary", Integer.class, w.anlage())).isEqualTo(2);
        String entzug = basis(w) + "/komponenten/" + w.komponente() + "/rollen/grid";
        ok(ruf(w, HttpMethod.DELETE, entzug, null), 200);
        ok(ruf(w, HttpMethod.DELETE, entzug, null), 200);
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE site_id = ? AND role = 'grid' AND is_primary", Integer.class, w.anlage())).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE objekt_id = ? AND art = 'rolle_entzogen'", Integer.class, w.anlage())).isEqualTo(2);
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200).toString()).isEqualTo(vorher.toString());
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + summe + "/wert", null), 200).path("wert").asDouble()).isEqualTo(-2);
    }

    @Test
    void entzugDerGemeinsamenSummeLaesstAndereQuellenUndRollenBestehen() throws Exception {
        Welt w = welt();
        UUID zweite = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, control, communication) "
                + "VALUES (?, ?, 'battery-hybrid', 'Zweiter Wechselrichter', 'battery-hybrid', ?, false, 'modbus_tcp') RETURNING id", UUID.class, w.mandant(), w.anlage(), w.box());
        UUID dritte = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, control, communication) "
                + "VALUES (?, ?, 'battery-hybrid', 'Unabhängiger Wechselrichter', 'battery-hybrid', ?, false, 'modbus_tcp') RETURNING id", UUID.class, w.mandant(), w.anlage(), w.box());
        Welt b = new Welt(w.mandant(), w.anlage(), w.box(), zweite);
        selektion(b, PV2);
        var eingabe = anlegen("Gemeinsame Dächer", term(w, PV1), term(b, PV2));
        eingabe.put("rolle", Map.of("entity_id", w.komponente(), "role", "pv"));
        String id = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", eingabe), 201).path("id").asText();
        var kanal = Map.of("art", "messkanal", "capability", "pv_power_kw");
        ok(ruf(w, HttpMethod.PUT, basis(w) + "/komponenten/" + dritte + "/rollen/pv", kanal), 200);
        ok(ruf(w, HttpMethod.PUT, basis(w) + "/komponenten/" + w.komponente() + "/rollen/consumer", kanal), 200);
        ok(ruf(w, HttpMethod.DELETE, basis(w) + "/komponenten/" + zweite + "/rollen/pv", null), 200);
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE quell_messstelle_id = ?", Integer.class, UUID.fromString(id))).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE site_id = ? AND is_primary", Integer.class, w.anlage())).isEqualTo(2);
        assertThat(ok(ruf(w, HttpMethod.GET, basis(w) + "/komponenten/" + dritte + "/rollen/pv", null), 200).at("/zugeordnet/art").asText()).isEqualTo("messkanal");
        assertThat(ok(ruf(w, HttpMethod.GET, basis(w) + "/komponenten/" + w.komponente() + "/rollen/consumer", null), 200).at("/zugeordnet/art").asText()).isEqualTo("messkanal");
    }

    private static String basis(Welt w) { return "/api/v1/sites/" + w.anlage(); }

    private void roh(Welt w) {
        root.update("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, pv_power_kw, load_kw, power_kw, soc_pct) "
                + "VALUES (now(), now(), ?, ?, ?, 12.4, 234.8, 6, 62)", w.mandant(), w.anlage(), w.box());
    }

    @Test
    void geraeteKontextMitGemeldeterDeyeFamilieOhneTelemetrieUndOhneFremdeQuellen() throws Exception {
        Welt basis = welt();
        root.update("DELETE FROM device_measurement_selection WHERE entity_id = ?", basis.komponente());
        root.update("DELETE FROM measurement_point WHERE id = ?", basis.komponente());
        // Genau der Kompositionspfad: keine gespeicherte Familie, kein Alias.
        var registry = new com.voltpilot.api.entities.EntityRegistryRepository(root);
        UUID hybrid = registry.createBatteryHybridPoint(basis.mandant(), basis.anlage(), null, basis.box());
        registry.setEntityConfig(hybrid, "battery-hybrid", "{\"measure\":[]}", "{}");
        Welt w = new Welt(basis.mandant(), basis.anlage(), basis.box(), hybrid);
        UUID haus = registry.createComposedPoint(w.mandant(), w.anlage(), "house-load", null, w.box());
        registry.setEntityConfig(haus, "house-load", "{\"measure\":[]}", "{}");
        UUID fremd = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, device_id, edge_source_id) "
                + "VALUES (?, ?, 'pv-generation', 'producer', ?, 'src-other') RETURNING id", UUID.class, w.mandant(), w.anlage(), w.box());
        meldung(w, "inverter", "hybrid_3p");
        meldung(w, "src-other", "string");
        var quellen = ok(ruf(w, HttpMethod.GET, basis(w) + "/summenwert-quellen?boxId=" + w.box() + "&geraetId=inverter", null), 200);
        assertThat(quellen).hasSize(2);
        assertThat(quellen.toString()).contains(hybrid.toString(), haus.toString()).doesNotContain(fremd.toString());
        assertThat(ok(ruf(w, HttpMethod.GET, basis(w) + "/summenwert-quellen", null), 200)).hasSize(3);
        var pages = new ArrayList<JsonNode>();
        for (int offset = 0; ; ) {
            var page = ok(ruf(w, HttpMethod.GET, katalog(w, hybrid) + "&offset=" + offset, null), 200);
            assertThat(page.path("availabilityReason").isNull()).isTrue();
            pages.add(page); offset += page.path("points").size();
            if (offset >= page.path("total").asInt()) break;
            assertThat(page.path("points")).isNotEmpty();
        }
        assertThat(pages).hasSize(3);
        assertThat(pages.getFirst().path("total").asInt()).isEqualTo(624);
        assertThat(pages.toString()).contains(PV1);
        for (var page : pages) for (var point : page.path("points")) {
            assertThat(point.path("family").asText()).isEqualTo("hybrid_3p");
            assertThat(point.path("selected").asBoolean()).isFalse();
            assertThat(point.path("lastReadAt").isNull()).isTrue();
        }
        assertThat(ok(ruf(w, HttpMethod.GET, katalog(w, fremd), null), 200).at("/points/0/family").asText()).isEqualTo("string");
        // Reale API-Seiten für die fiktive Browser-Bühne; keine Kundenwerte.
        String evidence = System.getProperty("summenwert.evidence");
        if (evidence != null) {
            var out = java.nio.file.Path.of(evidence); java.nio.file.Files.createDirectories(out);
            java.nio.file.Files.writeString(out.resolve("pages.json"), MAPPER.writeValueAsString(pages));
        }
        var kontext = Map.of("art", "geraet", "site_id", w.anlage(), "box_id", w.box(), "geraet_id", "inverter");
        var erlaubt = anlegen("Eigener Hybrid", term(w, PV1), term(new Welt(w.mandant(), w.anlage(), w.box(), haus), PV2));
        erlaubt.put("kontext", kontext);
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", erlaubt), 201);
        var manipuliert = anlegen("Anderes Gerät", term(w, PV1), term(new Welt(w.mandant(), w.anlage(), w.box(), fremd), PV2));
        manipuliert.put("kontext", kontext);
        assertThat(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", manipuliert), 422).toString())
                .contains("summenwert_kontext_verletzt", "anderes_geraet");
        manipuliert.put("kontext", Map.of("art", "anlage", "site_id", w.anlage()));
        UUID gemeinsame = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", manipuliert), 201).path("id").asText());
        var rekursiv = anlegen("Verschachtelt", mterm(gemeinsame));
        rekursiv.put("kontext", kontext);
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", rekursiv), 422);
        Welt fremdeAnlage = welt();
        var crossSite = anlegen("Fremd", term(fremdeAnlage, PV1)); crossSite.put("kontext", kontext);
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", crossSite), 404);
        ok(ruf(w, HttpMethod.GET, basis(w) + "/summenwert-quellen?boxId=" + fremdeAnlage.box() + "&geraetId=inverter", null), 404);
        root.update("UPDATE measurement_point SET family = 'unknown-family' WHERE id = ?", hybrid);
        var unbekannt = ok(ruf(w, HttpMethod.GET, katalog(w, hybrid), null), 200);
        assertThat(unbekannt.path("total").asInt()).isZero();
        assertThat(unbekannt.path("availabilityReason").asText()).isEqualTo("registerfamilie_nicht_zugeordnet");
        root.update("UPDATE measurement_point SET family = 'hybrid_1p' WHERE id = ?", hybrid);
        assertThat(ok(ruf(w, HttpMethod.GET, katalog(w, hybrid), null), 200).at("/points/0/family").asText()).isEqualTo("hybrid_1p");
        root.update("UPDATE measurement_point SET family = NULL WHERE id = ?", hybrid);
        root.update("DELETE FROM entity_observed_state WHERE device_id = ? AND entity_id = 'local:inverter'", w.box());
        assertThat(ok(ruf(w, HttpMethod.GET, katalog(w, hybrid), null), 200).path("availabilityReason").asText())
                .isEqualTo("registerfamilie_nicht_zugeordnet"); // keine Familie vom zweiten Gerät übernehmen
    }

    private static String katalog(Welt w, UUID entity) {
        return "/api/v1/devices/" + w.box() + "/measurement-selection/catalog?entityId=" + entity + "&availableOnly=true&limit=250";
    }

    private void meldung(Welt w, String id, String familie) {
        root.update("INSERT INTO entity_observed_state (tenant_id, site_id, device_id, entity_id, source, entity_type, "
                + "reported_at, edge_communication, edge_connection, edge_family) VALUES (?, ?, ?, ?, 'local', ?, now(), 'modbus_tcp', '{\"ip\":\"192.0.2.10\",\"unit_id\":1}'::jsonb, ?)",
                w.mandant(), w.anlage(), w.box(), "local:" + id, "inverter".equals(id) ? "inverter" : "source", familie);
    }

    private record Welt(UUID mandant, UUID anlage, UUID box, UUID komponente) {}

    /** Ein Kundenbereich mit einer Anlage, einer Box und einer Komponente, die PV1..PV3 liest. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Gesamtwert-Probe #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage #" + nr + "', now()) RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id",
                UUID.class, t, anlage, "E-" + nr);
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, communication, created_at) VALUES (?, ?, "
                + "'battery-hybrid', 'Wechselrichter', 'battery-hybrid', ?, false, 'modbus_tcp', now()) "
                + "RETURNING id", UUID.class, t, anlage, box);
        for (String pk : List.of(PV1, PV2, PV3)) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                    + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, "
                    + "changed_by, apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, "
                    + "true, 60, 1, now(), '2026.09.11.1', 'test', 'pending_edge', 'energy_counter', "
                    + "'fifteen_minute') ON CONFLICT DO NOTHING", t, anlage, box, k, pk);
        }
        return new Welt(t, anlage, box, k);
    }

    private static final AtomicInteger SEQ = new AtomicInteger();

    /** Ein frischer GUTER Sample-Wert (W) für einen Kanal. */
    private void probe(Welt w, String pointKey, double wattr) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version, "
                + "edge_sequence, aggregation_kind, long_term_cadence_s) VALUES (now(), now(), ?, ?, ?, ?, "
                + "?, ?, 'good', '2026.09.11.1', ?, 'gauge', 900)",
                w.mandant(), w.anlage(), w.box(), pointKey, wattr, wattr, SEQ.incrementAndGet());
    }

    // ================================================================ das Gerüst

    private static Map<String, Object> term(Welt w, String pointKey) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("eingang_art", "messkanal");
        t.put("entity_id", w.komponente().toString());
        t.put("point_key", pointKey);
        t.put("vorzeichen", "+");
        return t;
    }

    /** Ein Messkanal-Term mit gesetztem AP-08-Haken „gilt als Erzeugung". */
    private static Map<String, Object> termHaken(Welt w, String pointKey) {
        Map<String, Object> t = term(w, pointKey);
        t.put("gilt_als_erzeugung", true);
        return t;
    }

    /** Schaltet einen weiteren Kanal der Komponente als beobachtet ein (wie in {@link #welt()}). */
    private void selektion(Welt w, String pointKey) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, "
                + "changed_by, apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, "
                + "true, 60, 1, now(), '2026.09.11.1', 'test', 'pending_edge', 'energy_counter', "
                + "'fifteen_minute') ON CONFLICT DO NOTHING", w.mandant(), w.anlage(), w.box(),
                w.komponente(), pointKey);
    }

    /** Ein Baustein-Term: eine andere Messstelle als Eingang. */
    private static Map<String, Object> mterm(UUID quellMessstelle) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("eingang_art", "messstelle");
        t.put("quell_messstelle_id", quellMessstelle.toString());
        t.put("vorzeichen", "+");
        return t;
    }

    @SafeVarargs
    private static Map<String, Object> anlegen(String name, Map<String, Object>... terme) {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("name", name);
        a.put("terme", List.of(terme));
        return a;
    }

    private record Antwort(int status, JsonNode body) {}

    private static JsonNode ok(Antwort a, int status) {
        assertThat(a.status()).as("Antwort " + a.body()).isEqualTo(status);
        return a.body();
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + w.mandant());
                    j.claim("name", "Test");
                    j.claim("tenant_id", w.mandant().toString());
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
