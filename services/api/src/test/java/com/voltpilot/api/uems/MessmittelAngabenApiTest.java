package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-16 IP-15 (G1–G3, R8, E7 = A): Messmittel-Angaben am Einbau über die echte HTTP-, Rechte- und RLS-Kette
 * mit der App-Rolle. Der Netzzähler trägt Eichung und Beleg mit Prüfsumme, der Druckluft-Zähler sagt
 * {@code nicht_erhoben}; ein Beleg ohne Prüfsumme ist 422; die Klasse steht nur an Wandler-Fassungen.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessmittelAngabenApiTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Die Prüfsummen der Referenzdatei (uems-referenzunternehmen.json, messmittel_angaben). */
    private static final String SHA_GR2 = "3b1f4d86f164c8e54eaa3a9c335975dd54dcbd68b42bbb9c7b24d2195e2a9a2e";
    private static final String SHA_Z5B = "c07dd7a33d2b17df6fece484ec4e08bb50c93326653576cfb1b8dd8dcf8a41f0";
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "PH", "Peter Hollerbach",
            "CB", "Claudia Berger", "JW", "Jonas Wendlinger", "TB", "Thomas Brunner", "FR", "Fremd");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip15_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip15_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "ip15_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "ip15_admin_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    static JdbcTemplate root;
    UUID tenant, fremd, unternehmen, s1, s2, a1, a2, gr2, gr5, gr7, gr9, z5a, z5b, wandler, skalierung;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-15') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id",
                UUID.class, tenant);
        s1 = standort("ST-1");
        s2 = standort("ST-2");
        benutzer("IK", "benutzer", "energiemanager", null);
        benutzer("JW", "benutzer", "kundenadministrator", null);
        benutzer("PH", "benutzer", "bearbeiter", s2);
        benutzer("CB", "benutzer", "leser", s1);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'TB','partner',?,'aktiv')",
                tenant, NAMEN.get("TB"));
        LocalDate bis = LocalDate.parse("2099-12-30");
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,art,umfang,gueltig_ab,gueltig_bis,"
                + "endet_am,zeitzone) VALUES (?,'TB','unterstuetzer',?,'installateur','einrichten_und_bedienen',"
                + "'2026-01-01',?,?,'Europe/Berlin')", tenant, s1, bis,
                bis.plusDays(1).atStartOfDay(ZoneId.of("Europe/Berlin")).toOffsetDateTime());
        a1 = anlage("AN-1", s1);
        a2 = anlage("AN-2", s2);
        gr2 = geraet(a1, "GR-2", "GR-2", "2024-01-01T00:00:00Z", null);
        gr5 = geraet(a1, "GR-5", "GR-5", "2024-01-01T00:00:00Z", null);
        gr7 = geraet(a1, "GR-7", "GR-7", "2024-01-01T00:00:00Z", null);
        gr9 = geraet(a2, "GR-9", "GR-9", "2024-01-01T00:00:00Z", null);
        // R8 Schritt 2: der Zählerwechsel GR-4 — Z-5a ausgebaut, Z-5b eingebaut.
        z5a = geraet(a1, "GR-4", "Z-5a", "2024-01-01T00:00:00Z", "2026-10-02T08:00:00Z");
        z5b = geraet(a1, "GR-4", "Z-5b", "2026-10-02T08:00:00Z", null);
        wandler = einstellung(gr7, "wandler_strom", "{\"primaer_a\": 400, \"sekundaer_a\": 5}");
        skalierung = einstellung(gr7, "skalierung", "{\"faktor\": 2}");
        fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd IP-15') RETURNING id", UUID.class);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'FR','benutzer','Fremd','aktiv')",
                fremd);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,'FR','energiemanager',NULL,'2024-01-01','Europe/Berlin')", fremd);
    }

    @Test void r8NetzzaehlerMitEichungUndBelegMitPruefsumme() throws Exception {
        var a = ruf("PUT", pfad(gr2), "IK", gr2Angabe(), 200);
        assertThat(a.path("zustand").asText()).isEqualTo("erhoben");
        assertThat(a.path("einbau_kennzeichen").asText()).isEqualTo("GR-2");
        assertThat(a.path("genauigkeitsklasse").asText()).isEqualTo("B (MID, Wirkenergie)");
        assertThat(a.path("pruefungsart").asText()).isEqualTo("eichung");
        assertThat(a.path("pruefung_am").asText()).isEqualTo("2023-06-14");
        assertThat(a.path("pruefung_gueltig_bis").asText()).isEqualTo("2031-12-31");
        assertThat(a.at("/beleg/sha256").asText()).isEqualTo(SHA_GR2);
        assertThat(a.at("/beleg/ablage").asText()).isEqualTo("beim Kunden (Netzrechnung)");
        assertThat(a.at("/beleg/person/sub").asText()).isEqualTo("IK");
        assertThat(a.at("/beleg/person/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(a.at("/beleg/person/art").asText()).isEqualTo("kunde");
        assertThat(a.at("/beleg/zeitpunkt").isNull()).isFalse();
        assertThat(ruf("GET", pfad(gr2), "IK", null, 200)).isEqualTo(a);
        // Die Datei selbst wird nie gespeichert: der Beleg ist Bezeichnung, Ablage, Prüfsumme, Person, Zeitpunkt.
        assertThat(root.queryForObject("SELECT beleg_sha256 FROM geraet WHERE id=?", String.class, gr2)).isEqualTo(SHA_GR2);
        assertThat(journal(gr2)).containsExactly("messmittel_angabe");
        var zeile = root.queryForMap("SELECT alt::text AS alt, neu::text AS neu, actor_sub, actor_name, actor_art "
                + "FROM geraet_aenderung WHERE geraet_id=?", gr2);
        assertThat(JSON.readTree((String) zeile.get("alt")).path("pruefungsart").asText()).isEqualTo("nicht_erhoben");
        assertThat(JSON.readTree((String) zeile.get("neu")).path("pruefungsart").asText()).isEqualTo("eichung");
        assertThat(JSON.readTree((String) zeile.get("neu")).at("/beleg/sha256").asText()).isEqualTo(SHA_GR2);
        assertThat(zeile.get("actor_sub")).isEqualTo("IK");
        assertThat(zeile.get("actor_art")).isEqualTo("kunde");
        // Derselbe PUT noch einmal ändert nichts und schreibt nichts; der Beleg behält Person und Zeitpunkt.
        assertThat(ruf("PUT", pfad(gr2), "JW", gr2Angabe(), 200).at("/beleg/person/sub").asText()).isEqualTo("IK");
        assertThat(journal(gr2)).hasSize(1);
        // Das Protokoll des Geräts nennt den Eintrag mit Akteur.
        var p = ruf("GET", "/api/v1/geraete/" + gr2 + "/aenderungen", "IK", null, 200).path("eintraege");
        assertThat(p).hasSize(1);
        assertThat(p.get(0).path("art").asText()).isEqualTo("messmittel_angabe");
        assertThat(p.get(0).path("text").asText()).startsWith("Messmittel-Angaben eingetragen");
        assertThat(p.get(0).at("/urheber/name").asText()).isEqualTo("Ines Kaltenbach");
        var u = ruf("GET", "/api/v1/unternehmen/aenderungen", "IK", null, 200).path("eintraege");
        assertThat(u.findValuesAsText("art")).contains("messmittel_angabe");
    }

    @Test void ohneAngabeBleibtNichtErhobenUndNichtsWirdErfunden() throws Exception {
        var a = ruf("GET", pfad(gr5), "IK", null, 200);
        assertThat(a.path("zustand").asText()).isEqualTo("nicht_erhoben");
        assertThat(a.path("pruefungsart").asText()).isEqualTo("nicht_erhoben");
        assertThat(a.path("genauigkeitsklasse").isNull()).isTrue();
        assertThat(a.path("pruefung_am").isNull()).isTrue();
        assertThat(a.path("beleg").isNull()).isTrue();
        assertThat(a.path("wandler")).isEmpty();
        // Leer und ausdrücklich „nicht erhoben“ sind dasselbe — und keine Änderung.
        assertThat(ruf("PUT", pfad(gr5), "IK", Map.of(), 200)).isEqualTo(a);
        assertThat(ruf("PUT", pfad(gr5), "IK", Map.of("pruefungsart", "nicht_erhoben", "genauigkeitsklasse", "  "), 200))
                .isEqualTo(a);
        assertThat(journal(gr5)).isEmpty();
        // Eine Angabe zurücknehmen heißt wieder „nicht erhoben“, mit Protokoll.
        ruf("PUT", pfad(gr5), "IK", Map.of("pruefungsart", "keine"), 200);
        assertThat(ruf("PUT", pfad(gr5), "IK", Map.of(), 200)).isEqualTo(a);
        assertThat(journal(gr5)).hasSize(2);
    }

    @Test void belegOhnePruefsumme422UndKeineNebenwirkung() throws Exception {
        Map<String, Object> ohne = gr2Angabe();
        ohne.put("beleg", Map.of("bezeichnung", "Eichschein"));
        assertThat(ruf("PUT", pfad(gr2), "IK", ohne, 422).path("code").asText()).isEqualTo("pruefsumme_ungueltig");
        ohne.put("beleg", Map.of("bezeichnung", "Eichschein", "sha256", "3b1f…9a2e"));
        assertThat(ruf("PUT", pfad(gr2), "IK", ohne, 422).path("feld").asText()).isEqualTo("beleg.sha256");
        ohne.put("beleg", Map.of("sha256", SHA_GR2));
        assertThat(ruf("PUT", pfad(gr2), "IK", ohne, 422).path("code").asText()).isEqualTo("beleg_unvollstaendig");
        Map<String, Object> art = gr2Angabe();
        art.put("pruefungsart", "geschaetzt");
        assertThat(ruf("PUT", pfad(gr2), "IK", art, 422).path("code").asText()).isEqualTo("pruefungsart_unbekannt");
        Map<String, Object> zeitraum = gr2Angabe();
        zeitraum.put("pruefung_gueltig_bis", "2023-01-01");
        assertThat(ruf("PUT", pfad(gr2), "IK", zeitraum, 422).path("code").asText()).isEqualTo("zeitraum_ungueltig");
        Map<String, Object> fremdesFeld = gr2Angabe();
        fremdesFeld.put("genauigkeit_messkette", "0,7 %");
        ruf("PUT", pfad(gr2), "IK", fremdesFeld, 400);
        assertThat(ruf("GET", pfad(gr2), "IK", null, 200).path("zustand").asText()).isEqualTo("nicht_erhoben");
        assertThat(journal(gr2)).isEmpty();
        // Die Datenbank hält dieselbe Grenze: ein Beleg ohne Prüfsumme ist keiner.
        assertThatThrownBy(() -> root.update("UPDATE geraet SET beleg_bezeichnung='x', beleg_actor_name='IK', "
                + "beleg_actor_sub='IK', beleg_actor_art='kunde', beleg_am=now() WHERE id=?", gr2))
                .hasMessageContaining("geraet_beleg_vollstaendig_chk");
        assertThatThrownBy(() -> root.update("UPDATE geraet SET beleg_bezeichnung='x', beleg_sha256=?, "
                + "beleg_actor_name='IK', beleg_actor_sub='IK', beleg_actor_art='kunde', beleg_am=now() WHERE id=?",
                SHA_GR2.toUpperCase(), gr2)).hasMessageContaining("geraet_beleg_sha256_chk");
    }

    @Test void r8AngabeHaengtAmEinbauNichtAmGeraet() throws Exception {
        var b = ruf("PUT", pfad(z5b), "TB", Map.of("genauigkeitsklasse", "1", "pruefungsart", "werksbescheinigung",
                "pruefung_am", "2026-10-02", "beleg", Map.of("bezeichnung", "Werksprüfprotokoll Seriennr. 88231",
                        "ablage", "beim Kunden", "sha256", SHA_Z5B.toUpperCase())), 200);
        assertThat(b.path("einbau_kennzeichen").asText()).isEqualTo("Z-5b");
        assertThat(b.path("pruefung_gueltig_bis").isNull()).isTrue();
        assertThat(b.at("/beleg/sha256").asText()).isEqualTo(SHA_Z5B);
        assertThat(b.at("/beleg/person/art").asText()).isEqualTo("unterstuetzung");
        assertThat(b.at("/beleg/person/rolle").asText()).isEqualTo("unterstuetzer");
        assertThat(ruf("GET", pfad(z5a), "IK", null, 200).path("zustand").asText()).isEqualTo("nicht_erhoben");
        assertThat(root.queryForObject("SELECT actor_art FROM geraet_aenderung WHERE geraet_id=?", String.class, z5b))
                .isEqualTo("unterstuetzung");
        // Das Protokoll des Einbaus Z-5b nennt den Eintrag, das von Z-5a nicht.
        assertThat(ruf("GET", "/api/v1/geraete/" + z5b + "/aenderungen", "IK", null, 200).path("eintraege")).hasSize(1);
        assertThat(ruf("GET", "/api/v1/geraete/" + z5a + "/aenderungen", "IK", null, 200).path("eintraege")).isEmpty();
    }

    @Test void wandlerKlasseNurAnDerWandlerFassung() throws Exception {
        var a = ruf("PUT", pfad(gr7), "IK", Map.of("wandler", List.of(Map.of("fassung", wandler, "klasse", "0,5"))), 200);
        assertThat(a.path("zustand").asText()).isEqualTo("nicht_erhoben");
        assertThat(a.path("wandler")).hasSize(1);
        assertThat(a.at("/wandler/0/art").asText()).isEqualTo("wandler_strom");
        assertThat(a.at("/wandler/0/klasse").asText()).isEqualTo("0,5");
        assertThat(a.at("/wandler/0/zustand").asText()).isEqualTo("erhoben");
        assertThat(a.at("/wandler/0/wert/primaer_a").asInt()).isEqualTo(400);
        var neu = JSON.readTree(root.queryForObject("SELECT neu::text FROM geraet_aenderung WHERE geraet_id=?",
                String.class, gr7));
        assertThat(neu.at("/wandler/0/klasse").asText()).isEqualTo("0,5");
        assertThat(ruf("PUT", pfad(gr7), "IK", Map.of("wandler", List.of(Map.of("fassung", skalierung, "klasse", "1"))),
                422).path("code").asText()).isEqualTo("klasse_nur_am_wandler");
        UUID fremdeFassung = einstellung(gr2, "wandler_strom", "{\"primaer_a\": 100, \"sekundaer_a\": 5}");
        assertThat(ruf("PUT", pfad(gr7), "IK", Map.of("wandler", List.of(Map.of("fassung", fremdeFassung, "klasse", "1"))),
                422).path("code").asText()).isEqualTo("fassung_unbekannt");
        assertThat(journal(gr7)).hasSize(1);
        // Die Klasse ist eine Angabe, keine Wirkung: Wert und Gültigkeit der Fassung bleiben.
        assertThat(root.queryForObject("SELECT wert::text FROM quelle_einstellung WHERE id=?", String.class, wandler))
                .isEqualTo("{\"primaer_a\": 400, \"sekundaer_a\": 5}");
        assertThatThrownBy(() -> root.update("UPDATE quelle_einstellung SET klasse='1' WHERE id=?", skalierung))
                .hasMessageContaining("quelle_einstellung_klasse_chk");
    }

    @Test void rechteJeRolleMitStandortZaunUeberDenEinbauort() throws Exception {
        Map<String, Object> e = Map.of("pruefungsart", "kalibrierung");
        ruf("PUT", pfad(gr9), "PH", e, 200);            // Bearbeiter an seinem Standort (S)
        ruf("PUT", pfad(gr2), "PH", e, 404);            // Einbau an einem fremden Standort: gibt es nicht
        ruf("GET", pfad(gr2), "PH", null, 404);
        ruf("PUT", pfad(gr2), "CB", e, 403);            // Leser: sieht, darf nicht
        ruf("GET", pfad(gr2), "CB", null, 200);
        ruf("PUT", pfad(gr5), "TB", e, 200);            // Unterstützer mit „Einrichten“
        ruf("PUT", pfad(gr9), "TB", e, 404);            // … nur an seinem Standort
        ruf("PUT", pfad(gr2), "JW", e, 200);            // Kundenadministrator
        ruf("PUT", pfad(UUID.randomUUID()), "IK", e, 404);
        assertThat(journal(gr2)).hasSize(1);
        assertThat(journal(gr9)).hasSize(1);
    }

    @Test void rlsMandantUndOffboarding() throws Exception {
        ruf("PUT", pfad(gr2), "IK", gr2Angabe(), 200);
        ruf("GET", pfad(gr2), "FR", null, 404);
        ruf("PUT", pfad(gr2), "FR", gr2Angabe(), 404);
        try (var c = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), "voltpilot_app", "ip15_test_pw").getConnection();
                var st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id','" + fremd + "',false)");
            try (var rs = st.executeQuery("SELECT count(*) FROM geraet_aenderung")) {
                rs.next();
                assertThat(rs.getInt(1)).isZero();
            }
            assertThatThrownBy(() -> st.execute("INSERT INTO geraet_aenderung(tenant_id,geraet_id,art,actor_sub,"
                    + "actor_name,actor_art) VALUES ('" + tenant + "','" + gr2 + "','messmittel_angabe','IK','Ines','kunde')"))
                    .hasMessageContaining("row-level security");
        }
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE oid='geraet_aenderung'::regclass", Boolean.class)).isTrue();
        for (String recht : List.of("UPDATE", "DELETE")) {
            assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app','geraet_aenderung',?)",
                    Boolean.class, recht)).as(recht).isFalse();
        }
        new com.voltpilot.api.repo.TenantRepository(new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_admin", "ip15_admin_pw"))).offboard(tenant);
        assertThat(root.queryForObject("SELECT count(*) FROM geraet_aenderung WHERE tenant_id=?", Integer.class, tenant))
                .isZero();
    }

    // ------------------------------------------------------------------ Gerüst

    private static String pfad(UUID geraet) {
        return "/api/v1/geraete/" + geraet + "/messmittel";
    }

    private static Map<String, Object> gr2Angabe() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("genauigkeitsklasse", "B (MID, Wirkenergie)");
        m.put("pruefungsart", "eichung");
        m.put("pruefung_am", "2023-06-14");
        m.put("pruefung_gueltig_bis", "2031-12-31");
        m.put("beleg", Map.of("bezeichnung",
                "Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental, Zählernr. 47110000001-Z1",
                "ablage", "beim Kunden (Netzrechnung)", "sha256", SHA_GR2));
        return m;
    }

    private List<String> journal(UUID geraet) {
        return root.queryForList("SELECT art FROM geraet_aenderung WHERE geraet_id=? ORDER BY id", String.class, geraet);
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        UUID bereich = sub.equals("FR") ? fremd : tenant;
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", bereich.toString())
                .claim("realm_access", Map.of("roles", sub.equals("TB") ? List.of("partner") : List.of()))
                .claim("name", NAMEN.get(sub)).build();
        var b = request(HttpMethod.valueOf(method), path)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (sub.equals("TB")) {
            b.header("X-Kundenbereich", tenant.toString());
        }
        if (body != null) {
            b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        }
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString()).isEqualTo(status);
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        return text.isEmpty() ? JSON.nullNode() : JSON.readTree(text);
    }

    private UUID standort(String k) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, k, k);
    }

    private void benutzer(String sub, String konto, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,?,?,'aktiv')",
                tenant, sub, konto, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }

    private UUID anlage(String name, UUID standort) {
        UUID id = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,?) RETURNING id", UUID.class,
                tenant, name);
        root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, id, standort);
        return id;
    }

    private UUID geraet(UUID site, String kennzeichen, String einbau, String ab, String bis) {
        return root.queryForObject("INSERT INTO geraet(tenant_id,site_id,kennzeichen,einbau_kennzeichen,geraeteart,"
                + "eingebaut_am,ausgebaut_am) VALUES (?,?,?,?,'zaehler',?::timestamptz,?::timestamptz) RETURNING id",
                UUID.class, tenant, site, kennzeichen, einbau, ab, bis);
    }

    private UUID einstellung(UUID geraet, String art, String wert) {
        return root.queryForObject("INSERT INTO quelle_einstellung(tenant_id,geraet_id,art,wert,anwendung,herkunft,"
                + "gueltig_ab,rueckwirkend,actor_sub,actor_name,actor_art) VALUES (?,?,?,?::jsonb,'dokumentiert',"
                + "'eintrag','2024-01-01T00:00:00Z',false,'IK','Ines Kaltenbach','kunde') RETURNING id",
                UUID.class, tenant, geraet, art, wert);
    }
}
