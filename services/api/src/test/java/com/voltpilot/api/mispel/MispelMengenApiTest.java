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
import com.voltpilot.api.mispel.MispelAbgrenzungService.Vorgaben;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
 * MiSpeL MP-18 Ende zu Ende: eine Simulator-Anlage (Tagesprofil wie der Simulator — nachts Netzladen, mittags PV-Laden
 * und Einspeisung, abends Entladen, am Wochenende mittags AW ≤ 0) läuft durch den echten Monatslauf (MP-8), und die
 * Routen der Kundenansicht liefern genau die Zahlen des Rechenwerks — mit Begriff und Formelnummer, Stand, der Änderung
 * beim Endgültig-Werden und „Was das wert ist“.
 *
 * <p>Die Antworten sind zugleich die Fixture der Playwright-Bühne {@code frontend/portal/e2e/mispel-mengen.spec.ts}:
 * der Test vergleicht sie mit der eingecheckten Datei, damit das Portal-Foto dieselben Zahlen zeigt wie das Rechenwerk.
 * Neu schreiben: {@code ./mvnw test -Dtest=MispelMengenApiTest -Dmispel.fixtures.schreiben=true}.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MispelMengenApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    private static final Path FIXTURE = Path.of("../../frontend/portal/e2e/mispel-mengen-fixtures.json");
    private static final BigDecimal UMLAGEN_CT = new BigDecimal("2.946");
    private static final BigDecimal NETZENTGELT_CT = new BigDecimal("8.120");

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

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    private record Welt(UUID mandant, UUID anlage) {}

    @Test
    void dieKundenansichtZeigtDieZahlenDesRechenwerksMitBegriffStandUndWert() throws Exception {
        Welt w = welt();
        // November: erst die Vorschau aus Gerätewerten (20.11.), dann endgültig mit den Werten des MSB (10.12.).
        wertequelle(w, "geraet");
        Lauf vorschau = lauf(w, YearMonth.of(2026, 11), "2026-11-20T12:00:00Z", true);
        assertThat(vorschau.zeile().stand()).isEqualTo("vorlaeufig");
        wertequelle(w, "messstellenbetreiber");
        Lauf nov = lauf(w, YearMonth.of(2026, 11), "2026-12-10T12:00:00Z", false);
        assertThat(nov.zeile().stand()).isEqualTo("endgueltig");
        // Dezember läuft noch: vorläufig aus Gerätewerten, Stand 10.12.
        wertequelle(w, "geraet");
        Lauf dez = lauf(w, YearMonth.of(2026, 12), "2026-12-10T12:00:00Z", true);
        assertThat(dez.zeile().stand()).isEqualTo("vorlaeufig");

        JsonNode monat = ruf(w, "/monate/2026-11");
        assertThat(monat.get("abgrenzung").asBoolean()).isTrue();
        assertThat(monat.get("foerderweg").asText()).isEqualTo("marktpraemie_abgrenzung");
        assertThat(monat.get("stand").asText()).isEqualTo("endgueltig");
        assertThat(monat.get("giltAlsNachweis").asBoolean()).isTrue();
        JsonNode teil = monat.get("teile").get(0);
        Map<String, Bruch> soll = nov.ergebnis().monate().get("2026-11");
        assertThat(teil.get("formelsatz").asText()).isEqualTo("A1");
        assertThat(teil.get("wertequelle").asText()).isEqualTo("messstellenbetreiber");
        assertThat(zahl(teil.get("einspeisung"))).isEqualByComparingTo(gerundet(soll.get("(4)")));
        assertThat(teil.get("einspeisung").get("begriff").asText()).isEqualTo("Gesamte Netzeinspeisung im Kalendermonat");
        Map<String, JsonNode> farben = new LinkedHashMap<>();
        teil.get("farben").forEach(f -> farben.put(f.get("farbe").asText(), f));
        assertThat(farben.keySet()).containsExactly("gruen", "gelb", "rot", "grau");
        assertThat(farben.get("gruen").get("formel").asText()).isEqualTo("(26)");
        assertThat(zahl(farben.get("gruen"))).isEqualByComparingTo(gerundet(soll.get("(26)")));
        assertThat(zahl(farben.get("gelb"))).isEqualByComparingTo(gerundet(soll.get("(31)")));
        assertThat(zahl(farben.get("rot"))).isEqualByComparingTo(gerundet(soll.get("(16)")));
        assertThat(farben.get("rot").get("begriff").asText())
                .isEqualTo("Saldierungsfähige Netzeinspeisung im Kalendermonat");
        assertThat(zahl(farben.get("grau"))).isEqualByComparingTo(gerundet(soll.get("(4)").minus(soll.get("(26)"))
                .minus(soll.get("(31)")).minus(soll.get("(16)"))));
        // Das Profil trifft jede Farbe: Wochenend-Mittage AW ≤ 0 (grau), Netzladen nachts (rot).
        farben.values().forEach(f -> assertThat(zahl(f)).as(f.get("farbe").asText()).isPositive());
        assertThat(zahl(teil.get("netzbezug"))).isEqualByComparingTo(gerundet(soll.get("(3)")));
        assertThat(zahl(teil.get("umlagereduziert"))).isEqualByComparingTo(gerundet(soll.get("(20)")));
        assertThat(zahl(teil.get("umlagebelastet"))).isEqualByComparingTo(gerundet(soll.get("(21)")));
        assertThat(zahl(teil.get("foerderfaehig"))).isEqualByComparingTo(gerundet(soll.get("(32)")));

        // Beim Endgültig-Werden: die Vorschau (Fassung 1, Gerätewerte) mit Grund und Unterschied.
        JsonNode aenderung = teil.get("aenderung");
        assertThat(aenderung.get("vorherFassung").asInt()).isEqualTo(vorschau.zeile().fassung());
        assertThat(aenderung.get("vorherWertequelle").asText()).isEqualTo("geraet");
        assertThat(aenderung.get("vorherGruende").toString()).contains("wertequelle_geraet");
        assertThat(aenderung.get("differenzEur").decimalValue()).isNotZero();

        // Was das wert ist: (20) × Satz × (1 + USt), die Marktprämie offen bis zum Jahresmarktwert — nie 0 €.
        JsonNode wert = monat.get("wert");
        BigDecimal m20 = gerundet(soll.get("(20)"));
        assertThat(wert.get("vermiedeneUmlagen").get("eur").decimalValue()).isEqualByComparingTo(eur(m20, UMLAGEN_CT));
        assertThat(wert.get("vermiedenesNetzentgelt").get("eur").decimalValue())
                .isEqualByComparingTo(eur(m20, NETZENTGELT_CT));
        assertThat(wert.get("summeOhneMarktpraemieEur").decimalValue())
                .isEqualByComparingTo(eur(m20, UMLAGEN_CT).add(eur(m20, NETZENTGELT_CT)));
        assertThat(wert.get("marktpraemie").get("stand").asText()).isEqualTo("offen");
        assertThat(wert.get("marktpraemie").get("grund").asText()).isEqualTo("jahresmarktwert_offen");
        assertThat(wert.get("marktpraemie").get("eur").isNull()).isTrue();

        JsonNode dezember = ruf(w, "/monate/2026-12");
        assertThat(dezember.get("stand").asText()).isEqualTo("vorlaeufig");
        assertThat(dezember.get("teile").get(0).get("standGruende").toString()).contains("zeitraum_offen")
                .contains("wertequelle_geraet");
        assertThat(zahl(dezember.get("teile").get(0).get("farben").get(0)))
                .isEqualByComparingTo(gerundet(dez.ergebnis().monate().get("2026-12").get("(26)")));

        JsonNode oktober = ruf(w, "/monate/2026-10");
        assertThat(oktober.get("abgrenzung").asBoolean()).isFalse();
        assertThat(oktober.get("foerderwegBegriff").asText()).isEqualTo("Marktprämie mit Ausschließlichkeitsoption");
        assertThat(oktober.get("teile")).isEmpty();

        JsonNode jahr = ruf(w, "/jahre/2026");
        assertThat(jahr.get("monate")).extracting(m -> m.get("monat").asText())
                .containsExactly("2026-10", "2026-11", "2026-12");
        assertThat(jahr.get("stand").asText()).isEqualTo("vorlaeufig");
        assertThat(jahr.get("mitteilungBis").asText()).isEqualTo("2027-05-31");
        assertThat(jahr.get("wert").get("summeOhneMarktpraemieEur").decimalValue()).isEqualByComparingTo(
                monat.get("wert").get("summeOhneMarktpraemieEur").decimalValue()
                        .add(dezember.get("wert").get("summeOhneMarktpraemieEur").decimalValue()));

        ObjectNode fixture = MAPPER.createObjectNode();
        fixture.put("$comment", "Antworten der Routen …/mispel/abgrenzung/monate|jahre für die Simulator-Anlage aus "
                + "MispelMengenApiTest (echter Monatslauf MP-8). Nicht von Hand ändern: neu schreiben mit "
                + "-Dmispel.fixtures.schreiben=true.");
        fixture.set("monat-2026-10", oktober);
        fixture.set("monat-2026-11", monat);
        fixture.set("monat-2026-12", dezember);
        fixture.set("jahr-2026", jahr);
        String text = MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(fixture) + "\n";
        if (Boolean.getBoolean("mispel.fixtures.schreiben")) {
            Files.writeString(FIXTURE, text);
        }
        assertThat(MAPPER.readTree(Files.readString(FIXTURE))).as("Playwright-Fixture = Antwort der Route")
                .isEqualTo(MAPPER.readTree(text));
    }

    @Test
    void fremdeAnlagenBleibenUnsichtbarUndZeitraeumeWerdenGeprueft() throws Exception {
        Welt w = welt();
        assertThat(status(w, "/monate/2026-11")).isEqualTo(200);
        assertThat(status(w, "/monate/2026-09")).isEqualTo(400);
        assertThat(status(w, "/monate/2026-13")).isEqualTo(400);
        assertThat(status(w, "/jahre/26")).isEqualTo(400);
        Welt fremd = welt();
        assertThat(status(new Welt(fremd.mandant(), w.anlage()), "/monate/2026-11")).isEqualTo(404);
        assertThat(status(new Welt(fremd.mandant(), w.anlage()), "/jahre/2026")).isEqualTo(404);
        // Ohne Lauf: die Karte steht (Förderweg Abgrenzung), aber ohne Teile und ohne erfundene Zahlen.
        JsonNode leer = ruf(w, "/monate/2026-11");
        assertThat(leer.get("abgrenzung").asBoolean()).isTrue();
        assertThat(leer.get("teile")).isEmpty();
        assertThat(leer.get("stand").isNull()).isTrue();
        assertThat(leer.get("wert").isNull()).isTrue();
    }

    // ------------------------------------------------------------------ Hilfen

    private static BigDecimal zahl(JsonNode n) {
        return n.get("kwh").decimalValue();
    }

    private static BigDecimal gerundet(Bruch b) {
        return MispelNachweis.gerundet("(4)", b);
    }

    private static BigDecimal eur(BigDecimal kwh, BigDecimal ct) {
        return kwh.multiply(ct).multiply(new BigDecimal("1.19")).divide(new BigDecimal("100"), 2,
                RoundingMode.HALF_UP);
    }

    private Lauf lauf(Welt w, YearMonth monat, String uhr, boolean geraet) {
        dienst.leserSetzen(new SimulatorLeser(geraet));
        dienst.uhrStellen(Clock.fixed(Instant.parse(uhr), ZoneOffset.UTC));
        TenantContext.set(w.mandant());
        try {
            return dienst.monatslauf(w.anlage(), monat, Vorgaben.von("A1", "viertelstunde"));
        } finally {
            TenantContext.clear();
        }
    }

    private JsonNode ruf(Welt w, String pfad) throws Exception {
        MockHttpServletResponse r = antwort(w, pfad);
        assertThat(r.getStatus()).as(pfad).isEqualTo(200);
        return MAPPER.readTree(r.getContentAsByteArray());
    }

    private int status(Welt w, String pfad) throws Exception {
        return antwort(w, pfad).getStatus();
    }

    private MockHttpServletResponse antwort(Welt w, String pfad) throws Exception {
        return mvc.perform(get("/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung" + pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-" + w.mandant());
                    j.claim("name", "Mara Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))).andReturn().getResponse();
    }

    /**
     * Ersatz-Leser mit dem Tagesprofil einer Simulator-Anlage (kWh je Viertelstunde, Ortszeit Berlin): 01–03 Uhr
     * Netzladen (Bezug 6, Laden 5), 10–14 Uhr PV-Laden 3 · f und Einspeisung 4 · f (f = 0,7 … 1,0 je Tag), 17–21 Uhr
     * Entladen 4,6 mit Einspeisung 4, sonst Bezug 1. Die Geräte lesen den Speicher 1,5 % höher als der MSB.
     */
    private static final class SimulatorLeser extends MispelZaehlerLeser {

        private final boolean geraet;

        SimulatorLeser(boolean geraet) {
            super(null);
            this.geraet = geraet;
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                out.put(t, new Menge(wert(kennzeichen, t), !geraet));
            }
            return out;
        }

        private BigDecimal wert(String kz, Instant t) {
            ZonedDateTime z = t.atZone(MispelAbgrenzungRechenwerk.BERLIN);
            int h = z.getHour();
            double f = 0.7 + 0.1 * (z.getDayOfMonth() % 4);
            double speicher = geraet ? 1.015 : 1.0;
            double v = switch (kz) {
                case "MS-01" -> h >= 1 && h < 3 ? 6 : (h >= 10 && h < 14) || (h >= 17 && h < 21) ? 0 : 1;
                case "MS-02" -> h >= 10 && h < 14 ? 4 * f : h >= 17 && h < 21 ? 4 : 0;
                case "MS-03" -> (h >= 1 && h < 3 ? 5 : h >= 10 && h < 14 ? 3 * f : 0) * speicher;
                case "MS-04" -> (h >= 17 && h < 21 ? 4.6 : 0) * speicher;
                default -> 0;
            };
            return BigDecimal.valueOf(v).setScale(3, RoundingMode.HALF_UP);
        }
    }

    /** Netzzähler MS-01/MS-02 und Speicher MS-03/MS-04 ab 01.10.2026; Förderweg ab 01.11.2026 Abgrenzung (A1). */
    private static Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Mengen #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at, plant_kind, "
                + "anzulegender_wert_ct_kwh) VALUES (?, 'Simulator-Anlage', '2026-09-01', 'direktvermarktung', 6.85) "
                + "RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP18-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        UUID ms1 = messstelle(t, "MS-01", "Bezug");
        UUID ms2 = messstelle(t, "MS-02", "Abgabe");
        UUID ms3 = messstelle(t, "MS-03", "Laden");
        UUID ms4 = messstelle(t, "MS-04", "Entladen");
        stellung(t, anlage, ms1, "Hauptzähler", "2026-10-01");
        stellung(t, anlage, ms2, "Hauptzähler", "2026-10-01");
        stellung(t, anlage, ms3, "Speicher", "2026-10-01");
        stellung(t, anlage, ms4, "Speicher", "2026-10-01");
        quelle(t, box, ms1, "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms2, "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms3, "Laden", speicher, "battery.charge-energy");
        quelle(t, box, ms4, "Entladen", speicher, "battery.discharge-energy");
        rolle(t, ms1, "Z1", "DE0001234567890000000000000000001", "2026-10-01");
        rolle(t, ms2, "Z1", "DE0001234567890000000000000000001", "2026-10-01");
        rolle(t, ms3, "Z2", "DE0001234567890000000000000000002", "2026-10-01");
        rolle(t, ms4, "Z2", "DE0001234567890000000000000000002", "2026-10-01");
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, aw_regel, "
                + "gueltig_ab, created_by) VALUES (?, ?, 'marktpraemie_ausschliesslichkeit', NULL, false, NULL, "
                + "'2026-10-01', 'test'), (?, ?, 'marktpraemie_abgrenzung', 'A1', true, 'viertelstunde', '2026-11-01', "
                + "'test')", t, anlage, t, anlage);
        root.update("INSERT INTO site_supply_price (site_id, tenant_id, umlagen_ct, netzentgelt_arbeitspreis_ct, "
                + "ust_pct) VALUES (?, ?, ?, ?, 19.0)", anlage, t, UMLAGEN_CT, NETZENTGELT_CT);
        // AW > 0 überall, außer am Wochenende 12–14 Uhr (negative Preise): dort weder Prämie noch Saldierung.
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT 'viertelstunde', g, "
                + "'PT15M', NOT (EXTRACT(ISODOW FROM g AT TIME ZONE 'Europe/Berlin') IN (6, 7) AND "
                + "EXTRACT(HOUR FROM g AT TIME ZONE 'Europe/Berlin') IN (12, 13)) FROM generate_series("
                + "'2026-09-30T22:00Z'::timestamptz, '2026-12-31T22:45Z', INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
        assertThat(DayOfWeek.SATURDAY.getValue()).isEqualTo(6);
        return new Welt(t, anlage);
    }

    private static void wertequelle(Welt w, String quelle) {
        root.update("UPDATE messstelle_zaehlerrolle SET wertequelle = ? WHERE tenant_id = ? AND rolle = 'Z2'", quelle,
                w.mandant());
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?::jsonb, '2026-09-01') "
                + "RETURNING id", UUID.class, t, anlage, typ, typ, typ, box,
                "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}");
    }

    private static UUID messstelle(UUID t, String kz, String richtung) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kz, kz, richtung);
    }

    private static void stellung(UUID t, UUID anlage, UUID ms, String stellung, String ab) {
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, ?::date)", t, ms, anlage, stellung, ab);
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

    private static void rolle(UUID t, UUID ms, String rolle, String zp, String ab) {
        root.update("INSERT INTO messstelle_zaehlerrolle (tenant_id, messstelle_id, rolle, zaehlpunkt, "
                + "messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab) VALUES (?, ?, ?, ?, "
                + "'Netze Musterstadt GmbH', 'eichrechtskonform', '2034-12-31', 'messstellenbetreiber', ?::date)", t, ms,
                rolle, zp, ab);
    }
}
