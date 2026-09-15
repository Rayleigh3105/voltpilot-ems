package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
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
import org.springframework.beans.factory.annotation.Qualifier;
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
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Kaskaden-Naht der Kennzahlen an der Datenbank (UEMS AP-11 IP-8, E8 = A) — der Beweis des Konzepts: eine Korrektur an
 * einer Messreihe zieht sich ohne Zutun bis in jede Kennzahl durch, die davon lebt, und die alte Zahl bleibt lesbar.
 *
 * <p>K7 aus {@code kennzahl-vectors.json}: MS-12 Oktober 6 100 → 6 040 kWh (K-2026-0007) → Halle 2 (KZ-0001) Version 2 =
 * 0,1473, Unternehmen (KZ-0003) Version 2 = 0,2000, Lindach (KZ-0002) bleibt Version 1. Die Welt ist Ahrenberg 1.3 wie im
 * Rechenlauf ({@code UemsKennzahlRechenlaufTest}); Version 1 bildet der Regellauf.
 *
 * <p>Die Transaktion ist die der Korrektur-Kaskade: darin steht zuerst die Monats-Version 2 der Reihe von MS-12, genau
 * wie die Stufe sie schreibt ({@link KaskadeStufen#periodeSchreiben}), dann ruft die Naht mit dem {@code Betroffen}, das
 * die Kaskade baut. Die Stufen selbst (Viertelstunde bis Jahr aus einer freigegebenen Vorschau) beweist
 * {@code UemsKorrekturKaskadeTest}; dass die Kaskade diese Naht bekommt, prüft hier der volle Kontext.
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsKennzahlKaskadeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "kennzahl-vectors.json");
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final String OKTOBER = "?periode=monat&von=2026-10-01&bis=2026-10-31";
    private static final LocalDate OKT_1 = LocalDate.parse("2026-10-01");
    private static final LocalDate OKT_31 = LocalDate.parse("2026-10-31");
    private static final String K7 = "K-2026-0007";
    /** Version 1: der Regellauf nach dem Monatsende, als BZ-6 und BZ-7 eingetragen sind. */
    private static final Instant T_V1 = Instant.parse("2026-11-10T08:00:00Z");
    /** Die Kaskade: im Takt der Freigabe von K-2026-0007 (12.11.2026 10:05:33, Referenzdatei 1.4). */
    private static final Instant T_KASKADE = Instant.parse("2026-11-12T09:05:33Z");

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
    KennzahlenNaht naht;

    @Autowired
    KorrekturKaskade kaskade;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ K7: die Kaskade trifft, was betroffen ist

    /**
     * K7 in EINER Transaktion der Kaskade: KZ-0001 wird Version 2 = 0,1473, KZ-0003 liest sie schon und wird Version 2 =
     * 0,2000 — beide „korrigiert (Version 2)“, byte-gleich zum Vertrag, mit dem Anlass K-2026-0007 und der Meldung
     * {@code kennzahl_neu_gebildet}. KZ-0002 (Lindach) lebt nicht von MS-12: Zeile für Zeile unberührt, Version 1, keine
     * Meldung. Die Definitions-Fassung bleibt 1 — die Wert-Version ist die andere Achse.
     */
    @Test
    void k7HalleZweiUndUnternehmenWerdenVersionZweiUndLindachBleibtVersionEins() throws Exception {
        assertThat(naht).as("der volle Kontext füllt die Naht").isInstanceOf(KennzahlKaskade.class);
        assertThat(ReflectionTestUtils.getField(kaskade, "kennzahlen")).as("die Kaskade bekommt sie").isSameAs(naht);

        Welt w = k7Welt();
        gleichDemVektor(zeile(w, "KZ-0001"), ergebnis("K1", "wert", 0), "KZ-0001 Version 1");
        String lindachVorher = kennzahlZeilen(w, "KZ-0002");

        inDerKaskade(con -> {
            ms12Version2(con, w);
            naht.nachKorrektur(con, betroffen(w, "MS-12", T_KASKADE));
        });

        Map<String, Object> halle2 = zeile(w, "KZ-0001");
        gleichDemVektor(halle2, ergebnis("K7", "wert", 0), "K7 KZ-0001");
        assertThat(zahl(halle2.get("wert")).setScale(4, RoundingMode.HALF_UP)).isEqualByComparingTo("0.1473");
        herkunftGleich(halle2, herkunft("K7"), "K7 KZ-0001");
        assertThat(halle2.get("anlass_art")).isEqualTo("eingang");
        assertThat(halle2.get("anlass_kennung")).as("der Beleg, wie die Herkunft ihn zeigt")
                .isEqualTo("K-2026-0007 (freigegeben 12.11.2026)");
        assertThat(halle2.get("definition_fassung")).as("Fassung und Version sind zwei Achsen").isEqualTo(1);

        Map<String, Object> unternehmen = zeile(w, "KZ-0003");
        gleichDemVektor(unternehmen, ergebnis("K7", "wert", 1), "K7 KZ-0003");
        assertThat(zahl(unternehmen.get("wert")).setScale(4, RoundingMode.HALF_UP)).isEqualByComparingTo("0.2000");
        assertThat(unternehmen.get("anlass_kennung")).isEqualTo("K-2026-0007 (freigegeben 12.11.2026)");
        assertThat(eingaenge(unternehmen)).extracting(e -> e.get("objekt") + " v" + e.get("version"))
                .as("das Unternehmen las Halle 2 in Version 2, Lindach in Version 1")
                .containsExactly("KZ-0001 v2", "KZ-0002 v1");
        // IP-11: das laufende Jahr der Zusammenfassung zieht in DERSELBEN Transaktion nach (vorläufig, dieselbe Version) —
        // Summe durch Summe über den korrigierten Oktober, als Herkunft seine Paare.
        Map<String, Object> jahr = root.queryForMap("SELECT w.id, w.version, w.zaehler, w.nenner, w.zustand "
                + "FROM kennzahl_wert w JOIN kennzahl k ON k.id = w.kennzahl_id WHERE w.tenant_id = ? "
                + "AND k.kennzeichen = 'KZ-0003' AND w.periode_art = 'jahr' AND w.periode_von = '2026-01-01' "
                + "ORDER BY w.version DESC NULLS LAST, w.berechnet_am DESC LIMIT 1", w.mandant());
        assertThat(zahl(jahr.get("zaehler"))).as("6 040 + 3 600").isEqualByComparingTo("9640");
        assertThat(zahl(jahr.get("nenner"))).isEqualByComparingTo("48200");
        assertThat(jahr.get("version")).isEqualTo(1);
        assertThat(jahr.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(eingaenge(jahr)).extracting(e -> e.get("rolle") + " " + e.get("objekt"))
                .containsExactly("paar KZ-0001", "paar KZ-0002");

        assertThat(kennzahlZeilen(w, "KZ-0002")).as("Lindach: Zeile für Zeile unberührt").isEqualTo(lindachVorher);
        assertThat(zeile(w, "KZ-0002").get("version")).isEqualTo(1);
        assertThat(anzahl(w, "KZ-0002")).isEqualTo(1);

        assertThat(meldungen(w)).containsExactly(
                "KZ-0001|K-2026-0007|2|cloud|2026-09-30T22:00:00Z|2026-10-31T23:00:00Z",
                "KZ-0003|K-2026-0007|2|cloud|2026-09-30T22:00:00Z|2026-10-31T23:00:00Z");
    }

    /**
     * Die alte Zahl bleibt lesbar — über die Route aus IP-7, nicht über eine eigene Abfrage: aktuell Version 2 mit ihrer
     * Herkunft gleich dem Vertrag, {@code ?version=1} die damalige 0,1488, und {@code …/werte/versionen} nennt beide mit
     * „was vorher“ und dem Beleg der Korrektur. Das Unternehmen ebenso (0,2012 → 0,2000). Die Route liefert ungerundeten
     * Dezimaltext (gerechnet 6 040 ÷ 41 000 = 0,1473170732, gerundet wird im Portal) — verglichen wird darum wie im Vertrag
     * auf vier Stellen (U4), Zahl für Zahl, auch in der Herkunft.
     */
    @Test
    void k7DieAlteZahlBleibtUnterWerteVersionenLesbar() throws Exception {
        Welt w = k7Welt();
        inDerKaskade(con -> {
            ms12Version2(con, w);
            naht.nachKorrektur(con, betroffen(w, "MS-12", T_KASKADE));
        });
        String kz1 = PFAD + "/" + w.kz().get("KZ-0001");

        JsonNode v2 = einziger(ok(ruf(w, kz1 + "/werte" + OKTOBER)));
        assertThat(vier(v2.get("wert"))).isEqualTo("0.1473");
        assertThat(v2.get("version").asInt()).isEqualTo(2);
        assertThat(v2.get("versionen").asInt()).isEqualTo(2);
        assertThat(texte(v2.get("kennzeichen"))).containsExactly("berechnet (Kennzahl)", "korrigiert (Version 2)");
        assertThat(MAPPER.writeValueAsString(aufVierStellen(v2.get("herkunft"))))
                .isEqualTo(MAPPER.writeValueAsString(aufVierStellen(pruefung("K7", "herkunft", 0).get("ergebnis"))));

        JsonNode v1 = einziger(ok(ruf(w, kz1 + "/werte" + OKTOBER + "&version=1")));
        assertThat(vier(v1.get("wert"))).as("die damalige Zahl").isEqualTo("0.1488");
        assertThat(texte(v1.get("kennzeichen"))).containsExactly("berechnet (Kennzahl)");

        JsonNode h = ok(ruf(w, kz1 + "/werte/versionen?periode=monat&von=2026-10-01")).get("versionen");
        assertThat(h).hasSize(2);
        assertThat(vier(h.get(0).get("wert_neu").get("wert"))).isEqualTo("0.1488");
        assertThat(vier(h.get(1).get("wert_alt").get("wert"))).as("was vorher dastand").isEqualTo("0.1488");
        assertThat(vier(h.get(1).get("wert_neu").get("wert"))).isEqualTo("0.1473");
        assertThat(h.get(1).get("gebildet_am").asText()).isEqualTo("2026-11-12T10:05:33+01:00");
        assertThat(h.get(1).get("anlass").get("art").asText()).isEqualTo("eingang");
        assertThat(h.get(1).get("anlass").get("beleg").asText()).isEqualTo("K-2026-0007 (freigegeben 12.11.2026)");
        assertThat(h.get(1).get("entscheidungen").get(0).get("wer").get("name").asText()).isEqualTo("Ines Kaltenbach");

        JsonNode u = ok(ruf(w, PFAD + "/" + w.kz().get("KZ-0003") + "/werte/versionen?periode=monat&von=2026-10-01"))
                .get("versionen");
        assertThat(u).hasSize(2);
        assertThat(zahl(u.get(1).get("wert_alt").get("wert").asText()).setScale(4, RoundingMode.HALF_UP))
                .isEqualByComparingTo("0.2012");
        assertThat(zahl(u.get(1).get("wert_neu").get("wert").asText()).setScale(4, RoundingMode.HALF_UP))
                .isEqualByComparingTo("0.2000");
        JsonNode lindach = ok(ruf(w, PFAD + "/" + w.kz().get("KZ-0002") + "/werte/versionen?periode=monat&von=2026-10-01"))
                .get("versionen");
        assertThat(lindach).as("Lindach hat nur Version 1").hasSize(1);
    }

    // ================================================================ keine halbe Wahrheit

    /**
     * Ein Fehler IN der Naht rollt die ganze Kaskade zurück: KZ-0001 hat ihre Version 2 schon geschrieben, als KZ-0003 an
     * der Datenbank scheitert — danach steht weder die Monats-Version der Reihe noch irgendeine Kennzahl-Version noch eine
     * Meldung da, Tabelle für Tabelle wie vorher. Der nächste Takt ohne den Fehler bildet alles vollständig.
     */
    @Test
    void einFehlerInDerNahtRolltDieGanzeKaskadeZurueck() throws Exception {
        Welt w = k7Welt();
        String vorher = kaskadenTabellen(w);
        UUID kz1 = w.kz().get("KZ-0001");
        UUID kz3 = w.kz().get("KZ-0003");
        // Der Fehler sitzt in der Datenbank und sieht die Transaktion der Kaskade: er sagt, was bis zu ihm schon stand.
        root.execute("CREATE OR REPLACE FUNCTION test_kennzahl_kaskade_bricht() RETURNS trigger LANGUAGE plpgsql AS $$ "
                + "BEGIN RAISE EXCEPTION 'KZ-0003 nicht erreichbar (KZ-0001 Version 2 geschrieben: %, MS-12 Version 2 "
                + "geschrieben: %)', EXISTS (SELECT 1 FROM kennzahl_wert WHERE kennzahl_id = '" + kz1 + "' AND version = 2), "
                + "EXISTS (SELECT 1 FROM messreihe_periode_version WHERE tenant_id = NEW.tenant_id AND anlass_kennung = '"
                + K7 + "'); END $$");
        root.execute("CREATE TRIGGER test_kennzahl_kaskade_bricht BEFORE INSERT ON kennzahl_wert FOR EACH ROW "
                + "WHEN (NEW.kennzahl_id = '" + kz3 + "') EXECUTE FUNCTION test_kennzahl_kaskade_bricht()");
        try {
            assertThatThrownBy(() -> inDerKaskade(con -> {
                ms12Version2(con, w);
                naht.nachKorrektur(con, betroffen(w, "MS-12", T_KASKADE));
            })).as("der Fehler kam NACH der Neubildung von KZ-0001 und nach der Stufe der Reihe")
                    .hasStackTraceContaining("KZ-0003 nicht erreichbar (KZ-0001 Version 2 geschrieben: t, "
                            + "MS-12 Version 2 geschrieben: t)");
        } finally {
            root.execute("DROP TRIGGER IF EXISTS test_kennzahl_kaskade_bricht ON kennzahl_wert");
            root.execute("DROP FUNCTION IF EXISTS test_kennzahl_kaskade_bricht()");
        }
        assertThat(kaskadenTabellen(w)).as("nichts Halbes bleibt").isEqualTo(vorher);
        assertThat(zeile(w, "KZ-0001").get("version")).isEqualTo(1);

        inDerKaskade(con -> {
            ms12Version2(con, w);
            naht.nachKorrektur(con, betroffen(w, "MS-12", T_KASKADE.plusSeconds(300)));
        });
        assertThat(zeile(w, "KZ-0001").get("version")).isEqualTo(2);
        assertThat(zeile(w, "KZ-0003").get("version")).isEqualTo(2);
        assertThat(meldungen(w)).hasSize(2);
    }

    /**
     * Nur was wirklich betroffen ist: eine Korrektur an der Reihe von MS-10 (Hauptzähler Halle 2 — keine Kennzahl liest
     * ihn) schreibt keine Kennzahl-Zeile, und ein zweiter Durchlauf derselben Korrektur findet nichts Neues (V3): keine
     * Zeile, keine Version 3, keine zweite Meldung.
     */
    @Test
    void unbetroffenOderZweimalSchreibtNichts() throws Exception {
        Welt w = k7Welt();
        String vorher = kennzahlTabellen(w);
        inDerKaskade(con -> naht.nachKorrektur(con, betroffen(w, "MS-10", T_KASKADE)));
        assertThat(kennzahlTabellen(w)).as("MS-10 liest keine Kennzahl").isEqualTo(vorher);

        inDerKaskade(con -> {
            ms12Version2(con, w);
            naht.nachKorrektur(con, betroffen(w, "MS-12", T_KASKADE));
        });
        String nachK7 = kennzahlTabellen(w);
        List<String> meldungen = meldungen(w);
        inDerKaskade(con -> naht.nachKorrektur(con, betroffen(w, "MS-12", T_KASKADE.plusSeconds(300))));
        assertThat(kennzahlTabellen(w)).as("zweimal verarbeitet schreibt beim zweiten Mal nichts").isEqualTo(nachK7);
        assertThat(meldungen(w)).isEqualTo(meldungen).hasSize(2);
    }

    // ================================================================ die Kaskade im Test

    @FunctionalInterface
    private interface Schritt {
        void fahren(Connection con) throws SQLException;
    }

    /** EINE Transaktion wie ein Anlass der Kaskade: alles oder nichts, als Verwaltungsrolle. */
    private void inDerKaskade(Schritt schritt) {
        admin.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                schritt.fahren(con);
                con.commit();
                return null;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("Kaskade abgebrochen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    /** Die Monats-Version 2 der Reihe von MS-12, so wie die Monats-Stufe der Kaskade sie schreibt: 6 040 kWh, endgültig. */
    private static void ms12Version2(Connection con, Welt w) throws SQLException {
        Instant b = OKT_1.atStartOfDay(ZONE).toInstant();
        Instant e = OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int minuten = (int) ChronoUnit.MINUTES.between(b, e);
        KaskadeStufen.Inhalt inhalt = new KaskadeStufen.Inhalt("counter", new BigDecimal("6040"), "vollständig", List.of(),
                minuten, minuten, 100, null, null, null, null, null, null, null, null, null, null, null, "endgueltig");
        KaskadeStufen.periodeSchreiben(con, new KaskadeStufen.Periode(w.mandant(), "monat", w.komponenten().get("MS-12"),
                ENERGIE, null, b, e, OKT_1, ZONE), 2, inhalt, List.of(K7), List.of(), K7, 2, null);
    }

    /** Was die Kaskade nach K-2026-0007 an die Nähte gibt: die Reihe, der Oktober, der Zeitpunkt des Laufs. */
    private static KorrekturKaskade.Betroffen betroffen(Welt w, String messstelle, Instant jetzt) {
        return new KorrekturKaskade.Betroffen(w.mandant(), K7, 2, KorrekturKaskade.FREIGEGEBEN,
                List.of(new KorrekturKaskade.Reihe(w.komponenten().get(messstelle), ENERGIE)),
                OKT_1.atStartOfDay(ZONE).toInstant(), OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant(), ZONE, OKT_1,
                OKT_31, List.of(), List.of(), 1, jetzt);
    }

    /** Ahrenberg im Oktober, die drei Kennzahlen aus K1–K3, Version 1 aus dem Regellauf, die Korrektur K-2026-0007. */
    private Welt k7Welt() throws Exception {
        Welt w = welt();
        monat(w, "MS-12", "6100", List.of());
        monat(w, "MS-18", "3600", List.of("ab 15.10.2026"));
        bezugswert(w, "BZ-6", "41000");
        bezugswert(w, "BZ-7", "7200");
        w.kz().put("KZ-0001", anlegen(w, "KZ-0001", "quotient", "gebaeude", w.g2(), e("zaehler", "messstelle", "MS-12"),
                e("nenner", "bezugsgroesse", "BZ-6")));
        w.kz().put("KZ-0002", anlegen(w, "KZ-0002", "quotient", "gebaeude", w.g5(), e("zaehler", "messstelle", "MS-18"),
                e("nenner", "bezugsgroesse", "BZ-7")));
        w.kz().put("KZ-0003", anlegen(w, "KZ-0003", "zusammenfassung", "unternehmen", w.unternehmen(),
                e("paar", "kennzahl", "KZ-0001"), e("paar", "kennzahl", "KZ-0002")));
        korrekturK7(w);
        lauf.lauf(T_V1);
        assertThat(zeile(w, "KZ-0003").get("version")).as("Version 1 vor der Kaskade").isEqualTo(1);
        assertThat(zeile(w, "KZ-0003").get("zustand")).isEqualTo("endgueltig");
        return w;
    }

    /** K-2026-0007 wie in der Referenzdatei 1.4 — vorgeschlagen am 11.11., freigegeben am 12.11.2026 10:05:33. */
    private static void korrekturK7(Welt w) {
        String reihen = MAPPER.createArrayNode().add(MAPPER.createObjectNode()
                .put("entity_id", w.komponenten().get("MS-12").toString()).put("messkanal", ENERGIE)).toString();
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, "
                + "'K-2026-0007', 1, 'vorschlag', 'nachlieferung_nach_endgueltigkeit', ?::jsonb, "
                + "'2026-10-01T00:00:00+02:00', '2026-11-01T00:00:00+01:00', ?, '[{}]'::jsonb, 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-11-11T16:40:00+01:00')", w.mandant(), reihen,
                "Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)");
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art, created_at) VALUES (?, 'K-2026-0007', 2, 'freigegeben', NULL, "
                + "'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-11-12T10:05:33+01:00')",
                w.mandant());
    }

    // ================================================================ lesen

    private static Map<String, Object> zeile(Welt w, String kennzahl) {
        List<Map<String, Object>> z = root.queryForList("SELECT w.id, w.version, w.wert, w.zaehler, w.nenner, "
                + "w.menge_zustand, w.kennzeichen::text AS kennzeichen, w.abdeckung_prozent, w.richtung, w.grund, w.zustand, "
                + "w.endgueltig_ab, w.anlass_art, w.anlass_kennung, f.nummer AS definition_fassung FROM kennzahl_wert w "
                + "JOIN kennzahl k ON k.id = w.kennzahl_id JOIN kennzahl_fassung f ON f.id = w.definition_fassung_id "
                + "WHERE w.tenant_id = ? AND k.kennzeichen = ? AND w.periode_art = 'monat' AND w.periode_von = ? "
                + "ORDER BY w.version DESC NULLS LAST, w.berechnet_am DESC LIMIT 1", w.mandant(), kennzahl, OKT_1);
        assertThat(z).as(kennzahl + " Oktober hat eine Zeile").hasSize(1);
        return z.get(0);
    }

    private static long anzahl(Welt w, String kennzahl) {
        return root.queryForObject("SELECT count(*) FROM kennzahl_wert v JOIN kennzahl k ON k.id = v.kennzahl_id "
                + "WHERE v.tenant_id = ? AND k.kennzeichen = ? AND v.periode_art = 'monat' AND v.periode_von = ?",
                Long.class, w.mandant(), kennzahl, OKT_1);
    }

    private static List<Map<String, Object>> eingaenge(Map<String, Object> zeile) {
        return root.queryForList("SELECT position, rolle, art, objekt, wert, zaehler, nenner, einheit, menge_zustand, "
                + "abdeckung_prozent, version, fassung, kennzeichen::text AS kennzeichen FROM kennzahl_wert_eingang "
                + "WHERE wert_id = ? ORDER BY position", zeile.get("id"));
    }

    /** Die Meldungen {@code kennzahl_neu_gebildet} des Kundenbereichs: Kennzahl|Auslöser|Version|Urheber|von|bis. */
    private static List<String> meldungen(Welt w) {
        return root.queryForList("SELECT concat_ws('|', kennungen ->> 'kennzahl', nutzlast ->> 'ausloeser', "
                + "nutzlast ->> 'version', urheber, to_char(von AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), "
                + "to_char(bis AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) FROM messreihe_ereignis "
                + "WHERE tenant_id = ? AND art = 'kennzahl_neu_gebildet' ORDER BY 1", String.class, w.mandant());
    }

    /** Die Zeilen EINER Kennzahl mit ihren Eingängen, Zeile für Zeile. */
    private static String kennzahlZeilen(Welt w, String kennzahl) {
        return root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg(t::text || e.t::text, '|' ORDER BY "
                + "t::text)), '-') FROM kennzahl_wert t JOIN kennzahl k ON k.id = t.kennzahl_id "
                + "LEFT JOIN LATERAL (SELECT string_agg(x::text, ';' ORDER BY x.position) AS t FROM kennzahl_wert_eingang x "
                + "WHERE x.wert_id = t.id) e ON true WHERE t.tenant_id = ? AND k.kennzeichen = ?", String.class,
                w.mandant(), kennzahl);
    }

    /** Die Kennzahl-Werte des Kundenbereichs, Zeile für Zeile. */
    private static String kennzahlTabellen(Welt w) {
        return tabellen(w, List.of("kennzahl_wert", "kennzahl_wert_eingang", "messreihe_ereignis"));
    }

    /** Alles, was eine Kaskade im Kundenbereich schreiben kann — Messreihen-Versionen, Kennzahl-Werte, Meldungen. */
    private static String kaskadenTabellen(Welt w) {
        return tabellen(w, List.of("messreihe_periode_version", "kennzahl_wert", "kennzahl_wert_eingang",
                "messreihe_ereignis"));
    }

    private static String tabellen(Welt w, List<String> namen) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : namen) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg("
                    + "t::text, '|' ORDER BY t::text)), '-') FROM " + tabelle + " t WHERE t.tenant_id = ?", String.class,
                    w.mandant())).append('\n');
        }
        return s.toString();
    }

    // ================================================================ der Vertrag

    private static JsonNode pruefung(String fall, String regel, int index) {
        for (JsonNode c : vertrag.get("cases")) {
            if (c.get("id").asText().equals(fall)) {
                List<JsonNode> treffer = new ArrayList<>();
                c.get("pruefungen").forEach(p -> {
                    if (p.get("regel").asText().equals(regel)) {
                        treffer.add(p);
                    }
                });
                return treffer.get(index);
            }
        }
        throw new AssertionError("Fall " + fall + " fehlt");
    }

    private static JsonNode ergebnis(String fall, String regel, int index) {
        return pruefung(fall, regel, index).get("ergebnis");
    }

    private static JsonNode herkunft(String fall) {
        return pruefung(fall, "herkunft", 0).get("eingang");
    }

    /** Die gespeicherte Zeile gleich dem Ergebnis der Regel im Vertrag — Zahlen auf die Vergleichsstellen (U4). */
    private static void gleichDemVektor(Map<String, Object> z, JsonNode erw, String was) {
        zahlGleich(z.get("wert"), erw.get("wert"), was + " wert");
        zahlGleich(z.get("zaehler"), erw.get("zaehler"), was + " zaehler");
        zahlGleich(z.get("nenner"), erw.get("nenner"), was + " nenner");
        zahlGleich(z.get("abdeckung_prozent"), erw.get("abdeckung_prozent"), was + " abdeckung");
        assertThat(z.get("menge_zustand")).as(was + " zustand").isEqualTo(erw.get("zustand").asText());
        assertThat(z.get("richtung")).as(was + " richtung").isEqualTo(text(erw.get("richtung")));
        assertThat(z.get("grund")).as(was + " grund").isEqualTo(text(erw.get("grund")));
        assertThat(fassungWort(z.get("zustand"))).as(was + " fassung").isEqualTo(text(erw.get("fassung")));
        assertThat(z.get("version")).as(was + " version").isEqualTo(erw.get("version").isNull() ? null
                : erw.get("version").asInt());
        assertThat(saetze(z.get("kennzeichen"))).as(was + " kennzeichen")
                .containsExactlyElementsOf(texte(erw.get("kennzeichen")));
    }

    /** Die Eingänge der gespeicherten Herkunft gleich den Eingängen des Herkunft-Vektors. */
    private static void herkunftGleich(Map<String, Object> z, JsonNode erw, String was) {
        List<Map<String, Object>> ist = eingaenge(z);
        JsonNode soll = erw.get("eingaenge");
        assertThat(ist).as(was + " Eingänge").hasSize(soll.size());
        for (int i = 0; i < soll.size(); i++) {
            Map<String, Object> e = ist.get(i);
            JsonNode s = soll.get(i);
            String wo = was + " Eingang " + i;
            assertThat(e.get("rolle")).as(wo + " rolle").isEqualTo(s.get("rolle").asText());
            assertThat(e.get("objekt")).as(wo + " objekt").isEqualTo(s.get("objekt").asText());
            assertThat(e.get("menge_zustand")).as(wo + " zustand").isEqualTo(s.get("zustand").asText());
            zahlGleich(e.get("wert"), s.get("wert"), wo + " wert");
            assertThat(e.get("version")).as(wo + " version").isEqualTo(s.get("version").isNull() ? null
                    : s.get("version").asInt());
            assertThat(e.get("fassung")).as(wo + " fassung").isEqualTo(s.get("fassung").isNull() ? null
                    : s.get("fassung").asInt());
            assertThat(saetze(e.get("kennzeichen"))).as(wo + " kennzeichen")
                    .containsExactlyElementsOf(texte(s.get("kennzeichen")));
        }
    }

    private static void zahlGleich(Object ist, JsonNode soll, String was) {
        if (soll == null || soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isNotNull();
        assertThat(zahl(ist).setScale(4, RoundingMode.HALF_UP)).as(was)
                .isEqualByComparingTo(new BigDecimal(soll.asText()).setScale(4, RoundingMode.HALF_UP));
    }

    /** Ein Dezimaltext der Route auf die Vergleichsstellen des Vertrags (U4). */
    private static String vier(JsonNode n) {
        return new BigDecimal(n.asText()).setScale(4, RoundingMode.HALF_UP).toPlainString();
    }

    /** Jeder Dezimaltext eines Baums auf vier Stellen (U4) — Struktur, Wörter und Reihenfolge bleiben, wie sie sind. */
    private static JsonNode aufVierStellen(JsonNode n) {
        if (n.isTextual() && n.asText().matches("-?[0-9]+(\\.[0-9]+)?")) {
            return TextNode.valueOf(new BigDecimal(n.asText()).setScale(4, RoundingMode.HALF_UP).stripTrailingZeros()
                    .toPlainString());
        }
        if (n.isObject()) {
            ObjectNode o = MAPPER.createObjectNode();
            n.fields().forEachRemaining(f -> o.set(f.getKey(), aufVierStellen(f.getValue())));
            return o;
        }
        if (n.isArray()) {
            ArrayNode a = MAPPER.createArrayNode();
            n.forEach(x -> a.add(aufVierStellen(x)));
            return a;
        }
        return n;
    }

    private static BigDecimal zahl(Object o) {
        return o == null ? null : new BigDecimal(o.toString());
    }

    private static String fassungWort(Object zustand) {
        return zustand == null ? null : "endgueltig".equals(zustand) ? "endgültig" : "vorläufig";
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static List<String> saetze(Object json) {
        try {
            return json == null ? List.of() : MAPPER.readValue(json.toString(), new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    // ================================================================ die Welt (Ahrenberg 1.3, wie im Rechenlauf)

    private record Welt(UUID mandant, UUID unternehmen, UUID g2, UUID g5, UUID halle2, UUID lindach,
            Map<String, UUID> messstellen, Map<String, UUID> komponenten, Map<String, UUID> kz) {}

    private record Antwort(int status, JsonNode body) {}

    /** ST-1 mit Halle 2 (MS-10, MS-12), ST-2 mit der Montagehalle Lindach (MS-16, MS-18), BZ-6/BZ-7. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Kaskade #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        Welt w = new Welt(t, u, gebaeude(t, st1, "Halle 2", "G-2"), gebaeude(t, st2, "Montagehalle Lindach", "G-5"),
                anlage(t, "Halle 2 #" + nr), anlage(t, "Lindach #" + nr), new LinkedHashMap<>(), new LinkedHashMap<>(),
                new LinkedHashMap<>());
        messstelle(w, "MS-10", w.halle2(), "Hauptzähler", null);
        messstelle(w, "MS-12", w.halle2(), "Unterzähler", "MS-10");
        messstelle(w, "MS-16", w.lindach(), "Hauptzähler", null);
        messstelle(w, "MS-18", w.lindach(), "Unterzähler", "MS-16");
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-6', 'Gutteile Montage Halle 2', 'periodenwert', 'Stück', 'monat', 'gebaeude', ?)",
                t, w.g2());
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-7', 'Gutteile Montage Lindach', 'periodenwert', 'Stück', 'monat', 'gebaeude', ?)",
                t, w.g5());
        return w;
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

    private static UUID anlage(UUID t, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
    }

    /** Box, Komponente, Mess-Selektion des Zählerstands, gemessene Messstelle mit führender Quelle, Stellung. */
    private static void messstelle(Welt w, String kennzeichen, UUID anlage, String stellung, String unterzaehlerVon) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-KASKADE-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, anlage,
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, anlage, box, komponente, ENERGIE, KATALOG);
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
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, anlage, stellung,
                unterzaehlerVon == null ? null : w.messstellen().get(unterzaehlerVon), LocalDate.parse("2020-01-01"));
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
    }

    /** Der gemessene, endgültige Oktober der Reihe einer Messstelle (AP-08 IP-5) — Version 1 der Verdichtung. */
    private static void monat(Welt w, String kennzeichen, String menge, List<String> saetze) throws Exception {
        Instant b = OKT_1.atStartOfDay(ZONE).toInstant();
        Instant e = OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int tage = OKT_1.lengthOfMonth();
        long stunden = ChronoUnit.HOURS.between(b, e);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', ?::jsonb, ?, ?, "
                + "100, 'endgueltig', ?, 1)", OKT_1, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE,
                Timestamp.from(b), Timestamp.from(e), stunden, tage, tage, tage, menge, MAPPER.writeValueAsString(saetze),
                stunden * 60, stunden * 60, Timestamp.from(e.plus(Duration.ofDays(7))));
    }

    /** Ein wirksamer Oktober-Wert einer Bezugsgröße, eingetragen nach dem Monatsende (E16). */
    private static void bezugswert(Welt w, String kennzeichen, String betrag) {
        UUID bg = root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                w.mandant(), kennzeichen);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'Stück', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", w.mandant(), bg, OKT_1, OKT_31, new BigDecimal(betrag),
                Timestamp.from(OKT_1.plusMonths(1).atStartOfDay(ZONE).plusHours(9).toInstant()));
    }

    // ================================================================ die Schnittstelle

    @SafeVarargs
    private UUID anlegen(Welt w, String kennzeichen, String rechenform, String geltungArt, UUID geltung,
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
        return UUID.fromString(a.body().get("id").asText());
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
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

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    private static JsonNode einziger(JsonNode werte) {
        assertThat(werte.get("werte")).as(werte.toString()).hasSize(1);
        return werte.get("werte").get(0);
    }
}
