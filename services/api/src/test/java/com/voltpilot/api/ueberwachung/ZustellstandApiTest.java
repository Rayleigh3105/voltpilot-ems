package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

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
 * Kunden-Alarmierung P4 über HTTP: der Zustellstand je Meldung ({@code GET /api/v1/meldungen/zustellung}) und die
 * ausgefallenen Wege ({@code GET /api/v1/zustellwege/ausfaelle}).
 *
 * <ul>
 *   <li><b>Nur die eigene Zustellung:</b> der Zustellstand nennt die Zeilen des Versand-Protokolls für die Person aus
 *       dem Token, nie die anderer Empfänger.</li>
 *   <li><b>Rechte wie die Meldungen-Routen:</b> der Standort-Zaun auf {@code alarm} entscheidet; eine Meldung hinter
 *       dem Zaun oder aus einem anderen Kundenbereich fehlt in der Antwort.</li>
 *   <li><b>Ehrlich still:</b> Probelauf und „hängt an der Meldung der Box“ sagen, warum nichts hinausging.</li>
 *   <li><b>Ausfall:</b> eine endgültig gescheiterte Mail über den eingeschalteten Weg und ein vom Push-Dienst
 *       abgemeldetes Gerät; ein selbst ausgeschaltetes Gerät oder ein selbst abgeschalteter Weg ist keiner.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class ZustellstandApiTest {

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
        person(tenant, "jw", "kundenadministrator", null, "Jonas Wendlinger");
        person(tenant, "peter", "bearbeiter", st1, "Peter Lindner");
        person(tenant, "ost", "leser", st2, "Olga Ost");

        andererKunde = root.queryForObject("INSERT INTO tenant (name) VALUES ('Nordwind') RETURNING id", UUID.class);
        root.update("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Nordwind')", andererKunde);
        person(andererKunde, "nw", "kundenadministrator", null, "Nina Nordwind");
    }

    @Test
    void derZustellstandNenntJeWegZustandGrundUndZeitNurFuerDiePersonDieFragt() throws Exception {
        UUID regel = regel(st1, false);
        UUID meldung = meldung(st1, regel, false, null);
        Instant gesendet = Instant.parse("2026-11-13T11:34:00Z");
        zeile(meldung, "jw", "email", "ausgeloest", "gesendet", null, gesendet);
        zeile(meldung, "jw", "webpush", "ausgeloest", "unterdrueckt", "kein_weg", null);
        zeile(meldung, "jw", "webhook", "ausgeloest", "wartet", "beruhigt", null);
        zeile(meldung, "peter", "email", "ausgeloest", "gesendet", null, gesendet);

        MvcResult a = ruf(get("/api/v1/meldungen/zustellung").param("ids", meldung.toString()), konto("jw", tenant));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(200);
        JsonNode stand = JSON.readTree(koerper(a)).path("zustellungen");
        assertThat(stand).hasSize(1);
        assertThat(stand.get(0).path("meldungId").asText()).isEqualTo(meldung.toString());
        assertThat(stand.get(0).path("still").isNull()).isTrue();
        JsonNode wege = stand.get(0).path("wege");
        assertThat(wege).as("nur die drei Zeilen von jw, nicht die von peter").hasSize(3);
        Map<String, JsonNode> jeWeg = new HashMap<>();
        wege.forEach(w -> jeWeg.put(w.path("weg").asText(), w));
        assertThat(jeWeg.get("email").path("zustand").asText()).isEqualTo("gesendet");
        assertThat(Instant.parse(jeWeg.get("email").path("am").asText())).isEqualTo(gesendet);
        assertThat(jeWeg.get("webpush").path("grund").asText()).isEqualTo("kein_weg");
        assertThat(jeWeg.get("webhook").path("zustand").asText()).isEqualTo("wartet");
        assertThat(jeWeg.get("webhook").path("grund").asText()).isEqualTo("beruhigt");
    }

    @Test
    void probelaufUndAbhaengigeMeldungSagenWarumNichtsHinausging() throws Exception {
        UUID regel = regel(st1, false);
        UUID box = meldung(st1, regel, false, null);
        UUID andereRegel = regel(st1, false);
        UUID abhaengig = meldung(st1, andereRegel, false, box);
        UUID probe = meldung(st1, regel(st1, true), true, null);

        MvcResult a = ruf(get("/api/v1/meldungen/zustellung").param("ids", abhaengig + "," + probe),
                konto("jw", tenant));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(200);
        Map<String, JsonNode> je = new HashMap<>();
        JSON.readTree(koerper(a)).path("zustellungen").forEach(z -> je.put(z.path("meldungId").asText(), z));
        assertThat(je.get(abhaengig.toString()).path("still").asText()).isEqualTo("abhaengig");
        String kennzeichenBox = root.queryForObject("SELECT kennzeichen FROM alarm WHERE id = ?", String.class, box);
        assertThat(je.get(abhaengig.toString()).path("stillDurch").asText()).isEqualTo(kennzeichenBox);
        assertThat(je.get(probe.toString()).path("still").asText()).isEqualTo("probelauf");
        assertThat(je.get(probe.toString()).path("wege")).isEmpty();
    }

    @Test
    void standortZaunUndMandantVerbergenDenZustellstand() throws Exception {
        UUID meldung = meldung(st1, regel(st1, false), false, null);
        zeile(meldung, "ost", "email", "ausgeloest", "unterdrueckt", "keine_sicht", null);
        zeile(meldung, "nw", "email", "ausgeloest", "gesendet", null, Instant.now());

        MvcResult zaun = ruf(get("/api/v1/meldungen/zustellung").param("ids", meldung.toString()),
                konto("ost", tenant));
        MvcResult fremd = ruf(get("/api/v1/meldungen/zustellung").param("ids", meldung.toString()),
                konto("nw", andererKunde));

        assertThat(zaun.getResponse().getStatus()).as(koerper(zaun)).isEqualTo(200);
        assertThat(JSON.readTree(koerper(zaun)).path("zustellungen")).as("Leserin in Ostheim, Meldung im Werk")
                .isEmpty();
        assertThat(fremd.getResponse().getStatus()).as(koerper(fremd)).isEqualTo(200);
        assertThat(JSON.readTree(koerper(fremd)).path("zustellungen")).as("anderer Kundenbereich").isEmpty();
    }

    @Test
    void unsinnigeKennungenUndZuVieleSind400() throws Exception {
        MvcResult kaputt = ruf(get("/api/v1/meldungen/zustellung").param("ids", "keine-kennung"), konto("jw", tenant));
        StringBuilder viele = new StringBuilder();
        for (int i = 0; i <= 200; i++) {
            viele.append(i == 0 ? "" : ",").append(UUID.randomUUID());
        }
        MvcResult zuViele = ruf(get("/api/v1/meldungen/zustellung").param("ids", viele.toString()),
                konto("jw", tenant));

        assertThat(kaputt.getResponse().getStatus()).isEqualTo(400);
        assertThat(zuViele.getResponse().getStatus()).isEqualTo(400);
    }

    @Test
    void ausgefalleneWegeNennenMailUndAbgemeldetesGeraetNurDerEigenen() throws Exception {
        root.update("INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, aktiv, bestaetigt_am) "
                + "VALUES (?, 'peter', 'email', 'peter@ahrenberg.test', true, now())", tenant);
        UUID meldung = meldung(st1, regel(st1, false), false, null);
        zeile(meldung, "peter", "email", "ausgeloest", "fehlgeschlagen", null, null);
        root.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet, aktiv, "
                + "abgelaufen_am) VALUES (?, 'peter', 'https://push.example.test/1', 'k', 'a', 'Peters iPhone', "
                + "false, now())", tenant);
        root.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet, aktiv) "
                + "VALUES (?, 'peter', 'https://push.example.test/2', 'k', 'a', 'Peters Laptop', false)", tenant);
        root.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet, aktiv, "
                + "abgelaufen_am) VALUES (?, 'jw', 'https://push.example.test/3', 'k', 'a', 'Jonas Handy', false, "
                + "now())", tenant);

        MvcResult a = ruf(get("/api/v1/zustellwege/ausfaelle"), konto("peter", tenant));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(200);
        JsonNode liste = JSON.readTree(koerper(a));
        assertThat(liste).hasSize(2);
        assertThat(liste.get(0).path("weg").asText()).isEqualTo("email");
        assertThat(liste.get(0).path("name").asText()).isEqualTo("peter@ahrenberg.test");
        assertThat(liste.get(1).path("weg").asText()).isEqualTo("webpush");
        assertThat(liste.get(1).path("name").asText()).as("selbst ausgeschaltet ist kein Ausfall")
                .isEqualTo("Peters iPhone");

        // Wer den E-Mail-Weg selbst abschaltet, bekommt keinen Hinweis mehr dazu.
        root.update("UPDATE zustellweg SET aktiv = false WHERE tenant_id = ? AND benutzer_sub = 'peter'", tenant);
        JsonNode danach = JSON.readTree(koerper(ruf(get("/api/v1/zustellwege/ausfaelle"), konto("peter", tenant))));
        assertThat(danach).hasSize(1);
        assertThat(danach.get(0).path("weg").asText()).isEqualTo("webpush");
    }

    // ------------------------------------------------------------------ Welt

    private static UUID standort(UUID kunde, UUID unternehmen, String name, String kurzzeichen) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, kunde,
                unternehmen, name, kurzzeichen);
    }

    private static UUID regel(UUID standort, boolean probelauf) {
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, ?, 'DE-LU') "
                + "RETURNING id", UUID.class, tenant, "Anlage " + UUID.randomUUID());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlage, standort);
        UUID id = UUID.randomUUID();
        root.update("""
                INSERT INTO ueberwachung (id, tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von, probelauf_bis)
                VALUES (?, ?, ?, NULL, 'anlage.netz.leistung', ?::jsonb,
                       '{"art":"ueber","schwelle":120,"rueckkehr":114}'::jsonb, 'warnung',
                       '[{"rolle":"kundenadministrator"}]'::jsonb, 'eigen', true, 'jw', ?)
                """, id, tenant, standort, "{\"anlage\":\"" + anlage + "\"}",
                probelauf ? java.sql.Timestamp.from(Instant.now().plusSeconds(86_400)) : null);
        return id;
    }

    private static UUID meldung(UUID standort, UUID regel, boolean probelauf, UUID unterdruecktDurch) {
        return root.queryForObject("""
                INSERT INTO alarm (tenant_id, standort_id, kennzeichen, ueberwachung_id, fassung, bezug_kennung,
                       wertart, schwere, ausgeloest_am, probelauf, unterdrueckt_durch)
                VALUES (?, ?, ?, ?, 1, 'anlage:' || (SELECT bezug ->> 'anlage' FROM ueberwachung WHERE id = ?),
                       'anlage.netz.leistung', 'warnung', now(), ?, ?) RETURNING id
                """, UUID.class, tenant, standort, String.format("AL-2026-%06d", ++kennzeichenNr), regel, regel,
                probelauf, unterdruecktDurch);
    }

    private static void zeile(UUID meldung, String sub, String weg, String anlass, String zustand, String grund,
            Instant gesendetAm) {
        root.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr, "
                + "betreff, inhalt, zustand, grund, gesendet_am, schwere) "
                + "VALUES (?, 'alarm', ?, ?, ?, ?, 0, 'Betreff', 'Inhalt', ?, ?, ?, 'warnung')",
                tenant, meldung, sub, weg, anlass, zustand, grund,
                gesendetAm == null ? null : java.sql.Timestamp.from(gesendetAm));
    }

    private static void person(UUID kunde, String wer, String rolle, UUID ort, String name) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", kunde, wer, name);
        root.update("DELETE FROM zustellweg WHERE tenant_id = ? AND benutzer_sub = ?", kunde, wer);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", kunde, wer, rolle, ort);
    }

    private static String koerper(MvcResult a) throws Exception {
        return a.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }

    private Authentication konto(String wer, UUID kunde) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", wer);
        claims.put("preferred_username", wer);
        claims.put("realm_access", Map.of("roles", List.of()));
        claims.put("tenant_id", kunde.toString());
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
