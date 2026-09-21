package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.ZugriffContext;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Leseweg im Zugriff (AP-03 R-A1, A1 „MS-19 unsichtbar“) für die Messstelle, die Vorlagen und das Import-Protokoll
 * — in der Beweisform von {@code BezugsgroesseApiTest#jedeLeserouteZeigtDieBezugsgroesseNurImGeltungsbereich}: Konten
 * mit Kontoart kommen über den {@link KeycloakRealmRoleConverter} (ein {@code jwt()} ohne Kontoart lädt keinen
 * Zugriff-Kontext). Unternehmensweite Rolle, Bestandskonto (E12) und „ohne Kontext“ sehen byte-gleich, was sie vorher
 * sahen; ein Bearbeiter am Standort sieht sein Objekt; ein Bearbeiter nur anderswo bekommt Status und Körper einer
 * unbekannten Kennung bzw. die Zeile fehlt; interne Leser bleiben ungezäunt. Die Messstellen-API-Klassen laufen gegen
 * Keycloak mit festen Demo-Konten — darum steht der Beweis hier.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class LesewegImZugriffApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String MS = "/api/v1/messstellen";
    private static final String NIE = "00000000-0000-0000-0000-00000000dead";
    private static final String STICHTAG = "stichtag=2026-09-21";

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
    MessstelleService messstellen;

    @Autowired
    MessstelleRegisterService register;

    @Autowired
    ImportUebernahmeService uebernahme;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Werk Ahrenberg (ST-1), Werk Lindach (ST-2) und ein dritter Standort ohne jedes Objekt (ST-3). */
    private record Welt(UUID mandant, UUID unternehmen, UUID ahrenberg, UUID lindach, UUID dritter) {}

    /** Die Konten: Kundenadministrator, Bestandskonto (E12), Bearbeiter an ST-1, Bearbeiter nur an ST-3. */
    private record Konten(String ka, String bestand, String hier, String anderswo) {}

    private record Roh(int status, String body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        ZugriffContext.clear();
    }

    // ================================================================ Messstelle

    /**
     * Jede Leseroute zur Messstelle, per Kennung und per Kennzeichen, und die Liste: am Standort, in einem Gebäude
     * des Standorts, am anderen Standort, mit Ort „Unternehmen“ (MS-19, A1) und ohne Ort. Die Messstelle ohne Ort
     * (Entwurf) liest jedes Konto, das {@code messstelle.ansehen} irgendwo hat — wie die Schreibseite (Entscheid
     * firstmate 21.09.2026, Lesart A).
     */
    @Test
    void jedeLeserouteZeigtDieMessstelleNurImZugriff() throws Exception {
        Welt w = welt();
        Konten k = konten(w);
        UUID halle = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, "
                + "'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, w.mandant());
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2024-01-01')", w.mandant(), halle, w.ahrenberg());
        Map<String, UUID> ms = new LinkedHashMap<>();
        ms.put("MS-01", messstelle(w, "MS-01", "gemessen", "standort_id", w.ahrenberg()));
        ms.put("MS-10", messstelle(w, "MS-10", "gemessen", "ort_id", halle));
        ms.put("MS-16", messstelle(w, "MS-16", "gemessen", "standort_id", w.lindach()));
        ms.put("MS-19", messstelle(w, "MS-19", "berechnet", "unternehmen_id", w.unternehmen()));
        ms.put("MS-21", messstelle(w, "MS-21", "gemessen", null, null));
        Set<String> hierSieht = Set.of("MS-01", "MS-10", "MS-21");
        Set<String> anderswoSieht = Set.of("MS-21");

        List<String> kennungsRouten = List.of("", "/standort", "/quellen?" + STICHTAG, "/quellen/" + NIE,
                "/quellen/" + NIE + "/kadenz?" + STICHTAG, "/verteilung", "/prozesse", "/aenderungen", "/formel",
                "/wert", "/verlauf");
        List<String> kennzeichenRouten = List.of("/werte?raster=tag&von=2026-09-01&bis=2026-09-02",
                "/werte/versionen?raster=tag&von=2026-09-01&bis=2026-09-01");
        List<String> fehler = new ArrayList<>();
        for (Map.Entry<String, UUID> m : ms.entrySet()) {
            List<String[]> pfade = new ArrayList<>();
            kennungsRouten.forEach(r -> pfade.add(new String[] {MS + "/" + m.getValue() + r, MS + "/" + NIE + r}));
            kennzeichenRouten.forEach(r -> pfade.add(new String[] {MS + "/" + m.getKey() + r, MS + "/MS-99" + r}));
            for (String[] p : pfade) {
                vergleiche(w, k, m.getKey() + " " + p[0], p[0], p[1], hierSieht.contains(m.getKey()),
                        anderswoSieht.contains(m.getKey()), fehler);
            }
        }
        assertThat(fehler).isEmpty();

        // Die Liste zeigt genau, was die Einzelroute zeigt — beide Listen, ohne Hinweis auf die fehlenden.
        String liste = MS + "?" + STICHTAG;
        assertThat(roh(w, k.bestand(), liste)).isEqualTo(roh(w, k.ka(), liste)).isEqualTo(ohneKontext(w, liste));
        assertThat(kennzeichen(w, k.ka(), liste)).containsExactlyInAnyOrderElementsOf(ms.keySet());
        assertThat(kennzeichen(w, k.hier(), liste)).containsExactlyInAnyOrderElementsOf(hierSieht);
        assertThat(kennzeichen(w, k.anderswo(), liste)).containsExactlyInAnyOrderElementsOf(anderswoSieht);

        // Interne Leser (Bilanz, Formel, Kennzahl, Standort-Übersicht) bedienen keine Anfrage nach dieser Kennung.
        unterZugriffOhneSicht(w);
        assertThat(messstellen.eine(ms.get("MS-16")).kennzeichen()).isEqualTo("MS-16");
        assertThat(register.liste(Instant.parse("2026-09-21T00:00:00Z"),
                new MessstelleRegisterService.Filter(null, null, null, null, false)).messstellen())
                .extracting(x -> x.kennzeichen()).containsExactlyInAnyOrderElementsOf(ms.keySet());
    }

    // ================================================================ Vorlagen und Import-Protokoll

    /**
     * Die Vorlagen-Liste zeigt eine Vorlage, deren Bezüge alle im Zugriff liegen (AP-09 E12); das Import-Protokoll
     * lässt einen Import mit einem Ziel außerhalb weg, statt die ganze Liste mit 404 abzulehnen (F1).
     */
    @Test
    void vorlagenUndImportProtokollZeigenNurWasImZugriffLiegt() throws Exception {
        Welt w = welt();
        Konten k = konten(w);
        bezugsgroesse(w, "BZ-1", w.ahrenberg());
        bezugsgroesse(w, "BZ-2", w.lindach());
        String vorlageHier = vorlage(w, "ERP Ahrenberg", "BZ-1");
        String vorlageDort = vorlage(w, "ERP Lindach", "BZ-2");
        String importHier = importieren(w, "BZ-1");
        String importDort = importieren(w, "BZ-2");

        String vorlagen = "/api/v1/bezugsdaten/vorlagen";
        assertThat(roh(w, k.bestand(), vorlagen)).isEqualTo(roh(w, k.ka(), vorlagen))
                .isEqualTo(ohneKontext(w, vorlagen));
        assertThat(ids(w, k.ka(), vorlagen, "vorlagen", "vorlage_id")).containsExactlyInAnyOrder(vorlageHier,
                vorlageDort);
        assertThat(ids(w, k.hier(), vorlagen, "vorlagen", "vorlage_id")).containsExactly(vorlageHier);
        assertThat(ids(w, k.anderswo(), vorlagen, "vorlagen", "vorlage_id")).isEmpty();

        String importe = "/api/v1/bezugsdaten/importe";
        assertThat(roh(w, k.bestand(), importe)).isEqualTo(roh(w, k.ka(), importe))
                .isEqualTo(ohneKontext(w, importe));
        assertThat(ids(w, k.ka(), importe, "importe", "kennung")).containsExactlyInAnyOrder(importHier, importDort);
        assertThat(ids(w, k.hier(), importe, "importe", "kennung")).containsExactly(importHier);
        assertThat(ids(w, k.anderswo(), importe, "importe", "kennung")).isEmpty();
        // Die Einzelroute bleibt, wie sie war: außerhalb = unbekannte Kennung.
        assertThat(roh(w, k.hier(), importe + "/" + importDort)).isEqualTo(roh(w, k.hier(), importe + "/I-2026-9999"));

        // Der interne Leser (Übernahme, Detail ohne Kontext) liest weiter.
        TenantContext.set(w.mandant());
        assertThat(uebernahme.protokoll().importe()).hasSize(2);
    }

    // ================================================================ Folgepunkte aus PR 1003

    /**
     * Folgepunkt 2: {@code POST /bezugsdaten/importe/vorschau}. Eine Vorlage mit einem Bezug außerhalb ist wie eine
     * unbekannte {@code vorlage_id}; eine Bezugsgröße außerhalb ist als Ziel wie ein unbekanntes Kennzeichen
     * ({@code bezug_unbekannt}, ohne Kennung und ohne Stand). Die Übernahme rechnet mit derselben Sicht nach.
     */
    @Test
    void importVorschauKenntNurVorlagenUndBezugsgroessenImZugriff() throws Exception {
        Welt w = welt();
        Konten k = konten(w);
        bezugsgroesse(w, "BZ-1", w.ahrenberg());
        bezugsgroesse(w, "BZ-2", w.lindach());
        String vorlageDort = vorlage(w, "ERP Lindach", "BZ-2");
        importieren(w, "BZ-2");

        // Vorlage per Kennung: außerhalb = unbekannte Kennung, Status und Körper.
        Roh unbekannt = vorschau(w, k.hier(), null, NIE);
        assertThat(unbekannt.status()).as(unbekannt.body()).isEqualTo(404);
        assertThat(vorschau(w, k.hier(), null, vorlageDort)).isEqualTo(unbekannt);
        assertThat(vorschau(w, k.anderswo(), null, vorlageDort)).isEqualTo(vorschau(w, k.anderswo(), null, NIE));
        for (String sub : new String[] {k.ka(), k.bestand(), null}) {
            JsonNode v = MAPPER.readTree(ok(vorschau(w, sub, null, vorlageDort)).body());
            assertThat(v.at("/vorlage/name").asText()).as(String.valueOf(sub)).isEqualTo("ERP Lindach");
        }

        // Ziel per Kennzeichen: außerhalb = unbekanntes Kennzeichen, dieselben Zeilen (keine Kennung, kein Stand).
        JsonNode fremd = MAPPER.readTree(ok(vorschau(w, k.hier(), zuordnung("BZ-2"), null)).body());
        JsonNode nie = MAPPER.readTree(ok(vorschau(w, k.hier(), zuordnung("BZ-99"), null)).body());
        assertThat(fremd.path("zeilen")).isEqualTo(nie.path("zeilen"));
        assertThat(fremd.at("/zeilen/0/befunde").toString()).contains("\"bezug_unbekannt\"");
        assertThat(fremd.toString()).doesNotContain("312,4 kg").doesNotContain("\"bestand\":{");
        JsonNode voll = MAPPER.readTree(ok(vorschau(w, k.ka(), zuordnung("BZ-2"), null)).body());
        assertThat(voll.at("/zeilen/0/bezugsgroesse_id").isNull()).isFalse();
        assertThat(voll.at("/zeilen/0/bestand").isNull()).as("KA sieht den Stand").isFalse();
        for (String sub : new String[] {k.bestand(), null}) {
            assertThat(MAPPER.readTree(ok(vorschau(w, sub, zuordnung("BZ-2"), null)).body()).path("zeilen"))
                    .isEqualTo(voll.path("zeilen"));
        }
        // Am eigenen Standort bleibt alles, wie es war.
        JsonNode eigen = MAPPER.readTree(ok(vorschau(w, k.hier(), zuordnung("BZ-1"), null)).body());
        assertThat(eigen.at("/zeilen/0/bezugsgroesse").asText()).isEqualTo("BZ-1");
        assertThat(eigen.at("/zeilen/0/urteil").asText()).isEqualTo("neu");
    }

    /**
     * Folgepunkte 1, 3 und 4 an EINER Bühne: MS-01 an ST-1, MS-16 an ST-2, die berechnete MS-30 an ST-1 mit den
     * Eingängen MS-01 und MS-16; die Anlage AN-1 hängt an ST-1, MS-16 ist dort Hauptzähler, MS-01 sein Unterzähler
     * (eine Stellung prüft den Ort der Messstelle nicht — {@code MessstelleZuordnungService} kennt keine solche Regel).
     * Gemessen wird, ob der Bearbeiter an ST-1 das Kennzeichen MS-16 irgendwo liest.
     */
    @Test
    void registerVorschlagUndBilanzNennenKeineMessstelleAusserhalb() throws Exception {
        Welt w = welt();
        Konten k = konten(w);
        UUID ms01 = messstelle(w, "MS-01", "gemessen", "standort_id", w.ahrenberg());
        UUID ms16 = messstelle(w, "MS-16", "gemessen", "standort_id", w.lindach());
        UUID ms30 = messstelle(w, "MS-30", "berechnet", "standort_id", w.ahrenberg());
        UUID fassung = root.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, "
                + "formel_typ, herkunft, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'gewichtete_summe', "
                + "'anlage', 'sub-test', 'Test', 'kunde') RETURNING id", UUID.class, w.mandant(), ms30);
        int position = 0;
        for (UUID eingang : List.of(ms01, ms16)) {
            root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, "
                    + "eingang_art, quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, ?, ?, 'messstelle', ?, '+', "
                    + "1)", w.mandant(), ms30, fassung, position++, eingang);
        }
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Werk Ahrenberg – "
                + "Halle 1', '2024-01-01T00:00:00+01') RETURNING id", UUID.class, w.mandant());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2024-01-01')", w.mandant(), anlage, w.ahrenberg());
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, 'Hauptzähler', NULL, '2024-01-01')", w.mandant(), ms16, anlage);
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, 'Unterzähler', ?, '2024-01-01')", w.mandant(), ms01, anlage, ms16);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, created_at) "
                + "VALUES (?, ?, ?, 'Box Halle 1', 'claimed', '2024-01-01T00:00:00+01') RETURNING id", UUID.class,
                w.mandant(), anlage, "E-LESEWEG-" + w.mandant());
        UUID zaehler = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', "
                + "'Unterzähler Verwaltung', 'modbus-generic', ?, false, 'modbus_tcp', "
                + "'{\"ip\":\"10.11.0.30\",\"port\":502,\"unit_id\":1}'::jsonb, '2024-01-01T00:00:00+01') "
                + "RETURNING id", UUID.class, w.mandant(), anlage, box);
        for (String kanal : List.of("sunspec.model_203.totwhimp", "sunspec.model_203.w")) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), '2026.08.26.3', "
                    + "'test', 'pending_edge', 'energy_counter', 'fifteen_minute') ON CONFLICT DO NOTHING",
                    w.mandant(), anlage, box, zaehler, kanal);
        }

        Map<String, String> antworten = new LinkedHashMap<>();
        // (1) Register: die sichtbare berechnete MS-30 und ihre Routen.
        JsonNode liste = MAPPER.readTree(ok(w, k.hier(), MS + "?" + STICHTAG).body());
        for (JsonNode zeile : liste.path("register")) {
            if ("MS-30".equals(zeile.path("kennzeichen").asText())) {
                antworten.put("register MS-30 berechnung", zeile.path("berechnung").toString());
            }
        }
        for (String r : List.of("", "/formel", "/wert", "/verlauf")) {
            antworten.put("MS-30" + r, ok(w, k.hier(), MS + "/" + ms30 + r).body());
        }
        // (3) Vorschlag: fremder Standort = unbekannte Kennung; der eigene Standort.
        String vorschlag = "/api/v1/standorte/%s/messstellen-vorschlag";
        assertThat(roh(w, k.hier(), vorschlag.formatted(w.lindach())))
                .isEqualTo(unbekannt(w, k.hier(), vorschlag.formatted(NIE)));
        antworten.put("vorschlag ST-1", ok(w, k.hier(), vorschlag.formatted(w.ahrenberg())).body());
        // (4) Bilanz der sichtbaren Anlage.
        antworten.put("bilanz AN-1", ok(w, k.hier(), "/api/v1/sites/" + anlage + "/bilanz?periode=tag").body());

        // Wo der Bearbeiter an ST-1 MS-16 liest (Kennzeichen oder Kennung): genau die offenen Folgepunkte.
        assertThat(antworten).isNotEmpty().allSatisfy((fall, body) -> assertThat(body).as(fall).isNotEmpty());
        assertThat(antworten.entrySet().stream()
                .filter(e -> e.getValue().contains("MS-16") || e.getValue().contains(ms16.toString()))
                .map(Map.Entry::getKey).toList())
                .as("rot bei einem neuen UND bei einem geheilten Fall")
                .containsExactlyInAnyOrderElementsOf(FOLGEPUNKTE_OFFEN.keySet());

        // Lesart A (AP-03 R-A3/R-A6/R-A7): keine Zahl über MS-16, an ihrer Stelle der Hinweis ohne Namen und Anzahl.
        String hinweis = "umfasst Standorte außerhalb Ihres Zugriffs";
        JsonNode berechnung = MAPPER.readTree(antworten.get("register MS-30 berechnung"));
        assertThat(berechnung.path("zustand").asText()).isEqualTo("unvollstaendig");
        assertThat(berechnung.path("fehlend").toString()).isEqualTo("[\"MS-01\"]");
        assertThat(berechnung.path("text").asText()).endsWith("(fehlt: MS-01) · " + hinweis);
        JsonNode formel = MAPPER.readTree(antworten.get("MS-30/formel"));
        assertThat(formel.path("ausserhalb_zugriff").asText()).isEqualTo(hinweis);
        assertThat(formel.path("terme")).hasSize(1);
        assertThat(formel.at("/terme/0/position").asInt()).isZero();
        assertThat(formel.at("/terme/0/quell_messstelle_id").asText()).isEqualTo(ms01.toString());
        JsonNode wert = MAPPER.readTree(antworten.get("MS-30/wert"));
        assertThat(wert.path("wert").isNull()).isTrue();
        assertThat(wert.path("fehlende")).isEmpty();
        assertThat(wert.path("ausserhalb_zugriff").asText()).isEqualTo(hinweis);
        JsonNode verlauf = MAPPER.readTree(antworten.get("MS-30/verlauf"));
        assertThat(verlauf.path("punkte")).isEmpty();
        assertThat(verlauf.path("ausserhalb_zugriff").asText()).isEqualTo(hinweis);
        JsonNode bilanz = MAPPER.readTree(antworten.get("bilanz AN-1"));
        assertThat(bilanz.path("hauptzaehler")).isEmpty();
        assertThat(bilanz.path("ausserhalb_zugriff").asText()).isEqualTo(hinweis);
        JsonNode vorschlagHier = MAPPER.readTree(antworten.get("vorschlag ST-1"));
        assertThat(vorschlagHier.toString()).doesNotContain("\"unterzaehler_von\":{\"messstelle\":\"MS-");
        JsonNode ausgelassen = null;
        for (JsonNode a : vorschlagHier.path("ausgelassen")) {
            if ("ausserhalb_zugriff".equals(a.path("grund").asText())) {
                ausgelassen = a;
            }
        }
        assertThat(ausgelassen).as(vorschlagHier.toString()).isNotNull();
        assertThat(ausgelassen.path("zu").isNull()).isTrue();
        assertThat(ausgelassen.path("komponente").asText()).isEqualTo(zaehler.toString());
        assertThat(ausgelassen.path("text").asText()).contains(hinweis);

        // Unternehmensweit, Bestandskonto, ohne Kontext und ein Bearbeiter an ST-1 UND ST-2 sehen alles wie bisher —
        // untereinander Zeichen für Zeichen gleich, mit MS-16 und ohne den Hinweis.
        String beide = zuweisung(w, "sub-beide-", "bearbeiter", w.ahrenberg());
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) VALUES "
                + "(?, ?, 'bearbeiter', ?, '2024-01-01T00:00:00+01', 'Europe/Berlin')", w.mandant(), beide, w.lindach());
        for (String pfad : List.of(MS + "/" + ms30 + "/formel", MS + "/" + ms30 + "/wert",
                vorschlag.formatted(w.ahrenberg()), "/api/v1/sites/" + anlage + "/bilanz?periode=tag")) {
            Roh referenz = ok(w, k.ka(), pfad);
            assertThat(referenz.body()).as(pfad).doesNotContain(hinweis);
            assertThat(roh(w, k.bestand(), pfad)).as(pfad).isEqualTo(referenz);
            assertThat(roh(w, beide, pfad)).as(pfad).isEqualTo(referenz);
            assertThat(ohneKontext(w, pfad)).as(pfad).isEqualTo(referenz);
        }
        for (String sub : List.of(k.ka(), beide)) {
            for (JsonNode zeile : MAPPER.readTree(ok(w, sub, MS + "?" + STICHTAG).body()).path("register")) {
                if ("MS-30".equals(zeile.path("kennzeichen").asText())) {
                    assertThat(zeile.path("berechnung").toString()).as(sub)
                            .isEqualTo("{\"zustand\":\"unvollstaendig\",\"fehlend\":[\"MS-01\",\"MS-16\"],"
                                    + "\"seit\":null,\"text\":\"Unvollständig (fehlt: MS-01, MS-16)\"}");
                }
            }
        }
        assertThat(ok(w, k.ka(), "/api/v1/sites/" + anlage + "/bilanz?periode=tag").body()).contains("MS-16");
        assertThat(ok(w, k.ka(), MS + "/" + ms30 + "/formel").body()).contains(ms16.toString());

        // Der Schreibweg: die Zeile, wie die Unternehmenssicht sie zeigt (Unterzähler von MS-16), hängt die
        // Übernahme des Bearbeiters an ST-1 nicht still unter MS-16 — für ihn ist sie „geändert“.
        JsonNode zeile = null;
        for (JsonNode z : MAPPER.readTree(ok(w, k.ka(), vorschlag.formatted(w.ahrenberg())).body())
                .path("vorschlaege")) {
            if ("MS-16".equals(z.at("/unterzaehler_von/messstelle").asText())) {
                zeile = z;
            }
        }
        assertThat(zeile).as("die Unternehmenssicht schlägt den Unterzähler von MS-16 vor").isNotNull();
        var bestaetigt = MAPPER.createObjectNode();
        bestaetigt.put("komponente", zeile.path("komponente").asText());
        bestaetigt.put("kanal", zeile.at("/quelle/kanal").asText());
        bestaetigt.set("hauptgroesse", zeile.path("hauptgroesse"));
        bestaetigt.set("nebengroessen", zeile.path("nebengroessen"));
        bestaetigt.set("stellung", zeile.path("stellung"));
        bestaetigt.set("ab", zeile.path("ab"));
        var koerper = MAPPER.createObjectNode();
        koerper.putArray("vorschlaege").add(bestaetigt);
        Integer vorher = root.queryForObject("SELECT count(*) FROM messstelle WHERE tenant_id = ?", Integer.class,
                w.mandant());
        Roh uebernahme = roh(post(vorschlag.formatted(w.ahrenberg()) + "/uebernehmen").with(konto(w, k.hier()))
                .contentType("application/json").content(koerper.toString()));
        assertThat(uebernahme.status()).as(uebernahme.body()).isEqualTo(409);
        assertThat(uebernahme.body()).contains("vorschlag_geaendert").doesNotContain("MS-16");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle WHERE tenant_id = ?", Integer.class,
                w.mandant())).isEqualTo(vorher);
    }

    /**
     * Gemessen am 21.09.2026 (Bearbeiter nur an ST-1, MS-16 an ST-2): hier nennt eine sonst sichtbare Antwort die
     * fremde Messstelle. Entschieden ist AP-03 R-A3/R-A6/R-A7 (Lesart A, firstmate 21.09.2026): eine Zahl über einen
     * Eingang außerhalb fehlt ganz, der Hinweis „umfasst Standorte außerhalb Ihres Zugriffs“ nennt weder Namen noch
     * Werte. Gebaut in {@code vp-uems-zaun-eingaenge-ausserhalb} (Register, Formel/Wert/Verlauf, Vorschlag, Bilanz
     * über {@code RechtPruefung#alleLesbar}); die Liste ist leer und bewacht neue Funde — ein neuer Fall kommt hier
     * mit Grund hinein, bis er geheilt ist.
     */
    private static final Map<String, String> FOLGEPUNKTE_OFFEN = Map.of();

    // ================================================================ Gerüst

    /** Eine Route: KA = Bestandskonto = ohne Kontext; Bearbeiter hier/anderswo wie KA oder wie die unbekannte. */
    private void vergleiche(Welt w, Konten k, String fall, String pfad, String unbekannt, boolean hierSieht,
            boolean anderswoSieht, List<String> fehler) throws Exception {
        Roh voll = roh(w, k.ka(), pfad);
        if (voll.status() >= 500) {
            fehler.add(fall + ": Kundenadministrator " + voll);
        }
        if (!roh(w, k.bestand(), pfad).equals(voll) || !ohneKontext(w, pfad).equals(voll)) {
            fehler.add(fall + ": Bestandskonto oder ohne Kontext ≠ Kundenadministrator");
        }
        Roh h = roh(w, k.hier(), pfad);
        if (!h.equals(hierSieht ? voll : unbekannt(w, k.hier(), unbekannt))) {
            fehler.add(fall + ": Bearbeiter am Standort " + h);
        }
        Roh a = roh(w, k.anderswo(), pfad);
        if (!a.equals(anderswoSieht ? voll : unbekannt(w, k.anderswo(), unbekannt))) {
            fehler.add(fall + ": Bearbeiter nur anderswo " + a);
        }
    }

    private Roh unbekannt(Welt w, String sub, String pfad) throws Exception {
        Roh u = roh(w, sub, pfad);
        assertThat(u.status()).as(pfad + " " + u.body()).isEqualTo(404);
        return u;
    }

    private List<String> kennzeichen(Welt w, String sub, String pfad) throws Exception {
        JsonNode body = MAPPER.readTree(ok(w, sub, pfad).body());
        List<String> aus = new ArrayList<>();
        body.path("messstellen").forEach(x -> aus.add(x.path("kennzeichen").asText()));
        List<String> zeilen = new ArrayList<>();
        body.path("register").forEach(x -> zeilen.add(x.path("kennzeichen").asText()));
        assertThat(zeilen).as("register = messstellen").containsExactlyElementsOf(aus);
        return aus;
    }

    private List<String> ids(Welt w, String sub, String pfad, String feld, String id) throws Exception {
        List<String> aus = new ArrayList<>();
        MAPPER.readTree(ok(w, sub, pfad).body()).path(feld).forEach(x -> aus.add(x.path(id).asText()));
        return aus;
    }

    private Roh ok(Welt w, String sub, String pfad) throws Exception {
        Roh r = roh(w, sub, pfad);
        assertThat(r.status()).as(sub + " " + pfad + " " + r.body()).isEqualTo(200);
        return r;
    }

    /** Ein Kundenkonto wie aus Keycloak (Konverter setzt die Kontoart): der Zugriff-Kontext wird geladen. */
    private Roh roh(Welt w, String sub, String pfad) throws Exception {
        return roh(request(HttpMethod.GET, pfad).with(konto(w, sub)));
    }

    private static RequestPostProcessor konto(Welt w, String sub) {
        Map<String, Object> claims = Map.of("sub", sub, "preferred_username", sub, "tenant_id", w.mandant().toString(),
                "realm_access", Map.of("roles", List.of()));
        Jwt token = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return authentication(new KeycloakRealmRoleConverter().convert(token));
    }

    /** {@code POST /bezugsdaten/importe/vorschau} mit einer Zeile; {@code sub} {@code null} = ohne Zugriff-Kontext. */
    private Roh vorschau(Welt w, String sub, String zuordnung, String vorlageId) throws Exception {
        byte[] datei = ("Periode;Menge;Einheit\n" + YearMonth.now().minusMonths(2) + ";312,4;kg\n")
                .getBytes(StandardCharsets.UTF_8);
        var anfrage = multipart("/api/v1/bezugsdaten/importe/vorschau")
                .file(new MockMultipartFile("datei", "ERP.csv", "text/csv", datei));
        if (zuordnung != null) {
            anfrage.file(new MockMultipartFile("zuordnung", "", "application/json",
                    zuordnung.getBytes(StandardCharsets.UTF_8)));
        }
        if (vorlageId != null) {
            anfrage.file(new MockMultipartFile("vorlage_id", "", "text/plain", vorlageId.getBytes(StandardCharsets.UTF_8)));
        }
        return roh(anfrage.with(sub == null ? ohneKontext(w) : konto(w, sub)));
    }

    private static Roh ok(Roh r) {
        assertThat(r.status()).as(r.body()).isEqualTo(200);
        return r;
    }

    /** Derselbe Aufruf ohne Kontoart — ohne Zugriff-Kontext. */
    private Roh ohneKontext(Welt w, String pfad) throws Exception {
        return roh(request(HttpMethod.GET, pfad).with(ohneKontext(w)));
    }

    private static RequestPostProcessor ohneKontext(Welt w) {
        return jwt().jwt(j -> {
            j.subject("sub-ines-" + w.mandant());
            j.claim("preferred_username", "Ines Kaltenbach");
            j.claim("tenant_id", w.mandant().toString());
        });
    }

    private Roh roh(MockHttpServletRequestBuilder anfrage) throws Exception {
        MvcResult r = mvc.perform(anfrage).andReturn();
        return new Roh(r.getResponse().getStatus(), r.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private static void unterZugriffOhneSicht(Welt w) {
        TenantContext.set(w.mandant());
        ZugriffContext.set(new ZugriffContext.Zugriff("sub-ohne", RechteAbleitung.Konto.BENUTZER, w.mandant(),
                ZugriffContext.Zugang.KONTO, List.of(), Instant.now(), false));
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Leseweg #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        return new Welt(t, u, standort(t, u, "Werk Ahrenberg", "ST-1"), standort(t, u, "Werk Lindach", "ST-2"),
                standort(t, u, "Werk Ahrenberg Nord", "ST-3"));
    }

    private static UUID standort(UUID t, UUID u, String name, String kurz) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, name, kurz);
    }

    private static Konten konten(Welt w) {
        return new Konten(zuweisung(w, "sub-ka-", "kundenadministrator", null), "sub-ines-" + w.mandant(),
                zuweisung(w, "sub-hier-", "bearbeiter", w.ahrenberg()),
                zuweisung(w, "sub-anderswo-", "bearbeiter", w.dritter()));
    }

    /** Ein Konto mit einer wirksamen Zuweisung ({@code standort} {@code null} = unternehmensweit). */
    private static String zuweisung(Welt w, String praefix, String rolle, UUID standort) {
        String sub = praefix + w.mandant();
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", w.mandant(), sub, sub);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) VALUES "
                + "(?, ?, ?, ?, '2024-01-01T00:00:00+01', 'Europe/Berlin')", w.mandant(), sub, rolle, standort);
        return sub;
    }

    /** Eine Messstelle mit ihrem Ort ({@code spalte} {@code null} = noch ohne Ort, ein Entwurf). */
    private static UUID messstelle(Welt w, String kennzeichen, String art, String spalte, UUID ort) {
        UUID id = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, ?, 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, w.mandant(), kennzeichen, "Netzbezug " + kennzeichen, art);
        if (spalte != null) {
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, " + spalte + ", gueltig_ab) VALUES "
                    + "(?, ?, ?, '2024-01-01')", w.mandant(), id, ort);
        }
        return id;
    }

    private static void bezugsgroesse(Welt w, String kennzeichen, UUID standort) {
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, standort_id) VALUES (?, ?, 'Produktion', 'periodenwert', 'kg', 'monat', 'standort', ?)",
                w.mandant(), kennzeichen, standort);
    }

    private static String zuordnung(String bezugsgroesse) {
        return "{\"spalten\":{\"periode\":1,\"wert\":2,\"einheit\":3},\"deutung\":\"periode\",\"zahlformat\":\"de\","
                + "\"bezugsgroesse\":\"" + bezugsgroesse + "\"}";
    }

    private String vorlage(Welt w, String name, String bezugsgroesse) throws Exception {
        var anfrage = MAPPER.createObjectNode().put("name", name);
        anfrage.set("zuordnung", MAPPER.readTree(zuordnung(bezugsgroesse)));
        MvcResult r = mvc.perform(post("/api/v1/bezugsdaten/vorlagen").contentType("application/json")
                .content(anfrage.toString()).with(ohneKontext(w))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(201);
        return MAPPER.readTree(text).path("vorlage_id").asText();
    }

    /** Ein Import mit genau einer Zeile über den Schreibweg (Vorschau, dann Übernahme), ohne Zugriff-Kontext. */
    private String importieren(Welt w, String bezugsgroesse) throws Exception {
        byte[] datei = ("Periode;Menge;Einheit\n" + YearMonth.now().minusMonths(2) + ";312,4;kg\n")
                .getBytes(StandardCharsets.UTF_8);
        byte[] zuordnung = zuordnung(bezugsgroesse).getBytes(StandardCharsets.UTF_8);
        MvcResult v = mvc.perform(multipart("/api/v1/bezugsdaten/importe/vorschau")
                .file(new MockMultipartFile("datei", "ERP.csv", "text/csv", datei))
                .file(new MockMultipartFile("zuordnung", "", "application/json", zuordnung))
                .with(ohneKontext(w))).andReturn();
        String vorschau = v.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(v.getResponse().getStatus()).as(vorschau).isEqualTo(200);
        String bestaetigung = "{\"vorschau\":\"" + MAPPER.readTree(vorschau).at("/vorschau/kennung").asText()
                + "\",\"entscheidungen\":{}}";
        MvcResult i = mvc.perform(multipart("/api/v1/bezugsdaten/importe")
                .file(new MockMultipartFile("datei", "ERP.csv", "text/csv", datei))
                .file(new MockMultipartFile("zuordnung", "", "application/json", zuordnung))
                .file(new MockMultipartFile("bestaetigung", "", "application/json",
                        bestaetigung.getBytes(StandardCharsets.UTF_8)))
                .with(ohneKontext(w))).andReturn();
        String text = i.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(i.getResponse().getStatus()).as(text).isEqualTo(200);
        return MAPPER.readTree(text).path("kennung").asText();
    }
}
