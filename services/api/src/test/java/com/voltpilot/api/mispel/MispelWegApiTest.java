package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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
 * MiSpeL MP-55 gegen die Datenbank: {@code GET /api/v1/sites/{siteId}/mispel-weg} (Vertrag
 * {@code docs/contracts/v2/mispel-weg.md}) auf einer frisch migrierten Datenbank.
 *
 * <p><b>Prüfnachweis:</b> die sechs Demo-Anlagen, aufgebaut wie {@code DemoMispelAufbau} sie anlegt (Förderweg-Fassung,
 * Check, Vormerkung der Pauschaloption, Zählerrollen über die Route des Registers, Ladepunkt mit Fähigkeit,
 * Fahrzeugfenster und Wahl, Monats- und Jahreslauf), antworten je genau wie ihr Fall in
 * {@code mispel-weg-vectors.json}; der Leseweg hält den Zaun wie die Anlage: fremder Mandant und unbekannte Anlage 404,
 * ein Leser am Standort der Anlage liest dasselbe, ein Leser an einem anderen Standort bekommt 404.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MispelWegApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    /** Der Tag der Vektoren (19.10.2026), mittags in Berlin. */
    private static final Clock HEUTE = Clock.fixed(Instant.parse("2026-10-19T10:00:00Z"), ZoneOffset.UTC);
    private static final String AB = "2026-10-01";

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

    @MockBean
    EntityRegistryPublisher registryPublisher;
    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MockMvc mvc;
    @Autowired
    FoerderwegService foerderwege;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void uhr() {
        foerderwege.uhrStellen(HEUTE);
    }

    @AfterEach
    void uhrZurueck() {
        foerderwege.uhrStellen(Clock.systemUTC());
    }

    private record Anlage(UUID mandant, UUID id, UUID box) {}

    private record Antwort(int status, JsonNode body) {}

    // ------------------------------------------------------------------ die sechs Demo-Anlagen

    @Test
    void werkTalheimWieImVektor() throws Exception {
        Anlage a = anlage("Werk Talheim", "gewerbe", false);
        speicher(a);
        pv(a, 750);
        zaehlerGewerbe(a, "MS-11", "MS-12", "MS-13", "MS-14", "12");
        fassung(a, "marktpraemie_ausschliesslichkeit", null, true, null, null);
        check(a, "A1", 158, 1899, 8043, null);
        vergleiche(a, "Werk Talheim", null);
    }

    @Test
    void kuehlhausSeebachWieImVektor() throws Exception {
        Anlage a = anlage("Kühlhaus Seebach", "gewerbe", true);
        speicher(a);
        pv(a, 100);
        zaehlerGewerbe(a, "MS-01", "MS-02", "MS-03", "MS-04", "11");
        fassung(a, "marktpraemie_abgrenzung", "A1", true, "Nordstrom Direkt GmbH", true);
        monatslauf(a, "A1");
        vergleiche(a, "Kühlhaus Seebach", null);
    }

    @Test
    void autohausBrennerWieImVektor() throws Exception {
        Anlage a = anlage("Autohaus Brenner", "gewerbe", true);
        speicher(a);
        pv(a, 100);
        fassung(a, "ungefoerdert", null, true, null, null);
        check(a, "A1", -1321, -555, 691, null);
        vergleiche(a, "Autohaus Brenner", null);
    }

    @Test
    void hausKroegerWieImVektor() throws Exception {
        Anlage a = anlage("Haus Kröger", "privat", false);
        speicher(a);
        pv(a, 9.2);
        fassung(a, "einspeiseverguetung", null, false, null, null);
        root.update("INSERT INTO site_pauschal_vormerkung (tenant_id, site_id, steckersolar_kwp, "
                + "ein_betreiber_bestaetigt_am, steckersolar_dv_bestaetigt_am, direktvermarkter, bilanzkreis_gesondert, "
                + "created_by) VALUES (?, ?, 0.8, now(), now(), 'Sonnenstrom Direkt eG', false, 'test')",
                a.mandant(), a.id());
        check(a, "P1", -130, 25, 175, "Information vor dem Wechsel: Die Pauschaloption ist erst ab dem Monatsersten "
                + "nach der EU-Genehmigung anwendbar (Festlegung, Tenor Ziff. 9 b); gerechnet ist der Basisfall P1.");
        vergleiche(a, "Haus Kröger", null);
    }

    @Test
    void hausSommerWieImVektor() throws Exception {
        Anlage a = anlage("Haus Sommer", "privat", true);
        speicher(a);
        pv(a, 9.8);
        fassung(a, "marktpraemie_pauschal", null, true, "Sonnenstrom Direkt eG", false);
        root.update("INSERT INTO mispel_pauschal_jahr (tenant_id, site_id, jahr, tag_von, tag_bis, zeitraum_von, "
                + "zeitraum_bis, fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, "
                + "viertelstunden_gerechnet, rechenwerk_version, vertrag_version, nachweis, pruefsumme) VALUES (?, ?, "
                + "2026, DATE '2026-10-01', DATE '2026-12-31', TIMESTAMPTZ '2026-09-30 22:00:00+00', "
                + "TIMESTAMPTZ '2026-12-31 23:00:00+00', 1, 'P1', 'vorlaeufig', 'geraet', 8836, 384, 'test', 'test', "
                + "'{}', ?)", a.mandant(), a.id(), "0".repeat(64));
        vergleiche(a, "Haus Sommer", null);
    }

    @Test
    void hausAlbersWieImVektor() throws Exception {
        Anlage a = anlage("Haus Albers", "privat", true);
        pv(a, 9.9);
        UUID netz = komponente(a, "grid-meter", "Netzzähler");
        UUID wallbox = komponente(a, "ev-charger", "Wallbox Garage");
        Map<String, UUID> ms = new LinkedHashMap<>();
        ms.put("MS-01", messstelle(a, "MS-01", "Bezug", "Hauptzähler", netz, "sunspec.model_203.totwhimp"));
        ms.put("MS-02", messstelle(a, "MS-02", "Abgabe", "Hauptzähler", netz, "sunspec.model_203.totwhexp"));
        ms.put("MS-03", messstelle(a, "MS-03", "Laden", "Speicher", wallbox, "ev.charge-energy"));
        ms.put("MS-04", messstelle(a, "MS-04", "Entladen", "Speicher", wallbox, "ev.discharge-energy"));
        rollen(a, ms, "31");
        root.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, nutzbarkeit, v2h, v2g, "
                + "rueckspeisung_bei_einspeisung_unterbunden, rueckspeiseleistung_kw, gueltig_ab, created_by) "
                + "VALUES (?, ?, ?, 'bidirektional', true, true, false, 11, DATE '2026-10-01', 'test')",
                a.mandant(), a.id(), wallbox);
        root.update("INSERT INTO ladepunkt_fahrzeugfenster (komponente_id, tenant_id, site_id, mindest_soc_pct, "
                + "kapazitaet_kwh, geaendert_von) VALUES (?, ?, ?, 40, 64, 'test')", wallbox, a.mandant(), a.id());
        for (int tag = 1; tag <= 5; tag++) {
            root.update("INSERT INTO ladepunkt_anwesenheit (komponente_id, tenant_id, wochentag, ankunft, abfahrt, "
                    + "abfahrt_soc_pct) VALUES (?, ?, ?, TIME '17:45', TIME '07:15', 80)", wallbox, a.mandant(), tag);
        }
        root.update("INSERT INTO ladepunkt_fahrer_einstellung (komponente_id, tenant_id, site_id, rueckspeisen, "
                + "geaendert_von) VALUES (?, ?, ?, 'v2h', 'test')", wallbox, a.mandant(), a.id());
        fassung(a, "marktpraemie_abgrenzung", "A2", true, "Sonnenstrom Direkt eG", false);
        monatslauf(a, "A2");
        vergleiche(a, "Haus Albers", wallbox);
    }

    // ------------------------------------------------------------------ Zaun

    @Test
    void fremderMandantUndUnbekannteAnlageSind404() throws Exception {
        Anlage a = anlage("Werk Zaun", "gewerbe", false);
        speicher(a);
        Anlage b = anlage("Werk Nachbar", "gewerbe", false);
        assertThat(ruf(a, a.id()).status()).isEqualTo(200);
        assertThat(ruf(b, a.id()).status()).isEqualTo(404);
        assertThat(ruf(b, UUID.randomUUID()).status()).isEqualTo(404);
        assertThat(ruf(a, b.id()).status()).isEqualTo(404);
    }

    /** Leserecht wie die Anlage: ein Leser an ihrem Standort liest dasselbe, ein Leser an einem anderen nicht. */
    @Test
    void leserAmStandortLiestLeserAnderswoNicht() throws Exception {
        Anlage a = anlage("Werk Leser", "gewerbe", false);
        speicher(a);
        fassung(a, "marktpraemie_ausschliesslichkeit", null, true, null, null);
        check(a, "A1", 158, 1899, 8043, null);
        UUID zweite = root.queryForObject("INSERT INTO site (tenant_id, name, plant_kind, netzladen_erlaubt) VALUES "
                + "(?, 'Werk Leser 2', 'direktvermarktung', false) RETURNING id", UUID.class, a.mandant());
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Leser GmbH') "
                + "RETURNING id", UUID.class, a.mandant());
        UUID hier = standort(a, unternehmen, "ST-01", a.id());
        UUID dort = standort(a, unternehmen, "ST-02", zweite);
        leser(a, "sub-weg-leser-hier", hier);
        leser(a, "sub-weg-leser-dort", dort);

        Antwort bestand = ruf(a, a.id());
        Antwort hierAntwort = rufAls(a, "sub-weg-leser-hier", a.id());
        assertThat(hierAntwort.status()).isEqualTo(200);
        assertThat(hierAntwort.body()).isEqualTo(bestand.body());
        assertThat(hierAntwort.body().path("satz").asText()).isEqualTo("2 von 8 erledigt · jetzt: Förderweg wählen");
        assertThat(rufAls(a, "sub-weg-leser-dort", a.id()).status()).isEqualTo(404);
        // Die zweite Anlage hat kein Profil, keinen Speicher und keine Fassung: keine Strecke, kein Fehler.
        Antwort dortAntwort = rufAls(a, "sub-weg-leser-dort", zweite);
        assertThat(dortAntwort.status()).isEqualTo(200);
        assertThat(dortAntwort.body().path("strecken").size()).isZero();
        assertThat(dortAntwort.body().path("satz").asText()).isEqualTo("Diese Anlage hat keinen Speicher und keinen "
                + "Ladepunkt im Aufbau – MiSpeL betrifft sie nicht.");
    }

    // ------------------------------------------------------------------ Vergleich mit dem Vektor

    /** Die Antwort enthält den erwarteten Fall des Vektors; {@code komponente} ersetzt die Kennung des Vektors. */
    private void vergleiche(Anlage a, String fall, UUID komponente) throws Exception {
        JsonNode soll = null;
        for (JsonNode f : MispelWegRegelnTest.vektoren().path("faelle")) {
            if (fall.equals(f.path("name").asText())) {
                soll = f.path("erwartet").deepCopy();
            }
        }
        assertThat(soll).as(fall).isNotNull();
        if (komponente != null) {
            for (JsonNode s : soll.path("strecken")) {
                if (s.has("komponente_id")) {
                    ((ObjectNode) s).put("komponente_id", komponente.toString());
                }
            }
        }
        Antwort r = ruf(a, a.id());
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.body().path("site_id").asText()).isEqualTo(a.id().toString());
        assertThat(r.body().path("heute").asText()).isEqualTo("2026-10-19");
        MispelWegRegelnTest.teilmenge(soll, r.body(), fall);
    }

    // ------------------------------------------------------------------ Aufbau

    private Anlage anlage(String name, String profil, boolean netzladen) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Weg #" + nr);
        UUID s = root.queryForObject("INSERT INTO site (tenant_id, name, plant_kind, netzladen_erlaubt, profil) "
                + "VALUES (?, ?, 'direktvermarktung', ?, ?) RETURNING id", UUID.class, t, name, netzladen, profil);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, s, "VP-WEG-" + nr);
        return new Anlage(t, s, box);
    }

    private static void speicher(Anlage a) {
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh) VALUES (?, ?, 'battery', 65)",
                a.mandant(), a.id());
    }

    private static void pv(Anlage a, double kwp) {
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, is_primary) VALUES (?, ?, 'pv', ?, "
                + "true)", a.mandant(), a.id(), kwp);
    }

    private static void fassung(Anlage a, String weg, String formelsatz, boolean einverstaendnis, String partner,
            Boolean bilanzkreis) {
        String awRegel = weg.equals("marktpraemie_abgrenzung") || weg.equals("marktpraemie_pauschal") ? "viertelstunde"
                : null;
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, aw_regel, "
                + "direktvermarkter, bilanzkreis_gesondert, gueltig_ab, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "
                + "DATE '2026-10-01', 'test')", a.mandant(), a.id(), weg, formelsatz, einverstaendnis, awRegel, partner,
                bilanzkreis);
    }

    private static void check(Anlage a, String formelsatz, int niedrig, int mittel, int hoch, String hinweis) {
        root.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand, stand_seit, formelsatz, fenster_von, "
                + "fenster_bis, differenz_niedrig_eur, differenz_mittel_eur, differenz_hoch_eur, posten, datenbasis, "
                + "hinweis) VALUES (?, ?, 'fertig', TIMESTAMPTZ '2026-10-05 12:00:00+00', ?, DATE '2025-10-01', "
                + "DATE '2026-09-30', ?, ?, ?, ?::jsonb, '[]'::jsonb, ?)", a.id(), a.mandant(), formelsatz, niedrig,
                mittel, hoch, "[{\"art\":\"handel_saldierung\",\"niedrig_eur\":" + niedrig + ",\"mittel_eur\":" + mittel
                        + ",\"hoch_eur\":" + hoch + ",\"herkunft\":\"Test\"}]", hinweis);
    }

    private static void monatslauf(Anlage a, String formelsatz) {
        root.update("INSERT INTO mispel_abgrenzung_monat (tenant_id, site_id, monat, zeitraum_von, zeitraum_bis, "
                + "fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, viertelstunden_gerechnet, "
                + "rechenwerk_version, vertrag_version, nachweis, pruefsumme) VALUES (?, ?, DATE '2026-10-01', "
                + "TIMESTAMPTZ '2026-09-30 22:00:00+00', TIMESTAMPTZ '2026-10-31 23:00:00+00', 1, ?, 'vorlaeufig', "
                + "'messstellenbetreiber', 2980, 384, 'test', 'test', '{}', ?)", a.mandant(), a.id(), formelsatz,
                "0".repeat(64));
    }

    /** Netz- und Speicherzähler mit Quelle und den Rollen Z1/Z1/Z2/Z2 über die Route des Registers. */
    private void zaehlerGewerbe(Anlage a, String bezug, String abgabe, String laden, String entladen, String zp)
            throws Exception {
        UUID netz = komponente(a, "grid-meter", "Netzzähler");
        UUID speicher = komponente(a, "battery-hybrid", "Speicher");
        Map<String, UUID> ms = new LinkedHashMap<>();
        ms.put(bezug, messstelle(a, bezug, "Bezug", "Hauptzähler", netz, "sunspec.model_203.totwhimp"));
        ms.put(abgabe, messstelle(a, abgabe, "Abgabe", "Hauptzähler", netz, "sunspec.model_203.totwhexp"));
        ms.put(laden, messstelle(a, laden, "Laden", "Speicher", speicher, "battery.charge-energy"));
        ms.put(entladen, messstelle(a, entladen, "Entladen", "Speicher", speicher, "battery.discharge-energy"));
        rollen(a, ms, zp);
    }

    /** Die ersten beiden Messstellen werden Z1, die anderen Z2 — wie {@code DemoMispelAufbau#rolle}. */
    private void rollen(Anlage a, Map<String, UUID> ms, String zp) throws Exception {
        int i = 0;
        for (UUID m : ms.values()) {
            String rolle = i++ < 2 ? "Z1" : "Z2";
            String punkt = "DE00012345000000000000000000" + zp + (rolle.equals("Z1") ? "001" : "002");
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("rolle", rolle);
            body.put("zaehlpunkt", punkt);
            body.put("messstellenbetreiber", "Stadtwerke Demo Messstellenbetrieb");
            body.put("eichstatus", "eichrechtskonform");
            body.put("eichfrist_bis", "2034-12-31");
            body.put("wertequelle", "messstellenbetreiber");
            body.put("gueltig_ab", AB);
            MvcResult r = mvc.perform(request(HttpMethod.PUT, "/api/v1/messstellen/" + m + "/zaehlerrolle")
                    .with(token(a, "sub-mispel-weg-" + a.mandant(), false)).contentType(MediaType.APPLICATION_JSON)
                    .content(MAPPER.writeValueAsString(body))).andReturn();
            assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8))
                    .isEqualTo(200);
        }
    }

    private static UUID komponente(Anlage a, String typ, String label) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, "
                + "'{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb, '2025-12-01') RETURNING id",
                UUID.class, a.mandant(), a.id(), typ, label, typ, a.box());
    }

    /** Eine gemessene Messstelle an der Anlage mit Stellung und führender Quelle an der Komponente. */
    private static UUID messstelle(Anlage a, String kz, String richtung, String stellung, UUID komponente,
            String kanal) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, a.mandant(), kz, kz, richtung);
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, ?, NULL, ?::date)", a.mandant(), ms, a.id(), stellung, AB);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, ?::timestamptz, "
                + "'2026.09.11.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point "
                + "WHERE id = ? ON CONFLICT DO NOTHING", a.mandant(), a.box(), komponente, kanal, AB, komponente);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "?::timestamptz, true, now(), 'sub-test', 'Test', 'kunde')", a.mandant(), ms, richtung, komponente,
                geraet, kanal, AB);
        return ms;
    }

    private static UUID standort(Anlage a, UUID unternehmen, String kurz, UUID site) {
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, a.mandant(),
                unternehmen, "Standort " + kurz, kurz);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2026-01-01')", a.mandant(), site, st);
        return st;
    }

    private static void leser(Anlage a, String sub, UUID standort) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                + "'Leser', 'aktiv')", a.mandant(), sub);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) VALUES "
                + "(?, ?, 'leser', ?, '2026-01-01 00:00:00+01', 'Europe/Berlin')", a.mandant(), sub, standort);
    }

    // ------------------------------------------------------------------ Rufen

    private Antwort ruf(Anlage als, UUID site) throws Exception {
        return ruf(token(als, "sub-mispel-weg-" + als.mandant(), false), site);
    }

    private Antwort rufAls(Anlage als, String sub, UUID site) throws Exception {
        return ruf(token(als, sub, true), site);
    }

    private static org.springframework.test.web.servlet.request.RequestPostProcessor token(Anlage als, String sub,
            boolean konto) {
        var t = jwt().jwt(j -> {
            j.subject(sub);
            j.claim("name", "Mara Test");
            j.claim("tenant_id", als.mandant().toString());
        });
        if (konto) {
            t.authorities(new SimpleGrantedAuthority(KeycloakRealmRoleConverter.KONTO_BENUTZER));
        }
        return t;
    }

    private Antwort ruf(org.springframework.test.web.servlet.request.RequestPostProcessor token, UUID site)
            throws Exception {
        MockHttpServletRequestBuilder anfrage = request(HttpMethod.GET, "/api/v1/sites/" + site + "/mispel-weg")
                .with(token);
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
