package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
 * UEMS AP-17 IP-16a gegen die echte Kette: {@code GET /api/v1/kennzahlen/{id}/faktoren-vorschlag} schlägt für KZ-0005
 * (Netzbezug je m² — Halle 2, Geltung G-2) die statischen Faktoren aus der Struktur am Stichtag vor (R5, R1): die
 * Fläche von G-2 mit ihrem Wert am Stichtag (3 100 m² am 01.10.2026, 3 400 m² am 01.01.2027), den Standort ST-1, die
 * Prozesse und Kostenstellen der Messstellen in Halle 2. Ein Objekt ohne Gültigkeit am Stichtag fehlt, eine fehlende
 * Fläche ist nie 0; ein fremder Kundenbereich und ein Benutzer außerhalb des Zauns sehen nichts; nichts wird geschrieben.
 *
 * <p>Die Welt ist ein Ausschnitt des Referenzunternehmens 1.8 (Kunststoffwerk Ahrenberg): ST-1, G-2 mit den Bereichen
 * B-3/B-4, MS-10 (Netzbezug Halle 2, am Gebäude), MS-11 (Spritzguss, B-4, P-1, 4100), MS-12 (Montage, B-3, P-2, 4200 und
 * ab 01.01.2027 9010), dazu Werk Lindach (ST-2) mit G-5 und MS-18 (P-2), das nicht in den Vorschlag gehört.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class FaktorenVorschlagApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/kennzahlen";

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

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID unternehmen, UUID st1, UUID st2, UUID g2, UUID kz0005) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    /** Der Aufrufer von heute (Kundenbenutzer = Kundenadministrator unternehmensweit). */
    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ============================================================= R5/R1: Fläche G-2 am Stichtag

    @Test
    void kz0005SchlaegtFlaecheG2MitDemWertAmStichtagVor() throws Exception {
        Welt w = welt();

        JsonNode okt = vorschlag(w, w.kz0005(), "2026-10-01");
        assertThat(okt.path("kennzeichen").asText()).isEqualTo("KZ-0005");
        assertThat(okt.path("geltung_art").asText()).isEqualTo("gebaeude");
        assertThat(okt.path("stichtag").asText()).isEqualTo("2026-10-01");
        JsonNode f = eins(okt, "flaeche", "G-2");
        assertThat(f.path("wert").asInt()).isEqualTo(3100);
        assertThat(f.path("einheit").asText()).isEqualTo("m²");
        assertThat(f.path("gueltig_ab").asText()).isEqualTo("2026-10-01");
        assertThat(f.path("gueltig_bis").asText()).isEqualTo("2026-12-31");
        assertThat(f.path("satz").asText()).isEqualTo(
                "Fläche Halle 2 (G-2): 3 100 m² am 01.10.2026 · gültig 01.10.2026 bis 31.12.2026.");
        assertThat(okt.path("flaeche").path("wert").asInt()).isEqualTo(3100);
        assertThat(texte(okt.path("flaeche").path("objekte"))).containsExactly("G-2");
        assertThat(okt.path("flaeche").path("ohne_flaeche").size()).isZero();

        // Standort, Prozesse und Kostenstellen der Messstellen in Halle 2 — nie Lindach (MS-18, P-2 dort eingeschlossen).
        assertThat(kennungen(okt, "standort")).containsExactly("ST-1");
        assertThat(kennungen(okt, "prozess")).containsExactly("P-1", "P-2");
        assertThat(kennungen(okt, "kostenstelle")).containsExactly("4100", "4200");
        assertThat(arten(okt)).containsExactly("flaeche", "standort", "prozess", "prozess", "kostenstelle", "kostenstelle");
        JsonNode st = eins(okt, "standort", "ST-1");
        assertThat(st.path("wert").isNull()).isTrue();
        assertThat(st.path("einheit").isNull()).isTrue();
        assertThat(st.path("satz").asText()).endsWith("Verweis ohne Zahl.");

        JsonNode jan = vorschlag(w, w.kz0005(), "2027-01-01");
        JsonNode f2 = eins(jan, "flaeche", "G-2");
        assertThat(f2.path("wert").asInt()).isEqualTo(3400);
        assertThat(f2.path("gueltig_ab").asText()).isEqualTo("2027-01-01");
        assertThat(f2.path("gueltig_bis").isNull()).isTrue();
        assertThat(jan.path("flaeche").path("satz").asText())
                .isEqualTo("Fläche der Geltung am 01.01.2027: 3 400 m² (G-2) · gültig ab 01.01.2027.");
        // MS-12 wechselt zum 01.01.2027 von 4200 zu 9010 (gilt erst ab 01.01.2027) — der Stichtag liest die Verteilung
        // SEINES Tags: am 01.10.2026 4200 ohne 9010, am 01.01.2027 9010 ohne 4200.
        assertThat(kennungen(jan, "kostenstelle")).containsExactly("4100", "9010");
    }

    @Test
    void einStichtagVorDerGueltigkeitLaesstDasObjektWeg() throws Exception {
        Welt w = welt();
        JsonNode sep = vorschlag(w, w.kz0005(), "2026-09-15");
        assertThat(kennungen(sep, "flaeche")).isEmpty();
        assertThat(sep.path("flaeche").path("wert").isNull()).isTrue();
        assertThat(texte(sep.path("flaeche").path("ohne_flaeche"))).containsExactly("G-2");
        assertThat(sep.path("flaeche").path("satz").asText()).isEqualTo("Fläche der Geltung am 15.09.2026: keine Summe — "
                + "für G-2 ist an diesem Tag keine Fläche eingetragen.");
        // P-7 beginnt am 27.11.2026: vorher fehlt sie, danach steht sie da.
        assertThat(kennungen(sep, "prozess")).containsExactly("P-1", "P-2");
        assertThat(kennungen(vorschlag(w, w.kz0005(), "2026-11-27"), "prozess")).containsExactly("P-1", "P-2", "P-7");
    }

    @Test
    void eineStandortKennzahlSummiertIhreGebaeudeUndNenntJedesEinzeln() throws Exception {
        Welt w = welt();
        UUID g1 = gebaeude(w.mandant(), w.st1(), "Halle 1", "G-1");
        flaeche(w.mandant(), g1, 4200, "2026-10-01", null);
        UUID kz = anlegen(w, "KZ-0007", "standort", w.st1(), "MS-10", "BZ-6");
        JsonNode okt = vorschlag(w, kz, "2026-10-01");
        assertThat(kennungen(okt, "flaeche")).containsExactly("G-1", "G-2");
        assertThat(okt.path("flaeche").path("wert").asInt()).isEqualTo(7300);
        assertThat(okt.path("flaeche").path("gueltig_ab").asText()).isEqualTo("2026-10-01");
        assertThat(okt.path("flaeche").path("gueltig_bis").asText()).isEqualTo("2026-12-31");
        assertThat(kennungen(okt, "standort")).containsExactly("ST-1");
    }

    // ============================================================= Zaun, Anfrage, nichts geschrieben

    @Test
    void mandantBSiehtNichtsUndEinBenutzerAusserhalbDesZaunsAuchNicht() throws Exception {
        Welt a = welt();
        Welt b = welt();
        Antwort fremd = ruf(b, PFAD + "/" + a.kz0005() + "/faktoren-vorschlag?stichtag=2026-10-01");
        assertThat(fremd.status()).isEqualTo(404);
        assertThat(fremd.body().path("code").asText()).isEqualTo("nicht_gefunden");

        doReturn(person("PH", "Peter Hollerbach", RechteAbleitung.Rolle.BEARBEITER, a.st2())).when(aufrufer).benutzer(any());
        Antwort lindach = ruf(a, PFAD + "/" + a.kz0005() + "/faktoren-vorschlag?stichtag=2026-10-01");
        assertThat(lindach.status()).as(lindach.body().toString()).isEqualTo(404);
        assertThat(lindach.body().path("code").asText()).isEqualTo("nicht_gefunden");
    }

    @Test
    void dieAnfrageWirdStrengGelesenUndNichtsWirdGeschrieben() throws Exception {
        Welt w = welt();
        long vorher = zeilen(w);
        Antwort unbekannt = ruf(w, PFAD + "/" + w.kz0005() + "/faktoren-vorschlag?am=2026-10-01");
        assertThat(unbekannt.status()).isEqualTo(400);
        assertThat(unbekannt.body().path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(unbekannt.body().path("feld").asText()).isEqualTo("am");
        Antwort kaputt = ruf(w, PFAD + "/" + w.kz0005() + "/faktoren-vorschlag?stichtag=2026-13-01");
        assertThat(kaputt.status()).isEqualTo(400);
        assertThat(kaputt.body().path("feld").asText()).isEqualTo("stichtag");
        assertThat(ruf(w, PFAD + "/keine-id/faktoren-vorschlag").status()).isEqualTo(404);

        Antwort heute = ruf(w, PFAD + "/" + w.kz0005() + "/faktoren-vorschlag");
        assertThat(heute.status()).as(heute.body().toString()).isEqualTo(200);
        assertThat(heute.body().path("hinweis").asText()).contains("nichts ist gespeichert");
        vorschlag(w, w.kz0005(), "2027-01-01");
        assertThat(zeilen(w)).isEqualTo(vorher);
    }

    // ============================================================= Welt

    private Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Faktoren #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        UUID g2 = gebaeude(t, st1, "Halle 2", "G-2");
        UUID g5 = gebaeude(t, st2, "Montagehalle Lindach", "G-5");
        UUID b3 = bereich(t, g2, "Halle 2 Montage", "B-3");
        UUID b4 = bereich(t, g2, "Halle 2 Spritzguss", "B-4");
        flaeche(t, g2, 3100, "2026-10-01", "2026-12-31");
        flaeche(t, g2, 3400, "2027-01-01", null);
        flaeche(t, g5, 800, "2026-10-15", null);

        UUID p1 = prozess(t, u, "P-1", "Spritzguss", "2020-01-01");
        UUID p2 = prozess(t, u, "P-2", "Montage", "2020-01-01");
        UUID p7 = prozess(t, u, "P-7", "Gebäudetechnik Halle 1", "2026-11-27");
        UUID k4100 = kostenstelle(t, u, "4100", "Spritzguss", "2026-10-01");
        UUID k4200 = kostenstelle(t, u, "4200", "Montage", "2026-10-01");
        UUID k9010 = kostenstelle(t, u, "9010", "Druckluft", "2027-01-01");

        messstelle(t, "MS-10", "Netzbezug Halle 2", g2, null);
        UUID ms11 = messstelle(t, "MS-11", "Spritzguss SG07–SG10", b4, null);
        UUID ms12 = messstelle(t, "MS-12", "Montage Linie M1", b3, null);
        UUID ms13 = messstelle(t, "MS-13", "Lüftung Halle 2", g2, null);
        UUID ms18 = messstelle(t, "MS-18", "Montage Lindach", g5, null);
        // Jede Zuordnung liegt in den Tagen ihres Ziels (DB-Wächter uems_zuordnung_im_ziel): P-7 erst ab 27.11.2026.
        prozessZuordnen(t, ms11, p1, "2020-01-01");
        prozessZuordnen(t, ms12, p2, "2020-01-01");
        prozessZuordnen(t, ms13, p7, "2026-11-27");
        prozessZuordnen(t, ms18, p2, "2020-01-01");
        verteilen(t, ms11, k4100, "2026-10-01", null);
        verteilen(t, ms12, k4200, "2026-10-01", "2026-12-31");
        verteilen(t, ms12, k9010, "2027-01-01", null);
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-6', 'Gutteile Montage Halle 2', 'periodenwert', 'Stück', 'monat', 'gebaeude', ?)",
                t, g2);
        Welt ohne = new Welt(t, u, st1, st2, g2, null);
        UUID kz = anlegen(ohne, "KZ-0005", "gebaeude", g2, "MS-10", "BZ-6");
        return new Welt(t, u, st1, st2, g2, kz);
    }

    private static UUID standort(UUID t, UUID u, String name, String kurz) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, name, kurz);
    }

    private static UUID gebaeude(UUID t, UUID standort, String name, String kurz) {
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', ?, "
                + "?, 'aktiv') RETURNING id", UUID.class, t, name, kurz);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g, standort);
        return g;
    }

    private static UUID bereich(UUID t, UUID gebaeude, String name, String kurz) {
        UUID b = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'bereich', ?, "
                + "?, 'aktiv') RETURNING id", UUID.class, t, name, kurz);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_ort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, b, gebaeude);
        return b;
    }

    private static void flaeche(UUID t, UUID ort, int m2, String ab, String bis) {
        root.update("INSERT INTO flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab, gueltig_bis) "
                + "VALUES (?, ?, ?, ?::date, ?::date)", t, ort, m2, ab, bis);
    }

    private static UUID prozess(UUID t, UUID u, String kennzeichen, String name, String ab) {
        return root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, ?::date) RETURNING id", UUID.class, t, u, kennzeichen, name, ab);
    }

    private static UUID kostenstelle(UUID t, UUID u, String kennzeichen, String name, String ab) {
        return root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, ?::date) RETURNING id", UUID.class, t, u, kennzeichen, name, ab);
    }

    private static UUID messstelle(UUID t, String kennzeichen, String name, UUID ort, UUID standort) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') "
                + "RETURNING id", UUID.class, t, kennzeichen, name);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, '2020-01-01')", t, ms, ort, standort);
        return ms;
    }

    private static void prozessZuordnen(UUID t, UUID messstelle, UUID prozess, String ab) {
        root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?::date)", t, messstelle, prozess, ab);
    }

    private static void verteilen(UUID t, UUID messstelle, UUID kostenstelle, String ab, String bis) {
        root.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, anteil_prozent, "
                + "gueltig_ab, gueltig_bis) VALUES (?, ?, ?, 100, ?::date, ?::date)", t, messstelle, kostenstelle, ab, bis);
    }

    private UUID anlegen(Welt w, String kennzeichen, String geltungArt, UUID geltung, String zaehler, String nenner)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", "Netzbezug " + zaehler + " je " + nenner);
        m.put("rechenform", "quotient");
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        m.put("eingaenge", List.of(eingang("zaehler", "messstelle", zaehler), eingang("nenner", "bezugsgroesse", nenner)));
        Antwort a = ruf(w, HttpMethod.POST, PFAD, m);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return UUID.fromString(a.body().path("id").asText());
    }

    private static Map<String, Object> eingang(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    /** Alle Zeilen, die ein Schreibweg hier berühren könnte — der Vorschlag darf keine davon ändern. */
    private static long zeilen(Welt w) {
        long n = 0;
        for (String tabelle : List.of("kennzahl", "kennzahl_fassung", "kennzahl_eingang", "flaeche_gueltigkeit",
                "ort_zuordnung", "messstelle_prozess", "messstelle_verteilung", "prozess", "kostenstelle")) {
            n += root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, w.mandant());
        }
        return n;
    }

    private static RechteAbleitung.Benutzer person(String kennung, String name, RechteAbleitung.Rolle rolle, UUID standort) {
        return new RechteAbleitung.Benutzer(kennung, name, RechteAbleitung.Konto.BENUTZER, RechteAbleitung.KontoZustand.AKTIV,
                List.of(new RechteAbleitung.Zuweisung(rolle, List.of(standort.toString()), null, null, Instant.EPOCH, null,
                        null)));
    }

    // ============================================================= Lesen

    private JsonNode vorschlag(Welt w, UUID kennzahl, String stichtag) throws Exception {
        Antwort a = ruf(w, PFAD + "/" + kennzahl + "/faktoren-vorschlag?stichtag=" + stichtag);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    private static JsonNode eins(JsonNode vorschlag, String art, String kennung) {
        for (JsonNode f : vorschlag.path("faktoren")) {
            if (art.equals(f.path("art").asText()) && kennung.equals(f.path("kennung").asText())) {
                return f;
            }
        }
        throw new AssertionError(art + " " + kennung + " fehlt in " + vorschlag);
    }

    private static List<String> kennungen(JsonNode vorschlag, String art) {
        List<String> aus = new ArrayList<>();
        vorschlag.path("faktoren").forEach(f -> {
            if (art.equals(f.path("art").asText())) {
                aus.add(f.path("kennung").asText());
            }
        });
        return aus;
    }

    private static List<String> arten(JsonNode vorschlag) {
        List<String> aus = new ArrayList<>();
        vorschlag.path("faktoren").forEach(f -> aus.add(f.path("art").asText()));
        return aus;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    private Antwort ruf(Welt w, String pfad) throws Exception {
        return ruf(w, HttpMethod.GET, pfad, null);
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
