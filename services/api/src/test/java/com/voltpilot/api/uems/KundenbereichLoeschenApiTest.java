package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
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
 * UEMS AP-20 IP-18 — Vertragsende III, NW-5 für das Löschen nach der Frist (E10 = A, BT4, BT5, RF-08).
 *
 * <ul>
 *   <li><b>RF-08 durchgespielt:</b> aktiv → {@code 409 kundenbereich_nicht_beendet}; beendet →
 *       {@code 409 frist_laeuft} mit „frühestens am"; der Kundenadministrator lädt den Gesamtabzug; einen Tag vor
 *       dem Ablauf noch 409, am Tag des Ablaufs gelöscht. Vor jeder 409 ist nichts bewegt — kein Konto gesperrt
 *       (Keycloak unberührt), keine Zeile weg.</li>
 *   <li><b>Löschnachweis ohne Personendaten:</b> die Spalten sind genau die erwarteten, der Inhalt nennt weder Namen
 *       noch Konten, Anzeigenamen oder Auftragstexte; die Zählungen stimmen mit dem Katalog, die Prüfsumme mit dem
 *       letzten abgeschlossenen Abzug.</li>
 *   <li><b>{@code verblieben} ist ehrlich:</b> jede Katalog-Tabelle mit {@code tenant_id} trägt danach genau so viele
 *       Zeilen, wie der Nachweis nennt — heute die append-only-Protokolle ohne Fremdschlüssel (Befund im PR).</li>
 *   <li><b>Der Nachweis bleibt:</b> niemand ändert oder löscht ihn, die App-Rolle sieht ihn nicht.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KundenbereichLoeschenApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BETREIBER = "betrieb-voss";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final String AUFTRAG = "Kündigung zum 30.06.2029 (Annahme)";
    private static final String BEGRUENDUNG = "Vertragsende RF-08";
    private static final List<String> SPALTEN = List.of("id", "kennzeichen", "kundenbereich", "beendet_am",
            "frist_tage", "loeschung_fruehestens", "geloescht_am", "geloescht_von", "zaehlungen", "verblieben",
            "abzug_sha256", "abzug_am");

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
    @MockBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;
    private UUID tenant;
    private String name;
    private String kundenadmin;
    private String leserin;

    @BeforeEach
    void seed() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        String nr = UUID.randomUUID().toString().substring(0, 8);
        name = "Kunststoffwerk Ahrenberg " + nr;
        // Über die Plattform-Route angelegt: das legt auch Unternehmen und Protokollzeile an wie im Betrieb.
        MvcResult angelegt = ruf(post("/api/v1/admin/tenants").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("name", name))), plattform());
        assertThat(angelegt.getResponse().getStatus()).isEqualTo(201);
        tenant = UUID.fromString(json(angelegt).get("id").asText());
        UUID unternehmen = root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, tenant);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone,"
                + " zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                tenant, unternehmen);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, 'Werk', 'DE-LU') "
                + "RETURNING id", UUID.class, tenant);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, site, "kb-loeschen-" + nr);
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES (now(), ?, ?, ?, 1.0)",
                tenant, site, box);
        kundenadmin = "jw-" + nr;
        leserin = "berger-" + nr;
        spiegel(kundenadmin, "Jonas Wendlinger");
        spiegel(leserin, "Nora Berger");
        zuweisung(kundenadmin, "kundenadministrator", null);
        zuweisung(leserin, "leser", standort);
    }

    /** NW-5, RF-08: nicht beendet 409, vor der Frist 409, danach gelöscht — und der Löschnachweis bleibt. */
    @Test
    void rf08VorDerFrist409DanachGeloeschtMitLoeschnachweisOhnePersonendaten() throws Exception {
        long vorher = zeilen();

        // 1. Aktiv: der Löschweg verweigert, bevor ein Konto gesperrt wird.
        MvcResult aktiv = loeschen();
        assertThat(aktiv.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(aktiv).get("code").asText()).isEqualTo("kundenbereich_nicht_beendet");
        assertThat(zeilen()).isEqualTo(vorher);
        verifyNoInteractions(keycloak);

        // 2. Beendet (Startwert 90 Tage): die Frist läuft — 409 mit dem ersten erlaubten Tag.
        MvcResult beendet = ruf(post("/api/v1/admin/tenants/" + tenant + "/beenden")
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(Map.of("auftrag", AUFTRAG,
                        "begruendung", BEGRUENDUNG, "confirmName", name))), plattform());
        assertThat(beendet.getResponse().getStatus()).isEqualTo(200);
        MvcResult frist = loeschen();
        assertThat(frist.getResponse().getStatus()).isEqualTo(409);
        JsonNode fristKoerper = json(frist);
        assertThat(fristKoerper.get("code").asText()).isEqualTo("frist_laeuft");
        assertThat(fristKoerper.get("loeschung_fruehestens").asText())
                .isEqualTo(LocalDate.now(BERLIN).plusDays(90).toString());
        assertThat(fristKoerper.get("message").asText()).contains("frühestens am");
        assertThat(zeilen()).isEqualTo(vorher + 1); // nur die Protokollzeile kundenbereich_uebergang des Beendens
        assertThat(root.queryForObject("SELECT count(*) FROM benutzer WHERE tenant_id = ? AND zustand = 'aktiv'",
                Long.class, tenant)).isEqualTo(2L);
        verifyNoInteractions(keycloak);

        // 3. Mitnahme: der Kundenadministrator lädt den Gesamtabzug (IP-17).
        MvcResult abzug = ruf(get("/api/v1/unternehmen/abzug"), konto(kundenadmin));
        assertThat(abzug.getResponse().getStatus()).isEqualTo(200);
        String manifest = root.queryForObject("SELECT manifest_sha256 FROM kundenbereich_abzug WHERE tenant_id = ?"
                + " AND abgeschlossen_am IS NOT NULL", String.class, tenant);
        assertThat(manifest).matches("[0-9a-f]{64}");

        // 4. Zeitraffer: einen Tag vor dem Ablauf noch 409, am ersten erlaubten Tag gelöscht.
        vertragsendeVor(89);
        MvcResult knapp = loeschen();
        assertThat(knapp.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(knapp).get("loeschung_fruehestens").asText()).isEqualTo(LocalDate.now(BERLIN).plusDays(1).toString());
        vertragsendeVor(90);
        Map<String, Long> katalogVorher = katalog();
        MvcResult geloescht = loeschen();
        assertThat(geloescht.getResponse().getStatus()).as(text(geloescht)).isEqualTo(200);
        JsonNode nachweis = json(geloescht).get("loeschnachweis");
        assertThat(nachweis.get("kennzeichen").asText()).matches("LN-" + LocalDate.now(BERLIN).getYear() + "-\\d{4}");
        assertThat(nachweis.get("abzugSha256").asText()).isEqualTo(manifest);

        // 5. Der Bereich ist weg; die Zählungen sind die des Katalogs, verblieben ist genau, was noch da ist.
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, tenant)).isZero();
        Map<String, Long> zaehlungen = map(nachweis.get("zaehlungen"));
        Map<String, Long> verblieben = map(nachweis.get("verblieben"));
        Map<String, Long> erwartet = new TreeMap<>(katalogVorher);
        erwartet.put("tenant", 1L);
        assertThat(zaehlungen).isEqualTo(erwartet);
        assertThat(zaehlungen).containsEntry("benutzer", 2L).containsEntry("zugriff", 2L).containsEntry("device", 1L)
                .containsEntry("telemetry", 1L).containsEntry("kundenbereich_abzug", 1L);
        assertThat(katalog()).as("verblieben = was nach dem Löschen noch die Kennung trägt").isEqualTo(verblieben);
        System.out.printf("NW-5 IP-18: %s gelöscht, %d Tabellen gezählt, verblieben %s%n",
                nachweis.get("kennzeichen").asText(), zaehlungen.size(), verblieben);

        // 6. Der Löschnachweis: genau diese Spalten, keine Personendaten, die Kennung statt des Namens.
        assertThat(root.queryForList("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'"
                + " AND table_name = 'mandant_loeschnachweis' ORDER BY ordinal_position", String.class))
                .isEqualTo(SPALTEN);
        Map<String, Object> zeile = root.queryForMap("SELECT * FROM mandant_loeschnachweis WHERE kundenbereich = ?",
                tenant);
        assertThat(zeile.get("geloescht_von")).isEqualTo(BETREIBER);
        assertThat(zeile.get("abzug_sha256")).isEqualTo(manifest);
        assertThat(zeile.get("frist_tage")).isEqualTo(90);
        String inhalt = root.queryForObject("SELECT row_to_json(n)::text FROM mandant_loeschnachweis n"
                + " WHERE kundenbereich = ?", String.class, tenant);
        for (String person : List.of(name, "Ahrenberg", "Jonas Wendlinger", "Nora Berger", kundenadmin, leserin,
                AUFTRAG, BEGRUENDUNG, "Werk")) {
            assertThat(inhalt).as("Personendaten im Löschnachweis").doesNotContain(person);
        }

        // 7. Kein zweites Löschen: der Bereich ist weg.
        assertThat(loeschen().getResponse().getStatus()).isEqualTo(404);
    }

    /** Der Nachweis bleibt, wie er geschrieben wurde: nie geändert, nie gelöscht, für die App-Rolle unsichtbar. */
    @Test
    void derLoeschnachweisBleibtUndNurDerBetriebLiestIhn() throws Exception {
        vertragsendeVor(120);
        assertThat(loeschen().getResponse().getStatus()).isEqualTo(200);
        assertThatThrownBy(() -> root.update("UPDATE mandant_loeschnachweis SET frist_tage = 30 WHERE kundenbereich = ?",
                tenant)).hasStackTraceContaining("bleibt");
        assertThatThrownBy(() -> root.update("DELETE FROM mandant_loeschnachweis WHERE kundenbereich = ?", tenant))
                .hasStackTraceContaining("bleibt");
        JdbcTemplate admin = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), "voltpilot_admin",
                "voltpilot_admin_test_pw"));
        assertThat(admin.queryForObject("SELECT count(*) FROM mandant_loeschnachweis WHERE kundenbereich = ?",
                Long.class, tenant)).isOne();
        assertThatThrownBy(() -> admin.update("DELETE FROM mandant_loeschnachweis WHERE kundenbereich = ?", tenant))
                .hasStackTraceContaining("permission denied");
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        assertThatThrownBy(() -> app.queryForList("SELECT * FROM mandant_loeschnachweis"))
                .hasStackTraceContaining("permission denied");
    }

    /** Eine Wiederaufnahme vor dem Löschen: der Bereich ist wieder aktiv und der Löschweg verweigert wieder. */
    @Test
    void nachDerWiederaufnahmeVerweigertDerLoeschwegWieder() throws Exception {
        vertragsendeVor(120);
        MvcResult zurueck = ruf(post("/api/v1/admin/tenants/" + tenant + "/wiederaufnehmen")
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(Map.of("auftrag", AUFTRAG,
                        "begruendung", BEGRUENDUNG))), plattform());
        assertThat(zurueck.getResponse().getStatus()).isEqualTo(200);
        MvcResult r = loeschen();
        assertThat(r.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(r).get("code").asText()).isEqualTo("kundenbereich_nicht_beendet");
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, tenant)).isOne();
        verifyNoInteractions(keycloak);
    }

    /** Zeitraffer: der Bereich endete vor {@code tage} Kalendertagen (Berlin, mittags), Frist 90 Tage. */
    private void vertragsendeVor(int tage) {
        root.update("UPDATE tenant SET beendet_am = NULL, beendet_frist_tage = NULL, beendet_von = NULL WHERE id = ?",
                tenant);
        root.update("UPDATE tenant SET beendet_am = ?, beendet_frist_tage = 90, beendet_von = ? WHERE id = ?",
                LocalDate.now(BERLIN).minusDays(tage).atTime(LocalTime.NOON).atZone(BERLIN).toOffsetDateTime(),
                BETREIBER, tenant);
    }

    /** Zeilen mit der Kennung des Bereichs je Tabelle (Katalog: jede Tabelle mit {@code tenant_id}), nur die mit Zeilen. */
    private Map<String, Long> katalog() {
        Map<String, Long> je = new TreeMap<>();
        for (String tabelle : root.queryForList("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid ="
                + " c.relnamespace AND n.nspname = 'public' JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname ="
                + " 'tenant_id' AND NOT a.attisdropped WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition",
                String.class)) {
            long n = root.queryForObject("SELECT count(*) FROM \"" + tabelle + "\" WHERE tenant_id = ?", Long.class,
                    tenant);
            if (n > 0) {
                je.put(tabelle, n);
            }
        }
        return je;
    }

    private long zeilen() {
        return katalog().values().stream().mapToLong(Long::longValue).sum();
    }

    private MvcResult loeschen() throws Exception {
        return ruf(post("/api/v1/admin/tenants/" + tenant + "/delete").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("confirmName", name))), plattform());
    }

    private static Map<String, Long> map(JsonNode knoten) {
        Map<String, Long> m = new TreeMap<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = knoten.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            m.put(e.getKey(), e.getValue().asLong());
        }
        return m;
    }

    private static JsonNode json(MvcResult r) throws Exception {
        return JSON.readTree(text(r));
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private void spiegel(String wer, String anzeigename) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, 'aktiv')",
                tenant, wer, anzeigename);
    }

    private void zuweisung(String wer, String rolle, UUID ort) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, wer, rolle, ort);
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }

    private Authentication konto(String wer) {
        return auth(wer, tenant, false);
    }

    private static Authentication plattform() {
        return auth(BETREIBER, null, true);
    }

    private static Authentication auth(String wer, UUID kunde, boolean plattform) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", wer);
        claims.put("preferred_username", wer);
        claims.put("realm_access", Map.of("roles", plattform ? List.of("platform-admin") : List.of()));
        if (kunde != null) {
            claims.put("tenant_id", kunde.toString());
        }
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
