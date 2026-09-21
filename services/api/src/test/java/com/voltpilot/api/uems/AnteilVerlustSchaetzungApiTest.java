package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.forecast.ForecastModels;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
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
 * Die Schätzung des Anteils-Verlusts über den echten Weg (Folgepaket zu AP-15 IP-22, E1 = A, R2): die Box meldet die
 * Untergrenze und {@code gebunden_s} ({@code steuerungsverbund_anteil_verlust}); der Takt der Verbund-Bilanz
 * ({@link VerbundBilanzLaeufer#schaetzen}) rechnet aus PV-Prognose × kWp-Teil minus gemessener PV der Box die
 * Schätzung (V20260922130000); Kunden-GET, Betreiber-Blatt und Pilot-Bericht lesen sie getrennt von der Untergrenze.
 *
 * <p>R2: klarer Junitag, Box Verwaltung (E-4) hält 30 kW, 9 h gebunden, ihre PV 57 kW Spitze (Halbsinus 06:00–20:00).
 * Die Anlagen-Prognose ist 95 kW Spitze, E-4 trägt 60 von 100 kWp — ihr Teil also 57 kW. Die Box meldet im Feld
 * ≈ 0 kWh (sie kennt die verfügbare Erzeugung nicht).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AnteilVerlustSchaetzungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

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
    AnteilVerlustSchaetzung schaetzung;

    @Autowired
    ForecastModelService modelle;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID an1, UUID e1, UUID e4) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private VerbundBilanzLaeufer laeufer() {
        VerbundBilanzLaeufer l = new VerbundBilanzLaeufer(admin, bilanz);
        l.schaetzung(schaetzung);
        return l;
    }

    private static LocalDate gestern() {
        return LocalDate.now(AnteilVerlustAusHerzschlag.ZONE).minusDays(1);
    }

    @Test
    void r2SchaetzungAusDerPrognoseNebenDerUntergrenzeDerBoxUndNachrechnenIstIdempotent() throws Exception {
        Welt w = welt(true);
        LocalDate tag = gestern();
        prognose(w, tag);
        messung(w, tag);
        meldet(w, w.e4(), tag, "0.0", 32_400);

        assertThat(laeufer().schaetzen(tag)).isGreaterThanOrEqualTo(1);
        Map<String, Object> z = zeile(w.e4(), tag);
        assertThat(z.get("schaetzung_grundlage")).isEqualTo(AnteilVerlustSchaetzung.PROGNOSE);
        // Referenz 160,2 kWh; die Schätzung trifft sie auf 0,011 kWh (160,211 — die Referenz ist gerundet)
        assertThat((BigDecimal) z.get("schaetzung_kwh")).isEqualByComparingTo("160.211");
        // die Untergrenze bleibt, was die Box meldet
        assertThat((BigDecimal) z.get("verlust_kwh")).isEqualByComparingTo("0.0");
        assertThat(z.get("gebunden_s")).isEqualTo(32_400);

        // nachrechnen: derselbe Datenstand, dieselbe Zahl, keine neue Zeile
        Object gemeldet = z.get("gemeldet_am");
        laeufer().schaetzen(tag);
        laeufer().schaetzen(tag.plusDays(1));
        Map<String, Object> z2 = zeile(w.e4(), tag);
        assertThat((BigDecimal) z2.get("schaetzung_kwh")).isEqualByComparingTo("160.211");
        assertThat(z2.get("gemeldet_am")).isEqualTo(gemeldet);
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_anteil_verlust WHERE site_id = ?",
                Integer.class, w.an1())).isEqualTo(1);

        // eine verspätete kleinere Meldung der Box senkt nichts (GREATEST) — die Schätzung bleibt daneben stehen
        meldet(w, w.e4(), tag, "0.0", 3600);
        assertThat(zeile(w.e4(), tag).get("gebunden_s")).isEqualTo(32_400);

        // Betreiber-Blatt: je Box der gestrige Tag, Untergrenze und Schätzung getrennt
        Antwort blatt = plattform(w, get("/api/v1/admin/sites/" + w.an1() + "/gemeinsame-steuerung"));
        assertThat(blatt.status()).as(blatt.body().toString()).isEqualTo(200);
        JsonNode e4 = box(blatt.body(), w.e4()).get("verlust_gestern");
        assertThat(e4.get("tag").asText()).isEqualTo(tag.toString());
        assertThat(e4.get("verlust_kwh").decimalValue()).isEqualByComparingTo("0.0");
        assertThat(e4.get("schaetzung_kwh").decimalValue()).isEqualByComparingTo("160.211");
        assertThat(e4.get("schaetzung_grundlage").asText()).isEqualTo("prognose");
        assertThat(box(blatt.body(), w.e1()).get("verlust_gestern").isNull()).isTrue();

        // Kunden-GET: schaetzung_kwh additiv in der Monatssumme (heute ist nie geschätzt)
        Antwort kunde = kunde(w, get("/api/v1/sites/" + w.an1() + "/gemeinsame-steuerung"));
        assertThat(kunde.status()).isEqualTo(200);
        JsonNode verlust = mitglied(kunde.body(), w.e4()).get("anteil_verlust");
        if (tag.getMonth() == LocalDate.now(AnteilVerlustAusHerzschlag.ZONE).getMonth()) {
            assertThat(verlust.get("monat").get("kwh").decimalValue()).isEqualByComparingTo("0.0");
            assertThat(verlust.get("monat").get("schaetzung_kwh").decimalValue()).isEqualByComparingTo("160.211");
            assertThat(verlust.get("monat").get("tage_geschaetzt").asInt()).isEqualTo(1);
        }

        // Pilot-Bericht: Summe der Untergrenze und Summe der Schätzung über den Zeitraum
        Antwort bericht = plattform(w, get("/api/v1/admin/sites/" + w.an1()
                + "/gemeinsame-steuerung/anteil-verlust?von=" + tag.minusDays(6) + "&bis=" + tag));
        assertThat(bericht.status()).as(bericht.body().toString()).isEqualTo(200);
        JsonNode summe = bericht.body().get("summe");
        assertThat(summe.get("verlust_kwh").decimalValue()).isEqualByComparingTo("0.0");
        assertThat(summe.get("schaetzung_kwh").decimalValue()).isEqualByComparingTo("160.211");
        assertThat(summe.get("gebunden_s").asLong()).isEqualTo(32_400);
        assertThat(summe.get("tage").asInt()).isEqualTo(1);
        assertThat(summe.get("tage_geschaetzt").asInt()).isEqualTo(1);
        assertThat(bericht.body().get("boxen")).hasSize(1);
    }

    @Test
    void ohnePrognoseKeineUndKeinWertUnbekanntIstKeineNull() throws Exception {
        Welt w = welt(true);
        LocalDate tag = gestern();
        messung(w, tag);
        meldet(w, w.e4(), tag, "1.5", 32_400);

        laeufer().schaetzen(tag);
        Map<String, Object> z = zeile(w.e4(), tag);
        assertThat(z.get("schaetzung_grundlage")).isEqualTo(AnteilVerlustSchaetzung.KEINE);
        assertThat(z.get("schaetzung_kwh")).isNull();

        Antwort bericht = plattform(w, get("/api/v1/admin/sites/" + w.an1()
                + "/gemeinsame-steuerung/anteil-verlust?von=" + tag + "&bis=" + tag));
        JsonNode summe = bericht.body().get("summe");
        assertThat(summe.get("verlust_kwh").decimalValue()).isEqualByComparingTo("1.5");
        assertThat(summe.get("schaetzung_kwh").isNull()).isTrue();
        assertThat(summe.get("tage_ohne_prognose").asInt()).isEqualTo(1);
    }

    @Test
    void ohneGemeinsameSteuerungKeineZeileUndKeinLauf() throws Exception {
        // eine Ein-Box-Anlage ohne Gemeinsame Steuerung, mit Prognose und Messung: der Takt betritt sie nicht (I6)
        Welt w = welt(false);
        LocalDate tag = gestern();
        prognose(w, tag);
        messung(w, tag);
        laeufer().schaetzen(tag);
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_anteil_verlust WHERE site_id = ?",
                Integer.class, w.an1())).isZero();

        Antwort bericht = plattform(w, get("/api/v1/admin/sites/" + w.an1()
                + "/gemeinsame-steuerung/anteil-verlust?von=" + tag + "&bis=" + tag));
        assertThat(bericht.status()).isEqualTo(200);
        assertThat(bericht.body().get("boxen")).isEmpty();
        assertThat(bericht.body().get("summe").isNull()).isTrue();
    }

    @Test
    void pilotBerichtNurPlattformFremdeAnlage404UnlesbarerTag400() throws Exception {
        Welt w = welt(true);
        Welt fremd = welt(true);
        LocalDate tag = gestern();
        String pfad = "/gemeinsame-steuerung/anteil-verlust?von=" + tag + "&bis=" + tag;

        assertThat(kunde(w, get("/api/v1/admin/sites/" + w.an1() + pfad)).status()).isEqualTo(403);
        assertThat(plattform(w, get("/api/v1/admin/sites/" + fremd.an1() + pfad)).status()).isEqualTo(404);
        assertThat(plattform(w, get("/api/v1/admin/sites/" + w.an1()
                + "/gemeinsame-steuerung/anteil-verlust?von=gestern&bis=" + tag)).status()).isEqualTo(400);
        assertThat(plattform(w, get("/api/v1/admin/sites/" + w.an1()
                + "/gemeinsame-steuerung/anteil-verlust?von=" + tag + "&bis=" + tag.minusDays(1))).status())
                .isEqualTo(400);
        assertThat(plattform(w, get("/api/v1/admin/sites/" + w.an1()
                + "/gemeinsame-steuerung/anteil-verlust?von=" + tag.minusDays(366) + "&bis=" + tag)).status())
                .isEqualTo(400);
    }

    @Test
    void neueSpaltenMitCheckUndOhneNeueRechte() {
        assertThatThrows("INSERT INTO steuerungsverbund_anteil_verlust (tenant_id, site_id, device_id, tag, "
                + "verlust_kwh, gebunden_s, schaetzung_kwh, schaetzung_grundlage) SELECT tenant_id, site_id, id, "
                + "DATE '2026-06-17', 0, 0, 1.0, 'keine' FROM device LIMIT 1");
        assertThatThrows("INSERT INTO steuerungsverbund_anteil_verlust (tenant_id, site_id, device_id, tag, "
                + "verlust_kwh, gebunden_s, schaetzung_kwh, schaetzung_grundlage) SELECT tenant_id, site_id, id, "
                + "DATE '2026-06-17', 0, 0, NULL, 'prognose' FROM device LIMIT 1");
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'steuerungsverbund_anteil_verlust', 'DELETE')",
                Boolean.class, APP_USER)).isFalse();
    }

    // ============================================================================ Aufbau

    private static void assertThatThrows(String sql) {
        welt0();
        try {
            root.update(sql);
        } catch (RuntimeException e) {
            assertThat(e.getMessage()).contains("steuerungsverbund_anteil_verlust_schaetzung_chk");
            return;
        }
        throw new AssertionError("CHECK hätte ablehnen müssen: " + sql);
    }

    /** Mindestens ein Gerät für die CHECK-Proben. */
    private static void welt0() {
        if (root.queryForObject("SELECT count(*) FROM device", Integer.class) == 0) {
            UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('CHECK') RETURNING id", UUID.class);
            UUID s = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'CHECK') RETURNING id",
                    UUID.class, t);
            root.update("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, 'CHECK-1')", t, s);
        }
    }

    /** Halbsinus 06:00–20:00 (Anlagen-Zeit), Wert zur Viertelstunden-Mitte. */
    private static double pvAnlage(int i) {
        return 95.0 * Math.sin(Math.PI * ((i + 0.5) * 0.25) / 14.0);
    }

    private static Instant slot(LocalDate tag, int i) {
        return tag.atTime(6, 0).atZone(AnteilVerlustAusHerzschlag.ZONE).toInstant().plusSeconds(900L * i);
    }

    /**
     * Drei Läufe des aktiven PV-Modells: ein älterer (halb so viel), der jüngste VOR dem Tag (R2), und einer NACH dem
     * Tag (doppelt) — gilt nur der jüngste Lauf vor dem Zeitpunkt, kommt R2 heraus.
     */
    private void prognose(Welt w, LocalDate tag) {
        String modell;
        try {
            TenantContext.set(w.mandant());
            modell = modelle.activeModels(w.an1()).get(ForecastModels.KIND_PV);
        } finally {
            TenantContext.clear();
        }
        Instant alt = tag.minusDays(2).atStartOfDay(AnteilVerlustAusHerzschlag.ZONE).toInstant();
        Instant vorher = tag.minusDays(1).atTime(12, 0).atZone(AnteilVerlustAusHerzschlag.ZONE).toInstant();
        Instant nachher = tag.plusDays(1).atTime(12, 0).atZone(AnteilVerlustAusHerzschlag.ZONE).toInstant();
        for (int i = 0; i < 56; i++) {
            Instant t = slot(tag, i);
            for (Object[] lauf : new Object[][] {{alt, 0.5}, {vorher, 1.0}, {nachher, 2.0}}) {
                Instant runAt = (Instant) lauf[0];
                root.update("INSERT INTO forecast (time, tenant_id, site_id, kind, model, value_kw, run_at, "
                        + "horizon_min, method) VALUES (?, ?, ?, 'pv', ?, ?, ?, ?, 'test')", Timestamp.from(t),
                        w.mandant(), w.an1(), modell, pvAnlage(i) * (double) lauf[1], Timestamp.from(runAt),
                        (int) ((t.getEpochSecond() - runAt.getEpochSecond()) / 60));
            }
        }
    }

    /** E-4 misst ihre PV (60 % der Anlage), gehalten auf 30 kW; E-1 misst ihre volle PV. Zwei Proben je Viertelstunde. */
    private void messung(Welt w, LocalDate tag) {
        for (int i = 0; i < 56; i++) {
            double e4 = pvAnlage(i) * 0.6;
            for (int s : new int[] {120, 600}) {
                Timestamp t = Timestamp.from(slot(tag, i).plusSeconds(s));
                root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) "
                        + "VALUES (?, ?, ?, ?, ?)", t, w.mandant(), w.an1(), w.e4(), Math.min(e4, 30.0));
                root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) "
                        + "VALUES (?, ?, ?, ?, ?)", t, w.mandant(), w.an1(), w.e1(), pvAnlage(i) * 0.4);
            }
        }
    }

    /** Wie {@link AnteilVerlustRepository#melde}: das Größere gilt. */
    private void meldet(Welt w, UUID box, LocalDate tag, String kwh, int s) {
        root.update("INSERT INTO steuerungsverbund_anteil_verlust (tenant_id, site_id, device_id, tag, verlust_kwh, "
                + "gebunden_s) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, tag) DO UPDATE SET "
                + "verlust_kwh = GREATEST(steuerungsverbund_anteil_verlust.verlust_kwh, EXCLUDED.verlust_kwh), "
                + "gebunden_s = GREATEST(steuerungsverbund_anteil_verlust.gebunden_s, EXCLUDED.gebunden_s)",
                w.mandant(), w.an1(), box, tag, new BigDecimal(kwh), s);
    }

    private static Map<String, Object> zeile(UUID box, LocalDate tag) {
        List<Map<String, Object>> z = root.queryForList(
                "SELECT * FROM steuerungsverbund_anteil_verlust WHERE device_id = ? AND tag = ?", box, tag);
        assertThat(z).hasSize(1);
        return z.get(0);
    }

    private Welt welt(boolean mitVerbund) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Verlust-Schätzung #" + nr);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", t);
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        UUID e1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an1, "E-1-SCHAETZUNG-" + nr);
        UUID e4 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an1, "E-4-SCHAETZUNG-" + nr);
        root.update("INSERT INTO asset (tenant_id, site_id, device_id, type, pv_capacity_kwp) VALUES (?, ?, ?, 'pv', 40)",
                t, an1, e1);
        root.update("INSERT INTO asset (tenant_id, site_id, device_id, type, pv_capacity_kwp, is_primary) "
                + "VALUES (?, ?, ?, 'pv', 60, false)",
                t, an1, e4);
        if (mitVerbund) {
            UUID v = root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id, stufe, epoche, "
                    + "created_by) VALUES (?, ?, 'anteile_aktiv', 1, 'test') RETURNING id", UUID.class, t, an1);
            UUID dq2 = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                    + "adresse, geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-2', 'modbus_tcp', '10.0.1.2:502', '{1}', 10) "
                    + "RETURNING id", UUID.class, t, an1);
            root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                    + "effective_from) SELECT tenant_id, id, ?, protokoll, adresse, TIMESTAMPTZ '2026-01-01T00:00:00Z' "
                    + "FROM data_source WHERE id = ?", e1, dq2);
            for (Object[] m : new Object[][] {{e1, "fuehrt", dq2}, {e4, "steuert_mit", null}}) {
                root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, "
                        + "device_id, rolle, data_source_id, gueltig_ab, created_by) VALUES (?, ?, ?, ?, ?, ?, "
                        + "TIMESTAMPTZ '2026-01-01T00:00:00Z', 'test')", t, v, an1, m[0], m[1], m[2]);
            }
        }
        return new Welt(t, an1, e1, e4);
    }

    private static JsonNode mitglied(JsonNode zustand, UUID box) {
        for (JsonNode m : zustand.get("mitglieder")) {
            if (box.toString().equals(m.get("box_id").asText())) {
                return m;
            }
        }
        throw new AssertionError("kein Mitglied " + box + ": " + zustand);
    }

    private static JsonNode box(JsonNode blatt, UUID box) {
        for (JsonNode b : blatt.get("boxen")) {
            if (box.toString().equals(b.get("box_id").asText())) {
                return b;
            }
        }
        throw new AssertionError("keine Box " + box + ": " + blatt);
    }

    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        })));
    }

    private Antwort plattform(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.header("X-Tenant-Id", w.mandant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))));
    }

    private Antwort ruf(MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
