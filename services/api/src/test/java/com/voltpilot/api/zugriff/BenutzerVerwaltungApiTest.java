package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.benutzer.Startpasswort;
import com.voltpilot.api.benutzer.StartpasswortKonten;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
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
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.ConnectionCallback;
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

/** AP-03 IP-13: Kundenrouten unter echter RLS, eigene Rolle und letzter Administrator. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BenutzerVerwaltungApiTest {

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

    /** Das Keycloak-Konto beim Anlegen (AP-19 Folge IP-13) — ohne Keycloak-Container; die Zuweisung ist echt. */
    @MockBean
    StartpasswortKonten konten;

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

    @Test void listeLesendUndMandantenzaun() throws Exception {
        assertThat(ruf(get("/api/v1/benutzer"), konto(JONAS, DEMO)).status()).isEqualTo(200);
        Antwort liste = ruf(get("/api/v1/benutzer"), konto(INES, DEMO));
        assertThat(liste.status()).isEqualTo(200);
        assertThat(liste.body()).contains(JONAS, "energiemanager").doesNotContain("startpasswort");
        assertThat(ruf(get("/api/v1/benutzer"), konto(CLAUDIA, DEMO)).status()).isEqualTo(403);
        assertThat(ruf(post("/api/v1/benutzer/" + CLAUDIA + "/sperren", "{}"), konto(INES, DEMO)).status()).isEqualTo(403);
        assertThat(ruf(post("/api/v1/benutzer/fremdes-konto/sperren", "{}"), konto(JONAS, DEMO)).status()).isEqualTo(404);
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/benutzer/fremdes-konto")), konto(JONAS, DEMO)).status()).isEqualTo(404);
        Antwort fremd = ruf(get("/api/v1/benutzer"), konto("anderer-admin", UUID.fromString("00000000-0000-0000-0000-000000000003")));
        assertThat(fremd.body()).doesNotContain(JONAS, CLAUDIA);
    }

    /**
     * Der EIGENE Vertrag der Benutzerliste — die Route ist erst mit IP-13 entstanden, darum nimmt
     * {@link ZugriffZaunApiTest} sie aus seinem Vor-IP4-Bestandsvergleich aus und verweist auf diese Klasse.
     *
     * <p>Lesen duerfen (AP-03 E1/E2, entschieden Option A) Kundenadministrator und Energiemanager, und nach der
     * Bestandsregel E12 ein Kundenkonto ohne jede Zuweisung, solange der Kundenbereich keinen Stichtag hat.
     * Nicht lesen duerfen ein Standort-Leser und dasselbe Bestandskonto NACH gesetztem Stichtag. Die Antwort traegt
     * nur den eigenen Kundenbereich und keine Geheimnisse.
     */
    @Test void benutzerlisteLesendeRollenBestandskontoStichtagUndKeineGeheimnisse() throws Exception {
        UUID fremderKundenbereich = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Ahrenberg Fremdvergleich')", fremderKundenbereich);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, email, zustand) "
                + "VALUES (?, 'liste-fremde-person', 'benutzer', 'Fremde Person', 'fremd@example.invalid', 'aktiv')",
                fremderKundenbereich);
        for (String sub : List.of(JONAS, INES, BESTAND)) {
            Antwort a = ruf(get("/api/v1/benutzer"), konto(sub, DEMO));
            assertThat(a.status()).as(sub).isEqualTo(200);
            List<String> subs = new ArrayList<>();
            MAPPER.readTree(a.body()).forEach(n -> subs.add(n.path("sub").asText()));
            assertThat(subs).as(sub).contains(JONAS, INES, CLAUDIA).doesNotContain("liste-fremde-person");
            assertThat(a.body()).as(sub).doesNotContain("fremd@example.invalid", "passwort", "secret", "Secret");
        }
        assertThat(ruf(get("/api/v1/benutzer"), konto(CLAUDIA, DEMO)).status()).as("Standort-Leser").isEqualTo(403);
        root.update("INSERT INTO zugriff_bestand (tenant_id, stichtag, herkunft, konten) "
                + "VALUES (?, now(), 'bestandslauf', 6)", DEMO);
        try {
            assertThat(ruf(get("/api/v1/benutzer"), konto(BESTAND, DEMO)).status())
                    .as("Bestandskonto nach dem Stichtag").isEqualTo(403);
            assertThat(ruf(get("/api/v1/benutzer"), konto(JONAS, DEMO)).status())
                    .as("echte Zuweisung bleibt unberuehrt").isEqualTo(200);
        } finally {
            root.update("DELETE FROM zugriff_bestand WHERE tenant_id = ?", DEMO);
        }
    }

    /**
     * Der eigene Vertrag des Protokolls — dieselbe Ausnahme im Zaun, dieselbe Klasse als Beleg. Die Route verlangt
     * {@code zugriffsprotokoll.lesen}: in {@code docs/contracts/v2/rechte-matrix.json} U fuer den
     * Kundenadministrator und {@code -} fuer jede andere Kundenrolle, also auch fuer den Energiemanager, der die
     * Liste noch lesen darf. Das Bestandskonto (E12) zaehlt bis zum Stichtag als Kundenadministrator.
     */
    @Test void protokollNurKundenadministratorUndBestandskontoBisZumStichtag() throws Exception {
        String zeitraum = "/api/v1/benutzer/protokoll?von=2024-01-01T00:00:00Z&bis=2024-12-31T00:00:00Z";
        assertThat(ruf(get(zeitraum), konto(JONAS, DEMO)).status()).as("Kundenadministrator").isEqualTo(200);
        assertThat(ruf(get(zeitraum), konto(BESTAND, DEMO)).status()).as("Bestandskonto E12").isEqualTo(200);
        assertThat(ruf(get(zeitraum), konto(INES, DEMO)).status()).as("Energiemanager").isEqualTo(403);
        assertThat(ruf(get(zeitraum), konto(CLAUDIA, DEMO)).status()).as("Standort-Leser").isEqualTo(403);
        Antwort fremd = ruf(get(zeitraum), konto("protokoll-fremder-admin", UUID.randomUUID()));
        assertThat(fremd.body()).as("kein fremdes Protokoll").doesNotContain(JONAS, CLAUDIA);
    }

    @Test void sperrenEntfernenUndAltesTokenSofortGesperrt() throws Exception {
        String sub = "konto-zu-sperren"; spiegel(sub); amStandort(sub, "leser", standortA);
        var alt = konto(sub, DEMO);
        assertThat(ruf(get("/api/v1/sites"), alt).status()).isEqualTo(200);
        assertThat(ruf(post("/api/v1/benutzer/" + sub + "/sperren", "{}"), konto(JONAS, DEMO)).status()).isEqualTo(204);
        Antwort danach = ruf(get("/api/v1/sites"), alt);
        assertThat(danach.status()).isEqualTo(404); assertThat(danach.body()).contains("zugriff_beendet");
        assertThat(zuweisungen(sub)).hasSize(1); // Sperren hält an; Entfernen beendet die Zuweisung.
        assertThat(root.queryForObject("SELECT zustand FROM benutzer WHERE tenant_id = ? AND sub = ?", String.class, DEMO, sub)).isEqualTo("gesperrt");
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/benutzer/" + sub)), konto(JONAS, DEMO)).status()).isEqualTo(204);
        assertThat(zuweisungen(sub)).isEmpty();
        assertThat(ruf(get("/api/v1/benutzer"), konto(JONAS, DEMO)).body()).doesNotContain(sub);
        String p = "/api/v1/benutzer/protokoll?von=" + Instant.now().minusSeconds(3600) + "&bis=" + Instant.now().plusSeconds(3600);
        Antwort protokoll = ruf(get(p), konto(JONAS, DEMO));
        assertThat(protokoll.status()).isEqualTo(200); assertThat(protokoll.body()).contains("sperren", "entfernen", sub);
        assertThat(ruf(get(p), konto(INES, DEMO)).status()).isEqualTo(403);
    }

    @Test void a8AuchKontoSperrenUndEntfernenSchuetzenEigeneRechteUndLetztenAdmin() throws Exception {
        for (var anfrage : List.of(post("/api/v1/benutzer/" + JONAS + "/sperren", "{}"), MockMvcRequestBuilders.delete(uri("/api/v1/benutzer/" + JONAS)))) {
            Antwort a = ruf(anfrage, konto(JONAS, DEMO));
            assertThat(a.status()).isEqualTo(409); assertThat(a.body()).contains("eigene_zuweisung");
        }
        // Noch nicht übernommener Bestandsadministrator: der bekannte letzte Administrator bleibt geschützt.
        Antwort a = ruf(post("/api/v1/benutzer/" + JONAS + "/sperren", "{}"), konto(BESTAND, DEMO));
        assertThat(a.status()).isEqualTo(409); assertThat(a.body()).contains("letzter_kundenadministrator");
    }

    @Test void rollenwechselAtomarPflichtstandortUndFremdeZuweisung404() throws Exception {
        String sub = "konto-wechsel"; spiegel(sub); amStandort(sub, "leser", standortA);
        UUID bisher = zuweisungen(sub).get(0);
        var auth = konto(JONAS, DEMO);
        String pfad = "/api/v1/benutzer/" + sub + "/zugriff";
        Antwort fehlt = ruf(MockMvcRequestBuilders.put(uri(pfad)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(bisher), "rolle", "bearbeiter", "standorte", List.of()))), auth);
        assertThat(fehlt.status()).isEqualTo(422);
        assertThat(zuweisungen(sub)).containsExactly(bisher);
        Antwort fremd = ruf(MockMvcRequestBuilders.put(uri("/api/v1/benutzer/fremd/zugriff")).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(bisher), "rolle", "bearbeiter", "standorte", List.of(standortA)))), auth);
        assertThat(fremd.status()).isEqualTo(404);
        Antwort ok = ruf(MockMvcRequestBuilders.put(uri(pfad)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(bisher), "rolle", "bearbeiter", "standorte", List.of(standortA, standortB)))), auth);
        assertThat(ok.status()).isEqualTo(204);
        assertThat(zuweisungen(sub)).hasSize(2).doesNotContain(bisher);
        Antwort doppelt = ruf(MockMvcRequestBuilders.put(uri(pfad)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(), "rolle", "bearbeiter", "standorte", List.of(standortA)))), auth);
        assertThat(doppelt.status()).isEqualTo(409); assertThat(doppelt.body()).contains("zuweisung_vorhanden");
        assertThat(zuweisungen(sub)).hasSize(2);
    }

    // ================================================================= AP-19 Folge IP-13 — Einsicht befristen (R6)

    /**
     * AP-19 Folge IP-13 (RE3, R6: „Einsicht bis 31.01.2029“ in einem Schritt): {@code POST /api/v1/benutzer} nimmt
     * {@code gueltig_bis} an — dieselben Regeln wie {@code POST /api/v1/zugriff}: nur Einsicht (400), nicht vor heute
     * (422 {@code gueltig_bis_vergangen}), und jede Ablehnung kommt VOR dem Keycloak-Konto. Die Frist steht in der
     * Zuweisung und im Zugriffsprotokoll; nach ihrem Ende ist die unternehmensweite Sicht weg. Ohne {@code gueltig_bis}
     * bleibt die Zuweisung unbefristet wie bisher; ohne {@code benutzer.verwalten} 403.
     */
    @Test void ap19FolgeAnlegenMitBisBefristetEinsichtInEinemSchritt() throws Exception {
        var jonas = konto(JONAS, DEMO);
        LocalDate heute = LocalDate.now(ZoneId.of("Europe/Berlin"));
        when(konten.kunde(any(), anyString(), anyString(), any(), any())).thenAnswer(a -> new StartpasswortKonten.Angelegt(
                new KeycloakUser("kc-" + a.getArgument(1), a.getArgument(1), a.getArgument(2), null, null, true,
                        DEMO.toString()), new Startpasswort("Start-Passwort-24!")));

        assertThat(ruf(post("/api/v1/benutzer", anlage("bis-leser", "leser", List.of(standortA), heute.plusDays(3).toString())),
                jonas).status()).as("befristen lässt sich nur Einsicht").isEqualTo(400);
        Antwort gestern = ruf(post("/api/v1/benutzer", anlage("bis-gestern", "einsicht", List.of(), heute.minusDays(1).toString())), jonas);
        assertThat(gestern.status()).as("ein letzter Tag vor heute").isEqualTo(422);
        assertThat(gestern.body()).contains("gueltig_bis_vergangen");
        assertThat(ruf(post("/api/v1/benutzer", anlage("bis-kein-tag", "einsicht", List.of(), "31.01.2029")), jonas).status())
                .as("kein Tag").isEqualTo(400);
        assertThat(ruf(post("/api/v1/benutzer", anlage("bis-ines", "einsicht", List.of(), heute.plusDays(3).toString())),
                konto(INES, DEMO)).status()).as("Energiemanager hat benutzer.verwalten nicht").isEqualTo(403);
        verify(konten, never()).kunde(any(), anyString(), anyString(), any(), any());

        Antwort befristet = ruf(post("/api/v1/benutzer", anlage("bis-falk", "einsicht", List.of(), heute.plusDays(10).toString())), jonas);
        assertThat(befristet.status()).as(befristet.body()).isEqualTo(201);
        String falk = "kc-bis-falk";
        assertThat(root.queryForObject("SELECT gueltig_bis FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ? "
                + "AND rolle = 'einsicht'", LocalDate.class, DEMO, falk)).isEqualTo(heute.plusDays(10));
        assertThat(root.queryForObject("SELECT endet_am = ((gueltig_bis + 1)::timestamp AT TIME ZONE zeitzone) FROM zugriff "
                + "WHERE tenant_id = ? AND benutzer_sub = ?", Boolean.class, DEMO, falk)).as("letzter Tag einschließlich").isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ? AND betroffener_sub = ? "
                + "AND aktion = 'zuweisen' AND rolle = 'einsicht' AND gueltig_bis = ?", Integer.class, DEMO, falk,
                heute.plusDays(10))).as("protokolliert mit Frist").isEqualTo(1);

        Antwort ohne = ruf(post("/api/v1/benutzer", anlage("bis-ohne", "einsicht", List.of(), null)), jonas);
        assertThat(ohne.status()).as(ohne.body()).isEqualTo(201);
        assertThat(root.queryForObject("SELECT gueltig_bis IS NULL AND endet_am IS NULL FROM zugriff WHERE tenant_id = ? "
                + "AND benutzer_sub = 'kc-bis-ohne'", Boolean.class, DEMO)).as("ohne Frist unbefristet wie bisher").isTrue();
        Antwort leser = ruf(post("/api/v1/benutzer", anlage("ohne-frist-leser", "leser", List.of(standortA), null)), jonas);
        assertThat(leser.status()).as("Bestand: Standortrolle ohne Frist").isEqualTo(201);

        assertThat(MAPPER.readTree(ruf(get("/api/v1/me"), konto(falk, DEMO)).body()).path("unternehmensweit").asBoolean())
                .as("während der Frist unternehmensweit").isTrue();
        assertThat(ruf(get("/api/v1/sites/" + siteB), konto(falk, DEMO)).status()).isEqualTo(200);
        ablaufen(falk);
        assertThat(ruf(get("/api/v1/sites/" + siteB), konto(falk, DEMO)).status()).as("nach dem letzten Tag").isNotEqualTo(200);
        assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE), konto(falk, DEMO)).status()).isNotEqualTo(200);
    }

    /**
     * AP-19 Folge IP-13 (R6): {@code PUT /api/v1/benutzer/{sub}/zugriff} nimmt {@code gueltig_bis} an — eine Leserin
     * bekommt „Einsicht“ befristet dazu, eine unbefristete Einsicht wird durch eine befristete ersetzt. Dieselben Regeln
     * (400, 422, 403), und eine Ablehnung ändert nichts — auch nicht an der bisherigen Zuweisung. Nach dem Ende sieht sie
     * wieder die Teilansicht ihres Leser-Standorts (AP-03 E10).
     */
    @Test void ap19FolgeAendernMitBisBefristetEinsichtUndDanachGiltWiederDieTeilansicht() throws Exception {
        String sub = "konto-einsicht-bis"; spiegel(sub); amStandort(sub, "leser", standortA);
        var jonas = konto(JONAS, DEMO);
        LocalDate heute = LocalDate.now(ZoneId.of("Europe/Berlin"));
        String pfad = "/api/v1/benutzer/" + sub + "/zugriff";

        assertThat(ruf(put(pfad, List.of(), "leser", List.of(standortB), heute.plusDays(3).toString()), jonas).status())
                .as("befristen lässt sich nur Einsicht").isEqualTo(400);
        Antwort gestern = ruf(put(pfad, List.of(), "einsicht", List.of(), heute.minusDays(1).toString()), jonas);
        assertThat(gestern.status()).isEqualTo(422);
        assertThat(gestern.body()).contains("gueltig_bis_vergangen");
        assertThat(ruf(put(pfad, List.of(), "einsicht", List.of(), heute.plusDays(3).toString()), konto(INES, DEMO)).status())
                .isEqualTo(403);
        assertThat(zuweisungen(sub)).as("keine Ablehnung ändert etwas").hasSize(1);

        assertThat(ruf(put(pfad, List.of(), "einsicht", List.of(), null), jonas).status()).isEqualTo(204);
        UUID unbefristet = zuweisung(sub, "einsicht");
        assertThat(root.queryForObject("SELECT gueltig_bis IS NULL FROM zugriff WHERE id = ?", Boolean.class, unbefristet))
                .as("ohne Frist unbefristet wie bisher").isTrue();
        Antwort vergangenErsetzen = ruf(put(pfad, List.of(unbefristet), "einsicht", List.of(), heute.minusDays(1).toString()), jonas);
        assertThat(vergangenErsetzen.status()).isEqualTo(422);
        assertThat(zuweisung(sub, "einsicht")).as("die bisherige Einsicht bleibt").isEqualTo(unbefristet);

        assertThat(ruf(put(pfad, List.of(unbefristet), "einsicht", List.of(), heute.toString()), jonas).status())
                .as("Ändern mit „bis“").isEqualTo(204);
        UUID befristet = zuweisung(sub, "einsicht");
        assertThat(befristet).isNotEqualTo(unbefristet);
        assertThat(root.queryForObject("SELECT gueltig_bis FROM zugriff WHERE id = ?", LocalDate.class, befristet)).isEqualTo(heute);
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ? AND betroffener_sub = ? "
                + "AND aktion = 'zuweisen' AND rolle = 'einsicht' AND gueltig_bis = ?", Integer.class, DEMO, sub, heute))
                .as("protokolliert mit Frist").isEqualTo(1);
        assertThat(zuweisungen(sub)).as("die Leser-Zuweisung bleibt").hasSize(2);

        Authentication pruefer = konto(sub, DEMO);
        assertThat(MAPPER.readTree(ruf(get("/api/v1/me"), pruefer).body()).path("unternehmensweit").asBoolean()).isTrue();
        assertThat(ruf(get("/api/v1/sites/" + siteB), pruefer).status()).as("heute ist der letzte Tag").isEqualTo(200);
        ablaufen(sub);
        JsonNode danach = MAPPER.readTree(ruf(get("/api/v1/me"), pruefer).body());
        assertThat(danach.path("unternehmensweit").asBoolean()).isFalse();
        List<String> sichtbar = new ArrayList<>();
        danach.path("standorte").forEach(st -> sichtbar.add(st.path("name").asText()));
        assertThat(sichtbar).as("Teilansicht ihres Leser-Standorts").containsExactly("Werk Ahrenberg");
        assertThat(ruf(get("/api/v1/sites/" + siteB), pruefer).status()).isEqualTo(404);
        assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE), pruefer).status()).isEqualTo(200);
    }

    @Test void parallelesSperrenLaesstImmerEinenAdministratorUebrig() throws Exception {
        UUID tenant = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Ahrenberg Paralleltest')", tenant);
        for (String sub : List.of("admin-a", "admin-b")) {
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, 'aktiv')", tenant, sub, sub);
            root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) VALUES (?, ?, 'kundenadministrator', '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, sub);
        }
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var start = new java.util.concurrent.CountDownLatch(1);
            var a = pool.submit(() -> { start.await(); return ruf(post("/api/v1/benutzer/admin-a/sperren", "{}"), konto("bestand", tenant)).status(); });
            var b = pool.submit(() -> { start.await(); return ruf(post("/api/v1/benutzer/admin-b/sperren", "{}"), konto("bestand", tenant)).status(); });
            start.countDown();
            assertThat(List.of(a.get(), b.get())).containsExactlyInAnyOrder(204, 409);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff z JOIN benutzer b ON b.tenant_id = z.tenant_id AND b.sub = z.benutzer_sub "
                + "WHERE z.tenant_id = ? AND z.beendet_am IS NULL AND b.zustand = 'aktiv'", Integer.class, tenant)).isEqualTo(1);
    }

    private static String anlage(String username, String rolle, List<UUID> standorte, String gueltigBis) throws Exception {
        Map<String, Object> body = new HashMap<>(Map.of("username", username, "email", username + "@folge-ip13.example",
                "rolle", rolle, "standorte", standorte));
        if (gueltigBis != null) body.put("gueltig_bis", gueltigBis);
        return MAPPER.writeValueAsString(body);
    }

    private static MockHttpServletRequestBuilder put(String pfad, List<UUID> bisher, String rolle, List<UUID> standorte,
            String gueltigBis) throws Exception {
        Map<String, Object> body = new HashMap<>(Map.of("bisher", bisher, "rolle", rolle, "standorte", standorte));
        if (gueltigBis != null) body.put("gueltig_bis", gueltigBis);
        return MockMvcRequestBuilders.put(uri(pfad)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(body));
    }

    /**
     * Die laufende Einsicht endet „gestern“ — wie nach Ablauf ihrer Frist. Ein Zugriff wird nie umgeschrieben (Trigger
     * {@code zugriff_nur_beenden}); nur dieser Test schiebt die Zeile darum an ihm vorbei in die Vergangenheit.
     */
    private static void ablaufen(String sub) {
        int zeilen = root.execute((ConnectionCallback<Integer>) c -> {
            try (var st = c.prepareStatement("UPDATE zugriff SET gueltig_ab = gueltig_ab - interval '30 days', "
                    + "gueltig_bis = (now() AT TIME ZONE zeitzone)::date - 1, "
                    + "endet_am = (((now() AT TIME ZONE zeitzone)::date)::timestamp AT TIME ZONE zeitzone) "
                    + "WHERE tenant_id = ? AND benutzer_sub = ? AND rolle = 'einsicht' AND beendet_am IS NULL")) {
                c.createStatement().execute("SET session_replication_role = replica");
                st.setObject(1, DEMO);
                st.setString(2, sub);
                return st.executeUpdate();
            } finally {
                c.createStatement().execute("SET session_replication_role = origin");
            }
        });
        assertThat(zeilen).isEqualTo(1);
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
