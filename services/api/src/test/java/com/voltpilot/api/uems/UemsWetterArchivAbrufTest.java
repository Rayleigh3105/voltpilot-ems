package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.ApplicationContext;
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
 * Der Abruf des Wetter-Archivs gegen ein gestubbtes Archiv (UEMS AP-17 IP-12b, E9 = C, R3): Tagesmittel → Gradtage
 * G20/15 mit Herkunft {@code bezogen} und dem Kennzeichen „Temperatur von VoltPilot bezogen (Quelle, Abrufzeit)“; nie
 * ein Tag nach gestern; ein Ausfall lässt den Tag fehlen (nie 0) und der Monat heißt „x von y Tagen“; ohne Koordinaten
 * kein Abruf; ein zweiter Lauf schreibt nichts doppelt; im Testlauf ist der Schalter AUS und es gibt keinen Läufer; die
 * Kennzahl mit BZ-8-Nenner erbt das Kennzeichen (R3; Zähler ist eine eingegebene Menge).
 *
 * <p>Der Takt steht am Ersten dieses Monats 06:10 Europe/Berlin — gestern ist der letzte Tag des Vormonats.
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsWetterArchivAbrufTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String PFAD = "/api/v1/kennzahlen";
    // Der Takt steht am Ersten dieses Monats um 06:10 — nie in der Zukunft der Datenbank-Uhr, die jede Periode als
    // abgeschlossen verlangt (bezugsgroesse_wert_abgeschlossen_chk). Gestern ist der letzte Tag des Vormonats.
    private static final LocalDate ERSTER = LocalDate.now(ZoneId.of("Europe/Berlin")).withDayOfMonth(1);
    private static final Instant TAKT = ERSTER.atTime(6, 10).atZone(ZoneId.of("Europe/Berlin")).toInstant();
    private static final LocalDate GESTERN = ERSTER.minusDays(1);
    private static final LocalDate MONAT = ERSTER.minusMonths(1);
    private static final LocalDate VON = GESTERN.minusDays(29);
    private static final String BEZOGEN = "Temperatur von VoltPilot bezogen (Open-Meteo-Archiv, abgerufen am "
            + java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy").format(ERSTER) + " 06:10)";

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
    KennzahlLauf lauf;

    @Autowired
    ApplicationContext kontext;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    /** Das gestubbte Archiv: liefert, was {@link #daten} hat (auch Tage nach gestern), oder fällt aus. */
    static final class Stub implements WetterArchiv {
        final Map<LocalDate, BigDecimal> daten = new TreeMap<>();
        final List<LocalDate[]> anfragen = new ArrayList<>();
        String ausfall;

        @Override
        public Abruf tagesmittel(BigDecimal breite, BigDecimal laenge, LocalDate von, LocalDate bis, ZoneId zone) {
            anfragen.add(new LocalDate[] {von, bis});
            if (ausfall != null) {
                return new Abruf(OpenMeteoWetterArchiv.QUELLE, TAKT, Map.of(), ausfall);
            }
            Map<LocalDate, BigDecimal> aus = new TreeMap<>();
            // Absichtlich großzügig: die Quelle schickt auch heute und morgen — geschrieben werden sie nie.
            daten.forEach((t, m) -> { if (!t.isBefore(von)) aus.put(t, m); });
            return new Abruf(OpenMeteoWetterArchiv.QUELLE, TAKT, aus, null);
        }

        Stub monat(LocalDate erster, String mittel) {
            for (LocalDate t = erster; t.getMonth() == erster.getMonth(); t = t.plusDays(1)) {
                daten.put(t, new BigDecimal(mittel));
            }
            return this;
        }
    }

    // ================================================================ Tagesmittel → Gradtage mit Herkunft bezogen

    @Test
    void tagesmittelWerdenGradtageMitHerkunftBezogenUndKennzeichenNieEinTagNachGestern() throws Exception {
        Welt w = welt(true);
        UUID bz = gradtagzahl(w, "tag", VON);
        Stub stub = new Stub();
        for (LocalDate t = VON.minusDays(5); !t.isAfter(GESTERN.plusDays(2)); t = t.plusDays(1)) {
            stub.daten.put(t, new BigDecimal("5.0"));   // auch vor `von`, heute und morgen — geschrieben nie
        }
        stub.daten.put(VON.plusDays(10), new BigDecimal("16.2"));  // über der Heizgrenze → 0 Kd
        stub.daten.remove(VON.plusDays(14));                        // Ausfall des einen Tages
        stub.daten.put(GESTERN, new BigDecimal("4.0"));
        WetterArchivAbruf abruf = new WetterArchivAbruf(admin, MAPPER, stub);

        WetterArchivAbruf.Lauf l = abruf.lauf(TAKT, w.mandant());

        assertThat(l.abgerufen()).isEqualTo(1);
        assertThat(l.fehler()).isZero();
        assertThat(stub.anfragen).hasSize(1);
        assertThat(stub.anfragen.get(0)).as("angefragt ab `von` bis gestern, nie weiter").containsExactly(VON, GESTERN);
        List<Map<String, Object>> z = werte(w, bz);
        assertThat(z).as("30 Tage − 1 Ausfall").hasSize(29);
        assertThat(z).extracting(m -> m.get("periode_von").toString()).doesNotContain(VON.plusDays(14).toString(),
                VON.minusDays(1).toString(), ERSTER.toString(), ERSTER.plusDays(1).toString());
        assertThat(z).allSatisfy(m -> {
            assertThat(m.get("herkunft_art")).isEqualTo("bezogen");
            assertThat(m.get("vorgang")).isEqualTo("erstwert");
            assertThat(saetze(m.get("kennzeichen"))).containsExactly("Gradtage G20/15", BEZOGEN);
        });
        assertThat(betrag(w, bz, VON)).as("20 − 5,0").isEqualTo("15");
        assertThat(betrag(w, bz, VON.plusDays(10))).as("16,2 °C ≥ Heizgrenze 15").isEqualTo("0");
        assertThat(betrag(w, bz, GESTERN)).as("20 − 4,0").isEqualTo("16");
        assertThat(root.queryForMap("SELECT bezug_quelle, abgerufen_am FROM bezugsgroesse_wert WHERE tenant_id = ? "
                + "AND bezugsgroesse_id = ? AND periode_von = ?", w.mandant(), bz, VON))
                .containsEntry("bezug_quelle", "Open-Meteo-Archiv")
                .containsEntry("abgerufen_am", Timestamp.from(TAKT));
        JsonNode herkunft = MAPPER.readTree(root.queryForObject("SELECT bezug_herkunft::text FROM bezugsgroesse_wert "
                + "WHERE tenant_id = ? AND bezugsgroesse_id = ? AND periode_von = ?", String.class, w.mandant(), bz, VON));
        assertThat(herkunft.get("breitengrad").decimalValue()).isEqualByComparingTo("48.25");
        assertThat(herkunft.get("laengengrad").decimalValue()).isEqualByComparingTo("11.43");
        assertThat(herkunft.get("zustand").asText()).isEqualTo("vollständig");
        assertThat(herkunft.get("tagesmittel").decimalValue()).isEqualByComparingTo("5.0");

        // Zweiter Lauf: fragt nur den fehlenden Tag an, schreibt ihn — und keinen anderen doppelt.
        stub.daten.put(VON.plusDays(14), new BigDecimal("7.5"));
        stub.daten.put(VON, new BigDecimal("-3.0"));  // ein vorhandener Tag wird nie überschrieben
        WetterArchivAbruf.Lauf zweiter = abruf.lauf(TAKT.plusSeconds(3600), w.mandant());
        assertThat(zweiter.geschrieben()).isEqualTo(1);
        assertThat(stub.anfragen.get(1)).containsExactly(VON.plusDays(14), VON.plusDays(14));
        assertThat(betrag(w, bz, VON.plusDays(14))).as("nachgeholt: 20 − 7,5").isEqualTo("12.5");
        assertThat(betrag(w, bz, VON)).as("nie überschrieben").isEqualTo("15");
        assertThat(werte(w, bz)).hasSize(30);

        String vorher = fingerabdruck(w, bz);
        WetterArchivAbruf.Lauf dritter = abruf.lauf(TAKT.plusSeconds(7200), w.mandant());
        assertThat(dritter.geschrieben()).isZero();
        assertThat(stub.anfragen).as("nichts fehlt mehr — kein Abruf").hasSize(2);
        assertThat(fingerabdruck(w, bz)).as("ein dritter Lauf schreibt nichts").isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE tenant_id = ? AND "
                + "bezugsgroesse_id = ? AND fassung > 1", Long.class, w.mandant(), bz)).as("kein Tag doppelt").isZero();
    }

    // ================================================================ Ausfall: Monat unvollständig „x von y Tagen“

    @Test
    void ausfallLaesstDenTagFehlenUndDerMonatHeisstXVonYTagenNie0() throws Exception {
        Welt w = welt(true);
        UUID bz = gradtagzahl(w, "monat", MONAT);
        int tage = MONAT.lengthOfMonth();
        Stub stub = new Stub();
        stub.ausfall = "HTTP 503";
        WetterArchivAbruf abruf = new WetterArchivAbruf(admin, MAPPER, stub);

        WetterArchivAbruf.Lauf l = abruf.lauf(TAKT, w.mandant());
        assertThat(l.ausfaelle()).isEqualTo(1);
        assertThat(l.fehler()).as("ein Ausfall ist kein Fehler des Läufers").isZero();
        assertThat(werte(w, bz)).as("Ausfall → keine Zeile, nie 0").isEmpty();
        assertThat(stub.anfragen.get(0)).as("der Vormonat; der laufende Monat ist nie dabei")
                .containsExactly(MONAT, GESTERN);

        stub.ausfall = null;
        abruf.lauf(TAKT.plusSeconds(600), w.mandant());
        assertThat(werte(w, bz)).as("das Archiv liefert den ganzen Monat nicht: keine Zahl (die Variable fehlt)")
                .isEmpty();

        stub.monat(MONAT, "5.0");
        for (int d : List.of(7, 8, 9)) stub.daten.remove(MONAT.withDayOfMonth(d));
        abruf.lauf(TAKT.plusSeconds(3600), w.mandant());
        List<Map<String, Object>> z = werte(w, bz);
        assertThat(z).hasSize(1);
        assertThat(betrag(w, bz, MONAT)).as("(y − 3) Tage × 15 Kd").isEqualTo(String.valueOf((tage - 3) * 15));
        assertThat(saetze(z.get(0).get("kennzeichen"))).containsExactly("Gradtage G20/15",
                "Tagesmittel fehlen oder sind unvollständig", BEZOGEN, (tage - 3) + " von " + tage + " Tagen");
        JsonNode herkunft = MAPPER.readTree(String.valueOf(z.get(0).get("bezug")));
        assertThat(herkunft.get("zustand").asText()).isEqualTo("unvollständig");
        assertThat(herkunft.get("tage").asInt()).isEqualTo(tage - 3);
        assertThat(herkunft.get("tage_erwartet").asInt()).isEqualTo(tage);

        // Der nächste Abruf holt nach: Fassung 2 vollständig, Fassung 1 bleibt lesbar.
        stub.monat(MONAT, "5.0");
        abruf.lauf(TAKT.plusSeconds(7200), w.mandant());
        List<Map<String, Object>> alle = root.queryForList("SELECT fassung, vorgang, betrag, bezug_herkunft->>'zustand' "
                + "AS zustand FROM bezugsgroesse_wert WHERE tenant_id = ? AND bezugsgroesse_id = ? ORDER BY fassung",
                w.mandant(), bz);
        assertThat(alle).extracting(m -> m.get("fassung") + " " + m.get("vorgang") + " " + m.get("zustand") + " "
                + ((BigDecimal) m.get("betrag")).stripTrailingZeros().toPlainString())
                .containsExactly("1 erstwert unvollständig " + (tage - 3) * 15, "2 berichtigung vollständig " + tage * 15);
        abruf.lauf(TAKT.plusSeconds(10800), w.mandant());
        assertThat(root.queryForObject("SELECT max(fassung) FROM bezugsgroesse_wert WHERE tenant_id = ? AND "
                + "bezugsgroesse_id = ?", Integer.class, w.mandant(), bz)).as("vollständig — keine dritte Fassung")
                .isEqualTo(2);
        assertThat(stub.anfragen).as("vollständig — kein weiterer Abruf").hasSize(4);
    }

    // ================================================================ ohne Koordinaten, Schalter

    @Test
    void standortOhneKoordinatenWirdNichtAbgerufenUndIstKeinFehler() {
        Welt w = welt(false);
        UUID bz = gradtagzahl(w, "tag", VON);
        Stub stub = new Stub().monat(MONAT, "5.0");

        WetterArchivAbruf.Lauf l = new WetterArchivAbruf(admin, MAPPER, stub).lauf(TAKT, w.mandant());

        assertThat(stub.anfragen).as("kein Abruf").isEmpty();
        assertThat(l.ohneKoordinaten()).isGreaterThanOrEqualTo(1);
        assertThat(l.fehler()).isZero();
        assertThat(werte(w, bz)).isEmpty();
    }

    @Test
    void imTestlaufIstDerSchalterAusUndEsGibtKeinenLaeufer() {
        assertThat(kontext.getBeanNamesForType(WetterArchivLaeufer.class))
                .as("voltpilot.uems.wetter-archiv.enabled=false (surefire) → kein Takt, kein Abruf").isEmpty();
        assertThat(kontext.getBean(WetterArchiv.class)).as("die ausgelieferte Quelle")
                .isInstanceOf(OpenMeteoWetterArchiv.class);
    }

    // ================================================================ R3: die Kennzahl liest das Kennzeichen mit

    @Test
    void dieKennzahlMitBz8NennerErbtDasKennzeichen() throws Exception {
        Welt w = welt(true);
        // Der Zähler ist eine eingegebene Menge (Gas der Verwaltung, m³) — die Kette hier ist der Nenner.
        UUID gas = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, standort_id, art) VALUES (?, 'BZ-9', 'Gas Verwaltung', 'periodenwert', 'm³', "
                + "'monat', 'standort', ?, 'sonstige_menge') RETURNING id", UUID.class, w.mandant(), w.standort());
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'm³', 'monat', ?, ?, 'Europe/Berlin', 1, "
                + "'erstwert', 'wirksam', 1240, 'eingabe', 'sub-jw', 'Jonas Wendlinger', 'kundenadministrator', 'kunde')",
                w.mandant(), gas, MONAT, GESTERN);
        gradtagzahl(w, "tag", MONAT);
        new WetterArchivAbruf(admin, MAPPER, new Stub().monat(MONAT, "10.5")).lauf(TAKT, w.mandant());
        anlegen(w, "KZ-0006", "quotient", "gebaeude", w.halle(), e("zaehler", "bezugsgroesse", "BZ-9"),
                e("nenner", "bezugsgroesse", "BZ-8"));

        lauf.lauf(ERSTER.plusDays(9).atTime(8, 0).atZone(ZONE).toInstant());

        Map<String, Object> v = root.queryForMap("SELECT w.id, w.wert, w.grund, w.menge_zustand, w.kennzeichen::text AS kennzeichen FROM kennzahl_wert w "
                + "JOIN kennzahl k ON k.id = w.kennzahl_id WHERE w.tenant_id = ? AND k.kennzeichen = 'KZ-0006' "
                + "AND w.periode_art = 'monat' AND w.periode_von = ? ORDER BY w.version DESC NULLS LAST LIMIT 1",
                w.mandant(), MONAT);
        assertThat(v.get("wert")).as("KZ-0006 hat eine Zahl: %s", v).isNotNull();
        BigDecimal nenner = new BigDecimal("9.5").multiply(BigDecimal.valueOf(MONAT.lengthOfMonth()));
        assertThat(new BigDecimal(String.valueOf(v.get("wert"))).setScale(4, java.math.RoundingMode.HALF_UP))
                .as("1 240 ÷ (Tage × 9,5 Kd)").isEqualByComparingTo(new BigDecimal("1240")
                        .divide(nenner, 4, java.math.RoundingMode.HALF_UP));
        List<Map<String, Object>> eingaenge = root.queryForList("SELECT rolle, kennzeichen::text AS kennzeichen "
                + "FROM kennzahl_wert_eingang WHERE wert_id = ? ORDER BY position", v.get("id"));
        assertThat(eingaenge.stream().filter(e -> "nenner".equals(e.get("rolle"))).findFirst().orElseThrow())
                .extracting(e -> saetze(e.get("kennzeichen"))).as("der Nenner nennt, was er gelesen hat")
                .isEqualTo(List.of(BEZOGEN));
        assertThat(saetze(v.get("kennzeichen"))).as("die Kennzahl erbt das Kennzeichen (R3)").contains(BEZOGEN);
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID unternehmen, UUID standort, UUID halle, UUID anlage,
            Map<String, UUID> messstellen, Map<String, UUID> komponenten, Map<String, UUID> kz) {}

    private record Antwort(int status, JsonNode body) {}

    /** Werk Ahrenberg (ST-1, 48.25 / 11.43) — oder Lindach ohne Koordinaten. */
    private Welt welt(boolean koordinaten) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Wetter #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand, lage_breitengrad, lage_laengengrad) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv', ?, ?) "
                + "RETURNING id", UUID.class, t, u, koordinaten ? "Werk Ahrenberg" : "Lindach",
                koordinaten ? "ST-1" : "ST-2", koordinaten ? new BigDecimal("48.25") : null,
                koordinaten ? new BigDecimal("11.43") : null);
        UUID halle = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, "
                + "'gebaeude', 'Verwaltung', 'G-3', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, halle, st);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, "Verwaltung #" + nr, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        return new Welt(t, u, st, halle, anlage, new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>());
    }

    /** BZ-8 Gradtagzahl am Standort, vom Kunden angelegt und an die bezogene Temperatur gebunden (R3). */
    private static UUID gradtagzahl(Welt w, String periode, LocalDate von) {
        UUID bz = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, standort_id, art) VALUES (?, 'BZ-8', 'Gradtagzahl Werk Ahrenberg', "
                + "'periodenwert', 'Kd', ?, 'standort', ?, 'gradtagzahl') RETURNING id", UUID.class, w.mandant(), periode,
                w.standort());
        root.update("INSERT INTO bezugsgroesse_wetterbezug (tenant_id, bezugsgroesse_id, von, actor_name, actor_art) "
                + "VALUES (?, ?, ?, 'Jonas Wendlinger', 'kunde')", w.mandant(), bz, von);
        return bz;
    }

    private static List<Map<String, Object>> werte(Welt w, UUID bz) {
        return root.queryForList("SELECT DISTINCT ON (periode_von) periode_von, fassung, vorgang, herkunft_art, "
                + "kennzeichen::text AS kennzeichen, bezug_herkunft::text AS bezug FROM bezugsgroesse_wert "
                + "WHERE tenant_id = ? AND bezugsgroesse_id = ? ORDER BY periode_von, fassung DESC", w.mandant(), bz);
    }

    private static String betrag(Welt w, UUID bz, LocalDate tag) {
        return root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE tenant_id = ? AND bezugsgroesse_id = ? "
                + "AND periode_von = ? ORDER BY fassung DESC LIMIT 1", BigDecimal.class, w.mandant(), bz, tag)
                .stripTrailingZeros().toPlainString();
    }

    private static String fingerabdruck(Welt w, UUID bz) {
        return root.queryForObject("SELECT count(*) || ':' || md5(string_agg(periode_von || '/' || fassung || '/' || betrag, "
                + "'|' ORDER BY periode_von, fassung)) FROM bezugsgroesse_wert WHERE tenant_id = ? AND bezugsgroesse_id = ?",
                String.class, w.mandant(), bz);
    }

    @SafeVarargs
    private final void anlegen(Welt w, String kennzeichen, String rechenform, String geltungArt, UUID geltung,
            Map<String, Object>... eingaenge) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", "Kennzahl " + kennzeichen);
        m.put("rechenform", rechenform);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        m.put("eingaenge", List.of(eingaenge));
        Antwort a = ruf(w, HttpMethod.POST, PFAD, m);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        w.kz().put(kennzeichen, UUID.fromString(a.body().get("id").asText()));
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
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

    private static List<String> saetze(Object json) {
        try {
            return json == null ? List.of() : MAPPER.readValue(json.toString(), new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
