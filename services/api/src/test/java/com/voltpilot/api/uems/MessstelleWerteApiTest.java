package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.yaml.snakeyaml.Yaml;

/**
 * Das Lese-Modell „Werte je Messstelle“ (UEMS AP-08 IP-9) über die Route
 * {@code GET /api/v1/messstellen/{kennzeichen}/werte} — gegen Speicherklassen, die die ECHTEN Läufe
 * (Viertelstunde, Endgültigkeit, Tag, Monat/Jahr) aus den Rohwerten der Vektor-Datei gebildet haben.
 * Kennzeichen, Namen und Größen aus dem Referenzunternehmen Ahrenberg.
 *
 * <p>Geprüft: F8 und F13 Erwartung für Erwartung von {@code verbrauch-vectors.json} über die Route; je
 * Raster ein Fall (F16 für Monat und Jahr); die Gegenprobe am Tag mit Lücke (Tagesmenge ≠ Summe der
 * Viertelstunden); der 25-Stunden-Tag; vorläufig und endgültig nebeneinander; eine Messstelle ohne
 * Quelle hat „keine Werte“, nie 0; nur die führende Quelle liefert; Ereignis-Verweise; jeder Wert
 * jeder Antwort erfüllt den Ergebnis-Zustands-Vertrag ({@link ErgebnisZustand#pruefe}); die Anfrage
 * wird streng gelesen; der Mandantenzaun (fremd = 404, nie 403); die Felder der OpenAPI; der
 * Fingerabdruck des ganzen Schemas ist vor und nach allen Aufrufen gleich (die Route schreibt nichts).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessstelleWerteApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_dev_pw";
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");

    /** Ahrenberg (F8 an MS-10, F13 an MS-06, MS-21 ohne Quelle), die Oktober-Welt (F16 an MS-06), ein fremder Kunde. */
    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-0000000009a1");
    private static final UUID OKT = UUID.fromString("4e0e0000-0000-0000-0000-0000000009a2");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-0000000009a3");

    /** Gebildet am 05.11.2026 — die Oktobertage laufen noch in ihrer Frist. */
    private static final Instant T_BILDEN = Instant.parse("2026-11-05T12:00:00Z");
    /** Gelesen am 11.11.2026: der 03.11. ist endgültig, der 04.11. (Frist bis 11.11. 23:00 Z) noch vorläufig. */
    private static final Instant T_JETZT = Instant.parse("2026-11-11T12:00:00Z");

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
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    MessstelleWerteService dienst;

    private static JdbcTemplate root;
    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static final Map<String, JsonNode> FAELLE = new LinkedHashMap<>();
    private static boolean aufgebaut;

    private record Antwort(int status, JsonNode body) {}

    // =========================================================================== Aufbau

    @BeforeEach
    void aufbauen() throws Exception {
        dienst.uhrStellen(Clock.fixed(T_JETZT, ZoneOffset.UTC));
        if (aufgebaut) {
            return;
        }
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            FAELLE.put(fall.path("name").asText().split("-")[0], fall);
        }
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        JdbcTemplate admin = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW));
        stammdaten();
        rohwerte();

        // Tag- und Periodenlauf tragen den Katalog seit PR 726 (ReihenKontext): ohne die Einheit kWh des
        // Testkanals spräche der Lücken-Satz des Tages den Zuwachs ohne Zahl (F8: „Zuwachs 337,6 kWh gemessen").
        MeasurementCatalog katalog = UemsTestKatalog.mitKwhTestkanaelen();
        ViertelstundeVerdichter verdichter = new ViertelstundeVerdichter(admin,
                katalog, new SpaetankunftMelder(), 500, 40, 200_000);
        EndgueltigkeitLauf endgueltigkeit = new EndgueltigkeitLauf(admin, 2000, 200);
        TagVerdichter tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        PeriodeVerdichter perioden = new PeriodeVerdichter(admin, katalog, 50, 40, 2000);

        // ---- 1. Anfang November: Viertelstunden, Endgültigkeit, Tage, Monate, Jahre ---------
        arbeitFuellen();
        while (verdichter.verdichteEinenStapel(T_BILDEN)[0] > 0) {
            // bis die Liste leer ist
        }
        endgueltigkeit.umschalten(T_BILDEN);
        tagArbeitFuellen();
        while (tage.bildeEinenStapel(T_BILDEN)[0] > 0) {
            // bis die Liste leer ist
        }
        while (perioden.bildeEinenStapel(T_BILDEN)[0] > 0) {
            // bis die Liste leer ist
        }
        // ---- 2. 11.11.: was seine Frist hinter sich hat, wird endgültig; die Stufen ziehen nach --
        endgueltigkeit.umschalten(T_JETZT);
        tage.eintragenAusFrist(T_JETZT);
        while (tage.bildeEinenStapel(T_JETZT)[0] > 0) {
            // bis die Liste leer ist
        }
        perioden.lauf(T_JETZT);
        while (perioden.bildeEinenStapel(T_JETZT)[0] > 0) {
            // bis die Liste leer ist
        }
        // ---- 3. Die Lücke von F8 als Meldung des Writers (nach den Läufen: sie rechnet nichts) ---
        IDS.put("LUECKE", UUID.randomUUID());
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, site_id, "
                + "kennungen, device_id, entity_id, messkanal, nutzlast, aus_bestand) "
                + "VALUES (?, ?, ?, 'data_gap', 'writer', ?, ?, ?, ?::jsonb, ?, ?, ?, '{\"erkannt_aus\":\"kadenz\"}'::jsonb, false)",
                Timestamp.from(Instant.parse("2026-11-03T13:00:00Z")), KB, IDS.get("LUECKE"),
                Timestamp.from(Instant.parse("2026-11-03T13:00:00Z")), Timestamp.from(Instant.parse("2026-11-03T16:31:00Z")),
                IDS.get("AN:" + KB), "{\"box\":\"" + IDS.get("BOX:" + KB) + "\",\"komponente\":\"" + IDS.get("K-8.1")
                        + "\"}", IDS.get("BOX:" + KB), IDS.get("K-8.1"), "energy_kwh");
        // ---- 4. Rohwerte vom 10.11. 10:00–10:14, die noch kein Lauf gesehen hat -------------------
        List<Rohwert> ungebildet = new ArrayList<>();
        for (int i = 0; i < 15; i++) {
            ungebildet.add(new Rohwert(Instant.parse("2026-11-10T09:00:00Z").plusSeconds(60L * i),
                    new BigDecimal("425000").add(new BigDecimal("1.6").multiply(BigDecimal.valueOf(i)))));
        }
        saeen(KB, IDS.get("K-8.1"), ungebildet);
        // … und ein Rohwert in einer Stunde, deren andere Viertelstunde schon gebildet ist (26.10. 00:20 MEZ).
        saeen(KB, IDS.get("K-5:" + KB), List.of(new Rohwert(Instant.parse("2026-10-25T23:20:00Z"),
                new BigDecimal("1070729.6"))));
        aufgebaut = true;
    }

    @AfterEach
    void uhrZurueck() {
        dienst.uhrStellen(Clock.systemUTC());
    }

    // =========================================================== Die Vektoren über die Route

    /** F8 (Plan-Abnahme 2): jede Erwartung — Viertelstunden, Stunde, Tag — genau so über die Route. */
    @Test
    void f8JedeErwartungUeberDieRoute() throws Exception {
        pruefeFall(KB, "MS-10", "f8");
    }

    /** F13: der 25-Stunden-Tag, beide Stunden 02:00–03:00 und die Viertelstunde 02:15 MEZ über die Route. */
    @Test
    void f13JedeErwartungUeberDieRoute() throws Exception {
        pruefeFall(KB, "MS-06", "f13");
    }

    // ================================================================ Je Raster ein Fall

    @Test
    void viertelstundeF8EineLueckeIstKeineNullUndFehltNicht() throws Exception {
        JsonNode w = ok(werte(KB, "MS-10", "viertelstunde", "2026-11-03T14:00:00+01:00", "2026-11-03T15:00:00+01:00"));
        assertThat(w.path("werte")).hasSize(4);
        JsonNode luecke = schritt(w, "2026-11-03T14:15:00+01:00");
        assertThat(luecke.path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(luecke.path("menge").isNull()).isTrue();
        assertThat(luecke.path("erhalten").asInt()).isZero();
        assertThat(luecke.path("erwartet").asInt()).isEqualTo(15);
        assertThat(luecke.path("abdeckung_prozent").asInt()).isZero();
        assertThat(luecke.path("grund").isNull()).isTrue();
        assertThat(luecke.path("beschriftung").asText()).isEqualTo("14:15–14:30");
        assertThat(luecke.path("gebildet_aus").isNull()).as("keine Zeile — nichts gebildet").isTrue();
        assertThat(ids(luecke.path("ereignisse"))).containsExactly(IDS.get("LUECKE").toString());
        assertThat(schritt(w, "2026-11-03T14:00:00+01:00").path("gebildet_aus").asText()).isEqualTo("viertelstunde");
    }

    @Test
    void stundeF8IstDerZeitraumIhrerViertelstundenMitDerAbdeckungDerLuecke() throws Exception {
        JsonNode w = ok(werte(KB, "MS-10", "stunde", "2026-11-03T14:00:00+01:00", "2026-11-03T18:00:00+01:00"));
        assertThat(w.path("werte")).hasSize(4);
        // 15:00 und 16:00 haben keine einzige Viertelstunde: keine Werte, 0 von 60.
        JsonNode leer = schritt(w, "2026-11-03T15:00:00+01:00");
        assertThat(leer.path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(leer.path("menge").isNull()).isTrue();
        assertThat(leer.path("erwartet").asInt()).isEqualTo(60);
        JsonNode s17 = schritt(w, "2026-11-03T17:00:00+01:00");
        assertThat(s17.path("gebildet_aus").asText()).isEqualTo("zeitraum");
        assertThat(s17.path("fassung").asText()).isEqualTo("endgueltig");
        assertThat(ids(s17.path("ereignisse"))).containsExactly(IDS.get("LUECKE").toString());
    }

    @Test
    void monatF16AusDenPeriodenstaendenUndEndgueltig() throws Exception {
        JsonNode soll = erwartung("f16", "Monat Oktober 2026");
        JsonNode w = ok(werte(OKT, "MS-06", "monat", "2026-10-01", "2026-10-31"));
        assertThat(w.path("werte")).hasSize(1);
        JsonNode okt = w.path("werte").get(0);
        vergleiche(soll, okt);
        assertThat(okt.path("gebildet_aus").asText()).isEqualTo("monat");
        assertThat(okt.path("fassung").asText()).isEqualTo("endgueltig");
        assertThat(okt.path("stunden").asInt()).as("Oktober 2026 hat 745 Stunden").isEqualTo(745);
        assertThat(okt.path("version").asInt()).isEqualTo(1);
        gleichDerZeile(okt, "SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = 'monat' AND tag = '2026-10-01'",
                IDS.get("K-5:" + OKT));
    }

    @Test
    void jahrF16IstDieGespeicherteJahreszeileMitIhremZustand() throws Exception {
        JsonNode w = ok(werte(OKT, "MS-06", "jahr", "2026-01-01", "2026-12-31"));
        assertThat(w.path("werte")).hasSize(1);
        JsonNode jahr = w.path("werte").get(0);
        assertThat(jahr.path("gebildet_aus").asText()).isEqualTo("jahr");
        assertThat(jahr.path("stunden").asInt()).isEqualTo(8760);
        gleichDerZeile(jahr, "SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = 'jahr' AND tag = '2026-01-01'",
                IDS.get("K-5:" + OKT));
    }

    // =================================================== Gegenprobe, Umstellungstag, Fassung

    /**
     * DIE Gegenprobe (F8): die Tagesmenge über die Route ist 2 304 kWh aus den Periodenständen; die Summe
     * der Viertelstunden desselben Tages über dieselbe Route wäre 1 966,4 kWh — der gemessene Zuwachs
     * über den Box-Ausfall stünde nirgends.
     */
    @Test
    void gegenprobeDieTagesmengeIstNichtDieSummeDerViertelstunden() throws Exception {
        JsonNode tag = ok(werte(KB, "MS-10", "tag", "2026-11-03", "2026-11-03")).path("werte").get(0);
        assertThat(tag.path("menge").decimalValue()).isEqualByComparingTo("2304.0");
        assertThat(tag.path("zustand").asText()).isEqualTo("vollständig");

        JsonNode viertel = ok(werte(KB, "MS-10", "viertelstunde", "2026-11-03", "2026-11-03")).path("werte");
        assertThat(viertel).hasSize(96);
        BigDecimal summe = BigDecimal.ZERO;
        int keineWerte = 0;
        int ohneMenge = 0;
        int unvollstaendig = 0;
        for (JsonNode v : viertel) {
            if (!v.path("menge").isNull()) {
                assertThat(v.path("menge").decimalValue()).as("eine Menge ist nie eine erfundene Null")
                        .isNotEqualByComparingTo(BigDecimal.ZERO);
                summe = summe.add(v.path("menge").decimalValue());
            } else {
                ohneMenge++;
            }
            keineWerte += "keine Werte".equals(v.path("zustand").asText()) ? 1 : 0;
            unvollstaendig += "unvollständig".equals(v.path("zustand").asText()) ? 1 : 0;
        }
        assertThat(summe).isEqualByComparingTo("1966.4");
        assertThat(summe).isNotEqualByComparingTo(tag.path("menge").decimalValue());
        // Die Anzeige von F8 sagt „14 Viertelstunden ohne Werte“ und meint OHNE MENGE: 13 haben keinen
        // einzigen Wert (14:15 … 17:15), 14:00 hat einen — unvollständig, „nur ein Stand“. Das Vokabular
        // unterscheidet beides, die Route auch.
        assertThat(keineWerte).as("13 Viertelstunden ohne einen Wert").isEqualTo(13);
        assertThat(ohneMenge).as("14 Viertelstunden ohne Menge").isEqualTo(14);
        assertThat(unvollstaendig).as("14:00 und 17:30").isEqualTo(2);
    }

    @Test
    void derFuenfundzwanzigStundenTagHatHundertViertelstundenFuenfundzwanzigStundenUndSagtEs() throws Exception {
        JsonNode tag = ok(werte(KB, "MS-06", "tag", "2026-10-25", "2026-10-25"));
        JsonNode t = tag.path("werte").get(0);
        assertThat(t.path("stunden").asInt()).isEqualTo(25);
        assertThat(t.path("tagesdauer").asText()).isEqualTo(ErgebnisZustand.tagesdauer(
                java.time.LocalDate.of(2026, 10, 25), java.time.ZoneId.of("Europe/Berlin")));
        assertThat(t.path("von").asText()).isEqualTo("2026-10-25T00:00:00+02:00");
        assertThat(t.path("bis").asText()).isEqualTo("2026-10-26T00:00:00+01:00");
        assertThat(tag.path("zeitzone").asText()).isEqualTo("Europe/Berlin");
        assertThat(tag.path("zeitzone_herkunft").asText()).isEqualTo("standort");

        JsonNode stunden = ok(werte(KB, "MS-06", "stunde", "2026-10-25", "2026-10-25")).path("werte");
        assertThat(stunden).hasSize(25);
        assertThat(texte(stunden, "beschriftung")).contains("02:00–03:00 MESZ", "02:00–03:00 MEZ");
        BigDecimal summe = BigDecimal.ZERO;
        for (JsonNode s : stunden) {
            summe = summe.add(s.path("menge").decimalValue());
        }
        assertThat(summe).isEqualByComparingTo(t.path("menge").decimalValue());
        assertThat(ok(werte(KB, "MS-06", "viertelstunde", "2026-10-25", "2026-10-25")).path("werte")).hasSize(100);
        // Ein 24-Stunden-Tag sagt nichts über seine Länge.
        JsonNode normal = ok(werte(KB, "MS-10", "tag", "2026-11-03", "2026-11-03")).path("werte").get(0);
        assertThat(normal.path("stunden").asInt()).isEqualTo(24);
        assertThat(normal.path("tagesdauer").isNull()).isTrue();
    }

    /** Rohwerte ohne Lauf: die Periode ist NICHT „keine Werte“ — sie ist noch nicht gebildet und sagt das. */
    @Test
    void wasNochKeinLaufGesehenHatIstNochNichtGebildetNichtKeineWerte() throws Exception {
        JsonNode viertel = ok(werte(KB, "MS-10", "viertelstunde", "2026-11-10T10:00:00+01:00",
                "2026-11-10T10:30:00+01:00")).path("werte");
        assertThat(viertel.get(0).path("grund").asText()).isEqualTo("noch_nicht_gebildet");
        assertThat(viertel.get(0).path("zustand").isNull()).isTrue();
        assertThat(viertel.get(0).path("menge").isNull()).isTrue();
        assertThat(viertel.get(1).path("zustand").asText()).isEqualTo("keine Werte");
        JsonNode tag = ok(werte(KB, "MS-10", "tag", "2026-11-09", "2026-11-10")).path("werte");
        assertThat(tag.get(0).path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(tag.get(0).path("erwartet").asInt()).isEqualTo(1440);
        assertThat(tag.get(1).path("grund").asText()).isEqualTo("noch_nicht_gebildet");
        JsonNode stunde = ok(werte(KB, "MS-10", "stunde", "2026-11-10T10:00:00+01:00", "2026-11-10T11:00:00+01:00"))
                .path("werte").get(0);
        assertThat(stunde.path("grund").asText()).isEqualTo("noch_nicht_gebildet");
        // Eine Stunde, von der eine Viertelstunde gebildet ist und eine andere erst Rohwerte hat, ist nicht fertig.
        JsonNode halb = ok(werte(KB, "MS-06", "stunde", "2026-10-26T00:00:00+01:00", "2026-10-26T01:00:00+01:00"))
                .path("werte").get(0);
        assertThat(halb.path("grund").asText()).isEqualTo("noch_nicht_gebildet");
        assertThat(halb.path("menge").isNull()).isTrue();
        JsonNode viertelDavon = ok(werte(KB, "MS-06", "viertelstunde", "2026-10-26T00:00:00+01:00",
                "2026-10-26T00:30:00+01:00")).path("werte");
        assertThat(viertelDavon.get(0).path("gebildet_aus").asText()).isEqualTo("viertelstunde");
        assertThat(viertelDavon.get(1).path("grund").asText()).isEqualTo("noch_nicht_gebildet");
    }

    @Test
    void vorlaeufigUndEndgueltigStehenNebeneinanderUndSindNichtDerZustand() throws Exception {
        JsonNode w = ok(werte(KB, "MS-10", "tag", "2026-11-03", "2026-11-04")).path("werte");
        assertThat(w).hasSize(2);
        assertThat(w.get(0).path("fassung").asText()).isEqualTo("endgueltig");
        assertThat(w.get(1).path("fassung").asText()).isEqualTo("vorlaeufig");
        assertThat(w.get(0).path("zustand").asText()).isEqualTo("vollständig");
        assertThat(ErgebnisZustand.ZUSTAENDE.stream().map(ErgebnisZustand.Zustand::wort))
                .contains(w.get(1).path("zustand").asText()).doesNotContain("vorläufig", "endgültig");
        assertThat(w.get(0).path("endgueltig_ab").asText()).isEqualTo("2026-11-11T00:00:00+01:00");
    }

    // ================================================================ Quelle, Vergleich, Zaun

    @Test
    void eineMessstelleOhneQuelleHatKeineWerteNieNull() throws Exception {
        for (String[] r : new String[][] {{"viertelstunde", "2026-11-03T14:00:00+01:00", "2026-11-03T15:00:00+01:00"},
                {"stunde", "2026-11-03", "2026-11-03"}, {"tag", "2026-11-01", "2026-11-04"},
                {"monat", "2026-10-01", "2026-11-30"}, {"jahr", "2026-01-01", "2026-12-31"}}) {
            JsonNode w = ok(werte(KB, "MS-21", r[0], r[1], r[2]));
            assertThat(w.path("quellen")).isEmpty();
            assertThat(w.path("messstelle").path("einheit").asText()).isEqualTo("m³");
            assertThat(w.path("werte")).isNotEmpty();
            for (JsonNode v : w.path("werte")) {
                assertThat(v.path("zustand").asText()).as(r[0]).isEqualTo("keine Werte");
                assertThat(v.path("grund").asText()).isEqualTo("keine_quelle");
                for (String zahl : List.of("menge", "mittel", "min", "max", "erhalten", "erwartet", "abdeckung_prozent")) {
                    assertThat(v.path(zahl).isNull()).as(r[0] + " · " + zahl + " ist unbekannt, nie 0").isTrue();
                }
            }
        }
    }

    /** MS-10 hat eine Vergleichsquelle auf der Reihe von MS-06 — sie liefert nie, auch nicht, wo die führende schweigt. */
    @Test
    void nurDieFuehrendeQuelleLiefert() throws Exception {
        JsonNode w = ok(werte(KB, "MS-10", "tag", "2026-10-25", "2026-10-25"));
        assertThat(w.path("quellen")).hasSize(1);
        assertThat(w.path("quellen").get(0).path("komponente").asText()).isEqualTo(IDS.get("K-8.1").toString());
        JsonNode t = w.path("werte").get(0);
        assertThat(t.path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(t.path("menge").isNull()).isTrue();
        assertThat(t.path("erwartet").asInt()).as("1 500 erwartet am 25-Stunden-Tag bei 60 s").isEqualTo(1500);
    }

    @Test
    void eineFremdeMessstelleIst404NieEine403() throws Exception {
        // Beide Kunden haben ein MS-10 — jeder sieht seines.
        JsonNode eigen = ok(werte(KB, "MS-10", "tag", "2026-11-03", "2026-11-03"));
        JsonNode fremd = ok(werte(FREMD, "MS-10", "tag", "2026-11-03", "2026-11-03"));
        assertThat(eigen.path("messstelle").path("id").asText()).isNotEqualTo(fremd.path("messstelle").path("id").asText());
        assertThat(fremd.path("werte").get(0).path("menge").decimalValue())
                .isNotEqualByComparingTo(eigen.path("werte").get(0).path("menge").decimalValue());
        // MS-06 gibt es nur bei Ahrenberg (und in der Oktober-Welt): für den fremden Kunden 404.
        Antwort a = werte(FREMD, "MS-06", "tag", "2026-10-25", "2026-10-25");
        assertThat(a.status()).isEqualTo(404);
        assertThat(a.body().path("message").asText()).isEqualTo("Messstelle nicht gefunden.");
        assertThat(werte(KB, "MS-F9", "tag", "2026-10-25", "2026-10-25").status()).isEqualTo(404);
        // Ohne Anmeldung gar nichts.
        assertThat(mvc.perform(get("/api/v1/messstellen/MS-10/werte?raster=tag&von=2026-11-03&bis=2026-11-03"))
                .andReturn().getResponse().getStatus()).isEqualTo(401);
    }

    // ============================================================ Anfrage streng gelesen

    @Test
    void dieAnfrageWirdStrengGelesenUndJedeAblehnungNenntIhrFeld() throws Exception {
        anfrage(werte(KB, "MS-10", "woche", "2026-11-03", "2026-11-03"), "raster", "raster_unbekannt");
        anfrage(werte(KB, "MS-10", null, "2026-11-03", "2026-11-03"), "raster", "fehlt");
        anfrage(werte(KB, "MS-10", "tag", null, "2026-11-03"), "von", "fehlt");
        anfrage(werte(KB, "MS-10", "tag", "2026-11-04", "2026-11-03"), "bis", "von_nicht_vor_bis");
        anfrage(werte(KB, "MS-10", "tag", "2026-02-30", "2026-03-01"), "von", "form");
        anfrage(werte(KB, "MS-10", "viertelstunde", "2026-11-03T14:10:00+01:00", "2026-11-03T15:00:00+01:00"), "von",
                "nicht_im_raster");
        anfrage(werte(KB, "MS-10", "monat", "2026-11-03", "2026-11-30"), "von", "nicht_im_raster");
        anfrage(werte(KB, "MS-10", "viertelstunde", "2026-10-01", "2026-10-31"), "bis", "zu_viele_schritte");
        anfrage(werte(KB, "MS-10", "tag", "1999-12-31", "2000-01-02"), "von", "ausserhalb");
        Antwort v = mvcGet(KB, "/api/v1/messstellen/MS-10/werte?raster=tag&von=2026-11-03&bis=2026-11-03&version=0");
        anfrage(v, "version", "version_ungueltig");
    }

    /**
     * AP-08 IP-18: ein Tag ohne Korrektur hat genau Version 1 — {@code version=2} ist keine leere Antwort und nicht
     * stillschweigend Version 1, sondern die benannte Ablehnung mit der neuesten (vor IP-18 stand hier ein Schritt
     * ohne Zahl mit {@code version_nicht_gespeichert}; der bleibt Schritten, denen die Version in einem Zeitraum fehlt,
     * den Fall F21 fährt {@code MessstelleWerteVersionenApiTest}).
     */
    @Test
    void eineVersionDieEsNirgendsGibtWirdBenanntAbgelehnt() throws Exception {
        JsonNode eins = ok(mvcGet(KB, "/api/v1/messstellen/MS-10/werte?raster=tag&von=2026-11-03&bis=2026-11-03&version=1"))
                .path("werte").get(0);
        assertThat(eins.path("menge").decimalValue()).isEqualByComparingTo("2304.0");
        assertThat(eins.path("version").asInt()).isEqualTo(1);
        assertThat(eins.path("versionen").asInt()).isEqualTo(1);
        Antwort zwei = mvcGet(KB, "/api/v1/messstellen/MS-10/werte?raster=tag&von=2026-11-03&bis=2026-11-03&version=2");
        assertThat(zwei.status()).as(zwei.body().toString()).isEqualTo(404);
        assertThat(zwei.body().path("code").asText()).isEqualTo("version_gibt_es_nicht");
        assertThat(zwei.body().path("feld").asText()).isEqualTo("version");
        assertThat(zwei.body().path("version").asInt()).isEqualTo(2);
        assertThat(zwei.body().path("hoechste_version").asInt()).isEqualTo(1);
        assertThat(zwei.body().path("message").asText()).contains("Version 2");
    }

    // ============================================================ Vertrag, Felder, Bestand

    /**
     * Jeder Wert JEDER Antwort dieses Tests erfüllt den Ergebnis-Zustands-Vertrag: „keine Werte“ nie mit
     * einer Zahl, „unvollständig“ nie ohne einen Satz, der sagt, was fehlt, jedes Kennzeichen ein Satz der
     * geschlossenen Liste in seiner Reihenfolge — und ein Wert ohne Zustand nennt immer seinen Grund.
     * Dazu: die Felder sind genau die der OpenAPI, und die Route schreibt nichts (Fingerabdruck).
     */
    @Test
    void jederWertErfuelltDenVertragDieFelderSindDieDerOpenApiUndNichtsWirdGeschrieben() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        List<JsonNode> antworten = new ArrayList<>();
        for (String[] r : new String[][] {
                {"MS-10", "viertelstunde", "2026-11-03", "2026-11-04"}, {"MS-10", "stunde", "2026-11-03", "2026-11-04"},
                {"MS-10", "tag", "2026-10-25", "2026-11-11"}, {"MS-10", "monat", "2026-10-01", "2026-11-30"},
                {"MS-10", "jahr", "2026-01-01", "2026-12-31"}, {"MS-06", "stunde", "2026-10-24", "2026-10-26"},
                {"MS-06", "viertelstunde", "2026-10-25", "2026-10-25"}, {"MS-21", "tag", "2026-11-01", "2026-11-04"}}) {
            antworten.add(ok(werte(KB, r[0], r[1], r[2], r[3])));
        }
        antworten.add(ok(werte(OKT, "MS-06", "tag", "2026-10-01", "2026-10-31")));
        antworten.add(ok(werte(OKT, "MS-06", "monat", "2026-09-01", "2026-12-31")));
        antworten.add(ok(werte(OKT, "MS-06", "jahr", "2025-01-01", "2027-12-31")));
        werte(FREMD, "MS-06", "tag", "2026-10-25", "2026-10-25");
        werte(KB, "MS-10", "woche", "2026-11-03", "2026-11-03");

        Map<String, Set<String>> openapi = openapiFelder();
        int geprueft = 0;
        for (JsonNode a : antworten) {
            assertThat(felder(a)).isEqualTo(openapi.get("MessstelleWerte"));
            assertThat(felder(a.path("messstelle"))).isEqualTo(openapi.get("MessstelleWerteMessstelle"));
            a.path("quellen").forEach(q -> assertThat(felder(q)).isEqualTo(openapi.get("MessstelleWerteQuelle")));
            for (JsonNode v : a.path("werte")) {
                assertThat(felder(v)).isEqualTo(openapi.get("MessstelleWerteWert"));
                v.path("ereignisse").forEach(e -> assertThat(felder(e)).isEqualTo(openapi.get("MessstelleWerteEreignis")));
                if (v.path("zustand").isNull()) {
                    assertThat(v.path("grund").isNull()).as("ohne Zustand immer mit Grund: " + v).isFalse();
                    assertThat(v.path("menge").isNull() && v.path("mittel").isNull()).as("ohne Zustand keine Zahl").isTrue();
                    continue;
                }
                List<String> kennzeichen = new ArrayList<>();
                v.path("kennzeichen").forEach(k -> kennzeichen.add(k.asText()));
                ErgebnisZustand.Ergebnis e = new ErgebnisZustand.Ergebnis(
                        v.path("menge").isNull() ? null : v.path("menge").decimalValue(),
                        a.path("messstelle").path("einheit").asText(), a.path("raster").asText(),
                        v.path("zustand").asText(),
                        v.path("abdeckung_prozent").isNull() ? null : v.path("abdeckung_prozent").decimalValue(),
                        kennzeichen);
                assertThat(ErgebnisZustand.pruefe(e)).as(a.path("messstelle").path("kennzeichen").asText() + " "
                        + a.path("raster").asText() + " " + v).isEmpty();
                if (v.path("grund").isNull()) {
                    assertThat(v.path("fassung").asText()).isIn("vorlaeufig", "endgueltig");
                } else {
                    assertThat(v.path("grund").asText()).as("mit Zustand ohne Zahl nur ohne Quelle").isEqualTo("keine_quelle");
                }
                geprueft++;
            }
        }
        assertThat(geprueft).isGreaterThan(400);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    // ============================================================================ Helfer

    /** Ein Vektor-Fall über die Route: je Erwartung genau EIN Schritt ihres Rasters mit genau ihren Zahlen. */
    private void pruefeFall(UUID kunde, String messstelle, String fall) throws Exception {
        int geprueft = 0;
        for (JsonNode soll : FAELLE.get(fall).path("expected")) {
            String name = soll.path("name").asText();
            String raster = name.startsWith("Viertelstunde") ? "viertelstunde" : name.startsWith("Stunde") ? "stunde"
                    : name.startsWith("Tag") ? "tag" : null;
            assertThat(raster).as(name).isNotNull();
            JsonNode w = ok(werte(kunde, messstelle, raster, soll.path("von").asText(), soll.path("bis").asText()));
            assertThat(w.path("werte")).as(name).hasSize(1);
            JsonNode ist = w.path("werte").get(0);
            vergleiche(soll, ist);
            if (soll.has("stunden")) {
                assertThat(ist.path("stunden").asInt()).as(name).isEqualTo(soll.path("stunden").asInt());
            }
            if (raster.equals("stunde") || raster.equals("viertelstunde")) {
                // Die Beschriftung des Rasters ist der Name der Erwartung ohne das Raster-Wort (E10).
                assertThat(ist.path("beschriftung").asText()).as(name)
                        .isEqualTo(name.substring(name.indexOf(' ') + 1));
            }
            geprueft++;
        }
        assertThat(geprueft).isGreaterThanOrEqualTo(4);
    }

    private static void vergleiche(JsonNode soll, JsonNode ist) {
        String was = soll.path("name").asText();
        VerbrauchVectorsTest.zahl(was + " · menge", soll.path("menge"),
                ist.path("menge").isNull() ? null : ist.path("menge").decimalValue());
        assertThat(ist.path("zustand").asText()).as(was + " · zustand").isEqualTo(soll.path("zustand").asText());
        assertThat(ist.path("erhalten").asInt()).as(was + " · erhalten").isEqualTo(soll.path("erhalten").asInt());
        assertThat(ist.path("erwartet").asInt()).as(was + " · erwartet").isEqualTo(soll.path("erwartet").asInt());
        assertThat(ist.path("abdeckung_prozent").asInt()).as(was + " · abdeckung")
                .isEqualTo(soll.path("abdeckung_prozent").asInt());
        List<String> sollK = new ArrayList<>();
        soll.path("kennzeichen").forEach(n -> sollK.add(n.asText()));
        List<String> istK = new ArrayList<>();
        ist.path("kennzeichen").forEach(n -> istK.add(n.asText()));
        assertThat(istK).as(was + " · kennzeichen").isEqualTo(sollK);
    }

    /** Die Route sagt, was die Zeile der Speicherklasse sagt — Zeichen für Zeichen, nichts dazugerechnet. */
    private static void gleichDerZeile(JsonNode ist, String sql, Object... args) {
        Map<String, Object> z = root.queryForMap(sql, args);
        BigDecimal menge = (BigDecimal) z.get("menge");
        if (menge == null) {
            assertThat(ist.path("menge").isNull()).isTrue();
        } else {
            assertThat(ist.path("menge").decimalValue()).isEqualByComparingTo(menge);
        }
        assertThat(ist.path("zustand").asText()).isEqualTo(z.get("menge_zustand"));
        assertThat(ist.path("fassung").asText()).isEqualTo(z.get("zustand"));
        assertThat(ist.path("erhalten").asInt()).isEqualTo(((Number) z.get("erhalten")).intValue());
        assertThat(ist.path("erwartet").asInt()).isEqualTo(((Number) z.get("erwartet")).intValue());
        assertThat(ist.path("version").asInt()).isEqualTo(((Number) z.get("version")).intValue());
        List<String> k = new ArrayList<>();
        ist.path("kennzeichen").forEach(n -> k.add(n.asText()));
        assertThat(k).isEqualTo(ViertelstundenTeile.kennzeichen(String.valueOf(z.get("kennzeichen"))));
    }

    private static JsonNode erwartung(String fall, String name) {
        for (JsonNode e : FAELLE.get(fall).path("expected")) {
            if (e.path("name").asText().equals(name)) {
                return e;
            }
        }
        throw new AssertionError("keine Erwartung " + fall + " " + name);
    }

    private Antwort werte(UUID kunde, String messstelle, String raster, String von, String bis) throws Exception {
        StringBuilder q = new StringBuilder("/api/v1/messstellen/" + messstelle + "/werte?");
        if (raster != null) {
            q.append("raster=").append(raster).append('&');
        }
        if (von != null) {
            q.append("von=").append(java.net.URLEncoder.encode(von, StandardCharsets.UTF_8)).append('&');
        }
        if (bis != null) {
            q.append("bis=").append(java.net.URLEncoder.encode(bis, StandardCharsets.UTF_8));
        }
        return mvcGet(kunde, q.toString());
    }

    private Antwort mvcGet(UUID kunde, String pfad) throws Exception {
        MvcResult r = mvc.perform(get(java.net.URI.create(pfad)).with(jwt().jwt(j -> {
            j.subject("sub-ines-" + kunde);
            j.claim("preferred_username", "Ines Kaltenbach");
            j.claim("tenant_id", kunde.toString());
        }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    private static void anfrage(Antwort a, String feld, String grund) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(400);
        assertThat(a.body().path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(a.body().path("feld").asText()).isEqualTo(feld);
        assertThat(a.body().path("grund").asText()).isEqualTo(grund);
        assertThat(a.body().path("message").asText()).isNotBlank();
    }

    private static JsonNode schritt(JsonNode w, String von) {
        for (JsonNode v : w.path("werte")) {
            if (v.path("von").asText().equals(von)) {
                return v;
            }
        }
        throw new AssertionError("kein Schritt " + von + " in " + w);
    }

    private static List<String> ids(JsonNode ereignisse) {
        List<String> out = new ArrayList<>();
        ereignisse.forEach(e -> out.add(e.path("id").asText()));
        return out;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> out = new ArrayList<>();
        liste.forEach(e -> out.add(e.path(feld).asText()));
        return out;
    }

    private static Set<String> felder(JsonNode n) {
        Set<String> out = new TreeSet<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Set<String>> openapiFelder() throws Exception {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            Map<String, Object> schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            Map<String, Set<String>> out = new LinkedHashMap<>();
            for (String name : List.of("MessstelleWerte", "MessstelleWerteMessstelle", "MessstelleWerteQuelle",
                    "MessstelleWerteWert", "MessstelleWerteEreignis")) {
                Map<String, Object> s = (Map<String, Object>) schemas.get(name);
                assertThat(s).as(name).isNotNull();
                // Einzige Ausnahme (AP-03 R-A6): `ausserhalb_zugriff` steht nur, wenn es gilt — wie an Formel und Bilanz.
                Set<String> pflicht = new TreeSet<>(((Map<String, Object>) s.get("properties")).keySet());
                if (name.equals("MessstelleWerte")) {
                    assertThat(pflicht.remove("ausserhalb_zugriff")).as(name + " · ausserhalb_zugriff").isTrue();
                }
                assertThat((List<String>) s.get("required")).as(name + " · jedes Feld ist Pflicht, auch leer")
                        .containsExactlyInAnyOrderElementsOf(pflicht);
                out.put(name, pflicht);
            }
            return out;
        }
    }

    // ============================================================ Aufbau der Beispielwelt

    private static void stammdaten() {
        for (UUID t : new UUID[] {KB, OKT, FREMD}) {
            root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", t, t.equals(FREMD) ? "Kundenbereich B"
                    : t.equals(KB) ? "Kunststoffwerk Ahrenberg GmbH" : "Kunststoffwerk Ahrenberg GmbH (Oktober)");
            UUID un = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') RETURNING id",
                    t, "U " + t);
            UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", t, un);
            UUID an = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", t);
            root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, DATE '2024-01-01')", t, an, st);
            IDS.put("AN:" + t, an);
            IDS.put("BOX:" + t, uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                    + "VALUES (?, ?, ?, 'claimed') RETURNING id", t, an, "VP-BOX-WERTE-" + t));
        }
        // Ahrenberg: K-8.1 (EK-1) speist MS-10, K-5 speist MS-06; MS-21 hat keine Datenquelle (F17).
        IDS.put("K-8.1", komponente(KB, "K-8.1"));
        IDS.put("K-5:" + KB, komponente(KB, "K-5"));
        IDS.put("K-5:" + OKT, komponente(OKT, "K-5"));
        IDS.put("K-F:" + FREMD, komponente(FREMD, "K-F"));

        messstelle(KB, "MS-10", "Netzbezug Halle 2", "Strom", "Wirkenergie", "kWh");
        messstelle(KB, "MS-06", "Spritzguss SG01–SG06", "Strom", "Wirkenergie", "kWh");
        messstelle(KB, "MS-21", "Gas Heizung Verwaltung", "Gas", "Volumen", "m³");
        messstelle(OKT, "MS-06", "Spritzguss SG01–SG06", "Strom", "Wirkenergie", "kWh");
        messstelle(FREMD, "MS-10", "Fremder Netzbezug", "Strom", "Wirkenergie", "kWh");

        bindung(KB, "MS-10", IDS.get("K-8.1"), "fuehrend", null);
        bindung(KB, "MS-06", IDS.get("K-5:" + KB), "fuehrend", null);
        // Die Vergleichsquelle von MS-10 liest die Reihe von MS-06 — sie liefert an der Route nie.
        bindung(KB, "MS-10", IDS.get("K-5:" + KB), "vergleich", "Plausibilität");
        bindung(OKT, "MS-06", IDS.get("K-5:" + OKT), "fuehrend", null);
        bindung(FREMD, "MS-10", IDS.get("K-F:" + FREMD), "fuehrend", null);
    }

    private static UUID komponente(UUID tenant, String name) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, IDS.get("AN:" + tenant), name, IDS.get("BOX:" + tenant));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, 'energy_kwh', true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, IDS.get("AN:" + tenant), IDS.get("BOX:" + tenant), entity);
        return entity;
    }

    private static void messstelle(UUID tenant, String kennzeichen, String name, String medium, String groesse,
            String einheit) {
        IDS.put(kennzeichen + ":" + tenant, uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', ?, ?, 'Bezug', ?, 'Zählerstand') "
                + "RETURNING id", tenant, kennzeichen, name, medium, groesse, einheit));
    }

    private static void bindung(UUID tenant, String messstelle, UUID komponente, String rolle, String zweck) {
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, zweck, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, 'energy_kwh', 'counter', "
                + "'zaehlerstand', ?, ?, '2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')",
                tenant, IDS.get(messstelle + ":" + tenant), komponente, geraet, rolle, zweck);
    }

    /** Die Rohwerte der Vektor-Fälle — Zeichen für Zeichen die Eingänge der Datei; der fremde Kunde eigene. */
    private static void rohwerte() {
        saeen(KB, IDS.get("K-8.1"), VerbrauchVectorsTest.rohwerte(FAELLE.get("f8").path("input").path("reihe")));
        saeen(KB, IDS.get("K-5:" + KB), VerbrauchVectorsTest.rohwerte(FAELLE.get("f13").path("input").path("reihe")));
        saeen(OKT, IDS.get("K-5:" + OKT), VerbrauchVectorsTest.rohwerte(FAELLE.get("f16").path("input").path("reihe")));
        List<Rohwert> fremd = new ArrayList<>();
        for (int i = 0; i <= 1440; i++) {
            fremd.add(new Rohwert(Instant.parse("2026-11-02T23:00:00Z").plusSeconds(60L * i), new BigDecimal(900 + 2L * i)));
        }
        saeen(FREMD, IDS.get("K-F:" + FREMD), fremd);
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, 'energy_kwh', ?, "
                    + "'good', '2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2)";

    private static void saeen(UUID tenant, UUID entity, List<Rohwert> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.zeit().plusSeconds(2)), tenant,
                IDS.get("AN:" + tenant), IDS.get("BOX:" + tenant), r.wert(), r.zeit().getEpochSecond(), entity});
            if (stapel.size() == 5000) {
                root.batchUpdate(ROH_SQL, stapel);
                stapel.clear();
            }
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static void arbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s
                 WHERE s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'
                ON CONFLICT DO NOTHING
                """);
    }

    private static void tagArbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund)
                SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                       (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                  FROM messreihe_viertelstunde v
                ON CONFLICT DO NOTHING
                """);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

}
