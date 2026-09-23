package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
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
 * AP-17 R9 über die echte HTTP-, Rechte- und RLS-Kette (IP-11a, V4, W1): an KZ-0004 (Geltung P-1 Spritzguss) schlägt
 * {@code GET /api/v1/kennzahlen/{id}/variablen-vorschlag} die Einflussgrößen der Einsätze von P-1 vor — BZ-1 ist
 * Variable 1 (der Nenner), BZ-3 ein Kandidat mit r = 0,997 → Hinweis {@code variablen_abhaengig} gegen BZ-1, die
 * Leckagerate eine Zeile „ohne Zahl“. Danach sind Einsatz, Kennzahl und Bezugsgrößen byte-gleich (AP-16 B5).
 *
 * <p>Abweichung vom Referenzfall, bewusst: dort steht die Leckagerate an EE-3 Druckluft (P-3), und V4 liest nur die
 * Einsätze der Geltung. Damit die Zeile „ohne Zahl“ an KZ-0004 erscheint, trägt hier ein zweiter Einsatz von P-1
 * (Träger Druckluft) die Leckagerate und — wie EE-3 — BZ-3.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VariablenVorschlagApiTest {
    private static final String EINSAETZE = "/api/v1/unternehmen/energieeinsaetze";
    private static final String KENNZAHLEN = "/api/v1/kennzahlen";
    private static final ObjectMapper JSON = new ObjectMapper();
    /** R9: BZ-1 Produktionsmenge und BZ-3 Betriebsstunden, zwölf Monate (uems-referenzunternehmen.json 1.8). */
    private static final int[] BZ1 = {318000, 262000, 298000, 305000, 331000, 309000, 322000, 327000, 296000, 254000,
        336000, 341000};
    private static final int[] BZ3 = {5112, 4149, 4778, 4819, 5314, 4908, 5151, 5165, 4751, 4026, 5404, 5419};
    private static final String REFERENZ = "2025-01/2025-12";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip11a_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip11a_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    static JdbcTemplate root;
    UUID tenant, unternehmen, s1, s2, p1, p2;
    UUID bz1, bz3;

    @BeforeAll
    static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-11a') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id",
                UUID.class, tenant);
        s1 = standort("ST-1");
        s2 = standort("ST-2");
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'IK','benutzer',"
                + "'Ines Kaltenbach','aktiv')", tenant);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,'IK','energiemanager',NULL,'2024-01-01','Europe/Berlin')", tenant);
        p1 = prozess("P-1", "Spritzguss", s1);
        p2 = prozess("P-2", "Montage", s2);
        bz1 = bezugsgroesse("BZ-1", "Produktionsmenge Spritzguss", "kg", p1);
        bz3 = bezugsgroesse("BZ-3", "Betriebsstunden Spritzguss", "h", p1);
        for (int i = 0; i < 12; i++) {
            wert(bz1, "kg", LocalDate.of(2025, i + 1, 1), BZ1[i]);
            wert(bz3, "h", LocalDate.of(2025, i + 1, 1), BZ3[i]);
        }
    }

    @Test
    void r9Bz1IstVariable1Bz3HaengtDaranLeckagerateOhneZahlUndNichtsVeraendert() throws Exception {
        JsonNode ee1 = einsatz(p1, "Strom", "Spritzguss",
                List.of(verweis(bz1, "produktion"), verweis(bz3, "betriebszeit")));
        JsonNode ee2 = einsatz(p1, "Druckluft", "Druckluft",
                List.of(verweis(bz3, "betriebszeit"), Map.of("wortlaut", "Leckagerate", "art", "sonstige")));
        UUID kz4 = kennzahl("KZ-0004", "prozess", p1, "MS-1", "BZ-1");
        String vorher = bestand();

        JsonNode v = ruf("GET", pfad(kz4) + "?referenzperiode=" + REFERENZ, 200);

        assertThat(bestand()).as("Einsatz, Kennzahl und Bezugsgrößen byte-gleich (AP-16 B5)").isEqualTo(vorher);
        assertThat(v.at("/kennzahl/kennzeichen").asText()).isEqualTo("KZ-0004");
        assertThat(v.path("geltung_art").asText()).isEqualTo("prozess");
        assertThat(v.path("bezug").asText()).isEqualTo("prozess");
        assertThat(v.path("referenzperiode").asText()).isEqualTo(REFERENZ);
        assertThat(v.path("satz").isNull()).isTrue();
        assertThat(v.path("einsaetze").findValuesAsText("kennzeichen"))
                .containsExactly(ee1.path("kennzeichen").asText(), ee2.path("kennzeichen").asText());
        assertThat(v.at("/variable_1/kennzeichen").asText()).isEqualTo("BZ-1");
        assertThat(v.at("/variable_1/hat_werte").asBoolean()).isTrue();
        assertThat(v.at("/variable_1/hat_kanal").asBoolean()).isFalse();

        JsonNode kandidaten = v.path("kandidaten");
        assertThat(kandidaten).hasSize(2);
        JsonNode k1 = kandidaten.get(0);
        assertThat(k1.at("/bezugsgroesse/kennzeichen").asText()).isEqualTo("BZ-1");
        assertThat(k1.path("vorschlag").asText()).isEqualTo("variable_1");
        assertThat(k1.path("einfluss_art").asText()).isEqualTo("produktion");
        assertThat(k1.path("abhaengigkeit").isNull()).isTrue();
        JsonNode k3 = kandidaten.get(1);
        assertThat(k3.at("/bezugsgroesse/kennzeichen").asText()).isEqualTo("BZ-3");
        assertThat(k3.at("/bezugsgroesse/einheit").asText()).isEqualTo("h");
        assertThat(k3.path("vorschlag").asText()).isEqualTo("variable");
        assertThat(texte(k3.path("einsaetze")))
                .containsExactly(ee1.path("kennzeichen").asText(), ee2.path("kennzeichen").asText());
        JsonNode g4 = k3.path("abhaengigkeit");
        assertThat(g4.path("ergebnis").asText()).isEqualTo("variablen_abhaengig");
        assertThat(g4.path("gegen").asText()).isEqualTo("BZ-1");
        assertThat(g4.path("paare").asInt()).isEqualTo(12);
        assertThat(g4.path("r").asDouble()).isBetween(0.9972, 0.9973);
        assertThat(new BigDecimal(g4.path("schwelle").asText())).isEqualByComparingTo("0.9");
        assertThat(k3.path("satz").asText()).isEqualTo("Betriebsstunden Spritzguss hängt an Produktionsmenge Spritzguss "
                + "(r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.");

        JsonNode ohne = v.path("ohne_zahl");
        assertThat(ohne).hasSize(1);
        assertThat(ohne.get(0).path("wortlaut").asText()).isEqualTo("Leckagerate");
        assertThat(ohne.get(0).path("einfluss_art").asText()).isEqualTo("sonstige");
        assertThat(ohne.get(0).path("einsatz").asText()).isEqualTo(ee2.path("kennzeichen").asText());
        assertThat(ohne.get(0).path("satz").asText()).isEqualTo("ohne Zahl — erst als Bezugsgröße erfassen");

        // Zu wenig Monatspaare: nicht prüfbar, ohne r — und ohne Parameter die zwölf Monate vor dem laufenden.
        JsonNode kurz = ruf("GET", pfad(kz4) + "?referenzperiode=2025-01/2025-02", 200);
        assertThat(kurz.at("/kandidaten/1/abhaengigkeit/ergebnis").asText()).isEqualTo("nicht_pruefbar");
        assertThat(kurz.at("/kandidaten/1/abhaengigkeit/grund").asText()).isEqualTo("zu_wenig_paare");
        assertThat(kurz.at("/kandidaten/1/abhaengigkeit/r").isNull()).isTrue();
        assertThat(ruf("GET", pfad(kz4), 200).path("referenzperiode").asText()).matches("\\d{4}-\\d{2}/\\d{4}-\\d{2}");
        assertThat(bestand()).isEqualTo(vorher);
    }

    /** V4 zweiter Weg: ohne Einsatz am Prozess der Geltung die Einsätze der Prozesse der Zähler-Messstellen. */
    @Test
    void ohneProzessGeltungUeberDieZaehlerMessstellen() throws Exception {
        JsonNode ee1 = einsatz(p1, "Strom", "Spritzguss", List.of(verweis(bz1, "produktion")));
        UUID kz = kennzahl("KZ-0010", "unternehmen", unternehmen, "MS-1", "BZ-3");
        JsonNode v = ruf("GET", pfad(kz) + "?referenzperiode=" + REFERENZ, 200);
        assertThat(v.path("bezug").asText()).isEqualTo("zaehler_messstellen");
        assertThat(v.path("einsaetze").findValuesAsText("kennzeichen")).containsExactly(ee1.path("kennzeichen").asText());
        assertThat(v.at("/variable_1/kennzeichen").asText()).isEqualTo("BZ-3");
        assertThat(v.at("/kandidaten/0/bezugsgroesse/kennzeichen").asText()).isEqualTo("BZ-1");
        assertThat(v.at("/kandidaten/0/abhaengigkeit/ergebnis").asText()).isEqualTo("variablen_abhaengig");
    }

    @Test
    void ohneEinsatzBezugLeereListenMitSatz() throws Exception {
        UUID kz = kennzahl("KZ-0002", "prozess", p2, "MS-2", "BZ-1");
        JsonNode v = ruf("GET", pfad(kz), 200);
        assertThat(v.path("bezug").asText()).isEqualTo("keiner");
        assertThat(v.path("einsaetze")).isEmpty();
        assertThat(v.path("kandidaten")).isEmpty();
        assertThat(v.path("ohne_zahl")).isEmpty();
        assertThat(v.path("satz").asText()).isEqualTo(VariablenVorschlag.KEIN_EINSATZ);
    }

    @Test
    void zaunUndStrengeAnfrage() throws Exception {
        UUID kz4 = kennzahl("KZ-0004", "prozess", p1, "MS-1", "BZ-1");
        JsonNode unbekannt = ruf("GET", pfad(UUID.randomUUID()), 404);
        assertThat(unbekannt.path("code").asText()).isEqualTo("nicht_gefunden");
        assertThat(ruf("GET", KENNZAHLEN + "/keine-id/variablen-vorschlag", 404)).isEqualTo(unbekannt);
        UUID eigener = tenant;
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd') RETURNING id", UUID.class);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'IK','benutzer',"
                + "'Ines Kaltenbach','aktiv')", tenant);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,'IK','energiemanager',NULL,'2024-01-01','Europe/Berlin')", tenant);
        assertThat(ruf("GET", pfad(kz4), 404)).as("fremder Kundenbereich: 404, nie 403").isEqualTo(unbekannt);
        tenant = eigener;
        for (String falsch : List.of("?referenzperiode=2025-12/2025-01", "?referenzperiode=2025", "?periode=monat")) {
            JsonNode a = ruf("GET", pfad(kz4) + falsch, 400);
            assertThat(a.path("code").asText()).as(falsch).isEqualTo("anfrage_ungueltig");
        }
        for (String methode : List.of("POST", "PUT", "DELETE")) {
            assertThat(status(methode, pfad(kz4))).as(methode).isIn(403, 405);
        }
    }

    // ------------------------------------------------------------------------------ Welt

    private static String pfad(UUID kennzahl) {
        return KENNZAHLEN + "/" + kennzahl + "/variablen-vorschlag";
    }

    /** Alles, was der Vorschlag lesen darf, als Text — vor und nach dem Aufruf gleich. */
    private String bestand() {
        List<String> teile = new ArrayList<>();
        for (String tabelle : List.of("energieeinsatz", "energieeinsatz_einflussgroesse", "energieeinsatz_aenderung",
                "kennzahl", "kennzahl_fassung", "kennzahl_eingang", "kennzahl_wert", "bezugsgroesse", "bezugsgroesse_wert",
                "bezugsgroesse_kanalbindung")) {
            teile.add(tabelle + "=" + root.queryForObject("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), "
                    + "'[]'::jsonb)::text FROM " + tabelle + " t WHERE t.tenant_id = ?", String.class, tenant));
        }
        return String.join("\n", teile);
    }

    private JsonNode einsatz(UUID prozess, String traeger, String name, List<Map<String, Object>> einfluesse)
            throws Exception {
        JsonNode e = ruf("POST", EINSAETZE, Map.of("prozess_id", prozess.toString(), "traeger", traeger, "name", name,
                "gueltig_ab", "2025-01-01"), 201);
        ruf("PUT", EINSAETZE + "/" + e.path("id").asText() + "/einflussgroessen",
                Map.of("einflussgroessen", einfluesse), 200);
        return e;
    }

    private static Map<String, Object> verweis(UUID bezugsgroesse, String art) {
        return Map.of("bezugsgroesse_id", bezugsgroesse.toString(), "art", art);
    }

    private UUID kennzahl(String kennzeichen, String geltungArt, UUID geltung, String zaehler, String nenner)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", kennzeichen + " Spritzguss");
        m.put("rechenform", "quotient");
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", zaehler),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", nenner)));
        return UUID.fromString(ruf("POST", KENNZAHLEN, m, 201).path("id").asText());
    }

    private JsonNode ruf(String method, String path, int status) throws Exception {
        return ruf(method, path, null, status);
    }

    private JsonNode ruf(String method, String path, Object body, int status) throws Exception {
        var r = mvc.perform(anfrage(method, path, body)).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString()).isEqualTo(status);
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    private int status(String method, String path) throws Exception {
        return mvc.perform(anfrage(method, path, null)).andReturn().getResponse().getStatus();
    }

    private org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder anfrage(String method,
            String path, Object body) throws Exception {
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject("IK").issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", "Ines Kaltenbach").build();
        var b = request(HttpMethod.valueOf(method), path)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (body != null) {
            b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        }
        return b;
    }

    private UUID standort(String k) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, k, k);
    }

    /** Ein Prozess mit einer direkt zugeordneten Strom-Messstelle MS-n am Standort. */
    private UUID prozess(String k, String name, UUID standort) {
        UUID p = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,?,?,'2024-01-01') RETURNING id", UUID.class, tenant, unternehmen, k, name);
        UUID m = root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,"
                + "einheit,wertart) VALUES (?,?,?,'gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') "
                + "RETURNING id", UUID.class, tenant, "MS-" + k.substring(2), name);
        root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, m, standort);
        root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) "
                + "VALUES (?,?,?,'2024-01-01')", tenant, m, p);
        return p;
    }

    private UUID bezugsgroesse(String kennzeichen, String name, String einheit, UUID prozess) {
        return root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, prozess_id) VALUES (?, ?, ?, 'periodenwert', ?, 'monat', 'prozess', ?) RETURNING id",
                UUID.class, tenant, kennzeichen, name, einheit, prozess);
    }

    private void wert(UUID bezugsgroesse, String einheit, LocalDate monat, int betrag) {
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', ?, 'monat', ?, ?, 'Europe/Berlin', 1, "
                + "'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                tenant, bezugsgroesse, einheit, monat, monat.withDayOfMonth(monat.lengthOfMonth()), new BigDecimal(betrag));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }
}
