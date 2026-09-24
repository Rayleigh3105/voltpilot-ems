package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Date;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Abnahme der Plan-Konstruktion (UEMS AP-17 IP-26, NW-6; E8 = A, W6): weniger Strom im Absolutwert ist keine
 * Verbesserung, wenn die Produktion stärker gesunken ist — und das System sagt es, ohne die rohe Zahl zu bewerten. Vier
 * Hälften, je ein Referenzfall, alles über die Routen, die das Portal ruft:
 * <ol>
 *   <li><b>R2</b> Dezember 2027 gegen BB-0001 Fassung 2: roh −8,8 % Strom / −21,9 % Produktion OHNE Urteil (kein
 *       Urteil-Wort in irgendeinem Feld der rohen Hälfte und der rohen Kennzahl), bereinigt +12,9 % {@code schlechter} mit
 *       Bedingung und Band; derselbe Monat als Leistungsvergleich-Stand Nr. 1 mit Prüfsumme, zweimal byte-gleich.</li>
 *   <li><b>R7</b> K-2026-0007 (MS-12 6 100 → 6 040) unter der freigegebenen BB-0002 Fassung 1: KZ-0001 Version 2, die
 *       Fassung byte-gleich (Grundlage und Prüfsumme), genau EIN Anstoß {@code grundlage_korrigiert} an der Basis.</li>
 *   <li><b>R4</b> März 2028 mit 390 000 kg: {@code nicht_anwendbar} / {@code variable_ausserhalb}, keine bereinigte Zahl,
 *       kein Urteil, der Kundensatz aus §5.8.</li>
 *   <li><b>R10</b> KZ-0003 ohne Bezugsbasis: kein Urteil, keine bereinigte Hälfte, kein Läufer schreibt einen Anstoß, die
 *       Kennzahl-Routen bleiben byte-gleich.</li>
 * </ol>
 *
 * <p><b>Jede Zahl kommt aus den Verträgen</b>, nicht aus dem Test: die Referenzdatei 1.8 (BB-0001/BB-0002 mit
 * Grundlagen und Freigaben, {@code kennzahlen[]} Oktober 2026, {@code korrekturen[]}, {@code abnahmefaelle_ap17} R7)
 * und {@code bezugsbasis-vectors.json} (R2 „Dezember 2027: roh ohne Urteil, bereinigt schlechter“, R4/G3 „März 2028:
 * 390 000 kg“ — Eingang UND Erwartung). Die Fassungen entstehen über die Routen von IP-7/IP-8 (entwerfen, freigeben),
 * die Kennzahl-Zeilen schreibt der Test so, wie der Rechenlauf sie schreibt (Muster {@code BezugsbasisApiTest}).
 *
 * <p><b>R2/R4 zwei Jahre früher</b> (Muster {@code BezugsbasisVergleichApiTest}, IP-19): Dezember 2027 ist hier
 * Dezember 2025, die Referenzperiode 11/2024–10/2025, März 2028 ist März 2026 — {@code bezugsgroesse_wert} nimmt nur
 * Perioden an, die vor der echten Uhr der Datenbank enden. <b>R7/R10</b> leben in der Welt der Kennzahl-Kaskade
 * ({@code UemsKennzahlKaskadeTest}, K7) mit ihren echten Tagen im Oktober/November 2026.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsProduktionsrueckgangAbnahmeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bezugsbasis-vectors.json");
    /** R2/R4: das Konzept rechnet 2027/2028 — die Testwelt zwei Jahre früher (siehe Klassenkommentar). */
    private static final int JAHRE_FRUEHER = 2;
    /** R2/R4: der Tag des Lesens — nach März 2026 (R4), vor der echten Uhr. */
    private static final Instant HEUTE = Instant.parse("2026-04-15T09:00:00Z");
    /** U1/VG3: die Wörter eines Urteils — keines davon darf an einer rohen Zahl hängen, in keinem Feld. */
    private static final Set<String> URTEIL_WOERTER = Set.of("besser", "schlechter", "im_rahmen", "im Rahmen",
            "Verbesserung", "verbessert", "Verschlechterung", "verschlechtert");
    /**
     * §5.8 „Nicht anwendbar, Spannweite“: „Modell nicht anwendbar: die Produktionsmenge im März 2028 (390 000 kg) liegt
     * außerhalb der Bezugsbasis (254 000–341 000 kg).“ — gebaut (IP-13) nennt der Satz die Bezugsgröße beim Namen.
     */
    private static final String SATZ_AUSSERHALB = "Modell nicht anwendbar: %s im %s (%s %s) liegt außerhalb der "
            + "Bezugsbasis (%s–%s %s).";

    // R7/R10: die Welt der Kennzahl-Kaskade (UemsKennzahlKaskadeTest, K7).
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final LocalDate OKT_1 = LocalDate.parse("2026-10-01");
    private static final LocalDate OKT_31 = LocalDate.parse("2026-10-31");
    /** Version 1: der Regellauf nach dem Monatsende. */
    private static final Instant T_V1 = Instant.parse("2026-11-10T08:00:00Z");
    /** BB-0002 Fassung 1: freigegeben am 10.11.2026 (Referenzdatei 1.8). */
    private static final Instant T_FREIGABE_BB2 = Instant.parse("2026-11-10T09:00:00Z");
    /** Die Kaskade im Takt der Freigabe von K-2026-0007 (12.11.2026 10:05:33). */
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

    @MockBean
    KennzahlAufrufer aufrufer;

    @Autowired
    KennzahlService kennzahlen;

    @Autowired
    BerichtService berichte;

    @Autowired
    KennzahlLauf lauf;

    @Autowired
    KennzahlenNaht naht;

    @Autowired
    BezugsbasisAnstoss anstoss;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    private static JdbcTemplate root;
    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        referenz = MAPPER.readTree(REFERENZ.toFile());
        vektoren = MAPPER.readTree(VEKTOREN.toFile());
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
        berichte.uhrStellen(Clock.systemUTC());
    }

    // ================================================================ R2: die Plan-Abnahme

    /**
     * R2/NW-6: Dezember 2027 (hier 2025) — die rohe Hälfte nennt −8,8 % Strom und −21,9 % Produktion und trägt KEIN Urteil,
     * in keinem Feld; die rohe Kennzahl ebenso. Die bereinigte Hälfte gegen BB-0001 Fassung 2 (über die Routen entworfen
     * und freigegeben) sagt +12,9 % {@code schlechter}, mit der Bedingung (250 000 kg, BZ-1 Fassung 1) und dem Band
     * (2,0 %). Derselbe Monat als Leistungsvergleich Stand Nr. 1: Urteil nur bereinigt, Prüfsumme, zweimal byte-gleich.
     */
    @Test
    void r2PlanAbnahmeRohOhneUrteilBereinigtSchlechter() throws Exception {
        JsonNode fall = vektor("Dezember 2027: roh ohne Urteil, bereinigt schlechter");
        JsonNode rohEin = fall.at("/eingang/roh");
        JsonNode rohSoll = fall.at("/erwartet/roh");
        JsonNode bSoll = fall.at("/erwartet/bereinigt");
        Spritzguss w = spritzguss();
        String dezember = frueher("2027-12");

        Antwort a = ruf(w.mandant(), HttpMethod.GET, PFAD + "/" + w.kz4() + "/vergleich?von=" + dezember + "&bis="
                + dezember, null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        assertThat(a.body().at("/bezugsbasis/kennzeichen").asText()).isEqualTo(bb1().get("kennzeichen").asText());
        JsonNode monat = a.body().at("/monate/0");
        assertThat(monat.get("periode").asText()).isEqualTo(dezember);

        // Roh: die Zahlen des Vektors — und nirgends ein Urteil.
        JsonNode roh = monat.get("roh");
        assertThat(zahl(roh.get("gemessen"))).isEqualByComparingTo(rohEin.get("gemessen").asText());
        assertThat(zahl(roh.get("vorher"))).isEqualByComparingTo(rohEin.get("vorher").asText());
        assertThat(roh.get("delta_prozent").asText()).isEqualTo(rohSoll.get("delta_prozent").asText());
        assertThat(roh.get("variable_delta_prozent").asText()).isEqualTo(rohSoll.get("variable_delta_prozent").asText());
        assertThat(roh.get("richtung").asText()).isEqualTo(rohSoll.get("richtung").asText());
        assertThat(roh.get("urteil").asText()).isEqualTo(rohSoll.get("urteil").asText()).isEqualTo("ohne_urteil");
        ohneUrteilWort(roh, "roh");

        // Die rohe Kennzahl (Werte-Route der Kennzahl-Seite) trägt ebenso kein Urteil — in keinem Feld.
        YearMonth dez = YearMonth.parse(dezember);
        Antwort werte = ruf(w.mandant(), HttpMethod.GET, PFAD + "/" + w.kz4() + "/werte?periode=monat&von="
                + dez.atDay(1) + "&bis=" + dez.atEndOfMonth(), null);
        assertThat(werte.status()).as(werte.text()).isEqualTo(200);
        ohneUrteilWort(werte.body(), "werte");

        // Bereinigt: gegen Fassung 2, mit Bedingung und Band — schlechter.
        JsonNode b = monat.get("bereinigt");
        JsonNode f2 = bb1().at("/fassungen/1");
        assertThat(b.at("/fassung/fassung").asInt()).isEqualTo(f2.get("fassung").asInt());
        assertThat(b.at("/fassung/methode").asText()).isEqualTo(f2.get("methode").asText());
        assertThat(b.at("/fassung/referenzperiode").asText()).isEqualTo(frueher(f2.get("referenzperiode").asText()));
        assertThat(b.at("/gemessen/version").asInt()).isEqualTo(1);
        assertThat(zahl(b.at("/gemessen/wert"))).isEqualByComparingTo(bSoll.get("gemessen").asText());
        assertThat(b.get("bedingung")).hasSize(1);
        assertThat(b.at("/bedingung/0/kennzeichen").asText()).isEqualTo(f2.at("/variablen/0/objekt").asText());
        assertThat(zahl(b.at("/bedingung/0/wert"))).isEqualByComparingTo(rohEin.get("variable").asText());
        assertThat(b.at("/bedingung/0/fassung").asInt()).isEqualTo(1);
        // Die Fassung rechnet a auf vier Stellen (10 522,6206); die Referenzdatei trägt es auf ganze kWh — erwartet gleich.
        assertThat(zahl(b.get("erwartet")).setScale(0, RoundingMode.HALF_UP))
                .isEqualByComparingTo(bSoll.get("erwartet").asText());
        assertThat(b.get("delta_prozent").asText()).isEqualTo(bSoll.get("delta_prozent").asText());
        assertThat(b.get("band_prozent").asText()).isEqualTo(bSoll.get("band_prozent").asText());
        assertThat(b.get("richtung").asText()).isEqualTo(bSoll.get("richtung").asText());
        assertThat(b.get("urteil").asText()).isEqualTo(bSoll.get("urteil").asText()).isEqualTo("schlechter");
        assertThat(b.get("grund").isNull()).isTrue();
        String variable = fall.at("/eingang/bereinigt/fassung/variablen/0/name").asText();
        assertThat(b.get("kennzeichen")).hasSize(1);
        assertThat(b.at("/kennzeichen/0").asText()).isEqualTo(bSoll.at("/kennzeichen/0").asText()
                .replace("um " + variable + " (", "um " + bz1().get("name").asText() + " ("));
        // Der Satz nennt die Bedingung und das Urteil — keine Ursache (U6).
        String satz = monat.get("satz").asText();
        assertThat(satz).contains("bei " + de(rohEin.get("variable").asText()) + " kg").endsWith(": schlechter.");

        // Derselbe Monat als Leistungsvergleich: Stand Nr. 1 — Urteil nur bereinigt, Prüfsumme, byte-gleich.
        berichte.uhrStellen(Clock.fixed(HEUTE, ZoneOffset.UTC));
        Antwort angelegt = ruf(w.mandant(), HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "leistungsvergleich",
                "geltung_id", w.unternehmen().toString(), "zeitraum", dezember, "kennzahl", w.kz4().toString()));
        assertThat(angelegt.status()).as(angelegt.text()).isEqualTo(201);
        String kennung = angelegt.body().get("kennung").asText();
        Antwort entwurf = ruf(w.mandant(), HttpMethod.GET, "/api/v1/berichte/" + kennung + "/entwurf", null);
        assertThat(entwurf.status()).as(entwurf.text()).isEqualTo(200);
        Antwort frei = ruf(w.mandant(), HttpMethod.POST, "/api/v1/berichte/" + kennung + "/freigeben",
                Map.of("entwurf_datenstand", entwurf.body().get("datenstand").asText()));
        assertThat(frei.status()).as(frei.text()).isEqualTo(201);
        assertThat(frei.body().get("nr").asInt()).isEqualTo(1);
        String summe = frei.body().get("pruefsumme").asText();
        assertThat(summe).matches("sha256:[0-9a-f]{64}");

        Antwort stand = ruf(w.mandant(), HttpMethod.GET, "/api/v1/berichte/" + kennung + "/staende/1", null);
        assertThat(stand.status()).as(stand.text()).isEqualTo(200);
        JsonNode abzug = stand.body().get("abzug");
        assertThat(summe).isEqualTo(BerichtRegeln.pruefsumme(BerichtRegeln.kanonisch(abzug)));
        assertThat(abzug.at("/kopf/bezugsbasis/fassung").asInt()).isEqualTo(f2.get("fassung").asInt());
        JsonNode zeile = abzug.at("/vergleich_je_periode/0");
        assertThat(zeile.at("/roh/urteil").asText()).isEqualTo("ohne_urteil");
        ohneUrteilWort(zeile.get("roh"), "Stand roh");
        assertThat(zeile.at("/bereinigt/urteil").asText()).isEqualTo(bSoll.get("urteil").asText());
        assertThat(zeile.at("/bereinigt/delta_prozent").asText()).isEqualTo(bSoll.get("delta_prozent").asText());
        assertThat(zeile.at("/bereinigt/bedingung/0/kennzeichen").asText()).isEqualTo(f2.at("/variablen/0/objekt").asText());
        assertThat(abzug.at("/urteil/urteil").asText()).isEqualTo(bSoll.get("urteil").asText());
        assertThat(ruf(w.mandant(), HttpMethod.GET, "/api/v1/berichte/" + kennung + "/staende/1", null).text())
                .as("ein zweiter Abruf des Stands ist byte-gleich").isEqualTo(stand.text());
    }

    // ================================================================ R7: Korrektur unter einer freigegebenen Basis

    /**
     * R7/W4: K-2026-0007 berichtigt MS-12 im Oktober 2026 (6 100 → 6 040). Die Kaskade macht KZ-0001 zur Version 2
     * (0,1473); die freigegebene Fassung 1 von BB-0002 bleibt byte-gleich (Route, Grundlage, Prüfsumme) — der Basiswert
     * wandert nie von selbst. Die Basis meldet genau EINEN Anstoß {@code grundlage_korrigiert} (Pfad 1), sichtbar in
     * {@code anstoesse[]} des Basis-Lesers (Nachlese 3); ein zweiter Takt setzt keinen zweiten.
     */
    @Test
    void r7KorrekturLaesstDieFassungByteGleichUndStoesstEinmalAn() throws Exception {
        JsonNode r7 = abnahmefall("R7").get("gegeben");
        JsonNode k7 = referenz.get("korrekturen").get(0);
        JsonNode bb2 = basisDerReferenz("BB-0002");
        JsonNode f1 = bb2.at("/fassungen/0");
        Halle w = k7Welt();
        UUID kz1 = w.kz().get("KZ-0001");

        kennzahlen.uhrStellen(Clock.fixed(T_FREIGABE_BB2, ZoneOffset.UTC));
        String basis = basisAnlegen(w.mandant(), kz1);
        Antwort entwurf = ruf(w.mandant(), HttpMethod.POST, basis + "/fassungen",
                entwurf(f1.get("referenzperiode").asText(), f1.get("methode").asText()));
        assertThat(entwurf.status()).as(entwurf.text()).isEqualTo(200);
        assertThat(entwurf.body().get("basiswert").asText()).isEqualTo(r7.at("/fassung_1/basiswert").asText());
        freigeben(w.mandant(), basis, 1, f1.at("/freigabe/begruendung").asText());
        Antwort vorher = ruf(w.mandant(), HttpMethod.GET, basis + "/fassungen/1", null);
        assertThat(vorher.status()).as(vorher.text()).isEqualTo(200);
        assertThat(vorher.body().get("freigabe_status").asText()).isEqualTo("freigegeben");
        String grundlage = root.queryForObject("SELECT grundlage FROM bezugsbasis_fassung WHERE tenant_id = ? "
                + "AND fassung = 1", String.class, w.mandant());
        JsonNode zitat = MAPPER.readTree(grundlage).at("/perioden/0/eingaenge/0");
        assertThat(zitat.get("objekt").asText()).isEqualTo("MS-12");
        assertThat(zitat.get("wert").decimalValue()).isEqualByComparingTo(r7.at("/fassung_1/grundlage/MS-12/wert_kwh")
                .asText());
        assertThat(zitat.get("version").asInt()).isEqualTo(r7.at("/fassung_1/grundlage/MS-12/version").asInt());
        assertThat(ruf(w.mandant(), HttpMethod.GET, basis, null).body().get("anstoesse")).isEmpty();

        inDerKaskade(con -> {
            ms12Version2(con, w, k7.get("neu_kwh").asText(), k7.get("kennung").asText());
            naht.nachKorrektur(con, betroffen(w, k7.get("kennung").asText()));
        });

        // Die Kennzahl wandert weiter: Version 2 mit dem Wert der Referenz.
        Map<String, Object> halle2 = kennzahlZeile(w, "KZ-0001");
        assertThat(halle2.get("version")).isEqualTo(2);
        assertThat(((BigDecimal) halle2.get("wert")).setScale(4, RoundingMode.HALF_UP))
                .isEqualByComparingTo(r7.at("/korrektur/KZ-0001_version_2").asText());

        // Die Basis nicht: Fassung 1 byte-gleich — Route, Grundlage und Prüfsumme.
        kennzahlen.uhrStellen(Clock.fixed(T_KASKADE, ZoneOffset.UTC));
        assertThat(ruf(w.mandant(), HttpMethod.GET, basis + "/fassungen/1", null).text())
                .as("Fassung 1 byte-gleich nach der Korrektur").isEqualTo(vorher.text());
        assertThat(root.queryForObject("SELECT grundlage FROM bezugsbasis_fassung WHERE tenant_id = ? AND fassung = 1",
                String.class, w.mandant())).isEqualTo(grundlage);
        assertThat(vorher.body().get("pruefsumme").asText()).isEqualTo(BezugsbasisGrundlage.pruefsumme(grundlage));

        // Sie meldet: genau EIN Anstoß, Pfad 1, an Fassung 1, offen.
        JsonNode anstoesse = ruf(w.mandant(), HttpMethod.GET, basis, null).body().get("anstoesse");
        assertThat(anstoesse).as(anstoesse.toString()).hasSize(1);
        JsonNode a = anstoesse.get(0);
        assertThat(a.get("art").asText()).isEqualTo(r7.at("/anstoss/art").asText()).isEqualTo("grundlage_korrigiert");
        assertThat(a.get("pfad").asInt()).isEqualTo(1);
        // Die Kennung der Kaskade: K-2026-0007 in ihrer freigegebenen Fassung 2 (Vorschlag = 1, Freigabe = 2).
        assertThat(a.get("anlass_kennung").asText()).startsWith(k7.get("kennung").asText())
                .isEqualTo(BezugsbasisAnstoss.kennung(betroffen(w, k7.get("kennung").asText())));
        assertThat(a.get("fassung").asInt()).isEqualTo(1);
        assertThat(a.get("offen").asBoolean()).isTrue();
        // Der Kundensatz nennt die zitierte und die gültige Version mit ihren Werten (R7 „Anstoß“).
        assertThat(a.get("anlass_satz").asText()).contains(k7.get("kennung").asText())
                .contains("Version 1 (" + komma(r7.at("/fassung_1/grundlage/KZ-0001/wert").asText()) + ")")
                .contains("Version 2 (" + komma(r7.at("/korrektur/KZ-0001_version_2").asText()) + ")");

        // Nachzug im nächsten Takt: kein zweiter Anstoß, Fassung weiter byte-gleich.
        inDerKaskade(con -> naht.nachKorrektur(con, betroffen(w, k7.get("kennung").asText())));
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_anstoss WHERE tenant_id = ?", Integer.class,
                w.mandant())).isOne();
        assertThat(ruf(w.mandant(), HttpMethod.GET, basis + "/fassungen/1", null).text()).isEqualTo(vorher.text());
    }

    // ================================================================ R4: außerhalb der Spannweite

    /**
     * R4/G3: März 2028 (hier 2026) mit 390 000 kg liegt außerhalb der tolerierten Spannweite der Fassung 2 — das Modell ist
     * {@code nicht_anwendbar} mit Grund {@code variable_ausserhalb}: keine bereinigte Zahl, kein Band, keine Richtung, kein
     * Urteil; roh ebenso ohne Urteil; der Satz aus §5.8.
     */
    @Test
    void r4AusserhalbDerSpannweiteNichtAnwendbar() throws Exception {
        JsonNode fall = vektor("R4/G3 März 2028: 390 000 kg außerhalb der Spannweite, Modell nicht anwendbar");
        JsonNode soll = fall.get("erwartet");
        Spritzguss w = spritzguss();
        String maerz = frueher("2028-03");

        Antwort a = ruf(w.mandant(), HttpMethod.GET, PFAD + "/" + w.kz4() + "/vergleich?von=" + maerz + "&bis=" + maerz,
                null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        JsonNode m = a.body().at("/monate/0");
        JsonNode b = m.get("bereinigt");
        assertThat(b.get("urteil").asText()).isEqualTo(soll.get("urteil").asText()).isEqualTo("nicht_anwendbar");
        assertThat(b.get("grund").asText()).isEqualTo(soll.get("grund").asText()).isEqualTo("variable_ausserhalb");
        for (String feld : List.of("erwartet", "delta_prozent", "band_prozent", "richtung")) {
            assertThat(soll.get(feld).isNull()).as("Vektor " + feld).isTrue();
            assertThat(b.get(feld).isNull()).as("keine bereinigte Zahl: " + feld).isTrue();
        }
        assertThat(zahl(b.at("/gemessen/wert"))).isEqualByComparingTo(soll.get("gemessen").asText());
        assertThat(m.at("/roh/urteil").asText()).isEqualTo("ohne_urteil");
        ohneUrteilWort(m.get("roh"), "roh März");

        JsonNode spannweite = bb1().at("/fassungen/1/spannweite");
        YearMonth monat = YearMonth.parse(maerz);
        assertThat(m.get("satz").asText()).isEqualTo(String.format(SATZ_AUSSERHALB, bz1().get("name").asText(),
                m.get("beschriftung").asText(), de(fall.at("/eingang/variablen/0/wert").asText()), "kg",
                de(spannweite.get("von").asText()), de(spannweite.get("bis").asText()), "kg"));
        assertThat(m.get("beschriftung").asText()).isEqualTo("März " + monat.getYear());
        ohneUrteilWort(m.get("satz"), "Satz März");
    }

    // ================================================================ R10: ohne Basis merkt nichts

    /**
     * R10: KZ-0003 (Unternehmen, Zusammenfassung) hat keine Bezugsbasis. Der Vergleich antwortet 200 ohne Basis (Vertrag
     * §16): jeder Monat {@code basis_fehlt}, keine bereinigte Zahl, roh ohne Urteil, am Kopf der Leer-Satz. Kein Läufer
     * schreibt einen Anstoß — weder der Struktur-Läufer (Pfad 2) noch die Kaskade (Pfad 1), obwohl KZ-0003 durch
     * K-2026-0007 Version 2 wird —, und die Kennzahl-Routen sind vor und nach den Läufen byte-gleich.
     */
    @Test
    void r10OhneBasisKeinUrteilUndKeinLaeuferSchreibt() throws Exception {
        JsonNode kz3 = kennzahlDerReferenz("KZ-0003");
        Halle w = k7Welt();
        UUID id = w.kz().get("KZ-0003");
        kennzahlen.uhrStellen(Clock.fixed(T_KASKADE, ZoneOffset.UTC));

        String oktober = YearMonth.from(OKT_1).toString();
        String vergleichPfad = PFAD + "/" + id + "/vergleich?von=" + oktober + "&bis=" + oktober;
        Antwort v = ruf(w.mandant(), HttpMethod.GET, vergleichPfad, null);
        assertThat(v.status()).as(v.text()).isEqualTo(200);
        assertThat(v.body().get("bezugsbasis").isNull()).isTrue();
        assertThat(v.body().get("satz").asText()).isEqualTo(BezugsbasisVergleichSatz.LEER);
        JsonNode m = v.body().at("/monate/0");
        assertThat(zahl(m.at("/roh/gemessen"))).isEqualByComparingTo(kz3.get("oktober_2026_zaehler").asText());
        assertThat(m.at("/roh/urteil").asText()).isEqualTo("ohne_urteil");
        ohneUrteilWort(m.get("roh"), "roh KZ-0003");
        JsonNode b = m.get("bereinigt");
        assertThat(b.get("urteil").asText()).isEqualTo("nicht_anwendbar");
        assertThat(b.get("grund").asText()).isEqualTo("basis_fehlt");
        assertThat(b.get("fassung").isNull()).isTrue();
        assertThat(b.get("bedingung")).isEmpty();
        for (String feld : List.of("erwartet", "delta_prozent", "band_prozent", "richtung")) {
            assertThat(b.get(feld).isNull()).as("keine bereinigte Hälfte: " + feld).isTrue();
        }
        assertThat(v.body().get("staende")).isEmpty();
        assertThat(ruf(w.mandant(), HttpMethod.GET, PFAD + "/" + id + "/bezugsbasen", null).body().get("bezugsbasen"))
                .isEmpty();

        List<String> routen = List.of(PFAD + "/" + id, PFAD + "/" + id + "/werte?periode=monat&von=" + OKT_1 + "&bis="
                + OKT_31, vergleichPfad);
        List<String> vorher = texte(w.mandant(), routen);

        // Der Struktur-Läufer (Pfad 2), zweimal: nichts gelesen, das eine Basis betrifft — nichts geschrieben.
        assertThat(anstoss.strukturLauf(admin, T_KASKADE, 50).gesetzt()).isEmpty();
        assertThat(anstoss.strukturLauf(admin, T_KASKADE, 50).gesetzt()).isEmpty();
        assertThat(texte(w.mandant(), routen)).as("Kennzahl-Routen byte-gleich nach den Läufen").isEqualTo(vorher);

        // Die Kaskade (Pfad 1): KZ-0003 wird Version 2 — und trotzdem kein Anstoß, keine Basis, kein Urteil.
        inDerKaskade(con -> {
            ms12Version2(con, w, referenz.at("/korrekturen/0/neu_kwh").asText(),
                    referenz.at("/korrekturen/0/kennung").asText());
            naht.nachKorrektur(con, betroffen(w, referenz.at("/korrekturen/0/kennung").asText()));
        });
        assertThat(kennzahlZeile(w, "KZ-0003").get("version")).isEqualTo(2);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_anstoss WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();
        Antwort danach = ruf(w.mandant(), HttpMethod.GET, vergleichPfad, null);
        assertThat(danach.body().at("/monate/0/bereinigt/grund").asText()).isEqualTo("basis_fehlt");
        assertThat(danach.body().at("/monate/0/roh/urteil").asText()).isEqualTo("ohne_urteil");
        ohneUrteilWort(danach.body().at("/monate/0/roh"), "roh KZ-0003 nach der Kaskade");
    }

    // ================================================================ Prüfwerkzeug

    /** U1/VG3: kein Urteil-Wort in irgendeinem Feld — Schlüssel und Werte, rekursiv. */
    private static void ohneUrteilWort(JsonNode knoten, String wo) {
        List<String> funde = new ArrayList<>();
        sammeln(knoten, "", funde);
        assertThat(funde).as(wo + ": ein Urteil an einer rohen Zahl — " + knoten).isEmpty();
    }

    private static void sammeln(JsonNode n, String pfad, List<String> funde) {
        if (n == null) {
            return;
        }
        if (n.isObject()) {
            n.fields().forEachRemaining(e -> {
                if (URTEIL_WOERTER.contains(e.getKey())) {
                    funde.add(pfad + "/" + e.getKey());
                }
                sammeln(e.getValue(), pfad + "/" + e.getKey(), funde);
            });
        } else if (n.isArray()) {
            for (int i = 0; i < n.size(); i++) {
                sammeln(n.get(i), pfad + "/" + i, funde);
            }
        } else if (n.isTextual()) {
            for (String wort : URTEIL_WOERTER) {
                if (n.asText().contains(wort)) {
                    funde.add(pfad + " = " + n.asText());
                }
            }
        }
    }

    private List<String> texte(UUID mandant, List<String> routen) throws Exception {
        List<String> aus = new ArrayList<>();
        for (String r : routen) {
            Antwort a = ruf(mandant, HttpMethod.GET, r, null);
            assertThat(a.status()).as(r + " " + a.text()).isEqualTo(200);
            aus.add(a.text());
        }
        return aus;
    }

    // ================================================================ Verträge lesen

    private static JsonNode vektor(String name) {
        for (JsonNode c : vektoren.get("cases")) {
            if (c.get("name").asText().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("kein Vektor " + name);
    }

    private static JsonNode abnahmefall(String fall) {
        for (JsonNode f : referenz.at("/abnahmefaelle_ap17/faelle")) {
            if (f.get("fall").asText().equals(fall)) {
                return f;
            }
        }
        throw new AssertionError("kein Abnahmefall " + fall);
    }

    private static JsonNode basisDerReferenz(String kennzeichen) {
        for (JsonNode b : referenz.get("bezugsbasen")) {
            if (b.get("kennzeichen").asText().equals(kennzeichen)) {
                return b;
            }
        }
        throw new AssertionError("keine Bezugsbasis " + kennzeichen);
    }

    private static JsonNode kennzahlDerReferenz(String kennzeichen) {
        for (JsonNode k : referenz.get("kennzahlen")) {
            if (k.get("kennzeichen").asText().equals(kennzeichen)) {
                return k;
            }
        }
        throw new AssertionError("keine Kennzahl " + kennzeichen);
    }

    private static JsonNode bb1() {
        return basisDerReferenz("BB-0001");
    }

    private static JsonNode bz1() {
        for (JsonNode b : referenz.get("bezugsgroessen")) {
            if ("BZ-1".equals(b.path("kennzeichen").asText())) {
                return b;
            }
        }
        throw new AssertionError("keine BZ-1");
    }

    /** {@code JJJJ-MM} oder {@code JJJJ-MM/JJJJ-MM} des Konzepts, zwei Jahre früher. */
    private static String frueher(String periode) {
        if (periode.contains("/")) {
            String[] t = periode.split("/");
            return frueher(t[0]) + "/" + frueher(t[1]);
        }
        return YearMonth.parse(periode).minusYears(JAHRE_FRUEHER).toString();
    }

    /** Ganze Zahl mit Tausender-Leerzeichen, wie die Sätze sie schreiben („390 000“). */
    private static String de(String zahl) {
        String s = new BigDecimal(zahl).setScale(0, RoundingMode.HALF_UP).toPlainString();
        StringBuilder aus = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            if (i > 0 && (s.length() - i) % 3 == 0) {
                aus.append(' ');
            }
            aus.append(s.charAt(i));
        }
        return aus.toString();
    }

    /** Eine Dezimalzahl der Referenz mit Dezimalkomma („0,1473“). */
    private static String komma(String zahl) {
        return zahl.replace('.', ',');
    }

    private static BigDecimal zahl(JsonNode n) {
        return new BigDecimal(n.asText());
    }

    // ================================================================ R2/R4: Spritzguss P-1 (zwei Jahre früher)

    private record Spritzguss(UUID mandant, UUID unternehmen, UUID kz4) {}

    /**
     * Ahrenberg mit Prozess P-1 Spritzguss (MS-20, BZ-1), KZ-0004 mit Geltung Prozess; die Monate der Grundlagen von
     * BB-0001 Fassung 1 und 2, dazu November/Dezember 2027 (R2) und März 2028 (R4) aus den Vektoren — alle zwei Jahre
     * früher. BB-0001 entsteht über die Routen: Fassung 1 am Freigabetag der Referenz, Fassung 2 an ihrem.
     */
    private Spritzguss spritzguss() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Abnahme #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID p1 = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-1', 'Spritzguss', '2020-01-01') RETURNING id", UUID.class, t, u);
        UUID ms20 = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, ms20, st1);
        root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, ms20, p1);
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, prozess_id) VALUES (?, 'BZ-1', ?, 'periodenwert', 'kg', 'monat', 'prozess', ?) "
                + "RETURNING id", UUID.class, t, bz1().get("name").asText(), p1);

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", "KZ-0004");
        m.put("name", kennzahlDerReferenzName("KZ-0004"));
        m.put("rechenform", "quotient");
        m.put("geltung_art", "prozess");
        m.put("geltung_id", p1.toString());
        m.put("eingaenge", List.of(e("zaehler", "messstelle", "MS-20"), e("nenner", "bezugsgroesse", "BZ-1")));
        Antwort kz = ruf(t, HttpMethod.POST, PFAD, m);
        assertThat(kz.status()).as(kz.text()).isEqualTo(201);
        UUID kz4 = UUID.fromString(kz.body().get("id").asText());
        Spritzguss w = new Spritzguss(t, u, kz4);

        // Die Grundlagen der Referenz (Fassung 1: Oktober 2026; Fassung 2: 11/2026–10/2027) als Kennzahl-Monate.
        for (JsonNode f : bb1().get("fassungen")) {
            for (JsonNode g : f.get("grundlage")) {
                monat(w, bz1, frueher(g.get("periode").asText()), g.at("/zaehler/wert").asText(),
                        g.at("/nenner/wert").asText());
            }
        }
        // R2: November (Vormonat) und Dezember 2027; R4: März 2028 — aus den Vektoren.
        JsonNode roh = vektor("Dezember 2027: roh ohne Urteil, bereinigt schlechter").at("/eingang/roh");
        monat(w, bz1, frueher("2027-11"), roh.get("vorher").asText(), roh.get("variable_vorher").asText());
        monat(w, bz1, frueher("2027-12"), roh.get("gemessen").asText(), roh.get("variable").asText());
        JsonNode maerz = vektor("R4/G3 März 2028: 390 000 kg außerhalb der Spannweite, Modell nicht anwendbar")
                .get("eingang");
        monat(w, bz1, frueher("2028-03"), maerz.at("/gemessen/wert").asText(), maerz.at("/variablen/0/wert").asText());

        // BB-0001 über die Routen: Fassung 1 (Verhältnis, vorläufig), dann Fassung 2 (Modell), je an ihrem Freigabetag.
        JsonNode f1 = bb1().at("/fassungen/0");
        JsonNode f2 = bb1().at("/fassungen/1");
        kennzahlen.uhrStellen(Clock.fixed(freigabetag(f1), ZoneOffset.UTC));
        String basis = basisAnlegen(t, kz4);
        Antwort e1 = ruf(t, HttpMethod.POST, basis + "/fassungen", entwurf(frueher(f1.get("referenzperiode").asText()),
                f1.get("methode").asText()));
        assertThat(e1.status()).as(e1.text()).isEqualTo(200);
        assertThat(e1.body().get("basiswert").asText()).isEqualTo(f1.get("basiswert").asText());
        freigeben(t, basis, 1, f1.at("/freigabe/begruendung").asText());

        kennzahlen.uhrStellen(Clock.fixed(freigabetag(f2), ZoneOffset.UTC));
        Map<String, Object> zwei = entwurf(frueher(f2.get("referenzperiode").asText()), f2.get("methode").asText());
        List<String> gruende = new ArrayList<>();
        f2.get("anpassungsgruende").forEach(g -> gruende.add(g.asText()));
        zwei.put("anpassungsgruende", gruende);
        zwei.put("begruendung", f2.at("/freigabe/begruendung").asText());
        Antwort e2 = ruf(t, HttpMethod.POST, basis + "/fassungen", zwei);
        assertThat(e2.status()).as(e2.text()).isEqualTo(200);
        assertThat(e2.body().get("gilt_ab").asText()).isEqualTo(YearMonth.parse(frueher(f2.get("gilt_ab").asText()
                .substring(0, 7))).atDay(1).toString());
        assertThat(e2.body().get("basiswert").asText()).isEqualTo(f2.get("basiswert").asText());
        assertThat(e2.body().get("streuung_prozent").asText()).isEqualTo(f2.get("streuung_prozent").asText());
        assertThat(e2.body().at("/koeffizienten/b").asText()).isEqualTo(f2.at("/koeffizienten/b").asText());
        freigeben(t, basis, 2, f2.at("/freigabe/begruendung").asText());

        kennzahlen.uhrStellen(Clock.fixed(HEUTE, ZoneOffset.UTC));
        return w;
    }

    private static String kennzahlDerReferenzName(String kennzeichen) {
        for (String liste : List.of("kennzahlen", "kennzahlen_1_8")) {
            for (JsonNode k : referenz.path(liste)) {
                if (kennzeichen.equals(k.path("kennzeichen").asText()) && k.hasNonNull("name")) {
                    return k.get("name").asText();
                }
            }
        }
        throw new AssertionError("kein Name für " + kennzeichen);
    }

    /** Der Freigabetag einer Fassung der Referenz, zwei Jahre früher, 09:00 UTC. */
    private static Instant freigabetag(JsonNode fassung) {
        return LocalDate.parse(fassung.at("/freigabe/am").asText()).minusYears(JAHRE_FRUEHER).atTime(9, 0)
                .toInstant(ZoneOffset.UTC);
    }

    /**
     * Ein endgültiger Monat von KZ-0004, wie der Rechenlauf ihn schreibt (Version 1, ungerundet, beide Eingänge), und der
     * Wert der Produktionsmenge BZ-1 (Fassung 1), den der Vergleich als Bedingung liest.
     */
    private static void monat(Spritzguss w, UUID bz1, String periode, String kwh, String kg) {
        LocalDate von = YearMonth.parse(periode).atDay(1);
        LocalDate bis = von.plusMonths(1).minusDays(1);
        BigDecimal zaehler = new BigDecimal(kwh);
        BigDecimal nenner = new BigDecimal(kg);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, w.kz4());
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, w.mandant(), w.kz4(), Date.valueOf(von),
                Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner, am, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "'MS-20', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-20'), ?, 'kWh', "
                + "'vollständig', 1)", w.mandant(), wert, w.kz4(), w.mandant(), zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', ?, ?, 'kg', 'vollständig', 1)", w.mandant(), wert, w.kz4(), bz1, nenner);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, 'Europe/Berlin', "
                + "1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                w.mandant(), bz1, Date.valueOf(von), Date.valueOf(bis), nenner);
    }

    // ================================================================ R7/R10: Halle 2 und Lindach (K7)

    private record Halle(UUID mandant, UUID unternehmen, UUID g2, UUID g5, UUID halle2, UUID lindach,
            Map<String, UUID> komponenten, Map<String, UUID> messstellen, Map<String, UUID> kz) {}

    @FunctionalInterface
    private interface Schritt {
        void fahren(Connection con) throws SQLException;
    }

    /**
     * Ahrenberg im Oktober 2026 wie in der Kennzahl-Kaskade (K7): Halle 2 (MS-12 ÷ BZ-6 = KZ-0001), Lindach (MS-18 ÷ BZ-7
     * = KZ-0002), das Unternehmen (KZ-0003 = Zusammenfassung); die Zahlen aus {@code kennzahlen[]} der Referenz, Version 1
     * aus dem Regellauf; K-2026-0007 als Vorschlag und Freigabe.
     */
    private Halle k7Welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Abnahme K7 #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        Halle w = new Halle(t, u, gebaeude(t, st1, "Halle 2", "G-2"), gebaeude(t, st2, "Montagehalle Lindach", "G-5"),
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

        JsonNode kz1 = kennzahlDerReferenz("KZ-0001");
        JsonNode kz2 = kennzahlDerReferenz("KZ-0002");
        reihe(w, "MS-12", kz1.get("oktober_2026_zaehler").asText(), List.of());
        reihe(w, "MS-18", kz2.get("oktober_2026_zaehler").asText(), List.of("ab 15.10.2026"));
        bezugswert(w, "BZ-6", kz1.get("oktober_2026_nenner").asText());
        bezugswert(w, "BZ-7", kz2.get("oktober_2026_nenner").asText());
        w.kz().put("KZ-0001", anlegen(w, "KZ-0001", "quotient", "gebaeude", w.g2(), e("zaehler", "messstelle", "MS-12"),
                e("nenner", "bezugsgroesse", "BZ-6")));
        w.kz().put("KZ-0002", anlegen(w, "KZ-0002", "quotient", "gebaeude", w.g5(), e("zaehler", "messstelle", "MS-18"),
                e("nenner", "bezugsgroesse", "BZ-7")));
        w.kz().put("KZ-0003", anlegen(w, "KZ-0003", "zusammenfassung", "unternehmen", w.unternehmen(),
                e("paar", "kennzahl", "KZ-0001"), e("paar", "kennzahl", "KZ-0002")));
        korrekturK7(w);
        lauf.lauf(T_V1);
        Map<String, Object> v1 = kennzahlZeile(w, "KZ-0001");
        assertThat(v1.get("version")).as("Version 1 vor der Kaskade").isEqualTo(1);
        assertThat(((BigDecimal) v1.get("wert")).setScale(4, RoundingMode.HALF_UP))
                .isEqualByComparingTo(kz1.get("oktober_2026_wert").asText());
        assertThat(kennzahlZeile(w, "KZ-0003").get("zustand")).isEqualTo("endgueltig");
        return w;
    }

    /** K-2026-0007 wie in der Referenzdatei — vorgeschlagen und freigegeben (Muster {@code UemsKennzahlKaskadeTest}). */
    private static void korrekturK7(Halle w) {
        JsonNode k = referenz.get("korrekturen").get(0);
        String reihen = MAPPER.createArrayNode().add(MAPPER.createObjectNode()
                .put("entity_id", w.komponenten().get(k.get("reihe").asText()).toString()).put("messkanal", ENERGIE))
                .toString();
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 1, "
                + "'vorschlag', 'nachlieferung_nach_endgueltigkeit', ?::jsonb, '2026-10-01T00:00:00+02:00', "
                + "'2026-11-01T00:00:00+01:00', ?, '[{}]'::jsonb, 'kc-ines-kaltenbach', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?::timestamptz)", w.mandant(), k.get("kennung").asText(), reihen,
                k.get("begruendung").asText(), k.get("vorgeschlagen_am").asText());
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art, created_at) VALUES (?, ?, 2, 'freigegeben', NULL, 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', ?::timestamptz)", w.mandant(), k.get("kennung").asText(),
                k.get("freigegeben_am").asText());
    }

    /** EINE Transaktion wie ein Anlass der Korrektur-Kaskade: alles oder nichts, als Verwaltungsrolle. */
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

    /** Die Monats-Version 2 der Reihe von MS-12, so wie die Monats-Stufe der Kaskade sie schreibt. */
    private static void ms12Version2(Connection con, Halle w, String kwh, String kennung) throws SQLException {
        Instant b = OKT_1.atStartOfDay(ZONE).toInstant();
        Instant e = OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int minuten = (int) ChronoUnit.MINUTES.between(b, e);
        KaskadeStufen.Inhalt inhalt = new KaskadeStufen.Inhalt("counter", new BigDecimal(kwh), "vollständig", List.of(),
                minuten, minuten, 100, null, null, null, null, null, null, null, null, null, null, null, "endgueltig");
        KaskadeStufen.periodeSchreiben(con, new KaskadeStufen.Periode(w.mandant(), "monat", w.komponenten().get("MS-12"),
                ENERGIE, null, b, e, OKT_1, ZONE), 2, inhalt, List.of(kennung), List.of(), kennung, 2, null);
    }

    /** Was die Kaskade nach K-2026-0007 an die Nähte gibt: die Reihe von MS-12, der Oktober, der Zeitpunkt des Laufs. */
    private static KorrekturKaskade.Betroffen betroffen(Halle w, String kennung) {
        return new KorrekturKaskade.Betroffen(w.mandant(), kennung, 2, KorrekturKaskade.FREIGEGEBEN,
                List.of(new KorrekturKaskade.Reihe(w.komponenten().get("MS-12"), ENERGIE)),
                OKT_1.atStartOfDay(ZONE).toInstant(), OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant(), ZONE, OKT_1,
                OKT_31, List.of(), List.of(), 1, T_KASKADE);
    }

    private static Map<String, Object> kennzahlZeile(Halle w, String kennzahl) {
        List<Map<String, Object>> z = root.queryForList("SELECT w.version, w.wert, w.zustand FROM kennzahl_wert w "
                + "JOIN kennzahl k ON k.id = w.kennzahl_id WHERE w.tenant_id = ? AND k.kennzeichen = ? "
                + "AND w.periode_art = 'monat' AND w.periode_von = ? ORDER BY w.version DESC NULLS LAST, "
                + "w.berechnet_am DESC LIMIT 1", w.mandant(), kennzahl, OKT_1);
        assertThat(z).as(kennzahl + " Oktober hat eine Zeile").hasSize(1);
        return z.get(0);
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
    private static void messstelle(Halle w, String kennzeichen, UUID anlage, String stellung, String unterzaehlerVon) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-ABNAHME-" + kennzeichen + "-" + UUID.randomUUID());
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
    private static void reihe(Halle w, String kennzeichen, String menge, List<String> saetze) throws Exception {
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
    private static void bezugswert(Halle w, String kennzeichen, String betrag) {
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
    private UUID anlegen(Halle w, String kennzeichen, String rechenform, String geltungArt, UUID geltung,
            Map<String, Object>... eingaenge) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", kennzahlDerReferenzName(kennzeichen));
        m.put("rechenform", rechenform);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        m.put("eingaenge", List.of(eingaenge));
        Antwort a = ruf(w.mandant(), HttpMethod.POST, PFAD, m);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    /** Die Bezugsbasis über die Route von IP-7; zurück kommt ihr Pfad. */
    private String basisAnlegen(UUID mandant, UUID kennzahl) throws Exception {
        Antwort a = ruf(mandant, HttpMethod.POST, PFAD + "/" + kennzahl + "/bezugsbasen", null);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return PFAD + "/" + kennzahl + "/bezugsbasen/" + a.body().get("id").asText();
    }

    private static Map<String, Object> entwurf(String referenzperiode, String methode) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("referenzperiode", referenzperiode);
        m.put("methode", methode);
        return m;
    }

    /** Die Freigabe über die Route von IP-8 (ohne vier Augen, mit Begründung der Referenz). */
    private void freigeben(UUID mandant, String basis, int fassung, String begruendung) throws Exception {
        Antwort a = ruf(mandant, HttpMethod.POST, basis + "/fassungen/" + fassung + "/freigeben",
                Map.of("begruendung", begruendung));
        assertThat(a.status()).as("freigeben " + fassung + " " + a.text()).isEqualTo(200);
    }

    /** Ines Kaltenbach, Kundenadministratorin ihres Kundenbereichs (nie zugewiesen, E12). */
    private Antwort ruf(UUID mandant, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + mandant);
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", mandant.toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }
}
