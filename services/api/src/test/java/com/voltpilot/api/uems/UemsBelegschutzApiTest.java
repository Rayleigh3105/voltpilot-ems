package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.entities.EntityRegistryService;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.file.Path;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Belegschutz (UEMS AP-12 IP-12, E13 S2, Referenzfall B12) Ende zu Ende gegen echtes Keycloak + TimescaleDB:
 * was ein freigegebener Berichtsstand zitiert, lässt sich nicht mehr löschen — und was nichts wegnimmt, geht weiter.
 *
 * <p>Die Welt ist das Referenzunternehmen (Halle 2: AN-2, Box E-2, K-8.1 … K-8.4 hinter MS-10 … MS-13, der Ladepunkt
 * K-9 hinter MS-14; Halle 1: der Hybrid-Wechselrichter K-1 hinter MS-04). Die Berichtsstände sind wie in B12
 * Annahmen: BR-2026-0001 Nr. 1 (ersetzt) und Nr. 2 zitieren MS-12 unmittelbar, BR-2026-0002 Nr. 1 mittelbar,
 * BR-2026-0004 Nr. 1 als Vergleich; BR-2026-0003 zitiert MS-11 nur in seinem Entwurf. Die Welt liegt 60 Tage vor
 * der echten Uhr, damit jede Bindung und jeder Ort in der Vergangenheit beginnt.
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li><b>B12 Teil 1</b>: die Komponente hinter MS-12 löschen → 409 {@code berichts_belege} mit vier Ständen und dem
 *       Satz aus {@code bericht-vectors.json}, der Fingerabdruck der ganzen Datenbank unverändert; die Einzahl an
 *       K-8.1; ein Entwurf schützt nichts, eine gebundene, aber nicht zitierte Komponente geht wie heute;</li>
 *   <li><b>B12 Teil 2–4</b>: Purge E-2 und Anlage AN-2 entfernen → 409 mit BEIDEN Listen, nichts geschrieben; Box
 *       abmelden bleibt erlaubt (204); Ort B-3 archivieren bleibt erlaubt (200);</li>
 *   <li><b>die zwei Wege über die §8-Zelle hinaus</b> (firstmate 001 = A): Batterie am Standort abmelden und Verbraucher
 *       entfernen lehnen denselben Beleg ab — der Verbraucher-Fall tritt heute wirklich ein (Box abgemeldet, der
 *       Verbraucher ist damit „unverbunden“ und löschbar); ohne Beleg laufen beide wie heute.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class UemsBelegschutzApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.08.26.3";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final LocalDate HEUTE = LocalDate.now(BERLIN);
    private static final LocalDate SEIT = HEUTE.minusDays(60);
    private static final String AB = DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(SEIT.atStartOfDay(BERLIN).toOffsetDateTime());

    /** Die vier Stände, die MS-12 zitieren (B12 {@code staende_mit_ms12}). */
    private static final List<String> STAENDE_MS12 =
            List.of("BR-2026-0001 Nr. 1", "BR-2026-0001 Nr. 2", "BR-2026-0002 Nr. 1", "BR-2026-0004 Nr. 1");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

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
        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    EntityRegistryService registryService;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JsonNode referenz;
    private static JsonNode b12;
    private static JdbcTemplate root;

    /** Werk Ahrenberg: ST-1, AN-1 mit K-1, AN-2 mit Box E-2 und K-8.1 … K-8.4, K-9. */
    private record Werk(UUID tenant, Anrufer admin, UUID st1, UUID an1, UUID an2, UUID box,
            Map<String, UUID> komponenten, Map<String, UUID> messstellen) {
        UUID k(String kennzeichen) {
            return komponenten.get(kennzeichen);
        }

        UUID ms(String kennzeichen) {
            return messstellen.get(kennzeichen);
        }
    }

    @BeforeAll
    static void ladeReferenz() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        b12 = element(MAPPER.readTree(V2.resolve("bericht-vectors.json").toFile()).get("cases"), "B12", "id");
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- B12 Teil 1 ------------------------------------------------------------------------------

    /**
     * B12 Teil 1: die Komponente hinter MS-12 (K-8.3) ist Beleg in vier Ständen — auch im ersetzten Nr. 1, auch als
     * mittelbare Quelle und als Vergleich. 409 mit Liste und dem Vertragssatz; der Fingerabdruck der ganzen Datenbank
     * ist danach derselbe. Ein Entwurf schützt nichts, eine gebundene, aber von keinem Stand zitierte Komponente
     * geht wie heute.
     */
    @Test
    void b12_dieKomponenteHinterMs12IstBelegInVierStaendenUndNichtsWirdGeschrieben() {
        Werk w = werk("B12 Komponente");
        berichte(w);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        ResponseEntity<JsonNode> k83 = rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an2() + "/v2-entities/" + w.k("K-8.3"),
                w.admin());
        komponenteIstBeleg(k83, STAENDE_MS12, List.of("MS-12"));
        assertThat(k83.getBody().get("message").asText()).isEqualTo(kundensatz(0));

        // Die Einzahl: K-8.1 hinter MS-10 zitiert nur BR-2026-0001 Nr. 1.
        ResponseEntity<JsonNode> k81 = rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an2() + "/v2-entities/" + w.k("K-8.1"),
                w.admin());
        komponenteIstBeleg(k81, List.of("BR-2026-0001 Nr. 1"), List.of("MS-10"));
        assertThat(k81.getBody().get("message").asText()).isEqualTo(kundensatz(1));

        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("eine Ablehnung schreibt nichts").isEmpty();
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id IN (?, ?)", w.k("K-8.3"), w.k("K-8.1")))
                .isEqualTo(2);

        // Entwürfe schützen nichts: MS-11 steht nur im Entwurf von BR-2026-0003 — K-8.2 geht wie heute.
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an2() + "/v2-entities/" + w.k("K-8.2"),
                w.admin()))).isEqualTo(204);
        // Gebunden, aber von keinem Stand zitiert: K-8.4 hinter MS-13 — wie heute.
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an2() + "/v2-entities/" + w.k("K-8.4"),
                w.admin()))).isEqualTo(204);
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id IN (?, ?)", w.k("K-8.2"), w.k("K-8.4")))
                .isZero();
    }

    // ---- B12 Teil 2–4 und der Verbraucher --------------------------------------------------------

    /**
     * B12 Teil 2–4. Purge E-2 kommt VOR dem Abmelden: eine ausgebaute Box ist für jede Geräte-Route 404 (AP-07 IP-11),
     * ein Purge danach erreicht die Belegprüfung gar nicht. Beide Ablehnungen tragen beide Listen und schreiben
     * nichts; Box abmelden bleibt 204. Der Verbraucher K-9 ist nach dem Abmelden „unverbunden“ und heute löschbar —
     * jetzt 409 mit seinem Beleg. Ort B-3 archivieren bleibt 200: MS-12 lag dort, bis sie gestern nach G-2 umzog (ein
     * Ort mit AKTIVER Messstelle ist schon heute gesperrt, AP-02 IP-15 — ein Berichts-Beleg fügt keinen Grund hinzu).
     */
    @Test
    void b12_boxAbmeldenBleibtErlaubtPurgeUndAnlageNennenBeideListenOrtArchivierenBleibtErlaubt() {
        Werk w = werk("B12 Box");
        berichte(w);
        UUID g2 = ort(w, "gebaeude", "G-2", element(referenz.get("gebaeude"), "G-2").get("name").asText(), null);
        UUID b3 = ort(w, "bereich", "B-3", element(referenz.get("bereiche"), "B-3").get("name").asText(), g2);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, gueltig_ab, gueltig_bis) VALUES (?, ?, ?, ?, ?)",
                w.tenant(), w.ms("MS-12"), b3, Date.valueOf(SEIT), Date.valueOf(HEUTE.minusDays(1)));
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                w.tenant(), w.ms("MS-12"), g2, Date.valueOf(HEUTE));
        List<String> messstellen = List.of("MS-10", "MS-11", "MS-12", "MS-13", "MS-14");
        String liste = "MS-10 Netzbezug Halle 2, MS-11 Spritzguss SG07–SG10, MS-12 Montage Linie M1, "
                + "MS-13 Lager Halle 2 (Allgemein), MS-14 Ladepunkt Parkplatz Halle 2. Freigegebene Berichtsstände, die "
                + "sie zitieren: BR-2026-0001 Nr. 1, BR-2026-0001 Nr. 2, BR-2026-0002 Nr. 1, BR-2026-0004 Nr. 1.";
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        // Teil 3a — Purge E-2: 409 mit beiden Listen, kein Wasserzeichen, nichts geschrieben.
        ResponseEntity<JsonNode> purge = rufe(HttpMethod.POST, "/api/v1/devices/" + w.box() + "/purge-data", w.admin());
        beideListen(purge, messstellen, STAENDE_MS12,
                "Die Aufzeichnungen dieser Box sind Belege von 5 Messstellen und werden nicht gelöscht: " + liste);
        // Der verbundene Verbraucher: die Bestandsregel kommt zuerst, wie heute.
        ResponseEntity<JsonNode> verbunden = rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an2() + "/consumers/" + w.k("K-9"),
                w.admin());
        assertThat(status(verbunden)).isEqualTo(409);
        assertThat(verbunden.getBody().get("message").asText()).contains("noch mit einem Gerät verbunden");
        assertThat(root.queryForObject("SELECT data_purged_before FROM device WHERE id = ?", Timestamp.class, w.box()))
                .isNull();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();

        // Teil 2 — Box abmelden: erlaubt, wie heute.
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/devices/" + w.box(), w.admin()))).isEqualTo(204);
        Map<String, String> abgemeldet = Bestandsschutz.fingerabdruck(root, List.of());

        // Der Verbraucher K-9 ist jetzt „unverbunden“ — heute ginge er samt Bindung an MS-14; jetzt ist er ein Beleg.
        assertThat(root.queryForObject("SELECT device_id FROM measurement_point WHERE id = ?", UUID.class, w.k("K-9")))
                .isNull();
        ResponseEntity<JsonNode> verbraucher = rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an2() + "/consumers/"
                + w.k("K-9"), w.admin());
        komponenteIstBeleg(verbraucher, List.of("BR-2026-0001 Nr. 1", "BR-2026-0001 Nr. 2"), List.of("MS-14"));

        // Teil 3b — Anlage AN-2 entfernen (keine angemeldete Box mehr): 409 mit beiden Listen.
        ResponseEntity<JsonNode> anlage = rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an2(), w.admin());
        beideListen(anlage, messstellen, STAENDE_MS12,
                "Die Messwerte dieser Anlage sind Belege von 5 Messstellen und werden nicht gelöscht: " + liste);
        assertThat(Bestandsschutz.abweichungen(abgemeldet, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();

        // Teil 4 — Ort B-3 archivieren: erlaubt.
        ResponseEntity<JsonNode> archiviert = rufe(HttpMethod.POST, "/api/v1/orte/" + b3 + "/archivieren", w.admin());
        assertThat(status(archiviert)).as(String.valueOf(archiviert.getBody())).isEqualTo(200);
        assertThat(archiviert.getBody().get("zustand").asText()).isEqualTo("archiviert");
    }

    // ---- Über die §8-Zelle hinaus: Batterie am Standort abmelden, Verbraucher entfernen ----------

    /**
     * Batterie am Standort abmelden (PR 731, dieselbe DangerZone) entfernt die Komponente {@code battery-hybrid}: speiste
     * sie MS-04, die BR-2026-0001 zitiert, ist sie ein Beleg — 409, Speicher-Nennwerte und Komponente bleiben. MS-04
     * bindet der Test über den Protokolleintrag {@code quelle_gebunden}: „Laden / Entladen“ als Intervallmenge braucht
     * einen Speicher-Messkanal, den die Test-Box nicht liest; der Eintrag ist, was jede Bindung hinterlässt und was die
     * Bindungs-Zeile überlebt. Ohne Beleg laufen beide Wege wie heute.
     */
    @Test
    void batterieAbmeldenUndVerbraucherEntfernenLehnenDenselbenBelegAbUndGehenOhneIhnWieHeute() {
        Werk w = werk("B12 Batterie");
        berichte(w);
        UUID speicher = root.queryForObject("INSERT INTO asset (tenant_id, site_id, type, is_primary) VALUES (?, ?, "
                + "'battery', true) RETURNING id", UUID.class, w.tenant(), w.an1());
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        ResponseEntity<JsonNode> batterie = rufe(HttpMethod.DELETE, "/api/v1/sites/" + w.an1() + "/battery", w.admin());
        komponenteIstBeleg(batterie, List.of("BR-2026-0001 Nr. 1", "BR-2026-0001 Nr. 2"), List.of("MS-04"));
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        assertThat(anzahl("SELECT count(*) FROM asset WHERE id = ?", speicher)).isOne();
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id = ?", w.k("K-1"))).isOne();

        // Eine Bestandsanlage ohne zitierte Messstelle: Batterie abmelden und Verbraucher entfernen wie heute.
        UUID lager = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Lager Nord') RETURNING id",
                UUID.class, w.tenant());
        UUID wechselrichter = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type) VALUES (?, ?, 'battery-hybrid', 'Wechselrichter Lager', 'battery-hybrid') RETURNING id",
                UUID.class, w.tenant(), lager);
        UUID lagerSpeicher = root.queryForObject("INSERT INTO asset (tenant_id, site_id, type, is_primary) VALUES (?, ?, "
                + "'battery', true) RETURNING id", UUID.class, w.tenant(), lager);
        UUID heizstab = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type) "
                + "VALUES (?, ?, 'heating-rod', 'Heizstab Lager', 'heating-rod') RETURNING id", UUID.class, w.tenant(), lager);
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES (?, ?, ?, 'on_off', 3.0)", heizstab, w.tenant(), lager);
        assertThat(status(rufe(HttpMethod.DELETE, "/api/v1/sites/" + lager + "/battery", w.admin()))).isEqualTo(200);
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id = ?", wechselrichter)).isZero();
        assertThat(anzahl("SELECT count(*) FROM asset WHERE id = ?", lagerSpeicher)).isZero();
        assertThat(rufe(HttpMethod.DELETE, "/api/v1/sites/" + lager + "/consumers/" + heizstab, w.admin())
                .getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id = ?", heizstab)).isZero();
    }

    // ---- Gerüst: das Referenzunternehmen ------------------------------------------------------

    /** All additional DELETE entries use the same response and refuse before any write. */
    @ParameterizedTest
    @ValueSource(strings = {"admin", "admin-purge", "admin-composed", "measurement-points"})
    void verwaltungsUndMesspunktLoeschwegeSchuetzenBelegeUndLassenUnzitierteWieBisher(String weg) {
        Werk w = werk("Verwaltungsweg " + weg);
        berichte(w);
        if (weg.equals("admin-composed")) {
            root.update("UPDATE measurement_point SET role = 'pv-generation' WHERE id IN (?, ?)",
                    w.k("K-8.3"), w.k("K-8.2"));
        }
        String prefix = weg.equals("measurement-points") ? "/api/v1/sites/" : "/api/v1/admin/sites/";
        String segment = weg.equals("measurement-points") ? "/measurement-points/" : "/v2-entities/";
        String suffix = weg.equals("admin-purge") ? "?purgePoint=true" : "";
        String route = prefix + w.an2() + segment;
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        ResponseEntity<JsonNode> result = rufe(HttpMethod.DELETE, route + w.k("K-8.3") + suffix, w.admin());
        komponenteIstBeleg(result, STAENDE_MS12, List.of("MS-12"));
        assertThat(Bestandsschutz.fingerabdruck(root, List.of())).isEqualTo(vorher);

        // Same point in a different selected tenant is still invisible, without leaking the report list.
        UUID fremd = root.queryForObject("INSERT INTO tenant (name) VALUES ('Fremd') RETURNING id", UUID.class);
        assertThat(status(rufe(HttpMethod.DELETE, route + w.k("K-8.3") + suffix, new Anrufer("admin", fremd))))
                .isEqualTo(404);
        assertThat(status(rufe(HttpMethod.DELETE, route + UUID.randomUUID() + suffix, w.admin()))).isEqualTo(404);

        // MS-11 is cited only by a draft: keep the old success status and composed-row behavior.
        ResponseEntity<JsonNode> frei = rufe(HttpMethod.DELETE, route + w.k("K-8.2") + suffix, w.admin());
        assertThat(status(frei)).as(String.valueOf(frei.getBody()))
                .isEqualTo(weg.equals("measurement-points") ? 200 : 204);
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id = ?", w.k("K-8.2")))
                .isEqualTo(weg.equals("admin-composed") ? 1 : 0);
        if (weg.equals("admin-composed")) {
            assertThat(root.queryForObject("SELECT entity_type FROM measurement_point WHERE id = ?",
                    String.class, w.k("K-8.2"))).isNull();
        }
    }

    /** Re-pin and adoption share stale-point cleanup; citations retain the row and all its evidence. */
    @ParameterizedTest
    @ValueSource(strings = {"repin", "adopt"})
    @ExtendWith(OutputCaptureExtension.class)
    void internesAufraeumenUeberspringtZitierteZeilenUndLoeschtUnzitierte(String weg, CapturedOutput output) {
        Werk w = werk("Aufräumen " + weg);
        berichte(w);
        UUID belegt = w.k("K-8.3");
        UUID frei = w.k("K-8.2");
        root.update("UPDATE measurement_point SET entity_type = NULL, role = 'pv-generation', capacity_kwp = 5, "
                + "edge_source_id = id::text WHERE id IN (?, ?)", belegt, frei);
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES (?, ?, 'pv', 10)",
                w.tenant(), w.an2());
        String vorher = root.queryForObject("SELECT (to_jsonb(p) - 'edge_source_id')::text "
                + "FROM measurement_point p WHERE id = ?", String.class, belegt);
        long quellen = anzahl("SELECT count(*) FROM messstelle_quelle WHERE entity_id = ?", belegt);
        assertThat(quellen).isPositive();
        TenantContext.set(w.tenant());

        var neu = weg.equals("repin")
                ? registryService.repin(w.an2(), w.k("K-8.4"), belegt.toString())
                : registryService.adopt(w.an2(), belegt.toString(), "modbus-generic", "Übernommen", null, null, null);
        assertThat(neu.edgeSourceId()).isEqualTo(belegt.toString());
        assertThat(neu.id()).isNotEqualTo(belegt);
        assertThat(root.queryForObject("SELECT (to_jsonb(p) - 'edge_source_id')::text "
                + "FROM measurement_point p WHERE id = ?", String.class, belegt)).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT edge_source_id FROM measurement_point WHERE id = ?",
                String.class, belegt)).isNull();
        assertThat(anzahl("SELECT count(*) FROM messstelle_quelle WHERE entity_id = ?", belegt)).isEqualTo(quellen);
        assertThat(root.queryForObject("SELECT pv_capacity_kwp FROM asset WHERE site_id = ? AND type = 'pv'",
                java.math.BigDecimal.class, w.an2())).isEqualByComparingTo("10");
        assertThat(output).contains("Belegschutz: Aufräumen der Komponente " + belegt)
                .contains("übersprungen; Berichtsstände:", "BR-2026-0001", "BR-2026-0004");

        if (weg.equals("repin")) registryService.repin(w.an2(), neu.id(), frei.toString());
        else registryService.adopt(w.an2(), frei.toString(), "modbus-generic", "Übernommen", null, null, null);
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id = ?", frei)).isZero();
        assertThat(root.queryForObject("SELECT pv_capacity_kwp FROM asset WHERE site_id = ? AND type = 'pv'",
                java.math.BigDecimal.class, w.an2())).isEqualByComparingTo("5");
        assertThat(anzahl("SELECT count(*) FROM messstelle_quelle WHERE entity_id = ?", belegt)).isEqualTo(quellen);
    }

    private Werk werk(String zusatz) {
        String unternehmen = referenz.at("/unternehmen/name").asText();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                unternehmen + " · " + zusatz);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, unternehmen);
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand, created_at) VALUES (?, ?, ?, 'ST-1', 'Europe/Berlin', 'aktiv', ?) RETURNING id", UUID.class, t, u,
                element(referenz.get("standorte"), "ST-1").get("name").asText(), seit());
        UUID an1 = anlage(t, "AN-1");
        UUID an2 = anlage(t, "AN-2");
        JsonNode e2 = element(referenz.get("boxen"), "E-2");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, created_at) "
                + "VALUES (?, ?, ?, ?, 'claimed', ?) RETURNING id", UUID.class, t, an2, "box-halle-2-" + t,
                e2.get("name").asText() + " (" + e2.get("seriennummer").asText() + ")", seit());
        Werk w = new Werk(t, new Anrufer("admin", t), st1, an1, an2, box, new LinkedHashMap<>(), new LinkedHashMap<>());
        for (String k : List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4")) {
            w.komponenten().put(k, komponente(w, an2, box, k, "modbus-generic"));
            auswahl(t, an2, box, w.k(k), ENERGIE_BEZUG);
        }
        // Der Ladepunkt als Verbraucher: die Box liest ihn, einen Geräte-Pin (edge_source_id) trägt er nicht.
        w.komponenten().put("K-9", komponente(w, an2, box, "K-9", "wallbox"));
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES (?, ?, ?, 'on_off', 22.0)", w.k("K-9"), t, an2);
        auswahl(t, an2, box, w.k("K-9"), ENERGIE_BEZUG);
        // Der Hybrid-Wechselrichter an AN-1: die Komponente, die „Batterie am Standort abmelden“ entfernt.
        w.komponenten().put("K-1", komponente(w, an1, null, "K-1", "battery-hybrid"));

        binden(w, "MS-10", "K-8.1");
        binden(w, "MS-11", "K-8.2");
        binden(w, "MS-12", "K-8.3");
        binden(w, "MS-13", "K-8.4");
        binden(w, "MS-14", "K-9");
        UUID ms04 = messstelle(w, "MS-04");
        root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, neu, gilt_ab, rueckwirkend, "
                + "actor_name, actor_art) VALUES (?, ?, 'quelle_gebunden', jsonb_build_object('komponente', ?::text, "
                + "'kanal', 'Speicherleistung'), ?, false, 'VoltPilot', 'voltpilot')", t, ms04, w.k("K-1").toString(), seit());
        return w;
    }

    /** BR-2026-0001 Nr. 1 (ersetzt) und Nr. 2, BR-2026-0002 Nr. 1, BR-2026-0004 Nr. 1 — BR-2026-0003 nur als Entwurf. */
    private static void berichte(Werk w) {
        UUID br1 = bericht(w, "BR-2026-0001", "2026-10");
        stand(w, br1, 1, Map.of("MS-04", "unmittelbar", "MS-10", "unmittelbar", "MS-12", "unmittelbar",
                "MS-14", "unmittelbar"));
        stand(w, br1, 2, Map.of("MS-04", "unmittelbar", "MS-12", "unmittelbar", "MS-14", "unmittelbar"));
        root.update("UPDATE bericht_stand SET ersetzt_durch_nr = 2 WHERE bericht_id = ? AND nr = 1", br1);
        stand(w, bericht(w, "BR-2026-0002", "2026-11"), 1, Map.of("MS-12", "mittelbar"));
        UUID br3 = bericht(w, "BR-2026-0003", "2026-12");
        String abzug = "{\"bericht\":\"BR-2026-0003\",\"entwurf\":true}";
        root.update("INSERT INTO bericht_entwurf (tenant_id, bericht_id, abzug, pruefsumme, datenstand, gebildet_von) "
                + "VALUES (?, ?, ?, ?, now() - interval '1 day', 'anlegen')", w.tenant(), br3, abzug,
                BerichtRegeln.pruefsumme(abzug));
        quellen(w, br3, null, Map.of("MS-11", "unmittelbar"));
        stand(w, bericht(w, "BR-2026-0004", "2027-01"), 1, Map.of("MS-12", "vergleich"));
    }

    private static UUID bericht(Werk w, String kennung, String monat) {
        return root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "standort_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, ?, "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', ?, 'Europe/Berlin', 'Ines Kaltenbach') RETURNING id",
                UUID.class, w.tenant(), kennung, w.st1(), monat);
    }

    /** Ein freigegebener Stand, wie die Freigabe ihn schreibt — der Abzug ist hier nur ein Platzhalter mit Prüfsumme. */
    private static void stand(Werk w, UUID bericht, int nr, Map<String, String> quellen) {
        String abzug = "{\"bericht\":\"" + bericht + "\",\"nr\":" + nr + "}";
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, freigegeben_am, "
                + "freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, vorlage_fassung) VALUES (?, ?, ?, "
                + "?, ?, now() - interval '2 days', now() - interval '1 day', 'kc-ik', 'Ines Kaltenbach', 'energiemanager', "
                + "'{}'::jsonb, '{}'::jsonb, 1)", w.tenant(), bericht, nr, abzug, BerichtRegeln.pruefsumme(abzug));
        quellen(w, bericht, nr, quellen);
    }

    private static void quellen(Werk w, UUID bericht, Integer nr, Map<String, String> quellen) {
        quellen.forEach((kennzeichen, bezug) -> root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, "
                + "art, kennzeichen, objekt_id, bezug, erster_tag, letzter_tag, version, fassung, name_zum_datenstand) "
                + "VALUES (?, ?, ?, 'messstelle', ?, ?, ?, ?, ?, 1, NULL, ?)", w.tenant(), bericht, nr, kennzeichen,
                w.ms(kennzeichen), bezug, Date.valueOf(SEIT), Date.valueOf(SEIT.plusDays(29)),
                element(referenz.get("messstellen"), kennzeichen).get("name").asText()));
    }

    private static UUID anlage(UUID t, String kennzeichen) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id", UUID.class,
                t, element(referenz.get("anlagen"), kennzeichen).get("name").asText(), seit());
    }

    private static UUID komponente(Werk w, UUID site, UUID box, String kennzeichen, String art) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, device_id, role, label, entity_type, "
                + "control, communication, created_at) VALUES (?, ?, ?, ?, ?, ?, false, 'modbus_tcp', ?) RETURNING id",
                UUID.class, w.tenant(), site, box, art, element(referenz.get("komponenten"), kennzeichen).get("name").asText(),
                art, seit());
    }

    private static void auswahl(UUID t, UUID site, UUID box, UUID komponente, String kanal) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute') ON CONFLICT DO NOTHING", t, site, box, komponente,
                kanal, KATALOG);
    }

    /** Eine Messstelle der Referenz über die Route anlegen. */
    private UUID messstelle(Werk w, String kennzeichen) {
        JsonNode ms = element(referenz.get("messstellen"), kennzeichen);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        body.put("hauptgroesse", groesseAus(ms.get("hauptgroesse")));
        List<JsonNode> neben = new ArrayList<>();
        ms.get("nebengroessen").forEach(n -> neben.add(groesseAus(n)));
        body.put("nebengroessen", neben);
        ResponseEntity<JsonNode> angelegt = rufe(HttpMethod.POST, "/api/v1/messstellen", w.admin(), body);
        assertThat(status(angelegt)).as(String.valueOf(angelegt.getBody())).isEqualTo(201);
        UUID id = UUID.fromString(angelegt.getBody().get("id").asText());
        w.messstellen().put(kennzeichen, id);
        return id;
    }

    /** Die Hauptgröße ab dem ersten Tag der Welt an den Energie-Kanal der Komponente binden. */
    private void binden(Werk w, String kennzeichen, String komponente) {
        UUID id = messstelle(w, kennzeichen);
        Map<String, Object> bindung = new LinkedHashMap<>();
        bindung.put("komponente", w.k(komponente).toString());
        bindung.put("kanal", ENERGIE_BEZUG);
        bindung.put("rolle", "fuehrend");
        bindung.put("gueltig_ab", AB);
        ResponseEntity<JsonNode> gebunden = rufe(HttpMethod.POST, "/api/v1/messstellen/" + id + "/quellen", w.admin(), bindung);
        assertThat(status(gebunden)).as(String.valueOf(gebunden.getBody())).isEqualTo(201);
    }

    private UUID ort(Werk w, String art, String kennzeichen, String name, UUID eltern) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("art", art);
        body.put("name", name);
        body.put("kurzzeichen", kennzeichen);
        body.put("gueltigAb", SEIT.toString());
        if (eltern != null) {
            body.put("elternId", eltern.toString());
        }
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/api/v1/standorte/" + w.st1() + "/orte", w.admin(), body);
        assertThat(status(r)).as(String.valueOf(r.getBody())).isEqualTo(201);
        return UUID.fromString(r.getBody().get("id").asText());
    }

    // ---- Gerüst: Zusicherungen ------------------------------------------------------------------

    /** Die Komponente ist Beleg: 409 {@code berichts_belege}, die Stände in Reihenfolge, die zitierten Messstellen. */
    private static void komponenteIstBeleg(ResponseEntity<JsonNode> r, List<String> staende, List<String> messstellen) {
        assertThat(status(r)).as(String.valueOf(r.getBody())).isEqualTo(409);
        JsonNode b = r.getBody();
        assertThat(b.get("code").asText()).isEqualTo(BelegeImWeg.CODE_BERICHTE);
        assertThat(texte(b.get("codes"))).containsExactly(BelegeImWeg.CODE_BERICHTE);
        assertThat(staende(b)).containsExactlyElementsOf(staende);
        assertThat(kennzeichen(b)).containsExactlyElementsOf(messstellen);
        assertThat(b.get("message").asText()).isEqualTo(BerichtRegeln.berichtsBelege(b.get("berichtsstaende").isEmpty()
                ? List.of() : staendeAus(b)));
    }

    /** Purge oder Anlage: 409 mit BEIDEN Listen in derselben Antwort, {@code code} wie heute. */
    private static void beideListen(ResponseEntity<JsonNode> r, List<String> messstellen, List<String> staende, String satz) {
        assertThat(status(r)).as(String.valueOf(r.getBody())).isEqualTo(409);
        JsonNode b = r.getBody();
        assertThat(b.get("code").asText()).isEqualTo(BelegeImWeg.CODE);
        assertThat(texte(b.get("codes"))).containsExactly(BelegeImWeg.CODE, BelegeImWeg.CODE_BERICHTE);
        assertThat(kennzeichen(b)).containsExactlyElementsOf(messstellen);
        assertThat(staende(b)).containsExactlyElementsOf(staende);
        assertThat(b.get("message").asText()).isEqualTo(satz);
    }

    private static List<String> staende(JsonNode b) {
        return staendeAus(b).stream().map(s -> s.kennung() + " Nr. " + s.nr()).toList();
    }

    private static List<BerichtRegeln.StandBezeichnung> staendeAus(JsonNode b) {
        List<BerichtRegeln.StandBezeichnung> aus = new ArrayList<>();
        b.get("berichtsstaende").forEach(s -> aus.add(new BerichtRegeln.StandBezeichnung(s.get("kennung").asText(),
                s.get("nr").asInt())));
        return aus;
    }

    private static List<String> kennzeichen(JsonNode b) {
        List<String> aus = new ArrayList<>();
        b.get("messstellen").forEach(m -> {
            assertThat(m.get("id").asText()).isNotBlank();
            assertThat(m.get("name").asText()).isNotBlank();
            aus.add(m.get("kennzeichen").asText());
        });
        return aus;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    /** Der Kundensatz der i-ten Prüfung von B12 in {@code bericht-vectors.json}. */
    private static String kundensatz(int i) {
        return b12.get("pruefungen").get(i).at("/ergebnis/kundensatz").asText();
    }

    // ---- Gerüst: Anfragen -------------------------------------------------------------------------

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer) {
        return rufe(methode, pfad, wer, null);
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token(wer.benutzer()));
        if (wer.kundenbereich() != null) {
            headers.set("X-Tenant-Id", wer.kundenbereich().toString());
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange(java.net.URI.create("http://localhost:" + port + pfad), methode, entity, JsonNode.class);
    }

    private static int status(ResponseEntity<JsonNode> r) {
        return r.getStatusCode().value();
    }

    private String token(String benutzer) {
        Token t = TOKENS.get(benutzer);
        if (t != null && System.currentTimeMillis() - t.geholt() < 5 * 60_000) {
            return t.wert();
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", benutzer);
        form.add("password", benutzer);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        String wert = (String) body.get("access_token");
        TOKENS.put(benutzer, new Token(wert, System.currentTimeMillis()));
        return wert;
    }

    // ---- Gerüst: Datenbank --------------------------------------------------------------------------

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static Timestamp seit() {
        return Timestamp.from(SEIT.atStartOfDay(BERLIN).toInstant());
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        return element(liste, kennzeichen, "kennzeichen");
    }

    private static JsonNode element(JsonNode liste, String kennzeichen, String feld) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.path(feld).asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static JsonNode groesseAus(JsonNode g) {
        ObjectNode n = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }
}
