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
 * Der Leistungsvergleich als Bericht (UEMS AP-17 IP-21b, S1–S5, R8) über {@code POST /api/v1/berichte} — Testwelt wie
 * {@code BezugsbasisVergleichApiTest} (IP-19), R8 zwei Jahre früher: Dezember 2025 statt Dezember 2027. Stand Nr. 1 mit
 * Prüfsumme; der Abzug nennt jede Zahl mit Version und die Basis mit Fassung; 409 {@code berichts_belege} an der
 * Kennzahl-Archivierung; ohne Basis 422 {@code basis_fehlt}; V4 je Kennzahl; Zaun über die Kennzahl; die Vergleich-Fläche
 * nennt den Stand (S5).
 *
 * <p>Die Testwelt des Vergleich-Lesers (UEMS AP-17 IP-19, U1–U6) über {@code GET /api/v1/kennzahlen/{id}/vergleich} gegen eine echte
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
class UemsLeistungsvergleichApiTest {

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

    @Autowired
    BerichtService berichte;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID g2, UUID kz4, UUID kz6, UUID ohneBasis, UUID unternehmen) {}

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
        berichte.uhrStellen(Clock.fixed(HEUTE, ZoneOffset.UTC));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
        berichte.uhrStellen(Clock.systemUTC());
    }

    /** R2: Dezember 2025 roh 8,8 % weniger ohne Urteil; bereinigt 69 098 kWh erwartet, 12,9 % mehr — schlechter. */

    /**
     * R8: Stand Nr. 1 des Leistungsvergleichs Dezember 2025 für KZ-0004 — Prüfsumme, jede Zahl mit Version, die Basis
     * mit Fassung, die Quellenart {@code bezugsbasis} mit {@code bezug = vergleich}; danach nennt die Vergleich-Fläche
     * den Stand (S5) und die Archivierung der Kennzahl antwortet 409 {@code berichts_belege} (S4).
     */
    @Test
    void r8StandNrEinsMitPruefsummeUndBelegschutz() throws Exception {
        Welt w = welt();
        Antwort angelegt = schreib(w, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "leistungsvergleich",
                "geltung_id", w.unternehmen().toString(), "zeitraum", "2025-12", "kennzahl", w.kz4().toString()));
        assertThat(angelegt.status()).as(angelegt.text()).isEqualTo(201);
        String kennung = angelegt.body().get("kennung").asText();

        Antwort entwurf = ruf(w, "/api/v1/berichte/" + kennung + "/entwurf");
        assertThat(entwurf.status()).as(entwurf.text()).isEqualTo(200);
        JsonNode abzug = entwurf.body().get("abzug");
        assertThat(abzug.at("/kopf/vorlage").asText()).isEqualTo("leistungsvergleich");
        assertThat(abzug.at("/kopf/bezugsbasis/kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(abzug.at("/kopf/bezugsbasis/fassung").asInt()).isEqualTo(2);
        assertThat(abzug.at("/kopf/referenzperiode/bezeichnung").asText()).isEqualTo("November 2024 bis Oktober 2025");
        assertThat(abzug.at("/bezugsbasis/fassung").asInt()).isEqualTo(2);
        assertThat(abzug.at("/bezugsbasis/methode").asText()).isEqualTo("regression_eine_variable");
        JsonNode dez = abzug.at("/vergleich_je_periode/0/bereinigt");
        assertThat(new BigDecimal(dez.at("/gemessen/wert").asText())).isEqualByComparingTo("78000");
        assertThat(dez.at("/gemessen/version").asInt()).isEqualTo(1);
        assertThat(dez.at("/bedingung/0/fassung").asInt()).isEqualTo(1);
        assertThat(new BigDecimal(dez.get("erwartet").asText())).isEqualByComparingTo("69098");
        assertThat(dez.get("urteil").asText()).isEqualTo("schlechter");
        assertThat(abzug.at("/vergleich_je_periode/0/roh/urteil").asText()).isEqualTo("ohne_urteil");
        assertThat(abzug.at("/urteil/urteil").asText()).isEqualTo("schlechter");
        assertThat(abzug.at("/kopf/grenz_satz").asText()).isEqualTo(BerichtRegeln.BEWERTUNG_GRENZ_SATZ);
        List<String> quellen = new java.util.ArrayList<>();
        abzug.get("quellenverzeichnis").forEach(q -> quellen.add(q.get("art").asText() + " " + q.get("kennzeichen").asText()
                + " " + q.get("bezug").asText() + " v" + q.get("version").asText() + " f" + q.get("fassung").asText()));
        assertThat(quellen).containsExactly("kennzahl KZ-0004 unmittelbar v1 fnull", "messstelle MS-20 mittelbar v1 fnull",
                "bezugsgroesse BZ-1 unmittelbar vnull f1", "bezugsbasis BB-0001 vergleich vnull f2");

        Antwort frei = schreib(w, HttpMethod.POST, "/api/v1/berichte/" + kennung + "/freigeben",
                Map.of("entwurf_datenstand", entwurf.body().get("datenstand").asText()));
        assertThat(frei.status()).as(frei.text()).isEqualTo(201);
        assertThat(frei.body().get("nr").asInt()).isEqualTo(1);
        String summe = frei.body().get("pruefsumme").asText();
        assertThat(summe).matches("sha256:[0-9a-f]{64}");
        assertThat(summe).isEqualTo(BerichtRegeln.pruefsumme(BerichtRegeln.kanonisch(MAPPER.readTree(
                ruf(w, "/api/v1/berichte/" + kennung + "/staende/1").body().get("abzug").toString()))));
        assertThat(root.queryForList("SELECT art || ' ' || bezug || ' ' || coalesce(fassung, 0) FROM bericht_quelle q "
                + "JOIN bericht b ON b.id = q.bericht_id WHERE b.kennung = ? AND b.tenant_id = ? AND q.stand_nr = 1 "
                + "AND q.art = 'bezugsbasis'", String.class, kennung, w.mandant())).containsExactly("bezugsbasis vergleich 2");

        // S5: die Vergleich-Fläche nennt den Stand.
        Antwort vergleich = ruf(w, PFAD + "/" + w.kz4() + "/vergleich?von=2025-12&bis=2025-12");
        assertThat(vergleich.body().at("/staende/0/nummer").asInt()).isEqualTo(1);
        assertThat(vergleich.body().get("stand_satz").asText()).startsWith("Stand Nr. 1 vom ");

        // PDF/CSV folgen mit IP-22.
        assertThat(ruf(w, "/api/v1/berichte/" + kennung + "/staende/1/pdf").body().get("code").asText())
                .isEqualTo("ausgabe_fehlt");

        // S4: die Kennzahl ist Beleg — die Archivierung antwortet 409 berichts_belege, nichts ist geschrieben.
        Antwort archiv = schreib(w, HttpMethod.POST, PFAD + "/" + w.kz4() + "/archivieren", null);
        assertThat(archiv.status()).as(archiv.text()).isEqualTo(409);
        assertThat(archiv.body().get("code").asText()).isEqualTo("berichts_belege");
        assertThat(archiv.body().at("/berichtsstaende/0/kennung").asText()).isEqualTo(kennung);
        assertThat(root.queryForObject("SELECT archiviert_am IS NULL FROM kennzahl WHERE id = ?", Boolean.class, w.kz4()))
                .isTrue();
    }

    /** V4 je Kennzahl: derselbe Zeitraum für eine andere Kennzahl ist ein eigener Bericht; dieselbe 409. */
    @Test
    void v4ZaehltJeKennzahl() throws Exception {
        Welt w = welt();
        Map<String, Object> kz4 = Map.of("vorlage", "leistungsvergleich", "geltung_id", w.unternehmen().toString(),
                "zeitraum", "2025-12", "kennzahl", w.kz4().toString());
        assertThat(schreib(w, HttpMethod.POST, "/api/v1/berichte", kz4).status()).isEqualTo(201);
        Antwort nochmal = schreib(w, HttpMethod.POST, "/api/v1/berichte", kz4);
        assertThat(nochmal.status()).isEqualTo(409);
        assertThat(nochmal.body().get("code").asText()).isEqualTo("bericht_gibt_es_schon");
        Antwort kz6 = schreib(w, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "leistungsvergleich",
                "geltung_id", w.unternehmen().toString(), "zeitraum", "2026-01", "kennzahl", w.kz6().toString()));
        assertThat(kz6.status()).as(kz6.text()).isEqualTo(201);
    }

    /** Ohne freigegebene Basis kein Entwurf: 422 basis_fehlt, nichts angelegt; ohne Kennzahl 400; andere Vorlage mit Kennzahl 400. */
    @Test
    void ohneBasisKeinEntwurfUndDieAnfrageIstStreng() throws Exception {
        Welt w = welt();
        long vorher = root.queryForObject("SELECT count(*) FROM bericht WHERE tenant_id = ?", Long.class, w.mandant());
        Antwort ohne = schreib(w, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "leistungsvergleich",
                "geltung_id", w.unternehmen().toString(), "zeitraum", "2025-12", "kennzahl", w.ohneBasis().toString()));
        assertThat(ohne.status()).as(ohne.text()).isEqualTo(422);
        assertThat(ohne.body().get("code").asText()).isEqualTo("basis_fehlt");
        assertThat(ohne.body().get("message").asText()).startsWith("ungesichert — noch kein Stand");
        assertThat(root.queryForObject("SELECT count(*) FROM bericht WHERE tenant_id = ?", Long.class, w.mandant()))
                .isEqualTo(vorher);

        Antwort keine = schreib(w, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "leistungsvergleich",
                "geltung_id", w.unternehmen().toString(), "zeitraum", "2025-12"));
        assertThat(keine.status()).isEqualTo(400);
        assertThat(keine.body().get("feld").asText()).isEqualTo("kennzahl");
        Antwort falsch = schreib(w, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "monatsbericht_unternehmen",
                "geltung_id", w.unternehmen().toString(), "zeitraum", "2025-12", "kennzahl", w.kz4().toString()));
        assertThat(falsch.status()).isEqualTo(400);
        assertThat(falsch.body().get("feld").asText()).isEqualTo("kennzahl");
    }

    /** Zaun über die Kennzahl: eine Kennzahl eines fremden Kundenbereichs ist 404, wie eine, die es nicht gibt. */
    @Test
    void zaunUeberDieKennzahl() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        Antwort a = schreib(w, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "leistungsvergleich",
                "geltung_id", w.unternehmen().toString(), "zeitraum", "2025-12", "kennzahl", fremd.kz4().toString()));
        assertThat(a.status()).as(a.text()).isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM bericht WHERE tenant_id = ? AND vorlage = 'leistungsvergleich'",
                Long.class, w.mandant())).isZero();
    }

    private Antwort schreib(Welt w, HttpMethod methode, String pfad, Map<String, Object> koerper) throws Exception {
        MockHttpServletRequestBuilder r = request(methode, pfad).with(ines(w)).contentType(MediaType.APPLICATION_JSON);
        if (koerper != null) {
            r = r.content(MAPPER.writeValueAsString(koerper));
        }
        MvcResult m = mvc.perform(r).andReturn();
        String text = m.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(m.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }

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
        Welt ohne = new Welt(t, g2, null, null, null, u);
        UUID kz4 = kennzahl(ohne, "KZ-0004", e("zaehler", "messstelle", "MS-20"), e("nenner", "bezugsgroesse", "BZ-1"));
        UUID kz6 = kennzahl(ohne, "KZ-0006", e("zaehler", "messstelle", "MS-21"), e("nenner", "bezugsgroesse", "BZ-8"));
        UUID kz7 = kennzahl(ohne, "KZ-0007", e("zaehler", "messstelle", "MS-21"), e("nenner", "bezugsgroesse", "BZ-1"));
        Welt w = new Welt(t, g2, kz4, kz6, kz7, u);

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

    private Antwort ruf(Welt w, String pfad) throws Exception {
        MvcResult r = mvc.perform(request(HttpMethod.GET, pfad).with(ines(w))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }
}
