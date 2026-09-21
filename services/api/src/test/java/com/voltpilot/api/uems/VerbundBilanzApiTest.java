package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.VerbundBilanzMetrikRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Verbund-Bilanz über den echten Weg (UEMS AP-15 IP-12, Prüfnachweis der §8-Zelle): Messstellen mit
 * Viertelstunden (AP-08) → Lauf → gespeichertes Ergebnis → Folge an der Stufe → Auskunft im
 * {@code GET …/gemeinsame-steuerung} → Metrik-Stand. R1 am Sonntag 13.06.2027: Netzpunkt 98 kW Einspeisung, PV Halle 1
 * (E-1, führt) 83 kW, Abgang Verwaltung (E-4, DQ-10) 55 kW — das Ungeregelte ist die Last 40 kW.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VerbundBilanzApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String KANAL = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final LocalDate TAG = LocalDate.parse("2027-06-13");
    private static final String BEGINN = "2027-06-12T22:00:00Z";
    private static final String ENDE = "2027-06-13T21:45:00Z";

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

    @Autowired
    MockMvc mvc;

    @Autowired
    VerbundBilanzService bilanz;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @Autowired
    VerbundBilanzMetrikRepository metrik;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Anlage AN-1 mit E-1 (führt, DQ-2 Netzzähler) und E-4 (steuert mit, DQ-10 Abgang); Komponenten je Messstelle. */
    private record Welt(UUID mandant, UUID an1, UUID verbund, UUID netz, UUID pv, UUID abgang) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    // ============================================================================ die Fälle der Zelle

    @Test
    void r1IstPlausibelDieStufeBleibtUndDieAuskunftSagtSeitWann() throws Exception {
        Welt w = welt("anteile_aktiv");

        assertThat(laeufer().lauf(TAG)).isGreaterThanOrEqualTo(1);

        Map<String, Object> e = ergebnis(w);
        assertThat(e.get("zustand")).isEqualTo("plausibel");
        assertThat(e.get("grund")).isNull();
        assertThat(e.get("viertelstunden_erwartet")).isEqualTo(96);
        assertThat(e.get("viertelstunden_plausibel")).isEqualTo(96);
        assertThat((java.math.BigDecimal) e.get("geringstes_ungeregeltes_kw")).isEqualByComparingTo("40");
        assertThat((java.math.BigDecimal) root.queryForObject("SELECT hoechstes_ungeregeltes_kw FROM "
                + "steuerungsverbund_bilanz WHERE site_id = ? AND tag = ?", java.math.BigDecimal.class, w.an1(), TAG))
                .as("IP-13: der Höchstwert des Ungeregelten").isEqualByComparingTo("40");
        assertThat(e.get("stufe_vorher")).isEqualTo("anteile_aktiv");
        assertThat(e.get("auf_s1_zurueck")).isEqualTo(false);
        assertThat(e.get("gerechnet_von")).isEqualTo("Verbund-Bilanz");
        JsonNode grundlage = MAPPER.readTree((String) e.get("grundlage"));
        assertThat(grundlage.path("fassung").asText()).isEqualTo(VerbundBilanzRegel.FASSUNG);
        assertThat(grundlage.path("netzpunkt").get(0).path("richtung").asText()).isEqualTo("Abgabe");
        assertThat(grundlage.path("boxen").get(0).path("beitrag").asText()).isEqualTo("geraetesumme");
        assertThat(grundlage.path("boxen").get(1).path("terme").get(0).path("kennzeichen").asText())
                .startsWith("MS-AB");
        assertThat(stufe(w)).isEqualTo("anteile_aktiv");
        assertThat(stufenwechsel(w)).isZero();

        JsonNode z = lesen(w);
        assertThat(z.path("bilanz").path("zustand").asText()).isEqualTo("plausibel");
        assertThat(z.path("bilanz").path("tag").asText()).isEqualTo("2027-06-13");
        assertThat(z.path("bilanz").path("seit").asText()).isEqualTo("2027-06-13");
        assertThat(z.path("bilanz").path("grund").isNull()).isTrue();

        assertThat(metrik.staende()).contains(new VerbundBilanzMetrikRepository.Stand(w.mandant(), w.an1(),
                "plausibel"));
        SimpleMeterRegistry reg = new SimpleMeterRegistry();
        new com.voltpilot.api.metrics.VerbundBilanzMetrik(metrik, reg).collect();
        assertThat(reg.get("voltpilot_uems_verbund_bilanz_zustand").tags("site", w.an1().toString(), "zustand",
                "plausibel").gauge().value()).isEqualTo(1d);
        assertThat(reg.get("voltpilot_uems_verbund_bilanz_zustand").tags("site", w.an1().toString(), "zustand",
                "unplausibel").gauge().value()).isEqualTo(0d);
    }

    @Test
    void versteckterErzeugerIstUnplausibelUndFuehrtAufS1DieAnteileBleiben() throws Exception {
        Welt w = welt("anteile_aktiv");
        // R19-Lage mittags zwei Stunden: 60 kW eines nie eingetragenen Erzeugers; E-1 regelt den Netzpunkt weiter auf
        // 98 kW, ihre PV fällt auf 23 kW — am Netzpunkt fehlt, was die Boxen zusammen einspeisen müssten.
        assertThat(root.update("UPDATE messreihe_viertelstunde SET menge = 5.75 WHERE entity_id = ? "
                + "AND intervall_beginn >= ? AND intervall_beginn < ?", w.pv(), ts("2027-06-13T10:00:00Z"),
                ts("2027-06-13T12:00:00Z"))).isEqualTo(8);
        List<Map<String, Object>> mitgliederVorher = mitglieder(w);

        laeufer().lauf(TAG);

        Map<String, Object> e = ergebnis(w);
        assertThat(e.get("zustand")).isEqualTo("unplausibel");
        assertThat(e.get("viertelstunden_unplausibel")).isEqualTo(8);
        assertThat((java.math.BigDecimal) e.get("geringstes_ungeregeltes_kw")).isEqualByComparingTo("-20");
        assertThat(e.get("auf_s1_zurueck")).isEqualTo(true);
        assertThat(stufe(w)).isEqualTo("beobachtet");
        assertThat(epoche(w)).as("die Anteile bleiben in Kraft: keine neue Epoche").isEqualTo(1L);
        assertThat(mitglieder(w)).as("Mitglieder und Messpunkte unverändert").isEqualTo(mitgliederVorher);
        Map<String, Object> p = root.queryForMap("SELECT alt::text AS alt, neu::text AS neu, grund, actor_name, "
                + "actor_art, actor_sub FROM steuerungsverbund_aenderung WHERE site_id = ? AND art = 'stufe'", w.an1());
        assertThat(p.get("alt")).isEqualTo("\"anteile_aktiv\"");
        assertThat(p.get("neu")).isEqualTo("\"beobachtet\"");
        assertThat(p.get("grund")).isEqualTo("verbund_bilanz_unplausibel 2027-06-13");
        assertThat(p.get("actor_name")).isEqualTo("Verbund-Bilanz");
        assertThat(p.get("actor_art")).isEqualTo("voltpilot");
        assertThat(p.get("actor_sub")).isNull();
        assertThat(lesen(w).path("bilanz").path("zustand").asText()).isEqualTo("unplausibel");
        assertThat(lesen(w).path("zustand").asText()).isEqualTo("beobachtet");

        laeufer().lauf(TAG);
        assertThat(zeilen(w)).as("ein Tag wird genau einmal gerechnet").isEqualTo(1L);
        assertThat(stufenwechsel(w)).isEqualTo(1L);
    }

    @Test
    void lueckeIstUnbekanntNiePlausibelUndDieStufeBleibt() {
        Welt w = welt("anteile_aktiv");
        assertThat(root.update("DELETE FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn = ?",
                w.abgang(), ts("2027-06-13T11:00:00Z"))).isEqualTo(1);

        laeufer().lauf(TAG);

        Map<String, Object> e = ergebnis(w);
        assertThat(e.get("zustand")).isEqualTo("unbekannt");
        assertThat(e.get("grund")).isEqualTo("luecke");
        assertThat(e.get("viertelstunden_unbekannt")).isEqualTo(1);
        assertThat(e.get("auf_s1_zurueck")).isEqualTo(false);
        assertThat(stufe(w)).isEqualTo("anteile_aktiv");
        assertThat(stufenwechsel(w)).isZero();
    }

    /**
     * IP-13 (W10): der Höchstwert des Ungeregelten für den Vorbehalt aus Messwerten kommt nur aus BELEGTEN
     * Viertelstunden. 11:00 ist unvollständig (Netzzähler 0 kWh — gezählt wären es 138 kW), 12:00 vollständig mit
     * 80 kW Einspeisung am Netzpunkt → 58 kW; alle übrigen 40 kW.
     */
    @Test
    void unvollstaendigeViertelstundeZaehltNichtFuerDenHoechstwert() {
        Welt w = welt("anteile_aktiv");
        assertThat(root.update("UPDATE messreihe_viertelstunde SET menge = 0, menge_zustand = 'unvollständig', "
                + "erhalten = 3 WHERE entity_id = ? AND intervall_beginn = ?", w.netz(), ts("2027-06-13T11:00:00Z")))
                .isEqualTo(1);
        assertThat(root.update("UPDATE messreihe_viertelstunde SET menge = 20 WHERE entity_id = ? "
                + "AND intervall_beginn = ?", w.netz(), ts("2027-06-13T12:00:00Z"))).isEqualTo(1);

        laeufer().lauf(TAG);

        Map<String, Object> e = root.queryForMap("SELECT zustand, grund, hoechstes_ungeregeltes_kw, hoechstes_von "
                + "FROM steuerungsverbund_bilanz WHERE site_id = ? AND tag = ?", w.an1(), TAG);
        assertThat(e.get("zustand")).isEqualTo("unbekannt");
        assertThat(e.get("grund")).isEqualTo("luecke");
        assertThat((java.math.BigDecimal) e.get("hoechstes_ungeregeltes_kw")).isEqualByComparingTo("58");
        assertThat(((Timestamp) e.get("hoechstes_von")).toInstant()).isEqualTo(Instant.parse("2027-06-13T12:00:00Z"));
    }

    @Test
    void unplausibelAufS1BleibtS1OhneProtokoll() {
        Welt w = welt("beobachtet");
        root.update("UPDATE messreihe_viertelstunde SET menge = 5.75 WHERE entity_id = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?", w.pv(), ts("2027-06-13T10:00:00Z"), ts("2027-06-13T12:00:00Z"));

        laeufer().lauf(TAG);

        assertThat(ergebnis(w).get("zustand")).isEqualTo("unplausibel");
        assertThat(ergebnis(w).get("auf_s1_zurueck")).isEqualTo(false);
        assertThat(stufe(w)).isEqualTo("beobachtet");
        assertThat(stufenwechsel(w)).isZero();
    }

    @Test
    void ohneGemeinsameSteuerungKeinLaufKeineZeileKeineReihe() throws Exception {
        Welt w = weltOhneVerbund();

        laeufer().lauf(TAG);

        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_bilanz WHERE tenant_id = ?",
                Long.class, w.mandant())).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund WHERE tenant_id = ?", Long.class,
                w.mandant())).isZero();
        assertThat(metrik.staende()).noneMatch(s -> s.tenantId().equals(w.mandant()));
        JsonNode z = lesen(w);
        assertThat(z.path("eingerichtet").asBoolean()).isFalse();
        assertThat(z.path("bilanz").isNull()).isTrue();
    }

    // ============================================================================ Gerüst

    private VerbundBilanzLaeufer laeufer() {
        return new VerbundBilanzLaeufer(admin, bilanz);
    }

    private Welt welt(String stufe) {
        Welt w = weltOhneVerbund();
        UUID v = root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id, stufe, epoche, created_by) "
                + "VALUES (?, ?, ?, 1, 'test') RETURNING id", UUID.class, w.mandant(), w.an1(), stufe);
        UUID e1 = root.queryForObject("SELECT device_id FROM measurement_point WHERE id = ?", UUID.class, w.netz());
        UUID e4 = root.queryForObject("SELECT device_id FROM measurement_point WHERE id = ?", UUID.class, w.abgang());
        UUID dq2 = root.queryForObject("SELECT data_source_id FROM measurement_point WHERE id = ?", UUID.class, w.netz());
        UUID dq10 = root.queryForObject("SELECT data_source_id FROM measurement_point WHERE id = ?", UUID.class,
                w.abgang());
        mitglied(w, v, e1, "fuehrt", dq2);
        mitglied(w, v, e4, "steuert_mit", dq10);
        return new Welt(w.mandant(), w.an1(), v, w.netz(), w.pv(), w.abgang());
    }

    private Welt weltOhneVerbund() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Verbund-Bilanz #" + nr);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", t);
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        UUID e1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an1, "E-1-BILANZ-" + nr);
        UUID e4 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an1, "E-4-BILANZ-" + nr);
        UUID dq2 = quelle(t, an1, "DQ-2", "10.0.1.2:502", e1);
        UUID dq10 = quelle(t, an1, "DQ-10", "10.0.4.10:502", e4);
        // 98 kW Einspeisung = 24,5 kWh · 83 kW PV = 20,75 kWh · 55 kW Abgang = 13,75 kWh je Viertelstunde.
        UUID netz = messstelle(t, an1, e1, dq2, "MS-NZ-" + nr, "Abgabe", "24.5");
        UUID pv = messstelle(t, an1, e1, null, "MS-PV-" + nr, "Erzeugung", "20.75");
        UUID abgang = messstelle(t, an1, e4, dq10, "MS-AB-" + nr, "Abgabe", "13.75");
        return new Welt(t, an1, null, netz, pv, abgang);
    }

    private static UUID quelle(UUID t, UUID site, String kennzeichen, String adresse, UUID box) {
        UUID dq = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, '{1}', 10) RETURNING id", UUID.class, t,
                site, kennzeichen, adresse);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT tenant_id, id, ?, protokoll, adresse, TIMESTAMPTZ '2027-01-01T00:00:00Z' "
                + "FROM data_source WHERE id = ?", box, dq);
        return dq;
    }

    /** Komponente an der Box (und Quelle), Mess-Selektion, Messstelle Wirkenergie der Richtung, Viertelstunden. */
    private static UUID messstelle(UUID t, UUID site, UUID box, UUID quelle, String kennzeichen, String richtung,
            String kwh) {
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, data_source_id, communication, connection_json, created_at) VALUES (?, ?, "
                + "'modbus-generic', ?, 'modbus-generic', ?, ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id",
                UUID.class, t, site, "Zähler " + kennzeichen, box, quelle, ts("2020-01-01T00:00:00Z"));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, site, box, komponente, KANAL, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Zähler " + kennzeichen, richtung);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie',?,?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, ms, richtung, komponente, geraet, KANAL, ts("2027-01-01T00:00:00Z"), ts("2027-01-01T00:01:00Z"));
        assertThat(root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, entity_id, messkanal, "
                + "erhalten, erwartet, kadenz_s, kadenz_herkunft, endgueltig_ab, wertart, menge, menge_zustand) "
                + "SELECT q, ?, ?, ?, 15, 15, 60, 'auswahl', q + interval '10095 minutes', 'counter', ?::numeric, "
                + "'vollständig' FROM generate_series(?::timestamptz, ?::timestamptz, interval '15 minutes') AS q", t,
                komponente, KANAL, kwh, BEGINN, ENDE)).isEqualTo(96);
        return komponente;
    }

    private static void mitglied(Welt w, UUID verbund, UUID box, String rolle, UUID quelle) {
        root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, "
                + "rolle, data_source_id, gueltig_ab, created_by) VALUES (?, ?, ?, ?, ?, ?, "
                + "TIMESTAMPTZ '2026-01-01T00:00:00Z', 'test')", w.mandant(), verbund, w.an1(), box, rolle, quelle);
    }

    private static Map<String, Object> ergebnis(Welt w) {
        return root.queryForMap("SELECT zustand, grund, viertelstunden_erwartet, viertelstunden_plausibel, "
                + "viertelstunden_unplausibel, viertelstunden_unbekannt, geringstes_ungeregeltes_kw, grundlage::text "
                + "AS grundlage, stufe_vorher, auf_s1_zurueck, gerechnet_von FROM steuerungsverbund_bilanz "
                + "WHERE site_id = ? AND tag = ?", w.an1(), TAG);
    }

    private static long zeilen(Welt w) {
        return root.queryForObject("SELECT count(*) FROM steuerungsverbund_bilanz WHERE site_id = ?", Long.class,
                w.an1());
    }

    private static String stufe(Welt w) {
        return root.queryForObject("SELECT stufe FROM steuerungsverbund WHERE site_id = ?", String.class, w.an1());
    }

    private static long epoche(Welt w) {
        return root.queryForObject("SELECT epoche FROM steuerungsverbund WHERE site_id = ?", Long.class, w.an1());
    }

    private static long stufenwechsel(Welt w) {
        return root.queryForObject("SELECT count(*) FROM steuerungsverbund_aenderung WHERE site_id = ? "
                + "AND art = 'stufe'", Long.class, w.an1());
    }

    private static List<Map<String, Object>> mitglieder(Welt w) {
        return root.queryForList("SELECT id, device_id, rolle, data_source_id, gueltig_ab, gueltig_bis, aufgehoben_am "
                + "FROM steuerungsverbund_mitglied WHERE site_id = ? ORDER BY id", w.an1());
    }

    private static Timestamp ts(String zeit) {
        return Timestamp.from(Instant.parse(zeit));
    }

    private JsonNode lesen(Welt w) throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/sites/" + w.an1() + "/gemeinsame-steuerung").with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(200);
        return MAPPER.readTree(text);
    }
}
