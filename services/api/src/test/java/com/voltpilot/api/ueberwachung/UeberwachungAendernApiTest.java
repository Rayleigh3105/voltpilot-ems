package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Routen "Regel ändern" ({@code PUT /api/v1/meldungen/regeln/{id}}) und "Regel an/aus"
 * ({@code PUT /api/v1/meldungen/regeln/{id}/aktiv}) der Kunden-Alarmierung P3 über HTTP.
 *
 * <ul>
 *   <li><b>Ändern</b> schreibt die neue Fassung ({@code fassung + 1}), schließt offene Meldungen mit
 *       {@code regel_geaendert} und vergisst den technischen Stand je Bezug.</li>
 *   <li><b>Schalten</b> wirkt auch auf eine Regel ab Werk, ist in beiden Richtungen idempotent und schließt beim
 *       Ausschalten offene Meldungen; die Liste {@code GET /regeln} zeigt die ausgeschaltete Regel weiter.</li>
 *   <li><b>Mandantentrennung:</b> die Regel eines anderen Kundenbereichs ist 404 - wie eine unbekannte und eine
 *       hinter dem Standort-Zaun - und bleibt unverändert.</li>
 *   <li><b>Rechte</b> wie bei Anlegen/Scharfschalten/Löschen: die eigene Regel ändert eine Leserin mit
 *       {@code ueberwachung.eigene}; eine Regel an Rollen, oder eine eigene auf Rollen umgestellt, braucht
 *       {@code ueberwachung.verwalten} (403 {@code recht_fehlt}).</li>
 *   <li><b>Probelauf</b> ist beim Anlegen eine Wahl (Entscheid KA-3 A) und beim Ändern schaltbar.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UeberwachungAendernApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
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

    @Autowired MockMvc mvc;
    @MockitoBean KeycloakAdminClient keycloak;

    private static JdbcTemplate root;
    private static UUID tenant;
    private static UUID st1;
    private static UUID st2;
    private static UUID andererKunde;
    private static UUID fremderStandort;
    private static int kennzeichenNr;

    @BeforeEach
    void welt() {
        if (root != null) {
            return;
        }
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg') RETURNING id",
                UUID.class);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        st1 = standort(tenant, unternehmen, "Werk Ahrenberg", "ST-1");
        st2 = standort(tenant, unternehmen, "Lager Ostheim", "ST-2");
        person("jw", "kundenadministrator", null, "Jonas Wendlinger");
        person("berger", "leser", st1, "Claudia Berger");
        person("ost", "leser", st2, "Olga Ost");
        person("peter", "bearbeiter", st1, "Peter Lindner");

        andererKunde = root.queryForObject("INSERT INTO tenant (name) VALUES ('Nordwind') RETURNING id", UUID.class);
        UUID nordwind = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Nordwind') "
                + "RETURNING id", UUID.class, andererKunde);
        fremderStandort = standort(andererKunde, nordwind, "Hafen", "ST-1");
    }

    @Test
    void aendernSchreibtDieNeueFassungUndSchliesstDieOffeneMeldung() throws Exception {
        UUID regel = regel(tenant, st1, "eigen", "[{\"rolle\":\"energiemanager\"}]", null);
        UUID alarm = offeneMeldung(tenant, st1, regel);
        root.update("INSERT INTO ueberwachung_instanz (tenant_id, ueberwachung_id, bezug_kennung, zustand) "
                + "VALUES (?, ?, 'anlage:x', 'aktiv')", tenant, regel);

        MvcResult a = ruf(put(pfad(regel)).contentType(MediaType.APPLICATION_JSON).content(
                "{\"bedingung\":{\"art\":\"ueber\",\"schwelle\":200,\"rueckkehr\":190,\"dauer_s\":600},"
                        + "\"schwere\":\"dringend\",\"name\":\"Netzbezug hoch\"}"), konto("jw"));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(200);
        JsonNode r = JSON.readTree(koerper(a));
        assertThat(r.path("fassung").asInt()).isEqualTo(2);
        assertThat(r.path("schwere").asText()).isEqualTo("dringend");
        assertThat(r.path("name").asText()).isEqualTo("Netzbezug hoch");
        assertThat(r.path("bedingung").path("schwelle").asDouble()).isEqualTo(200);
        assertThat(r.path("bedingung").path("dauer_s").asLong()).isEqualTo(600);
        assertThat(r.path("bedingung").path("erholen_s").asLong()).as("Vorgabe ergänzt").isEqualTo(300);
        assertThat(r.path("empfaenger").get(0).path("rolle").asText()).isEqualTo("energiemanager");

        Map<String, Object> m = root.queryForMap("SELECT zustand, erledigt_durch FROM alarm WHERE id = ?", alarm);
        assertThat(m.get("zustand")).isEqualTo("erledigt");
        assertThat(m.get("erledigt_durch")).isEqualTo("regel_geaendert");
        assertThat(root.queryForObject("SELECT count(*) FROM alarm_verlauf WHERE alarm_id = ? AND art = 'erledigt'",
                Integer.class, alarm)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM ueberwachung_instanz WHERE ueberwachung_id = ?",
                Integer.class, regel)).as("Stand je Bezug vergessen").isZero();
    }

    @Test
    void einVerdrehtesPaarUndEineFremdeBedingungsartSind400() throws Exception {
        UUID regel = regel(tenant, st1, "eigen", "[{\"person\":\"jw\"}]", null);

        MvcResult verdreht = ruf(put(pfad(regel)).contentType(MediaType.APPLICATION_JSON).content(
                "{\"bedingung\":{\"art\":\"ueber\",\"schwelle\":5,\"rueckkehr\":7.6},\"schwere\":\"warnung\"}"),
                konto("jw"));
        MvcResult fremd = ruf(put(pfad(regel)).contentType(MediaType.APPLICATION_JSON).content(
                "{\"bedingung\":{\"art\":\"zustand\",\"ziel\":[\"x\"]},\"schwere\":\"warnung\"}"), konto("jw"));

        assertThat(verdreht.getResponse().getStatus()).as(koerper(verdreht)).isEqualTo(400);
        assertThat(fremd.getResponse().getStatus()).as(koerper(fremd)).isEqualTo(400);
        assertThat(root.queryForObject("SELECT fassung FROM ueberwachung WHERE id = ?", Integer.class, regel))
                .isEqualTo(1);
    }

    @Test
    void ausUndWiederAnAuchAbWerkUndIdempotent() throws Exception {
        UUID regel = regel(tenant, st1, "ab_werk", "[{\"rolle\":\"kundenadministrator\"}]", null);
        UUID alarm = offeneMeldung(tenant, st1, regel);

        MvcResult aus = ruf(schalten(regel, false), konto("jw"));
        MvcResult nochmalAus = ruf(schalten(regel, false), konto("jw"));

        assertThat(aus.getResponse().getStatus()).as(koerper(aus)).isEqualTo(200);
        assertThat(JSON.readTree(koerper(aus)).path("aktiv").asBoolean()).isFalse();
        assertThat(nochmalAus.getResponse().getStatus()).isEqualTo(200);
        assertThat(root.queryForObject("SELECT erledigt_durch FROM alarm WHERE id = ?", String.class, alarm))
                .isEqualTo("regel_geaendert");
        assertThat(root.queryForObject("SELECT count(*) FROM alarm_verlauf WHERE alarm_id = ? AND art = 'erledigt'",
                Integer.class, alarm)).as("zweimal aus schließt nur einmal").isEqualTo(1);

        JsonNode liste = JSON.readTree(koerper(ruf(get("/api/v1/meldungen/regeln"), konto("jw"))));
        JsonNode zeile = null;
        for (JsonNode z : liste.path("ueberwachungen")) {
            if (z.path("id").asText().equals(regel.toString())) {
                zeile = z;
            }
        }
        assertThat(zeile).as("die ausgeschaltete Regel steht weiter in der Liste").isNotNull();
        assertThat(zeile.path("aktiv").asBoolean()).isFalse();
        assertThat(zeile.path("standortId").asText()).isEqualTo(st1.toString());

        MvcResult an = ruf(schalten(regel, true), konto("jw"));
        assertThat(an.getResponse().getStatus()).as(koerper(an)).isEqualTo(200);
        assertThat(root.queryForObject("SELECT aktiv FROM ueberwachung WHERE id = ?", Boolean.class, regel)).isTrue();
        assertThat(root.queryForObject("SELECT fassung FROM ueberwachung WHERE id = ?", Integer.class, regel))
                .as("Schalten ändert den Inhalt nicht").isEqualTo(1);
    }

    @Test
    void fremderKundenbereichUnbekanntUndUmzaeuntSindGleich404UndBleibenUnveraendert() throws Exception {
        UUID fremd = regel(andererKunde, fremderStandort, "eigen", "[{\"person\":\"jw\"}]", null);
        UUID anderswo = regel(tenant, st2, "eigen", "[{\"person\":\"berger\"}]", null);
        String koerper = "{\"bedingung\":{\"art\":\"ueber\",\"schwelle\":1},\"schwere\":\"warnung\"}";

        MvcResult unbekannt = ruf(put(pfad(UUID.randomUUID())).contentType(MediaType.APPLICATION_JSON).content(koerper),
                konto("jw"));
        assertThat(unbekannt.getResponse().getStatus()).isEqualTo(404);
        Map<String, MvcResult> faelle = Map.of(
                "Ändern im anderen Kundenbereich",
                ruf(put(pfad(fremd)).contentType(MediaType.APPLICATION_JSON).content(koerper), konto("jw")),
                "Schalten im anderen Kundenbereich", ruf(schalten(fremd, false), konto("jw")),
                "Ändern hinter dem Standort-Zaun",
                ruf(put(pfad(anderswo)).contentType(MediaType.APPLICATION_JSON).content(koerper), konto("berger")),
                "Schalten hinter dem Standort-Zaun", ruf(schalten(anderswo, false), konto("berger")));
        for (Map.Entry<String, MvcResult> f : faelle.entrySet()) {
            assertThat(f.getValue().getResponse().getStatus()).as(f.getKey()).isEqualTo(404);
            assertThat(koerper(f.getValue())).as(f.getKey() + ": derselbe Körper wie unbekannt")
                    .isEqualTo(koerper(unbekannt));
        }
        Map<String, Object> m = root.queryForMap("SELECT fassung, aktiv FROM ueberwachung WHERE id = ?", fremd);
        assertThat(m.get("fassung")).isEqualTo(1);
        assertThat(m.get("aktiv")).isEqualTo(true);

        JsonNode liste = JSON.readTree(koerper(ruf(get("/api/v1/meldungen/regeln"), konto("jw"))));
        for (JsonNode z : liste.path("ueberwachungen")) {
            assertThat(z.path("id").asText()).as("keine fremde Regel in der Liste").isNotEqualTo(fremd.toString());
        }
    }

    @Test
    void dieEigeneRegelAendertDieLeserinDieRegelAnRollenNicht() throws Exception {
        UUID eigene = regel(tenant, st1, "eigen", "[{\"person\":\"berger\"}]", null);
        UUID anRollen = regel(tenant, st1, "eigen", "[{\"rolle\":\"energiemanager\"}]", null);
        String koerper = "{\"bedingung\":{\"art\":\"ueber\",\"schwelle\":50},\"schwere\":\"warnung\"}";

        MvcResult eigen = ruf(put(pfad(eigene)).contentType(MediaType.APPLICATION_JSON).content(koerper),
                konto("berger"));
        MvcResult aufRollen = ruf(put(pfad(eigene)).contentType(MediaType.APPLICATION_JSON).content(
                "{\"bedingung\":{\"art\":\"ueber\",\"schwelle\":50},\"schwere\":\"warnung\","
                        + "\"empfaenger\":[{\"rolle\":\"leser\"}]}"), konto("berger"));
        MvcResult rollen = ruf(put(pfad(anRollen)).contentType(MediaType.APPLICATION_JSON).content(koerper),
                konto("berger"));
        MvcResult rollenAus = ruf(schalten(anRollen, false), konto("berger"));

        assertThat(eigen.getResponse().getStatus()).as(koerper(eigen)).isEqualTo(200);
        assertThat(JSON.readTree(koerper(eigen)).path("empfaenger").get(0).path("name").asText())
                .as("Anzeigename der Person").isEqualTo("Claudia Berger");
        for (MvcResult a : List.of(aufRollen, rollen, rollenAus)) {
            assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(403);
            JsonNode k = JSON.readTree(koerper(a));
            assertThat(k.path("code").asText()).isEqualTo("recht_fehlt");
            assertThat(k.path("recht").asText()).isEqualTo("ueberwachung.verwalten");
        }
        assertThat(root.queryForObject("SELECT empfaenger::text FROM ueberwachung WHERE id = ?", String.class, eigene))
                .contains("berger");
    }

    /**
     * Befund P3: der Aufrufer einer Route trägt seine Standorte als ID, die Überwachungs-Dienste urteilen über das
     * Kurzzeichen - eine Leserin am Standort bekam beim Anlegen, Ausschalten und Stummschalten ihrer EIGENEN
     * Überwachung 403. Über HTTP, nicht nur am Dienst.
     */
    @Test
    void eineLeserinAmStandortLegtIhreEigeneUeberwachungUeberHttpAnUndSchaltetSieAus() throws Exception {
        UUID anlage = anlage(tenant, st1, "Halle Berger");
        MvcResult neu = ruf(post("/api/v1/meldungen/regeln").contentType(MediaType.APPLICATION_JSON).content(
                JSON.writeValueAsString(Map.of("wertart", "anlage.netz.leistung",
                        "bezug", Map.of("anlage", anlage.toString()),
                        "bedingung", Map.of("art", "ueber", "schwelle", 10), "schwere", "warnung",
                        "probelauf", false))), konto("berger"));
        assertThat(neu.getResponse().getStatus()).as(koerper(neu)).isEqualTo(201);
        UUID id = UUID.fromString(JSON.readTree(koerper(neu)).path("id").asText());

        MvcResult aus = ruf(schalten(id, false), konto("berger"));
        assertThat(aus.getResponse().getStatus()).as(koerper(aus)).isEqualTo(200);

        // Stummschalten trifft alle Empfänger und braucht darum ueberwachung.verwalten - am Standort hat das der
        // Bearbeiter, und auch ihn traf derselbe Fehler.
        MvcResult stumm = ruf(post("/api/v1/stummschaltungen").contentType(MediaType.APPLICATION_JSON).content(
                JSON.writeValueAsString(Map.of("art", "regel", "id", id.toString(),
                        "bis", Instant.now().plusSeconds(3600).toString()))), konto("peter"));
        assertThat(stumm.getResponse().getStatus()).as(koerper(stumm)).isBetween(200, 201);
    }

    @Test
    void probelaufIstBeimAnlegenEineWahlUndBeimAendernSchaltbar() throws Exception {
        UUID anlage = anlage(tenant, st1, "Halle Wahl");
        MvcResult sofort = ruf(post("/api/v1/meldungen/regeln").contentType(MediaType.APPLICATION_JSON).content(
                JSON.writeValueAsString(Map.of("wertart", "anlage.netz.leistung",
                        "bezug", Map.of("anlage", anlage.toString()),
                        "bedingung", Map.of("art", "ueber", "schwelle", 10), "schwere", "warnung",
                        "probelauf", false))), konto("jw"));
        MvcResult mitzaehlen = ruf(post("/api/v1/meldungen/regeln").contentType(MediaType.APPLICATION_JSON).content(
                JSON.writeValueAsString(Map.of("wertart", "anlage.netz.leistung",
                        "bezug", Map.of("anlage", anlage.toString()),
                        "bedingung", Map.of("art", "ueber", "schwelle", 20), "schwere", "warnung",
                        "probelauf", true))), konto("jw"));

        assertThat(sofort.getResponse().getStatus()).as(koerper(sofort)).isEqualTo(201);
        assertThat(JSON.readTree(koerper(sofort)).path("probelaufBis").isNull()).isTrue();
        assertThat(mitzaehlen.getResponse().getStatus()).as(koerper(mitzaehlen)).isEqualTo(201);
        assertThat(JSON.readTree(koerper(mitzaehlen)).path("probelaufBis").isNull()).isFalse();

        UUID id = UUID.fromString(JSON.readTree(koerper(sofort)).path("id").asText());
        MvcResult an = ruf(put(pfad(id)).contentType(MediaType.APPLICATION_JSON).content(
                "{\"bedingung\":{\"art\":\"ueber\",\"schwelle\":10},\"schwere\":\"warnung\",\"probelauf\":true}"),
                konto("jw"));
        assertThat(JSON.readTree(koerper(an)).path("probelaufBis").isNull()).isFalse();
        assertThat(root.queryForObject("SELECT probelauf_gewaehlt FROM ueberwachung WHERE id = ?", Boolean.class, id))
                .as("wie beim Anlegen: ein Probelauf ist immer gewählt (P2)").isTrue();
        MvcResult aus = ruf(put(pfad(id)).contentType(MediaType.APPLICATION_JSON).content(
                "{\"bedingung\":{\"art\":\"ueber\",\"schwelle\":10},\"schwere\":\"warnung\",\"probelauf\":false}"),
                konto("jw"));
        assertThat(JSON.readTree(koerper(aus)).path("probelaufBis").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT probelauf_gewaehlt FROM ueberwachung WHERE id = ?", Boolean.class, id))
                .isFalse();

        // P2 (KA-3 A): ohne Feld meldet eine neue Regel sofort.
        MvcResult ohneFeld = ruf(post("/api/v1/meldungen/regeln").contentType(MediaType.APPLICATION_JSON).content(
                JSON.writeValueAsString(Map.of("wertart", "anlage.netz.leistung",
                        "bezug", Map.of("anlage", anlage.toString()),
                        "bedingung", Map.of("art", "ueber", "schwelle", 30), "schwere", "warnung"))), konto("jw"));
        assertThat(JSON.readTree(koerper(ohneFeld)).path("probelaufBis").isNull()).isTrue();
    }

    /**
     * KA-4 B: ein Hinweis zählt nicht in der Glocke; die Meldung trägt die Kennung ihrer Regel (der Knopf „Stumm“
     * der Karte schaltet genau sie stumm).
     */
    @Test
    void dieGlockeZaehltKeineHinweiseUndDieMeldungNenntIhreRegel() throws Exception {
        UUID regel = regel(tenant, st1, "eigen", "[{\"person\":\"jw\"}]", null);
        long vorher = JSON.readTree(koerper(ruf(get("/api/v1/meldungen/zahl"), konto("jw")))).path("ungesehen").asLong();
        UUID warnung = offeneMeldung(tenant, st1, regel);
        UUID hinweisRegel = regel(tenant, st1, "eigen", "[{\"person\":\"jw\"}]", null);
        UUID hinweis = offeneMeldung(tenant, st1, hinweisRegel);
        root.update("UPDATE alarm SET schwere = 'hinweis' WHERE id = ?", hinweis);

        JsonNode zahl = JSON.readTree(koerper(ruf(get("/api/v1/meldungen/zahl"), konto("jw"))));
        assertThat(zahl.path("ungesehen").asLong()).as("nur die Warnung zählt").isEqualTo(vorher + 1);

        JsonNode liste = JSON.readTree(koerper(ruf(get("/api/v1/meldungen?status=jetzt"), konto("jw"))));
        boolean gefunden = false;
        for (JsonNode m : liste.path("meldungen")) {
            if (m.path("id").asText().equals(warnung.toString())) {
                assertThat(m.path("ueberwachungId").asText()).isEqualTo(regel.toString());
                gefunden = true;
            }
        }
        assertThat(gefunden).isTrue();
    }

    // ------------------------------------------------------------------ Welt

    private static UUID standort(UUID kunde, UUID unternehmen, String name, String kurzzeichen) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, kunde,
                unternehmen, name, kurzzeichen);
    }

    private static UUID anlage(UUID kunde, UUID standort, String name) {
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, ?, 'DE-LU') "
                + "RETURNING id", UUID.class, kunde, name);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", kunde, anlage, standort);
        return anlage;
    }

    private static UUID regel(UUID kunde, UUID standort, String herkunft, String empfaenger, Instant probelaufBis) {
        UUID anlage = anlage(kunde, standort, "Anlage " + UUID.randomUUID());
        UUID id = UUID.randomUUID();
        root.update("""
                INSERT INTO ueberwachung (id, tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von, probelauf_bis)
                VALUES (?, ?, ?, NULL, 'anlage.netz.leistung', ?::jsonb,
                       '{"art":"ueber","schwelle":120,"rueckkehr":114}'::jsonb, 'warnung', ?::jsonb, ?, true, 'jw', ?)
                """, id, kunde, standort, "{\"anlage\":\"" + anlage + "\"}", empfaenger, herkunft,
                probelaufBis == null ? null : java.sql.Timestamp.from(probelaufBis));
        return id;
    }

    private static UUID offeneMeldung(UUID kunde, UUID standort, UUID regel) {
        return root.queryForObject("""
                INSERT INTO alarm (tenant_id, standort_id, kennzeichen, ueberwachung_id, fassung, bezug_kennung,
                       wertart, schwere, ausgeloest_am)
                VALUES (?, ?, ?, ?, 1, 'anlage:' || (SELECT bezug ->> 'anlage' FROM ueberwachung WHERE id = ?),
                       'anlage.netz.leistung', 'warnung', now()) RETURNING id
                """, UUID.class, kunde, standort, String.format("AL-2026-%06d", ++kennzeichenNr), regel, regel);
    }

    private static void person(String wer, String rolle, UUID ort, String name) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", tenant, wer, name);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, wer, rolle, ort);
    }

    private static String pfad(UUID regel) {
        return "/api/v1/meldungen/regeln/" + regel;
    }

    private static MockHttpServletRequestBuilder schalten(UUID regel, boolean aktiv) {
        return put(pfad(regel) + "/aktiv").contentType(MediaType.APPLICATION_JSON).content("{\"aktiv\":" + aktiv + "}");
    }

    private static String koerper(MvcResult a) throws Exception {
        return a.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }

    private Authentication konto(String wer) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", wer);
        claims.put("preferred_username", wer);
        claims.put("realm_access", Map.of("roles", List.of()));
        claims.put("tenant_id", tenant.toString());
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
