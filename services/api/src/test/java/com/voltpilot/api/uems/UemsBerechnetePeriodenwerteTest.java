package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
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

/**
 * Die Periodenwerte berechneter Messstellen (UEMS AP-10 IP-10, E6 = A) gegen die echte Kette: Flyway-Schema
 * ({@code V20260914100300}), RLS, das Lese-Modell „Werte je Messstelle“ als Leser der Eingänge UND der Ergebnisse,
 * und der Lauf {@link BerechnetePeriodenLauf}, wie der Stundentakt ihn ruft.
 *
 * <p>Die Welten sind Ausschnitte des Referenzunternehmens Ahrenberg ({@code uems-referenzunternehmen.json}): Werk
 * Lindach (MS-16 Hauptzähler, MS-17/MS-18 Unterzähler, Rest MS-22) und Halle 2 (MS-10 Hauptzähler, MS-11 … MS-14
 * Unterzähler, Rest MS-15). Die Eingangswerte sind die der Vektoren F1–F7 in {@code bilanz-vectors.json}, gespeichert
 * als gemessene Periodenwerte (Tag bzw. Monat) — die Zahlen der berechneten Zeilen rechnet der Lauf.
 *
 * <p>Nicht über die Speicherklasse prüfbar sind F4 und der AN-1-Teil von F7: sie haben einen Speicher mit zwei
 * Anteilen (MS-04 positiv/negativ), und die Speicherklassen tragen nur den ganzen Wert einer Reihe
 * ({@code anteil_nicht_gespeichert}, Befund AP-08 IP-9). Ihre Zahlen hält {@code BerechnetePeriodeVectorsTest}
 * über dieselbe Regel.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsBerechnetePeriodenwerteTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String VOLL = "vollständig";
    private static final String ENDGUELTIG = "endgueltig";
    private static final String VORLAEUFIG = "vorlaeufig";

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
    BerechnetePeriodenRepository speicher;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private static final AtomicInteger SEQ = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ============================================================================ F1–F7 als Periodenwerte

    /**
     * F1 (Plan-Abnahme): 100 − 60 − 30 = 10 kWh — als TAGESWERT der Rest-Messstelle MS-22 in {@code messreihe_tag},
     * mit Zustand, Abdeckung, Kennzeichen, endgültig (alle Eingänge endgültig, Frist vorbei) und ihren drei Eingängen
     * in {@code bilanzwert_eingang}. Dieselbe Viertelstunde: 2,5 − 1,5 − 0,75 = 0,25. Gelesen über das Lese-Modell.
     */
    @Test
    void f1DerRestIstAlsTagesUndViertelstundenwertGespeichertUndLesbar() throws Exception {
        LocalDate tag = LocalDate.parse("2026-10-18");
        Welt w = lindach("2026-01-01");
        tageswert(w, "MS-16", tag, "100", VOLL, 100, List.of(), true);
        tageswert(w, "MS-17", tag, "60", VOLL, 100, List.of(), true);
        tageswert(w, "MS-18", tag, "30", VOLL, 100, List.of(), true);
        Instant zehnUhr = tag.atTime(10, 0).atZone(ZONE).toInstant();
        viertelstunde(w, "MS-16", zehnUhr, "2.5", true);
        viertelstunde(w, "MS-17", zehnUhr, "1.5", true);
        viertelstunde(w, "MS-18", zehnUhr, "0.75", true);
        UUID rest = rest(w, "MS-22", "MS-16");

        BerechnetePeriodenLauf.Lauf l = lauf.lauf(Instant.parse("2026-10-27T12:00:00Z"));
        assertThat(l.geschrieben()).isPositive();

        Map<String, Object> t = tagZeile(w, rest, tag);
        assertThat((BigDecimal) t.get("menge")).isEqualByComparingTo("10");
        assertThat(t.get("menge_zustand")).isEqualTo(VOLL);
        assertThat(t.get("abdeckung_prozent")).isEqualTo(100);
        assertThat(kennzeichen(t)).containsExactly("berechnet (Differenz)", "nicht zugeordnet");
        assertThat(t.get("zustand")).isEqualTo(ENDGUELTIG);
        assertThat(t.get("formel_typ")).isEqualTo("rest");
        assertThat(t.get("entity_id")).as("eine berechnete Zeile hat keine Reihe").isNull();
        assertThat(t.get("erhalten")).as("und keine Rohwert-Zählung").isNull();
        assertThat(root.queryForList("SELECT eingang_kennzeichen || ':' || rolle || ':' || menge::text || ':' || fassung "
                + "FROM bilanzwert_eingang WHERE tenant_id = ? AND messstelle_id = ? AND periode = 'tag' ORDER BY position",
                String.class, w.mandant(), rest))
                .containsExactly("MS-16:zufluss:100:endgueltig", "MS-17:zugeordnet:60:endgueltig",
                        "MS-18:zugeordnet:30:endgueltig");

        Map<String, Object> v = root.queryForMap("SELECT menge, menge_zustand, zustand FROM messreihe_viertelstunde "
                + "WHERE tenant_id = ? AND messstelle_id = ? AND intervall_beginn = ?", w.mandant(), rest,
                Timestamp.from(zehnUhr));
        assertThat((BigDecimal) v.get("menge")).isEqualByComparingTo("0.25");
        assertThat(v.get("zustand")).isEqualTo(ENDGUELTIG);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE tenant_id = ? "
                + "AND messstelle_id = ?", Long.class, w.mandant(), rest))
                .as("eine Viertelstunde ohne Eingang hat keine Zeile — wie eine Lücke").isEqualTo(1);

        // Das Lese-Modell nimmt die Spur auf: dieselbe Zahl, derselbe Zustand, nie ohne Kennzeichen.
        JsonNode werte = werte(w, "MS-22", "tag", tag, tag);
        JsonNode schritt = werte.get("werte").get(0);
        assertThat(schritt.get("menge").decimalValue()).isEqualByComparingTo("10");
        assertThat(schritt.get("zustand").asText()).isEqualTo(VOLL);
        assertThat(schritt.get("fassung").asText()).isEqualTo(ENDGUELTIG);
        assertThat(schritt.get("gebildet_aus").asText()).isEqualTo("tag");
        assertThat(texte(schritt.get("kennzeichen"))).containsExactly("berechnet (Differenz)", "nicht zugeordnet");
        assertThat(schritt.get("grund").isNull()).isTrue();
        JsonNode vs = werte(w, "MS-22", "viertelstunde", tag, tag).get("werte");
        assertThat(vs.get(40).get("von").asText()).startsWith("2026-10-18T10:00");
        assertThat(vs.get(40).get("menge").decimalValue()).isEqualByComparingTo("0.25");
        assertThat(vs.get(41).get("grund").asText()).as("ohne Zeile: noch nicht gebildet, nie 0")
                .isEqualTo("noch_nicht_gebildet");
        assertThat(werte(w, "MS-22", "stunde", tag, tag).get("werte").get(0).get("grund").asText())
                .as("die Stunde ist keine Speicherklasse").isEqualTo("berechnet");
    }

    /**
     * AP-10 IP-12: die HERKUNFT des gespeicherten Rests. Der Lauf rechnet F1 am 19.10.2026 um 00:12 (MESZ) — genau der
     * Rechenzeitpunkt der Vorlage —, und die Route „Werte je Messstelle“ liefert den Satz Zeichen für Zeichen wie die
     * Prüfung {@code herkunft} von F1 in {@code bilanz-vectors.json}: Formel-Fassung 1, drei Eingänge aus
     * {@code bilanzwert_eingang} mit Rolle und Version, Periodenende, {@code berechnet_am}, kein Auslöser. Eine
     * gemessene Zahl (MS-16) trägt KEINE Herkunft — {@code null}, nicht eine leere; ein Schritt ohne Zahl ebenso.
     */
    @Test
    void f1DieHerkunftDesGespeichertenRestsIstByteGleichZumVektor() throws Exception {
        LocalDate tag = LocalDate.parse("2026-10-18");
        Welt w = lindach("2026-01-01");
        tageswert(w, "MS-16", tag, "100", VOLL, 100, List.of(), true);
        tageswert(w, "MS-17", tag, "60", VOLL, 100, List.of(), true);
        tageswert(w, "MS-18", tag, "30", VOLL, 100, List.of(), true);
        Instant zehnUhr = tag.atTime(10, 0).atZone(ZONE).toInstant();
        viertelstunde(w, "MS-16", zehnUhr, "2.5", true);
        viertelstunde(w, "MS-17", zehnUhr, "1.5", true);
        viertelstunde(w, "MS-18", zehnUhr, "0.75", true);
        rest(w, "MS-22", "MS-16");

        lauf.lauf(Instant.parse("2026-10-18T22:12:00Z"));

        JsonNode schritt = werte(w, "MS-22", "tag", tag, tag).get("werte").get(0);
        assertThat(schritt.get("menge").decimalValue()).isEqualByComparingTo("10");
        assertThat(BilanzwertHerkunftVektor.route(schritt.get("herkunft")))
                .isEqualTo(BilanzwertHerkunftVektor.umschlag("bilanz-vectors.json", "F1"));

        JsonNode vs = werte(w, "MS-22", "viertelstunde", tag, tag).get("werte");
        JsonNode satz = vs.get(40).get("herkunft").get("satz");
        assertThat(vs.get(40).get("herkunft").get("fehlt")).isEmpty();
        assertThat(satz.get("periode").get("art").asText()).isEqualTo("viertelstunde");
        assertThat(satz.get("periode").get("schluessel").asText()).isEqualTo("2026-10-18T10:00:00+02:00");
        assertThat(satz.get("periode_ende").asText()).isEqualTo("2026-10-18T10:14:59+02:00");
        assertThat(satz.get("menge").asText()).isEqualTo("0.25");
        assertThat(satz.get("eingaenge").get(2).get("menge").asText()).isEqualTo("0.75");
        assertThat(vs.get(41).get("herkunft").isNull()).as("ohne Zahl keine Herkunft").isTrue();
        assertThat(werte(w, "MS-22", "stunde", tag, tag).get("werte").get(0).get("herkunft").isNull())
                .as("die Stunde trägt keine gespeicherte Zahl").isTrue();

        JsonNode gemessen = werte(w, "MS-16", "tag", tag, tag).get("werte").get(0);
        assertThat(gemessen.has("herkunft")).as("das Feld steht immer da").isTrue();
        assertThat(gemessen.get("herkunft").isNull()).as("eine gemessene Zahl hat keine Bilanzwert-Herkunft").isTrue();
    }

    /**
     * F5: MS-14 hat keine Werte — die Summe MS-11 … MS-14 wird „unvollständig“ (1 055 kWh, Abdeckung 0), der Rest
     * „keine Werte“ (Menge null, nie 0). F6: 100 − 60 − 45 = −5 kWh, gezeigt und nicht geklemmt.
     */
    @Test
    void f5UndF6SummeUnvollstaendigRestKeineWerteUndNegativerRest() {
        LocalDate f5 = LocalDate.parse("2026-11-04");
        Welt halle = halle2("2026-01-01");
        tageswert(halle, "MS-10", f5, "1200", VOLL, 100, List.of(), true);
        tageswert(halle, "MS-11", f5, "740", VOLL, 100, List.of(), true);
        tageswert(halle, "MS-12", f5, "200", VOLL, 100, List.of(), true);
        tageswert(halle, "MS-13", f5, "115", VOLL, 100, List.of(), true);
        UUID rest = rest(halle, "MS-15", "MS-10");
        UUID summe = summe(halle, "SU-5", List.of("MS-11", "MS-12", "MS-13", "MS-14"));

        LocalDate f6 = LocalDate.parse("2026-11-08");
        Welt lindach = lindach("2026-01-01");
        tageswert(lindach, "MS-16", f6, "100", VOLL, 100, List.of(), true);
        tageswert(lindach, "MS-17", f6, "60", VOLL, 100, List.of(), true);
        tageswert(lindach, "MS-18", f6, "45", VOLL, 100, List.of(), true);
        UUID restLindach = rest(lindach, "MS-22", "MS-16");

        lauf.lauf(Instant.parse("2026-11-16T12:00:00Z"));

        Map<String, Object> s = tagZeile(halle, summe, f5);
        assertThat((BigDecimal) s.get("menge")).isEqualByComparingTo("1055");
        assertThat(s.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(s.get("abdeckung_prozent")).isEqualTo(0);
        assertThat(kennzeichen(s)).containsExactly("berechnet (Summe)");

        Map<String, Object> r = tagZeile(halle, rest, f5);
        assertThat(r.get("menge")).as("keine Werte ist nie 0").isNull();
        assertThat(r.get("menge_zustand")).isEqualTo("keine Werte");
        assertThat(r.get("abdeckung_prozent")).isEqualTo(0);
        assertThat(kennzeichen(r)).containsExactly("berechnet (Differenz)", "keine Werte");
        assertThat(root.queryForObject("SELECT menge_zustand FROM bilanzwert_eingang WHERE tenant_id = ? "
                + "AND messstelle_id = ? AND periode = 'tag' AND eingang_kennzeichen = 'MS-14'", String.class,
                halle.mandant(), rest)).as("der fehlende Eingang steht im Satz, nicht weggelassen").isEqualTo("keine Werte");

        Map<String, Object> n = tagZeile(lindach, restLindach, f6);
        assertThat((BigDecimal) n.get("menge")).isEqualByComparingTo("-5");
        assertThat(kennzeichen(n)).containsExactly("berechnet (Differenz)", "unplausibel (negativ)");
    }

    /**
     * F2 (Lindach Oktober 2026, MS-16 Hauptzähler erst ab 15.10.): 9 100 − 4 300 − 3 600 = 1 200 kWh mit dem
     * geerbten Kennzeichen „ab 15.10.2026“; F3 (Halle 2 Oktober 2026): Rest 3 800 kWh, Summe MS-11 … MS-14 33 100 kWh —
     * beide aus den MONATSWERTEN der Eingänge, nie als Summe von Tagen.
     */
    @Test
    void f2UndF3AlsMonatswerteAusDenMonatswertenDerEingaenge() {
        LocalDate oktober = LocalDate.parse("2026-10-01");
        Welt lindach = lindach("2026-10-15");
        monatswert(lindach, "MS-16", oktober, "9100", List.of("ab 15.10.2026"));
        monatswert(lindach, "MS-17", oktober, "4300", List.of());
        monatswert(lindach, "MS-18", oktober, "3600", List.of());
        UUID restLindach = rest(lindach, "MS-22", "MS-16");

        Welt halle = halle2("2026-01-01");
        monatswert(halle, "MS-10", oktober, "36900", List.of());
        monatswert(halle, "MS-11", oktober, "22400", List.of());
        monatswert(halle, "MS-12", oktober, "6100", List.of());
        monatswert(halle, "MS-13", oktober, "3500", List.of());
        monatswert(halle, "MS-14", oktober, "1100", List.of());
        UUID restHalle = rest(halle, "MS-15", "MS-10");
        UUID summe = summe(halle, "SU-3", List.of("MS-11", "MS-12", "MS-13", "MS-14"));

        lauf.lauf(Instant.parse("2026-11-09T12:00:00Z"));

        Map<String, Object> f2 = monatZeile(lindach, restLindach, oktober);
        assertThat((BigDecimal) f2.get("menge")).isEqualByComparingTo("1200");
        assertThat(f2.get("menge_zustand")).isEqualTo(VOLL);
        assertThat(kennzeichen(f2)).containsExactly("berechnet (Differenz)", "nicht zugeordnet", "ab 15.10.2026");
        assertThat(f2.get("zustand")).isEqualTo(ENDGUELTIG);
        assertThat(f2.get("stunden")).as("Oktober 2026 hat 745 Stunden").isEqualTo(745);

        Map<String, Object> f3 = monatZeile(halle, restHalle, oktober);
        assertThat((BigDecimal) f3.get("menge")).isEqualByComparingTo("3800");
        assertThat(kennzeichen(f3)).containsExactly("berechnet (Differenz)", "nicht zugeordnet");
        Map<String, Object> f3Summe = monatZeile(halle, summe, oktober);
        assertThat((BigDecimal) f3Summe.get("menge")).isEqualByComparingTo("33100");
        assertThat(kennzeichen(f3Summe)).containsExactly("berechnet (Summe)");
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_tag WHERE tenant_id = ? AND messstelle_id = ?",
                Long.class, halle.mandant(), restHalle)).as("ohne Tageswerte der Eingänge kein Tag").isZero();
    }

    /**
     * F7: MS-08 zieht am 01.03.2027 von AN-1 nach AN-2 — der gespeicherte Rest von AN-2 (MS-15) folgt der Stellung,
     * ohne dass eine Formel angefasst wird: 1 400 − (740 + 200 + 115 + 35 + 200) = 110 kWh am 01.03., am Vortag ohne
     * MS-08 310 kWh. Der Vortag liegt vor dem Fenster — ihn holt das Nachholen im selben Lauf.
     */
    @Test
    void f7DerGespeicherteRestFolgtDerStellung() {
        Welt w = halle2("2020-01-01");
        UUID an1 = anlage(w, "Werk Ahrenberg – Halle 1");
        messstelle(w, "MS-01", an1, "Hauptzähler", null, "2020-01-01");
        messstelle(w, "MS-08", an1, "Unterzähler", "MS-01", "2020-01-01");
        root.update("UPDATE messstelle_stellung SET gueltig_bis = '2027-02-28' WHERE messstelle_id = ?",
                w.messstellen().get("MS-08"));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, 'Unterzähler', ?, '2027-03-01')", w.mandant(), w.messstellen().get("MS-08"),
                w.anlage(), w.messstellen().get("MS-10"));
        LocalDate vortag = LocalDate.parse("2027-02-28");
        LocalDate umzug = LocalDate.parse("2027-03-01");
        for (LocalDate tag : List.of(vortag, umzug)) {
            tageswert(w, "MS-10", tag, "1400", VOLL, 100, List.of(), true);
            tageswert(w, "MS-11", tag, "740", VOLL, 100, List.of(), true);
            tageswert(w, "MS-12", tag, "200", VOLL, 100, List.of(), true);
            tageswert(w, "MS-13", tag, "115", VOLL, 100, List.of(), true);
            tageswert(w, "MS-14", tag, "35", VOLL, 100, List.of(), true);
            tageswert(w, "MS-08", tag, "200", VOLL, 100, List.of(), true);
        }
        UUID rest = rest(w, "MS-15", "MS-10");
        String formelVorher = Bestandsschutz.inhalt(root, "messstelle_formel_fassung", "tenant_id = ?", w.mandant());

        lauf.lauf(Instant.parse("2027-03-10T12:00:00Z"));

        Map<String, Object> nach = tagZeile(w, rest, umzug);
        assertThat((BigDecimal) nach.get("menge")).isEqualByComparingTo("110");
        assertThat(kennzeichen(nach)).as("die Vermerke „Stellung geändert (…)“ bringt die Herkunft (IP-12)")
                .containsExactly("berechnet (Differenz)", "nicht zugeordnet");
        assertThat((BigDecimal) tagZeile(w, rest, vortag).get("menge")).as("der Vortag ohne MS-08")
                .isEqualByComparingTo("310");
        assertThat(root.queryForList("SELECT eingang_kennzeichen FROM bilanzwert_eingang WHERE tenant_id = ? AND "
                + "messstelle_id = ? AND periode = 'tag' AND periode_beginn = ? ORDER BY position", String.class,
                w.mandant(), rest, Timestamp.from(umzug.atStartOfDay(ZONE).toInstant())))
                .containsExactly("MS-10", "MS-08", "MS-11", "MS-12", "MS-13", "MS-14");
        assertThat(Bestandsschutz.inhalt(root, "messstelle_formel_fassung", "tenant_id = ?", w.mandant()))
                .as("keine Formel wurde angefasst").isEqualTo(formelVorher);
    }

    /**
     * Zieht ein Unterzähler MITTEN im Monat um, gelten im Monat zwei Termsätze — dann entsteht keine Monatszahl
     * ({@code terme_wechseln}): eine Zahl über Abschnitte wäre eine neue Rechenregel. Die Tage stehen.
     */
    @Test
    void einStellungswechselMittenImMonatErgibtKeineMonatszahl() {
        Welt w = halle2("2020-01-01");
        UUID an3 = anlage(w, "Werk Ahrenberg – Halle 3");
        messstelle(w, "MS-20", an3, "Hauptzähler", null, "2020-01-01");
        root.update("UPDATE messstelle_stellung SET gueltig_bis = '2027-03-14' WHERE messstelle_id = ?",
                w.messstellen().get("MS-14"));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, 'Unterzähler', ?, '2027-03-15')", w.mandant(), w.messstellen().get("MS-14"),
                an3, w.messstellen().get("MS-20"));
        LocalDate maerz = LocalDate.parse("2027-03-01");
        for (String kz : List.of("MS-10", "MS-11", "MS-12", "MS-13", "MS-14")) {
            monatswert(w, kz, maerz, "100", List.of());
            tageswert(w, kz, LocalDate.parse("2027-03-20"), "10", VOLL, 100, List.of(), true);
        }
        UUID rest = rest(w, "MS-15", "MS-10");

        lauf.lauf(Instant.parse("2027-03-22T12:00:00Z"));

        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_periode WHERE tenant_id = ? AND messstelle_id = ? "
                + "AND art = 'monat'", Long.class, w.mandant(), rest)).isZero();
        assertThat((BigDecimal) tagZeile(w, rest, LocalDate.parse("2027-03-20")).get("menge"))
                .as("10 − 10 − 10 − 10 ohne MS-14").isEqualByComparingTo("-20");
    }

    // ============================================================================ Reihenfolge und Kreis

    /**
     * DER Test des Pakets: die Summe MS-00 liest den Rest MS-15 — und steht im Kennzeichen VOR ihm. Rechnete der Lauf
     * in Kennzeichen-Reihenfolge, läse MS-00 den veralteten gespeicherten Rest (999 kWh) und schriebe 1 739 kWh. In
     * der Abhängigkeitsordnung rechnet MS-15 zuerst (110 kWh) und MS-00 in DEMSELBEN Lauf 110 + 740 = 850 kWh.
     */
    @Test
    void dieBerechneteMessstelleRechnetNachIhremEingangNichtNachIhremKennzeichen() {
        LocalDate tag = LocalDate.parse("2026-10-20");
        Welt w = halle2("2020-01-01");
        tageswert(w, "MS-10", tag, "1200", VOLL, 100, List.of(), true);
        tageswert(w, "MS-11", tag, "740", VOLL, 100, List.of(), true);
        tageswert(w, "MS-12", tag, "200", VOLL, 100, List.of(), true);
        tageswert(w, "MS-13", tag, "115", VOLL, 100, List.of(), true);
        tageswert(w, "MS-14", tag, "35", VOLL, 100, List.of(), true);
        UUID rest = rest(w, "MS-15", "MS-10");
        UUID summe = summe(w, "MS-00", List.of("MS-15", "MS-11"));
        assertThat("MS-00").as("die Summe steht im Kennzeichen VOR ihrem Eingang").isLessThan("MS-15");
        // Der Rest trägt einen veralteten, vorläufigen Tageswert — den läse eine falsche Reihenfolge.
        UUID fassung = root.queryForObject("SELECT id FROM messstelle_formel_fassung WHERE messstelle_id = ?", UUID.class,
                rest);
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, messstelle_id, formel_fassung_id, formel_typ, zeitzone, "
                + "zeitzone_herkunft, beginn, ende, stunden, menge, menge_zustand, kennzeichen, abdeckung_prozent, zustand, "
                + "endgueltig_ab) VALUES (?, ?, ?, ?, 'rest', 'Europe/Berlin', 'vorgabe', ?, ?, 24, 999, 'vollständig', "
                + "'[\"berechnet (Differenz)\", \"nicht zugeordnet\"]', 100, 'vorlaeufig', ?)", tag, w.mandant(), rest,
                fassung, Timestamp.from(beginn(tag)), Timestamp.from(ende(tag)),
                Timestamp.from(ende(tag).plus(Duration.ofDays(7))));

        lauf.lauf(Instant.parse("2026-10-28T12:00:00Z"));

        assertThat((BigDecimal) tagZeile(w, rest, tag).get("menge")).isEqualByComparingTo("110");
        Map<String, Object> s = tagZeile(w, summe, tag);
        assertThat((BigDecimal) s.get("menge")).as("110 + 740 — nie 999 + 740 = 1 739").isEqualByComparingTo("850");
        assertThat(s.get("menge_zustand")).isEqualTo(VOLL);
        assertThat(root.queryForObject("SELECT menge FROM bilanzwert_eingang WHERE tenant_id = ? AND messstelle_id = ? "
                + "AND periode = 'tag' AND eingang_kennzeichen = 'MS-15'", BigDecimal.class, w.mandant(), summe))
                .isEqualByComparingTo("110");
    }

    /** Ein Formel-Kreis (KR-1 → KR-2 → KR-1) wird benannt abgelehnt — der Lauf endet, der Rest daneben rechnet. */
    @Test
    void einFormelKreisWirdBenanntAbgelehntStattEndlosGerechnet() {
        LocalDate tag = LocalDate.parse("2026-10-21");
        Welt w = halle2("2020-01-01");
        for (String kz : List.of("MS-10", "MS-11", "MS-12", "MS-13", "MS-14")) {
            tageswert(w, kz, tag, "10", VOLL, 100, List.of(), true);
        }
        UUID rest = rest(w, "MS-15", "MS-10");
        UUID k1 = summe(w, "KR-1", List.of("MS-11"));
        UUID k2 = summe(w, "KR-2", List.of("KR-1"));
        // Am Schreibweg vorbei (der lehnt einen Kreis schon beim Anlegen ab): KR-1 liest zusätzlich KR-2.
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, (SELECT id FROM messstelle_formel_fassung WHERE "
                + "messstelle_id = ?), 1, 'messstelle', ?, '+', 1)", w.mandant(), k1, k1, k2);
        UUID haengt = summe(w, "KR-3", List.of("KR-2", "MS-12"));

        BerechnetePeriodenLauf.Lauf l = lauf.lauf(Instant.parse("2026-10-29T12:00:00Z"));

        Map<String, BerechnetePeriode.Abgelehnt> abgelehnt = new LinkedHashMap<>();
        l.abgelehnt().stream().filter(a -> a.messstelle().startsWith("KR-")).forEach(a -> abgelehnt.put(a.messstelle(), a));
        assertThat(abgelehnt.keySet()).containsExactlyInAnyOrder("KR-1", "KR-2", "KR-3");
        assertThat(abgelehnt.get("KR-1").grund()).isEqualTo(BerechnetePeriode.FORMEL_KREIS);
        assertThat(abgelehnt.get("KR-1").kette()).containsExactly("KR-1", "KR-2", "KR-1");
        assertThat(abgelehnt.get("KR-3").grund()).isEqualTo(BerechnetePeriode.HAENGT_AN_KREIS);
        for (UUID m : List.of(k1, k2, haengt)) {
            assertThat(root.queryForObject("SELECT count(*) FROM messreihe_tag WHERE tenant_id = ? AND messstelle_id = ?",
                    Long.class, w.mandant(), m)).as("im Kreis wird nichts gerechnet").isZero();
        }
        assertThat((BigDecimal) tagZeile(w, rest, tag).get("menge")).isEqualByComparingTo("-30");
    }

    // ============================================================================ Fortpflanzung, Endgültigkeit

    /**
     * Ein VORLÄUFIGER Eingang macht das Ergebnis vorläufig (auch nach der Frist); wird er endgültig, wird es der Rest
     * im nächsten Lauf mit ihm. Eine ENDGÜLTIGE berechnete Zeile rührt der Lauf nie an — auch nicht, wenn sich ein
     * Eingang danach noch ändert (das ist die Korrektur-Kaskade, IP-11).
     */
    @Test
    void einVorlaeufigerEingangMachtVorlaeufigUndEineEndgueltigeZeileBleibtStehen() {
        LocalDate tag = LocalDate.parse("2026-10-18");
        Welt w = lindach("2026-01-01");
        tageswert(w, "MS-16", tag, "100", VOLL, 100, List.of(), true);
        tageswert(w, "MS-17", tag, "60", VOLL, 100, List.of(), false);
        tageswert(w, "MS-18", tag, "30", VOLL, 100, List.of(), true);
        UUID rest = rest(w, "MS-22", "MS-16");
        Instant jetzt = Instant.parse("2026-10-27T12:00:00Z");

        lauf.lauf(jetzt);
        Map<String, Object> vorher = tagZeile(w, rest, tag);
        assertThat((BigDecimal) vorher.get("menge")).isEqualByComparingTo("10");
        assertThat(vorher.get("zustand")).as("MS-17 ist vorläufig").isEqualTo(VORLAEUFIG);

        root.update("UPDATE messreihe_tag SET zustand = 'endgueltig', slots_endgueltig = slots_vorhanden "
                + "WHERE tenant_id = ? AND entity_id = ?", w.mandant(), w.komponenten().get("MS-17"));
        lauf.lauf(jetzt);
        assertThat(tagZeile(w, rest, tag).get("zustand")).isEqualTo(ENDGUELTIG);
        assertThat(root.queryForObject("SELECT fassung FROM bilanzwert_eingang WHERE tenant_id = ? AND messstelle_id = ? "
                + "AND periode = 'tag' AND eingang_kennzeichen = 'MS-17'", String.class, w.mandant(), rest))
                .isEqualTo(ENDGUELTIG);

        String endgueltig = Bestandsschutz.inhalt(root, "messreihe_tag", "tenant_id = ? AND messstelle_id IS NOT NULL",
                w.mandant());
        String eingaenge = Bestandsschutz.inhalt(root, "bilanzwert_eingang", "tenant_id = ?", w.mandant());
        root.update("UPDATE messreihe_tag SET menge = 58 WHERE tenant_id = ? AND entity_id = ?", w.mandant(),
                w.komponenten().get("MS-17"));
        lauf.lauf(jetzt.plus(Duration.ofDays(1)));
        assertThat(Bestandsschutz.inhalt(root, "messreihe_tag", "tenant_id = ? AND messstelle_id IS NOT NULL",
                w.mandant())).as("die endgültige Zeile bleibt Zeichen für Zeichen").isEqualTo(endgueltig);
        assertThat(Bestandsschutz.inhalt(root, "bilanzwert_eingang", "tenant_id = ?", w.mandant()))
                .as("und ihre Eingänge auch").isEqualTo(eingaenge);
    }

    // ============================================================================ wiederholbar, abbruchsicher, Nachholen

    /** Zweimal über dieselbe Periode ergibt dasselbe und schreibt beim zweiten Mal nichts. */
    @Test
    void einZweiterLaufSchreibtNichts() {
        LocalDate tag = LocalDate.parse("2026-10-18");
        Welt w = lindach("2026-01-01");
        tageswert(w, "MS-16", tag, "100", VOLL, 100, List.of(), true);
        tageswert(w, "MS-17", tag, "60", VOLL, 100, List.of(), false);
        tageswert(w, "MS-18", tag, "30", VOLL, 100, List.of(), true);
        viertelstunde(w, "MS-16", tag.atTime(9, 0).atZone(ZONE).toInstant(), "2.5", false);
        monatswert(w, "MS-16", LocalDate.parse("2026-10-01"), "3000", List.of());
        rest(w, "MS-22", "MS-16");
        Instant jetzt = Instant.parse("2026-10-24T12:00:00Z");

        lauf.lauf(jetzt);
        Map<String, String> erster = spur(w);
        assertThat(erster.get("messreihe_tag")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(erster.get("messreihe_viertelstunde")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(erster.get("bilanzwert_eingang")).isNotEqualTo(Bestandsschutz.LEER);

        lauf.lauf(jetzt);
        assertThat(spur(w)).as("der zweite Lauf schreibt nichts — auch kein berechnet_am").isEqualTo(erster);
    }

    /**
     * Ein Abbruch mitten im Schreiben (der dritte Eingang einer Zeile scheitert) lässt nichts Halbes zurück: keine
     * berechnete Zeile ohne ihre Eingänge, keine Eingänge ohne Zeile. Der nächste Lauf schreibt alles.
     */
    @Test
    void einAbbruchLaesstNichtsHalbesZurueck() {
        LocalDate tag = LocalDate.parse("2026-10-18");
        Welt w = lindach("2026-01-01");
        tageswert(w, "MS-16", tag, "100", VOLL, 100, List.of(), true);
        tageswert(w, "MS-17", tag, "60", VOLL, 100, List.of(), true);
        tageswert(w, "MS-18", tag, "30", VOLL, 100, List.of(), true);
        Instant zehnUhr = tag.atTime(10, 0).atZone(ZONE).toInstant();
        for (String kz : List.of("MS-16", "MS-17", "MS-18")) {
            viertelstunde(w, kz, zehnUhr, "1", true);
        }
        UUID rest = rest(w, "MS-22", "MS-16");
        root.execute("CREATE OR REPLACE FUNCTION test_abbruch_eingang() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                + "IF NEW.tenant_id = '" + w.mandant() + "' AND NEW.position = 2 AND NEW.periode = 'tag' THEN "
                + "RAISE EXCEPTION 'Abbruch mitten im Schreiben'; END IF; RETURN NEW; END $$");
        root.execute("CREATE TRIGGER test_abbruch_eingang BEFORE INSERT ON bilanzwert_eingang FOR EACH ROW "
                + "EXECUTE FUNCTION test_abbruch_eingang()");
        try {
            lauf.lauf(Instant.parse("2026-10-27T12:00:00Z"));
            assertThat(spur(w).values()).as("die Scheibe mit Viertelstunde UND Tag rollt ganz zurück")
                    .containsOnly(Bestandsschutz.LEER);
        } finally {
            root.execute("DROP TRIGGER test_abbruch_eingang ON bilanzwert_eingang");
            root.execute("DROP FUNCTION test_abbruch_eingang()");
        }
        lauf.lauf(Instant.parse("2026-10-27T12:00:00Z"));
        assertThat((BigDecimal) tagZeile(w, rest, tag).get("menge")).isEqualByComparingTo("10");
        assertThat(root.queryForObject("SELECT count(*) FROM bilanzwert_eingang WHERE tenant_id = ? AND periode = 'tag'",
                Long.class, w.mandant())).isEqualTo(3);
        assertThat(root.queryForObject("SELECT count(*) FROM bilanzwert_eingang WHERE tenant_id = ? "
                + "AND periode = 'viertelstunde'", Long.class, w.mandant())).isEqualTo(3);
    }

    /**
     * Die Vergangenheit vor dem Fenster holt der Lauf rückwärts in Scheiben von 28 Tagen nach: ein Tag 45 Tage vor
     * „jetzt“ steht nach dem ersten Lauf noch nicht, nach dem zweiten schon; danach ist die Messstelle fertig.
     */
    @Test
    void dieVergangenheitWirdInScheibenNachgeholt() {
        Instant jetzt = Instant.parse("2026-12-15T12:00:00Z");
        LocalDate alt = LocalDate.parse("2026-10-31");
        Welt w = lindach("2026-01-01");
        tageswert(w, "MS-16", alt, "100", VOLL, 100, List.of(), true);
        tageswert(w, "MS-17", alt, "60", VOLL, 100, List.of(), true);
        tageswert(w, "MS-18", alt, "30", VOLL, 100, List.of(), true);
        UUID rest = rest(w, "MS-22", "MS-16");

        lauf.lauf(jetzt);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_tag WHERE tenant_id = ? AND messstelle_id = ?",
                Long.class, w.mandant(), rest)).as("45 Tage zurück: nicht in Fenster + erster Scheibe").isZero();
        assertThat(root.queryForObject("SELECT fertig FROM messreihe_berechnet_stand WHERE tenant_id = ? "
                + "AND messstelle_id = ?", Boolean.class, w.mandant(), rest)).isFalse();

        lauf.lauf(jetzt);
        assertThat((BigDecimal) tagZeile(w, rest, alt).get("menge")).isEqualByComparingTo("10");
        assertThat(root.queryForObject("SELECT nachgeholt_ab::text || ':' || fertig FROM messreihe_berechnet_stand "
                + "WHERE tenant_id = ? AND messstelle_id = ?", String.class, w.mandant(), rest))
                .isEqualTo("2026-10-31:true");
    }

    // ============================================================================ Zaun und Bestand

    /**
     * Zwei Kundenbereiche mit denselben Kennzeichen: jeder bekommt SEINEN Rest (10 gegen 20 kWh), jeder liest nur
     * seinen, und der Lauf ändert keine gemessene Zeile und keine andere Tabelle.
     */
    @Test
    void derMandantenzaunHaeltUndDerBestandBleibtUnberuehrt() throws Exception {
        LocalDate tag = LocalDate.parse("2026-10-18");
        Welt a = lindach("2026-01-01");
        Welt b = lindach("2026-01-01");
        for (Welt w : List.of(a, b)) {
            tageswert(w, "MS-16", tag, "100", VOLL, 100, List.of(), true);
            tageswert(w, "MS-17", tag, "60", VOLL, 100, List.of(), true);
        }
        tageswert(a, "MS-18", tag, "30", VOLL, 100, List.of(), true);
        tageswert(b, "MS-18", tag, "20", VOLL, 100, List.of(), true);
        UUID restA = rest(a, "MS-22", "MS-16");
        UUID restB = rest(b, "MS-22", "MS-16");

        List<String> spurTabellen = List.of("messreihe_viertelstunde", "messreihe_tag", "messreihe_periode",
                "bilanzwert_eingang", "messreihe_berechnet_stand");
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, spurTabellen);
        Map<String, String> gemessenVorher = gemessen();

        lauf.lauf(Instant.parse("2026-10-27T12:00:00Z"));

        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, spurTabellen)))
                .as("der Lauf schreibt nur in die Spur berechnet").isEmpty();
        assertThat(gemessen()).as("keine gemessene Zeile wird angefasst").isEqualTo(gemessenVorher);

        assertThat(werte(a, "MS-22", "tag", tag, tag).get("werte").get(0).get("menge").decimalValue())
                .isEqualByComparingTo("10");
        assertThat(werte(b, "MS-22", "tag", tag, tag).get("werte").get(0).get("menge").decimalValue())
                .isEqualByComparingTo("20");
        TenantContext.set(a.mandant());
        assertThat(speicher.gespeichert(restB, "tag", beginn(tag), ende(tag))).as("B hinter dem Zaun von A").isEmpty();
        assertThat(speicher.gespeichert(restA, "tag", beginn(tag), ende(tag))).hasSize(1);
        TenantContext.clear();
        assertThat(root.queryForObject("SELECT count(DISTINCT tenant_id) FROM bilanzwert_eingang WHERE messstelle_id = ?",
                Long.class, restA)).isEqualTo(1);
    }

    @Test
    void saldoRechnetGespeicherteMengenUndNiemalsEineTeilsumme() {
        Welt w = lindach("2026-01-01");
        LocalDate tag = LocalDate.parse("2026-10-18");
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, wertart) "
                + "VALUES (?, 'SALDO', 'Saldo', 'berechnet', 'Strom', 'Wirkenergie', 'saldiert', 'kWh', 'Intervallmenge') RETURNING id",
                UUID.class, w.mandant());
        UUID fassung = root.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, actor_sub, actor_name, actor_art) "
                + "VALUES (?, ?, 1, 'saldo', 'anlage', 'test', 'Test', 'kunde') RETURNING id", UUID.class, w.mandant(), ms);
        // Hier beginnt die Leser-Abnahme an gespeicherten Termen; die Hauptzähler-Grenze prüft der API-Test.
        for (int i = 0; i < 2; i++) {
            root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, quell_messstelle_id, vorzeichen, faktor) "
                    + "VALUES (?, ?, ?, ?, 'messstelle', ?, ?, 1)", w.mandant(), ms, fassung, i,
                    w.messstellen().get(i == 0 ? "MS-16" : "MS-17"), i == 0 ? "+" : "-");
        }
        tageswert(w, "MS-16", tag, "128400", VOLL, 100, List.of(), true);
        tageswert(w, "MS-17", tag, "3120", VOLL, 100, List.of(), true);
        tageswert(w, "MS-16", tag.plusDays(1), "100", VOLL, 100, List.of(), true);
        lauf.lauf(Instant.parse("2026-10-28T12:00:00Z"));
        Map<String, Object> voll = tagZeile(w, ms, tag);
        assertThat((BigDecimal) voll.get("menge")).isEqualByComparingTo("125280");
        assertThat(kennzeichen(voll)).contains("berechnet (Saldo)", "saldiert (Bezug − Abgabe)");
        Map<String, Object> luecke = tagZeile(w, ms, tag.plusDays(1));
        assertThat(luecke.get("menge")).isNull();
        assertThat(luecke.get("menge_zustand")).isEqualTo("keine Werte");
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID anlage, Map<String, UUID> messstellen, Map<String, UUID> komponenten) {}

    /** Werk Lindach (AN-3): MS-16 Hauptzähler ab {@code hauptzaehlerAb}, MS-17 und MS-18 Unterzähler. */
    private Welt lindach(String hauptzaehlerAb) {
        Welt w = welt("Werk Lindach");
        messstelle(w, "MS-16", w.anlage(), "Hauptzähler", null, hauptzaehlerAb);
        messstelle(w, "MS-17", w.anlage(), "Unterzähler", "MS-16", hauptzaehlerAb);
        messstelle(w, "MS-18", w.anlage(), "Unterzähler", "MS-16", hauptzaehlerAb);
        return w;
    }

    /** Halle 2 (AN-2): MS-10 Hauptzähler, MS-11 … MS-14 Unterzähler von MS-10. */
    private Welt halle2(String ab) {
        Welt w = welt("Werk Ahrenberg – Halle 2");
        messstelle(w, "MS-10", w.anlage(), "Hauptzähler", null, ab);
        for (String kz : List.of("MS-11", "MS-12", "MS-13", "MS-14")) {
            messstelle(w, kz, w.anlage(), "Unterzähler", "MS-10", ab);
        }
        return w;
    }

    private Welt welt(String anlage) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Periodenwerte-Probe #" + nr);
        Welt w = new Welt(t, null, new LinkedHashMap<>(), new LinkedHashMap<>());
        return new Welt(t, anlage(w, anlage + " #" + nr), w.messstellen(), w.komponenten());
    }

    private UUID anlage(Welt w, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, w.mandant(), name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
    }

    /** Box, Komponente, Mess-Selektion des Zählerstands, gemessene Messstelle mit führender Quelle, Stellung. */
    private UUID messstelle(Welt w, String kennzeichen, UUID anlage, String stellung, String unterzaehlerVon, String ab) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-PERIODE-" + kennzeichen + "-" + UUID.randomUUID());
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
                unterzaehlerVon == null ? null : w.messstellen().get(unterzaehlerVon), LocalDate.parse(ab));
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
        return messstelle;
    }

    /** Eine Rest-Messstelle: Fassung 1 vom Typ {@code rest} mit ihrem Hauptzähler, ohne Terme (wie „Rest anlegen“). */
    private UUID rest(Welt w, String kennzeichen, String hauptzaehler) {
        UUID ms = berechnete(w, kennzeichen);
        root.update("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art, rest_hauptzaehler_id) VALUES (?, ?, 1, 'rest', 'anlage', 'sub-test', "
                + "'Test', 'kunde', ?)", w.mandant(), ms, w.messstellen().get(hauptzaehler));
        return ms;
    }

    /** Eine gewichtete Summe aus Baustein-Termen (je „+“, Faktor 1). */
    private UUID summe(Welt w, String kennzeichen, List<String> bausteine) {
        UUID ms = berechnete(w, kennzeichen);
        UUID fassung = root.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, "
                + "formel_typ, herkunft, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'gewichtete_summe', 'anlage', "
                + "'sub-test', 'Test', 'kunde') RETURNING id", UUID.class, w.mandant(), ms);
        int position = 0;
        for (String b : bausteine) {
            root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                    + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, ?, ?, 'messstelle', ?, '+', 1)", w.mandant(),
                    ms, fassung, position++, w.messstellen().get(b));
        }
        return ms;
    }

    private UUID berechnete(Welt w, String kennzeichen) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'berechnet', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') "
                + "RETURNING id", UUID.class, w.mandant(), kennzeichen, kennzeichen + " berechnet");
        w.messstellen().put(kennzeichen, ms);
        return ms;
    }

    /** Ein gemessener Tageswert der Reihe einer Messstelle (Speicherklasse AP-07, Menge AP-08 IP-5). */
    private void tageswert(Welt w, String kennzeichen, LocalDate tag, String menge, String mengeZustand,
            int abdeckung, List<String> kennzeichenSaetze, boolean endgueltig) {
        int stunden = TagRegeln.stunden(tag, ZONE);
        int slots = stunden * 4;
        int erwartet = stunden * 60;
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, erhalten, erwartet, "
                + "abdeckung_prozent, rolle, zustand, endgueltig_ab, version, menge, menge_zustand, kennzeichen) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?, ?, ?, 'fuehrend', ?, ?, 1, "
                + "?::numeric, ?, ?::jsonb)", tag, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE,
                Timestamp.from(beginn(tag)), Timestamp.from(ende(tag)), stunden, slots, slots, endgueltig ? slots : 0,
                erwartet * abdeckung / 100, erwartet, abdeckung, endgueltig ? ENDGUELTIG : VORLAEUFIG,
                Timestamp.from(ende(tag).plus(Duration.ofDays(7))), menge, mengeZustand, json(kennzeichenSaetze));
    }

    /** Ein gemessener, endgültiger, vollständiger Monatswert (AP-08 IP-5). */
    private void monatswert(Welt w, String kennzeichen, LocalDate erster, String menge, List<String> kennzeichenSaetze) {
        Instant b = beginn(erster);
        Instant e = beginn(erster.plusMonths(1));
        int tage = erster.lengthOfMonth();
        long stunden = ChronoUnit.HOURS.between(b, e);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', ?::jsonb, ?, ?, "
                + "100, 'endgueltig', ?, 1)", erster, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE,
                Timestamp.from(b), Timestamp.from(e), stunden, tage, tage, tage, menge, json(kennzeichenSaetze),
                stunden * 60, stunden * 60, Timestamp.from(e.plus(Duration.ofDays(7))));
    }

    /** Ein gemessener, vollständiger Viertelstundenwert (AP-07 IP-12, Menge AP-08 IP-2). */
    private void viertelstunde(Welt w, String kennzeichen, Instant beginn, String menge, boolean endgueltig) {
        root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, entity_id, messkanal, wertart, "
                + "erhalten, erwartet, abdeckung_prozent, kadenz_s, kadenz_herkunft, n_good, rolle, zustand, endgueltig_ab, "
                + "version, menge, menge_zustand, n_nachgeliefert) VALUES (?, ?, ?, ?, 'counter', 15, 15, 100, 60, 'auswahl', "
                + "15, 'fuehrend', ?, ?, 1, ?::numeric, 'vollständig', 0)", Timestamp.from(beginn), w.mandant(),
                w.komponenten().get(kennzeichen), ENERGIE, endgueltig ? ENDGUELTIG : VORLAEUFIG,
                Timestamp.from(ViertelstundeRegeln.endgueltigAb(beginn)), menge);
    }

    // ================================================================ lesen

    private Map<String, Object> tagZeile(Welt w, UUID messstelle, LocalDate tag) {
        List<Map<String, Object>> z = root.queryForList("SELECT menge, menge_zustand, kennzeichen::text AS kennzeichen, "
                + "abdeckung_prozent, zustand, formel_typ, entity_id, erhalten FROM messreihe_tag WHERE tenant_id = ? "
                + "AND messstelle_id = ? AND tag = ?", w.mandant(), messstelle, tag);
        assertThat(z).as("eine berechnete Tageszeile am " + tag).hasSize(1);
        return z.get(0);
    }

    private Map<String, Object> monatZeile(Welt w, UUID messstelle, LocalDate erster) {
        List<Map<String, Object>> z = root.queryForList("SELECT menge, menge_zustand, kennzeichen::text AS kennzeichen, "
                + "zustand, stunden FROM messreihe_periode WHERE tenant_id = ? AND messstelle_id = ? AND art = 'monat' "
                + "AND tag = ?", w.mandant(), messstelle, erster);
        assertThat(z).as("eine berechnete Monatszeile " + erster).hasSize(1);
        return z.get(0);
    }

    /** Der Inhalt der Spur berechnet EINES Kundenbereichs — je Tabelle ein Wert. */
    private Map<String, String> spur(Welt w) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String tabelle : List.of("messreihe_viertelstunde", "messreihe_tag", "messreihe_periode")) {
            out.put(tabelle, Bestandsschutz.inhalt(root, tabelle, "tenant_id = ? AND messstelle_id IS NOT NULL",
                    w.mandant()));
        }
        out.put("bilanzwert_eingang", Bestandsschutz.inhalt(root, "bilanzwert_eingang", "tenant_id = ?", w.mandant()));
        return out;
    }

    /** Alle gemessenen Zeilen der drei Klassen (aller Kundenbereiche). */
    private Map<String, String> gemessen() {
        Map<String, String> out = new LinkedHashMap<>();
        for (String tabelle : List.of("messreihe_viertelstunde", "messreihe_tag", "messreihe_periode")) {
            out.put(tabelle, Bestandsschutz.inhalt(root, tabelle, "messstelle_id IS NULL"));
        }
        return out;
    }

    private JsonNode werte(Welt w, String kennzeichen, String raster, LocalDate von, LocalDate bis) throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/messstellen/" + kennzeichen + "/werte?raster=" + raster + "&von=" + von
                        + "&bis=" + bis)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + w.mandant());
                    j.claim("name", "Claudia Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(200);
        return MAPPER.readTree(text);
    }

    private static List<String> kennzeichen(Map<String, Object> zeile) {
        try {
            List<String> out = new ArrayList<>();
            MAPPER.readTree(String.valueOf(zeile.get("kennzeichen"))).forEach(k -> out.add(k.asText()));
            return out;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static String json(List<String> saetze) {
        try {
            return MAPPER.writeValueAsString(saetze);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Instant beginn(LocalDate tag) {
        return tag.atStartOfDay(ZONE).toInstant();
    }

    private static Instant ende(LocalDate tag) {
        return tag.plusDays(1).atStartOfDay(ZONE).toInstant();
    }
}
