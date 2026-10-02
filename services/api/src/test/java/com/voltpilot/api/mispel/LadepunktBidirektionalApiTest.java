package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
 * MiSpeL MP-31 gegen die Datenbank: {@code GET/PUT /api/v1/sites/{siteId}/ladepunkte/…}.
 *
 * <p><b>Der Prüfnachweis des Pakets:</b> der Bestand bleibt unidirektional (keine Zeile, {@code erfasst: false});
 * ein Ladepunkt wird ab einem Tag bidirektional (V2H), und Z2 am Ladepunkt kommt mit Eichstatus und Urteil aus den
 * Zählerrollen, die über die Route von MP-6 gesetzt werden. Dazu die Einordnung nach Anlage 1 (S. 26 Fn. 21, S. 27
 * Fn. 22), Fassungen, das Fahrzeugfenster und der Mandantenzaun.
 *
 * <p>Die Welt entsteht über SQL (Komponenten, Messstellen, Stellungen, führende Quellen) wie in
 * {@code ZaehlerrolleApiTest}; die Zählerrollen setzt deren eigene Route.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class LadepunktBidirektionalApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String AB = "2026-01-01";
    private static final AtomicInteger NR = new AtomicInteger();

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
    LadepunktService ladepunkte;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void uhr() {
        // „Heute“ ist der 15.10.2026 (Mittag in Berlin) — unabhängig vom Tag des Laufs.
        ladepunkte.uhrStellen(Clock.fixed(Instant.parse("2026-10-15T10:00:00Z"), ZoneOffset.UTC));
    }

    /** Netz MS-01/MS-02, die OCPP-Säule {@code ev-charger} mit MS-03 (Bezug) und MS-04 (Abgabe), Wallbox mit MS-05. */
    private record Welt(UUID mandant, UUID anlage, UUID saeule, UUID wallbox, UUID netz, Map<String, UUID> ms) {
        UUID m(String kz) {
            return ms.get(kz);
        }
    }

    private record Antwort(int status, JsonNode body) {}

    // ------------------------------------------------------------------ der Prüfnachweis

    @Test
    void bestandBleibtUnidirektionalUndZ2KommtAusDenZaehlerrollen() throws Exception {
        Welt w = welt();
        // Bestand: kein Eintrag, beide Ladepunkte gelten als unidirektional (Captain-Vorgabe, A1 S. 26).
        Antwort liste = ruf(w, HttpMethod.GET, "", null);
        assertThat(liste.status()).isEqualTo(200);
        assertThat(liste.body().path("am").asText()).isEqualTo("2026-10-15");
        assertThat(liste.body().path("ladepunkte")).hasSize(2);
        for (JsonNode lp : liste.body().path("ladepunkte")) {
            assertThat(lp.path("faehigkeit").path("erfasst").asBoolean()).isFalse();
            assertThat(lp.path("faehigkeit").path("nutzbarkeit").asText()).isEqualTo("unidirektional");
            assertThat(lp.path("einordnung").asText()).isEqualTo("sonstiger_verbrauch");
            assertThat(lp.path("befunde")).isEmpty();
            assertThat(lp.path("fahrzeugfenster").isNull()).isTrue();
        }
        assertThat(liste.body().path("ladepunkte").get(0).path("charge_point_id").asText()).isEqualTo("CP-GARAGE");
        assertThat(liste.body().path("ladepunkte").get(0).path("name").asText()).isEqualTo("CP-GARAGE");
        assertThat(root.queryForObject("SELECT count(*) FROM ladepunkt_faehigkeit WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();

        // Z2 über die Route von MP-6: MS-03 mit Eichstatus, MS-04 ohne (nicht erhoben).
        assertThat(zaehlerrolle(w, "MS-03", "eichrechtskonform").status()).isEqualTo(200);
        assertThat(zaehlerrolle(w, "MS-04", null).status()).isEqualTo(200);
        // Der Bestand hinter Z2 ist sonstiger Verbrauch — der Befund zeigt es (A1 S. 25–26).
        JsonNode bestand = ruf(w, HttpMethod.GET, "/" + w.saeule(), null).body();
        assertThat(codes(bestand)).containsExactly("unidirektional_hinter_z2", "unidirektional_hinter_z2");

        // Ab dem 01.10.2026 bidirektional nutzbar (V2H).
        Antwort v2h = ruf(w, HttpMethod.PUT, "/" + w.saeule() + "/faehigkeit", faehigkeit("bidirektional", true,
                false, false, "2026-10-01"));
        assertThat(v2h.status()).isEqualTo(200);
        JsonNode a = v2h.body();
        assertThat(a.path("am").asText()).isEqualTo("2026-10-01");
        assertThat(a.path("faehigkeit").path("erfasst").asBoolean()).isTrue();
        assertThat(a.path("faehigkeit").path("v2h").asBoolean()).isTrue();
        assertThat(a.path("faehigkeit").path("rueckspeiseleistung_kw").decimalValue()).isEqualByComparingTo("7.4");
        assertThat(a.path("einordnung").asText()).isEqualTo("ladepunkt_der_festlegung");
        assertThat(a.path("einordnung_fundstelle").asText()).isEqualTo("Anlage 1 S. 26, Abschn. 3.2.5, Fn. 21");
        // Z2 am Ladepunkt: beide Richtungen, mit Eichstatus und dem Urteil der Zählerrolle.
        assertThat(a.path("z2")).hasSize(2);
        assertThat(a.path("z2").get(0).path("groesse").asText()).isEqualTo("Z2V");
        assertThat(a.path("z2").get(0).path("messstelle").asText()).isEqualTo("MS-03");
        assertThat(a.path("z2").get(0).path("eichstatus").asText()).isEqualTo("eichrechtskonform");
        assertThat(a.path("z2").get(0).path("zaehlpunkt").asText()).isEqualTo("DE0001234567890000000000000000003");
        assertThat(a.path("z2").get(0).path("urteil").asText()).isEqualTo("tauglich");
        assertThat(a.path("z2").get(1).path("groesse").asText()).isEqualTo("Z2E");
        assertThat(a.path("z2").get(1).path("eichstatus").isNull()).isTrue();
        assertThat(a.path("z2").get(1).path("urteil").asText()).isEqualTo("nicht_pruefbar");
        assertThat(codes(a)).containsExactly("z2_nicht_pruefbar");
        assertThat(a.path("befunde").get(0).path("fundstelle").asText())
                .isEqualTo("Tenor mit Begründung S. 28, Abschn. 3.2.3.2.1");

        // Am Tag davor gilt noch der Bestand.
        JsonNode vorher = ruf(w, HttpMethod.GET, "/" + w.saeule() + "?am=2026-09-30", null).body();
        assertThat(vorher.path("faehigkeit").path("erfasst").asBoolean()).isFalse();
        assertThat(vorher.path("einordnung").asText()).isEqualTo("sonstiger_verbrauch");

        // Die Wallbox ohne Zähler mit Rolle: V2G ohne Z2 — nur A11 oder Pauschaloption.
        assertThat(ruf(w, HttpMethod.PUT, "/" + w.wallbox() + "/faehigkeit", faehigkeit("bidirektional", false,
                true, false, "2026-10-01")).status()).isEqualTo(200);
        JsonNode wallbox = ruf(w, HttpMethod.GET, "/" + w.wallbox(), null).body();
        assertThat(wallbox.path("z2")).isEmpty();
        assertThat(codes(wallbox)).containsExactly("z2_fehlt");
    }

    @Test
    void fassungenStattUeberschreiben() throws Exception {
        Welt w = welt();
        String pfad = "/" + w.saeule() + "/faehigkeit";
        assertThat(ruf(w, HttpMethod.PUT, pfad, faehigkeit("bidirektional", true, false, false, "2026-10-01"))
                .status()).isEqualTo(200);
        // Rückbau ab 01.11.2026: ausdrücklich unidirektional.
        Map<String, Object> rueckbau = new LinkedHashMap<>();
        rueckbau.put("nutzbarkeit", "unidirektional");
        rueckbau.put("gueltig_ab", "2026-11-01");
        assertThat(ruf(w, HttpMethod.PUT, pfad, rueckbau).status()).isEqualTo(200);
        JsonNode oktober = ruf(w, HttpMethod.GET, "/" + w.saeule() + "?am=2026-10-20", null).body();
        assertThat(oktober.path("faehigkeit").path("gueltig_bis").asText()).isEqualTo("2026-10-31");
        JsonNode november = ruf(w, HttpMethod.GET, "/" + w.saeule() + "?am=2026-11-02", null).body();
        assertThat(november.path("faehigkeit").path("erfasst").asBoolean()).isTrue();
        assertThat(november.path("einordnung").asText()).isEqualTo("sonstiger_verbrauch");

        // Korrektur desselben Tages: die alte Fassung wird aufgehoben, nicht überschrieben.
        assertThat(ruf(w, HttpMethod.PUT, pfad, faehigkeit("bidirektional", true, true, false, "2026-10-01"))
                .status()).isEqualTo(200);
        JsonNode fassungen = ruf(w, HttpMethod.GET, "/" + w.saeule(), null).body().path("fassungen");
        assertThat(fassungen).hasSize(3);
        assertThat(fassungen.get(0).path("aufgehoben_am").isNull()).isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM ladepunkt_faehigkeit WHERE komponente_id = ? "
                + "AND aufgehoben_am IS NULL", Integer.class, w.saeule())).isEqualTo(2);
        assertThat(root.queryForObject("SELECT created_by FROM ladepunkt_faehigkeit WHERE komponente_id = ? LIMIT 1",
                String.class, w.saeule())).isEqualTo("Mara Test");

        // Dieselbe Fähigkeit noch einmal: 409.
        Antwort gleich = ruf(w, HttpMethod.PUT, pfad, faehigkeit("bidirektional", true, true, false, "2026-10-01"));
        assertThat(gleich.status()).isEqualTo(409);
        assertThat(gleich.body().path("code").asText()).isEqualTo("faehigkeit_unveraendert");

        // Form: Code und Grund; unbekanntes Feld und fehlender Tag.
        Antwort ohneWeise = ruf(w, HttpMethod.PUT, pfad, faehigkeit("bidirektional", false, false, false,
                "2026-12-01"));
        assertThat(ohneWeise.status()).isEqualTo(400);
        assertThat(ohneWeise.body().path("code").asText()).isEqualTo("faehigkeit_ungueltig");
        assertThat(ohneWeise.body().path("grund").asText()).isEqualTo("betriebsweise");
        Antwort v2gGesperrt = ruf(w, HttpMethod.PUT, pfad, faehigkeit("bidirektional", false, true, true,
                "2026-12-01"));
        assertThat(v2gGesperrt.body().path("grund").asText()).isEqualTo("unterbunden");
        Map<String, Object> fremdesFeld = faehigkeit("bidirektional", true, false, false, "2026-12-01");
        fremdesFeld.put("fahrzeug", "BMW iX3");
        Antwort unbekannt = ruf(w, HttpMethod.PUT, pfad, fremdesFeld);
        assertThat(unbekannt.status()).isEqualTo(400);
        assertThat(unbekannt.body().path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(unbekannt.body().path("feld").asText()).isEqualTo("fahrzeug");
        Map<String, Object> ohneTag = faehigkeit("bidirektional", true, false, false, null);
        assertThat(ruf(w, HttpMethod.PUT, pfad, ohneTag).body().path("feld").asText()).isEqualTo("gueltig_ab");
    }

    @Test
    void alternativeZurAusschliesslichkeit() throws Exception {
        Welt w = welt();
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, gueltig_ab) VALUES (?, ?, "
                + "'marktpraemie_ausschliesslichkeit', '2026-10-01')", w.mandant(), w.anlage());
        String pfad = "/" + w.saeule() + "/faehigkeit";
        ruf(w, HttpMethod.PUT, pfad, faehigkeit("bidirektional", true, false, false, "2026-10-01"));
        JsonNode mit = ruf(w, HttpMethod.GET, "/" + w.saeule(), null).body();
        assertThat(codes(mit)).contains("ausschliesslichkeit_mit_ladepunkt");
        // A1 S. 27 Fn. 22: die Rückspeisung bei gleichzeitiger Einspeisung technisch unterbunden.
        ruf(w, HttpMethod.PUT, pfad, faehigkeit("bidirektional", true, false, true, "2026-10-01"));
        JsonNode alternative = ruf(w, HttpMethod.GET, "/" + w.saeule(), null).body();
        assertThat(alternative.path("einordnung").asText()).isEqualTo("alternative_zur_ausschliesslichkeit");
        assertThat(alternative.path("einordnung_fundstelle").asText()).isEqualTo("Anlage 1 S. 27, Fn. 22; Abschn. 2.1.3");
        assertThat(codes(alternative)).doesNotContain("ausschliesslichkeit_mit_ladepunkt");
    }

    @Test
    void fahrzeugfensterNurAmBidirektionalenLadepunkt() throws Exception {
        Welt w = welt();
        String pfad = "/" + w.saeule() + "/fahrzeugfenster";
        Map<String, Object> fenster = new LinkedHashMap<>();
        fenster.put("mindest_soc_pct", 30);
        fenster.put("kapazitaet_kwh", 60);
        fenster.put("anwesenheit", List.of(
                Map.of("wochentag", 1, "ankunft", "18:00", "abfahrt", "07:00", "abfahrt_soc_pct", 80),
                Map.of("wochentag", 2, "ankunft", "18:00", "abfahrt", "07:00")));
        Antwort bestand = ruf(w, HttpMethod.PUT, pfad, fenster);
        assertThat(bestand.status()).isEqualTo(422);
        assertThat(bestand.body().path("code").asText()).isEqualTo("ladepunkt_nicht_bidirektional");

        // Ab morgen bidirektional reicht: das Fenster plant die Rückspeisung voraus.
        ruf(w, HttpMethod.PUT, "/" + w.saeule() + "/faehigkeit", faehigkeit("bidirektional", true, false, false,
                "2026-10-16"));
        Antwort ok = ruf(w, HttpMethod.PUT, pfad, fenster);
        assertThat(ok.status()).isEqualTo(200);
        JsonNode f = ok.body().path("fahrzeugfenster");
        assertThat(f.path("mindest_soc_pct").decimalValue()).isEqualByComparingTo("30");
        assertThat(f.path("kapazitaet_kwh").decimalValue()).isEqualByComparingTo("60");
        assertThat(f.path("anwesenheit")).hasSize(2);
        assertThat(f.path("anwesenheit").get(0).path("ankunft").asText()).isEqualTo("18:00");
        assertThat(f.path("anwesenheit").get(0).path("abfahrt_soc_pct").decimalValue()).isEqualByComparingTo("80");
        assertThat(f.path("anwesenheit").get(1).path("abfahrt_soc_pct").isNull()).isTrue();
        assertThat(f.path("geaendert_von").asText()).isEqualTo("Mara Test");

        // Ersetzen, nicht anhängen.
        fenster.put("anwesenheit", List.of(Map.of("wochentag", 6, "ankunft", "09:00", "abfahrt", "21:00")));
        assertThat(ruf(w, HttpMethod.PUT, pfad, fenster).status()).isEqualTo(200);
        assertThat(root.queryForObject("SELECT count(*) FROM ladepunkt_anwesenheit WHERE komponente_id = ?",
                Integer.class, w.saeule())).isEqualTo(1);

        // Überschneidung und Abfahrt unter dem Mindest-Ladestand.
        fenster.put("anwesenheit", List.of(
                Map.of("wochentag", 1, "ankunft", "18:00", "abfahrt", "07:00"),
                Map.of("wochentag", 2, "ankunft", "06:00", "abfahrt", "08:00")));
        Antwort ueber = ruf(w, HttpMethod.PUT, pfad, fenster);
        assertThat(ueber.status()).isEqualTo(400);
        assertThat(ueber.body().path("grund").asText()).isEqualTo("ueberschneidung");
        fenster.put("anwesenheit", List.of(Map.of("wochentag", 1, "ankunft", "18:00", "abfahrt", "07:00",
                "abfahrt_soc_pct", 20)));
        assertThat(ruf(w, HttpMethod.PUT, pfad, fenster).body().path("grund").asText()).isEqualTo("abfahrt_soc");
        fenster.put("anwesenheit", List.of(Map.of("wochentag", 1, "ankunft", "18 Uhr", "abfahrt", "07:00")));
        assertThat(ruf(w, HttpMethod.PUT, pfad, fenster).body().path("code").asText()).isEqualTo("anfrage_ungueltig");
    }

    @Test
    void mandantenzaunUndNurLadepunkte() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        // Eine Komponente, die kein Ladepunkt ist, und ein fremder Ladepunkt: 404, nie 403.
        Antwort netz = ruf(w, HttpMethod.GET, "/" + w.netz(), null);
        assertThat(netz.status()).isEqualTo(404);
        assertThat(netz.body().path("code").asText()).isEqualTo("ladepunkt_unbekannt");
        assertThat(ruf(w, HttpMethod.PUT, "/" + fremd.saeule() + "/faehigkeit", faehigkeit("bidirektional", true,
                false, false, "2026-10-01")).status()).isEqualTo(404);
        assertThat(ruf(w, fremd.anlage(), HttpMethod.GET, "", null).status()).isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM ladepunkt_faehigkeit WHERE tenant_id = ?", Integer.class,
                fremd.mandant())).isZero();
    }

    // ------------------------------------------------------------------ Bausteine

    private static Map<String, Object> faehigkeit(String nutzbarkeit, boolean v2h, boolean v2g, boolean unterbunden,
            String ab) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("nutzbarkeit", nutzbarkeit);
        b.put("v2h", v2h);
        b.put("v2g", v2g);
        b.put("rueckspeisung_bei_einspeisung_unterbunden", unterbunden);
        b.put("rueckspeiseleistung_kw", v2h || v2g ? 7.4 : null);
        b.put("gueltig_ab", ab);
        return b;
    }

    private Antwort zaehlerrolle(Welt w, String kz, String eichstatus) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("rolle", "Z2");
        b.put("zaehlpunkt", "DE0001234567890000000000000000003");
        b.put("messstellenbetreiber", "Netze Musterstadt GmbH");
        b.put("eichstatus", eichstatus);
        b.put("eichfrist_bis", "2034-12-31");
        b.put("wertequelle", "messstellenbetreiber");
        b.put("gueltig_ab", AB);
        MockHttpServletRequestBuilder anfrage = request(HttpMethod.PUT,
                "/api/v1/messstellen/" + w.m(kz) + "/zaehlerrolle").with(kunde(w)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(b));
        return antwort(mvc.perform(anfrage).andReturn());
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Ladepunkt #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Hof L', "
                + "'2025-12-01') RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-LADEPUNKT-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID saeule = komponente(t, anlage, box, "ev-charger", "power_kw");
        UUID wallbox = komponente(t, anlage, box, "wallbox", "power_kw");
        root.update("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, entity_id, "
                + "reported_at) VALUES (?, 'CP-GARAGE', ?, ?, ?, now())", box, t, anlage, saeule);
        Map<String, UUID> ms = new LinkedHashMap<>();
        ms.put("MS-01", messstelle(t, "MS-01", "Bezug"));
        ms.put("MS-02", messstelle(t, "MS-02", "Abgabe"));
        ms.put("MS-03", messstelle(t, "MS-03", "Bezug"));
        ms.put("MS-04", messstelle(t, "MS-04", "Abgabe"));
        ms.put("MS-05", messstelle(t, "MS-05", "Bezug"));
        stellung(t, anlage, ms.get("MS-01"), "Hauptzähler");
        stellung(t, anlage, ms.get("MS-02"), "Hauptzähler");
        stellung(t, anlage, ms.get("MS-03"), "Abzweig");
        stellung(t, anlage, ms.get("MS-04"), "Abzweig");
        stellung(t, anlage, ms.get("MS-05"), "Abzweig");
        quelle(t, box, ms.get("MS-01"), "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms.get("MS-02"), "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms.get("MS-03"), "Bezug", saeule, "ocpp.energy-import");
        quelle(t, box, ms.get("MS-04"), "Abgabe", saeule, "ocpp.energy-export");
        quelle(t, box, ms.get("MS-05"), "Bezug", wallbox, "wallbox.energy-import");
        return new Welt(t, anlage, saeule, wallbox, netz, ms);
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?::jsonb, ?::timestamptz) "
                + "RETURNING id", UUID.class, t, anlage, typ, "ev-charger".equals(typ) ? null : typ, typ, box,
                "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}",
                "ev-charger".equals(typ) ? "2025-12-01T00:00:00Z" : "2025-12-01T00:00:01Z");
    }

    private static UUID messstelle(UUID t, String kz, String richtung) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kz, kz, richtung);
    }

    private static void stellung(UUID t, UUID anlage, UUID ms, String stellung) {
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, ?, NULL, ?::date)", t, ms, anlage, stellung, AB);
    }

    private static void quelle(UUID t, UUID box, UUID ms, String richtung, UUID komponente, String kanal) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, ?::timestamptz, "
                + "'2026.09.11.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point "
                + "WHERE id = ? ON CONFLICT DO NOTHING", t, box, komponente, kanal, AB, komponente);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "?::timestamptz, true, now(), 'sub-test', 'Test', 'kunde')", t, ms, richtung, komponente, geraet, kanal,
                AB);
    }

    private static List<String> codes(JsonNode ansicht) {
        return java.util.stream.StreamSupport.stream(ansicht.path("befunde").spliterator(), false)
                .map(b -> b.path("code").asText()).toList();
    }

    private static org.springframework.test.web.servlet.request.RequestPostProcessor kunde(Welt w) {
        return jwt().jwt(j -> {
            j.subject("sub-mispel-" + w.mandant());
            j.claim("name", "Mara Test");
            j.claim("tenant_id", w.mandant().toString());
        });
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        return ruf(w, w.anlage(), methode, pfad, body);
    }

    private Antwort ruf(Welt w, UUID anlage, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, "/api/v1/sites/" + anlage + "/ladepunkte" + pfad)
                .with(kunde(w)).contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        return antwort(mvc.perform(anfrage).andReturn());
    }

    private static Antwort antwort(MvcResult r) throws Exception {
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
