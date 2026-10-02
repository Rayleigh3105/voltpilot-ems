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
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
 * MiSpeL MP-16 Ende zu Ende: ein echter Monatslauf (MP-8, Zählerrollen MP-6, AW-Liste MP-7, Rumpfmonat MP-21) wird
 * gespeichert, und die Download-Routen liefern seinen Nachweis als CSV und PDF — die Zahlen sind genau die des
 * Rechenwerks, der Kopf nennt die Prüfsumme des gespeicherten Nachweis-Texts, das PDF ist byte-gleich zur reinen
 * Funktion. Dazu: vorläufig markiert, der Jahresnachweis mit Frist, und die Ablehnungen.
 *
 * <p>Welt und Ersatz-Leser wie {@code MispelAbgrenzungMonatslaufTest} (A1 S. 15–16: 130 kWh Bezug bei 100 kWh Laden,
 * 80 kWh Einspeisung bei 100 kWh Entladen; der Speicher kommt am 15.03.2027 hinzu).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MispelNachweisApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    private static final YearMonth MAERZ = YearMonth.of(2027, 3);
    private static final LocalDate RUMPF = LocalDate.of(2027, 3, 15);
    private static final Instant Q1 = Instant.parse("2027-03-17T11:00:00Z");
    private static final Instant Q2 = Instant.parse("2027-03-17T18:00:00Z");

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
    MispelNachweisService nachweise;

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

    private record Antwort(int status, String typ, String datei, byte[] inhalt) {

        JsonNode json() throws Exception {
            return MAPPER.readTree(inhalt);
        }
    }

    @Test
    void derMonatsnachweisTraegtDieZahlenDesRechenwerksUndDiePruefsummeDesGespeichertenNachweises() throws Exception {
        Welt w = welt("messstellenbetreiber");
        Lauf l = lauf(w);
        assertThat(l.zeile().stand()).isEqualTo("endgueltig");
        String gespeichert = root.queryForObject("SELECT nachweis FROM mispel_abgrenzung_monat WHERE id = ?",
                String.class, l.zeile().id());
        // Geordnet serialisiert: derselbe Lauf ergibt in jeder JVM denselben Text und dieselbe Prüfsumme.
        assertThat(gespeichert).contains("\"zeitraum\":{\"von\":\"2027-03-15T00:00+01:00\",\"bis\":");

        Antwort csv = ruf(w, "/monate/2027-03/nachweis.csv?empfaenger=netzbetreiber");
        assertThat(csv.status()).isEqualTo(200);
        assertThat(csv.typ()).startsWith("text/csv");
        assertThat(csv.datei()).contains("filename=\"mispel-abgrenzung-2027-03-netzbetreiber.csv\"");
        Map<String, String> kopf = MispelNachweisTest.kopf(csv.inhalt());
        assertThat(kopf.get("stand")).isEqualTo("endgueltig");
        assertThat(kopf.get("gilt_als_nachweis")).isEqualTo("ja");
        assertThat(kopf.get("nachweis")).isEqualTo("Mengenbestimmung nach Anlage 1 (Abgrenzungsoption) – "
                + "Kalendermonat März 2027");
        assertThat(kopf.get("nachweis_pruefsummen")).isEqualTo(l.zeile().pruefsumme())
                .isEqualTo(MispelAbgrenzungService.sha256(gespeichert));

        Map<String, List<Map<String, String>>> teile = MispelNachweisTest.csv(csv.inhalt());
        Map<String, Bruch> soll = l.ergebnis().monate().get("2027-03/15");
        assertThat(teile.get("formelsatz")).extracting(r -> r.get("nr")).containsExactlyElementsOf(soll.keySet());
        for (Map<String, String> r : teile.get("formelsatz")) {
            Bruch b = soll.get(r.get("nr"));
            assertThat(r.get("wert_exakt")).as(r.get("nr")).isEqualTo(b == null ? "" : b.text().replace(".", ","));
        }
        // A1 S. 15–16: (1)¼ = 100, (2)¼ = 80 — und genau so viele Viertelstunden wie gerechnet.
        assertThat(soll.get("(9)")).isEqualTo(Bruch.von(new BigDecimal("100")));
        assertThat(soll.get("(11)")).isEqualTo(Bruch.von(new BigDecimal("80")));
        assertThat(teile.get("viertelstunden")).hasSize(l.zeile().viertelstundenGerechnet());
        assertThat(teile.get("messkonzept")).extracting(r -> r.get("eingang") + " " + r.get("messstelle"))
                .containsExactly("Z1NB¼ MS-01", "Z1NE¼ MS-02", "Z2V¼ MS-03", "Z2E¼ MS-04");
        assertThat(teile.get("laeufe")).singleElement().satisfies(r -> {
            assertThat(r.get("schluessel")).isEqualTo("2027-03/15");
            assertThat(r.get("erster_tag")).isEqualTo("2027-03-15");
            assertThat(r.get("letzter_tag")).isEqualTo("2027-03-31");
        });

        Antwort pdf = ruf(w, "/monate/2027-03/nachweis.pdf?empfaenger=netzbetreiber");
        assertThat(pdf.status()).isEqualTo(200);
        assertThat(pdf.typ()).isEqualTo("application/pdf");
        TenantContext.set(w.mandant());
        byte[] rein = MispelNachweisPdf.datei(nachweise.monat(w.anlage(), MAERZ),
                MispelNachweis.empfaenger("netzbetreiber"));
        TenantContext.clear();
        assertThat(pdf.inhalt()).isEqualTo(rein);
        assertThat(MispelNachweisTest.pdfText(pdf.inhalt())).contains(l.zeile().pruefsumme())
                .contains("Mengenbestimmung nach Anlage 1").doesNotContain(MispelNachweisPdf.WASSERZEICHEN);
    }

    @Test
    void geraetewerteGehenAlsVorlaeufigHinausUndDerJahresnachweisNenntDieFrist() throws Exception {
        Welt w = welt("geraet");
        Lauf l = lauf(w);
        assertThat(l.zeile().stand()).isEqualTo("vorlaeufig");

        Antwort monat = ruf(w, "/monate/2027-03/nachweis.csv?empfaenger=lieferant");
        assertThat(monat.status()).isEqualTo(200);
        assertThat(monat.datei()).contains("mispel-abgrenzung-2027-03-lieferant-vorlaeufig.csv");
        Map<String, String> kopf = MispelNachweisTest.kopf(monat.inhalt());
        assertThat(kopf.get("gilt_als_nachweis")).isEqualTo("nein");
        assertThat(kopf.get("nachweis")).startsWith("Vorläufige Rechnung").contains("keine Mengenbestimmung");
        assertThat(kopf.get("wertequelle")).isEqualTo("geraet");
        assertThat(MispelNachweisTest.pdfText(ruf(w, "/monate/2027-03/nachweis.pdf?empfaenger=lieferant").inhalt()))
                .contains(MispelNachweisPdf.WASSERZEICHEN).contains("Gerätewerte statt Werte des Messstellenbetreibers");

        Antwort jahr = ruf(w, "/jahre/2027/nachweis.csv?empfaenger=lieferant");
        assertThat(jahr.status()).isEqualTo(200);
        Map<String, String> jk = MispelNachweisTest.kopf(jahr.inhalt());
        assertThat(jk.get("frist")).isEqualTo("Mitteilung bis 31.05.2028 (§ 21 Abs. 7 EnFG)");
        assertThat(jk.get("stand_gruende"))
                .isEqualTo("lauf_vorlaeufig:2027-03/15, nicht_bis_jahresende:2027-04-01/2027-12-31");
        assertThat(MispelNachweisTest.csv(jahr.inhalt()).get("ergebnis")).singleElement().satisfies(r -> {
            assertThat(r.get("nr")).isEqualTo("(22)");
            assertThat(r.get("wert_exakt")).isEqualTo(l.ergebnis().jahre().get("2027").get("(22)").text()
                    .replace(".", ","));
        });
        assertThat(ruf(w, "/jahre/2027/nachweis.pdf?empfaenger=direktvermarkter").status()).isEqualTo(200);
    }

    @Test
    void ablehnungenKommenAlsJsonUndFremdeAnlagenBleibenUnsichtbar() throws Exception {
        Welt w = welt("messstellenbetreiber");
        lauf(w);
        assertThat(ruf(w, "/monate/2027-03/nachweis.csv").json().get("code").asText())
                .isEqualTo("empfaenger_unbekannt");
        assertThat(ruf(w, "/monate/2027-03/nachweis.csv").status()).isEqualTo(400);
        Antwort ohne = ruf(w, "/monate/2027-02/nachweis.pdf?empfaenger=lieferant");
        assertThat(ohne.status()).isEqualTo(404);
        assertThat(ohne.json().get("code").asText()).isEqualTo("kein_lauf");
        assertThat(ruf(w, "/monate/2026-09/nachweis.csv?empfaenger=lieferant").status()).isEqualTo(400);
        assertThat(ruf(w, "/monate/2027-13/nachweis.csv?empfaenger=lieferant").json().get("code").asText())
                .isEqualTo("zeitraum_ungueltig");
        assertThat(ruf(w, "/jahre/27/nachweis.csv?empfaenger=lieferant").status()).isEqualTo(400);
        assertThat(ruf(w, "/jahre/2028/nachweis.csv?empfaenger=lieferant").status()).isEqualTo(404);

        Welt fremd = welt("messstellenbetreiber");
        Welt blick = new Welt(fremd.mandant(), w.anlage());
        assertThat(ruf(blick, "/monate/2027-03/nachweis.csv?empfaenger=lieferant").status()).isEqualTo(404);
        assertThat(ruf(blick, "/jahre/2027/nachweis.pdf?empfaenger=lieferant").status()).isEqualTo(404);
    }

    // ------------------------------------------------------------------ Hilfen

    private Lauf lauf(Welt w) {
        dienst.leserSetzen(new Leser());
        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-04-10T08:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());
        try {
            return dienst.monatslauf(w.anlage(), MAERZ, new Vorgaben("A1", "viertelstunde", null, null, Set.of(),
                    RUMPF, null));
        } finally {
            TenantContext.clear();
        }
    }

    private Antwort ruf(Welt w, String pfad) throws Exception {
        MockHttpServletResponse r = mvc.perform(get("/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung" + pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-" + w.mandant());
                    j.claim("name", "Mara Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))).andReturn().getResponse();
        return new Antwort(r.getStatus(), r.getContentType(), r.getHeader("Content-Disposition"),
                r.getContentAsByteArray());
    }

    /** Ersatz-Leser: jede Viertelstunde 0 kWh, außer den beiden der Beispielrechnungen (A1 S. 15–16). */
    private static final class Leser extends MispelZaehlerLeser {

        Leser() {
            super(null);
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                out.put(t, new Menge(wert(kennzeichen, t), true));
            }
            return out;
        }

        private static BigDecimal wert(String kz, Instant t) {
            if (t.equals(Q1)) {
                return switch (kz) {
                    case "MS-01" -> new BigDecimal("130");
                    case "MS-03" -> new BigDecimal("100");
                    default -> BigDecimal.ZERO;
                };
            }
            if (t.equals(Q2)) {
                return switch (kz) {
                    case "MS-02" -> new BigDecimal("80");
                    case "MS-04" -> new BigDecimal("100");
                    default -> BigDecimal.ZERO;
                };
            }
            return BigDecimal.ZERO;
        }
    }

    /** Netzzähler MS-01/MS-02 (Z1 ab 01.01.2027), Speicher MS-03/MS-04 (Z2 ab 15.03.2027), AW-Liste für März. */
    private static Welt welt(String wertequelleSpeicher) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Nachweis #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle N', "
                + "'2026-12-01') RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP16-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        UUID ms1 = messstelle(t, "MS-01", "Bezug");
        UUID ms2 = messstelle(t, "MS-02", "Abgabe");
        UUID ms3 = messstelle(t, "MS-03", "Laden");
        UUID ms4 = messstelle(t, "MS-04", "Entladen");
        stellung(t, anlage, ms1, "Hauptzähler", "2027-01-01");
        stellung(t, anlage, ms2, "Hauptzähler", "2027-01-01");
        stellung(t, anlage, ms3, "Speicher", "2027-03-15");
        stellung(t, anlage, ms4, "Speicher", "2027-03-15");
        quelle(t, box, ms1, "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms2, "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms3, "Laden", speicher, "battery.charge-energy");
        quelle(t, box, ms4, "Entladen", speicher, "battery.discharge-energy");
        rolle(t, ms1, "Z1", "DE0001234567890000000000000000001", "messstellenbetreiber", "2027-01-01");
        rolle(t, ms2, "Z1", "DE0001234567890000000000000000001", "messstellenbetreiber", "2027-01-01");
        rolle(t, ms3, "Z2", "DE0001234567890000000000000000002", wertequelleSpeicher, "2027-03-15");
        rolle(t, ms4, "Z2", "DE0001234567890000000000000000002", wertequelleSpeicher, "2027-03-15");
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT 'viertelstunde', g, "
                + "'PT15M', true FROM generate_series('2027-02-28T23:00Z'::timestamptz, '2027-03-31T21:45Z', "
                + "INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
        return new Welt(t, anlage);
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?::jsonb, '2026-12-01') "
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
                + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, '2027-01-01'::timestamptz, "
                + "'2026.09.11.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point "
                + "WHERE id = ? ON CONFLICT DO NOTHING", t, box, komponente, kanal, komponente);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2027-01-01'::timestamptz, false, now(), 'sub-test', 'Test', 'kunde')", t, ms, richtung, komponente,
                geraet, kanal);
    }

    private static void rolle(UUID t, UUID ms, String rolle, String zp, String wertequelle, String ab) {
        root.update("INSERT INTO messstelle_zaehlerrolle (tenant_id, messstelle_id, rolle, zaehlpunkt, "
                + "messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab) VALUES (?, ?, ?, ?, "
                + "'Netze Musterstadt GmbH', 'eichrechtskonform', '2034-12-31', ?, ?::date)", t, ms, rolle, zp,
                wertequelle, ab);
    }
}
