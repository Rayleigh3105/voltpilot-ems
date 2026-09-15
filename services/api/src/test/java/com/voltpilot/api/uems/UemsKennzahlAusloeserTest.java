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
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
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
 * Die Auslöser aus Nenner und Definition an der Datenbank (UEMS AP-11 IP-9, E8 = A, W1) — Meilenstein 3 „Kennzahl
 * korrigiert sich“: nach der Messreihe (IP-8) bilden auch eine geänderte Bezugsgröße, ein rückwirkendes Stammdatum und
 * eine rückwirkend geänderte Berechnung die Kennzahl neu — im Takt der Korrektur-Kaskade ({@link KorrekturKaskade#lauf}),
 * in ihrer Transaktion, ab dem ersten betroffenen Tag und keinen Tag früher.
 *
 * <ul>
 *   <li><b>K6 über den echten Weg.</b> Die Berichtigung über {@code POST …/werte/{periode}/berichtigung} (AP-09 IP-7)
 *       schreibt Fassung 2 und die Meldung {@code correction}; erst der nächste Takt der Kaskade liest sie und macht
 *       KZ-0004 zu Version 2 = 0,2833. Der Schreibweg nimmt nur abgeschlossene Perioden nach der Uhr der Datenbank (E16,
 *       Z4) — der Fall spielt darum im Oktober 2025 statt 2026.</li>
 *   <li><b>K6-Beleg und K19 synthetisch.</b> Ein Import (AP-09 IP-12/IP-13) schreibt heute weder eine Berichtigung noch
 *       eine Rücknahme, und der Schreibweg von IP-7 kennt keine Rücknahme: Fassung 2 steht darum von Hand in
 *       {@code bezugsgroesse_wert}, ihre Meldung geht durch den echten {@link MessreiheEreignisRepository#anhaengen}
 *       (dasselbe Vokabular wie IP-7). Der Beleg-Satz ist byte-gleich zur Herkunft des Vertrags.</li>
 *   <li><b>K17 und K12 über die echten Routen.</b> {@code POST /api/v1/kennzahlen/{id}/fassungen} und
 *       {@code PUT /api/v1/bezugsgroessen/{id}/stammdatum} urteilen „rückwirkend“ nach der echten Uhr; die Perioden liegen
 *       darum 2026 bzw. 2025/2026. ⚠ K12 nennt die Fläche von Halle 2 — eine Fläche ist heute KEIN Kennzahl-Eingang
 *       ({@code BezugsgroesseService.stammdatum} liest nur {@code bezugsgroesse_stammdatum}, eine Bezugsgröße in m² lehnt
 *       der Schreibweg mit {@code flaeche_aus_struktur} ab): dieselbe Regel läuft mit einem Stammdatum in Personen und
 *       den Zahlen aus K12.</li>
 * </ul>
 *
 * <p>Version 1 bildet jeweils der Regellauf ({@link KennzahlLauf#lauf}) zu einer Uhr nach dem Monatsende.
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsKennzahlAusloeserTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "kennzahl-vectors.json");
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final String BZ_PFAD = "/api/v1/bezugsgroessen";

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
    KorrekturKaskade kaskade;

    @Autowired
    MessreiheEreignisRepository ereignisse;

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

    // ================================================================ K6: der Nenner wird berichtigt

    /**
     * K6 über den echten Schreibweg: die Berichtigung von BZ-1 (312 400 → 312 900 kg) meldet {@code correction} mit Bezug
     * {@code bezugsgroesse}; der Takt der Kaskade liest die Meldung und ruft NUR die Kennzahl- und die Berichts-Naht —
     * KZ-0004 wird Version 2 = 0,2833 „korrigiert (Version 2)“ mit dem Beleg der Berichtigung, Version 1 (0,2837) bleibt
     * über die Route lesbar, keine Messreihe bekommt eine Version, ein zweiter Takt schreibt nichts.
     */
    @Test
    void k6DieBerichtigungUeberDenEchtenWegWirdImTaktVersionZweiOhneMessreihenStufe() throws Exception {
        LocalDate okt = LocalDate.parse("2025-10-01");
        Welt w = spritzguss(okt);
        lauf.lauf(Instant.parse("2025-11-10T08:00:00Z"));
        Map<String, Object> v1 = zeile(w, "KZ-0004", "monat", okt);
        assertThat(v1.get("version")).isEqualTo(1);
        assertThat(v1.get("zustand")).isEqualTo("endgueltig");
        assertThat(vier(v1.get("wert"))).as("88 630 ÷ 312 400").isEqualTo("0.2837");

        root.update("UPDATE unternehmen SET vieraugen_freigabe = false WHERE tenant_id = ?", w.mandant());
        Antwort b = ruf(w, HttpMethod.POST, BZ_PFAD + "/" + w.bezugsgroessen().get("BZ-1") + "/werte/2025-10/berichtigung",
                Map.of("wert", "312.900", "begruendung", "ERP-Nachbuchung vom 05.11.2025"));
        assertThat(b.status()).as(b.body().toString()).isEqualTo(201);
        assertThat(b.body().get("urteil").asText()).isEqualTo("berichtigung");
        String bk = b.body().get("kennung").asText();
        assertThat(bk).matches("BK-[0-9]{4}-[0-9]{4,}");
        assertThat(zeile(w, "KZ-0004", "monat", okt).get("version")).as("vor dem Takt ändert sich keine Kennzahl")
                .isEqualTo(1);

        Instant takt = Instant.now();
        kaskade.lauf(takt);

        Map<String, Object> v2 = zeile(w, "KZ-0004", "monat", okt);
        assertThat(v2.get("version")).isEqualTo(2);
        assertThat(v2.get("zustand")).isEqualTo("endgueltig");
        assertThat(vier(v2.get("wert"))).as("88 630 ÷ 312 900").isEqualTo("0.2833");
        assertThat(saetze(v2.get("kennzeichen"))).contains("korrigiert (Version 2)");
        assertThat(v2.get("anlass_art")).isEqualTo("eingang");
        assertThat(v2.get("anlass_kennung")).isEqualTo("correction BZ-1 2025-10 Fassung 1 → 2 (" + bk + ")");
        assertThat(v2.get("definition_fassung")).as("Fassung und Version sind zwei Achsen").isEqualTo(1);
        assertThat(eingaenge(v2)).extracting(e -> e.get("rolle") + " " + e.get("objekt") + " Fassung " + e.get("fassung"))
                .contains("nenner BZ-1 Fassung 2");
        assertThat(zeilen(w, "KZ-0004", "monat", okt)).extracting(z -> z.get("version")).as("Version 1 bleibt stehen")
                .containsExactly(1, 2);
        assertThat(meldungen(w)).containsExactly("KZ-0004|" + bk + "|2|cloud|2025-09-30T22:00:00Z|2025-10-31T23:00:00Z");
        assertThat(wirkung(w)).containsExactly(bk + " 2 gebildet");
        assertThat(anzahl(w, "SELECT count(*) FROM messreihe_periode_version WHERE tenant_id = ?"))
                .as("keine Messreihen-Stufe").isZero();
        assertThat(anzahl(w, "SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? AND art = 'bilanz_neu_berechnet'"))
                .as("keine Bilanz-Meldung").isZero();

        JsonNode alt = einziger(ok(ruf(w, HttpMethod.GET, PFAD + "/" + w.kz().get("KZ-0004")
                + "/werte?periode=monat&von=2025-10-01&bis=2025-10-31&version=1", null)));
        assertThat(vier(alt.get("wert"))).as("die alte Zahl bleibt lesbar").isEqualTo("0.2837");

        String vorher = tabellen(w);
        kaskade.lauf(takt.plusSeconds(300));
        assertThat(tabellen(w)).as("ein zweiter Takt schreibt nichts").isEqualTo(vorher);
    }

    /**
     * Der Beleg einer Berichtigung aus einem Import, wie K6 ihn in der Herkunft nennt: „correction BZ-1 2026-10 Fassung
     * 1 → 2 (I-2026-0003)“ — synthetisch, weil der Import heute keine Berichtigung schreibt (siehe Klassenkopf).
     */
    @Test
    void k6DerBelegEinerBerichtigungAusDemImportIstDerSatzDerHerkunft() throws Exception {
        LocalDate okt = LocalDate.parse("2026-10-01");
        Welt w = spritzguss(okt);
        lauf.lauf(Instant.parse("2026-11-04T08:00:00Z"));
        fassungZwei(w, okt, new BigDecimal("312900"), "berichtigung", "wirksam", "I-2026-0003",
                "ERP-Nachbuchung vom 05.11.2026", Instant.parse("2026-11-05T13:40:12Z"));
        melden(w, "BK-2026-0003", okt, KorrekturKaskade.FREIGEGEBEN, "I-2026-0003");

        kaskade.lauf(Instant.parse("2026-11-05T14:00:00Z"));

        Map<String, Object> v2 = zeile(w, "KZ-0004", "monat", okt);
        assertThat(v2.get("version")).isEqualTo(2);
        assertThat(vier(v2.get("wert"))).as("K6: 0,2833 in Version 2").isEqualTo("0.2833");
        assertThat(v2.get("anlass_kennung")).as("byte-gleich zur Herkunft K6")
                .isEqualTo(belegImVertrag("correction BZ-1 2026-10"));
        assertThat(meldungen(w)).containsExactly("KZ-0004|BK-2026-0003|2|cloud|2026-09-30T22:00:00Z|2026-10-31T23:00:00Z");
        assertThat(wirkung(w)).containsExactly("BK-2026-0003 2 gebildet");
    }

    // ================================================================ K19: der Nenner wird zurückgenommen

    /**
     * K19: der Import I-2026-0001 wird zurückgenommen — BZ-1 Oktober hat keinen wirksamen Betrag mehr. KZ-0004 wird Version
     * 2 „keine Werte“ (Grund Nenner fehlt) mit „Nenner zurückgenommen (BZ-1 Oktober 2026)“, nie 0; Version 1 (0,2837)
     * bleibt stehen. Synthetisch, weil es die Rücknahme (AP-09 IP-13) noch nicht gibt.
     */
    @Test
    void k19DieRuecknahmeDesNennersWirdVersionZweiOhneZahlUndVersionEinsBleibt() throws Exception {
        LocalDate okt = LocalDate.parse("2026-10-01");
        Welt w = spritzguss(okt);
        lauf.lauf(Instant.parse("2026-11-10T08:00:00Z"));
        fassungZwei(w, okt, null, "ruecknahme", "zurueckgenommen", "I-2026-0001",
                "Import I-2026-0001 zurückgenommen: falsche Datei", Instant.parse("2026-11-20T10:02:00Z"));
        melden(w, "BK-2026-0004", okt, KorrekturKaskade.ZURUECKGENOMMEN, "I-2026-0001");

        kaskade.lauf(Instant.parse("2026-11-20T11:00:00Z"));

        Map<String, Object> v2 = zeile(w, "KZ-0004", "monat", okt);
        assertThat(v2.get("version")).isEqualTo(2);
        assertThat(v2.get("zustand")).isEqualTo("endgueltig");
        assertThat(v2.get("wert")).as("keine Werte ist keine Null").isNull();
        assertThat(v2.get("menge_zustand")).isEqualTo("keine Werte");
        assertThat(v2.get("grund")).isEqualTo("nenner_fehlt");
        assertThat(saetze(v2.get("kennzeichen"))).contains("korrigiert (Version 2)",
                "Nenner zurückgenommen (BZ-1 Oktober 2026)");
        assertThat(v2.get("anlass_kennung")).as("byte-gleich zur Herkunft K19").isEqualTo(belegImVertrag("Rücknahme "));
        assertThat(zeilen(w, "KZ-0004", "monat", okt)).extracting(z -> vier(z.get("wert")), z -> z.get("version"))
                .as("Version 1 bleibt lesbar").first().isEqualTo(org.assertj.core.groups.Tuple.tuple("0.2837", 1));
        assertThat(meldungen(w)).containsExactly("KZ-0004|BK-2026-0004|2|cloud|2026-09-30T22:00:00Z|2026-10-31T23:00:00Z");
    }

    // ================================================================ K17: die Berechnung ändert sich ab einem Tag

    /**
     * K17: Fassung 2 der Berechnung (Zähler MS-24) gilt ab 01.03., eingetragen später — rückwirkend. Der März war
     * vorläufig: er zieht mit Fassung 2 nach (Version bleibt 1, keine Meldung). Der Februar liest Fassung 1 und bleibt
     * Zeile für Zeile, wie er war.
     */
    @Test
    void k17DerMaerzZiehtMitDerRueckwirkendenFassungNachUndDerFebruarBleibtUnveraendert() throws Exception {
        LocalDate feb = LocalDate.parse("2026-02-01");
        LocalDate mar = LocalDate.parse("2026-03-01");
        Welt w = spritzgussMitKuehlung(feb, mar, false);
        lauf.lauf(Instant.parse("2026-04-03T08:00:00Z"));
        assertThat(vier(zeile(w, "KZ-0004", "monat", feb).get("wert"))).as("84 900 ÷ 300 200").isEqualTo("0.2828");
        Map<String, Object> maerz1 = zeile(w, "KZ-0004", "monat", mar);
        assertThat(maerz1.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(vier(maerz1.get("wert"))).as("91 200 ÷ 320 000 mit Fassung 1").isEqualTo("0.2850");
        String bisFebruar = zeilenBis(w, "KZ-0004", mar.minusDays(1));

        fassungZwei(w, "KZ-0004", "2026-03-01");

        kaskade.lauf(Instant.parse("2026-04-04T08:00:00Z"));

        Map<String, Object> maerz = zeile(w, "KZ-0004", "monat", mar);
        assertThat(maerz.get("version")).as("vorläufig zieht nach, ohne neue Version").isEqualTo(1);
        assertThat(maerz.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(vier(maerz.get("wert"))).as("(91 200 + 6 300) ÷ 320 000 mit Fassung 2").isEqualTo("0.3047");
        assertThat(maerz.get("definition_fassung")).isEqualTo(2);
        assertThat(maerz.get("anlass_art")).isNull();
        assertThat(zeilenBis(w, "KZ-0004", mar.minusDays(1))).as("Februar unverändert").isEqualTo(bisFebruar);
        assertThat(meldungen(w)).as("ein vorläufiger Wert zieht ohne Meldung nach").isEmpty();
        assertThat(wirkung(w)).containsExactly("kennzahl_fassung:" + w.kz().get("KZ-0004") + " 2 gebildet");
    }

    /** K17, „wäre der März endgültig gewesen“: Version 2 „Berechnung geändert (Fassung 2)“, Anlass {@code definition}. */
    @Test
    void k17WaereDerMaerzEndgueltigGewesenWirdErVersionZweiBerechnungGeaendert() throws Exception {
        LocalDate feb = LocalDate.parse("2026-02-01");
        LocalDate mar = LocalDate.parse("2026-03-01");
        Welt w = spritzgussMitKuehlung(feb, mar, true);
        lauf.lauf(Instant.parse("2026-04-20T08:00:00Z"));
        assertThat(zeile(w, "KZ-0004", "monat", mar).get("zustand")).isEqualTo("endgueltig");
        String bisFebruar = zeilenBis(w, "KZ-0004", mar.minusDays(1));

        fassungZwei(w, "KZ-0004", "2026-03-01");

        kaskade.lauf(Instant.parse("2026-04-21T08:00:00Z"));

        Map<String, Object> maerz = zeile(w, "KZ-0004", "monat", mar);
        assertThat(maerz.get("version")).isEqualTo(2);
        assertThat(maerz.get("zustand")).isEqualTo("endgueltig");
        assertThat(vier(maerz.get("wert"))).isEqualTo("0.3047");
        assertThat(maerz.get("definition_fassung")).isEqualTo(2);
        assertThat(maerz.get("anlass_art")).isEqualTo("definition");
        assertThat((String) maerz.get("anlass_kennung")).startsWith("KZ-0004 Fassung 2 ab 01.03.2026 (eingetragen ");
        assertThat(saetze(maerz.get("kennzeichen"))).contains("Berechnung geändert (Fassung 2)");
        assertThat(zeilenBis(w, "KZ-0004", mar.minusDays(1))).as("Februar unverändert").isEqualTo(bisFebruar);
        assertThat(meldungen(w)).containsExactly("KZ-0004|KZ-0004/Fassung-2|2|cloud|2026-02-28T23:00:00Z|2026-03-31T22:00:00Z");
    }

    // ================================================================ K12: das Stammdatum gilt rückwirkend

    /**
     * K12 mit einem Stammdatum statt der Fläche (siehe Klassenkopf): 3 100 → 3 400 ab 01.01., eingetragen später. Der
     * Januar war vorläufig und zieht nach (38 760 ÷ 3 400 = 11,40); der Dezember bleibt 34 300 ÷ 3 100 = 11,06, Zeile für
     * Zeile — der neue Wert gilt ab 01.01.
     */
    @Test
    void k12DerJanuarZiehtMitDemRueckwirkendenStammdatumNachUndDerDezemberBleibtUnveraendert() throws Exception {
        LocalDate dez = LocalDate.parse("2025-12-01");
        LocalDate jan = LocalDate.parse("2026-01-01");
        Welt w = hallenbezug(dez, jan, false);
        lauf.lauf(Instant.parse("2026-02-03T08:00:00Z"));
        assertThat(vier(zeile(w, "KZ-0005", "monat", dez).get("wert"))).isEqualTo("11.0645");
        Map<String, Object> januar1 = zeile(w, "KZ-0005", "monat", jan);
        assertThat(januar1.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(vier(januar1.get("wert"))).as("38 760 ÷ 3 100").isEqualTo("12.5032");
        String bisDezember = zeilenBis(w, "KZ-0005", jan.minusDays(1));

        stammdatumAb(w, "BZ-8", "3400", "2026-01-01");

        kaskade.lauf(Instant.parse("2026-02-04T08:00:00Z"));

        Map<String, Object> januar = zeile(w, "KZ-0005", "monat", jan);
        assertThat(januar.get("version")).isEqualTo(1);
        assertThat(januar.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(vier(januar.get("wert"))).as("38 760 ÷ 3 400").isEqualTo("11.4000");
        assertThat(zeilenBis(w, "KZ-0005", jan.minusDays(1))).as("Dezember unverändert").isEqualTo(bisDezember);
        assertThat(meldungen(w)).isEmpty();
        assertThat(wirkung(w)).containsExactly("bezugsgroesse_stammdatum:" + w.bezugsgroessen().get("BZ-8") + " 1 gebildet");
    }

    /** K12, der Januar schon endgültig: Version 2 „korrigiert (Version 2)“ mit dem Stammdatum als Beleg. */
    @Test
    void k12WaereDerJanuarEndgueltigGewesenWirdErVersionZweiMitDemStammdatumAlsAnlass() throws Exception {
        LocalDate dez = LocalDate.parse("2025-12-01");
        LocalDate jan = LocalDate.parse("2026-01-01");
        Welt w = hallenbezug(dez, jan, true);
        lauf.lauf(Instant.parse("2026-02-10T08:00:00Z"));
        assertThat(zeile(w, "KZ-0005", "monat", jan).get("zustand")).isEqualTo("endgueltig");
        String bisDezember = zeilenBis(w, "KZ-0005", jan.minusDays(1));

        stammdatumAb(w, "BZ-8", "3400", "2026-01-01");

        kaskade.lauf(Instant.parse("2026-02-11T08:00:00Z"));

        Map<String, Object> januar = zeile(w, "KZ-0005", "monat", jan);
        assertThat(januar.get("version")).isEqualTo(2);
        assertThat(vier(januar.get("wert"))).isEqualTo("11.4000");
        assertThat(januar.get("anlass_art")).isEqualTo("eingang");
        assertThat((String) januar.get("anlass_kennung")).startsWith("Stammdatum BZ-8 ab 01.01.2026 (eingetragen ");
        assertThat(saetze(januar.get("kennzeichen"))).contains("korrigiert (Version 2)");
        assertThat(zeilenBis(w, "KZ-0005", jan.minusDays(1))).as("Dezember unverändert").isEqualTo(bisDezember);
        assertThat(meldungen(w)).containsExactly("KZ-0005|BZ-8/ab-2026-01-01|2|cloud|2025-12-31T23:00:00Z|2026-01-31T23:00:00Z");
    }

    // ================================================================ keine halbe Wahrheit

    /**
     * Ein Fehler NACH der Naht — beim Schreiben der Wirkung — rollt die Neubildung mit zurück: die Datenbank sieht in
     * derselben Transaktion KZ-0004 schon als Version 2, danach steht Tabelle für Tabelle, was vorher stand. Der nächste
     * Takt ohne den Fehler bildet Version 2.
     */
    @Test
    void einFehlerNachDerNahtRolltNeubildungMeldungUndWirkungZurueck() throws Exception {
        LocalDate okt = LocalDate.parse("2026-10-01");
        Welt w = spritzguss(okt);
        lauf.lauf(Instant.parse("2026-11-04T08:00:00Z"));
        fassungZwei(w, okt, new BigDecimal("312900"), "berichtigung", "wirksam", "I-2026-0003",
                "ERP-Nachbuchung vom 05.11.2026", Instant.parse("2026-11-05T13:40:12Z"));
        melden(w, "BK-2026-0003", okt, KorrekturKaskade.FREIGEGEBEN, "I-2026-0003");
        String vorher = tabellen(w);
        root.execute("CREATE OR REPLACE FUNCTION test_ausloeser_bricht() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                + "RAISE EXCEPTION 'Wirkung nicht schreibbar (Version 2 schon geschrieben: %)', EXISTS (SELECT 1 FROM "
                + "kennzahl_wert WHERE tenant_id = NEW.tenant_id AND version = 2); END $$");
        root.execute("CREATE TRIGGER test_ausloeser_bricht BEFORE INSERT ON messreihe_kaskade_wirkung FOR EACH ROW "
                + "WHEN (NEW.tenant_id = '" + w.mandant() + "') EXECUTE FUNCTION test_ausloeser_bricht()");
        String danach;
        try {
            assertThatThrownBy(() -> kaskade.lauf(Instant.parse("2026-11-05T14:00:00Z")))
                    .hasStackTraceContaining("Version 2 schon geschrieben: t)");
        } finally {
            root.execute("DROP TRIGGER IF EXISTS test_ausloeser_bricht ON messreihe_kaskade_wirkung");
            danach = tabellen(w);
            // Der nächste Takt ohne den Fehler — auch wenn oben etwas scheitert: kein Anlass bleibt für die anderen Tests liegen.
            kaskade.lauf(Instant.parse("2026-11-05T14:05:00Z"));
        }
        assertThat(danach).as("nichts bleibt halb").isEqualTo(vorher);
        assertThat(zeile(w, "KZ-0004", "monat", okt).get("version")).isEqualTo(2);
        assertThat(wirkung(w)).containsExactly("BK-2026-0003 2 gebildet");
    }

    // ================================================================ die Welten

    private record Welt(UUID mandant, UUID unternehmen, UUID halle, UUID anlage, Map<String, UUID> messstellen,
            Map<String, UUID> komponenten, Map<String, UUID> bezugsgroessen, Map<String, UUID> kz) {}

    private record Antwort(int status, JsonNode body) {}

    /** K6/K19: MS-20 (88 630 kWh, endgültig) ÷ BZ-1 (Fassung 1 = 312 400 kg) = KZ-0004 an Halle 1. */
    private Welt spritzguss(LocalDate monat) throws Exception {
        Welt w = welt();
        messstelle(w, "MS-20");
        monat(w, "MS-20", monat, "88630", true);
        bezugsgroesse(w, "BZ-1", "Produktionsmenge Spritzguss");
        erstwert(w, "BZ-1", monat, "312400");
        anlegen(w, "KZ-0004", "quotient", "gebaeude", w.halle(), e("zaehler", "messstelle", "MS-20"),
                e("nenner", "bezugsgroesse", "BZ-1"));
        return w;
    }

    /** K17: Februar 84 900 ÷ 300 200 (endgültig), März MS-20 91 200 und MS-24 97 500 ÷ 320 000. */
    private Welt spritzgussMitKuehlung(LocalDate feb, LocalDate mar, boolean maerzEndgueltig) throws Exception {
        Welt w = welt();
        messstelle(w, "MS-20");
        messstelle(w, "MS-24");
        monat(w, "MS-20", feb, "84900", true);
        monat(w, "MS-20", mar, "91200", maerzEndgueltig);
        monat(w, "MS-24", mar, "97500", maerzEndgueltig);
        bezugsgroesse(w, "BZ-1", "Produktionsmenge Spritzguss");
        erstwert(w, "BZ-1", feb, "300200");
        erstwert(w, "BZ-1", mar, "320000");
        anlegen(w, "KZ-0004", "quotient", "gebaeude", w.halle(), e("zaehler", "messstelle", "MS-20"),
                e("nenner", "bezugsgroesse", "BZ-1"));
        return w;
    }

    /** K12: MS-10 Dezember 34 300 (endgültig), Januar 38 760 ÷ Stammdatum BZ-8 = 3 100 seit 2020 — KZ-0005. */
    private Welt hallenbezug(LocalDate dez, LocalDate jan, boolean januarEndgueltig) throws Exception {
        Welt w = welt();
        messstelle(w, "MS-10");
        monat(w, "MS-10", dez, "34300", true);
        monat(w, "MS-10", jan, "38760", januarEndgueltig);
        stammdatum(w, "BZ-8", "Belegschaft Halle 1", "Personen", "3100");
        anlegen(w, "KZ-0005", "quotient", "unternehmen", w.unternehmen(), e("zaehler", "messstelle", "MS-10"),
                e("nenner", "bezugsgroesse", "BZ-8"));
        return w;
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Auslöser #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID halle = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, "
                + "'gebaeude', 'Halle 1', 'G-1', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, halle, st);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, "Halle 1 #" + nr, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        return new Welt(t, u, halle, anlage, new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>(),
                new LinkedHashMap<>());
    }

    /** Box, Komponente, Mess-Selektion des Zählerstands, gemessene Messstelle mit führender Quelle, Stellung. */
    private static void messstelle(Welt w, String kennzeichen) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, w.anlage(), "VP-AUSLOESER-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, w.anlage(),
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
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
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,'Hauptzähler',NULL,?)", t, messstelle, w.anlage(), LocalDate.parse("2020-01-01"));
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
    }

    /** Ein Monat der Reihe einer Messstelle (AP-08 IP-5) — Version 1 der Verdichtung, endgültig oder noch vorläufig. */
    private static void monat(Welt w, String kennzeichen, LocalDate erster, String menge, boolean endgueltig) {
        Instant b = erster.atStartOfDay(ZONE).toInstant();
        Instant e = erster.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int tage = erster.lengthOfMonth();
        long stunden = ChronoUnit.HOURS.between(b, e);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', '[]'::jsonb, "
                + "?, ?, 100, ?, ?, 1)", erster, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE, Timestamp.from(b),
                Timestamp.from(e), stunden, tage, tage, endgueltig ? tage : 0, menge, stunden * 60, stunden * 60,
                endgueltig ? "endgueltig" : "vorlaeufig", Timestamp.from(e.plus(Duration.ofDays(7))));
    }

    /** Eine Periodenwert-Bezugsgröße in kg an Halle 1. */
    private static void bezugsgroesse(Welt w, String kennzeichen, String name) {
        w.bezugsgroessen().put(kennzeichen, root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, "
                + "wertart, einheit, periode_art, geltung_art, ort_id) VALUES (?, ?, ?, 'periodenwert', 'kg', 'monat', "
                + "'gebaeude', ?) RETURNING id", UUID.class, w.mandant(), kennzeichen, name, w.halle()));
    }

    /** Fassung 1 eines Monatswerts, eingetragen am Morgen nach dem Monatsende (E16). */
    private static void erstwert(Welt w, String kennzeichen, LocalDate erster, String betrag) {
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", w.mandant(), w.bezugsgroessen().get(kennzeichen), erster, erster.plusMonths(1).minusDays(1),
                new BigDecimal(betrag), Timestamp.from(erster.plusMonths(1).atStartOfDay(ZONE).plusHours(9).toInstant()));
    }

    /**
     * SYNTHETISCH: Fassung 2 eines Monatswerts aus einem Import — eine Berichtigung mit Betrag oder eine Rücknahme ohne.
     * Der Import schreibt sie heute nicht (AP-09 IP-12/IP-13); die Tabelle prüft dieselben Wände wie für jeden Weg.
     */
    private static void fassungZwei(Welt w, LocalDate erster, BigDecimal betrag, String vorgang, String status,
            String importKennung, String begruendung, Instant erfasst) {
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, ersetzt_fassung, vorgang, status, betrag, begruendung, "
                + "herkunft_art, import_kennung, import_zeile, actor_sub, actor_name, actor_rolle, actor_art, created_at) "
                + "VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, 'Europe/Berlin', 2, 1, ?, ?, ?, ?, 'import', ?, 1, "
                + "'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde', ?)", w.mandant(), w.bezugsgroessen().get("BZ-1"),
                erster, erster.plusMonths(1).minusDays(1), vorgang, status, betrag, begruendung, importKennung,
                Timestamp.from(erfasst));
    }

    /**
     * SYNTHETISCH: die Meldung {@code correction} mit Bezug {@code bezugsgroesse}, wie AP-09 IP-7 sie schreibt
     * ({@code BezugswertService.correction}) — durch den echten {@link MessreiheEreignisRepository#anhaengen}.
     */
    private void melden(Welt w, String korrektur, LocalDate erster, String status, String importKennung) {
        ObjectNode e = MAPPER.createObjectNode();
        e.put("ereignis_id", UUID.nameUUIDFromBytes(("correction:" + w.mandant() + ":" + korrektur + ":" + status)
                .getBytes(StandardCharsets.UTF_8)).toString());
        e.put("art", "correction");
        e.put("von", erster.atStartOfDay(ZONE).toInstant().toString());
        e.put("bis", erster.plusMonths(1).atStartOfDay(ZONE).toInstant().toString());
        e.put("bezugsgroesse", "BZ-1");
        e.put("korrektur", korrektur);
        e.put("korrektur_art", EreignisVokabular.KORREKTUR_ART_BEZUGSWERT);
        e.put("status", status);
        e.put("fassung_alt", 1);
        e.put("fassung_neu", 2);
        e.put("import", importKennung);
        TenantContext.set(w.mandant());
        try {
            MessreiheEreignisRepository.Ergebnis r = ereignisse.anhaengen(w.mandant(), null,
                    EreignisVokabular.Urheber.KUNDE, e, null, null);
            assertThat(r.ausgang()).as(r.grund() + " " + r.hinweis())
                    .isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        } finally {
            TenantContext.clear();
        }
    }

    /** Ein Bezugs-Stammdatum am Unternehmen, gültig seit 2020 (AP-09 E15). */
    private static void stammdatum(Welt w, String kennzeichen, String name, String einheit, String wert) {
        UUID bg = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, unternehmen_id) VALUES (?, ?, ?, 'stammdatum', ?, NULL, 'unternehmen', ?) RETURNING id",
                UUID.class, w.mandant(), kennzeichen, name, einheit, w.unternehmen());
        root.update("INSERT INTO bezugsgroesse_stammdatum (tenant_id, bezugsgroesse_id, einheit, wert, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, '2020-01-01')", w.mandant(), bg, einheit, new BigDecimal(wert));
        w.bezugsgroessen().put(kennzeichen, bg);
    }

    // ================================================================ die echten Schreibwege

    @SafeVarargs
    private void anlegen(Welt w, String kennzeichen, String rechenform, String geltungArt, UUID geltung,
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

    /** K17 über die Route: Fassung 2 mit MS-24 als Zähler ab {@code ab} — nach der echten Uhr rückwirkend. */
    private void fassungZwei(Welt w, String kennzahl, String ab) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab);
        m.put("begruendung", "Seit dem Umzug des Kaltwassersatzes gehört die Prozesskühlung zum Stromeinsatz Spritzguss.");
        m.put("eingaenge", List.of(e("zaehler", "messstelle", "MS-24"), e("nenner", "bezugsgroesse", "BZ-1")));
        Antwort a = ruf(w, HttpMethod.POST, PFAD + "/" + w.kz().get(kennzahl) + "/fassungen", m);
        assertThat(a.status()).as(a.body().toString()).isBetween(200, 201);
        assertThat(root.queryForObject("SELECT rueckwirkend FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 2",
                Boolean.class, w.kz().get(kennzahl))).as("rückwirkend nach der echten Uhr").isTrue();
    }

    /** K12 über die Route: ein Stammdatum ab einem Tag — nach der echten Uhr rückwirkend. */
    private void stammdatumAb(Welt w, String kennzeichen, String wert, String ab) throws Exception {
        Antwort a = ruf(w, HttpMethod.PUT, BZ_PFAD + "/" + w.bezugsgroessen().get(kennzeichen) + "/stammdatum",
                Map.of("wert", wert, "gueltig_ab", ab));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(root.queryForList("SELECT rueckwirkend FROM bezugsgroesse_aenderung WHERE bezugsgroesse_id = ? "
                + "AND art = 'stammdatum_eingetragen'", Boolean.class, w.bezugsgroessen().get(kennzeichen)))
                .as("rückwirkend nach der echten Uhr").containsExactly(true);
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

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    private static JsonNode einziger(JsonNode werte) {
        assertThat(werte.get("werte")).as(werte.toString()).hasSize(1);
        return werte.get("werte").get(0);
    }

    // ================================================================ lesen

    /** Die neueste Zeile einer Kennzahl-Periode (höchste Version, dann jüngstes {@code berechnet_am}). */
    private static Map<String, Object> zeile(Welt w, String kennzahl, String art, LocalDate von) {
        List<Map<String, Object>> z = zeilen(w, kennzahl, art, von);
        assertThat(z).as(kennzahl + " " + art + " " + von + " hat eine Zeile").isNotEmpty();
        return z.get(z.size() - 1);
    }

    /** Alle Zeilen einer Kennzahl-Periode, älteste Version zuerst. */
    private static List<Map<String, Object>> zeilen(Welt w, String kennzahl, String art, LocalDate von) {
        return root.queryForList("SELECT w.id, w.version, w.wert, w.menge_zustand, w.kennzeichen::text AS kennzeichen, "
                + "w.grund, w.zustand, w.anlass_art, w.anlass_kennung, f.nummer AS definition_fassung FROM kennzahl_wert w "
                + "JOIN kennzahl k ON k.id = w.kennzahl_id JOIN kennzahl_fassung f ON f.id = w.definition_fassung_id "
                + "WHERE w.tenant_id = ? AND k.kennzeichen = ? AND w.periode_art = ? AND w.periode_von = ? "
                + "ORDER BY w.version NULLS FIRST, w.berechnet_am", w.mandant(), kennzahl, art, von);
    }

    /** Jede Zeile einer Kennzahl, deren Periode spätestens am {@code letzterTag} endet — mit ihren Eingängen. */
    private static String zeilenBis(Welt w, String kennzahl, LocalDate letzterTag) {
        return root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg(t::text || coalesce(e.t, ''), '|' "
                + "ORDER BY t::text)), '-') FROM kennzahl_wert t JOIN kennzahl k ON k.id = t.kennzahl_id "
                + "LEFT JOIN LATERAL (SELECT string_agg(x::text, ';' ORDER BY x.position) AS t FROM kennzahl_wert_eingang x "
                + "WHERE x.wert_id = t.id) e ON true WHERE t.tenant_id = ? AND k.kennzeichen = ? AND t.periode_bis <= ?",
                String.class, w.mandant(), kennzahl, letzterTag);
    }

    private static List<Map<String, Object>> eingaenge(Map<String, Object> zeile) {
        return root.queryForList("SELECT position, rolle, art, objekt, wert, version, fassung, kennzeichen::text AS "
                + "kennzeichen FROM kennzahl_wert_eingang WHERE wert_id = ? ORDER BY position", zeile.get("id"));
    }

    /** Die Meldungen {@code kennzahl_neu_gebildet}: Kennzahl|Auslöser|Version|Urheber|von|bis. */
    private static List<String> meldungen(Welt w) {
        return root.queryForList("SELECT concat_ws('|', kennungen ->> 'kennzahl', nutzlast ->> 'ausloeser', "
                + "nutzlast ->> 'version', urheber, to_char(von AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), "
                + "to_char(bis AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) FROM messreihe_ereignis "
                + "WHERE tenant_id = ? AND art = 'kennzahl_neu_gebildet' ORDER BY 1", String.class, w.mandant());
    }

    /** Die Wirkung der Kaskade im Kundenbereich: „Kennung Fassung Ergebnis“. */
    private static List<String> wirkung(Welt w) {
        return root.queryForList("SELECT anlass_kennung || ' ' || fassung || ' ' || ergebnis FROM messreihe_kaskade_wirkung "
                + "WHERE tenant_id = ? ORDER BY 1", String.class, w.mandant());
    }

    private static long anzahl(Welt w, String sql) {
        return root.queryForObject(sql, Long.class, w.mandant());
    }

    /** Alles, was ein Auslöser im Kundenbereich schreiben kann, Zeile für Zeile. */
    private static String tabellen(Welt w) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("kennzahl_wert", "kennzahl_wert_eingang", "messreihe_ereignis",
                "messreihe_kaskade_wirkung", "messreihe_periode_version")) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg("
                    + "t::text, '|' ORDER BY t::text)), '-') FROM " + tabelle + " t WHERE t.tenant_id = ?", String.class,
                    w.mandant())).append('\n');
        }
        return s.toString();
    }

    /** Der Beleg-Satz, den der Vertrag in einer Herkunft nennt — gesucht nach seinem Anfang, genau einer. */
    private static String belegImVertrag(String anfang) {
        List<String> treffer = vertrag.findValues("anlass").stream().filter(JsonNode::isTextual).map(JsonNode::asText)
                .filter(t -> t.startsWith(anfang)).distinct().toList();
        assertThat(treffer).as("kennzahl-vectors.json nennt genau einen Beleg „" + anfang + "…“").hasSize(1);
        return treffer.get(0);
    }

    /** Eine Zahl auf vier Stellen (U4) — {@code null} für „keine Werte“, nie 0. */
    private static String vier(Object o) {
        if (o == null || o instanceof JsonNode n && n.isNull()) {
            return null;
        }
        String t = o instanceof JsonNode n ? n.asText() : String.valueOf(o);
        return new BigDecimal(t).setScale(4, RoundingMode.HALF_UP).toPlainString();
    }

    private static List<String> saetze(Object json) {
        try {
            return json == null ? List.of() : MAPPER.readValue(json.toString(), new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
