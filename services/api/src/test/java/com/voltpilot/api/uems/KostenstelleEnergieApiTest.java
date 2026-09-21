package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.ZugriffContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Kostenstellen-Sicht (UEMS AP-10 IP-11) gegen die echte Kette: Flyway-Schema, RLS, die Verteilung
 * ({@code messstelle_verteilung}, 100 % zur Commit-Zeit), die gespeicherten Tageswerte (gemessen, die Spur
 * berechnet aus {@link BerechnetePeriodenLauf}, Versionen der Kaskade) und die Route
 * {@code GET /api/v1/unternehmen/kostenstellen/{id}/energie}.
 *
 * <p>Die Welten sind Ausschnitte des Referenzunternehmens Ahrenberg: Halle 1 mit MS-03/MS-07 und den Kostenstellen
 * 4100/4200/9000/9010 (F12, F13), Werk Lindach mit MS-16/MS-17/MS-18 und dem Rest MS-22 (F14). Wo die Vorlage keine
 * Tageswerte nennt, sind sie Annahmen (wie in {@code verteilung-vectors.json}, {@code _abweichungen}).
 *
 * <p>F14 über die Speicherklassen: die Version 2 von MS-17 und MS-22 steht hier in {@code messreihe_periode_version}
 * genau so, wie die Korrektur-Kaskade sie schreibt (Anlass, Kennzeichen „korrigiert (Version 2)“) — die Kaskade selbst
 * mit der Meldung {@code bilanz_neu_berechnet} fährt {@code UemsKorrekturKaskadeTest}. Eine freigegebene Korrektur, die
 * einen VOLLSTÄNDIGEN Tag von 60 auf 58 kWh senkt, lässt sich aus Rohwerten nicht bauen (eine Nachlieferung macht
 * einen Tag nur vollständiger, und ein unvollständiger Eingang macht den Rest „keine Werte“).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KostenstelleEnergieApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String VOLL = "vollständig";
    private static final LocalDate JANUAR = LocalDate.parse("2027-01-01");
    private static final LocalDate F14_TAG = LocalDate.parse("2026-10-18");

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
    BerechnetePeriodenLauf lauf;

    @Autowired
    KostenstelleEnergieService kostenstellenSicht;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        ZugriffContext.clear();
    }

    // ============================================================================ Standort-Zaun (AP-03 R-A1)

    private record Roh(int status, String body) {}

    /**
     * Geltung Unternehmen (AP-03 R-A1, §4.9): die Bilanz einer Kostenstelle sieht nur eine unternehmensweite Rolle —
     * sie trägt Anteile von Messstellen jedes Standorts. Kundenadministrator, Bestandskonto (E12) und ein Aufruf ohne
     * Zugriff-Kontext (wie jeder andere Fall dieser Klasse) sehen sie byte-gleich; ein Bearbeiter am Standort ALLER ihrer
     * Messstellen bekommt Status und Körper einer unbekannten Kennung, auch bei einer ungültigen Periode (400 wie dort).
     * Der interne Leser (Bericht, Kaskade) liest weiter.
     */
    @Test
    void dieBilanzSiehtNurEineUnternehmensweiteRolle() throws Exception {
        Welt w = lindach("Werk Lindach (Zaun)", true);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                w.mandant(), w.unternehmen());
        for (UUID ms : w.messstellen().values()) {
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                    + "'2024-01-01')", w.mandant(), ms, standort);
        }
        String bestand = "sub-" + w.mandant();
        String ka = zuweisung(w, "sub-ka-", "kundenadministrator", null);
        String hier = zuweisung(w, "sub-hier-", "bearbeiter", standort);
        UUID k = w.kostenstellen().get("4200");
        String basis = "/api/v1/unternehmen/kostenstellen/";
        kostenstellenSicht.uhrStellen(Clock.fixed(Instant.parse("2026-10-31T23:15:00Z"), ZoneId.of("UTC")));
        try {
            for (String abfrage : List.of("/energie?periode=tag&am=" + F14_TAG, "/energie?periode=monat&am=" + F14_TAG,
                    "/energie?periode=woche&am=" + F14_TAG)) {
                String pfad = basis + k + abfrage;
                Roh voll = als(w, ka, pfad);
                assertThat(voll.status()).as(pfad + " " + voll.body()).isEqualTo(abfrage.contains("woche") ? 400 : 200);
                assertThat(als(w, bestand, pfad)).as(pfad + ": Bestandskonto").isEqualTo(voll);
                assertThat(ohneKontext(w, pfad)).as(pfad + ": ohne Kontext").isEqualTo(voll);
                Roh h = als(w, hier, pfad);
                Roh unbekannt = als(w, hier, basis + "00000000-0000-0000-0000-00000000dead" + abfrage);
                assertThat(h.status()).as(pfad + ": Bearbeiter " + h.body()).isEqualTo(abfrage.contains("woche") ? 400 : 404);
                assertThat(h).as(pfad + ": wie eine unbekannte Kennung").isEqualTo(unbekannt);
            }
            // Der interne Leser bedient keine Kundenanfrage nach der Kennung: er liest auch unter einem Zugriff, der die
            // Kostenstelle nicht sieht.
            TenantContext.set(w.mandant());
            ZugriffContext.set(new ZugriffContext.Zugriff("sub-ohne", RechteAbleitung.Konto.BENUTZER, w.mandant(),
                    ZugriffContext.Zugang.KONTO, List.of(), Instant.now(), false));
            assertThat(kostenstellenSicht.energie(k, "tag", F14_TAG, null).kostenstelle().kennzeichen()).isEqualTo("4200");
        } finally {
            kostenstellenSicht.uhrStellen(Clock.systemUTC());
        }
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

    /** Ein Kundenkonto wie aus Keycloak (der Konverter setzt die Kontoart): der Zugriff-Kontext wird geladen. */
    private Roh als(Welt w, String sub, String pfad) throws Exception {
        Map<String, Object> claims = Map.of("sub", sub, "preferred_username", sub, "tenant_id", w.mandant().toString(),
                "realm_access", Map.of("roles", List.of()));
        Jwt token = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return roh(mvc.perform(get(pfad).with(authentication(new KeycloakRealmRoleConverter().convert(token))))
                .andReturn());
    }

    /** Derselbe Aufruf ohne Kontoart — ohne Zugriff-Kontext, wie {@link #abrufen}. */
    private Roh ohneKontext(Welt w, String pfad) throws Exception {
        return roh(mvc.perform(get(pfad).with(jwt().jwt(j -> {
            j.subject("sub-" + w.mandant());
            j.claim("name", "Ines Test");
            j.claim("tenant_id", w.mandant().toString());
        }))).andReturn());
    }

    private static Roh roh(MvcResult r) throws Exception {
        return new Roh(r.getResponse().getStatus(), r.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    // ============================================================================ F13 — Tagesanteile (E12)

    /**
     * F13: MS-07 geht bis 14.01.2027 zu 70/30, ab 15.01. zu 60/40 an 4100/4200; 31 Tage zu je 500 kWh. Der Januar je
     * Kostenstelle ist die Summe der verteilten TAGE: 4100 = 14 × 350 + 17 × 300 = 10 000 kWh, 4200 = 5 500 kWh — nie
     * 9 300 kWh (60 % auf den ganzen Monat, Stichtag). Die Herkunft nennt die Fassung des letzten Tages und die Quelle.
     */
    @Test
    void f13ZehntausendUndFuenftausendfuenfhundertAusDenTagesanteilen() throws Exception {
        Welt w = welt("Werk Ahrenberg – Halle 1");
        messstelle(w, "MS-07", null, null);
        UUID k4100 = kostenstelle(w, "4100", "Spritzguss", "2026-10-01", null);
        UUID k4200 = kostenstelle(w, "4200", "Montage", "2026-10-01", null);
        verteilung(w, "MS-07", List.of(
                new Anteil("4100", "70", "2026-10-01", "2027-01-14"), new Anteil("4200", "30", "2026-10-01", "2027-01-14"),
                new Anteil("4100", "60", "2027-01-15", null), new Anteil("4200", "40", "2027-01-15", null)));
        for (int i = 0; i < 31; i++) {
            tageswert(w, "MS-07", JANUAR.plusDays(i), "500");
        }

        JsonNode a = energie(w, k4100, "periode=monat&am=2027-01-15");
        assertThat(a.path("von").asText()).isEqualTo("2027-01-01");
        assertThat(a.path("bis").asText()).isEqualTo("2027-01-31");
        assertThat(a.path("verteilt").path("menge").decimalValue()).isEqualByComparingTo("10000")
                .as("nie der Stichtag").isNotEqualByComparingTo("9300");
        assertThat(a.path("verteilt").path("zustand").asText()).isEqualTo(VOLL);
        JsonNode p = a.path("verteilt").path("posten").get(0);
        assertThat(p.path("messstelle").path("kennzeichen").asText()).isEqualTo("MS-07");
        assertThat(texte(p.path("kennzeichen"))).containsExactly("verteilt (70 % von MS-07)",
                "verteilt (60 % von MS-07)", "Verteilung geändert am 15.01.2027");
        assertThat(p.path("fassungen").toString()).isEqualTo("[1,2]");
        assertThat(p.path("tage")).hasSize(31);
        assertThat(p.path("tage").get(13).path("anteil_prozent").decimalValue()).isEqualByComparingTo("70");
        assertThat(p.path("tage").get(13).path("menge").decimalValue()).isEqualByComparingTo("350");
        assertThat(p.path("tage").get(14).path("anteil_prozent").decimalValue()).isEqualByComparingTo("60");
        assertThat(p.path("tage").get(14).path("menge").decimalValue()).isEqualByComparingTo("300");
        assertThat(a.path("gemessen").path("menge").isNull()).isTrue();
        assertThat(a.path("gemessen").path("grund").asText()).isEqualTo("keine_zuordnung");
        assertThat(a.path("summe").path("menge").decimalValue()).isEqualByComparingTo("10000");
        assertThat(a.path("nicht_verteilt").path("posten")).isEmpty();

        JsonNode satz = p.path("herkunft").path("satz");
        assertThat(p.path("herkunft").path("fehlt")).isEmpty();
        assertThat(satz.path("art").asText()).isEqualTo("verteilt");
        assertThat(satz.path("messstelle").asText()).isEqualTo("4100");
        assertThat(satz.path("periode").path("schluessel").asText()).isEqualTo("2027-01");
        assertThat(satz.path("verteilung").path("fassung").asInt()).isEqualTo(2);
        assertThat(satz.path("verteilung").path("anteil_prozent").asText()).isEqualTo("60");
        assertThat(satz.path("eingaenge").get(0).path("messstelle").asText()).isEqualTo("MS-07");
        assertThat(satz.path("eingaenge").get(0).path("menge").asText()).isEqualTo("15500");
        assertThat(satz.path("menge").asText()).isEqualTo("10000");

        JsonNode b = energie(w, k4200, "periode=monat&am=2027-01-01");
        assertThat(b.path("verteilt").path("menge").decimalValue()).isEqualByComparingTo("5500");
        assertThat(b.path("verteilt").path("menge").decimalValue()
                .add(a.path("verteilt").path("menge").decimalValue())).as("Summe der Kostenstellen = MS-07")
                .isEqualByComparingTo("15500");
    }

    // ============================================================================ Herkunft (AP-10 IP-12)

    /**
     * F10: MS-07 geht im Oktober 2026 zu 70 % an 4100 (15 900 kWh gemessen → 11 130 kWh). Gelesen am 01.11.2026 um
     * 00:15 (MEZ), trägt der verteilte Posten den Satz Zeichen für Zeichen wie die Prüfung {@code herkunft} von F10 in
     * {@code verteilung-vectors.json} — und die Tage der GEMESSENEN Quelle tragen keine Herkunft ({@code null}).
     */
    @Test
    void f10DieHerkunftDesVerteiltenPostensIstByteGleichZumVektor() throws Exception {
        Welt w = welt("Werk Ahrenberg – Halle 1 (F10)");
        messstelle(w, "MS-07", null, null);
        UUID k4100 = kostenstelle(w, "4100", "Spritzguss", "2026-10-01", null);
        kostenstelle(w, "4200", "Montage", "2026-10-01", null);
        verteilung(w, "MS-07", List.of(new Anteil("4100", "70", "2026-10-01", null),
                new Anteil("4200", "30", "2026-10-01", null)));
        LocalDate oktober = LocalDate.parse("2026-10-01");
        for (int i = 0; i < 31; i++) {
            tageswert(w, "MS-07", oktober.plusDays(i), i == 30 ? "900" : "500");
        }
        kostenstellenSicht.uhrStellen(Clock.fixed(Instant.parse("2026-10-31T23:15:00Z"), ZoneId.of("UTC")));
        try {
            JsonNode p = energie(w, k4100, "periode=monat&am=2026-10-15").path("verteilt").path("posten").get(0);
            assertThat(p.path("menge").decimalValue()).isEqualByComparingTo("11130");
            assertThat(BilanzwertHerkunftVektor.route(p.path("herkunft")))
                    .isEqualTo(BilanzwertHerkunftVektor.umschlag("verteilung-vectors.json", "F10"));
            assertThat(p.path("tage").get(0).has("herkunft")).isTrue();
            assertThat(p.path("tage").get(0).path("herkunft").isNull())
                    .as("eine gemessene Quelle hat keine Bilanzwert-Herkunft").isTrue();
        } finally {
            kostenstellenSicht.uhrStellen(Clock.systemUTC());
        }
    }

    /**
     * F14: der Tageswert des Rests MS-22 in Version 2 trägt an {@code nicht_verteilt.posten[].tage[]} seine Herkunft —
     * Zeichen für Zeichen wie die Prüfung {@code herkunft} von F14 in {@code bilanz-vectors.json}: die Eingänge IN
     * Version 2 aus {@code bilanzwert_eingang} (so schreibt sie die Kaskade, hier eingetragen), der Auslöser aus dem
     * Anlass der Version. Mit {@code version=1} steht derselbe Tag mit Version 1 und ohne Auslöser da.
     */
    @Test
    void f14DieHerkunftDesKorrigiertenRestsIstByteGleichZumVektor() throws Exception {
        Welt w = lindach("Werk Lindach (F14, Herkunft)", false);
        lauf.lauf(Instant.parse("2026-10-27T12:00:00Z"));
        versionZwei(w, "MS-17", false, "58", List.of("korrigiert (Version 2)"));
        versionZwei(w, "MS-22", true, "12", List.of("berechnet (Differenz)", "nicht zugeordnet", "korrigiert (Version 2)"));
        Instant kaskade = Instant.parse("2026-10-21T07:40:00Z");
        int position = 0;
        for (String[] e : List.of(new String[] {"MS-16", "zufluss", "100", "1", "[]"},
                new String[] {"MS-17", "zugeordnet", "58", "2", "[\"nachgeliefert\"]"},
                new String[] {"MS-18", "zugeordnet", "30", "1", "[]"})) {
            root.update("INSERT INTO bilanzwert_eingang (periode_beginn, tenant_id, messstelle_id, periode, version, "
                    + "position, eingang_messstelle_id, eingang_kennzeichen, rolle, anteil, menge, menge_zustand, fassung, "
                    + "abdeckung_prozent, eingang_version, kennzeichen, berechnet_am) VALUES (?, ?, ?, 'tag', 2, ?, ?, ?, ?, "
                    + "'gesamt', ?::numeric, 'vollständig', 'endgueltig', 100, ?, ?::jsonb, ?)",
                    Timestamp.from(beginn(F14_TAG)), w.mandant(), w.messstellen().get("MS-22"), position++,
                    w.messstellen().get(e[0]), e[0], e[1], e[2], Integer.parseInt(e[3]), e[4], Timestamp.from(kaskade));
        }

        JsonNode offen = energie(w, w.kostenstellen().get("4300"), "periode=tag&am=" + F14_TAG).path("nicht_verteilt");
        assertThat(kennzeichenDerPosten(offen)).containsExactly("MS-16", "MS-22");
        JsonNode ms22 = offen.path("posten").get(1);
        assertThat(ms22.path("herkunft").isNull()).as("nicht verteilt: keine Verteilung").isTrue();
        assertThat(BilanzwertHerkunftVektor.route(ms22.path("tage").get(0).path("herkunft")))
                .isEqualTo(BilanzwertHerkunftVektor.umschlag("bilanz-vectors.json", "F14"));
        assertThat(offen.path("posten").get(0).path("tage").get(0).path("herkunft").isNull())
                .as("MS-16 ist gemessen").isTrue();

        JsonNode alt = energie(w, w.kostenstellen().get("4300"), "periode=tag&am=" + F14_TAG + "&version=1")
                .path("nicht_verteilt").path("posten").get(1).path("tage").get(0).path("herkunft");
        assertThat(alt.path("fehlt")).isEmpty();
        assertThat(alt.path("satz").path("version").asInt()).isEqualTo(1);
        assertThat(alt.path("satz").path("ausloeser").isNull()).isTrue();
        assertThat(alt.path("satz").path("menge").asText()).isEqualTo("10");
        assertThat(alt.path("satz").path("eingaenge").get(1).path("menge").asText()).isEqualTo("60");
        assertThat(alt.path("satz").path("berechnet_am").asText()).as("der Lauf").isEqualTo("2026-10-27T13:00:00+01:00");
    }

    // ============================================================================ nicht verteilt

    /**
     * <b>Nicht verteilt verschwindet nie und wird nie aufgeteilt.</b> F12: 9000 endet am 31.12.2026, MS-03 hat im Januar
     * keine Zeile; MS-07 geht erst ab 10.01. an 4100; MS-16 (Hauptzähler) hat nie eine Kostenstelle. Die Sicht von 9010
     * hat KEINE Menge, die von 4100 nur die 22 verteilten Tage von MS-07 — und BEIDE nennen denselben Block „nicht
     * verteilt“ mit allen drei Messstellen, ohne Anteil, ohne dass er in eine Summe eingeht. Die Tage von MS-07 gehen
     * genau einmal auf: 22 × 500 an 4100 plus 9 × 500 nicht verteilt = 31 × 500.
     */
    @Test
    void nichtVerteiltVerschwindetNieUndWirdNieAufgeteilt() throws Exception {
        Welt w = welt("Werk Ahrenberg – Halle 1 (F12)");
        messstelle(w, "MS-03", null, null);
        messstelle(w, "MS-07", null, null);
        messstelle(w, "MS-16", "Hauptzähler", null);
        kostenstelle(w, "9000", "Infrastruktur (Druckluft, Kühlung, PV)", "2026-10-01", "2026-12-31");
        UUID k9010 = kostenstelle(w, "9010", "Druckluft", "2027-01-01", null);
        UUID k4100 = kostenstelle(w, "4100", "Spritzguss", "2026-10-01", null);
        verteilung(w, "MS-03", List.of(new Anteil("9000", "100", "2026-10-01", "2026-12-31")));
        verteilung(w, "MS-07", List.of(new Anteil("4100", "100", "2027-01-10", null)));
        for (int i = 0; i < 31; i++) {
            tageswert(w, "MS-03", JANUAR.plusDays(i), "480");
            tageswert(w, "MS-07", JANUAR.plusDays(i), "500");
            tageswert(w, "MS-16", JANUAR.plusDays(i), "1000");
        }

        JsonNode druckluft = energie(w, k9010, "periode=monat&am=2027-01-20");
        for (String h : List.of("gemessen", "verteilt", "berechnet", "summe")) {
            assertThat(druckluft.path(h).path("menge").isNull()).as(h + ": keine Menge, nie 0").isTrue();
            assertThat(druckluft.path(h).path("grund").asText()).as(h).isEqualTo("keine_zuordnung");
        }
        JsonNode offen = druckluft.path("nicht_verteilt");
        assertThat(offen.path("menge").decimalValue()).isEqualByComparingTo("50380");
        assertThat(kennzeichenDerPosten(offen)).containsExactly("MS-03", "MS-07", "MS-16");
        JsonNode ms03 = offen.path("posten").get(0);
        assertThat(ms03.path("menge").decimalValue()).as("nie still auf 9010").isEqualByComparingTo("14880");
        assertThat(texte(ms03.path("kennzeichen"))).containsExactly("nicht verteilt");
        assertThat(ms03.path("herkunft").isNull()).isTrue();
        JsonNode ms07 = offen.path("posten").get(1);
        assertThat(ms07.path("menge").decimalValue()).isEqualByComparingTo("4500");
        assertThat(ms07.path("tage")).hasSize(9);
        ms07.path("tage").forEach(t -> assertThat(t.path("anteil_prozent").isNull()).as("nie aufgeteilt").isTrue());

        JsonNode spritzguss = energie(w, k4100, "periode=monat&am=2027-01-20");
        assertThat(spritzguss.path("gemessen").path("menge").decimalValue()).isEqualByComparingTo("11000");
        assertThat(spritzguss.path("summe").path("menge").decimalValue())
                .as("nicht verteilt zählt in der Summe der Kostenstelle nie mit").isEqualByComparingTo("11000");
        assertThat(spritzguss.path("nicht_verteilt")).as("dieselbe Wahrheit in jeder Kostenstellen-Sicht")
                .isEqualTo(offen);
        assertThat(spritzguss.path("gemessen").path("menge").decimalValue()
                .add(ms07.path("menge").decimalValue())).as("MS-07 geht genau einmal auf").isEqualByComparingTo("15500");
    }

    /**
     * <b>{@code null} ist nie 0.</b> Eine Kostenstelle ohne Zuordnung hat keine Menge (Grund {@code keine_zuordnung},
     * leere Summen) — im JSON steht {@code null}, keine 0. Ein zugeordneter Tag ohne Werte ist „keine Werte“ mit
     * Grund {@code quelle_keine_werte}, ebenfalls ohne Zahl.
     */
    @Test
    void eineKostenstelleOhneZuordnungLiefertNullNichtNull() throws Exception {
        Welt w = welt("Werk Lindach (ohne Zuordnung)");
        messstelle(w, "MS-16", "Hauptzähler", null);
        messstelle(w, "MS-18", "Unterzähler", "MS-16");
        UUID k4300 = kostenstelle(w, "4300", "Logistik", "2026-10-01", null);
        UUID k4200 = kostenstelle(w, "4200", "Montage", "2026-10-01", null);
        verteilung(w, "MS-18", List.of(new Anteil("4200", "100", "2026-10-15", null)));
        tageswert(w, "MS-16", F14_TAG, "100");

        MvcResult roh = abrufen(w, k4300, "periode=tag&am=" + F14_TAG);
        String text = roh.getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode logistik = MAPPER.readTree(text);
        for (String h : List.of("gemessen", "verteilt", "berechnet", "summe")) {
            assertThat(logistik.path(h).path("menge").isNull()).as(h).isTrue();
            assertThat(logistik.path(h).path("summen")).as(h).isEmpty();
            assertThat(logistik.path(h).path("grund").asText()).isEqualTo("keine_zuordnung");
        }
        assertThat(text).contains("\"summe\":{\"menge\":null").doesNotContain("\"menge\":0");

        JsonNode montage = energie(w, k4200, "periode=tag&am=" + F14_TAG);
        JsonNode p = montage.path("gemessen").path("posten").get(0);
        assertThat(p.path("messstelle").path("kennzeichen").asText()).isEqualTo("MS-18");
        assertThat(p.path("menge").isNull()).isTrue();
        assertThat(p.path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(p.path("tage").get(0).path("grund").asText())
                .as("ohne Rohwert sagt das Lese-Modell „keine Werte“ (0 von erwartet)").isEqualTo("quelle_keine_werte");
        assertThat(montage.path("gemessen").path("menge").isNull()).as("zugeordnet, aber ohne Wert: keine Zahl").isTrue();
        assertThat(montage.path("gemessen").path("zustand").asText()).isEqualTo("keine Werte");
    }

    // ============================================================================ F14 — Version 2, Version 1 lesbar

    /**
     * F14: MS-17 wird korrigiert (60 → 58 kWh), der Rest MS-22 wird Version 2 = 12 kWh. Die Sicht von 4300 zeigt MS-17
     * mit 58 kWh „korrigiert (Version 2)“ und daneben „nicht verteilt“ MS-16 100 kWh und MS-22 12 kWh (Version 2) —
     * mit {@code version=1} dieselbe Sicht mit 60 und 10 kWh: die damalige Zahl bleibt auffindbar. In einer zweiten Welt
     * geht MS-22 an 4200 (Annahme): dort steht er unter „berechnet“, ebenfalls 12 kWh in Version 2 und 10 kWh in
     * Version 1.
     */
    @Test
    void f14VersionZweiIstZwoelfUndVersionEinsBleibtLesbar() throws Exception {
        Welt a = lindach("Werk Lindach (F14)", false);
        Welt b = lindach("Werk Lindach (F14, Rest an 4200)", true);
        lauf.lauf(Instant.parse("2026-10-27T12:00:00Z"));
        for (Welt w : List.of(a, b)) {
            assertThat(root.queryForObject("SELECT menge FROM messreihe_tag WHERE tenant_id = ? AND messstelle_id = ? "
                    + "AND tag = ?", BigDecimal.class, w.mandant(), w.messstellen().get("MS-22"), F14_TAG))
                    .as("Version 1 des Rests aus dem Lauf").isEqualByComparingTo("10");
            // So schreibt die Kaskade Version 2: MS-17 als Reihe, MS-22 als berechnete Messstelle.
            versionZwei(w, "MS-17", false, "58", List.of("korrigiert (Version 2)"));
            versionZwei(w, "MS-22", true, "12",
                    List.of("berechnet (Differenz)", "nicht zugeordnet", "korrigiert (Version 2)"));
        }

        JsonNode neu = energie(a, a.kostenstellen().get("4300"), "periode=tag&am=" + F14_TAG);
        JsonNode ms17 = neu.path("gemessen").path("posten").get(0);
        assertThat(ms17.path("menge").decimalValue()).isEqualByComparingTo("58");
        assertThat(ms17.path("version").asInt()).isEqualTo(2);
        assertThat(texte(ms17.path("kennzeichen"))).containsExactly("verteilt (100 % von MS-17)", "korrigiert (Version 2)");
        JsonNode satz = ms17.path("herkunft").path("satz");
        assertThat(ms17.path("herkunft").path("fehlt")).isEmpty();
        assertThat(satz.path("version").asInt()).isEqualTo(2);
        assertThat(satz.path("ausloeser").asText()).as("dieselbe Form wie F14 (AP-10 IP-12)")
                .isEqualTo("correction MS-17 2026-10-18 Version 2");
        assertThat(satz.path("eingaenge").get(0).path("version").asInt()).isEqualTo(2);
        JsonNode offen = neu.path("nicht_verteilt");
        assertThat(kennzeichenDerPosten(offen)).containsExactly("MS-16", "MS-22");
        assertThat(offen.path("posten").get(1).path("menge").decimalValue()).as("v2 = 12").isEqualByComparingTo("12");
        assertThat(offen.path("posten").get(1).path("version").asInt()).isEqualTo(2);
        assertThat(offen.path("menge").decimalValue()).isEqualByComparingTo("112");

        JsonNode alt = energie(a, a.kostenstellen().get("4300"), "periode=tag&am=" + F14_TAG + "&version=1");
        assertThat(alt.path("version").asInt()).isEqualTo(1);
        assertThat(alt.path("gemessen").path("posten").get(0).path("menge").decimalValue()).isEqualByComparingTo("60");
        assertThat(texte(alt.path("gemessen").path("posten").get(0).path("kennzeichen")))
                .containsExactly("verteilt (100 % von MS-17)");
        assertThat(alt.path("nicht_verteilt").path("posten").get(1).path("menge").decimalValue())
                .as("v1 lesbar").isEqualByComparingTo("10");
        assertThat(alt.path("nicht_verteilt").path("menge").decimalValue()).isEqualByComparingTo("110");
        JsonNode zwei = energie(a, a.kostenstellen().get("4300"), "periode=tag&am=" + F14_TAG + "&version=2");
        assertThat(zwei.path("gemessen").path("menge").decimalValue()).as("Version 2 ausdrücklich = die neueste")
                .isEqualByComparingTo("58");
        assertThat(zwei.path("nicht_verteilt").path("menge").decimalValue()).isEqualByComparingTo("112");

        JsonNode montage = energie(b, b.kostenstellen().get("4200"), "periode=tag&am=" + F14_TAG);
        JsonNode rest = montage.path("berechnet").path("posten").get(0);
        assertThat(rest.path("messstelle").path("kennzeichen").asText()).isEqualTo("MS-22");
        assertThat(rest.path("menge").decimalValue()).isEqualByComparingTo("12");
        assertThat(texte(rest.path("kennzeichen"))).containsExactly("verteilt (100 % von MS-22)",
                "berechnet (Differenz)", "nicht zugeordnet", "korrigiert (Version 2)");
        assertThat(montage.path("gemessen").path("menge").decimalValue()).isEqualByComparingTo("30");
        assertThat(montage.path("summe").path("menge").decimalValue()).isEqualByComparingTo("42");
        JsonNode montageAlt = energie(b, b.kostenstellen().get("4200"), "periode=tag&am=" + F14_TAG + "&version=1");
        assertThat(montageAlt.path("berechnet").path("menge").decimalValue()).isEqualByComparingTo("10");
        assertThat(montageAlt.path("summe").path("menge").decimalValue()).isEqualByComparingTo("40");

        MvcResult falsch = abrufen(a, a.kostenstellen().get("4300"), "periode=tag&am=" + F14_TAG + "&version=0");
        assertThat(falsch.getResponse().getStatus()).isEqualTo(400);
        JsonNode fehler = MAPPER.readTree(falsch.getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertThat(fehler.path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(fehler.path("feld").asText()).isEqualTo("version");
    }

    // ============================================================================ Mandantenzaun

    /**
     * Eine Kostenstelle eines anderen Kundenbereichs ist nicht zu finden (404, nie 403), und „nicht verteilt“ nennt nur
     * Messstellen des eigenen Kundenbereichs — auch wenn der andere dasselbe Kennzeichen trägt.
     */
    @Test
    void derMandantenzaunHaelt() throws Exception {
        Welt x = welt("Werk X");
        Welt y = welt("Werk Y");
        messstelle(x, "MS-16", "Hauptzähler", null);
        messstelle(y, "MS-16", "Hauptzähler", null);
        messstelle(y, "MS-99", "Hauptzähler", null);
        UUID fremd = kostenstelle(x, "4300", "Logistik", "2026-10-01", null);
        UUID eigen = kostenstelle(y, "4300", "Logistik", "2026-10-01", null);
        tageswert(x, "MS-16", F14_TAG, "100");
        tageswert(y, "MS-99", F14_TAG, "7");

        MvcResult r = abrufen(y, fremd, "periode=tag&am=" + F14_TAG);
        assertThat(r.getResponse().getStatus()).isEqualTo(404);
        JsonNode sicht = energie(y, eigen, "periode=tag&am=" + F14_TAG);
        assertThat(kennzeichenDerPosten(sicht.path("nicht_verteilt"))).containsExactly("MS-99");
        assertThat(sicht.path("nicht_verteilt").path("menge").decimalValue()).isEqualByComparingTo("7");
    }

    // ============================================================================ Doppelzählung (Captain 14.09.2026)

    /**
     * <b>Die Zahlen sind vorher und nachher zeichengleich.</b> Die Warnung vor doppelter Zählung ändert keine Zahl: jede
     * Antwort der Sicht ist bis zum neuen, letzten Feld {@code doppelzaehlung} Zeichen für Zeichen die Antwort, die der
     * Stand VOR der Warnung (uems cf9b8bb7) auf dieselbe Welt gab ({@code uems/doppelzaehlung-vorher/}, Kennungen als
     * {@code <id>}) — der Tag, der Monat und die Welt, in der MS-20 vollständig ist und die Summe 5 650 kWh MS-06 und MS-11
     * wirklich doppelt zählt. Und der Abruf schreibt nichts (Bestandsschutz-Vergleich über jede Tabelle).
     */
    @Test
    void dieZahlenSindZeichengleich() throws Exception {
        Welt w = spritzguss("Werk Ahrenberg – Spritzguss (zeichengleich)", true);
        Welt ohne = spritzguss("Werk Ahrenberg – Spritzguss (ohne Anteil MS-07)", false);
        kostenstellenSicht.uhrStellen(Clock.fixed(Instant.parse("2026-10-31T23:15:00Z"), ZoneId.of("UTC")));
        try {
            Map<String, String> vorDemAbruf = Bestandsschutz.fingerabdruck(root, List.of());
            String tag = roh(w, w.kostenstellen().get("4100"), "periode=tag&am=2026-10-16");
            String monat = roh(w, w.kostenstellen().get("4100"), "periode=monat&am=2026-10-15");
            String doppelt = roh(ohne, ohne.kostenstellen().get("4100"), "periode=tag&am=2026-10-16");
            assertThat(Bestandsschutz.abweichungen(vorDemAbruf, Bestandsschutz.fingerabdruck(root, List.of())))
                    .as("die Sicht schreibt nichts").isEmpty();

            assertThat(ohneWarnung(tag)).as("Tag").isEqualTo(vorher("4100-tag.json"));
            assertThat(ohneWarnung(monat)).as("Monat").isEqualTo(vorher("4100-monat.json"));
            assertThat(ohneWarnung(doppelt)).as("MS-20 vollständig").isEqualTo(vorher("4100-tag-ohne-anteil-ms07.json"));
            JsonNode sicht = MAPPER.readTree(doppelt);
            assertThat(sicht.path("summe").path("menge").decimalValue()).as("die doppelte Summe bleibt stehen")
                    .isEqualByComparingTo("5650");
            assertThat(saetze(sicht)).containsExactly("MS-06 ist bereits in MS-20 enthalten",
                    "MS-11 ist bereits in MS-20 enthalten");
        } finally {
            kostenstellenSicht.uhrStellen(Clock.systemUTC());
        }
    }

    /**
     * Der Referenzfall: MS-20 (= MS-06 + MS-11 + Anteil 4100 von MS-07) geht zu 100 % an 4100, MS-06, MS-11 und MS-07
     * (70 %) auch — die Sicht nennt alle drei als bereits in MS-20 enthalten, ganz, an jedem Tag des Oktobers, mit dem Satz
     * aus dem Vertrag; MS-08 steht in keiner Formel und wird nicht genannt. Der Anteil 4100 von MS-07 ist genau der Posten
     * MS-07 an 4100 — auch wenn MS-20 ihn heute noch ohne Menge führt, ist er enthalten. 4200 hat keine Überdeckung.
     */
    @Test
    void derReferenzfallWarntUndEineSaubereKostenstelleNicht() throws Exception {
        Welt w = spritzguss("Werk Ahrenberg – Spritzguss (Referenzfall)", true);
        JsonNode sicht = energie(w, w.kostenstellen().get("4100"), "periode=monat&am=2026-10-15");
        JsonNode enthalten = sicht.path("doppelzaehlung").path("enthalten");
        assertThat(saetze(sicht)).containsExactly("MS-06 ist bereits in MS-20 enthalten",
                "MS-07 ist bereits in MS-20 enthalten", "MS-11 ist bereits in MS-20 enthalten");
        for (JsonNode e : enthalten) {
            assertThat(e.path("summe").asText()).isEqualTo("MS-20");
            assertThat(e.path("umfang").asText()).isEqualTo("ganz");
            assertThat(texte(e.path("kette"))).containsExactly("MS-20", e.path("teil").asText());
            assertThat(e.path("zeitraeume").toString()).isEqualTo("[{\"von\":\"2026-10-01\",\"bis\":\"2026-10-31\"}]");
        }
        assertThat(sicht.path("doppelzaehlung").path("nicht_pruefbar")).isEmpty();
        assertThat(kennzeichenDerPosten(sicht.path("berechnet"))).as("die Summe bleibt ein Posten").containsExactly("MS-20");
        assertThat(kennzeichenDerPosten(sicht.path("gemessen"))).as("die Teile bleiben Posten")
                .containsExactly("MS-06", "MS-08", "MS-11");

        JsonNode sauber = energie(w, w.kostenstellen().get("4200"), "periode=monat&am=2026-10-15");
        assertThat(kennzeichenDerPosten(sauber.path("verteilt"))).containsExactly("MS-07");
        assertThat(sauber.path("doppelzaehlung").toString()).isEqualTo("{\"enthalten\":[],\"nicht_pruefbar\":[]}");
    }

    /**
     * Der Mandantenzaun: die Formeln und Verteilungen eines fremden Kundenbereichs erzeugen keine Warnung — Werk Y hat
     * dieselben Kennzeichen an 4100, aber MS-20 ist dort gemessen und hat keine Formel.
     */
    @Test
    void dieWarnungHaeltDenMandantenzaun() throws Exception {
        spritzguss("Werk X – Spritzguss (fremd)", true);
        Welt y = welt("Werk Y – Spritzguss");
        for (String ms : List.of("MS-06", "MS-11", "MS-20")) {
            messstelle(y, ms, null, null);
        }
        kostenstelle(y, "4100", "Spritzguss", "2026-10-01", null);
        for (String ms : List.of("MS-06", "MS-11", "MS-20")) {
            verteilung(y, ms, List.of(new Anteil("4100", "100", "2026-10-01", null)));
            tageswert(y, ms, LocalDate.parse("2026-10-16"), "100");
        }
        JsonNode sicht = energie(y, y.kostenstellen().get("4100"), "periode=tag&am=2026-10-16");
        assertThat(kennzeichenDerPosten(sicht.path("gemessen"))).containsExactly("MS-06", "MS-11", "MS-20");
        assertThat(sicht.path("doppelzaehlung").toString()).isEqualTo("{\"enthalten\":[],\"nicht_pruefbar\":[]}");
    }

    /**
     * Kostenstelle 4100 der Referenzdatei im Oktober 2026: MS-06, MS-08, MS-11 zu 100 %, MS-07 zu 70 % (30 % an 4200) und
     * die Prozess-Summe MS-20 = MS-06 + MS-11 + Anteil 4100 von MS-07 zu 100 % — drei Tage mit Werten, MS-20 vom Lauf.
     */
    private Welt spritzguss(String name, boolean anteilVonMs07) {
        Welt w = welt(name);
        for (String ms : List.of("MS-06", "MS-07", "MS-08", "MS-11")) {
            messstelle(w, ms, null, null);
        }
        kostenstelle(w, "4100", "Spritzguss", "2026-10-01", null);
        kostenstelle(w, "4200", "Montage", "2026-10-01", null);
        List<String[]> terme = new ArrayList<>(List.of(new String[] {"messstelle", "MS-06", null},
                new String[] {"messstelle", "MS-11", null}));
        if (anteilVonMs07) {
            terme.add(new String[] {"verteilung", "MS-07", "4100"});
        }
        summe(w, "MS-20", terme);
        verteilung(w, "MS-06", List.of(new Anteil("4100", "100", "2026-10-01", null)));
        verteilung(w, "MS-07", List.of(new Anteil("4100", "70", "2026-10-01", null),
                new Anteil("4200", "30", "2026-10-01", null)));
        verteilung(w, "MS-08", List.of(new Anteil("4100", "100", "2026-10-01", null)));
        verteilung(w, "MS-11", List.of(new Anteil("4100", "100", "2026-10-01", null)));
        verteilung(w, "MS-20", List.of(new Anteil("4100", "100", "2026-10-01", null)));
        LocalDate tag = LocalDate.parse("2026-10-15");
        for (int i = 0; i < 3; i++) {
            tageswert(w, "MS-06", tag.plusDays(i), "1800");
            tageswert(w, "MS-07", tag.plusDays(i), "500");
            tageswert(w, "MS-08", tag.plusDays(i), "300");
            tageswert(w, "MS-11", tag.plusDays(i), "700");
        }
        lauf.lauf(Instant.parse("2026-10-20T12:00:00Z"));
        return w;
    }

    /** Eine berechnete Summe (Fassung 1, {@code gewichtete_summe}); je Term {Art, Quelle, Verteilungsziel oder null}. */
    private void summe(Welt w, String kennzeichen, List<String[]> terme) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'berechnet', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Intervallmenge') RETURNING id", UUID.class, w.mandant(), kennzeichen, "Prozess Spritzguss gesamt");
        UUID fassung = root.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, "
                + "formel_typ, herkunft, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'gewichtete_summe', 'anlage', "
                + "'sub-test', 'Test', 'kunde') RETURNING id", UUID.class, w.mandant(), ms);
        int position = 0;
        for (String[] t : terme) {
            root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                    + "quell_messstelle_id, vorzeichen, faktor, verteilung_ziel) VALUES (?, ?, ?, ?, ?, ?, '+', 1, ?)",
                    w.mandant(), ms, fassung, position++, t[0], w.messstellen().get(t[1]),
                    t[2] == null ? null : w.kostenstellen().get(t[2]));
        }
        w.messstellen().put(kennzeichen, ms);
    }

    /** Die Antwort OHNE das letzte Feld {@code doppelzaehlung} — als Text, sonst unberührt. */
    private static String ohneWarnung(String antwort) {
        int feld = antwort.lastIndexOf(",\"doppelzaehlung\":");
        assertThat(feld).as("doppelzaehlung ist das letzte Feld").isPositive();
        assertThat(antwort.indexOf("\"nicht_verteilt\":")).as("…nach nicht_verteilt").isLessThan(feld);
        return antwort.substring(0, feld) + "}";
    }

    private static String vorher(String datei) throws Exception {
        String text = new String(KostenstelleEnergieApiTest.class.getResourceAsStream("/uems/doppelzaehlung-vorher/" + datei)
                .readAllBytes(), StandardCharsets.UTF_8);
        return text.endsWith("\n") ? text.substring(0, text.length() - 1) : text;
    }

    private static List<String> saetze(JsonNode sicht) {
        List<String> raus = new ArrayList<>();
        sicht.path("doppelzaehlung").path("enthalten").forEach(e -> raus.add(e.path("satz").asText()));
        return raus;
    }

    /** Die Antwort als Text, jede Kennung als {@code <id>} — die Welt legt sie je Lauf neu an. */
    private String roh(Welt w, UUID kostenstelle, String abfrage) throws Exception {
        MvcResult r = abrufen(w, kostenstelle, abfrage);
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(200);
        return text.replaceAll("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<id>");
    }

    // ================================================================ Welten

    private record Welt(UUID mandant, UUID unternehmen, UUID anlage, Map<String, UUID> messstellen,
            Map<String, UUID> komponenten, Map<String, UUID> kostenstellen) {}

    private record Anteil(String kostenstelle, String prozent, String ab, String bis) {}

    /** Lindach (AN-3): MS-16 Hauptzähler, MS-17/MS-18 Unterzähler, Rest MS-22, Kostenstellen 4200/4300, F14-Tag. */
    private Welt lindach(String name, boolean restAn4200) {
        Welt w = welt(name);
        messstelle(w, "MS-16", "Hauptzähler", null);
        messstelle(w, "MS-17", "Unterzähler", "MS-16");
        messstelle(w, "MS-18", "Unterzähler", "MS-16");
        rest(w, "MS-22", "MS-16");
        kostenstelle(w, "4200", "Montage", "2026-10-01", null);
        kostenstelle(w, "4300", "Logistik", "2026-10-01", null);
        verteilung(w, "MS-17", List.of(new Anteil("4300", "100", "2026-10-15", null)));
        verteilung(w, "MS-18", List.of(new Anteil("4200", "100", "2026-10-15", null)));
        if (restAn4200) {
            verteilung(w, "MS-22", List.of(new Anteil("4200", "100", "2026-10-15", null)));
        }
        tageswert(w, "MS-16", F14_TAG, "100");
        tageswert(w, "MS-17", F14_TAG, "60");
        tageswert(w, "MS-18", F14_TAG, "30");
        return w;
    }

    private Welt welt(String anlage) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Kostenstellen-Probe #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH #" + nr);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage + " #" + nr, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        return new Welt(t, u, site, new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>());
    }

    /** Box, Komponente, Mess-Selektion des Zählerstands, gemessene Messstelle mit führender Quelle, Stellung. */
    private void messstelle(Welt w, String kennzeichen, String stellung, String unterzaehlerVon) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, w.anlage(), "VP-KST-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t,
                w.anlage(), "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, w.anlage(), box, komponente, ENERGIE, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                Timestamp.from(Instant.parse("2020-01-01T00:01:00Z")));
        if (stellung != null) {
            root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                    + "gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, w.anlage(), stellung,
                    unterzaehlerVon == null ? null : w.messstellen().get(unterzaehlerVon), LocalDate.parse("2026-01-01"));
        }
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
    }

    /** Eine Rest-Messstelle: Fassung 1 vom Typ {@code rest} mit ihrem Hauptzähler, ohne Terme (wie „Rest anlegen“). */
    private void rest(Welt w, String kennzeichen, String hauptzaehler) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'berechnet', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Intervallmenge') RETURNING id", UUID.class, w.mandant(), kennzeichen, "Lindach nicht zugeordnet");
        root.update("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art, rest_hauptzaehler_id) VALUES (?, ?, 1, 'rest', 'anlage', 'sub-test', "
                + "'Test', 'kunde', ?)", w.mandant(), ms, w.messstellen().get(hauptzaehler));
        w.messstellen().put(kennzeichen, ms);
    }

    private UUID kostenstelle(Welt w, String kennzeichen, String name, String ab, String bis) {
        UUID id = root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, "
                + "gueltig_bis, created_by) VALUES (?, ?, ?, ?, ?, ?, 'test') RETURNING id", UUID.class, w.mandant(),
                w.unternehmen(), kennzeichen, name, LocalDate.parse(ab), bis == null ? null : LocalDate.parse(bis));
        w.kostenstellen().put(kennzeichen, id);
        return id;
    }

    /** Ein Satz in EINER Anweisung — die 100 % prüft die Datenbank zur Commit-Zeit. */
    private void verteilung(Welt w, String messstelle, List<Anteil> anteile) {
        StringBuilder sql = new StringBuilder("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, "
                + "anteil_prozent, gueltig_ab, gueltig_bis, created_by) VALUES ");
        List<Object> args = new ArrayList<>();
        for (Anteil a : anteile) {
            sql.append(args.isEmpty() ? "" : ", ").append("(?, ?, ?, ?::numeric, ?, ?, 'test')");
            args.addAll(java.util.Arrays.asList(w.mandant(), w.messstellen().get(messstelle),
                    w.kostenstellen().get(a.kostenstelle()), a.prozent(), LocalDate.parse(a.ab()),
                    a.bis() == null ? null : LocalDate.parse(a.bis())));
        }
        root.update(sql.toString(), args.toArray());
    }

    /** Ein gemessener, vollständiger, endgültiger Tageswert der Reihe einer Messstelle. */
    private void tageswert(Welt w, String kennzeichen, LocalDate tag, String menge) {
        int stunden = TagRegeln.stunden(tag, ZONE);
        int slots = stunden * 4;
        int erwartet = stunden * 60;
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, erhalten, erwartet, "
                + "abdeckung_prozent, rolle, zustand, endgueltig_ab, version, menge, menge_zustand, kennzeichen) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?, ?, 100, 'fuehrend', "
                + "'endgueltig', ?, 1, ?::numeric, 'vollständig', '[]'::jsonb)", tag, w.mandant(),
                w.komponenten().get(kennzeichen), ENERGIE, Timestamp.from(beginn(tag)), Timestamp.from(beginn(tag.plusDays(1))),
                stunden, slots, slots, slots, erwartet, erwartet,
                Timestamp.from(beginn(tag.plusDays(1)).plus(Duration.ofDays(7))), menge);
    }

    /** Version 2 eines Tages — so, wie die Korrektur-Kaskade sie in {@code messreihe_periode_version} schreibt. */
    private void versionZwei(Welt w, String kennzeichen, boolean berechnet, String menge, List<String> saetze)
            throws Exception {
        root.update("INSERT INTO messreihe_periode_version (tenant_id, ebene, entity_id, messkanal, messstelle_id, "
                + "periode_beginn, periode_ende, tag, zeitzone, version, menge, menge_zustand, kennzeichen, "
                + "abdeckung_prozent, zustand, korrekturen, ersatzwerte, anlass_kennung, anlass_fassung) "
                + "VALUES (?, 'tag', ?, ?, ?, ?, ?, ?, 'Europe/Berlin', 2, ?::numeric, 'vollständig', ?::jsonb, 100, "
                + "'endgueltig', ARRAY['K-2026-0011'], ARRAY[]::text[], 'K-2026-0011', 2)", w.mandant(),
                berechnet ? null : w.komponenten().get(kennzeichen), berechnet ? null : ENERGIE,
                berechnet ? w.messstellen().get(kennzeichen) : null, Timestamp.from(beginn(F14_TAG)),
                Timestamp.from(beginn(F14_TAG.plusDays(1))), F14_TAG, menge, MAPPER.writeValueAsString(saetze));
    }

    // ================================================================ lesen

    private JsonNode energie(Welt w, UUID kostenstelle, String abfrage) throws Exception {
        MvcResult r = abrufen(w, kostenstelle, abfrage);
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(200);
        return MAPPER.readTree(text);
    }

    private MvcResult abrufen(Welt w, UUID kostenstelle, String abfrage) throws Exception {
        return mvc.perform(get("/api/v1/unternehmen/kostenstellen/" + kostenstelle + "/energie?" + abfrage)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + w.mandant());
                    j.claim("name", "Ines Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))).andReturn();
    }

    private static List<String> kennzeichenDerPosten(JsonNode block) {
        List<String> raus = new ArrayList<>();
        block.path("posten").forEach(p -> raus.add(p.path("messstelle").path("kennzeichen").asText()));
        return raus;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> raus = new ArrayList<>();
        liste.forEach(n -> raus.add(n.asText()));
        return raus;
    }

    private static Instant beginn(LocalDate tag) {
        return tag.atStartOfDay(ZONE).toInstant();
    }
}
