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
        Map<String, Object> claims = Map.of("sub", sub, "preferred_username", sub, "tenant_id", w.mandant().toString(),
                "realm_access", Map.of("roles", List.of()));
        Jwt token = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return roh(request(HttpMethod.GET, pfad).with(authentication(new KeycloakRealmRoleConverter().convert(token))));
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
