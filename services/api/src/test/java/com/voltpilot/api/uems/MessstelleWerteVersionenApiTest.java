package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.MessreiheErsatzwertRepository.Anlage;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Abnahme von AP-08 IP-18 über die Route (Testcontainers): <b>eine Korrektur ist erst dann nachvollziehbar, wenn man
 * den alten Wert noch sieht.</b> {@code GET /api/v1/messstellen/{kennzeichen}/werte?version=} und
 * {@code GET …/werte/versionen} gegen Versionen, die die ECHTEN Läufe geschrieben haben.
 *
 * <p>F21 an MS-10 (Halle 2, Box-Tausch) aus dem Referenzunternehmen Ahrenberg: Version 1 bildet die Verdichtung
 * (03.11. 14:00 bis 04.11. 09:30 keine Werte, Tage unvollständig); Version 2 der Ersatzwert „Zuwachs gleichmäßig
 * verteilen“ (Ines Kaltenbach); Version 3 Widerruf („Profil aus Netzbetreiber-Lastgang verfügbar“) und der Ersatzwert
 * nach dem Profil der Vergleichsquelle vor demselben Lauf. Zahlen aus {@code verbrauch-vectors.json} Block
 * {@code ersatzwerte}, gerechnet von Ersatzwert-Lauf und Kaskade, nicht hier. Die Kennungen vergibt der Kundenbereich
 * selbst ({@code EW-2026-0001}/{@code -0002} statt der Vertragsnummern 0003/0005).
 *
 * <p>Dazu, weil F21 nur Ersatzwerte kennt: eine Viertelstunde mit einer freigegebenen Korrektur OHNE Grund, so
 * eingetragen, wie Vorschlags-Lauf und Kaskade sie schreiben (System-Vorschlag, Freigabe durch Jonas Wendlinger) — die
 * Historie sagt, dass das „warum“ fehlt, statt eines zu erfinden. Und ein fremder Kundenbereich mit DERSELBEN Kennung,
 * dessen Grund nie erscheint.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessstelleWerteVersionenApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_dev_pw";
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-0000000018a1");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-0000000018a3");

    private static final Instant LUECKE_VON = Instant.parse("2026-11-03T13:01:00Z");
    private static final Instant LUECKE_BIS = Instant.parse("2026-11-04T08:30:00Z");
    private static final Instant EW_VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final BigDecimal ZUWACHS = new BigDecimal("1872.0");
    private static final Instant JETZT = Instant.parse("2026-11-12T00:00:00Z");
    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");
    private static final String BEGRUENDUNG = "Box-Tausch nach Defekt; Energiekarte hat weitergezählt";
    private static final String WIDERRUF = "Profil aus Netzbetreiber-Lastgang verfügbar";
    private static final String BESSER = "Lastgang des Netzbetreibers liegt für den 03./04.11. vor";
    /** Die Korrektur ohne Grund an der Viertelstunde 03.11. 09:00 — und die fremde mit derselben Kennung. */
    private static final String KORREKTUR = "K-2026-0001";
    private static final Instant K_VIERTELSTUNDE = Instant.parse("2026-11-03T08:00:00Z");
    private static final String FREMDER_GRUND = "Fremder Kundenbereich: dieser Grund darf nie erscheinen";

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
    private static JdbcTemplate app;
    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static String ewA;
    private static String ewC;
    private static boolean aufgebaut;

    private record Antwort(int status, JsonNode body) {}

    // =========================================================================== Aufbau

    @BeforeEach
    void aufbauen() throws Exception {
        dienst.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));
        if (aufgebaut) {
            return;
        }
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        JdbcTemplate admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        stammdaten();
        rohwerte();
        MeasurementCatalog katalog = new MeasurementCatalog(MAPPER);
        SpaetankunftMelder melder = new SpaetankunftMelder();
        ViertelstundeVerdichter verdichter = new ViertelstundeVerdichter(admin, katalog, melder, 500, 40, 200_000);
        TagVerdichter tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        // Diese Welt hat keine berechnete Messstelle: der Hook antwortet leer.
        BerechnetePeriodenLauf berechnete = mock(BerechnetePeriodenLauf.class);
        when(berechnete.zoneDesKundenbereichs(any())).thenReturn(BERLIN);
        EndgueltigkeitLaeufer laeufer = new EndgueltigkeitLaeufer(new EndgueltigkeitLauf(admin, 2000, 200), tage,
                new PeriodeVerdichter(admin, katalog, 50, 40, 2000), berechnete,
                new KorrekturVorschlagLauf(admin, verdichter, melder, 200));
        MessreiheErsatzwertRepository ersatzwerte = new MessreiheErsatzwertRepository(app);
        ErsatzwertLauf lauf = new ErsatzwertLauf(admin, katalog, verdichter, 200);
        KorrekturKaskade kaskade = new KorrekturKaskade(admin, katalog, verdichter, lauf, berechnete,
                new KennzahlenNaht.Keine(), new BerichteNaht.Keine(), 50);

        // ---- Version 1 aller Stufen ---------------------------------------------------------------------------
        for (int i = 0; i < 200; i++) {
            ViertelstundeVerdichter.Lauf l = verdichter.lauf(JETZT);
            if (l.rueckrechnungFertig()
                    && root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde_arbeit", Integer.class) == 0) {
                break;
            }
        }
        tage.rueckrechnenGanz(JETZT, 200);
        laeufer.takt(JETZT);
        luecke();

        // ---- Version 2: der Zuwachs gleichmäßig verteilt (F11) -------------------------------------------------
        ewA = erfassen(ersatzwerte, verteilen("gleichmaessig_verteilen", BEGRUENDUNG, null));
        lauf.lauf(JETZT);
        kaskade.lauf(JETZT);

        // ---- Version 3: Widerruf und die bessere Methode vor DEMSELBEN Lauf (F21) --------------------------------
        als(KB, () -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .execute(s -> ersatzwerte.zuruecknehmen(KB, ewA, WIDERRUF, INES)));
        ewC = erfassen(ersatzwerte, verteilen("profil_vergleichsquelle", BESSER, IDS.get("Q-VQ")));
        lauf.lauf(JETZT);
        kaskade.lauf(JETZT);

        korrekturOhneGrund();
        fremderKundenbereich();
        aufgebaut = true;
    }

    // ============================================================ ?version= im Lese-Modell

    /**
     * F21 am Tag 03.11. und 04.11.: ohne Angabe Version 3 (die wirksame), mit {@code version=1}, {@code 2} und
     * {@code 3} je die Zahl, die damals galt — Zahl, Zustand, Abdeckung und Kennzeichen des Vertrags, nie die heutige
     * mit einem Etikett.
     */
    @Test
    void f21DerTagZeigtOhneAngabeDieNeuesteUndMitVersionDieDamaligeZahl() throws Exception {
        for (String[] t : new String[][] {{"2026-11-03", "Tag 03.11.2026"}, {"2026-11-04", "Tag 04.11.2026"}}) {
            JsonNode neueste = tag(t[0], null);
            JsonNode eins = tag(t[0], 1);
            JsonNode zwei = tag(t[0], 2);
            JsonNode drei = tag(t[0], 3);
            pruefe(eins, erwartung("F21 · Widerruf von EW-2026-0003", t[1] + " (Version 3, nur Widerruf)"), null, 1);
            pruefe(zwei, erwartung("F11 · EW-2026-0003", t[1] + " (Version 2)"), ewA, 2);
            pruefe(drei, erwartung("F21 · Widerruf und EW-2026-0005", t[1] + " (Version 3)"), ewC, 3);
            assertThat(neueste).isEqualTo(drei);
            for (JsonNode w : List.of(eins, zwei, drei)) {
                assertThat(w.path("versionen").asInt()).isEqualTo(3);
            }
            // Version 1 IST die Zeile der Verdichtung.
            Map<String, Object> zeile = root.queryForMap("SELECT menge, menge_zustand FROM messreihe_tag "
                    + "WHERE entity_id = ? AND tag = ?::date", IDS.get("ZW"), t[0]);
            assertThat(eins.path("menge").decimalValue()).isEqualByComparingTo((BigDecimal) zeile.get("menge"));
            assertThat(eins.path("zustand").asText()).isEqualTo(zeile.get("menge_zustand"));
        }
    }

    /**
     * Die Viertelstunde 03.11. 20:00 ganz in der Lücke: Version 1 hat KEINE Zeile und ist „keine Werte“ mit 0 von 15,
     * Version 2 24,0 kWh (gleichmäßig), Version 3 der Anteil nach dem Profil — und 14:00, die nur den Stand vor der
     * Lücke hat, trägt in Version 3 die Zahl des Vertrags.
     */
    @Test
    void f21DieViertelstundeInDerLueckeHatDreiVersionenUndVersionEinsIstKeineWerte() throws Exception {
        String q = "2026-11-03T20:00:00+01:00";
        String bis = "2026-11-03T20:15:00+01:00";
        JsonNode eins = schritt(ok(werte(KB, "MS-10", "viertelstunde", q, bis, 1)));
        assertThat(eins.path("menge").isNull()).isTrue();
        assertThat(eins.path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(eins.path("erhalten").asInt()).isZero();
        assertThat(eins.path("erwartet").asInt()).isEqualTo(15);
        assertThat(eins.path("versionen").asInt()).isEqualTo(3);
        pruefe(schritt(ok(werte(KB, "MS-10", "viertelstunde", q, bis, 2))),
                erwartung("F11 · EW-2026-0003", "Viertelstunde 03.11. 20:00–20:15 (Version 2) — ganz in der Lücke"),
                ewA, 2);
        JsonNode drei = schritt(ok(werte(KB, "MS-10", "viertelstunde", q, bis, null)));
        assertThat(drei.path("version").asInt()).isEqualTo(3);
        assertThat(drei.path("menge").decimalValue()).isEqualByComparingTo(root.queryForObject(
                "SELECT menge FROM messreihe_viertelstunde_version WHERE entity_id = ? AND intervall_beginn = ? "
                        + "AND version = 3", BigDecimal.class, IDS.get("ZW"),
                Timestamp.from(Instant.parse("2026-11-03T19:00:00Z"))));
        assertThat(texte(drei.path("kennzeichen"))).containsExactly(
                ErgebnisZustand.ersatzwert("profil_vergleichsquelle", ewC), ErgebnisZustand.korrigiert(3));
        pruefe(schritt(ok(werte(KB, "MS-10", "viertelstunde", "2026-11-03T14:00:00+01:00",
                        "2026-11-03T14:15:00+01:00", 3))),
                erwartung("F21 · Widerruf und EW-2026-0005", "Viertelstunde 03.11. 14:00–14:15 (Version 3)"), ewC, 3);
    }

    /**
     * Falle 1: Version 5, wo es drei gibt, ist die benannte Ablehnung 404 {@code version_gibt_es_nicht} mit der
     * neuesten — nie leer, nie stillschweigend Version 3. Fehlt eine Version nur an einzelnen Schritten eines Zeitraums,
     * nennen diese {@code version_nicht_gespeichert} und ihre neueste.
     */
    @Test
    void eineVersionDieEsNichtGibtWirdBenanntAbgelehnt() throws Exception {
        Antwort fuenf = werte(KB, "MS-10", "tag", "2026-11-03", "2026-11-03", 5);
        assertThat(fuenf.status()).as(fuenf.body().toString()).isEqualTo(404);
        assertThat(fuenf.body().path("code").asText()).isEqualTo("version_gibt_es_nicht");
        assertThat(fuenf.body().path("feld").asText()).isEqualTo("version");
        assertThat(fuenf.body().path("version").asInt()).isEqualTo(5);
        assertThat(fuenf.body().path("hoechste_version").asInt()).isEqualTo(3);
        assertThat(fuenf.body().path("message").asText())
                .isEqualTo("Version 5 gibt es für diesen Zeitraum nicht — die neueste ist Version 3.");
        assertThat(werte(KB, "MS-10", "monat", "2026-11-01", "2026-11-30", 4).status()).isEqualTo(404);

        JsonNode zeitraum = ok(werte(KB, "MS-10", "viertelstunde", "2026-11-03T13:45:00+01:00",
                "2026-11-03T14:15:00+01:00", 3));
        JsonNode davor = zeitraum.path("werte").get(0);
        assertThat(davor.path("menge").isNull()).isTrue();
        assertThat(davor.path("zustand").isNull()).isTrue();
        assertThat(davor.path("grund").asText()).isEqualTo("version_nicht_gespeichert");
        assertThat(davor.path("versionen").asInt()).isEqualTo(1);
        assertThat(zeitraum.path("werte").get(1).path("version").asInt()).isEqualTo(3);
        // Monat und Jahr ziehen mit: ohne Angabe Version 3, mit version=1 die Zeile der Verdichtung.
        JsonNode monat = ok(werte(KB, "MS-10", "monat", "2026-11-01", "2026-11-30", null)).path("werte").get(0);
        assertThat(monat.path("version").asInt()).isEqualTo(3);
        JsonNode monatEins = ok(werte(KB, "MS-10", "monat", "2026-11-01", "2026-11-30", 1)).path("werte").get(0);
        assertThat(monatEins.path("menge").decimalValue()).isEqualByComparingTo(root.queryForObject(
                "SELECT menge FROM messreihe_periode WHERE entity_id = ? AND art = 'monat' AND tag = DATE '2026-11-01'",
                BigDecimal.class, IDS.get("ZW")));
    }

    /**
     * Die Stunde ist keine gespeicherte Periode: trägt eine ihrer Viertelstunden eine spätere Version, steht keine Zahl
     * da ({@code version_nicht_gebildet}) — nie die Stunde von Version 1 als heutige. Mit {@code version=1} die damalige.
     */
    @Test
    void dieStundeHatKeineEigenenVersionen() throws Exception {
        JsonNode heute = schritt(ok(werte(KB, "MS-10", "stunde", "2026-11-03T20:00:00+01:00",
                "2026-11-03T21:00:00+01:00", null)));
        assertThat(heute.path("grund").asText()).isEqualTo("version_nicht_gebildet");
        assertThat(heute.path("menge").isNull()).isTrue();
        assertThat(heute.path("versionen").isNull()).isTrue();
        JsonNode damals = schritt(ok(werte(KB, "MS-10", "stunde", "2026-11-03T20:00:00+01:00",
                "2026-11-03T21:00:00+01:00", 1)));
        assertThat(damals.path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(damals.path("grund").isNull()).isTrue();
        JsonNode unberuehrt = schritt(ok(werte(KB, "MS-10", "stunde", "2026-11-03T10:00:00+01:00",
                "2026-11-03T11:00:00+01:00", null)));
        assertThat(unberuehrt.path("grund").isNull()).isTrue();
        assertThat(unberuehrt.path("zustand").asText()).isEqualTo("vollständig");
        assertThat(werte(KB, "MS-10", "stunde", "2026-11-03T20:00:00+01:00", "2026-11-03T21:00:00+01:00", 4)
                .status()).isEqualTo(404);
    }

    // =================================================================== Die Historie

    /**
     * Die Historie des 03.11.: drei Versionen, je der Wert davor und danach — genau so, wie {@code version=n} sie
     * zeigt — und wer, wann, warum. Version 3 besteht aus ZWEI Entscheidungen (Widerruf, bessere Methode), in der
     * Reihenfolge, in der Ines Kaltenbach sie getroffen hat; die Rücknahme nennt ihren Grund UND, unter
     * {@code angelegt}, die Begründung, mit der der Ersatzwert eingetragen wurde.
     */
    @Test
    void dieHistorieNenntWerWannWarumUndWasVorherDastand() throws Exception {
        JsonNode h = ok(versionen(KB, "MS-10", "tag", "2026-11-03", "2026-11-03"));
        assertThat(h.path("grund").isNull()).isTrue();
        assertThat(h.path("zeitzone").asText()).isEqualTo("Europe/Berlin");
        JsonNode v = h.path("versionen");
        assertThat(v).hasSize(3);

        JsonNode v1 = v.get(0);
        assertThat(v1.path("version").asInt()).isEqualTo(1);
        assertThat(v1.path("wert_alt").isNull()).isTrue();
        assertThat(v1.path("wert_neu")).isEqualTo(tag("2026-11-03", 1));
        assertThat(v1.path("anlass").isNull()).isTrue();
        assertThat(v1.path("entscheidungen")).isEmpty();
        assertThat(v1.path("gebildet_am").asText()).isNotBlank();

        JsonNode v2 = v.get(1);
        assertThat(v2.path("wert_alt")).isEqualTo(tag("2026-11-03", 1));
        assertThat(v2.path("wert_neu")).isEqualTo(tag("2026-11-03", 2));
        assertThat(v2.path("wert_alt").path("menge").decimalValue()).isEqualByComparingTo("1344.0");
        assertThat(v2.path("wert_neu").path("menge").decimalValue()).isEqualByComparingTo("2304.0");
        assertThat(v2.path("anlass").path("kennung").asText()).isEqualTo(ewA);
        assertThat(v2.path("entscheidungen")).hasSize(1);
        JsonNode eingetragen = v2.path("entscheidungen").get(0);
        assertThat(eingetragen.path("vorgang").asText()).isEqualTo("ersatzwert");
        assertThat(eingetragen.path("kennung").asText()).isEqualTo(ewA);
        assertThat(eingetragen.path("fassung").asInt()).isEqualTo(1);
        assertThat(eingetragen.path("status").asText()).isEqualTo("wirksam");
        assertThat(eingetragen.path("methode").asText()).isEqualTo("gleichmaessig_verteilen");
        pruefeInes(eingetragen.path("wer"));
        // Zeitpunkte in der Zone des Standorts, mit Versatz — geschrieben hat die Welt sie heute (now()).
        assertThat(java.time.OffsetDateTime.parse(eingetragen.path("wann").asText()).toInstant())
                .isEqualTo(root.queryForObject("SELECT created_at FROM messreihe_ersatzwert WHERE kennung = ? "
                        + "AND fassung = 1", Timestamp.class, ewA).toInstant()
                        .truncatedTo(java.time.temporal.ChronoUnit.SECONDS));
        assertThat(eingetragen.path("warum").asText()).isEqualTo(BEGRUENDUNG);
        assertThat(eingetragen.path("fehlt")).isEmpty();
        assertThat(eingetragen.path("angelegt").isNull()).isTrue();

        JsonNode v3 = v.get(2);
        assertThat(v3.path("wert_alt")).isEqualTo(tag("2026-11-03", 2));
        assertThat(v3.path("wert_neu")).isEqualTo(tag("2026-11-03", 3));
        assertThat(v3.path("wert_neu").path("menge").decimalValue()).isEqualByComparingTo("2354.4");
        assertThat(texte(v3.path("entscheidungen"), "kennung")).containsExactly(ewA, ewC);
        JsonNode widerruf = v3.path("entscheidungen").get(0);
        assertThat(widerruf.path("fassung").asInt()).isEqualTo(2);
        assertThat(widerruf.path("status").asText()).isEqualTo("zurueckgenommen");
        assertThat(widerruf.path("warum").asText()).isEqualTo(WIDERRUF);
        pruefeInes(widerruf.path("wer"));
        assertThat(widerruf.path("methode").asText()).isEqualTo("gleichmaessig_verteilen");
        assertThat(widerruf.path("angelegt").path("warum").asText()).isEqualTo(BEGRUENDUNG);
        pruefeInes(widerruf.path("angelegt").path("wer"));
        JsonNode besser = v3.path("entscheidungen").get(1);
        assertThat(besser.path("fassung").asInt()).isEqualTo(1);
        assertThat(besser.path("methode").asText()).isEqualTo("profil_vergleichsquelle");
        assertThat(besser.path("warum").asText()).isEqualTo(BESSER);
        assertThat(java.time.OffsetDateTime.parse(v2.path("gebildet_am").asText())).isNotNull();
        assertThat(v3.path("anlass").path("kennung").asText()).isIn(ewA, ewC);
    }

    /** Eine Periode ohne Korrektur hat genau eine Version — Version 1 ohne Entscheidung, nichts erfunden. */
    @Test
    void einePeriodeOhneKorrekturHatGenauEineVersion() throws Exception {
        JsonNode h = ok(versionen(KB, "MS-10", "viertelstunde", "2026-11-03T10:00:00+01:00",
                "2026-11-03T10:15:00+01:00"));
        assertThat(h.path("versionen")).hasSize(1);
        JsonNode v1 = h.path("versionen").get(0);
        assertThat(v1.path("version").asInt()).isEqualTo(1);
        assertThat(v1.path("wert_alt").isNull()).isTrue();
        assertThat(v1.path("entscheidungen")).isEmpty();
        JsonNode schritt = schritt(ok(werte(KB, "MS-10", "viertelstunde", "2026-11-03T10:00:00+01:00",
                "2026-11-03T10:15:00+01:00", null)));
        assertThat(v1.path("wert_neu")).isEqualTo(schritt);
        assertThat(schritt.path("versionen").asInt()).isEqualTo(1);
        assertThat(schritt.path("zustand").asText()).isEqualTo("vollständig");
    }

    /**
     * Falle 3: das „warum“ ist die Begründung eines Menschen. Die Korrektur an 03.11. 09:00 hat das System
     * vorgeschlagen und Jonas Wendlinger OHNE Grund freigegeben: {@code warum} ist leer und {@code fehlt} sagt es — der
     * Satz des System-Vorschlags steht als das, was er ist, unter {@code angelegt} mit dem Urheber VoltPilot. Der
     * fremde Kundenbereich hat dieselbe Kennung mit einem Grund; der erscheint nie.
     */
    @Test
    void eineFehlendeBegruendungWirdEhrlichAlsFehlendGezeigt() throws Exception {
        JsonNode h = ok(versionen(KB, "MS-10", "viertelstunde", "2026-11-03T09:00:00+01:00",
                "2026-11-03T09:15:00+01:00"));
        assertThat(h.path("versionen")).hasSize(2);
        JsonNode v2 = h.path("versionen").get(1);
        assertThat(v2.path("wert_alt").path("kennzeichen")).isEmpty();
        assertThat(texte(v2.path("wert_neu").path("kennzeichen"))).containsExactly(ErgebnisZustand.korrigiert(2));
        assertThat(v2.path("entscheidungen")).hasSize(1);
        JsonNode freigabe = v2.path("entscheidungen").get(0);
        assertThat(freigabe.path("vorgang").asText()).isEqualTo("korrektur");
        assertThat(freigabe.path("kennung").asText()).isEqualTo(KORREKTUR);
        assertThat(freigabe.path("status").asText()).isEqualTo("freigegeben");
        assertThat(freigabe.path("art").asText()).isEqualTo("nachlieferung_nach_endgueltigkeit");
        assertThat(freigabe.path("wer").path("name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(freigabe.path("wer").path("rolle").asText()).isEqualTo("kundenadministrator");
        assertThat(freigabe.path("warum").isNull()).isTrue();
        assertThat(texte(freigabe.path("fehlt"))).containsExactly("warum");
        assertThat(freigabe.path("angelegt").path("wer").path("name").asText()).isEqualTo("VoltPilot");
        assertThat(freigabe.path("angelegt").path("wer").path("art").asText()).isEqualTo("voltpilot");
        assertThat(freigabe.path("angelegt").path("warum").asText()).isEqualTo(systemBegruendung());
        assertThat(h.toString()).doesNotContain(FREMDER_GRUND).doesNotContain("Fremde Person");
    }

    @Test
    void dieHistorieWirdStrengGelesen() throws Exception {
        anfrage(versionen(KB, "MS-10", "stunde", "2026-11-03T20:00:00+01:00", "2026-11-03T21:00:00+01:00"), "raster",
                "raster_ohne_versionen");
        anfrage(versionen(KB, "MS-10", "tag", "2026-11-03", "2026-11-04"), "bis", "nicht_genau_eine_periode");
        anfrage(versionen(KB, "MS-10", "woche", "2026-11-03", "2026-11-03"), "raster", "raster_unbekannt");
    }

    // ============================================================ Zaun, Felder, Bestand

    /** Fremd = 404, nie 403 — an beiden Routen, auch mit einer Version; der fremde Kundenbereich hat keine MS-10. */
    @Test
    void derMandantenzaunHaelt() throws Exception {
        Antwort w = werte(FREMD, "MS-10", "tag", "2026-11-03", "2026-11-03", 2);
        assertThat(w.status()).isEqualTo(404);
        assertThat(w.body().path("message").asText()).isEqualTo("Messstelle nicht gefunden.");
        Antwort h = versionen(FREMD, "MS-10", "tag", "2026-11-03", "2026-11-03");
        assertThat(h.status()).isEqualTo(404);
        assertThat(h.body().toString()).doesNotContain(BEGRUENDUNG).doesNotContain(ewA);
    }

    /**
     * Die Felder sind genau die der OpenAPI (jedes Pflicht, auch leer), und die Routen schreiben nichts: der
     * Fingerabdruck des ganzen Schemas ist vor und nach allen Aufrufen gleich.
     */
    @Test
    void dieFelderSindDieDerOpenApiUndNichtsWirdGeschrieben() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        List<JsonNode> historien = new ArrayList<>();
        historien.add(ok(versionen(KB, "MS-10", "tag", "2026-11-03", "2026-11-03")));
        historien.add(ok(versionen(KB, "MS-10", "tag", "2026-11-04", "2026-11-04")));
        historien.add(ok(versionen(KB, "MS-10", "monat", "2026-11-01", "2026-11-30")));
        historien.add(ok(versionen(KB, "MS-10", "jahr", "2026-01-01", "2026-12-31")));
        historien.add(ok(versionen(KB, "MS-10", "viertelstunde", "2026-11-03T09:00:00+01:00",
                "2026-11-03T09:15:00+01:00")));
        historien.add(ok(versionen(KB, "MS-10", "viertelstunde", "2026-11-04T09:30:00+01:00",
                "2026-11-04T09:45:00+01:00")));
        historien.add(ok(versionen(KB, "MS-10", "tag", "2026-11-10", "2026-11-10")));
        JsonNode werte = ok(werte(KB, "MS-10", "viertelstunde", "2026-11-03", "2026-11-04", null));
        ok(werte(KB, "MS-10", "stunde", "2026-11-03", "2026-11-04", 1));
        werte(FREMD, "MS-10", "tag", "2026-11-03", "2026-11-03", null);

        Map<String, Set<String>> openapi = openapiFelder();
        int entscheidungen = 0;
        for (JsonNode h : historien) {
            assertThat(felder(h)).isEqualTo(openapi.get("MessstelleWerteHistorie"));
            for (JsonNode v : h.path("versionen")) {
                assertThat(felder(v)).isEqualTo(openapi.get("MessstelleWerteVersion"));
                assertThat(felder(v.path("wert_neu"))).isEqualTo(openapi.get("MessstelleWerteWert"));
                for (JsonNode e : v.path("entscheidungen")) {
                    assertThat(felder(e)).isEqualTo(openapi.get("MessstelleWerteEntscheidung"));
                    assertThat(felder(e.path("wer"))).isEqualTo(openapi.get("MessstelleWerteUrheber"));
                    if (!e.path("angelegt").isNull()) {
                        assertThat(felder(e.path("angelegt"))).isEqualTo(openapi.get("MessstelleWerteAngelegt"));
                    }
                    entscheidungen++;
                }
            }
        }
        assertThat(entscheidungen).isGreaterThanOrEqualTo(6);
        // Ein Tag ohne einen Rohwert hat genau Version 1: „keine Werte“ — ohne Zeile, ohne Entscheidung.
        assertThat(historien.get(6).path("versionen")).hasSize(1);
        assertThat(historien.get(6).path("versionen").get(0).path("wert_neu").path("zustand").asText())
                .isEqualTo("keine Werte");
        assertThat(historien.get(6).path("versionen").get(0).path("gebildet_am").isNull()).isTrue();
        werte.path("werte").forEach(w -> assertThat(felder(w)).isEqualTo(openapi.get("MessstelleWerteWert")));
        Antwort fehlt = werte(KB, "MS-10", "tag", "2026-11-03", "2026-11-03", 9);
        assertThat(felder(fehlt.body())).isEqualTo(openapi.get("MessstelleWerteVersionGibtEsNicht"));
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    // =========================================================================== Helfer

    private static void pruefe(JsonNode ist, JsonNode soll, String kennung, int version) {
        assertThat(ist.path("version").asInt()).as(ist.toString()).isEqualTo(version);
        assertThat(ist.path("grund").isNull()).as(ist.toString()).isTrue();
        if (soll.path("menge").isNull()) {
            assertThat(ist.path("menge").isNull()).isTrue();
        } else {
            assertThat(ist.path("menge").decimalValue()).as(ist.toString())
                    .isEqualByComparingTo(soll.path("menge").decimalValue());
        }
        assertThat(ist.path("zustand").asText()).isEqualTo(soll.path("zustand").asText());
        assertThat(ist.path("erhalten").asInt()).isEqualTo(soll.path("erhalten").asInt());
        assertThat(ist.path("erwartet").asInt()).isEqualTo(soll.path("erwartet").asInt());
        List<String> kz = new ArrayList<>();
        soll.path("kennzeichen").forEach(k -> kz.add(k.asText()
                .replace("EW-2026-0003", kennung == null ? "EW-2026-0003" : kennung)
                .replace("EW-2026-0005", kennung == null ? "EW-2026-0005" : kennung)));
        if (version > 1) {
            kz.add(ErgebnisZustand.korrigiert(version));
        }
        assertThat(texte(ist.path("kennzeichen"))).as(ist.toString()).containsExactlyElementsOf(kz);
    }

    private static void pruefeInes(JsonNode wer) {
        assertThat(wer.path("name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(wer.path("rolle").asText()).isEqualTo("energiemanager");
        assertThat(wer.path("art").asText()).isEqualTo("kunde");
    }

    private JsonNode tag(String tag, Integer version) throws Exception {
        return schritt(ok(werte(KB, "MS-10", "tag", tag, tag, version)));
    }

    private static JsonNode schritt(JsonNode antwort) {
        assertThat(antwort.path("werte")).as(antwort.toString()).hasSize(1);
        return antwort.path("werte").get(0);
    }

    private static JsonNode erwartung(String eintrag, String name) throws Exception {
        for (JsonNode e : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("ersatzwerte")) {
            if (!e.path("name").asText().startsWith(eintrag)) {
                continue;
            }
            for (JsonNode x : e.path("expected")) {
                if (name.equals(x.path("name").asText())) {
                    return x;
                }
            }
        }
        throw new AssertionError("keine Erwartung " + name + " in " + eintrag);
    }

    private Antwort werte(UUID kunde, String messstelle, String raster, String von, String bis, Integer version)
            throws Exception {
        return mvcGet(kunde, "/api/v1/messstellen/" + messstelle + "/werte?raster=" + raster + "&von=" + enc(von)
                + "&bis=" + enc(bis) + (version == null ? "" : "&version=" + version));
    }

    private Antwort versionen(UUID kunde, String messstelle, String raster, String von, String bis) throws Exception {
        return mvcGet(kunde, "/api/v1/messstellen/" + messstelle + "/werte/versionen?raster=" + raster + "&von="
                + enc(von) + "&bis=" + enc(bis));
    }

    private static String enc(String s) {
        return java.net.URLEncoder.encode(s, StandardCharsets.UTF_8);
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
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(e -> out.add(e.asText()));
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
            for (String name : List.of("MessstelleWerteHistorie", "MessstelleWerteVersion", "MessstelleWerteWert",
                    "MessstelleWerteEntscheidung", "MessstelleWerteUrheber", "MessstelleWerteAngelegt",
                    "MessstelleWerteVersionGibtEsNicht")) {
                Map<String, Object> s = (Map<String, Object>) schemas.get(name);
                assertThat(s).as(name).isNotNull();
                // Einzige Ausnahme (AP-03 R-A6): `ausserhalb_zugriff` steht nur, wenn es gilt — wie an Formel und Bilanz.
                Set<String> pflicht = new TreeSet<>(((Map<String, Object>) s.get("properties")).keySet());
                if (name.equals("MessstelleWerteHistorie")) {
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
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Ahrenberg', 'Europe/Berlin') "
                + "RETURNING id", KB);
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", KB, u);
        UUID an = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, an, st);
        IDS.put("AN", an);
        reihe("ZW", 60);
        reihe("VQ", 900);
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-10', 'Halle 2', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", KB);
        bindung(ms, "ZW", "fuehrend", null);
        IDS.put("Q-VQ", bindung(ms, "VQ", "vergleich", "Abrechnungszähler"));
    }

    private static void reihe(String name, int kadenz) {
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", KB, IDS.get("AN"), "VP-BOX-VS-" + name);
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get("AN"), name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get("AN"), box, entity, KANAL, kadenz);
        IDS.put(name, entity);
        IDS.put("BOX:" + name, box);
    }

    private static UUID bindung(UUID messstelle, String reihe, String rolle, String zweck) {
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, IDS.get(reihe));
        return root.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, zweck, gueltig_ab, rueckwirkend, "
                + "eingetragen_am, actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, "
                + "'counter', 'zaehlerstand', ?, ?, '2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde') "
                + "RETURNING id", UUID.class, KB, messstelle, IDS.get(reihe), geraet, KANAL, rolle, zweck);
    }

    private static void rohwerte() throws Exception {
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            if (fall.path("name").asText().startsWith("f11-")) {
                saeen("ZW", VerbrauchVectorsTest.rohwerte(fall.path("input").path("reihe")));
            }
        }
        // Die Vergleichsquelle (15 min): der Lastgang des Netzbetreibers über die Lücke (F21).
        List<Rohwert> vq = new ArrayList<>();
        BigDecimal lastgang = new BigDecimal("50000.0");
        List<Instant> q = VerbrauchRegeln.viertelstunden(EW_VON, LUECKE_BIS);
        for (int i = 0; i < q.size(); i++) {
            vq.add(new Rohwert(q.get(i), lastgang));
            lastgang = lastgang.add(new BigDecimal(i < 40 ? "25.26" : i < 76 ? "22.6" : "24.0"));
        }
        vq.add(new Rohwert(LUECKE_BIS, lastgang));
        saeen("VQ", vq);
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2) ON CONFLICT DO NOTHING";

    private static void saeen(String reihe, List<Rohwert> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.zeit().plusSeconds(2)), KB,
                    IDS.get("AN"), IDS.get("BOX:" + reihe), KANAL, r.wert(), r.zeit().getEpochSecond(), IDS.get(reihe)});
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static void luecke() {
        UUID id = UUID.randomUUID();
        ObjectNode e = MAPPER.createObjectNode()
                .put("ereignis_id", id.toString()).put("art", "data_gap")
                .put("von", LUECKE_VON.toString()).put("bis", LUECKE_BIS.toString())
                .put("box", IDS.get("BOX:ZW").toString()).put("komponente", IDS.get("ZW").toString())
                .put("messkanal", KANAL).put("erkannt_aus", "kadenz").put("zuwachs", ZUWACHS).put("einheit", "kWh")
                .put("stand_vor", new BigDecimal("418200.0")).put("stand_nach", new BigDecimal("420072.0"));
        MessreiheEreignisRepository.Ergebnis r = als(KB, () ->
                new MessreiheEreignisRepository(app).anhaengen(KB, null, Urheber.CLOUD, e, null, null));
        assertThat(r.ausgang()).as("Lücke angehängt: " + r).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        IDS.put("LUECKE", id);
    }

    private static Anlage verteilen(String methode, String begruendung, UUID vergleich) {
        return new Anlage(methode, IDS.get("ZW"), KANAL, null, EW_VON, LUECKE_BIS, null, begruendung, null,
                IDS.get("LUECKE"), ZUWACHS, new BigDecimal("418200.0"), new BigDecimal("420072.0"), "kWh", null,
                vergleich, null, null, null);
    }

    private static String erfassen(MessreiheErsatzwertRepository ersatzwerte, Anlage a) {
        return als(KB, () -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .execute(s -> ersatzwerte.erfassen(KB, a, INES, BERLIN))).kennung();
    }

    private static String systemBegruendung() {
        return KorrekturVorschlagRegeln.nachlieferung(K_VIERTELSTUNDE, K_VIERTELSTUNDE.plusSeconds(900), 15,
                Instant.parse("2026-11-11T09:40:00Z"), Instant.parse("2026-11-10T23:00:00Z"), BERLIN);
    }

    /**
     * Die Korrektur an 03.11. 09:00, wie Vorschlags-Lauf, Freigabe und Kaskade sie schreiben: Fassung 1 vom System mit
     * dem Satz des Vertrags, Fassung 2 von Jonas Wendlinger OHNE Grund (die Freigabe verlangt keinen), Version 2 der
     * Viertelstunde mit den Fakten von Version 1 und „korrigiert (Version 2)“.
     */
    private static void korrekturOhneGrund() {
        String reihen = MAPPER.createArrayNode().add(MAPPER.createObjectNode()
                .put("entity_id", IDS.get("ZW").toString()).put("messkanal", KANAL)).toString();
        ProtokollAkteur system = KorrekturVorschlagLauf.SYSTEM;
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, 'vorschlag', "
                + "'nachlieferung_nach_endgueltigkeit', ?::jsonb, ?, ?, ?, '[{\"periode\": \"2026-11-03T09:00:00+01:00\"}]'"
                + "::jsonb, ?, ?, ?, ?)", KB, KORREKTUR, reihen, Timestamp.from(K_VIERTELSTUNDE),
                Timestamp.from(K_VIERTELSTUNDE.plusSeconds(900)), systemBegruendung(), system.sub(), system.name(),
                system.rolle(), system.art());
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 2, 'freigegeben', NULL, 'kc-jonas-wendlinger', "
                + "'Jonas Wendlinger', 'kundenadministrator', 'kunde')", KB, KORREKTUR);
        int n = root.update("INSERT INTO messreihe_viertelstunde_version (tenant_id, entity_id, messkanal, "
                + "intervall_beginn, version, menge, menge_zustand, kennzeichen, anteil, ersatzwerte, anlass_kennung, "
                + "anlass_fassung, basis_berechnet_am, korrekturen, wertart, stand_anfang, stand_anfang_zeit, stand_ende, "
                + "stand_ende_zeit, erster_wert, erster_zeit, letzter_wert, letzter_zeit, erhalten, erwartet, "
                + "abdeckung_prozent) SELECT tenant_id, entity_id, messkanal, intervall_beginn, 2, menge, menge_zustand, "
                + "kennzeichen || '[\"korrigiert (Version 2)\"]'::jsonb, NULL, '{}'::text[], ?, 2, berechnet_am, "
                + "ARRAY[?]::text[], wertart, stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, "
                + "erster_zeit, letzter_wert, letzter_zeit, erhalten, erwartet, abdeckung_prozent "
                + "FROM messreihe_viertelstunde WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? "
                + "AND intervall_beginn = ?", KORREKTUR, KORREKTUR, KB, IDS.get("ZW"), KANAL,
                Timestamp.from(K_VIERTELSTUNDE));
        assertThat(n).as("Version 2 der Viertelstunde 09:00").isEqualTo(1);
    }

    /** Ein fremder Kundenbereich mit DERSELBEN Korrektur-Kennung und einem Grund, der nie erscheinen darf. */
    private static void fremderKundenbereich() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Fremder Kunde')", FREMD);
        String reihen = MAPPER.createArrayNode().add(MAPPER.createObjectNode()
                .put("entity_id", UUID.randomUUID().toString()).put("messkanal", KANAL)).toString();
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, 'vorschlag', "
                + "'nachlieferung_nach_endgueltigkeit', ?::jsonb, ?, ?, ?, '[{}]'::jsonb, 'kc-fremd', 'Fremde Person', "
                + "'bearbeiter', 'kunde')", FREMD, KORREKTUR, reihen, Timestamp.from(K_VIERTELSTUNDE),
                Timestamp.from(K_VIERTELSTUNDE.plusSeconds(900)), FREMDER_GRUND);
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 2, 'freigegeben', ?, 'kc-fremd', 'Fremde Person', "
                + "'kundenadministrator', 'kunde')", FREMD, KORREKTUR, FREMDER_GRUND);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static <T> T als(UUID kunde, Supplier<T> arbeit) {
        TenantContext.set(kunde);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static javax.sql.DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
