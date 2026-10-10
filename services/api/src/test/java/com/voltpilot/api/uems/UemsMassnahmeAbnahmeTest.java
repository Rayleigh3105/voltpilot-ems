package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MassnahmeWelt.Antwort;
import com.voltpilot.api.uems.MassnahmeWelt.Welt;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Abnahme der Plan-Konstruktion (UEMS AP-18 IP-22, NW-6) — die zwei Sätze des Auftrags als grüner Test: „Eine
 * Maßnahme ist mit Ziel, Verantwortlichem, Messgrundlage und Ergebnis verbunden. Die Software behauptet keine Ursache,
 * die die Daten nicht tragen.“ Alles über die Routen, die das Portal ruft, in der Welt von {@link MassnahmeWelt}
 * (Referenzdatei 1.9, Kunststoffwerk Ahrenberg), mit gestellter Uhr. Die Gruppen:
 * <ol>
 *   <li><b>Verbunden</b> (R3, R6, R10): M-2028-0001 trägt EZ-2028-0001, Murat Demirci (aktives Konto), KZ-0004 ×
 *       BB-0001 Fassung 2 × Ausgangslage Dezember 2027 (Prüfsumme) und den Stand Nr. 1 {@code belegt} mit Person,
 *       Begründung und Prüfsumme; AW-2028-0001 schließt mit der Maßnahme; EZ-2028-0001 wird {@code verfehlt}
 *       bewertet.</li>
 *   <li><b>Keine Ursache</b> (R2, R8, SP2): kein Satz eines Lesers — Vergleich, Wirkung, Ziel-Stand, Abweichung,
 *       Auffälligkeit, Maßnahme, Bewertung, Übersicht — enthält „Ursache“ ohne „Aussage von“, „hat gewirkt“ oder „Einsparung
 *       durch“; einmal im Quelltext der Leser und der Satz-Schablonen, einmal in jeder Antwort des Plans.</li>
 *   <li><b>Januar 2028</b> (R6): 3,5 % „besser“ vor der Umsetzung ist keine Wirkung.</li>
 *   <li><b>Ohne Person</b> (E6, WK6): {@code bewertung: null}, auch mit offenem Vier-Augen-Antrag; der Satz der Fläche
 *       ist {@code bewertung_offen} „Beobachtet — nicht belegt …“.</li>
 *   <li><b>Ohne Messgrundlage</b> (R7): M-2028-0002 nur {@code nicht_messbar}, {@code belegt} 422.</li>
 * </ol>
 * <ol start="6">
 *   <li><b>Anstoß statt Umbau</b> (R12, IP-17): K-2028-0001 macht Dezember 2027 zur Version 2 (+12,0 %); die
 *       Ausgangslage von M-2028-0001 bleibt byte-gleich (Version 1, +12,9 %), genau ein Anstoß, eine Person antwortet
 *       „bleibt“.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsMassnahmeAbnahmeTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = MassnahmeWelt.PFAD;
    private static final JsonNode RU = MassnahmeWelt.REFERENZ;
    private static final JsonNode M1 = MassnahmeWelt.RU.get("M-2028-0001");
    private static final JsonNode M2 = MassnahmeWelt.RU.get("M-2028-0002");
    private static final JsonNode EZ = RU.at("/energieziele/0");
    private static final String UEBERSICHT = "/api/v1/verbesserung/uebersicht";
    private static final Instant BEWERTET = Instant.parse("2028-11-15T09:00:00Z");

    /** Die Leser, deren Sätze der Kunde liest (Quelltext-Probe); Pfade relativ zu {@code services/api}. */
    private static final List<String> LESER = List.of("MassnahmeService", "MassnahmeWirkung", "MassnahmeBewertung",
            "EnergiezielService", "AbweichungService", "VerbesserungNaht", "BezugsbasisVergleich",
            "BezugsbasisVergleichSatz", "BerichtLeistungsvergleich", "VorgangAnstoss", "VorgangAntwort", "VerbesserungUebersicht");

    /**
     * Die einzigen Texte der Leser mit „Ursache“ ohne „Aussage von“: zwei Ablehnungen (422) an der Eingabe einer
     * Ursache-Aussage — sie verlangen die Person, sie behaupten keine Ursache.
     */
    private static final List<String> ABLEHNUNGEN = List.of("Eine Ursache-Aussage hat 10 bis 500 Zeichen.",
            "Eine Ursache ist immer die Aussage einer Person — bitte nennen Sie, von wem sie ist.");

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
        // Der Stundentakt schreibt selbst Kennzahl-Zeilen — hier schreibt allein der Test.
        registry.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    KennzahlService kennzahlen;

    @Autowired
    VerbesserungNaht naht;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    private static JdbcTemplate root;
    private MassnahmeWelt mw;

    /** Der ganze Plan in einer Welt; {@code leser} hält jede Antwort eines Lesers in der Reihenfolge des Abrufs. */
    private record Plan(Welt w, String m1, String m2, String ez, String aw2028, String aw2026,
            Map<String, Antwort> leser) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void welt() {
        mw = new MassnahmeWelt(mvc, kennzahlen, root);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    // ================================================================================ (1) Verbunden

    /**
     * R3, R6, R10: „mit Ziel, Verantwortlichem, Messgrundlage und Ergebnis verbunden“ — jede Verbindung aus der Antwort
     * der Maßnahme selbst, das Ergebnis als Stand mit Person, Begründung und Prüfsumme der Referenzdatei; ein beendetes
     * Konto kann nicht verantwortlich sein; das Ziel wird bewertet, obwohl es verfehlt ist.
     */
    @Test
    void verbundenMitZielVerantwortlichemMessgrundlageUndErgebnis() throws Exception {
        Plan p = plan();
        JsonNode m = p.leser().get("massnahme M-2028-0001 bewertet").body();
        assertThat(m.get("kennzeichen").asText()).isEqualTo("M-2028-0001");
        // Ziel (Z1)
        assertThat(m.at("/energieziel/kennzeichen").asText()).isEqualTo(EZ.get("kennzeichen").asText())
                .isEqualTo("EZ-2028-0001");
        assertThat(m.at("/energieziel/id").asText()).isEqualTo(p.ez());
        // Verantwortlicher (M1): eine Person mit aktivem Konto, kein Freitext
        assertThat(m.at("/verantwortlich/name").asText()).isEqualTo("Murat Demirci");
        assertThat(m.at("/verantwortlich/sub").asText()).isEqualTo(MassnahmeWelt.sub(p.w(), "murat"));
        assertThat(root.queryForObject("SELECT zustand FROM benutzer WHERE sub = ?", String.class,
                MassnahmeWelt.sub(p.w(), "murat"))).isEqualTo("aktiv");
        mw.uhr(MassnahmeWelt.ANGELEGT);
        Map<String, Object> olga = MassnahmeWelt.mitMessgrundlage(p.w(), M1);
        olga.put("verantwortlich", MassnahmeWelt.sub(p.w(), "olga"));
        olga.put("herkunft", "von_hand");
        olga.remove("herkunft_kennung");
        Antwort beendet = mw.ruf(p.w(), "ines", HttpMethod.POST, PFAD, olga);
        assertThat(beendet.status()).as("beendetes Konto " + beendet.text()).isEqualTo(422);
        // Messgrundlage (M2): KZ-0004 × BB-0001 Fassung 2 × Ausgangslage Dezember 2027 mit Prüfsumme
        JsonNode mg = m.get("messgrundlage");
        assertThat(mg.at("/kennzahl/kennzeichen").asText()).isEqualTo("KZ-0004");
        assertThat(mg.at("/bezugsbasis/kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(mg.get("fassung").asInt()).isEqualTo(2);
        assertThat(mg.at("/ausgangslage_inhalt/monate").asText()).isEqualTo("2027-12");
        assertThat(mg.at("/ausgangslage_inhalt/vergleich/0/bereinigt/delta_prozent").asText()).isEqualTo("12.9");
        assertThat(mg.at("/ausgangslage_inhalt/vergleich/0/bereinigt/gemessen/version").asInt()).isEqualTo(1);
        assertThat(mg.get("pruefsumme").asText()).startsWith("sha256:")
                .isEqualTo(BerichtRegeln.pruefsumme(mg.get("ausgangslage").asText()));
        assertThat(root.queryForObject("SELECT bericht_pruefsumme(ausgangslage) FROM massnahme WHERE id = ?::uuid",
                String.class, p.m1())).isEqualTo(mg.get("pruefsumme").asText());
        // Herkunft: die Abweichung, und die Abweichung schließt mit genau dieser Maßnahme
        assertThat(m.at("/herkunft/art").asText()).isEqualTo("abweichung");
        assertThat(m.at("/herkunft/kennung").asText()).isEqualTo("AW-2028-0001");
        JsonNode aw = p.leser().get("abweichung AW-2028-0001 abgeschlossen").body();
        assertThat(aw.at("/abschluss/ergebnis").asText()).isEqualTo("massnahme");
        assertThat(aw.at("/abschluss/massnahme/kennzeichen").asText()).isEqualTo("M-2028-0001");
        // Ergebnis (WK6, E6 = A): Stand Nr. 1 belegt — Person, Begründung, Kopie und Prüfsumme der Referenzdatei
        JsonNode ref = M1.at("/bewertungen/0");
        JsonNode b = m.get("bewertung");
        assertThat(m.get("zustand").asText()).isEqualTo("bewertet");
        assertThat(b.get("stand_nr").asInt()).isEqualTo(1);
        assertThat(b.get("ergebnis").asText()).isEqualTo("belegt");
        assertThat(b.at("/person/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(b.get("begruendung").asText()).isEqualTo(ref.get("begruendung").asText());
        assertThat(b.get("kopie").asText()).isEqualTo(BerichtRegeln.kanonisch(ref.get("kopie")));
        assertThat(b.get("pruefsumme").asText()).isEqualTo(ref.get("pruefsumme").asText())
                .isEqualTo(BerichtRegeln.pruefsumme(b.get("kopie").asText()));
        assertThat(b.get("satz").asText()).startsWith("Belegt von Ines Kaltenbach am 15.11.2028: ‚")
                .contains("Beobachtet: 2,4 % weniger (8 von 12 Monaten). Stand Nr. 1, Prüfsumme ");
        // R10: das Ziel wird bewertet, auch wenn es verfehlt ist — Kopie mit Prüfsumme der Referenzdatei
        JsonNode z = p.leser().get("energieziel EZ-2028-0001 bewertet").body();
        assertThat(z.get("kennzeichen").asText()).isEqualTo("EZ-2028-0001");
        assertThat(z.get("ergebnis").asText()).isEqualTo("verfehlt");
        assertThat(z.at("/bewertung/person/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(z.at("/bewertung/begruendung").asText()).isEqualTo(EZ.at("/bewertung/begruendung").asText());
        assertThat(z.at("/bewertung/pruefsumme").asText()).isEqualTo(EZ.at("/bewertung/pruefsumme").asText());
        assertThat(z.at("/bewertung/kopie").asText()).isEqualTo(BerichtRegeln.kanonisch(EZ.at("/bewertung/kopie")));
        JsonNode stand = p.leser().get("energieziel EZ-2028-0001 stand 15.01.2029").body();
        assertThat(stand.get("monate_text").asText()).isEqualTo("11 von 12");
        assertThat(stand.at("/summe/delta_prozent").asText()).isEqualTo("-2.7");
        assertThat(stand.get("vorschlag").isNull()).as("11 von 12 → kein Vorschlag „erreicht“").isTrue();
    }

    // ================================================================================ (2) Keine Ursache

    /**
     * SP2 im Quelltext: jede Satz-Schablone ({@link VerbesserungRegeln#SAETZE}) und jeder Text in den Lesern — „Ursache“
     * nur mit „Aussage von“ (die beiden Ablehnungen an der Eingabe ausgenommen), nie „hat gewirkt“ oder „Einsparung
     * durch“.
     */
    @Test
    void keineUrsacheImQuelltextDerLeser() throws IOException {
        List<String> funde = new ArrayList<>();
        VerbesserungRegeln.SAETZE.forEach((k, v) -> pruefe("SAETZE." + k, v, funde));
        int texte = 0;
        for (String klasse : LESER) {
            Path datei = Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", klasse + ".java");
            for (String text : texte(Files.readString(datei, StandardCharsets.UTF_8))) {
                texte++;
                if (!ABLEHNUNGEN.contains(text)) {
                    pruefe(klasse, text, funde);
                }
            }
        }
        assertThat(texte).as("Texte in den Lesern").isGreaterThan(200);
        assertThat(VerbesserungRegeln.SAETZE.get("ursache_aussage")).startsWith("Ursache — Aussage von {person}, {am}");
        assertThat(funde).as("Satz mit Ursache ohne Person").isEmpty();
    }

    /**
     * SP2 in den Antworten: der ganze Plan (R8, R2, R3, R5, R6, R7, R10) — jeder Abruf eines Lesers ist 200, und kein
     * Text darin nennt eine Ursache ohne „Aussage von“. Die zwei Ursache-Aussagen (Murat Demirci, Jonas Wendlinger)
     * stehen in den Abweichungen, jede als Aussage mit Person und Datum.
     */
    @Test
    void keineUrsacheInDenAntwortenDerLeser() throws Exception {
        Plan p = plan();
        List<String> funde = new ArrayList<>();
        List<String> aussagen = new ArrayList<>();
        p.leser().forEach((wo, a) -> {
            assertThat(a.status()).as(wo + " " + a.text()).isEqualTo(200);
            texte(a.body(), wo, funde, aussagen);
            assertThat(a.text()).as(wo).doesNotContain("hat gewirkt").doesNotContain("Einsparung durch");
        });
        assertThat(p.leser()).hasSizeGreaterThanOrEqualTo(20);
        assertThat(funde).as("Satz mit Ursache ohne Person").isEmpty();
        assertThat(aussagen).as("die Ursache-Aussagen, mit Person und Datum")
                .anyMatch(s -> s.startsWith("Ursache — Aussage von Murat Demirci, 14.01.2028 (keine Messung): ‚"))
                .anyMatch(s -> s.startsWith("Ursache — Aussage von Jonas Wendlinger, 10.12.2026 (keine Messung): ‚"));
        // Die Übersicht (IP-19): ihre faellig-Zeilen sind in der Probe — am 15.03.2028 die überfällige M-2028-0002 (R9).
        JsonNode faellig = p.leser().get("uebersicht 15.03.2028").body().get("faellig");
        assertThat(faellig).hasSize(1);
        assertThat(faellig.at("/0/satz").asText())
                .isEqualTo("M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.");
        // Die Wirkung ist eine Zahl mit Bedingung — ob die Maßnahme sie bewirkt hat, sagt eine Person.
        assertThat(p.leser().get("wirkung M-2028-0001 15.11.2028").body().get("satz").asText())
                .contains("weniger Strom als die Bezugsbasis erwarten lässt")
                .endsWith("Ob die Maßnahme das bewirkt hat, sagt eine Person.");
    }

    // ================================================================================ (3) Januar 2028 vor der Umsetzung

    /**
     * R6: der Januar 2028 ist 3,5 % „besser“ — der Vergleich zeigt es weiter mit seinem Urteil, aber die Maßnahme
     * zählt ihn nicht: vor der Umsetzung gibt es keine Wirkung ({@code nicht_umgesetzt}), nach der Umsetzung am
     * 22.01.2028 ist er der Umsetzungsmonat — nicht gezählt, auch nicht in der Summe.
     */
    @Test
    void januar2028BesserVorDerUmsetzungIstKeineWirkung() throws Exception {
        Welt w = mw.welt();
        Antwort geplant = mw.ruf(w, "ines", HttpMethod.POST, PFAD, MassnahmeWelt.mitMessgrundlage(w, M1));
        assertThat(geplant.status()).as(geplant.text()).isEqualTo(201);
        String vorher = geplant.body().get("id").asText();
        String umgesetzt = mw.umgesetzteMassnahme(w, "murat")[0];
        mw.nachher(w, "2028-01", "2028-01");

        mw.uhr(Instant.parse("2028-02-15T09:00:00Z"));
        Antwort vergleich = mw.ruf(w, "ines", HttpMethod.GET, "/api/v1/kennzahlen/" + w.kz4()
                + "/vergleich?von=2028-01&bis=2028-01", null);
        assertThat(vergleich.status()).as(vergleich.text()).isEqualTo(200);
        assertThat(vergleich.text()).contains("\"delta_prozent\":\"-3.5\"").contains("\"urteil\":\"besser\"");

        JsonNode nichtUmgesetzt = mw.ruf(w, "ines", HttpMethod.GET, PFAD + "/" + vorher + "/wirkung", null).body();
        assertThat(nichtUmgesetzt.get("grund").asText()).isEqualTo("nicht_umgesetzt");
        assertThat(nichtUmgesetzt.get("summe").isNull()).isTrue();
        assertThat(nichtUmgesetzt.get("satz").isNull()).isTrue();
        assertThat(nichtUmgesetzt.get("monate")).isEmpty();
        Antwort bewerten = mw.ruf(w, "ines", HttpMethod.POST, PFAD + "/" + vorher + "/bewertungen", Map.of("ergebnis",
                "belegt", "begruendung", M1.at("/bewertungen/0/begruendung").asText()));
        assertThat(bewerten.status()).as(bewerten.text()).isEqualTo(409);
        assertThat(bewerten.body().get("code").asText()).isEqualTo("massnahme_nicht_umgesetzt");

        JsonNode r = mw.ruf(w, "ines", HttpMethod.GET, PFAD + "/" + umgesetzt + "/wirkung", null).body();
        assertThat(r.get("umsetzungsmonat").asText()).isEqualTo("2028-01");
        assertThat(r.get("nachher_von").asText()).isEqualTo("2028-02");
        JsonNode januar = r.at("/monate/0");
        assertThat(januar.get("periode").asText()).isEqualTo("2028-01");
        assertThat(januar.at("/vergleich/bereinigt/urteil").asText()).isEqualTo("besser");
        assertThat(januar.at("/vergleich/bereinigt/delta_prozent").asText()).isEqualTo("-3.5");
        assertThat(januar.get("gezaehlt").asBoolean()).isFalse();
        assertThat(januar.get("grund").asText()).isEqualTo("umsetzungsmonat");
        assertThat(januar.get("satz").asText()).isEqualTo("Januar 2028: Umsetzungsmonat — nicht gezählt.");
        assertThat(r.get("monate_bewertbar").asInt()).isZero();
        assertThat(r.get("monate_text").asText()).isEqualTo("0 von 12");
        assertThat(r.at("/summe/urteil").asText()).as("ohne gezählten Monat keine Zahl").isEqualTo("nicht_anwendbar");
        assertThat(r.at("/summe/gemessen").isNull()).isTrue();
        assertThat(r.at("/summe/delta_prozent").isNull()).isTrue();
        assertThat(r.get("satz").isNull()).isTrue();

        // Mit den Nachher-Monaten: die Summe ist Σ der gezählten Monate — der Januar ist nicht darin.
        mw.nachher(w, "2028-02", "2028-10");
        mw.uhr(BEWERTET);
        JsonNode spaeter = mw.ruf(w, "ines", HttpMethod.GET, PFAD + "/" + umgesetzt + "/wirkung", null).body();
        BigDecimal gezaehlt = BigDecimal.ZERO;
        for (JsonNode monat : spaeter.get("monate")) {
            if (monat.get("gezaehlt").asBoolean()) {
                gezaehlt = gezaehlt.add(MassnahmeWelt.zahl(monat.at("/vergleich/bereinigt/gemessen/wert")));
            }
        }
        assertThat(MassnahmeWelt.zahl(spaeter.at("/summe/gemessen"))).isEqualByComparingTo(gezaehlt)
                .isEqualByComparingTo(FAELLE_R5_SUMME);
        assertThat(spaeter.at("/nicht_gezaehlt/0/monat").asText()).isEqualTo("2028-01");
        assertThat(spaeter.at("/nicht_gezaehlt/0/grund").asText()).isEqualTo("umsetzungsmonat");
    }

    /** R5 „erwartet“: Σ gemessen Februar bis Oktober 2028 ohne März (8 Monate) — 647 000 kWh, ohne den Januar. */
    private static final BigDecimal FAELLE_R5_SUMME = new BigDecimal("647000");

    // ================================================================================ (4) Ohne Person

    /**
     * E6 = A: ohne das Wort einer Person bleibt {@code bewertung} {@code null} — auch wenn die Wirkung als Zahl da ist
     * und auch mit einem offenen Vier-Augen-Antrag (ein Antrag ist kein Stand). Die Fläche sagt dann den Satz
     * {@code bewertung_offen}; die API liefert dafür {@code bewertung: null} und keinen Satz, der „belegt“ behauptet.
     */
    @Test
    void ohnePersonBleibtBewertungNullBeobachtetNichtBelegt() throws Exception {
        Plan p = plan();
        JsonNode vorher = p.leser().get("massnahme M-2028-0001 vor der Bewertung").body();
        assertThat(vorher.get("zustand").asText()).isEqualTo("umgesetzt");
        assertThat(vorher.get("bewertung").isNull()).isTrue();
        assertThat(vorher.get("bewertung_antrag").isNull()).isTrue();
        assertThat(p.leser().get("bewertungen M-2028-0001 vor der Bewertung").body().get("bewertungen")).isEmpty();
        JsonNode wirkung = p.leser().get("wirkung M-2028-0001 15.11.2028").body();
        assertThat(wirkung.at("/summe/delta_prozent").asText()).isEqualTo("-2.4");
        assertThat(wirkung.at("/summe/urteil").asText()).isEqualTo("besser");
        for (String wo : List.of("massnahme M-2028-0001 vor der Bewertung", "wirkung M-2028-0001 15.11.2028")) {
            assertThat(p.leser().get(wo).text()).as(wo).doesNotContainIgnoringCase("belegt");
        }
        assertThat(VerbesserungRegeln.satz("bewertung_offen", Map.of()).get("satz"))
                .isEqualTo("Beobachtet — nicht belegt. Eine Bewertung mit Begründung setzt eine Person.");

        // Vier-Augen: der Antrag ist kein Stand — bewertung bleibt null, bis eine zweite Person bestätigt.
        Welt w = mw.welt();
        String id = mw.umgesetzteMassnahme(w, "murat")[0];
        mw.nachher(w, "2028-01", "2028-10");
        mw.uhr(BEWERTET);
        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE tenant_id = ?", w.mandant());
        Antwort antrag = mw.ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/bewertungen/beantragen", Map.of(
                "ergebnis", "belegt", "begruendung", M1.at("/bewertungen/0/begruendung").asText()));
        assertThat(antrag.status()).as(antrag.text()).isEqualTo(201);
        JsonNode m = mw.ruf(w, "ines", HttpMethod.GET, PFAD + "/" + id, null).body();
        assertThat(m.get("bewertung").isNull()).isTrue();
        assertThat(m.at("/bewertung_antrag/status").asText()).isEqualTo("beantragt");
        assertThat(m.at("/bewertung_antrag/satz").isNull()).isTrue();
        assertThat(m.get("zustand").asText()).isEqualTo("umgesetzt");
    }

    // ================================================================================ (5) Ohne Messgrundlage

    /**
     * R7 (M4, E2 = A): M-2028-0002 ohne Messgrundlage sagt es an jeder Stelle und kann nur {@code nicht_messbar}
     * bewertet werden — {@code belegt} und {@code nicht_belegt} 422; die Wirkung hat keine Zahl.
     */
    @Test
    void ohneMessgrundlageNurNichtMessbar() throws Exception {
        Plan p = plan();
        JsonNode vorher = p.leser().get("massnahme M-2028-0002 vor der Bewertung").body();
        assertThat(vorher.get("messgrundlage").isNull()).isTrue();
        assertThat(vorher.at("/ohne_messgrundlage/satz").asText()).contains("ohne Messgrundlage — Wirkung nicht messbar");
        JsonNode wirkung = p.leser().get("wirkung M-2028-0002").body();
        assertThat(wirkung.get("grund").asText()).isEqualTo("ohne_messgrundlage");
        assertThat(wirkung.get("summe").isNull()).isTrue();
        assertThat(p.leser().get("wirkung M-2028-0002").text()).doesNotContainPattern("\\d+,\\d %");

        mw.uhr(Instant.parse("2028-11-20T09:00:00Z"));
        JsonNode ref = M2.at("/bewertungen/0");
        for (String ergebnis : List.of("belegt", "nicht_belegt")) {
            Antwort x = mw.ruf(p.w(), "ines", HttpMethod.POST, PFAD + "/" + p.m2() + "/bewertungen", Map.of(
                    "ergebnis", ergebnis, "begruendung", ref.get("begruendung").asText()));
            assertThat(x.status()).as(ergebnis + " " + x.text()).isEqualTo(422);
            assertThat(x.body().get("code").asText()).isEqualTo("ohne_messgrundlage");
        }
        JsonNode m = p.leser().get("massnahme M-2028-0002 bewertet").body();
        assertThat(m.at("/bewertung/ergebnis").asText()).isEqualTo(ref.get("ergebnis").asText())
                .isEqualTo("nicht_messbar");
        assertThat(m.at("/bewertung/kopie").isNull()).isTrue();
        assertThat(m.at("/bewertung/pruefsumme").isNull()).isTrue();
        assertThat(m.at("/bewertung/satz").asText()).isEqualTo("Bewertet am 20.11.2028 von Ines Kaltenbach: nicht "
                + "messbar — ‚" + ref.get("begruendung").asText() + "‘");
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme_bewertung WHERE massnahme_id = ?::uuid",
                Integer.class, p.m2())).isEqualTo(1);
    }

    // ================================================================================ (6) Anstoß statt Umbau

    /**
     * R12: K-2028-0001 (MS-20 Dezember 2027 78 000 → 77 400 kWh) — der Vergleich sagt jetzt +12,0 % mit Version 2, die
     * Ausgangslage von M-2028-0001 bleibt byte-gleich (Version 1, +12,9 %, dieselbe Prüfsumme) und bekommt genau einen
     * Anstoß {@code ausgangslage_korrigiert}; Ines antwortet „bleibt“ mit Begründung — die Kopie ändert sich nicht, und
     * kein Satz nennt eine Ursache.
     */
    @Test
    void r12KorrekturIstAnstossStattUmbau() throws Exception {
        Welt w = mw.welt();
        String[] m = mw.umgesetzteMassnahme(w, "murat");
        JsonNode r12 = M1.at("/anstoesse/0");
        mw.uhr(Instant.parse("2028-04-03T07:20:00Z"));
        assertThat(korrektur(w, r12.get("anlass_kennung").asText())).singleElement().satisfies(g -> {
            assertThat(g.massnahme()).isEqualTo(UUID.fromString(m[0]));
            assertThat(g.art()).isEqualTo(r12.get("art").asText()).isEqualTo("ausgangslage_korrigiert");
        });

        Antwort vergleich = mw.ruf(w, "ines", HttpMethod.GET, "/api/v1/kennzahlen/" + w.kz4()
                + "/vergleich?von=2027-12&bis=2027-12", null);
        assertThat(vergleich.status()).as(vergleich.text()).isEqualTo(200);
        assertThat(vergleich.text()).contains("\"delta_prozent\":\"12.0\"");
        JsonNode a = mw.ruf(w, "ines", HttpMethod.GET, PFAD + "/" + m[0], null).body();
        assertThat(a.at("/messgrundlage/ausgangslage").asText()).as("byte-gleich").isEqualTo(m[1]);
        assertThat(a.at("/messgrundlage/pruefsumme").asText()).isEqualTo(m[2]);
        assertThat(a.at("/messgrundlage/ausgangslage_inhalt/vergleich/0/bereinigt/gemessen/version").asInt()).isEqualTo(1);
        assertThat(a.at("/messgrundlage/ausgangslage_inhalt/vergleich/0/bereinigt/delta_prozent").asText())
                .isEqualTo("12.9");
        assertThat(a.get("anstoesse")).hasSize(1);
        JsonNode an = a.at("/anstoesse/0");
        assertThat(an.get("anlass_kennung").asText()).isEqualTo("K-2028-0001");
        assertThat(an.get("zustand").asText()).isEqualTo("offen");

        mw.uhr(Instant.parse("2028-04-05T08:00:00Z"));
        Antwort b = mw.ruf(w, "ines", HttpMethod.POST, PFAD + "/" + m[0] + "/anstoesse/" + an.get("id").asText()
                + "/antwort", Map.of("antwort", "bleibt", "begruendung", r12.at("/antwort/begruendung").asText()));
        assertThat(b.status()).as(b.text()).isEqualTo(200);
        assertThat(b.body().at("/anstoesse/0/antwort").asText()).isEqualTo("bleibt");
        assertThat(b.body().at("/anstoesse/0/beantwortet_von").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(b.body().at("/messgrundlage/ausgangslage").asText()).isEqualTo(m[1]);
        assertThat(b.body().at("/messgrundlage/pruefsumme").asText()).isEqualTo(m[2]);
        List<String> funde = new ArrayList<>();
        texte(b.body(), "massnahme nach dem Anstoß", funde, new ArrayList<>());
        texte(vergleich.body(), "vergleich nach K-2028-0001", funde, new ArrayList<>());
        assertThat(funde).isEmpty();
    }

    /** Die Kaskade von K-2028-0001, wie {@link KennzahlKaskade} sie fährt (Muster {@code VorgangAnstossApiTest}). */
    private List<VorgangAnstoss.Gesetzt> korrektur(Welt w, String kennung) {
        Instant jetzt = kennzahlen.jetzt();
        LocalDate von = LocalDate.parse("2027-12-01");
        KennzahlLauf.Neu v2 = new KennzahlLauf.Neu(w.kz4(), "KZ-0004", "monat", von, von.plusMonths(1).minusDays(1),
                ZoneId.of("Europe/Berlin"), 2);
        List<VorgangAnstoss.Gesetzt> aus = new ArrayList<>();
        admin.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try (var ps = con.prepareStatement("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, "
                    + "periode_von, periode_bis, zeitzone, version, wert, zaehler, nenner, menge_zustand, kennzeichen, "
                    + "zustand, endgueltig_ab, definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) SELECT "
                    + "tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, 2, ?, ?, nenner, "
                    + "menge_zustand, kennzeichen, zustand, endgueltig_ab, definition_fassung_id, ?, 'eingang', ? FROM "
                    + "kennzahl_wert WHERE tenant_id = ? AND kennzahl_id = ? AND periode_art = 'monat' AND periode_von = ? "
                    + "AND version = 1")) {
                BigDecimal kwh = new BigDecimal("77400");
                ps.setBigDecimal(1, kwh.divide(new BigDecimal("250000"), 20, java.math.RoundingMode.HALF_UP));
                ps.setBigDecimal(2, kwh);
                ps.setTimestamp(3, Timestamp.from(jetzt));
                ps.setString(4, kennung);
                ps.setObject(5, w.mandant());
                ps.setObject(6, w.kz4());
                ps.setDate(7, java.sql.Date.valueOf(von));
                assertThat(ps.executeUpdate()).isOne();
                aus.addAll(naht.anstossen(con, w.mandant(), kennung, List.of(v2), jetzt));
                con.commit();
            } catch (SQLException e) {
                con.rollback();
                throw e;
            } finally {
                con.setAutoCommit(autoCommit);
            }
            return null;
        });
        return aus;
    }

    // ================================================================================ Der Plan

    /**
     * Die Zeitachse der Referenzdatei 1.9 in einer Welt, über die Routen: R8 (AW-2026-0001, erklärt), EZ-2028-0001,
     * R1/R2 (Vermerk Dezember 2027, AW-2028-0001 mit Ursache-Aussage, Abschluss mit M-2028-0001), R3 (angelegt
     * 15.01.2028 am Ziel, umgesetzt 22.01.2028), R7 (M-2028-0002 ohne Messgrundlage), R4 (Ziel-Stand Juli 2028), R5/R6
     * (Wirkung und Stand Nr. 1 am 15.11.2028), R7 (nicht messbar 20.11.2028), R10 (Ziel verfehlt 15.01.2029).
     */
    private Plan plan() throws Exception {
        Welt w = mw.welt();
        Map<String, Antwort> leser = new LinkedHashMap<>();
        String vermerke = "/api/v1/kennzahlen/" + w.kz4() + "/auffaelligkeiten";

        // R8: November 2026 an der vorläufigen Fassung 1 — Ursache-Aussage von Jonas, Abschluss „erklärt“.
        JsonNode r8 = abweichung("AW-2026-0001");
        ObjectNode anlass8 = (ObjectNode) r8.get("anlass").deepCopy();
        anlass8.put("kennzahl", "KZ-0004");
        anlass8.put("bezugsbasis", "BB-0001");
        mw.uhr(Instant.parse("2026-12-09T09:00:00Z"));
        UUID november = vermerk(w, 1, "2026-11", anlass8, "2026-12-07T05:00:00Z");
        leser.put("auffaelligkeiten 09.12.2026", lies(w, vermerke));
        String aw2026 = ok(mw.ruf(w, "ines", HttpMethod.POST, vermerke + "/" + november + "/antwort", Map.of("antwort",
                "abweichung", "frist", r8.get("frist").asText(), "verantwortlich", MassnahmeWelt.sub(w, "jonas"))), 201)
                .at("/abweichung/id").asText();
        mw.uhr(Instant.parse("2026-12-10T09:00:00Z"));
        ok(mw.ruf(w, "jonas", HttpMethod.POST, "/api/v1/abweichungen/" + aw2026 + "/eintraege", Map.of("art",
                "ursache_aussage", "wortlaut", r8.at("/verlauf/1/wortlaut").asText(), "aussage_sub",
                MassnahmeWelt.sub(w, "jonas"), "aussage_am", "2026-12-10")), 201);
        mw.uhr(Instant.parse("2026-12-20T09:00:00Z"));
        ok(mw.ruf(w, "jonas", HttpMethod.POST, "/api/v1/abweichungen/" + aw2026 + "/abschliessen", Map.of("ergebnis",
                "erklaert", "begruendung", r8.at("/abschluss/begruendung").asText())), 200);
        leser.put("abweichung AW-2026-0001 abgeschlossen", lies(w, "/api/v1/abweichungen/" + aw2026));

        // EZ-2028-0001 am 20.12.2027.
        mw.uhr(Instant.parse("2027-12-20T09:00:00Z"));
        Map<String, Object> ziel = new LinkedHashMap<>();
        ziel.put("kennzahl", w.kz4().toString());
        ziel.put("zielwert_prozent", EZ.get("zielwert_prozent").decimalValue());
        ziel.put("zielperiode", EZ.get("zielperiode").asText());
        ziel.put("wortlaut", EZ.get("wortlaut").asText());
        ziel.put("begruendung", EZ.get("begruendung").asText());
        JsonNode ez = ok(mw.ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele", ziel), 201);
        assertThat(ez.get("kennzeichen").asText()).isEqualTo("EZ-2028-0001");
        String ezId = ez.get("id").asText();

        // R1/R2: der Vermerk Dezember 2027 (07.01.2028), die Abweichung am 12.01., die Aussage von Murat am 14.01.
        JsonNode r2 = abweichung("AW-2028-0001");
        UUID dezember = vermerk(w, 2, "2027-12", auffaelligkeit("KZ-0004", "2027-12").get("anlass"),
                "2028-01-07T04:12:00Z");
        mw.uhr(Instant.parse("2028-01-12T09:00:00Z"));
        leser.put("auffaelligkeiten 12.01.2028", lies(w, vermerke));
        String aw2028 = ok(mw.ruf(w, "ines", HttpMethod.POST, vermerke + "/" + dezember + "/antwort", Map.of("antwort",
                "abweichung", "frist", r2.get("frist").asText(), "verantwortlich", MassnahmeWelt.sub(w, "ines"))), 201)
                .at("/abweichung/id").asText();
        String eintraege = "/api/v1/abweichungen/" + aw2028 + "/eintraege";
        ok(mw.ruf(w, "ines", HttpMethod.POST, eintraege, Map.of("text", r2.at("/verlauf/1/text").asText())), 201);
        mw.uhr(Instant.parse("2028-01-14T10:00:00Z"));
        ok(mw.ruf(w, "ines", HttpMethod.POST, eintraege, Map.of("art", "ursache_aussage", "wortlaut",
                r2.at("/verlauf/2/wortlaut").asText(), "aussage_sub", MassnahmeWelt.sub(w, "murat"), "aussage_am",
                "2028-01-14")), 201);
        leser.put("abweichung AW-2028-0001 offen", lies(w, "/api/v1/abweichungen/" + aw2028));

        // R3: M-2028-0001 am 15.01.2028 am Energieziel; die Abweichung schließt mit ihr; umgesetzt am 22.01.2028.
        mw.uhr(MassnahmeWelt.ANGELEGT);
        Map<String, Object> m1 = MassnahmeWelt.mitMessgrundlage(w, M1);
        m1.put("energieziel", ezId);
        String m1Id = ok(mw.ruf(w, "ines", HttpMethod.POST, PFAD, m1), 201).get("id").asText();
        ok(mw.ruf(w, "ines", HttpMethod.POST, eintraege, Map.of("art", "kommentar", "text",
                r2.at("/verlauf/3/text").asText())), 201);
        ok(mw.ruf(w, "ines", HttpMethod.POST, "/api/v1/abweichungen/" + aw2028 + "/abschliessen", Map.of("ergebnis",
                "massnahme", "begruendung", r2.at("/abschluss/begruendung").asText(), "massnahme", m1Id)), 200);
        leser.put("abweichung AW-2028-0001 abgeschlossen", lies(w, "/api/v1/abweichungen/" + aw2028));
        leser.put("massnahme M-2028-0001 geplant", lies(w, PFAD + "/" + m1Id));
        leser.put("wirkung M-2028-0001 geplant", lies(w, PFAD + "/" + m1Id + "/wirkung"));
        mw.uhr(MassnahmeWelt.UMGESETZT);
        ok(mw.ruf(w, "ines", HttpMethod.POST, PFAD + "/" + m1Id + "/umgesetzt", Map.of("am", "2028-01-22",
                "begruendung", M1.at("/verlauf/1/begruendung").asText())), 200);

        // R7: M-2028-0002 ohne Messgrundlage am Einsatz EE-3, umgesetzt am 28.03.2028.
        mw.uhr(Instant.parse("2028-01-20T09:00:00Z"));
        Map<String, Object> m2 = new LinkedHashMap<>();
        m2.put("titel", M2.get("titel").asText());
        m2.put("verantwortlich", MassnahmeWelt.sub(w, "ines"));
        m2.put("termin", M2.get("termin").asText());
        m2.put("herkunft", "einsatz");
        m2.put("einsatz", w.ee3().toString());
        m2.put("standort", w.st1().toString());
        m2.put("erwartete_wirkung_wortlaut", M2.at("/erwartete_wirkung/wortlaut").asText());
        String m2Id = ok(mw.ruf(w, "ines", HttpMethod.POST, PFAD, m2), 201).get("id").asText();
        mw.uhr(Instant.parse("2028-03-15T09:00:00Z"));
        leser.put("uebersicht 15.03.2028", lies(w, UEBERSICHT));
        mw.uhr(Instant.parse("2028-03-28T09:00:00Z"));
        ok(mw.ruf(w, "ines", HttpMethod.POST, PFAD + "/" + m2Id + "/umgesetzt", Map.of("am", "2028-03-28",
                "begruendung", "Leckagen geortet und abgedichtet.")), 200);

        // R4/R5/R6: die Monate; der Ziel-Stand im Juli, Vergleich und Wirkung am 15.11.2028, dann „belegt“.
        mw.nachher(w, "2028-01", "2028-10");
        mw.uhr(Instant.parse("2028-07-10T09:00:00Z"));
        leser.put("energieziel EZ-2028-0001 stand 10.07.2028", lies(w, "/api/v1/energieziele/" + ezId + "/stand"));
        mw.uhr(BEWERTET);
        leser.put("vergleich KZ-0004 2027-12 bis 2028-10", lies(w, "/api/v1/kennzahlen/" + w.kz4()
                + "/vergleich?von=2027-12&bis=2028-10"));
        leser.put("wirkung M-2028-0001 15.11.2028", lies(w, PFAD + "/" + m1Id + "/wirkung"));
        leser.put("massnahme M-2028-0001 vor der Bewertung", lies(w, PFAD + "/" + m1Id));
        leser.put("bewertungen M-2028-0001 vor der Bewertung", lies(w, PFAD + "/" + m1Id + "/bewertungen"));
        leser.put("massnahme M-2028-0002 vor der Bewertung", lies(w, PFAD + "/" + m2Id));
        leser.put("wirkung M-2028-0002", lies(w, PFAD + "/" + m2Id + "/wirkung"));
        leser.put("register massnahmen 15.11.2028", lies(w, PFAD));
        leser.put("uebersicht 15.11.2028", lies(w, UEBERSICHT));
        ok(mw.ruf(w, "ines", HttpMethod.POST, PFAD + "/" + m1Id + "/bewertungen", Map.of("ergebnis", "belegt",
                "begruendung", M1.at("/bewertungen/0/begruendung").asText())), 201);
        leser.put("massnahme M-2028-0001 bewertet", lies(w, PFAD + "/" + m1Id));
        leser.put("bewertungen M-2028-0001", lies(w, PFAD + "/" + m1Id + "/bewertungen"));
        mw.uhr(Instant.parse("2028-11-20T09:00:00Z"));
        ok(mw.ruf(w, "ines", HttpMethod.POST, PFAD + "/" + m2Id + "/bewertungen", Map.of("ergebnis", "nicht_messbar",
                "begruendung", M2.at("/bewertungen/0/begruendung").asText())), 201);
        leser.put("massnahme M-2028-0002 bewertet", lies(w, PFAD + "/" + m2Id));

        // R10: bis Januar 2029; am 15.01.2029 der Stand über 11 von 12 und die Bewertung „verfehlt“.
        mw.nachher(w, "2028-11", "2029-01");
        mw.uhr(Instant.parse("2029-01-15T09:00:00Z"));
        leser.put("energieziel EZ-2028-0001 stand 15.01.2029", lies(w, "/api/v1/energieziele/" + ezId + "/stand"));
        ok(mw.ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele/" + ezId + "/bewerten", Map.of("ergebnis",
                "verfehlt", "begruendung", EZ.at("/bewertung/begruendung").asText())), 200);
        leser.put("energieziel EZ-2028-0001 bewertet", lies(w, "/api/v1/energieziele/" + ezId));
        leser.put("register energieziele 15.01.2029", lies(w, "/api/v1/energieziele"));
        leser.put("register abweichungen 15.01.2029", lies(w, "/api/v1/abweichungen"));
        leser.put("uebersicht 15.01.2029", lies(w, UEBERSICHT));
        mw.uhr(Instant.parse("2029-02-10T09:00:00Z"));
        leser.put("wirkung M-2028-0001 10.02.2029", lies(w, PFAD + "/" + m1Id + "/wirkung"));
        leser.put("vergleich KZ-0004 2028", lies(w, "/api/v1/kennzahlen/" + w.kz4() + "/vergleich?von=2028-01&bis=2028-12"));
        return new Plan(w, m1Id, m2Id, ezId, aw2028, aw2026, leser);
    }

    private Antwort lies(Welt w, String pfad) throws Exception {
        return mw.ruf(w, "ines", HttpMethod.GET, pfad, null);
    }

    private static JsonNode ok(Antwort a, int status) {
        assertThat(a.status()).as(a.text()).isEqualTo(status);
        return a.body();
    }

    /** Ein offener Vermerk, wie ihn die Naht (IP-15) schreibt (Muster {@code AbweichungApiTest}). */
    private static UUID vermerk(Welt w, int fassung, String periode, JsonNode anlass, String am) {
        UUID basis = root.queryForObject("SELECT id FROM bezugsbasis WHERE kennzahl_id = ?", UUID.class, w.kz4());
        String text = BerichtRegeln.kanonisch(anlass);
        return root.queryForObject("INSERT INTO auffaelligkeit (tenant_id, kennzahl_id, bezugsbasis_id, fassung, periode, "
                + "standort_id, anlass, anlass_pruefsumme, vermerkt_am) VALUES (?, ?, ?, ?, ?, ?, ?, bericht_pruefsumme(?), "
                + "?) RETURNING id", UUID.class, w.mandant(), w.kz4(), basis, fassung, periode, w.st1(), text, text,
                Timestamp.from(Instant.parse(am)));
    }

    private static JsonNode abweichung(String kennzeichen) {
        for (JsonNode n : RU.get("abweichungen")) {
            if (n.get("kennzeichen").asText().equals(kennzeichen)) {
                return n;
            }
        }
        throw new IllegalStateException(kennzeichen);
    }

    private static JsonNode auffaelligkeit(String kennzahl, String periode) {
        for (JsonNode n : RU.get("auffaelligkeiten")) {
            if (n.get("kennzahl").asText().equals(kennzahl) && n.get("periode").asText().equals(periode)) {
                return n;
            }
        }
        throw new IllegalStateException(kennzahl + " " + periode);
    }

    // ================================================================================ Die Sprach-Probe

    /** SP2: „Ursache“ nur als „Aussage von …“; nie „hat gewirkt“, nie „Einsparung durch“. */
    private static void pruefe(String wo, String text, List<String> funde) {
        if (text.contains("Ursache") && !text.contains("Aussage von")) {
            funde.add(wo + ": " + text);
        }
        String klein = text.toLowerCase(java.util.Locale.ROOT);
        if (klein.contains("hat gewirkt") || klein.contains("einsparung durch")) {
            funde.add(wo + ": " + text);
        }
    }

    /** Jeder Text einer Antwort (auch Kopien in Stand und Anlass, die als JSON-Text gespeichert sind). */
    private static void texte(JsonNode n, String wo, List<String> funde, List<String> aussagen) {
        if (n.isTextual()) {
            String t = n.asText();
            pruefe(wo, t, funde);
            if (t.startsWith("Ursache — Aussage von")) {
                aussagen.add(t);
            }
            if (t.startsWith("{") || t.startsWith("[")) {
                try {
                    texte(MassnahmeWelt.MAPPER.readTree(t), wo + " (Kopie)", funde, aussagen);
                } catch (IOException kein) {
                    // kein JSON — der Text selbst ist geprüft
                }
            }
        }
        n.forEach(k -> texte(k, wo, funde, aussagen));
    }

    /** Die Texte einer Java-Quelle: Kommentare weg, zusammengesetzte Literale ({@code "a " + "b"}) als ein Text. */
    private static List<String> texte(String quelle) {
        String ohneBlock = quelle.replaceAll("(?s)/\\*.*?\\*/", "");
        StringBuilder code = new StringBuilder();
        for (String zeile : ohneBlock.split("\n")) {
            int i = zeile.indexOf("//");
            code.append(i >= 0 && zeile.substring(0, i).chars().filter(c -> c == '"').count() % 2 == 0
                    ? zeile.substring(0, i) : zeile).append('\n');
        }
        String verbunden = code.toString().replaceAll("\"\\s*\\+\\s*\"", "");
        List<String> texte = new ArrayList<>();
        Matcher m = Pattern.compile("\"((?:[^\"\\\\\\n]|\\\\.)*)\"").matcher(verbunden);
        while (m.find()) {
            texte.add(m.group(1));
        }
        return texte;
    }
}
