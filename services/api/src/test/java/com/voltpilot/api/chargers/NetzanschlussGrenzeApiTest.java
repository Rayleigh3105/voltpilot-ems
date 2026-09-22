package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.NetzanschlussAbgelehnt.Ablehnung;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.LinkedHashMap;
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
 * Das Grenzblatt am Netzanschluss (UEMS AP-15 IP-3, Kasten W1) gegen die echte Kette: die Routen
 * {@code GET/POST /api/v1/standorte/{id}/netzanschluesse/{id}/grenzen}, jede Ablehnung (schreibt nichts), das Protokoll
 * {@code grenze}, RLS/{@code FORCE}/Rechte der Tabelle — und der PAARBEWEIS am Ladepark-Dokument: für jede Anlage
 * ohne wirksame Fassung sind die Bytes des Dokuments dieselben wie mit dem Rahmen allein (Stand vor IP-3); mit
 * Fassung reist der engere Wert. Liegt im Paket {@code chargers}, weil der Dokument-Bauer dort paketprivat ist.
 * Der Optimierer-Eingang hat seinen Paarbeweis in {@code services/optimization/tests/test_freshness.py}.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class NetzanschlussGrenzeApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final LocalDate HEUTE = LocalDate.now(ZoneOffset.UTC);

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
    ChargingConfigService ladepark;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Ein Kundenbereich: Standorte ST-1/ST-2, Anlage AN-1 an ST-1, Netzanschluss NA-1 (630 kVA, 550 kW vereinbart). */
    private record Welt(UUID mandant, UUID st1, UUID st2, UUID an1, UUID na1) {
        String grenzen() {
            return "/api/v1/standorte/" + st1 + "/netzanschluesse/" + na1 + "/grenzen";
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    // ============================================================================ R1: setzen und lesen

    @Test
    void r1GrenzblattSetzenLesenUndGenauEinProtokolleintrag() throws Exception {
        Welt w = welt();
        Antwort a = ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze("2027-05-03", 100, 550)), 201);
        assertThat(a.body().get("fassungen")).hasSize(1);
        assertThat(a.body().get("gilt").isNull()).as("ab 03.05.2027 gilt heute noch nichts").isTrue();

        JsonNode am = ok(ruf(w, HttpMethod.GET, w.grenzen() + "?stichtag=2027-06-13", null), 200).body();
        assertThat(am.get("kennzeichen").asText()).isEqualTo("NA-1");
        assertThat(am.at("/gilt/gueltig_ab").asText()).isEqualTo("2027-05-03");
        assertThat(am.at("/gilt/einspeisegrenze_kw").decimalValue()).isEqualByComparingTo("100");
        assertThat(am.at("/gilt/bezugsgrenze_kw").decimalValue()).isEqualByComparingTo("550");
        assertThat(ok(ruf(w, HttpMethod.GET, w.grenzen() + "?stichtag=2027-05-02", null), 200).body().get("gilt")
                .isNull()).as("der Vortag gehört noch keiner Fassung").isTrue();

        List<Map<String, Object>> protokoll = protokoll(w);
        assertThat(protokoll).hasSize(1);
        assertThat(protokoll.get(0).get("alt")).isNull();
        JsonNode neu = MAPPER.readTree(protokoll.get(0).get("neu").toString());
        assertThat(neu.get("gueltig_ab").asText()).isEqualTo("2027-05-03");
        assertThat(neu.get("bezugsgrenze_kw").decimalValue()).isEqualByComparingTo("550");
        assertThat(protokoll.get(0).get("rueckwirkend")).isEqualTo(false);
    }

    @Test
    void ausdruecklichKeineIstZeitgueltigProtokolliertUndNichtDasselbeWieUnbekannt() throws Exception {
        Welt w = welt();
        Map<String, Object> leer = grenze("2027-05-03", null, 550);
        ok(ruf(w, HttpMethod.POST, w.grenzen(), leer), 201);
        Map<String, Object> keine = grenze("2027-05-03", null, 550);
        keine.put("einspeisegrenze_keine", true);
        JsonNode a = ok(ruf(w, HttpMethod.POST, w.grenzen(), keine), 201).body();
        assertThat(a.at("/fassungen/0/einspeisegrenze_keine").asBoolean()).isTrue();
        assertThat(a.at("/fassungen/0/einspeisegrenze_kw").isNull()).isTrue();
        JsonNode am = ok(ruf(w, HttpMethod.GET, w.grenzen() + "?stichtag=2027-05-03", null), 200).body();
        assertThat(am.at("/gilt/einspeisegrenze_keine").asBoolean()).isTrue();
        ok(ruf(w, HttpMethod.POST, w.grenzen(), keine), 201);
        assertThat(protokoll(w)).hasSize(2);
        Map<String, Object> wechsel = protokoll(w).get(1);
        assertThat(MAPPER.readTree(wechsel.get("alt").toString()).get("einspeisegrenze_keine").asBoolean()).isFalse();
        assertThat(MAPPER.readTree(wechsel.get("neu").toString()).get("einspeisegrenze_keine").asBoolean()).isTrue();
        ok(ruf(w, HttpMethod.POST, w.grenzen(), leer), 201);
        assertThat(protokoll(w)).hasSize(3);
        assertThat(MAPPER.readTree(protokoll(w).get(2).get("neu").toString())
                .get("einspeisegrenze_keine").asBoolean()).isFalse();
    }

    @Test
    void ausdruecklichKeineUndWertSindInApiUndDatenbankUnzulaessig() throws Exception {
        Welt w = welt();
        Map<String, Object> widerspruch = grenze("2027-05-03", 100, 550);
        widerspruch.put("einspeisegrenze_keine", true);
        abgelehntMitFeld(w, w.grenzen(), widerspruch, "einspeisegrenze_keine");
        assertThat(protokoll(w)).isEmpty();
        for (Object falsch : new Object[] {"true", 1, null}) {
            Map<String, Object> anfrage = grenze("2027-05-03", null, 550);
            anfrage.put("einspeisegrenze_keine", falsch);
            abgelehntMitFeld(w, w.grenzen(), anfrage, "einspeisegrenze_keine");
        }
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> root.update(
                "INSERT INTO netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab, "
                        + "einspeisegrenze_kw, einspeisegrenze_keine) VALUES (?, ?, DATE '2027-05-03', 100, true)",
                w.mandant(), w.na1()))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class)
                .hasMessageContaining("netzanschluss_grenze_keine_oder_wert_chk");
    }

    @Test
    void eineZweiteFassungAmSelbenTagHebtDieErsteAufUndDieselbenWerteSchreibenNichts() throws Exception {
        Welt w = welt();
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze("2027-05-03", 100, 550)), 201);
        JsonNode b = ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze("2027-05-03", 90, "500.5")), 201).body();
        assertThat(b.get("fassungen")).hasSize(1);
        assertThat(b.at("/fassungen/0/bezugsgrenze_kw").decimalValue()).isEqualByComparingTo("500.5");
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze("2027-05-03", 90, "500.500")), 201);
        assertThat(root.queryForObject("SELECT count(*) FROM netzanschluss_grenze WHERE tenant_id = ?", Long.class,
                w.mandant())).as("die alte bleibt als aufgehobene Zeile").isEqualTo(2);
        List<Map<String, Object>> protokoll = protokoll(w);
        assertThat(protokoll).as("dieselben Werte noch einmal: kein Eintrag").hasSize(2);
        assertThat(MAPPER.readTree(protokoll.get(1).get("alt").toString()).get("einspeisegrenze_kw").decimalValue())
                .isEqualByComparingTo("100");
        // Eine spätere Fassung löst die frühere ab ihrem Tag ab; eine leere beendet die Grenze.
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze("2027-07-01", null, null)), 201);
        assertThat(ok(ruf(w, HttpMethod.GET, w.grenzen() + "?stichtag=2027-06-30", null), 200).body()
                .at("/gilt/einspeisegrenze_kw").decimalValue()).isEqualByComparingTo("90");
        JsonNode leer = ok(ruf(w, HttpMethod.GET, w.grenzen() + "?stichtag=2027-07-01", null), 200).body().get("gilt");
        assertThat(leer.get("einspeisegrenze_kw").isNull()).isTrue();
        assertThat(leer.get("bezugsgrenze_kw").isNull()).isTrue();
    }

    // ============================================================================ Ablehnungen

    @Test
    void jedeAblehnungSprichtIhrenSatzUndSchreibtNichts() throws Exception {
        Welt w = welt();
        abgelehnt(w, HttpMethod.POST, w.grenzen(), grenze("2027-05-03", 100, 560), "grenze_ueber_vereinbart");
        abgelehnt(w, HttpMethod.POST, w.grenzen(), grenze("2027-05-03", 700, 550), "grenze_ueber_anschluss");
        abgelehntMitFeld(w, w.grenzen(), grenze("2027-05-03", 0, 550), "einspeisegrenze_kw");
        abgelehntMitFeld(w, w.grenzen(), grenze("2027-05-03", 100, -5), "bezugsgrenze_kw");
        abgelehntMitFeld(w, w.grenzen(), grenze("2027-05-03", "100.1234", 550), "einspeisegrenze_kw");
        abgelehntMitFeld(w, w.grenzen(), grenze("2027-05-03", "viel", 550), "einspeisegrenze_kw");
        abgelehntMitFeld(w, w.grenzen(), grenze(null, 100, 550), "gueltig_ab");
        abgelehntMitFeld(w, w.grenzen(), grenze("3.5.2027", 100, 550), "gueltig_ab");
        // Mandant nie aus dem Körper: ein Feld tenant_id ist ein unbekanntes Feld.
        Map<String, Object> mitMandant = grenze("2027-05-03", 100, 550);
        mitMandant.put("tenant_id", UUID.randomUUID().toString());
        abgelehntMitFeld(w, w.grenzen(), mitMandant, "tenant_id");
        // Vor dem ersten Tag des Anschlusses.
        root.update("UPDATE netzanschluss SET gueltig_ab = '2027-01-01' WHERE id = ?", w.na1());
        abgelehnt(w, HttpMethod.POST, w.grenzen(), grenze("2026-12-31", 100, 550), "netzanschluss_besteht_nicht");
        // Unbekannt, am anderen Standort, fremder Kundenbereich: 404 — lesen wie schreiben.
        String unbekannt = "/api/v1/standorte/" + w.st1() + "/netzanschluesse/" + UUID.randomUUID() + "/grenzen";
        String andererStandort = "/api/v1/standorte/" + w.st2() + "/netzanschluesse/" + w.na1() + "/grenzen";
        for (String pfad : List.of(unbekannt, andererStandort)) {
            abgelehnt(w, HttpMethod.GET, pfad, null, "nicht_gefunden");
            abgelehnt(w, HttpMethod.POST, pfad, grenze("2027-05-03", 100, 550), "nicht_gefunden");
        }
        Welt fremd = welt();
        assertThat(ruf(fremd, HttpMethod.GET, w.grenzen(), null).status()).isEqualTo(404);
        assertThat(ruf(fremd, HttpMethod.POST, w.grenzen(), grenze("2027-05-03", 100, 550)).status()).isEqualTo(404);

        assertThat(root.queryForObject("SELECT count(*) FROM netzanschluss_grenze WHERE tenant_id = ?", Long.class,
                w.mandant())).isZero();
        assertThat(protokoll(w)).isEmpty();
    }

    @Test
    void dieTabelleHatErzwungeneRlsUndNurLesenEintragenAufheben() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'netzanschluss_grenze'", Boolean.class)).isTrue();
        assertThat(recht("SELECT")).isTrue();
        assertThat(recht("INSERT")).isTrue();
        assertThat(recht("DELETE")).isFalse();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'netzanschluss_grenze', 'aufgehoben_am', "
                + "'UPDATE')", Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'netzanschluss_grenze', 'bezugsgrenze_kw', "
                + "'UPDATE')", Boolean.class, APP_USER)).isFalse();
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'netzanschluss_aenderung_art_chk'", String.class))
                .contains("angelegt", "bearbeitet", "gebunden", "anlage_entfernt", "grenze");
    }

    // ============================================================================ Paarbeweis Ladepark-Dokument

    /**
     * Stand vor IP-3 = das Dokument mit dem Rahmen allein. Ohne wirksame Fassung — nicht gebunden, gebunden ohne
     * Blatt, Fassung erst ab übermorgen, Fassung nur für die Einspeisung — ist jedes Byte gleich, je Rahmen (keiner,
     * 400 kW, 600 kW). Mit Bezugsgrenze 550 kW ab gestern reist der engere Wert, sonst ändert sich nichts.
     */
    @Test
    void ladeparkDokumentOhneWirksameFassungIstByteGleichUndMitFassungReistDerEngereWert() throws Exception {
        Welt w = welt();
        Double[] rahmen = {null, 400.0, 600.0};
        paar(w, rahmen, "nicht gebunden");
        ok(ruf(w, HttpMethod.POST, "/api/v1/standorte/" + w.st1() + "/netzanschluesse/" + w.na1() + "/anlagen",
                Map.of("anlage_id", w.an1().toString(), "gueltig_ab", HEUTE.minusDays(30).toString())), 201);
        paar(w, rahmen, "gebunden ohne Blatt");
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(HEUTE.plusDays(2).toString(), 90, 300)), 201);
        paar(w, rahmen, "Fassung erst ab übermorgen");
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(HEUTE.minusDays(1).toString(), 100, null)), 201);
        paar(w, rahmen, "Fassung nur für die Einspeisung");

        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(HEUTE.minusDays(1).toString(), 100, 550)), 201);
        TenantContext.set(w.mandant());
        try {
            assertThat(ladepark.netzgrenze(w.an1(), 400.0)).as("Rahmen enger").isEqualTo(400.0);
            assertThat(ladepark.netzgrenze(w.an1(), 600.0)).as("Netzanschluss enger").isEqualTo(550.0);
            assertThat(ladepark.netzgrenze(w.an1(), null)).as("nur Netzanschluss").isEqualTo(550.0);
            String vorher = new String(dokument(w, 600.0), StandardCharsets.UTF_8);
            String nachher = new String(dokument(w, ladepark.netzgrenze(w.an1(), 600.0)), StandardCharsets.UTF_8);
            assertThat(nachher).isNotEqualTo(vorher).contains("\"grid_limit_kw\":550")
                    .isEqualTo(vorher.replace("\"grid_limit_kw\":600", "\"grid_limit_kw\":550"));
        } finally {
            TenantContext.clear();
        }
    }

    private void paar(Welt w, Double[] rahmen, String fall) {
        TenantContext.set(w.mandant());
        try {
            for (Double r : rahmen) {
                Double nachher = ladepark.netzgrenze(w.an1(), r);
                assertThat(nachher).as(fall + " / " + r).isSameAs(r);
                assertThat(dokument(w, nachher)).as(fall + " / " + r).isEqualTo(dokument(w, r));
            }
        } finally {
            TenantContext.clear();
        }
    }

    private static byte[] dokument(Welt w, Double netzgrenze) {
        return ChargingConfigPublisher.document(w.mandant(), w.an1(), new UUID(0, 1), netzgrenze, List.of("cp-1"),
                null, null, List.of(), List.of(), null, null, List.of(), List.of(), Instant.parse("2027-06-13T11:00:00Z"));
    }

    // ============================================================================== Gerüst

    private Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Grenzblatt #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)", t,
                an1, st1, HEUTE.minusDays(60));
        Welt ohneNa = new Welt(t, st1, st2, an1, null);
        Map<String, Object> na = new LinkedHashMap<>();
        na.put("kennzeichen", "NA-1");
        na.put("name", "Übergabestation Werk Ahrenberg");
        na.put("malo", "47110000001");
        na.put("netzbetreiber", "Netzgesellschaft Ahrental (fiktiv)");
        na.put("anschluss_kva", 630);
        na.put("vereinbart_kw", 550);
        na.put("messung", "RLM");
        Antwort a = ok(ruf(ohneNa, HttpMethod.POST, "/api/v1/standorte/" + st1 + "/netzanschluesse", na), 201);
        return new Welt(t, st1, st2, an1, UUID.fromString(a.body().get("id").asText()));
    }

    private static UUID standort(UUID t, UUID u, String name, String kz) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, name, kz);
    }

    private static Map<String, Object> grenze(String ab, Object einspeisung, Object bezug) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab);
        m.put("einspeisegrenze_kw", einspeisung);
        m.put("bezugsgrenze_kw", bezug);
        return m;
    }

    private static List<Map<String, Object>> protokoll(Welt w) {
        return root.queryForList("SELECT alt, neu, rueckwirkend FROM netzanschluss_aenderung WHERE tenant_id = ? "
                + "AND art = 'grenze' ORDER BY id", w.mandant());
    }

    private static boolean recht(String art) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, 'netzanschluss_grenze', ?)",
                Boolean.class, APP_USER, art));
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(status);
        return a;
    }

    private Antwort abgelehnt(Welt w, HttpMethod methode, String pfad, Object body, String code) throws Exception {
        Antwort a = ruf(w, methode, pfad, body);
        Ablehnung soll = Arrays.stream(Ablehnung.values()).filter(x -> x.code().equals(code)).findFirst().orElseThrow();
        assertThat(a.body().path("code").asText()).as(a.body().toString()).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.status());
        assertThat(a.body().path("message").asText()).isEqualTo(soll.satz());
        return a;
    }

    private void abgelehntMitFeld(Welt w, String pfad, Object body, String feld) throws Exception {
        assertThat(abgelehnt(w, HttpMethod.POST, pfad, body, "anfrage_ungueltig").body().path("feld").asText())
                .isEqualTo(feld);
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-jonas-" + w.mandant());
                    j.claim("preferred_username", "Jonas Wendlinger");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
