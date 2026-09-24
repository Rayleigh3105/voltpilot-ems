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
 * Energieziel-Routen und Ziel-Stand (UEMS AP-18 IP-6, Z1–Z4, NW-2) gegen eine echte Datenbank — mit R4 der
 * Referenzdatei 1.9 ({@code energieziele[]}, EZ-2028-0001): KZ-0004 Spritzguss (MS-20 ÷ BZ-1) mit BB-0001 Fassung 2
 * (Modell 10 523 kWh + 0,2343 kWh je kg, Streuung ± 0,8 %, Spannweite 254 000–341 000 kg, gilt ab 01.11.2027);
 * Januar bis Juni 2028 wie R4 „gegeben“. Angelegt am 20.12.2027, Abruf am 10.07.2028 (Juni endgültig ab 07.07.2028).
 *
 * <p>Die Monate liegen in der Zukunft der Datenbank-Uhr: die Bezugsgrößen-Werte schreibt der Test mit ausdrücklichem
 * {@code created_at} nach dem Monatsende ({@code bezugsgroesse_wert_abgeschlossen_chk}); die Fassungen direkt als
 * freigegeben (Muster {@code BezugsbasisVergleichApiTest}). Die Uhr der Kennzahlen ist gestellt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiezielApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/energieziele";
    private static final Instant ANGELEGT = Instant.parse("2027-12-20T09:00:00Z");
    private static final Instant ABRUF = Instant.parse("2028-07-10T09:00:00Z");
    private static final Map<String, Object> R4 = ziel();

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

    private record Welt(UUID mandant, UUID g2, UUID kz4, UUID kz3) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void aufruferWieHeute() {
        // Lars Vogel ist Leser an jedem Standort: er sieht das Ziel, verwaltet es nie.
        doAnswer(inv -> {
            ProtokollAkteur wer = inv.getArgument(0);
            return wer.sub() != null && wer.sub().startsWith("sub-lars-")
                    ? new RechteAbleitung.Benutzer(wer.sub(), wer.name(), RechteAbleitung.Konto.BENUTZER,
                            RechteAbleitung.KontoZustand.AKTIV, List.of(new RechteAbleitung.Zuweisung(
                                    RechteAbleitung.Rolle.LESER,
                                    root.queryForList("SELECT id::text FROM standort", String.class), null, null,
                                    Instant.EPOCH, null, null)))
                    : KorrekturRechte.benutzer(wer);
        }).when(aufrufer).benutzer(any());
        uhr(ANGELEGT);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    /**
     * R4: EZ-2028-0001 am 20.12.2027 an KZ-0004 × BB-0001 Fassung 2; am 10.07.2028 2,9 % weniger (Σ 410 400 ÷ Σ
     * 422 809 kWh), 5 von 12, März {@code variable_ausserhalb}, kein Vorschlag — die Periode ist nicht zu Ende.
     */
    @Test
    void r4StandAm10Juli2028() throws Exception {
        Welt w = welt();
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), (String) R4.get("zielperiode")));
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        JsonNode z = neu.body();
        assertThat(z.get("kennzeichen").asText()).isEqualTo("EZ-2028-0001");
        assertThat(z.at("/kennzahl/kennzeichen").asText()).isEqualTo("KZ-0004");
        assertThat(z.at("/bezugsbasis/kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(z.at("/bezugsbasis/fassung").asInt()).isEqualTo(2);
        assertThat(z.get("zielwert_prozent").asText()).isEqualTo("-5.0");
        assertThat(z.get("zielperiode").asText()).isEqualTo("2028-01/2028-12");
        assertThat(z.get("zustand").asText()).isEqualTo("offen");
        assertThat(z.get("angelegt_am").asText()).isEqualTo("2027-12-20");
        assertThat(z.at("/verantwortlich/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(z.get("standort_id").asText()).isEqualTo(standort(w).toString());
        assertThat(z.get("verlauf")).hasSize(1);
        assertThat(z.at("/verlauf/0/art").asText()).isEqualTo("energieziel_angelegt");
        assertThat(z.at("/verlauf/0/begruendung").asText()).isEqualTo(R4.get("begruendung"));

        uhr(ABRUF);
        Antwort a = ruf(w, "ines", HttpMethod.GET, PFAD + "/" + z.get("id").asText() + "/stand", null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        JsonNode s = a.body();
        assertThat(s.get("abruf").asText()).isEqualTo("2028-07-10");
        assertThat(s.get("monate")).hasSize(12);
        assertThat(s.get("monate_endgueltig").asInt()).isEqualTo(6);
        assertThat(s.get("monate_bewertbar").asInt()).isEqualTo(5);
        assertThat(s.get("monate_soll").asInt()).isEqualTo(12);
        assertThat(s.get("monate_text").asText()).isEqualTo("5 von 12");
        assertThat(s.get("vollstaendig").asBoolean()).isFalse();
        assertThat(zahl(s.at("/summe/gemessen"))).isEqualByComparingTo("410400");
        assertThat(zahl(s.at("/summe/erwartet"))).isEqualByComparingTo("422809");
        assertThat(s.at("/summe/delta_prozent").asText()).isEqualTo("-2.9");
        assertThat(s.at("/summe/urteil").asText()).isEqualTo("besser");
        assertThat(s.at("/summe/band_prozent").asText()).isEqualTo("2.0");
        assertThat(s.get("nicht_gezaehlt")).hasSize(1);
        assertThat(s.at("/nicht_gezaehlt/0/monat").asText()).isEqualTo("2028-03");
        assertThat(s.at("/nicht_gezaehlt/0/grund").asText()).isEqualTo("variable_ausserhalb");
        assertThat(s.get("vorschlag").isNull()).isTrue();
        assertThat(s.get("vorschlag_satz").isNull()).isTrue();
        // Je Monat das Vergleichsergebnis des Bezugsbasis-Lesers; Juli ist nicht endgültig.
        assertThat(s.at("/monate/0/vergleich/bereinigt/delta_prozent").asText()).isEqualTo("-3.5");
        assertThat(s.at("/monate/0/vergleich/bereinigt/urteil").asText()).isEqualTo("besser");
        assertThat(s.at("/monate/1/vergleich/bereinigt/urteil").asText()).isEqualTo("im_rahmen");
        assertThat(s.at("/monate/2/vergleich/bereinigt/grund").asText()).isEqualTo("variable_ausserhalb");
        assertThat(s.at("/monate/5/endgueltig").asBoolean()).isTrue();
        assertThat(s.at("/monate/6/endgueltig").asBoolean()).isFalse();
        assertThat(s.get("satz").asText()).isEqualTo("Energieziel EZ-2028-0001 · " + R4.get("wortlaut")
                + " · Januar bis Dezember 2028 · Verantwortlich Ines Kaltenbach. Stand nach 5 von 12 Monaten: "
                + "2,9 % weniger (März 2028 nicht bewertbar: Produktionsmenge Spritzguss außerhalb der Bezugsbasis). "
                + "Bezugsbasis BB-0001, Fassung 2.");
        assertThat(s.toString()).doesNotContain("\"erreicht\"").doesNotContain("nicht_erreicht");
    }

    /** Z1/E3: kein Ziel an KZ-0003 (keine Bezugsbasis) — 422; zweimal dieselbe Periode — 409. */
    @Test
    void ohneBezugsbasis422UndEinLaufendesJeKennzahl() throws Exception {
        Welt w = welt();
        Antwort ohne = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz3(), "2028-01/2028-12"));
        assertThat(ohne.status()).as(ohne.text()).isEqualTo(422);
        assertThat(ohne.body().get("code").asText()).isEqualTo("kennzahl_ohne_bezugsbasis");
        assertThat(ohne.body().get("kennzahl").asText()).isEqualTo("KZ-0003");

        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2028-01/2028-12")).status()).isEqualTo(201);
        Antwort zweit = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2028-06/2028-08"));
        assertThat(zweit.status()).as(zweit.text()).isEqualTo(409);
        assertThat(zweit.body().get("code").asText()).isEqualTo("energieziel_laeuft");
        assertThat(zweit.body().get("kennzeichen").asText()).isEqualTo("EZ-2028-0001");
        // Die nächste Periode ist frei; das Jahr im Kennzeichen ist das erste der Zielperiode.
        Antwort folge = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2029-01/2029-12"));
        assertThat(folge.status()).as(folge.text()).isEqualTo(201);
        assertThat(folge.body().get("kennzeichen").asText()).isEqualTo("EZ-2029-0001");
    }

    /** Z2: rollierend, rückwärts, rückwirkend, zu viele Stellen, ein kWh-Zielwert — 400. */
    @Test
    void zielperiodeFestUndNichtRueckwirkend400() throws Exception {
        Welt w = welt();
        for (String p : List.of("rollierend 12 Monate", "P12M", "2028-01", "2028-12/2028-01", "2028-01-01/2028-12-31")) {
            Antwort a = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), p));
            assertThat(a.status()).as(p + " " + a.text()).isEqualTo(400);
            assertThat(a.body().get("code").asText()).isEqualTo("zielperiode_ungueltig");
        }
        Antwort rueck = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2027-12/2028-11"));
        assertThat(rueck.status()).as(rueck.text()).isEqualTo(400);
        assertThat(rueck.body().get("code").asText()).isEqualTo("zielperiode_rueckwirkend");
        assertThat(rueck.body().get("fruehestens").asText()).isEqualTo("2028-01");
        Map<String, Object> stellen = anlegen(w.kz4(), "2028-01/2028-12");
        stellen.put("zielwert_prozent", new BigDecimal("-5.25"));
        assertThat(ruf(w, "ines", HttpMethod.POST, PFAD, stellen).status()).isEqualTo(400);
        Map<String, Object> kwh = anlegen(w.kz4(), "2028-01/2028-12");
        kwh.put("zielwert_kwh", 900000);
        Antwort absolut = ruf(w, "ines", HttpMethod.POST, PFAD, kwh);
        assertThat(absolut.status()).isEqualTo(400);
        assertThat(absolut.body().get("feld").asText()).isEqualTo("zielwert_kwh");
        assertThat(root.queryForObject("SELECT count(*) FROM energieziel WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();
    }

    /** RE2: ein anderer Kundenbereich sieht nichts und ändert nichts — 404; der Leser liest, verwaltet nie — 403. */
    @Test
    void zaun404UndRecht403() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        String id = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2028-01/2028-12")).body().get("id").asText();
        for (String pfad : List.of(PFAD + "/" + id, PFAD + "/" + id + "/stand", PFAD + "/" + UUID.randomUUID(),
                PFAD + "/kein-id")) {
            assertThat(ruf(fremd, "ines", HttpMethod.GET, pfad, null).status()).as(pfad).isEqualTo(404);
        }
        assertThat(ruf(fremd, "ines", HttpMethod.PUT, PFAD + "/" + id, Map.of("wortlaut", "fremd",
                "begruendung", "Fremder Kundenbereich will ändern.")).status()).isEqualTo(404);
        assertThat(ruf(fremd, "ines", HttpMethod.POST, PFAD + "/" + id + "/beenden",
                Map.of("begruendung", "Fremder Kundenbereich will beenden.")).status()).isEqualTo(404);
        assertThat(ruf(fremd, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2029-01/2029-12")).status())
                .isEqualTo(404);
        assertThat(ruf(fremd, "ines", HttpMethod.GET, PFAD, null).body().get("energieziele")).isEmpty();

        assertThat(ruf(w, "lars", HttpMethod.GET, PFAD + "/" + id, null).status()).isEqualTo(200);
        Antwort put = ruf(w, "lars", HttpMethod.PUT, PFAD + "/" + id, Map.of("wortlaut", "Leser will ändern",
                "begruendung", "Der Leser versucht eine Änderung."));
        assertThat(put.status()).as(put.text()).isEqualTo(403);
        assertThat(put.body().get("code").asText()).isEqualTo("recht_fehlt");
        Antwort post = ruf(w, "lars", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2029-01/2029-12"));
        assertThat(post.status()).as(post.text()).isEqualTo(403);
        assertThat(post.body().get("code").asText()).isEqualTo("recht_fehlt");
    }

    /** §5.7: ändern nur mit Begründung und nur nach hinten, Verantwortlicher, beenden — jede Änderung im Verlauf. */
    @Test
    void aendernVerantwortlicherBeendenMitProtokoll() throws Exception {
        Welt w = welt();
        String id = ruf(w, "ines", HttpMethod.POST, PFAD, anlegen(w.kz4(), "2028-01/2028-12")).body().get("id").asText();
        String pfad = PFAD + "/" + id;
        Antwort ohne = ruf(w, "ines", HttpMethod.PUT, pfad, Map.of("wortlaut", "Neuer Wortlaut"));
        assertThat(ohne.status()).isEqualTo(422);
        assertThat(ohne.body().get("code").asText()).isEqualTo("begruendung_fehlt");
        Antwort vorn = ruf(w, "ines", HttpMethod.PUT, pfad, Map.of("zielperiode", "2028-01/2028-06",
                "begruendung", "Kürzer wäre bequemer, ist aber nicht erlaubt."));
        assertThat(vorn.status()).isEqualTo(422);
        assertThat(vorn.body().get("code").asText()).isEqualTo("zielperiode_nur_nach_hinten");

        Antwort ok = ruf(w, "ines", HttpMethod.PUT, pfad, Map.of("wortlaut", "Spritzguss: 5 % weniger Strom",
                "zielperiode", "2028-01/2029-03", "begruendung", "Geschäftsjahr endet künftig im März."));
        assertThat(ok.status()).as(ok.text()).isEqualTo(200);
        assertThat(ok.body().get("zielperiode").asText()).isEqualTo("2028-01/2029-03");
        JsonNode g = ok.body().at("/verlauf/1");
        assertThat(g.get("art").asText()).isEqualTo("energieziel_geaendert");
        assertThat(g.at("/alt/zielperiode").asText()).isEqualTo("2028-01/2028-12");
        assertThat(g.at("/neu/zielperiode").asText()).isEqualTo("2028-01/2029-03");
        assertThat(g.get("begruendung").asText()).isEqualTo("Geschäftsjahr endet künftig im März.");
        assertThat(g.get("person").asText()).isEqualTo("Ines Kaltenbach");

        Antwort v = ruf(w, "ines", HttpMethod.PUT, pfad + "/verantwortlicher", Map.of("benutzer", "sub-lars-"
                + w.mandant(), "begruendung", "Lars Vogel übernimmt das Ziel für die Halle 2."));
        assertThat(v.status()).as(v.text()).isEqualTo(200);
        assertThat(v.body().at("/verantwortlich/name").asText()).isEqualTo("Lars Vogel");
        assertThat(v.body().at("/verlauf/2/art").asText()).isEqualTo("verantwortlicher_geaendert");
        assertThat(ruf(w, "ines", HttpMethod.PUT, pfad + "/verantwortlicher", Map.of("benutzer", "niemand",
                "begruendung", "Eine Person, die es nicht gibt.")).body().get("code").asText())
                .isEqualTo("benutzer_unbekannt");

        uhr(Instant.parse("2028-03-02T09:00:00Z"));
        Antwort b = ruf(w, "ines", HttpMethod.POST, pfad + "/beenden", Map.of("begruendung",
                "Spritzguss wird an einen neuen Standort verlagert."));
        assertThat(b.status()).as(b.text()).isEqualTo(200);
        assertThat(b.body().get("zustand").asText()).isEqualTo("beendet");
        assertThat(b.body().get("beendet_zum").asText()).isEqualTo("2028-03-02");
        assertThat(b.body().at("/verlauf/3/art").asText()).isEqualTo("energieziel_beendet");
        Antwort danach = ruf(w, "ines", HttpMethod.PUT, pfad, Map.of("wortlaut", "Zu spät",
                "begruendung", "Nach dem Ende ändert sich nichts."));
        assertThat(danach.status()).isEqualTo(409);
        assertThat(danach.body().get("code").asText()).isEqualTo("energieziel_nicht_offen");
        assertThat(root.queryForObject("SELECT count(*) FROM energieziel_aenderung WHERE energieziel_id = ?::uuid",
                Integer.class, id)).isEqualTo(4);

        // Das Register filtert nach Kennzahl und Zustand; fremde Parameter sind 400.
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?kennzahl=" + w.kz4() + "&zustand=beendet", null).body()
                .get("energieziele")).hasSize(1);
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?zustand=offen", null).body().get("energieziele")).isEmpty();
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?zustand=laufend", null).status()).isEqualTo(400);
        assertThat(ruf(w, "ines", HttpMethod.GET, PFAD + "?periode=2028", null).status()).isEqualTo(400);
    }

    // ================================================================================ Welt

    private static Map<String, Object> ziel() {
        try {
            JsonNode datei = MAPPER.readTree(java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                    "uems-referenzunternehmen.json").toFile());
            JsonNode ez = datei.get("energieziele").get(0);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("kennzeichen", ez.get("kennzeichen").asText());
            m.put("zielwert_prozent", ez.get("zielwert_prozent").decimalValue());
            m.put("zielperiode", ez.get("zielperiode").asText());
            m.put("wortlaut", ez.get("wortlaut").asText());
            m.put("begruendung", ez.get("begruendung").asText());
            return m;
        } catch (java.io.IOException x) {
            throw new IllegalStateException(x);
        }
    }

    private static Map<String, Object> anlegen(UUID kennzahl, String zielperiode) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzahl", kennzahl.toString());
        m.put("zielwert_prozent", R4.get("zielwert_prozent"));
        m.put("zielperiode", zielperiode);
        m.put("wortlaut", R4.get("wortlaut"));
        m.put("begruendung", R4.get("begruendung"));
        return m;
    }

    private void uhr(Instant jetzt) {
        kennzahlen.uhrStellen(Clock.fixed(jetzt, ZoneOffset.UTC));
    }

    private static UUID standort(Welt w) {
        return root.queryForObject("SELECT id FROM standort WHERE tenant_id = ?", UUID.class, w.mandant());
    }

    private Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Energieziel #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g2, st1);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, ms, g2);
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge Spritzguss', 'periodenwert', "
                + "'kg', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g2);
        for (String[] p : new String[][] {{"ines", "Ines Kaltenbach"}, {"lars", "Lars Vogel"}}) {
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                    + "'aktiv')", t, "sub-" + p[0] + "-" + t, p[1]);
        }
        Welt ohne = new Welt(t, g2, null, null);
        UUID kz4 = kennzahl(ohne, "KZ-0004");
        UUID kz3 = kennzahl(ohne, "KZ-0003");
        Welt w = new Welt(t, g2, kz4, kz3);

        // R4 „gegeben“: Januar bis Juni 2028 (kg, kWh), jeder Monat endgültig am 7. des Folgemonats.
        String[][] r4 = {{"2028-01-01", "78000", "300000"}, {"2028-02-01", "81500", "305000"},
            {"2028-03-01", "100000", "390000"}, {"2028-04-01", "81900", "318000"}, {"2028-05-01", "83900", "326000"},
            {"2028-06-01", "85100", "331000"}};
        for (String[] m : r4) {
            monat(w, kz4, bz1, m[0], m[1], m[2]);
        }

        TenantContext.set(t);
        UUID bb1 = basis(w, kz4);
        fassung(t, bb1, 1, bz1, "verhaeltnis", "2026-10/2026-10", "2026-11-01", "2027-10-31", "0.2837", null, null,
                null, null);
        fassung(t, bb1, 2, bz1, "regression_eine_variable", "2026-11/2027-10", "2027-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        TenantContext.clear();
        return w;
    }

    /** Eine endgültige Monatszeile der Kennzahl (Version 1) und der Bezugsgrößen-Wert (Fassung 1). */
    private static void monat(Welt w, UUID kennzahl, UUID bz, String erster, String zaehlerText, String nennerText) {
        LocalDate von = LocalDate.parse(erster);
        LocalDate bis = von.plusMonths(1).minusDays(1);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        Timestamp endgueltig = Timestamp.from(von.plusMonths(1).plusDays(6).atStartOfDay().toInstant(ZoneOffset.UTC));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, richtung, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', NULL, '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, w.mandant(), kennzahl,
                Date.valueOf(von), Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner,
                endgueltig, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "'MS-20', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-20'), ?, 'kWh', "
                + "'vollständig', 1)", w.mandant(), wert, kennzahl, w.mandant(), zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', ?, ?, 'kg', 'vollständig', 1)", w.mandant(), wert, kennzahl, bz, nenner);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", w.mandant(), bz, Date.valueOf(von), Date.valueOf(bis), nenner, am);
    }

    /** Die Bezugsbasis über die Route von AP-17 IP-7 (BB-…). */
    private UUID basis(Welt w, UUID kennzahl) throws Exception {
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen/" + kennzahl + "/bezugsbasen", null);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster BezugsbasisVergleichApiTest); Fassung 1 ist beendet. */
    private static void fassung(UUID t, UUID basis, int nummer, UUID bz, String methode, String referenzperiode,
            String giltAb, String giltBis, String basiswert, String koeffizienten, String streuung, String von,
            String bis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, "
                + "methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, anpassungsgruende, "
                + "begruendung, basiswert, koeffizienten, streuung_prozent, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, ?::text[], 'Freigabe im Energieziel-Test.', ?, ?::jsonb, ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', now(), now()) RETURNING id", UUID.class, t, basis, nummer, referenzperiode,
                methode, nummer == 1 ? "vorlaeufig" : "vollstaendig", Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : Timestamp.from(ANGELEGT),
                giltBis == null ? null : "Fassung 2 ersetzt das Verhältnis.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", new BigDecimal(basiswert), koeffizienten,
                streuung == null ? null : new BigDecimal(streuung));
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, 1, ?, 1, ?, ?)", t, f, bz,
                von == null ? null : new BigDecimal(von), bis == null ? null : new BigDecimal(bis));
    }

    private UUID kennzahl(Welt w, String kennzeichen) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", kennzeichen + " Stromeinsatz Spritzguss je kg");
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", w.g2().toString());
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen", m);
        assertThat(a.status()).as(kennzeichen + " " + a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Die Zahlen sind JSON-Texte (exakte Dezimalen). */
    private static BigDecimal zahl(JsonNode n) {
        return new BigDecimal(n.asText());
    }

    /** ines = Ines Kaltenbach (nie zugewiesen → Kundenadministrator), lars = Lars Vogel (Leser an jedem Standort). */
    private Antwort ruf(Welt w, String person, HttpMethod methode, String pfad, Object body) throws Exception {
        String name = "lars".equals(person) ? "Lars Vogel" : "Ines Kaltenbach";
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + person + "-" + w.mandant());
                    j.claim("preferred_username", name);
                    j.claim("tenant_id", w.mandant().toString());
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
