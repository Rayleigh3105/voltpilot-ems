package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Lauf;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Vorgaben;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
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
 * MiSpeL MP-41a gegen die Datenbank: die Erträge am Ladepunkt (Verlauf › Erlöse) kommen aus dem gespeicherten
 * Monatslauf der Abgrenzung in A2 (MP-32) — dieselben Zahlen wie die MiSpeL-Karte (MP-18), mit Fremdtankstrom (12)
 * (A1 S. 16, Abschn. 2.1.6; S. 35) und ohne Summe, solange der Vergleich „Auto lädt nur“ fehlt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class LadepunktErtraegeApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
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
    @Autowired
    LadepunktErtragService ertraege;

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

    private record Welt(UUID mandant, UUID anlage, UUID wallbox) {}

    @Test
    void ertraegeAmLadepunktAusDemMonatslaufA2() throws Exception {
        Welt w = welt();
        Lauf nov = lauf(w, YearMonth.of(2026, 11), "2026-12-10T12:00:00Z");
        assertThat(nov.zeile().formelsatz()).isEqualTo("A2");

        JsonNode e = ruf(w, "/ladepunkte/ertraege/2026-11");
        assertThat(e.path("monat").asText()).isEqualTo("2026-11");
        assertThat(e.path("ladepunkte")).hasSize(1);
        assertThat(e.path("ladepunkte").get(0).path("name").asText()).isEqualTo("Wallbox Garage");
        assertThat(e.path("ladepunkte").get(0).path("einordnung").asText()).isEqualTo("ladepunkt_der_festlegung");
        assertThat(e.path("teile")).hasSize(1);
        JsonNode teil = e.path("teile").get(0);
        assertThat(teil.path("formelsatz").asText()).isEqualTo("A2");
        assertThat(teil.path("nur_ladepunkt").asBoolean()).isTrue();
        assertThat(teil.path("erster_tag").asText()).isEqualTo("2026-11-01");
        assertThat(teil.path("letzter_tag").asText()).isEqualTo("2026-11-30");
        Map<String, JsonNode> m = new LinkedHashMap<>();
        teil.path("mengen").forEach(x -> m.put(x.path("nr").asText().replaceAll("A.*", ""), x));
        assertThat(m.keySet()).containsExactly("(5)", "(9)", "(10)", "(6)", "(11)", "(12)", "(13)", "(14)", "(15)",
                "(16)", "(20)", "(28)", "(31)");
        assertThat(m.get("(12)").path("begriff").asText()).isEqualTo("Fremdtankstrom im Kalendermonat");
        assertThat(m.get("(12)").path("fundstelle").asText()).startsWith("A1 S. 35");
        BigDecimal b5 = kwh(m, "(5)");
        BigDecimal b6 = kwh(m, "(6)");
        BigDecimal b11 = kwh(m, "(11)");
        // 15 gerade Tage × (12 × 2,75 + 12 × 1) = 675 kWh geladen, 30 Abende × 16 × 2 = 960 kWh zurückgegeben.
        assertThat(b5).isEqualByComparingTo("675");
        assertThat(b6).isEqualByComparingTo("960");
        assertThat(kwh(m, "(9)").add(kwh(m, "(10)"))).isEqualByComparingTo(b5);
        // (12) = MAX[(6) − (5); 0], (13) = MAX[(11) − (12); 0] — Anlage 1 S. 35.
        assertThat(kwh(m, "(12)")).isEqualByComparingTo("285");
        assertThat(kwh(m, "(13)")).isEqualByComparingTo(b11.subtract(kwh(m, "(12)")).max(BigDecimal.ZERO));
        assertThat(m.get("(14)").path("nr").asText()).isEqualTo("(14)A2,A3,A4");
        assertThat(kwh(m, "(14)")).isEqualByComparingTo("0.85");
        assertThat(teil.path("ins_haus").path("kwh").decimalValue()).isEqualByComparingTo(b6.subtract(b11));

        // Dieselben Zahlen wie die MiSpeL-Karte (MP-18): (20) und (16).
        JsonNode karte = ruf(w, "/mispel/abgrenzung/monate/2026-11").path("teile").get(0);
        assertThat(kwh(m, "(20)")).isEqualByComparingTo(karte.path("umlagereduziert").path("kwh").decimalValue());

        // Posten: die vier aus dem Vergleich offen, Umlagen und Netzentgelt (Vorbehalt) aus (20), keine Summe.
        Map<String, JsonNode> p = new LinkedHashMap<>();
        e.path("posten").forEach(x -> p.put(x.path("schluessel").asText(), x));
        assertThat(p.keySet()).containsExactly("weniger_gekauft", "mehr_geladen", "ins_netz_verkauft",
                "vermiedene_umlagen", "vermiedenes_netzentgelt", "akku_verschleiss", "marktpraemie");
        for (String k : List.of("weniger_gekauft", "mehr_geladen", "ins_netz_verkauft", "akku_verschleiss")) {
            assertThat(p.get(k).path("stand").asText()).as(k).isEqualTo("offen");
            assertThat(p.get(k).path("eur").isNull()).as(k).isTrue();
            assertThat(p.get(k).path("grund").asText()).as(k).isEqualTo("messlatte_fehlt");
        }
        assertThat(p.get("vermiedene_umlagen").path("stand").asText()).isEqualTo("bestimmt");
        assertThat(p.get("vermiedene_umlagen").path("eur").decimalValue())
                .isEqualByComparingTo(eur(kwh(m, "(20)"), UMLAGEN_CT));
        assertThat(p.get("vermiedenes_netzentgelt").path("vorbehalt").asBoolean()).isTrue();
        assertThat(p.get("vermiedenes_netzentgelt").path("eur").decimalValue())
                .isEqualByComparingTo(eur(kwh(m, "(20)"), NETZENTGELT_CT));
        assertThat(p.get("marktpraemie").path("formel").asText()).isEqualTo("(31)");
        assertThat(p.get("marktpraemie").path("stand").asText()).isEqualTo("offen");
        assertThat(e.path("vergleich").path("stand").asText()).isEqualTo("offen");
        assertThat(e.path("vergleich").path("grund").asText()).isEqualTo("messlatte_fehlt");
        assertThat(e.path("vergleich").path("summe_eur").isNull()).isTrue();
        assertThat(e.path("ust_pct").decimalValue()).isEqualByComparingTo("19");

        // Oktober: Ausschließlichkeit, kein Lauf mit Ladepunkt — keine Teile, keine Posten.
        JsonNode okt = ruf(w, "/ladepunkte/ertraege/2026-10");
        assertThat(okt.path("teile")).isEmpty();
        assertThat(okt.path("posten")).isEmpty();
        // Vor der Festlegung und eine falsche Form: 400.
        assertThat(antwort(w, "/ladepunkte/ertraege/2026-09").getStatus()).isEqualTo(400);
        assertThat(antwort(w, "/ladepunkte/ertraege/November").getStatus()).isEqualTo(400);
    }

    /**
     * MP-33e: die Messlatte „nur laden“ aus der Ablage je Viertelstunde (ladepunkt_messlatte) — die vier Posten und
     * die Summe gegenüber nur laden; eine fehlende Viertelstunde ist eine fehlende Summe, keine kleinere.
     */
    @Test
    void summeGegenNurLadenAusDerAblageJeViertelstunde() throws Exception {
        Welt w = welt();
        lauf(w, YearMonth.of(2026, 11), "2026-12-10T12:00:00Z");
        ertraege.uhrStellen(Clock.fixed(Instant.parse("2026-12-10T12:00:00Z"), ZoneOffset.UTC));
        // November 2026 in Berlin: 30 Tage × 96 = 2 880 Viertelstunden (ohne Umstellung).
        int n = messlatteAblegen(w, "2026-10-31T23:00:00Z", "2026-11-30T22:45:00Z");
        assertThat(n).isEqualTo(2880);
        // Ein älterer Plan ersetzt nichts: die Ablage hält je Viertelstunde den Plan, der für sie galt.
        assertThat(root.queryForObject("SELECT count(DISTINCT komponente_id) FROM ladepunkt_messlatte WHERE site_id = ?",
                Integer.class, w.anlage())).isEqualTo(1);

        JsonNode e = ruf(w, "/ladepunkte/ertraege/2026-11");
        Map<String, JsonNode> p = new LinkedHashMap<>();
        e.path("posten").forEach(x -> p.put(x.path("schluessel").asText(), x));
        // 2 880 × 0,0125 € = 36,00 € für 108 kWh (Mittel 33,3 ct); 2 880 × −0,00785 € = −22,61 € für 95,0 kWh.
        assertPosten(p.get("weniger_gekauft"), "36.00", "108.0", "33.3");
        assertPosten(p.get("mehr_geladen"), "-22.61", "95.0", "23.8");
        assertPosten(p.get("ins_netz_verkauft"), "3.60", "34.0", "10.6");
        // Verschleiß: 3 ct je zurückgegebener kWh (FAHRZEUG_VERSCHLEISS_CT_JE_KWH, Schätzung).
        assertPosten(p.get("akku_verschleiss"), "-4.32", "144.0", "3.0");
        assertThat(p.get("marktpraemie").path("stand").asText()).isEqualTo("offen");
        BigDecimal summe = BigDecimal.ZERO;
        for (String k : List.of("weniger_gekauft", "mehr_geladen", "ins_netz_verkauft", "vermiedene_umlagen",
                "vermiedenes_netzentgelt", "akku_verschleiss")) {
            summe = summe.add(p.get(k).path("eur").decimalValue());
        }
        assertThat(e.path("vergleich").path("stand").asText()).isEqualTo("bestimmt");
        assertThat(e.path("vergleich").path("grund").isNull()).isTrue();
        assertThat(e.path("vergleich").path("summe_eur").decimalValue()).isEqualByComparingTo(summe);

        // Eine Viertelstunde fehlt: keine Summe, kein Posten aus dem Vergleich — offen statt 0.
        root.update("DELETE FROM ladepunkt_messlatte WHERE komponente_id = ? AND zeit = '2026-11-15T12:00:00Z'",
                w.wallbox());
        JsonNode luecke = ruf(w, "/ladepunkte/ertraege/2026-11");
        assertThat(luecke.path("vergleich").path("stand").asText()).isEqualTo("offen");
        assertThat(luecke.path("vergleich").path("grund").asText()).isEqualTo("messlatte_fehlt");
        assertThat(luecke.path("vergleich").path("summe_eur").isNull()).isTrue();
        luecke.path("posten").forEach(x -> {
            if (List.of("weniger_gekauft", "mehr_geladen", "ins_netz_verkauft", "akku_verschleiss")
                    .contains(x.path("schluessel").asText())) {
                assertThat(x.path("stand").asText()).isEqualTo("offen");
                assertThat(x.path("eur").isNull()).isTrue();
            }
        });

        // Im laufenden Monat zählen nur die vergangenen Viertelstunden: am 15.11. 12:07 trägt die Ablage bis 12:00.
        messlatteAblegen(w, "2026-11-15T12:00:00Z", "2026-11-15T12:00:00Z");
        ertraege.uhrStellen(Clock.fixed(Instant.parse("2026-11-15T11:07:00Z"), ZoneOffset.UTC));
        root.update("DELETE FROM ladepunkt_messlatte WHERE komponente_id = ? AND zeit >= '2026-11-15T11:00:00Z'",
                w.wallbox());
        assertThat(ruf(w, "/ladepunkte/ertraege/2026-11").path("vergleich").path("stand").asText())
                .isEqualTo("bestimmt");

        // Der Löschweg: die Komponente nimmt ihre Messlatte mit (ON DELETE CASCADE), über sie Anlage und Mandant.
        assertThat(root.queryForObject("SELECT confdeltype::text FROM pg_constraint "
                + "WHERE conname = 'ladepunkt_messlatte_komponente_fk'", String.class)).isEqualTo("c");
        assertThat(root.queryForObject("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'ladepunkt_messlatte'",
                Boolean.class)).isTrue();
    }

    /** Legt je Viertelstunde in {@code [von, bis]} eine Zeile ab wie der Optimierer ({@code persistence.messlatte_rows}). */
    private static int messlatteAblegen(Welt w, String von, String bis) {
        return root.update("INSERT INTO ladepunkt_messlatte (komponente_id, zeit, tenant_id, site_id, plan_id, "
                + "generated_at, weniger_gekauft_eur, weniger_gekauft_kwh, mehr_geladen_eur, mehr_geladen_kwh, "
                + "ins_netz_verkauft_eur, ins_netz_verkauft_kwh, akku_verschleiss_eur, rueckgespeist_kwh) "
                + "SELECT ?, z, ?, ?, gen_random_uuid(), z, 0.0125, 0.0375, -0.00785, 0.033, 0.00125, 0.0118, "
                + "-0.0015, 0.05 FROM generate_series(?::timestamptz, ?::timestamptz, INTERVAL '15 minutes') z "
                + "ON CONFLICT (komponente_id, zeit) DO NOTHING",
                w.wallbox(), w.mandant(), w.anlage(), von, bis);
    }

    private static void assertPosten(JsonNode p, String eur, String kwh, String satzCt) {
        String k = p.path("schluessel").asText();
        assertThat(p.path("stand").asText()).as(k).isEqualTo("bestimmt");
        assertThat(p.path("grund").isNull()).as(k).isTrue();
        assertThat(p.path("eur").decimalValue()).as(k).isEqualByComparingTo(eur);
        assertThat(p.path("menge_kwh").decimalValue()).as(k).isEqualByComparingTo(kwh);
        assertThat(p.path("satz_ct").decimalValue()).as(k).isEqualByComparingTo(satzCt);
    }

    private static BigDecimal kwh(Map<String, JsonNode> m, String nr) {
        return m.get(nr).path("kwh").decimalValue();
    }

    private static BigDecimal eur(BigDecimal kwh, BigDecimal ct) {
        return kwh.multiply(ct).multiply(new BigDecimal("1.19")).divide(new BigDecimal("100"), 2,
                RoundingMode.HALF_UP);
    }

    private Lauf lauf(Welt w, YearMonth monat, String uhr) {
        dienst.leserSetzen(new LadepunktLeser());
        dienst.uhrStellen(Clock.fixed(Instant.parse(uhr), ZoneOffset.UTC));
        TenantContext.set(w.mandant());
        try {
            return dienst.monatslauf(w.anlage(), monat, Vorgaben.von("A2", "viertelstunde"));
        } finally {
            TenantContext.clear();
        }
    }

    private JsonNode ruf(Welt w, String pfad) throws Exception {
        MockHttpServletResponse r = antwort(w, pfad);
        assertThat(r.getStatus()).as(pfad + " " + r.getContentAsString()).isEqualTo(200);
        return MAPPER.readTree(r.getContentAsByteArray());
    }

    private MockHttpServletResponse antwort(Welt w, String pfad) throws Exception {
        return mvc.perform(get("/api/v1/sites/" + w.anlage() + pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-" + w.mandant());
                    j.claim("name", "Mara Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))).andReturn().getResponse();
    }

    /**
     * Ersatz-Leser für eine Anlage ohne Hausspeicher mit bidirektionaler Wallbox (Basisfall A2, A1 S. 29–30): Z1 am
     * Netzanschluss (MS-01 Bezug, MS-02 Abgabe), Z2 am Ladepunkt (MS-03 Laden = Verbrauch, MS-04 Entladen = Erzeugung
     * im Ladepunkt, A1 S. 27).
     */
    private static final class LadepunktLeser extends MispelZaehlerLeser {

        LadepunktLeser() {
            super(null);
        }

        /** Der Ersatz liefert aus der angegebenen Wertequelle — wie nach einem Import der MSB-Werte (MP-15). */
        @Override
        public Gelesen lesen(com.voltpilot.api.uems.ZaehlerrolleRegeln.Knoten zaehler, Instant von, Instant bis) {
            return new Gelesen(lesen(zaehler.kennzeichen(), von, bis), zaehler.angaben().wertequelle());
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                out.put(t, new Menge(wert(kennzeichen, t), true));
            }
            return out;
        }

        private BigDecimal wert(String kz, Instant t) {
            ZonedDateTime z = t.atZone(MispelAbgrenzungRechenwerk.BERLIN);
            int h = z.getHour();
            // Das Auto lädt nur an geraden Tagen hier (01–04 Uhr aus dem Netz, 10–13 Uhr Sonne) und gibt jeden Abend
            // ab: 18–21 Uhr ins Haus, 21–22 Uhr ins Netz — an ungeraden Tagen mit anderswo geladenem Strom.
            boolean laedtHier = z.getDayOfMonth() % 2 == 0;
            double v = switch (kz) {
                case "MS-01" -> laedtHier && h >= 1 && h < 4 ? 3 : h >= 18 && h < 22 ? 0 : (h >= 10 && h < 13) ? 0 : 0.25;
                case "MS-02" -> h >= 10 && h < 13 ? (laedtHier ? 1 : 2) : h == 21 ? 1.5 : 0;
                case "MS-03" -> laedtHier ? (h >= 1 && h < 4 ? 2.75 : h >= 10 && h < 13 ? 1 : 0) : 0;
                case "MS-04" -> h >= 18 && h < 22 ? 2 : 0;
                default -> 0;
            };
            return BigDecimal.valueOf(v).setScale(3, RoundingMode.HALF_UP);
        }
    }

    /** Netzzähler MS-01/MS-02, Wallbox mit Z2 (MS-03/MS-04) ab 01.10.2026; Förderweg ab 01.11.2026 Abgrenzung A2. */
    private static Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Ladepunkt #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at, plant_kind, "
                + "anzulegender_wert_ct_kwh) VALUES (?, 'Haus Albers', '2026-09-01', 'direktvermarktung', 6.85) "
                + "RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP41A-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "grid-meter", "power_kw");
        UUID wallbox = komponente(t, anlage, box, "wallbox", "Wallbox Garage", "power_kw");
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
        quelle(t, box, ms3, "Laden", wallbox, "ev.charge-energy");
        quelle(t, box, ms4, "Entladen", wallbox, "ev.discharge-energy");
        rolle(t, ms1, "Z1", "DE0001234567890000000000000000001", "2026-10-01");
        rolle(t, ms2, "Z1", "DE0001234567890000000000000000001", "2026-10-01");
        rolle(t, ms3, "Z2", "DE0001234567890000000000000000002", "2026-10-01");
        rolle(t, ms4, "Z2", "DE0001234567890000000000000000002", "2026-10-01");
        root.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, nutzbarkeit, v2h, v2g, "
                + "rueckspeiseleistung_kw, gueltig_ab, created_by) VALUES (?, ?, ?, 'bidirektional', true, true, 11, "
                + "'2026-10-01', 'test')", t, anlage, wallbox);
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, aw_regel, "
                + "gueltig_ab, created_by) VALUES (?, ?, 'marktpraemie_ausschliesslichkeit', NULL, false, NULL, "
                + "'2026-10-01', 'test'), (?, ?, 'marktpraemie_abgrenzung', 'A2', true, 'viertelstunde', '2026-11-01', "
                + "'test')", t, anlage, t, anlage);
        root.update("INSERT INTO site_supply_price (site_id, tenant_id, umlagen_ct, netzentgelt_arbeitspreis_ct, "
                + "ust_pct) VALUES (?, ?, ?, ?, 19.0)", anlage, t, UMLAGEN_CT, NETZENTGELT_CT);
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT 'viertelstunde', g, "
                + "'PT15M', true FROM generate_series('2026-09-30T22:00Z'::timestamptz, '2026-12-31T22:45Z', "
                + "INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
        return new Welt(t, anlage, wallbox);
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String name, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?::jsonb, '2026-09-01') "
                + "RETURNING id", UUID.class, t, anlage, typ, name, typ, box,
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
