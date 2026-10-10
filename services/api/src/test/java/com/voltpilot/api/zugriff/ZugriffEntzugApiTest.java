package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Entzug wirkt sofort (UEMS AP-03 IP-9) — die vier Abnahmefälle A6, A7, A8 und A13 über die echten Routen,
 * mit dem Demo-Kundenbereich des Dev-Seeds.
 *
 * <ol>
 *   <li><b>A6 — Entzug während der Sitzung:</b> Sabine hat ihren Standort offen; Jonas beendet ihre beiden
 *       Zuweisungen. Ihre NÄCHSTE Anfrage ist 404 {@code zugriff_beendet} mit dem Satz aus §4.7 — ohne
 *       Abmelden, ohne Token-Ablauf und ohne einen Takt dazwischen. {@code /api/v1/me} antwortet weiter,
 *       damit das Portal den Leerzustand rechnen kann.</li>
 *   <li><b>A7 — Bedienrecht weg, Handeingriff bleibt (E15):</b> Murats Eingriff steht nach dem Entzug
 *       ZEICHENGLEICH in {@code device_override}; die Jetzt-Zone trägt ihn mit „(Bedienrecht beendet am …)",
 *       und Murats eigenes „Automatik fortsetzen" ist 403.</li>
 *   <li><b>A8 — 409 zweimal:</b> niemand ändert die eigene Zuweisung, und der letzte Kundenadministrator
 *       bleibt. Mit einer zweiten Kundenadministratorin geht, was vorher 409 war.</li>
 *   <li><b>A13 — das Fehlerbild bleibt:</b> ein fremder Standort ist 404 OHNE Grund (die Existenz wird nicht
 *       bestätigt), ein fehlendes Recht 403 {@code recht_fehlt} mit {@code rolle_noetig}. Nur wer den Zugang
 *       HATTE, bekommt {@code zugriff_beendet}.</li>
 *   <li><b>Bestand:</b> ein Konto, dessen Rechte niemand angefasst hat, kann unverändert dasselbe.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class ZugriffEntzugApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final UUID DEMO = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

    private static final String JONAS = "sub-entzug-jonas";
    private static final String INES = "sub-entzug-ines";
    private static final String SABINE = "sub-entzug-sabine";
    private static final String MURAT = "sub-entzug-murat";
    private static final String CLAUDIA = "sub-entzug-claudia";
    private static final String BESTAND = "sub-entzug-bestandskonto";

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

    private static JdbcTemplate root;
    private static UUID standortA;
    private static UUID standortB;
    private static UUID siteB;

    private record Antwort(int status, String body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void seedEinmal() {
        if (standortA == null) {
            seed();
        }
    }

    // ================================================================= A6

    @Test
    void a6DerEntzugWirktMitDerNaechstenAnfrageUndSagtWarum() throws Exception {
        Authentication sabine = konto(SABINE, DEMO);
        Authentication jonas = konto(JONAS, DEMO);

        assertThat(ruf(get("/api/v1/sites/" + siteB), sabine).status())
                .as("vor dem Entzug sieht Sabine die Anlage ihres Standorts").isEqualTo(200);
        List<UUID> ihre = zuweisungen(SABINE);
        assertThat(ihre).as("Bearbeiter und Bedienberechtigt").hasSize(2);

        for (UUID id : ihre) {
            Antwort a = ruf(MockMvcRequestBuilders.delete(uri("/api/v1/zugriff/" + id)), jonas);
            assertThat(a.status()).as("Jonas entzieht " + id).isEqualTo(204);
        }

        // KEIN Neuanmelden, KEIN Takt, KEIN Warten: die unmittelbar folgende Anfrage ist die nächste.
        Antwort nachher = ruf(get("/api/v1/sites/" + siteB), sabine);
        assertThat(nachher.status()).isEqualTo(404);
        JsonNode n = MAPPER.readTree(nachher.body());
        assertThat(n.path("code").asText()).isEqualTo("zugriff_beendet");
        assertThat(n.path("message").asText()).isEqualTo("Ihr Zugriff auf Werk Ahrenberg Nord wurde beendet.");
        assertThat(n.path("standort").asText()).isEqualTo("Werk Ahrenberg Nord");

        assertThat(ruf(get("/api/v1/sites"), sabine).status()).as("jede Kundenroute, nicht nur die offene")
                .isEqualTo(404);
        assertThat(ruf(get("/api/v1/me"), sabine).status())
                .as("die Selbstauskunft antwortet weiter — sonst gäbe es keinen Leerzustand").isEqualTo(200);

        assertThat(root.queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ? "
                        + "AND betroffener_sub = ? AND aktion = 'entziehen'", Integer.class, DEMO, SABINE))
                .as("Zugriffsprotokoll des Kundenbereichs").isEqualTo(2);
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ? "
                        + "AND objekt_art = 'standort' AND objekt_id = ? AND art = 'zugriff_entzogen'",
                Integer.class, DEMO, standortB))
                .as("Änderungsprotokoll des Standorts (AP-02 §4.4)").isEqualTo(2);
        assertThat(MAPPER.readTree(ruf(get("/api/v1/zugriff?benutzer=" + SABINE), jonas).body()))
                .as("eine Zuweisung wird nie gelöscht — sie steht beendet in der Liste").hasSize(2);

        // Und es gibt auch kein NEGATIVES Gedächtnis: dieselbe Sitzung sieht sofort wieder, was sie wiederbekommt.
        assertThat(ruf(post("/api/v1/zugriff", "{\"benutzer_sub\":\"" + SABINE + "\",\"rolle\":\"leser\","
                + "\"standort_id\":\"" + standortB + "\"}"), jonas).status()).isEqualTo(201);
        assertThat(ruf(get("/api/v1/sites/" + siteB), sabine).status())
                .as("die nächste Anfrage liest die Zuweisung neu — in beide Richtungen").isEqualTo(200);
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ? "
                        + "AND objekt_id = ? AND art = 'zugriff_zugewiesen'", Integer.class, DEMO, standortB))
                .isEqualTo(1);
    }

    // ================================================================= AP-19 IP-12 — Einsicht (R6)

    /**
     * AP-19 IP-12, R6 (RE3, AP-03 E10): der Kundenadministrator weist „Einsicht“ zu und befristet sie ({@code gueltig_bis},
     * letzter Tag einschließlich); befristen lässt sich nur Einsicht (400 sonst), ein Ende in der Vergangenheit ist 400.
     * Mit Einsicht sieht die Leserin unternehmensweit — alle Standorte, die Unternehmens-Rechte nur lesend, keine
     * Teilansicht —; nach dem Ende (eine Einsicht, die gestern endete) sieht sie wieder nur ihren Leser-Standort, den
     * anderen als beendeten Zugriff, und kein Unternehmens-Objekt.
     */
    @Test
    void r6EinsichtWirdBefristetZugewiesenUndDanachGiltWiederDieTeilansicht() throws Exception {
        Authentication jonas = konto(JONAS, DEMO);
        String pruefer = "sub-entzug-pruefer";
        String nachher = "sub-entzug-pruefer-danach";
        spiegel(pruefer);
        amStandort(pruefer, "leser", standortA);
        spiegel(nachher);
        amStandort(nachher, "leser", standortA);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, gueltig_bis, endet_am, zeitzone) "
                + "VALUES (?, ?, 'einsicht', now() - interval '12 days', (now() AT TIME ZONE 'Europe/Berlin')::date - 1, "
                + "(((now() AT TIME ZONE 'Europe/Berlin')::date)::timestamp AT TIME ZONE 'Europe/Berlin'), 'Europe/Berlin')",
                DEMO, nachher);
        java.time.LocalDate heute = java.time.LocalDate.now(java.time.ZoneId.of("Europe/Berlin"));

        assertThat(ruf(post("/api/v1/zugriff", "{\"benutzer_sub\":\"" + pruefer + "\",\"rolle\":\"leser\","
                + "\"standort_id\":\"" + standortB + "\",\"gueltig_bis\":\"" + heute + "\"}"), jonas).status())
                .as("befristen lässt sich nur Einsicht").isEqualTo(400);
        assertThat(ruf(post("/api/v1/zugriff", "{\"benutzer_sub\":\"" + pruefer + "\",\"rolle\":\"einsicht\","
                + "\"gueltig_bis\":\"" + heute.minusDays(1) + "\"}"), jonas).status())
                .as("ein Ende in der Vergangenheit").isEqualTo(400);
        assertThat(ruf(post("/api/v1/zugriff", "{\"benutzer_sub\":\"" + pruefer + "\",\"rolle\":\"einsicht\","
                + "\"gueltig_bis\":\"31.01.2029\"}"), jonas).status()).as("kein Tag").isEqualTo(400);
        Antwort zugewiesen = ruf(post("/api/v1/zugriff", "{\"benutzer_sub\":\"" + pruefer + "\",\"rolle\":\"einsicht\","
                + "\"gueltig_bis\":\"" + heute.plusDays(10) + "\",\"grund\":\"Internes Audit AU-2029-0001\"}"), jonas);
        assertThat(zugewiesen.status()).as(zugewiesen.body()).isEqualTo(201);
        JsonNode z = MAPPER.readTree(zugewiesen.body());
        assertThat(z.path("rolle").asText()).isEqualTo("einsicht");
        assertThat(z.path("standort_id").isNull()).as("unternehmensweit, ohne Standort").isTrue();
        assertThat(z.path("gueltig_bis").asText()).isEqualTo(heute.plusDays(10).toString());
        assertThat(root.queryForObject("SELECT endet_am = ((gueltig_bis + 1)::timestamp AT TIME ZONE zeitzone) FROM zugriff "
                + "WHERE tenant_id = ? AND benutzer_sub = ? AND rolle = 'einsicht'", Boolean.class, DEMO, pruefer)).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ? AND betroffener_sub = ? "
                + "AND aktion = 'zuweisen' AND rolle = 'einsicht'", Integer.class, DEMO, pruefer)).isEqualTo(1);

        Authentication waehrend = konto(pruefer, DEMO);
        JsonNode ich = MAPPER.readTree(ruf(get("/api/v1/me"), waehrend).body());
        assertThat(ich.path("unternehmensweit").asBoolean()).isTrue();
        assertThat(ich.path("teilansicht").path("teilansicht").asBoolean()).isFalse();
        assertThat(ich.path("teilansicht").path("unternehmensweite_objekte").asBoolean()).isTrue();
        List<String> rechte = new java.util.ArrayList<>();
        ich.path("unternehmen_rechte").forEach(r -> rechte.add(r.asText()));
        assertThat(rechte).contains("bericht.unternehmen_abrufen", "bewertung.ansehen", "messwerte.ansehen",
                "aenderungsprotokoll.lesen").doesNotContain("bericht.unternehmen", "bewertung.abrufen",
                "export.unternehmen", "zugriffsprotokoll.lesen", "zuweisung.verwalten", "verbesserung.verwalten");
        assertThat(ruf(get("/api/v1/sites/" + siteB), waehrend).status()).as("Werk Ahrenberg Nord über Einsicht")
                .isEqualTo(200);
        assertThat(ruf(post("/api/v1/zugriff", "{\"benutzer_sub\":\"" + nachher + "\",\"rolle\":\"leser\","
                + "\"standort_id\":\"" + standortB + "\"}"), waehrend).status()).as("Einsicht weist nichts zu").isEqualTo(403);

        Authentication danach = konto(nachher, DEMO);
        JsonNode spaeter = MAPPER.readTree(ruf(get("/api/v1/me"), danach).body());
        assertThat(spaeter.path("unternehmensweit").asBoolean()).isFalse();
        assertThat(spaeter.path("teilansicht").path("unternehmensweite_objekte").asBoolean()).isFalse();
        List<String> sichtbar = new java.util.ArrayList<>();
        spaeter.path("standorte").forEach(st -> sichtbar.add(st.path("name").asText()));
        assertThat(sichtbar).containsExactly("Werk Ahrenberg");
        assertThat(ruf(get("/api/v1/sites/" + siteB), danach).status())
                .as("Werk Ahrenberg Nord ist wieder unsichtbar (Standort-Zaun) — sie hat noch eine Zuweisung, darum kein "
                        + "„jeder Zugriff beendet“").isEqualTo(404);
        assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE), danach).status()).as("die Leser-Anlage bleibt").isEqualTo(200);
    }

    // ================================================================= A7

    @Test
    void a7DerHandeingriffBleibtUnveraendertUndBekommtSeinEtikett() throws Exception {
        Authentication murat = konto(MURAT, DEMO);
        Authentication jonas = konto(JONAS, DEMO);

        Antwort gesetzt = ruf(post("/api/v1/sites/" + BERLIN_SITE + "/battery-override",
                "{\"kind\":\"speicher_halten\",\"durationMinutes\":240}"), murat);
        assertThat(gesetzt.status()).as("Bedienberechtigt darf (E4)").isEqualTo(200);
        Map<String, Object> vorher = eingriff();
        assertThat(vorher).isNotNull();

        UUID bedienrecht = zuweisung(MURAT, "bedienberechtigt");
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/zugriff/" + bedienrecht)), jonas).status())
                .isEqualTo(204);

        assertThat(eingriff()).as("E15: der Entzug schaltet nie — die Zeile bleibt, wie sie war")
                .isEqualTo(vorher);

        JsonNode jetzt = MAPPER.readTree(ruf(get("/api/v1/sites/" + BERLIN_SITE + "/interventions"), jonas).body());
        JsonNode zeile = jetzt.path("interventions").get(0);
        assertThat(zeile.path("etikett").asText())
                .startsWith("gesetzt von " + MURAT + " (Bedienrecht beendet am ").endsWith(")");

        Antwort fortsetzen = ruf(MockMvcRequestBuilders.delete(
                uri("/api/v1/sites/" + BERLIN_SITE + "/battery-override")), murat);
        assertThat(fortsetzen.status()).as("Murat darf nicht mehr eingreifen").isEqualTo(403);
        assertThat(MAPPER.readTree(fortsetzen.body()).path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE), murat).status())
                .as("sein Leser-Recht am selben Standort bleibt").isEqualTo(200);
        assertThat(eingriff()).as("auch die abgelehnte Anfrage hat nichts geschrieben").isEqualTo(vorher);
    }

    // ================================================================= A8

    @Test
    void a8DieEigeneZuweisungUndDerLetzteKundenadministratorSindGeschuetzt() throws Exception {
        Authentication jonas = konto(JONAS, DEMO);
        UUID seine = zuweisung(JONAS, "kundenadministrator");

        Antwort selbst = ruf(MockMvcRequestBuilders.delete(uri("/api/v1/zugriff/" + seine)), jonas);
        assertThat(selbst.status()).as("niemand ändert die eigene Zuweisung (W12)").isEqualTo(409);
        assertThat(MAPPER.readTree(selbst.body()).path("code").asText()).isEqualTo("eigene_zuweisung");

        // Ein Konto, das hier NIE eine Zuweisung hatte, handelt nach der Bestandsregel E12 als
        // Kundenadministrator — es steht aber in keiner Zuweisung. Genau dafür ist der Schutz da: es darf den
        // EINEN eingetragenen Kundenadministrator nicht entfernen.
        Antwort letzter = ruf(MockMvcRequestBuilders.delete(uri("/api/v1/zugriff/" + seine)), konto(BESTAND, DEMO));
        assertThat(letzter.status()).isEqualTo(409);
        JsonNode l = MAPPER.readTree(letzter.body());
        assertThat(l.path("code").asText()).isEqualTo("letzter_kundenadministrator");
        assertThat(l.path("message").asText()).endsWith("braucht mindestens einen Kundenadministrator. "
                + "Ernennen Sie zuerst eine weitere Person.");

        Antwort ernannt = ruf(post("/api/v1/zugriff",
                "{\"benutzer_sub\":\"" + INES + "\",\"rolle\":\"kundenadministrator\"}"), jonas);
        assertThat(ernannt.status()).as("Jonas ernennt Ines zusätzlich").isEqualTo(201);

        Authentication inesAuth = konto(INES, DEMO);
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/zugriff/" + seine)), inesAuth).status())
                .as("INES kann Jonas jetzt herabstufen — er sich selbst weiterhin nicht").isEqualTo(204);
        UUID ihre = zuweisung(INES, "kundenadministrator");
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/zugriff/" + ihre)), inesAuth).status())
                .as("und auch Ines nicht sich selbst").isEqualTo(409);

        // Zurück in den Ausgangszustand: Ines ernennt Jonas erneut (eine NEUE Zeile — eine Zuweisung wird nie
        // wiederbelebt, AP-00 Invariante 4), dann nimmt Jonas ihr die seine wieder ab.
        assertThat(ruf(post("/api/v1/zugriff",
                "{\"benutzer_sub\":\"" + JONAS + "\",\"rolle\":\"kundenadministrator\"}"), inesAuth).status())
                .isEqualTo(201);
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/zugriff/" + ihre)), konto(JONAS, DEMO)).status())
                .isEqualTo(204);
        assertThat(zuweisungen(JONAS)).as("Jonas ist wieder der eine eingetragene Kundenadministrator").hasSize(1);
    }

    // ================================================================= A13

    @Test
    void a13FremderStandortIst404OhneGrundFehlendesRecht403() throws Exception {
        Authentication claudia = konto(CLAUDIA, DEMO);

        Antwort fremd = ruf(get("/api/v1/standorte/" + standortB), claudia);
        assertThat(fremd.status()).isEqualTo(404);
        assertThat(MAPPER.readTree(fremd.body()).path("code").asText())
                .as("Claudia hatte ST-B nie — die Existenz wird nicht bestätigt (W2)").isNotEqualTo("zugriff_beendet");

        Antwort loeschen = ruf(MockMvcRequestBuilders.delete(uri("/api/v1/sites/" + BERLIN_SITE)), claudia);
        assertThat(loeschen.status()).isEqualTo(403);
        JsonNode d = MAPPER.readTree(loeschen.body());
        assertThat(d.path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(d.path("rolle_noetig").asText()).isEqualTo("kundenadministrator");

        Antwort eingriff = ruf(post("/api/v1/sites/" + BERLIN_SITE + "/battery-override",
                "{\"kind\":\"speicher_halten\",\"durationMinutes\":60}"), claudia);
        assertThat(eingriff.status()).isEqualTo(403);
        assertThat(MAPPER.readTree(eingriff.body()).path("rolle_noetig").asText()).isEqualTo("bedienberechtigt");
    }

    // ================================================================= Bestand

    @Test
    void bestandJedesKontoOhneAngefassteRechteKannUnveraendertDasselbe() throws Exception {
        for (Authentication k : List.of(konto(JONAS, DEMO), konto(BESTAND, DEMO))) {
            assertThat(ruf(get("/api/v1/sites"), k).status()).isEqualTo(200);
            assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE), k).status()).isEqualTo(200);
            assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE + "/interventions"), k).status()).isEqualTo(200);
            assertThat(ruf(get("/api/v1/me"), k).status()).isEqualTo(200);
        }
        // Ein Leser bleibt Leser: er sieht seinen Standort und darf dort nichts steuern — wie vor IP-9.
        Authentication claudia = konto(CLAUDIA, DEMO);
        assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE), claudia).status()).isEqualTo(200);
        assertThat(ruf(get("/api/v1/sites/" + siteB), claudia).status()).isEqualTo(404);
    }

    // ================================================================= Hilfen

    private Map<String, Object> eingriff() {
        List<Map<String, Object>> zeilen = root.queryForList("SELECT kind, entity_id, target_value, ends_at, "
                + "created_by, created_at, actor_sub, actor_name, actor_rolle, actor_art FROM device_override "
                + "WHERE tenant_id = ? AND entity_id IS NOT NULL", DEMO);
        return zeilen.isEmpty() ? null : zeilen.get(0);
    }

    private static List<UUID> zuweisungen(String sub) {
        return root.queryForList("SELECT id FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ? "
                + "AND beendet_am IS NULL ORDER BY rolle", UUID.class, DEMO, sub);
    }

    private static UUID zuweisung(String sub, String rolle) {
        return root.queryForObject("SELECT id FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ? AND rolle = ? "
                + "AND beendet_am IS NULL", UUID.class, DEMO, sub, rolle);
    }

    private Antwort ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        MvcResult r = mvc.perform(anfrage.with(authentication(auth))).andReturn();
        return new Antwort(r.getResponse().getStatus(), r.getResponse().getContentAsString());
    }

    private static MockHttpServletRequestBuilder get(String pfad) {
        return MockMvcRequestBuilders.get(uri(pfad));
    }

    private static MockHttpServletRequestBuilder post(String pfad, String body) {
        return MockMvcRequestBuilders.post(uri(pfad)).contentType(MediaType.APPLICATION_JSON).content(body);
    }

    private static java.net.URI uri(String pfad) {
        return java.net.URI.create(pfad);
    }

    private static Authentication konto(String sub, UUID tenant) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", List.of()));
        if (tenant != null) {
            claims.put("tenant_id", tenant.toString());
        }
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    /**
     * Zwei Standorte im Demo-Kundenbereich: die Berliner Anlage an „Werk Ahrenberg" (Jonas, Murat, Claudia),
     * eine zweite Anlage an „Werk Ahrenberg Nord" (Sabine). Der Bestandskonto-Login bekommt KEINE Zuweisung
     * (Bestandsregel E12) — und der Kundenbereich keinen Stichtag, damit sie gilt.
     */
    private static void seed() {
        UUID unternehmen = root.queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, DEMO)
                .stream().findFirst().orElseGet(() -> root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                        + "VALUES (?, 'Kunststoffwerk Ahrenberg GmbH') RETURNING id", UUID.class, DEMO));
        standortA = standort(unternehmen, "Werk Ahrenberg", "ST-A1");
        standortB = standort(unternehmen, "Werk Ahrenberg Nord", "ST-A3");
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?::uuid, ?, '2024-01-01')", DEMO, BERLIN_SITE, standortA);
        siteB = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) "
                + "VALUES (?, 'Halle Nord', 'DE-LU') RETURNING id", UUID.class, DEMO);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2024-01-01')", DEMO, siteB, standortB);

        spiegel(JONAS);
        unternehmensweit(JONAS, "kundenadministrator");
        spiegel(INES);
        unternehmensweit(INES, "energiemanager");
        spiegel(SABINE);
        amStandort(SABINE, "bearbeiter", standortB);
        amStandort(SABINE, "bedienberechtigt", standortB);
        spiegel(MURAT);
        amStandort(MURAT, "bedienberechtigt", standortA);
        amStandort(MURAT, "leser", standortA);
        spiegel(CLAUDIA);
        amStandort(CLAUDIA, "leser", standortA);
        spiegel(BESTAND);
    }

    private static UUID standort(UUID unternehmen, String name, String kurzzeichen) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                DEMO, unternehmen, name, kurzzeichen);
    }

    private static void spiegel(String sub) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", DEMO, sub, sub);
    }

    private static void unternehmensweit(String sub, String rolle) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", DEMO, sub, rolle);
    }

    private static void amStandort(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", DEMO, sub, rolle, standort);
    }
}
