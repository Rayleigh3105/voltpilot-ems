package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Lauf;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Viertelstunde;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Vorgaben;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * MiSpeL MP-22 — Pilot-Durchstich im Simulator (E6 = D): ein Monat der Simulator-Anlage mit Z1/Z2 im Förderweg
 * „Marktprämie mit Abgrenzungsoption“ (A1) Ende zu Ende auf der Cloud-Seite.
 *
 * <p>Die Viertelstundenwerte stammen nicht aus einem Tagesprofil, sondern aus dem Optimierer: {@code
 * services/optimization/tests/fixtures/mispel-durchstich-2026-10.json} schreibt {@code
 * voltpilot_optimization.simulation.mispel_durchstich} — Mischbetrieb (MP-10/MP-11) mit Förderweg im Plan (MP-14), die
 * Box fährt die Pläne ungeklemmt ({@code edge-app/core/internal/plan/mispel_durchstich_test.go}), und das
 * Python-Rechenwerk (MP-9) hat (1)–(33) darauf exakt gerechnet. Hier läuft derselbe Monat durch den echten Monatslauf
 * (MP-8), den Nachweis (MP-16, CSV und PDF) und die Kundenansicht (MP-18): jede Menge ist genau die des Rechenwerks.
 *
 * <p>Die Werte sind Gerätewerte der Box (Wertequelle {@code geraet}): der Monat bleibt „vorläufig“ — keine
 * Mengenbestimmung ohne Werte des Messstellenbetreibers (T S. 28; MP-15 bringt den Import). Die Antwort der Route ist
 * zugleich die Fixture der Playwright-Bühne {@code e2e/mispel-durchstich.spec.ts}; neu schreiben mit {@code
 * -Dmispel.fixtures.schreiben=true}. Mit {@code -Dmispel.durchstich.ablage=<ordner>} legt der Lauf CSV und PDF ab.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MispelDurchstichSimulatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path SIMULATOR = Path.of("../optimization/tests/fixtures/mispel-durchstich-2026-10.json");
    private static final Path FIXTURE = Path.of("../../frontend/portal/e2e/mispel-durchstich-fixtures.json");
    private static final YearMonth OKTOBER = YearMonth.of(2026, 10);
    private static final Map<String, String> KENNZEICHEN = Map.of("MS-01", "Z1NB", "MS-02", "Z1NE", "MS-03", "Z2V",
            "MS-04", "Z2E");

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
    MispelAbgrenzungService dienst;

    private static JdbcTemplate root;
    private static JsonNode simulator;

    @BeforeAll
    static void verbinden() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        simulator = MAPPER.readTree(Files.readString(SIMULATOR));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    private record Welt(UUID mandant, UUID anlage) {}

    @Test
    void einMonatSimulatorAnlageLiefertInBerichtNachweisUndKarteDieMengenDesRechenwerks() throws Exception {
        Welt w = welt();
        JsonNode anlage = simulator.get("anlage");
        assertThat(anlage.get("foerderweg").asText()).isEqualTo("marktpraemie_abgrenzung");
        for (JsonNode plan : simulator.get("plaene")) {
            assertThat(plan.get("foerderweg").asText()).as(plan.get("tag").asText())
                    .isEqualTo("marktpraemie_abgrenzung");
            assertThat(plan.get("grid_charge_allowed").asBoolean()).isTrue();
        }
        assertThat(simulator.get("plaene")).hasSize(31);

        // Monatslauf (MP-8) nach Monatsende mit Formelsatz und AW-Regel des Förderwegs.
        Map<String, Object> foerderweg = root.queryForMap("SELECT formelsatz, aw_regel FROM site_foerderweg "
                + "WHERE site_id = ? AND gueltig_ab <= '2026-10-01' ORDER BY gueltig_ab DESC LIMIT 1", w.anlage());
        Lauf lauf = lauf(w, Vorgaben.von((String) foerderweg.get("formelsatz"), (String) foerderweg.get("aw_regel")));
        assertThat(lauf.zeile().stand()).isEqualTo("vorlaeufig");
        assertThat(lauf.gruende()).contains("wertequelle_geraet");
        assertThat(lauf.zeile().viertelstundenGerechnet()).isEqualTo(2980);

        // Mengen = Rechenwerk: jede Formel (1)–(33) des Monats exakt wie das Python-Rechenwerk der Simulation.
        Map<String, Bruch> soll = soll();
        Map<String, Bruch> ist = lauf.ergebnis().monate().get("2026-10");
        assertThat(ist.keySet()).containsExactlyElementsOf(soll.keySet());
        for (Map.Entry<String, Bruch> e : soll.entrySet()) {
            assertThat(ist.get(e.getKey())).as(e.getKey()).isEqualTo(e.getValue());
        }
        // … und wie das Java-Rechenwerk unmittelbar auf denselben Viertelstunden.
        assertThat(MispelAbgrenzungRechenwerk.rechne("A1", viertelstunden(), null, null, Set.of()).monate().get("2026-10"))
                .isEqualTo(ist);

        // Nachweis (MP-16): CSV mit wert_exakt je Formel, PDF als Vorschau mit Wasserzeichen.
        MockHttpServletResponse csv = antwort(w, "/monate/2026-10/nachweis.csv?empfaenger=netzbetreiber");
        assertThat(csv.getStatus()).isEqualTo(200);
        Map<String, String> kopf = MispelNachweisTest.kopf(csv.getContentAsByteArray());
        assertThat(kopf.get("stand")).isEqualTo("vorlaeufig");
        assertThat(kopf.get("gilt_als_nachweis")).isEqualTo("nein");
        Map<String, List<Map<String, String>>> teile = MispelNachweisTest.csv(csv.getContentAsByteArray());
        assertThat(teile.get("formelsatz")).extracting(r -> r.get("nr")).containsExactlyElementsOf(soll.keySet());
        for (Map<String, String> r : teile.get("formelsatz")) {
            assertThat(r.get("wert_exakt")).as(r.get("nr")).isEqualTo(soll.get(r.get("nr")).text().replace(".", ","));
        }
        assertThat(teile.get("viertelstunden")).hasSize(2980);
        MockHttpServletResponse pdf = antwort(w, "/monate/2026-10/nachweis.pdf?empfaenger=netzbetreiber");
        assertThat(pdf.getStatus()).isEqualTo(200);
        assertThat(MispelNachweisTest.pdfText(pdf.getContentAsByteArray()))
                .contains("vorläufig – keine Mengenbestimmung");

        // Kundenansicht (MP-18): die Karte zeigt dieselben Mengen, gerundet wie der Nachweis; der Wert rechnet mit der
        // gerundeten Menge (20) × Satz des Preisblatts (USt 0 %, Gewerbe).
        JsonNode monat = MAPPER.readTree(antwort(w, "/monate/2026-10").getContentAsByteArray());
        assertThat(monat.get("abgrenzung").asBoolean()).isTrue();
        assertThat(monat.get("foerderweg").asText()).isEqualTo("marktpraemie_abgrenzung");
        assertThat(monat.get("stand").asText()).isEqualTo("vorlaeufig");
        JsonNode teil = monat.get("teile").get(0);
        assertThat(zahl(teil.get("einspeisung"))).isEqualByComparingTo(gerundet(soll.get("(4)")));
        assertThat(zahl(teil.get("netzbezug"))).isEqualByComparingTo(gerundet(soll.get("(3)")));
        assertThat(zahl(teil.get("umlagereduziert"))).isEqualByComparingTo(gerundet(soll.get("(20)")));
        assertThat(zahl(teil.get("umlagebelastet"))).isEqualByComparingTo(gerundet(soll.get("(21)")));
        assertThat(zahl(teil.get("foerderfaehig"))).isEqualByComparingTo(gerundet(soll.get("(32)")));
        Map<String, BigDecimal> farben = new LinkedHashMap<>();
        teil.get("farben").forEach(f -> farben.put(f.get("farbe").asText(), f.get("kwh").decimalValue()));
        assertThat(farben.get("gruen")).isEqualByComparingTo(gerundet(soll.get("(26)")));
        assertThat(farben.get("gelb")).isEqualByComparingTo(gerundet(soll.get("(31)")));
        assertThat(farben.get("rot")).isEqualByComparingTo(gerundet(soll.get("(16)")));
        assertThat(farben.get("grau")).isEqualByComparingTo(gerundet(soll.get("(4)").minus(soll.get("(26)"))
                .minus(soll.get("(31)")).minus(soll.get("(16)"))));
        JsonNode wert = monat.get("wert");
        BigDecimal umlagen = new BigDecimal(anlage.get("umlagenCt").asText());
        assertThat(wert.get("vermiedeneUmlagen").get("eur").decimalValue()).isEqualByComparingTo(
                gerundet(soll.get("(20)")).multiply(umlagen).divide(new BigDecimal("100"), 2, RoundingMode.HALF_UP));
        assertThat(wert.get("vermiedeneUmlagen").get("eur").decimalValue().signum()).isPositive();

        ObjectNode fixture = MAPPER.createObjectNode();
        fixture.put("$comment", "Antwort der Route …/mispel/abgrenzung/monate/2026-10 für die Simulator-Anlage aus "
                + "MispelDurchstichSimulatorTest (MP-22: Optimierer → Box → Monatslauf). Nicht von Hand ändern: neu "
                + "schreiben mit -Dmispel.fixtures.schreiben=true.");
        fixture.set("monat-2026-10", monat);
        String text = MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(fixture) + "\n";
        if (Boolean.getBoolean("mispel.fixtures.schreiben")) {
            Files.writeString(FIXTURE, text);
        }
        assertThat(MAPPER.readTree(Files.readString(FIXTURE))).as("Playwright-Fixture = Antwort der Route")
                .isEqualTo(MAPPER.readTree(text));
        String ablage = System.getProperty("mispel.durchstich.ablage");
        if (ablage != null) {
            Files.write(Path.of(ablage, "nachweis-2026-10.csv"), csv.getContentAsByteArray());
            Files.write(Path.of(ablage, "nachweis-2026-10.pdf"), pdf.getContentAsByteArray());
        }
    }

    // ------------------------------------------------------------------ Hilfen

    private static Map<String, Bruch> soll() {
        Map<String, Bruch> out = new LinkedHashMap<>();
        simulator.get("rechenwerk").fields().forEachRemaining(e -> out.put(e.getKey(), bruch(e.getValue().asText())));
        return out;
    }

    private static Bruch bruch(String text) {
        int s = text.indexOf('/');
        if (s < 0) {
            return Bruch.von(new BigDecimal(text));
        }
        return Bruch.von(new BigDecimal(text.substring(0, s))).durch(Bruch.von(new BigDecimal(text.substring(s + 1))));
    }

    private static BigDecimal zahl(JsonNode n) {
        return n.get("kwh").decimalValue();
    }

    private static BigDecimal gerundet(Bruch b) {
        return MispelNachweis.gerundet("(4)", b);
    }

    /** Die Viertelstunden der Simulation als Eingänge des Java-Rechenwerks (A1: Z1NB¼, Z1NE¼, Z2V¼, Z2E¼, AW¼). */
    private static List<Viertelstunde> viertelstunden() {
        JsonNode q = simulator.get("viertelstunden");
        Instant beginn = Instant.parse(q.get("beginn").asText());
        List<Viertelstunde> out = new ArrayList<>();
        for (int i = 0; i < q.get("anzahl").asInt(); i++) {
            Map<String, BigDecimal> z = new LinkedHashMap<>();
            for (String g : List.of("Z1NB", "Z1NE", "Z2V", "Z2E")) {
                z.put(g + "¼", new BigDecimal(q.get(g).get(i).asText()));
            }
            out.add(new Viertelstunde(beginn.plus(Duration.ofMinutes(15L * i)).atOffset(ZoneOffset.UTC), z,
                    Map.of("AW¼", q.get("AWgroesserNull").get(i).asInt() == 1)));
        }
        return out;
    }

    private Lauf lauf(Welt w, Vorgaben v) {
        dienst.leserSetzen(new SimulatorLeser());
        dienst.uhrStellen(Clock.fixed(Instant.parse("2026-11-03T08:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());
        try {
            return dienst.monatslauf(w.anlage(), OKTOBER, v);
        } finally {
            TenantContext.clear();
        }
    }

    private MockHttpServletResponse antwort(Welt w, String pfad) throws Exception {
        return mvc.perform(get("/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung" + pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-" + w.mandant());
                    j.claim("name", "Mara Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))).andReturn().getResponse();
    }

    /** Die Zählerwerte der Simulation, wie die Box sie liefert: Gerätewerte, nicht endgültig. */
    private static final class SimulatorLeser extends MispelZaehlerLeser {

        SimulatorLeser() {
            super(null);
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            JsonNode q = simulator.get("viertelstunden");
            Instant beginn = Instant.parse(q.get("beginn").asText());
            JsonNode reihe = q.get(KENNZEICHEN.get(kennzeichen));
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (int i = 0; i < q.get("anzahl").asInt(); i++) {
                Instant t = beginn.plus(Duration.ofMinutes(15L * i));
                if (!t.isBefore(von) && t.isBefore(bis)) {
                    out.put(t, new Menge(new BigDecimal(reihe.get(i).asText()), false));
                }
            }
            return out;
        }
    }

    /** Netzzähler MS-01/MS-02 (Z1) und Speicher MS-03/MS-04 (Z2), Förderweg Abgrenzung (A1) ab 01.10.2026. */
    private static Welt welt() {
        JsonNode a = simulator.get("anlage");
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('MiSpeL Durchstich') RETURNING id",
                UUID.class);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at, plant_kind, "
                + "anzulegender_wert_ct_kwh) VALUES (?, 'Simulator-Anlage', '2026-09-01', 'direktvermarktung', ?) "
                + "RETURNING id", UUID.class, t, a.get("anzulegenderWertCt").decimalValue());
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-MP22-SIM', 'claimed') RETURNING id", UUID.class, t, anlage);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        UUID ms1 = messstelle(t, "MS-01", "Bezug");
        UUID ms2 = messstelle(t, "MS-02", "Abgabe");
        UUID ms3 = messstelle(t, "MS-03", "Laden");
        UUID ms4 = messstelle(t, "MS-04", "Entladen");
        stellung(t, anlage, ms1, "Hauptzähler");
        stellung(t, anlage, ms2, "Hauptzähler");
        stellung(t, anlage, ms3, "Speicher");
        stellung(t, anlage, ms4, "Speicher");
        quelle(t, box, ms1, "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms2, "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms3, "Laden", speicher, "battery.charge-energy");
        quelle(t, box, ms4, "Entladen", speicher, "battery.discharge-energy");
        rolle(t, ms1, "Z1", "DE0002222222220000000000000000001");
        rolle(t, ms2, "Z1", "DE0002222222220000000000000000001");
        rolle(t, ms3, "Z2", "DE0002222222220000000000000000002");
        rolle(t, ms4, "Z2", "DE0002222222220000000000000000002");
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, aw_regel, "
                + "gueltig_ab, created_by) VALUES (?, ?, ?, ?, true, ?, '2026-10-01', 'test')", t, anlage,
                a.get("foerderweg").asText(), a.get("formelsatz").asText(), a.get("awRegel").asText());
        root.update("INSERT INTO site_supply_price (site_id, tenant_id, umlagen_ct, netzentgelt_arbeitspreis_ct, "
                + "ust_pct) VALUES (?, ?, ?, ?, 0)", anlage, t, a.get("umlagenCt").decimalValue(),
                a.get("netzentgeltArbeitspreisCt").decimalValue());
        // AW¼ > 0 je Viertelstunde, wie die Simulation sie gerechnet hat (Liste der Regel „viertelstunde“).
        JsonNode q = simulator.get("viertelstunden");
        Instant beginn = Instant.parse(q.get("beginn").asText());
        List<Object[]> zeilen = new ArrayList<>();
        for (int i = 0; i < q.get("anzahl").asInt(); i++) {
            zeilen.add(new Object[] {java.sql.Timestamp.from(beginn.plus(Duration.ofMinutes(15L * i))),
                    q.get("AWgroesserNull").get(i).asInt() == 1});
        }
        root.batchUpdate("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) VALUES ('viertelstunde', "
                + "?, 'PT15M', ?) ON CONFLICT DO NOTHING", zeilen);
        return new Welt(t, anlage);
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.22\",\"unit_id\":1}'::jsonb, ?::jsonb, '2026-09-01') "
                + "RETURNING id", UUID.class, t, anlage, typ, typ, typ, box,
                "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}");
    }

    private static UUID messstelle(UUID t, String kz, String richtung) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kz, kz, richtung);
    }

    private static void stellung(UUID t, UUID anlage, UUID ms, String stellung) {
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, '2026-10-01'::date)", t, ms, anlage, stellung);
    }

    private static void quelle(UUID t, UUID box, UUID ms, String richtung, UUID komponente, String kanal) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, '2026-10-01'::timestamptz, "
                + "'2026.09.11.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point "
                + "WHERE id = ? ON CONFLICT DO NOTHING", t, box, komponente, kanal, komponente);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2026-10-01'::timestamptz, false, now(), 'sub-test', 'Test', 'kunde')", t, ms, richtung, komponente,
                geraet, kanal);
    }

    /** Wertequelle „geraet“: die Box liefert die Werte (Simulator), kein Messstellenbetreiber. */
    private static void rolle(UUID t, UUID ms, String rolle, String zp) {
        root.update("INSERT INTO messstelle_zaehlerrolle (tenant_id, messstelle_id, rolle, zaehlpunkt, "
                + "messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab) VALUES (?, ?, ?, ?, "
                + "'Simulator-MSB', 'eichrechtskonform', '2034-12-31', 'geraet', '2026-10-01'::date)", t, ms, rolle,
                zp);
    }
}
