package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
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
 * Der Vergleich-Leser (UEMS AP-17 IP-19, U1–U6) über {@code GET /api/v1/kennzahlen/{id}/vergleich} gegen eine echte
 * Datenbank — mit den Ahrenberg-Annahmen der Referenzdatei 1.8: KZ-0004 Spritzguss (MS-20 ÷ BZ-1) mit BB-0001
 * Fassung 1 (Verhältnis 0,2837, beendet 31.10.2025) und Fassung 2 (Modell 10 523 kWh + 0,2343 kWh je kg, Streuung
 * ± 0,8 %, Spannweite 254 000–341 000 kg, gilt seit 01.11.2025); KZ-0006 Heizung (MS-21 ÷ BZ-8 Gradtage) mit BB-0004
 * (Gradtage 119 + 3,8 je Kd, Streuung ± 4,6 %). Die Fassungen schreibt der Test direkt als freigegeben (Muster
 * {@code UemsBezugsbasisMigrationTest}) — die Freigabe-Route bringt IP-8. Die Uhr steht auf dem 15.04.2026.
 *
 * <p><b>Zwei Jahre früher als das Konzept:</b> R2 „Dezember 2027“ ist hier Dezember 2025, R11 November 2025 bis
 * Februar 2026, R3 Januar 2026, G3 März 2026 — die ZAHLEN sind die der Referenzfälle. Grund: {@code bezugsgroesse_wert}
 * nimmt nur abgeschlossene Perioden an ({@code bezugsgroesse_wert_abgeschlossen_chk} gegen {@code created_at}, die
 * echte Uhr der Datenbank); die gestellte Uhr (15.04.2026) liegt vor jedem echten Lauf, so hängen
 * {@code periode_nicht_zu_ende} und P4 nur an ihr.
 *
 * <p>MS-21 ist hier eine Strom-Messstelle: die Einheit des Gases ist für R3 ohne Belang, es zählen Zahl und Urteil.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugsbasisVergleichApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final Instant HEUTE = Instant.parse("2026-04-15T09:00:00Z");

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

    @MockBean
    KennzahlAufrufer aufrufer;

    @Autowired
    KennzahlService kennzahlen;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID g2, UUID kz4, UUID kz6, UUID ohneBasis) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
        kennzahlen.uhrStellen(Clock.fixed(HEUTE, ZoneOffset.UTC));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    /** R2: Dezember 2025 roh 8,8 % weniger ohne Urteil; bereinigt 69 098 kWh erwartet, 12,9 % mehr — schlechter. */
    @Test
    void r2DezemberRohOhneUrteilBereinigtSchlechter() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, PFAD + "/" + w.kz4() + "/vergleich?von=2025-12&bis=2025-12");
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        assertThat(a.body().at("/bezugsbasis/kennzeichen").asText()).isEqualTo("BB-0001");
        JsonNode dez = a.body().get("monate").get(0);
        assertThat(dez.get("periode").asText()).isEqualTo("2025-12");
        JsonNode roh = dez.get("roh");
        assertThat(zahl(roh.get("gemessen"))).isEqualByComparingTo("78000");
        assertThat(roh.get("delta_prozent").asText()).isEqualTo("-8.8");
        assertThat(roh.get("variable_delta_prozent").asText()).isEqualTo("-21.9");
        assertThat(roh.get("urteil").asText()).isEqualTo("ohne_urteil");
        assertThat(roh.toString()).doesNotContain("besser").doesNotContain("schlechter").doesNotContain("im_rahmen");

        JsonNode b = dez.get("bereinigt");
        assertThat(b.at("/fassung/fassung").asInt()).isEqualTo(2);
        assertThat(b.at("/fassung/methode").asText()).isEqualTo("regression_eine_variable");
        assertThat(b.at("/gemessen/version").asInt()).isEqualTo(1);
        assertThat(b.at("/gemessen/einheit").asText()).isEqualTo("kWh");
        assertThat(b.at("/bedingung/0/kennzeichen").asText()).isEqualTo("BZ-1");
        assertThat(zahl(b.at("/bedingung/0/wert"))).isEqualByComparingTo("250000");
        assertThat(b.at("/bedingung/0/fassung").asInt()).isEqualTo(1);
        assertThat(zahl(b.get("erwartet"))).isEqualByComparingTo("69098");
        assertThat(b.get("delta_prozent").asText()).isEqualTo("12.9");
        assertThat(b.get("band_prozent").asText()).isEqualTo("2.0");
        assertThat(b.get("urteil").asText()).isEqualTo("schlechter");
        assertThat(b.get("grund").isNull()).isTrue();
        assertThat(b.get("kennzeichen").get(0).asText()).isEqualTo("bereinigt um Produktionsmenge Spritzguss (Modell mit "
                + "einer Einflussgröße, Bezugsbasis BB-0001, Fassung 2; Streuung ± 0,8 %)");
        assertThat(dez.get("satz").asText()).isEqualTo("Dezember 2025: 78 000 kWh gemessen, 69 098 kWh erwartet bei "
                + "250 000 kg — 12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter.");
        // S5: noch kein Leistungsvergleichs-Stand.
        assertThat(a.body().get("staende")).isEmpty();
        assertThat(a.body().get("stand_satz").asText()).isEqualTo("ungesichert — noch kein Stand");
    }

    /** R11: November 2025 bis Februar 2026 — Σ ÷ Σ 1,8 % im Rahmen, nicht das Mittel der Monats-Δ (2,2 %). */
    @Test
    void r11ZeitraumSummeDurchSummeNieEinMittel() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, PFAD + "/" + w.kz4() + "/vergleich?von=2025-11&bis=2026-02");
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        JsonNode z = a.body().get("zeitraum");
        assertThat(zahl(z.get("gemessen"))).isEqualByComparingTo("323000");
        assertThat(zahl(z.get("erwartet"))).isEqualByComparingTo("317394.5");
        assertThat(z.get("delta_prozent").asText()).isEqualTo("1.8").isNotEqualTo("2.2");
        assertThat(z.get("urteil").asText()).isEqualTo("im_rahmen");
        assertThat(z.get("monate").asText()).isEqualTo("4 von 4");
        assertThat(z.get("fassung").asInt()).isEqualTo(2);
        assertThat(z.get("satz").asText()).isEqualTo("November 2025 bis Februar 2026: 323 000 kWh gemessen, 317 395 kWh "
                + "erwartet — 1,8 %: im Rahmen der Bezugsbasis (Summe über vier Monate).");
        List<String> urteile = List.of("im_rahmen", "schlechter", "besser", "im_rahmen");
        for (int i = 0; i < 4; i++) {
            assertThat(a.body().at("/monate/" + i + "/bereinigt/urteil").asText()).isEqualTo(urteile.get(i));
        }
    }

    /** G3: März 2026 mit 390 000 kg liegt außerhalb der Spannweite — kein erwarteter Wert, kein Urteil. */
    @Test
    void maerzVariableAusserhalb() throws Exception {
        Welt w = welt();
        JsonNode m = ruf(w, PFAD + "/" + w.kz4() + "/vergleich?von=2026-03&bis=2026-03").body().get("monate").get(0);
        assertThat(m.at("/bereinigt/urteil").asText()).isEqualTo("nicht_anwendbar");
        assertThat(m.at("/bereinigt/grund").asText()).isEqualTo("variable_ausserhalb");
        assertThat(m.at("/bereinigt/erwartet").isNull()).isTrue();
        assertThat(m.get("satz").asText()).isEqualTo("Modell nicht anwendbar: Produktionsmenge Spritzguss im März 2026 "
                + "(390 000 kg) liegt außerhalb der Bezugsbasis (254 000–341 000 kg).");
    }

    /** P4: Oktober 2025 liest Fassung 1 (Verhältnis, vorläufig); der laufende April 2026 ist nicht zu Ende. */
    @Test
    void jederMonatLiestDieFassungSeinesLetztenTags() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, PFAD + "/" + w.kz4() + "/vergleich?von=2025-10&bis=2026-04");
        assertThat(a.body().at("/monate/0/bereinigt/fassung/fassung").asInt()).isEqualTo(1);
        assertThat(a.body().at("/monate/0/bereinigt/fassung/methode").asText()).isEqualTo("verhaeltnis");
        assertThat(a.body().at("/monate/1/bereinigt/fassung/fassung").asInt()).isEqualTo(2);
        assertThat(a.body().at("/monate/6/bereinigt/grund").asText()).isEqualTo("periode_nicht_zu_ende");
        assertThat(a.body().at("/zeitraum/urteil").asText()).isEqualTo("ohne_urteil");
    }

    /** R3: Gas Januar 2026 — 1 930 bei 480 Kd, 1 943 erwartet, im Rahmen des Bands ± 4,6 % (Streuung über Toleranz). */
    @Test
    void r3GasImRahmenDerStreuung() throws Exception {
        Welt w = welt();
        JsonNode b = ruf(w, PFAD + "/" + w.kz6() + "/vergleich?von=2026-01&bis=2026-01").body()
                .at("/monate/0/bereinigt");
        assertThat(zahl(b.get("erwartet"))).isEqualByComparingTo("1943");
        assertThat(b.get("delta_prozent").asText()).isEqualTo("-0.7");
        assertThat(b.get("band_prozent").asText()).isEqualTo("4.6");
        assertThat(b.get("urteil").asText()).isEqualTo("im_rahmen");
        assertThat(b.get("kennzeichen").toString()).contains("bereinigt um Gradtage (G20/15, Bezugsbasis BB-0002, "
                + "Fassung 1)").contains("Streuung ± 4,6 %");
    }

    /** R10: ohne Bezugsbasis trägt jeder Monat {@code basis_fehlt}, der Leer-Satz steht am Kopf. */
    @Test
    void ohneBasisBasisFehlt() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, PFAD + "/" + w.ohneBasis() + "/vergleich?von=2025-12&bis=2025-12");
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        assertThat(a.body().get("bezugsbasis").isNull()).isTrue();
        assertThat(a.body().at("/monate/0/bereinigt/grund").asText()).isEqualTo("basis_fehlt");
        assertThat(a.body().at("/monate/0/roh/urteil").asText()).isEqualTo("ohne_urteil");
        assertThat(a.body().get("satz").asText()).startsWith("Noch keine Bezugsbasis.");
    }

    /** Zaun: fremder Kundenbereich, unbekannte Kennzahl und fremde Basis sind 404; eine falsche Anfrage 400. */
    @Test
    void zaunUndAnfrage() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        assertThat(ruf(fremd, PFAD + "/" + w.kz4() + "/vergleich").status()).isEqualTo(404);
        assertThat(ruf(w, PFAD + "/" + UUID.randomUUID() + "/vergleich").status()).isEqualTo(404);
        assertThat(ruf(w, PFAD + "/kein-id/vergleich").status()).isEqualTo(404);
        assertThat(ruf(w, PFAD + "/" + w.kz4() + "/vergleich?basis=BB-0002").status()).isEqualTo(404);
        Antwort falsch = ruf(w, PFAD + "/" + w.kz4() + "/vergleich?von=2027-13");
        assertThat(falsch.status()).isEqualTo(400);
        assertThat(falsch.body().get("feld").asText()).isEqualTo("von");
        assertThat(ruf(w, PFAD + "/" + w.kz4() + "/vergleich?periode=monat").status()).isEqualTo(400);
    }

    // ================================================================================ Welt

    private Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Vergleich #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g2, st1);
        for (String ms : List.of("MS-20", "MS-21")) {
            UUID id = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                    + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                    + "'Zählerstand') RETURNING id", UUID.class, t, ms, "Messstelle " + ms);
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, id, g2);
        }
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge Spritzguss', 'periodenwert', "
                + "'kg', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g2);
        UUID bz8 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-8', 'Gradtagzahl Werk', 'periodenwert', 'Kd', 'monat', "
                + "'gebaeude', ?) RETURNING id", UUID.class, t, g2);
        Welt ohne = new Welt(t, g2, null, null, null);
        UUID kz4 = kennzahl(ohne, "KZ-0004", e("zaehler", "messstelle", "MS-20"), e("nenner", "bezugsgroesse", "BZ-1"));
        UUID kz6 = kennzahl(ohne, "KZ-0006", e("zaehler", "messstelle", "MS-21"), e("nenner", "bezugsgroesse", "BZ-8"));
        UUID kz7 = kennzahl(ohne, "KZ-0007", e("zaehler", "messstelle", "MS-21"), e("nenner", "bezugsgroesse", "BZ-1"));
        Welt w = new Welt(t, g2, kz4, kz6, kz7);

        // Die Monate von R2/R11 und März 2026 (R4); dazu Oktober 2025 als Vormonat und für Fassung 1.
        String[][] spritzguss = {{"2025-10-01", "88000", "310000"}, {"2025-11-01", "85500", "320000"},
            {"2025-12-01", "78000", "250000"}, {"2026-01-01", "78000", "300000"}, {"2026-02-01", "81500", "305000"},
            {"2026-03-01", "100000", "390000"}};
        for (String[] m : spritzguss) {
            monat(w, kz4, "MS-20", bz1, "BZ-1", "kg", m[0], m[1], m[2]);
            monat(w, kz7, "MS-21", null, "BZ-1", "kg", m[0], m[1], m[2]);
        }
        monat(w, kz6, "MS-21", bz8, "BZ-8", "Kd", "2026-01-01", "1930", "480");

        TenantContext.set(t);
        UUID bb1 = basis(w, kz4);
        fassung(t, bb1, 1, bz1, "verhaeltnis", "2024-10/2024-10", "2024-11-01", "2025-10-31", "0.2837", null, null, null,
                null);
        fassung(t, bb1, 2, bz1, "regression_eine_variable", "2024-11/2025-10", "2025-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        UUID bb2 = basis(w, kz6);
        fassung(t, bb2, 1, bz8, "gradtage", "2024-11/2025-10", "2025-11-01", null, "4.2465",
                "{\"a\": 119, \"b\": 3.8}", "4.6", null, null);
        TenantContext.clear();
        return w;
    }

    /** Eine Monatszeile der Kennzahl, wie der Rechenlauf sie schreibt (Version 1), und der Bezugsgrößen-Wert (Fassung 1). */
    private static void monat(Welt w, UUID kennzahl, String ms, UUID bz, String bzKennzeichen, String bzEinheit,
            String erster, String zaehlerText, String nennerText) throws Exception {
        LocalDate von = LocalDate.parse(erster);
        LocalDate bis = von.plusMonths(1).minusDays(1);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, w.mandant(), kennzahl, Date.valueOf(von),
                Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner, am, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "?, (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = ?), ?, 'kWh', 'vollständig', 1)",
                w.mandant(), wert, kennzahl, ms, w.mandant(), ms, zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "?, (SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?), ?, ?, 'vollständig', 1)",
                w.mandant(), wert, kennzahl, bzKennzeichen, w.mandant(), bzKennzeichen, nenner, bzEinheit);
        if (bz != null) {
            root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                    + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                    + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', ?, 'monat', ?, ?, 'Europe/Berlin', "
                    + "1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                    w.mandant(), bz, bzEinheit, Date.valueOf(von), Date.valueOf(bis), nenner);
        }
    }

    /** Die Bezugsbasis über die Route von IP-7 (BB-…, Verantwortliche der Kennzahl). */
    private UUID basis(Welt w, UUID kennzahl) throws Exception {
        MvcResult r = mvc.perform(request(HttpMethod.POST, PFAD + "/" + kennzahl + "/bezugsbasen").with(ines(w))
                .contentType(MediaType.APPLICATION_JSON)).andReturn();
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(201);
        return UUID.fromString(MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .get("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Freigabe-Route IP-8); Fassung 1 von BB-0001 ist beendet. */
    private static void fassung(UUID t, UUID basis, int nummer, UUID bz, String methode, String referenzperiode,
            String giltAb, String giltBis, String basiswert, String koeffizienten, String streuung, String von,
            String bis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, "
                + "methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, anpassungsgruende, "
                + "begruendung, basiswert, koeffizienten, streuung_prozent, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, ?::text[], 'Freigabe im Vergleichs-Test.', ?, ?::jsonb, ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', now(), now()) RETURNING id", UUID.class, t, basis, nummer, referenzperiode,
                methode, nummer == 1 && "verhaeltnis".equals(methode) ? "vorlaeufig" : "vollstaendig",
                Date.valueOf(giltAb), giltBis == null ? null : Date.valueOf(giltBis),
                giltBis == null ? null : Timestamp.from(HEUTE), giltBis == null ? null : "Fassung 2 ersetzt das Verhältnis.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", new BigDecimal(basiswert), koeffizienten,
                streuung == null ? null : new BigDecimal(streuung));
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, 1, ?, 1, ?, ?)", t, f, bz,
                von == null ? null : new BigDecimal(von), bis == null ? null : new BigDecimal(bis));
    }

    @SafeVarargs
    private UUID kennzahl(Welt w, String kennzeichen, Map<String, Object>... eingaenge) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", kennzeichen + " quotient");
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", w.g2().toString());
        m.put("eingaenge", List.of(eingaenge));
        MvcResult r = mvc.perform(request(HttpMethod.POST, PFAD).with(ines(w)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(m))).andReturn();
        assertThat(r.getResponse().getStatus()).as(kennzeichen + " " + r.getResponse().getContentAsString())
                .isEqualTo(201);
        return UUID.fromString(MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .get("id").asText());
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    private static org.springframework.test.web.servlet.request.RequestPostProcessor ines(Welt w) {
        return jwt().jwt(j -> {
            j.subject("sub-ines-" + w.mandant());
            j.claim("preferred_username", "Ines Kaltenbach");
            j.claim("tenant_id", w.mandant().toString());
        });
    }

    /** Die Zahlen des Vergleichs sind JSON-Texte (exakte Dezimalen, §16) — {@code decimalValue()} gäbe auf Text 0. */
    private static BigDecimal zahl(JsonNode n) {
        return new BigDecimal(n.asText());
    }

    private Antwort ruf(Welt w, String pfad) throws Exception {
        MvcResult r = mvc.perform(request(HttpMethod.GET, pfad).with(ines(w))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }
}
