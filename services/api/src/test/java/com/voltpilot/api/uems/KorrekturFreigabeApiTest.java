package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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
 * Vier Augen bei Korrekturen (UEMS AP-08 IP-15, Entscheid E8 = A) gegen die echte Kette: JWT → TenantFilter →
 * Controller → Rechte-Ableitung → RLS → Datenbank. Personen aus dem Referenzunternehmen Ahrenberg: Ines Kaltenbach
 * erstellt, Jonas Wendlinger gibt als zweite Person frei; Lena Voss (VoltPilot-Support) ist heute der Plattform-Admin
 * im Kundenbereich — ein Unterstützer.
 *
 * <p>Die Abnahme: die Vorgabe ist AUS; bei AN wird die Erstellerin mit 403 abgewiesen, obwohl sie das Recht hat — und
 * bei AUS darf dieselbe Erstellerin freigeben; ein Unterstützer wird immer abgewiesen; fremd bleibt 404; jede Freigabe
 * protokolliert Ersteller, Freigeber, Zeitpunkt und Begründung; die Einstellung wirkt zum Zeitpunkt der Freigabe.
 * Jede Ablehnung schreibt nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KorrekturFreigabeApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String VIERAUGEN = "/api/v1/unternehmen/vieraugen";
    private static final String BEGRUENDUNG = "Nachlieferung nach Endgültigkeit (Box Halle 2 repariert)";

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
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

    private record Wer(String sub, String name, UUID kundenbereich, boolean plattform) {}

    private record Antwort(int status, JsonNode body) {}

    /** Ein Kundenbereich mit Unternehmen und seinen drei Personen. */
    private record Welt(UUID mandant, Wer ines, Wer jonas, Wer voss) {

        String korrektur(String kennung) {
            return "/api/v1/korrekturen/" + kennung;
        }
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    // =========================================================================== Vorgabe aus

    /** E8: ein Kunde, der nichts einstellt, bekommt kein Vier-Augen-Prinzip — die Erstellerin gibt selbst frei. */
    @Test
    void dieVorgabeIstAusUndDieErstellerinGibtSelbstFrei() throws Exception {
        Welt w = welt();
        Antwort einstellung = ok(ruf(w.ines(), HttpMethod.GET, VIERAUGEN, null), 200);
        assertThat(einstellung.body()).isEqualTo(MAPPER.readTree("{\"vieraugen\": false, \"vorgabe\": true}"));
        assertThat(root.queryForObject("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ?", Boolean.class,
                w.mandant())).isNull();

        vorschlag(w, "K-2027-0002", w.ines());
        Antwort frei = ok(ruf(w.ines(), HttpMethod.POST, w.korrektur("K-2027-0002") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)), 200);
        assertThat(frei.body().get("status").asText()).isEqualTo("freigegeben");
        assertThat(frei.body().get("vieraugen").asBoolean()).isFalse();
        assertThat(frei.body().get("von_ersteller").asBoolean()).as("„freigegeben von der Erstellerin“").isTrue();
        assertThat(fassungen(w, "K-2027-0002")).containsExactly("vorschlag", "freigegeben");
        assertThat(root.queryForObject("SELECT freigabe_vieraugen FROM messreihe_korrektur WHERE tenant_id = ? "
                + "AND kennung = 'K-2027-0002' AND fassung = 2", Boolean.class, w.mandant())).isFalse();
    }

    // =========================================================================== Vier Augen an

    /** E8 an: Ersteller ≠ Freigeber — die Erstellerin wird mit 403 abgewiesen, obwohl sie das Recht hätte. */
    @Test
    void beiAnWirdDieErstellerinMit403AbgewiesenUndJonasGibtFrei() throws Exception {
        Welt w = welt();
        vorschlag(w, "K-2027-0002", w.ines());
        Antwort an = ok(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", true)), 200);
        assertThat(an.body()).isEqualTo(MAPPER.readTree("{\"vieraugen\": true, \"vorgabe\": false}"));
        Map<String, Object> eintrag = root.queryForMap("SELECT art, alt::text AS alt, neu::text AS neu, actor_sub "
                + "FROM ort_aenderung WHERE tenant_id = ? AND objekt_art = 'unternehmen'", w.mandant());
        assertThat(eintrag).containsEntry("art", "bearbeitet").containsEntry("actor_sub", w.jonas().sub());
        assertThat(MAPPER.readTree((String) eintrag.get("alt"))).isEqualTo(MAPPER.readTree("{\"vieraugen_freigabe\": null}"));
        assertThat(MAPPER.readTree((String) eintrag.get("neu"))).isEqualTo(MAPPER.readTree("{\"vieraugen_freigabe\": true}"));

        Antwort selbst = ruf(w.ines(), HttpMethod.POST, w.korrektur("K-2027-0002") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG));
        assertThat(selbst.status()).isEqualTo(403);
        assertThat(selbst.body().get("code").asText()).isEqualTo("zweite_person_noetig");
        assertThat(selbst.body().get("message").asText()).isEqualTo("Freigabe durch eine zweite Person.");
        assertThat(fassungen(w, "K-2027-0002")).as("nichts geschrieben").containsExactly("vorschlag");

        Antwort frei = ok(ruf(w.jonas(), HttpMethod.POST, w.korrektur("K-2027-0002") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)), 200);
        // Die vier Angaben aus E8: Ersteller, Freigeber, Zeitpunkt, Begründung — dazu die Regel, unter der es geschah.
        JsonNode b = frei.body();
        assertThat(b.get("ersteller")).isEqualTo(MAPPER.readTree(
                "{\"name\": \"Ines Kaltenbach\", \"rolle\": \"kundenadministrator\", \"art\": \"kunde\"}"));
        assertThat(b.get("entschieden_von")).isEqualTo(MAPPER.readTree(
                "{\"name\": \"Jonas Wendlinger\", \"rolle\": \"kundenadministrator\", \"art\": \"kunde\"}"));
        assertThat(b.get("entschieden_am").asText()).isNotBlank();
        assertThat(b.get("begruendung").asText()).isEqualTo(BEGRUENDUNG);
        assertThat(b.get("vieraugen").asBoolean()).isTrue();
        assertThat(b.get("von_ersteller").asBoolean()).isFalse();
        Map<String, Object> fassung = root.queryForMap("SELECT actor_sub, grund, created_at, freigabe_vieraugen "
                + "FROM messreihe_korrektur WHERE tenant_id = ? AND kennung = 'K-2027-0002' AND fassung = 2", w.mandant());
        assertThat(fassung).containsEntry("actor_sub", w.jonas().sub()).containsEntry("grund", BEGRUENDUNG)
                .containsEntry("freigabe_vieraugen", true);
        assertThat(fassung.get("created_at")).isNotNull();
    }

    /** E14: einen Vorschlag des Systems (ohne Person) gibt auch bei an eine Person frei — sie ist die zweite. */
    @Test
    void beiAnGibtEinMenschDenVorschlagDesSystemsFrei() throws Exception {
        Welt w = welt();
        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE tenant_id = ?", w.mandant());
        vorschlag(w, "K-2026-0007", null);
        Antwort frei = ok(ruf(w.ines(), HttpMethod.POST, w.korrektur("K-2026-0007") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)), 200);
        assertThat(frei.body().get("ersteller").get("art").asText()).isEqualTo("voltpilot");
        assertThat(frei.body().get("vieraugen").asBoolean()).isTrue();
    }

    // =========================================================================== Zeitpunkt

    /** Die Einstellung wirkt zum Zeitpunkt der Freigabe: heute vorgeschlagen, morgen unter der Einstellung von morgen. */
    @Test
    void dieEinstellungWirktZumZeitpunktDerFreigabeNichtDesVorschlags() throws Exception {
        Welt w = welt();
        vorschlag(w, "K-2027-0003", w.ines());   // vorgeschlagen unter „aus“
        ok(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", true)), 200);
        assertThat(ruf(w.ines(), HttpMethod.POST, w.korrektur("K-2027-0003") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)).body().get("code").asText()).isEqualTo("zweite_person_noetig");

        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) SELECT tenant_id, 'K-2027-0004', 1, "
                + "status, art, reihen, von, bis, begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art "
                + "FROM messreihe_korrektur WHERE tenant_id = ? AND kennung = 'K-2027-0003'", w.mandant());
        ok(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", false)), 200);   // vorgeschlagen unter „an“
        Antwort frei = ok(ruf(w.ines(), HttpMethod.POST, w.korrektur("K-2027-0004") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)), 200);
        assertThat(frei.body().get("vieraugen").asBoolean()).isFalse();
        assertThat(ok(ruf(w.ines(), HttpMethod.POST, w.korrektur("K-2027-0003") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)), 200).body().get("von_ersteller").asBoolean()).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?", Long.class, w.mandant()))
                .as("an, dann aus — zwei Einträge").isEqualTo(2);
    }

    // =========================================================================== Unterstützer

    /** Ein Unterstützer gibt NIE frei — bei aus und bei an, stellt nichts ein und nimmt nichts zurück. */
    @Test
    void derUnterstuetzerWirdImmerMit403Abgewiesen() throws Exception {
        Welt w = welt();
        vorschlag(w, "K-2027-0005", w.ines());
        verboten(ruf(w.voss(), HttpMethod.POST, w.korrektur("K-2027-0005") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)), "bei aus");
        verboten(ruf(w.voss(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", true)), "einstellen");
        assertThat(ok(ruf(w.voss(), HttpMethod.GET, VIERAUGEN, null), 200).body().get("vorgabe").asBoolean())
                .as("lesen darf er, eingestellt hat er nichts").isTrue();

        ok(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", true)), 200);
        verboten(ruf(w.voss(), HttpMethod.POST, w.korrektur("K-2027-0005") + "/freigeben",
                Map.of("begruendung", BEGRUENDUNG)), "bei an");
        assertThat(fassungen(w, "K-2027-0005")).containsExactly("vorschlag");

        ok(ruf(w.jonas(), HttpMethod.POST, w.korrektur("K-2027-0005") + "/freigeben", Map.of("begruendung", BEGRUENDUNG)), 200);
        verboten(ruf(w.voss(), HttpMethod.POST, w.korrektur("K-2027-0005") + "/zuruecknehmen",
                Map.of("grund", "Die Box hat den Puffer doppelt geschickt.")), "zurücknehmen");
        assertThat(fassungen(w, "K-2027-0005")).containsExactly("vorschlag", "freigegeben");
    }

    // =========================================================================== Zaun

    /** Fremd ist 404, nie 403 — für den Kunden eines anderen Bereichs UND für den Unterstützer dort. */
    @Test
    void einFremderKundenbereichBekommt404UndNie403() throws Exception {
        Welt a = welt();
        Welt b = welt();
        vorschlag(a, "K-2027-0006", a.ines());
        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE tenant_id = ?", b.mandant());
        for (Wer fremd : List.of(b.jonas(), b.ines(), b.voss())) {
            Antwort r = ruf(fremd, HttpMethod.POST, a.korrektur("K-2027-0006") + "/freigeben",
                    Map.of("begruendung", BEGRUENDUNG));
            assertThat(r.status()).as(fremd.name()).isEqualTo(404);
            assertThat(r.body().get("code").asText()).isEqualTo("nicht_gefunden");
            assertThat(ruf(fremd, HttpMethod.POST, a.korrektur("K-2027-0006") + "/zuruecknehmen",
                    Map.of("grund", "Die Box hat den Puffer doppelt geschickt.")).status()).as(fremd.name()).isEqualTo(404);
        }
        assertThat(ruf(a.jonas(), HttpMethod.POST, "/api/v1/korrekturen/EW-2027-0001/freigeben",
                Map.of("begruendung", BEGRUENDUNG)).status()).as("keine Korrektur-Kennung").isEqualTo(404);
        assertThat(fassungen(a, "K-2027-0006")).containsExactly("vorschlag");
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id IN (?, ?)", Long.class,
                a.mandant(), b.mandant())).isZero();
    }

    // =========================================================================== Begründung und Stand

    /** Die Freigabe protokolliert VIER Dinge — fehlt die Begründung, ist sie unvollständig, und nichts wird geschrieben. */
    @Test
    void ohneBegruendungKeineFreigabe() throws Exception {
        Welt w = welt();
        vorschlag(w, "K-2027-0008", w.ines());
        String pfad = w.korrektur("K-2027-0008") + "/freigeben";
        abgelehnt(ruf(w.jonas(), HttpMethod.POST, pfad, Map.of()), 422, "begruendung_fehlt");
        abgelehnt(ruf(w.jonas(), HttpMethod.POST, pfad, Map.of("begruendung", "   ")), 422, "begruendung_fehlt");
        Antwort kurz = abgelehnt(ruf(w.jonas(), HttpMethod.POST, pfad, Map.of("begruendung", "passt")), 422,
                "begruendung_fehlt");
        assertThat(kurz.body().get("zeichen").asInt()).isEqualTo(5);
        abgelehnt(ruf(w.jonas(), HttpMethod.POST, pfad, null), 400, "anfrage_ungueltig");
        assertThat(abgelehnt(ruf(w.jonas(), HttpMethod.POST, pfad, Map.of("begruendung", BEGRUENDUNG, "freigeber", "JW")),
                400, "anfrage_ungueltig").body().get("feld").asText()).isEqualTo("freigeber");
        assertThat(fassungen(w, "K-2027-0008")).containsExactly("vorschlag");
        abgelehnt(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", "ja")), 400, "anfrage_ungueltig");
    }

    /** Freigeben nur einen Vorschlag, zurücknehmen nur eine freigegebene — mit Grund; die Korrektur bleibt sichtbar. */
    @Test
    void zuruecknehmenUndDerStand() throws Exception {
        Welt w = welt();
        vorschlag(w, "K-2027-0009", w.ines());
        String k = w.korrektur("K-2027-0009");
        abgelehnt(ruf(w.jonas(), HttpMethod.POST, k + "/zuruecknehmen", Map.of("grund", "Die Box hat den Puffer doppelt "
                + "geschickt.")), 409, "status_passt_nicht");
        ok(ruf(w.jonas(), HttpMethod.POST, k + "/freigeben", Map.of("begruendung", BEGRUENDUNG)), 200);
        Antwort wieder = abgelehnt(ruf(w.jonas(), HttpMethod.POST, k + "/freigeben", Map.of("begruendung", BEGRUENDUNG)),
                409, "status_passt_nicht");
        assertThat(wieder.body().get("status").asText()).isEqualTo("freigegeben");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, k + "/zuruecknehmen", Map.of()), 422, "begruendung_fehlt");

        ok(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", true)), 200);
        // §5 wörtlich: den Widerruf beschränkt der Bedienablauf nur für den Bearbeiter.
        Antwort zurueck = ok(ruf(w.ines(), HttpMethod.POST, k + "/zuruecknehmen",
                Map.of("grund", "Die Box hat den Puffer doppelt geschickt.")), 200);
        assertThat(zurueck.body().get("status").asText()).isEqualTo("zurueckgenommen");
        assertThat(zurueck.body().get("fassung").asInt()).isEqualTo(3);
        assertThat(zurueck.body().get("vieraugen").isNull()).isTrue();
        assertThat(fassungen(w, "K-2027-0009")).containsExactly("vorschlag", "freigegeben", "zurueckgenommen");
    }

    /** Dasselbe noch einmal einzustellen schreibt nichts; von der Vorgabe auf „aus“ ist eine Änderung. */
    @Test
    void einstellenOhneAenderungSchreibtNichts() throws Exception {
        Welt w = welt();
        assertThat(ok(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", false)), 200).body())
                .isEqualTo(MAPPER.readTree("{\"vieraugen\": false, \"vorgabe\": false}"));
        ok(ruf(w.jonas(), HttpMethod.PUT, VIERAUGEN, Map.of("vieraugen", false)), 200);
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?", Long.class, w.mandant()))
                .isEqualTo(1);
    }

    // =========================================================================== Hilfen

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Vier Augen #" + nr);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", t);
        return new Welt(t, new Wer("kc-ines-" + t, "Ines Kaltenbach", t, false),
                new Wer("kc-jonas-" + t, "Jonas Wendlinger", t, false),
                new Wer("kc-lena-voss", "Lena Voss", t, true));
    }

    /** Ein Vorschlag, wie der Stundenlauf (ohne Person) oder ein Mensch (IP-16) ihn anlegt — Fassung 1. */
    private static void vorschlag(Welt w, String kennung, Wer ersteller) {
        UUID u = root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, w.mandant());
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, w.mandant(), u, "ST-" + NR.incrementAndGet());
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg') RETURNING id", UUID.class, w.mandant());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, '2024-01-01')", w.mandant(), site, st);
        UUID entity = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type) "
                + "VALUES (?, ?, 'grid-meter', 'Halle 2', 'grid-meter') RETURNING id", UUID.class, w.mandant(), site);
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, 'vorschlag', "
                + "'nachlieferung_nach_endgueltigkeit', ?::jsonb, '2026-11-03T13:00:00Z', '2026-11-03T16:45:00Z', "
                + "'Nachlieferung nach Endgültigkeit (Box Halle 2 repariert)', '[{}]', ?, ?, ?, ?)",
                w.mandant(), kennung, "[{\"entity_id\": \"" + entity + "\", \"messkanal\": \"energy_import_kwh\"}]",
                ersteller == null ? null : ersteller.sub(), ersteller == null ? "VoltPilot" : ersteller.name(),
                ersteller == null ? "voltpilot_betrieb" : "kundenadministrator", ersteller == null ? "voltpilot" : "kunde");
    }

    private static List<String> fassungen(Welt w, String kennung) {
        return root.queryForList("SELECT status FROM messreihe_korrektur WHERE tenant_id = ? AND kennung = ? "
                + "ORDER BY fassung", String.class, w.mandant(), kennung);
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(String.valueOf(a.body())).isEqualTo(status);
        return a;
    }

    private static Antwort abgelehnt(Antwort a, int status, String code) {
        assertThat(a.status()).as(String.valueOf(a.body())).isEqualTo(status);
        assertThat(a.body().get("code").asText()).isEqualTo(code);
        assertThat(a.body().get("message").asText()).isEqualTo(
                KorrekturFreigabeAbgelehnt.Ablehnung.valueOf(code.toUpperCase()).satz());
        return a;
    }

    /** Unterstützer nie: 403 {@code recht_fehlt} ohne Rolle, die es gäbe — nie „zweite Person“. */
    private static void verboten(Antwort a, String wann) {
        assertThat(a.status()).as(wann + " " + a.body()).isEqualTo(403);
        assertThat(a.body().get("code").asText()).as(wann).isEqualTo("recht_fehlt");
        assertThat(a.body().get("message").asText()).isEqualTo("Dafür fehlt Ihnen das Recht.");
        assertThat(a.body().get("rolle_noetig").isNull()).as(wann).isTrue();
    }

    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    j.claim("preferred_username", wer.name());
                    if (!wer.plattform()) {
                        j.claim("tenant_id", wer.kundenbereich().toString());
                    }
                }).authorities(wer.plattform()
                        ? List.of(new SimpleGrantedAuthority("ROLE_platform-admin")) : List.of()))
                .contentType(MediaType.APPLICATION_JSON);
        if (wer.plattform()) {
            anfrage.header("X-Tenant-Id", wer.kundenbereich().toString());
        }
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
