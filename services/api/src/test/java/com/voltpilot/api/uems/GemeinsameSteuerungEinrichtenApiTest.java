package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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
 * „Einrichten in sechs Fragen“ über die Kundenroute (UEMS AP-15, Konzept §5.2; Vertrag steuerungsverbund.md §6a):
 * Ahrenberg 1.5 (V-1, R1/R3) — ein Kundenadministrator richtet AN-1 NUR über GET/PUT ein, und die GET-Antwort zeigt
 * dieselben Zahlen wie {@code SteuerungsverbundAnteilDienstTest}: Einspeisung 40/60, Bezug 0/77, Auslegung
 * {@code passt}, Vorbehalt 473 {@code erklaert}. Dazu: Vollständigkeit (422 mit Kennung), „keine“ vs. Feld fehlt,
 * Strukturänderung setzt die Stufe zurück und steht im Protokoll, der Bestand ohne Gemeinsame Steuerung liest nur,
 * der Rückfall am Gerät über seine Route, eine fremde Anlage ist 404.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GemeinsameSteuerungEinrichtenApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

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

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /**
     * Ahrenberg 1.5: AN-1 an NA-1 (Grenzblatt 100 / 550 kW), Box Halle 1 (E-1: Netzzähler über DQ-2, K-1
     * Wechselrichter 100 kW über DQ-1, K-2 Speicher), Box Verwaltung (E-4: Abgangszähler DQ-10, K-12 PV 60 kW über
     * DQ-8, K-13.1…6 Ladepunkte je 22 kW über DQ-9).
     */
    private record Welt(UUID mandant, UUID an1, UUID e1, UUID e4, UUID dq2, UUID dq10, UUID k1, UUID k2, UUID k12,
            List<UUID> k13) {
        String pfad() {
            return "/api/v1/sites/" + an1 + "/gemeinsame-steuerung";
        }
    }

    private record Antwort(int status, JsonNode body) {
        String code() {
            return body.path("code").asText();
        }
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    // ============================================================================ Abnahme: Ahrenberg

    @Test
    void ahrenbergUeberDieKundenroute() throws Exception {
        Welt w = welt();
        // Frage 1–5 vorgeschlagen, ohne Gemeinsame Steuerung: gelesen, nichts geschrieben (I6)
        JsonNode vorschlag = ok(kunde(w, get(w.pfad() + "/einrichten")));
        assertThat(vorschlag.path("eingerichtet").asBoolean()).isFalse();
        assertThat(vorschlag.path("netzzaehler_box_id").asText()).isEqualTo(w.e1().toString());
        assertThat(vorschlag.path("grenzen").path("einspeisung_kw").decimalValue()).isEqualByComparingTo("100");
        assertThat(vorschlag.path("grenzen").path("bezug_kw").decimalValue()).isEqualByComparingTo("550");
        JsonNode e4 = box(vorschlag, w.e4());
        assertThat(e4.path("komponenten")).hasSize(7);
        assertThat(komponente(e4, w.k12()).path("schreibfreigabe").asBoolean()).isTrue();
        assertThat(komponente(e4, w.k12()).path("nenn_kw").decimalValue()).isEqualByComparingTo("60");
        assertThat(komponente(e4, w.k13().get(0)).path("nenn_kw").decimalValue()).isEqualByComparingTo("22");
        assertThat(komponente(box(vorschlag, w.e1()), w.k2()).path("nenn_kw").isNull())
                .as("Speicher: der Bestand kennt keine Nennleistung").isTrue();
        assertThat(vorschlag.path("ergebnis").isNull()).isTrue();
        assertThat(zeilen(w)).isZero();

        // Rückfall am Gerät hinterlegen (IP-6): K-1 40 kW, K-2 0 kW, jeder Ladepunkt 4,1 kW; K-12 läuft frei
        ok(kunde(w, put(w.pfad() + "/komponenten/" + w.k1() + "/rueckfall").content(
                "{\"richtung\":\"einspeisung\",\"rueckfall\":\"faellt_auf_wert\",\"rueckfall_kw\":40,\"nach_s\":60,"
                        + "\"hinweis\":\"am Gerät hinterlegt, vom Installateur gesetzt\"}")));
        ok(kunde(w, put(w.pfad() + "/komponenten/" + w.k2() + "/rueckfall").content(
                "{\"richtung\":\"bezug\",\"rueckfall\":\"faellt_auf_wert\",\"rueckfall_kw\":0,\"nach_s\":60}")));
        for (UUID k : w.k13()) {
            ok(kunde(w, put(w.pfad() + "/komponenten/" + k + "/rueckfall").content(
                    "{\"richtung\":\"bezug\",\"rueckfall\":\"faellt_auf_wert\",\"rueckfall_kw\":4.1,\"nach_s\":60}")));
        }
        JsonNode verlauf = ok(kunde(w, get(w.pfad() + "/komponenten/" + w.k1() + "/rueckfall")));
        assertThat(verlauf).hasSize(1);
        assertThat(verlauf.get(0).path("eingetragen_von").asText()).isEqualTo("Jonas Wendlinger");

        // Einrichten mit Erklärung (Fragen 1–5)
        JsonNode zustand = ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "473"))));
        assertThat(zustand.path("zustand").asText()).isEqualTo("beobachtet");

        // Frage 6: dieselben Zahlen wie SteuerungsverbundAnteilDienstTest (R1/R3)
        JsonNode e = ok(kunde(w, get(w.pfad() + "/einrichten")));
        assertThat(e.path("eingerichtet").asBoolean()).isTrue();
        JsonNode einspeisung = e.path("ergebnis").path("einspeisung");
        assertThat(einspeisung.path("urteil").asText()).isEqualTo("passt");
        assertThat(anteil(einspeisung, w.e1())).isEqualByComparingTo("40");
        assertThat(anteil(einspeisung, w.e4())).isEqualByComparingTo("60");
        JsonNode bezug = e.path("ergebnis").path("bezug");
        assertThat(bezug.path("urteil").asText()).isEqualTo("passt");
        assertThat(bezug.path("verteilbar_kw").decimalValue()).isEqualByComparingTo("77");
        assertThat(bezug.path("summe_rueckfall_kw").decimalValue()).isEqualByComparingTo("24.6");
        assertThat(anteil(bezug, w.e1())).isEqualByComparingTo("0");
        assertThat(anteil(bezug, w.e4())).isEqualByComparingTo("77");
        assertThat(e.path("vorbehalt").path("bezug_kw").decimalValue()).isEqualByComparingTo("473");
        assertThat(e.path("vorbehalt").path("bezug_herkunft").asText()).isEqualTo("erklaert");
        assertThat(e.path("vorbehalt").path("einspeisung_kw").decimalValue()).isEqualByComparingTo("0");
        assertThat(e.path("vorbehalt").path("von").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(e.path("ungesteuerte_erzeuger").asText()).isEqualTo("keine");
        JsonNode k12 = geraet(box(e, w.e4()), w.k12());
        assertThat(k12.path("rueckfall_herkunft").asText()).as("K-12: kein sicherer Rückfallwert hinterlegt")
                .isEqualTo("ohne_angabe");
        assertThat(k12.path("rueckfall_kw").decimalValue()).isEqualByComparingTo("60");
        assertThat(geraet(box(e, w.e1()), w.k1()).path("rueckfall_herkunft").asText()).isEqualTo("am_geraet");
        assertThat(woerter(e.path("hinweise"))).doesNotContain(GemeinsameSteuerungErklaerung.GERAET_NICHT_ERKLAERT,
                GemeinsameSteuerungErklaerung.ERZEUGER_NICHT_ERKLAERT);
        // G6 sieht die vollständige Gerätetabelle: Ladepunkte an E-4, Speicher (bezug) an E-1
        assertThat(mitglied(zustand, w.e4()).path("verbraucher14a").asText()).isEqualTo("ja");
        assertThat(protokoll(w)).contains("geraete", "erzeuger", "vorbehalt");

        // dieselbe Erklärung noch einmal: nichts ändert sich
        long vorher = zeilen(w);
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "473"))));
        assertThat(zeilen(w)).isEqualTo(vorher);
    }

    // ============================================================================ Vollständigkeit und Pflicht

    @Test
    void eineFehlendeKomponenteMitSchreibfreigabeIst422MitIhrerKennung() throws Exception {
        Welt w = welt();
        Antwort a = kunde(w, put(w.pfad()).content(erklaerung(w, w.k13().subList(0, 5), "\"keine\"", "473")));
        assertThat(a.status()).isEqualTo(422);
        assertThat(a.code()).isEqualTo("erklaerung_unvollstaendig");
        assertThat(a.body().path("fehlt")).hasSize(1);
        assertThat(a.body().path("fehlt").get(0).path("wort").asText()).isEqualTo("komponente");
        assertThat(a.body().path("fehlt").get(0).path("komponente_id").asText()).isEqualTo(w.k13().get(5).toString());
        assertThat(a.body().path("fehlt").get(0).path("box_id").asText()).isEqualTo(w.e4().toString());
        assertThat(zeilen(w)).as("nichts geschrieben").isZero();
    }

    @Test
    void keineErzeugerAusdruecklichSonstFehltDieAngabe() throws Exception {
        Welt w = welt();
        Antwort ohne = kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), null, "473")));
        assertThat(ohne.status()).isEqualTo(422);
        assertThat(ohne.body().path("fehlt").get(0).path("wort").asText()).isEqualTo("ungesteuerte_erzeuger");
        assertThat(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "[]", "473"))).status()).isEqualTo(400);
        assertThat(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "null", "473"))).status()).isEqualTo(400);
        assertThat(zeilen(w)).isZero();
        // eine Liste: ihre Summe ist der Vorbehalt der Einspeiseseite
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(),
                "[{\"bezeichnung\":\"BHKW Halle 2\",\"nenn_kw\":20}]", "473"))));
        JsonNode e = ok(kunde(w, get(w.pfad() + "/einrichten")));
        assertThat(e.path("ungesteuerte_erzeuger").get(0).path("bezeichnung").asText()).isEqualTo("BHKW Halle 2");
        assertThat(e.path("vorbehalt").path("einspeisung_kw").decimalValue()).isEqualByComparingTo("20");
        assertThat(e.path("ergebnis").path("einspeisung").path("urteil").asText())
                .as("Rückfälle 100 > verteilbar 80").isEqualTo("auslegung_passt_nicht");
    }

    @Test
    void schreibfreigabeMandantUndEinspeiseVorbehaltKommenNieAusDemKoerper() throws Exception {
        Welt w = welt();
        String mitFreigabe = erklaerung(w, w.k13(), "\"keine\"", "473").replace("\"nenn_kw\":60",
                "\"nenn_kw\":60,\"schreibfreigabe\":false");
        assertThat(kunde(w, put(w.pfad()).content(mitFreigabe)).status()).isEqualTo(400);
        String mitMandant = erklaerung(w, w.k13(), "\"keine\"", "473").replace("\"nenn_kw\":60",
                "\"nenn_kw\":60,\"tenant_id\":\"" + w.mandant() + "\"");
        assertThat(kunde(w, put(w.pfad()).content(mitMandant)).status()).isEqualTo(400);
        String einspeiseVorbehalt = erklaerung(w, w.k13(), "\"keine\"", "473").replace("\"bezug_kw\":473",
                "\"bezug_kw\":473,\"einspeisung_kw\":0");
        assertThat(kunde(w, put(w.pfad()).content(einspeiseVorbehalt)).status()).isEqualTo(400);
        String nullKw = erklaerung(w, w.k13(), "\"keine\"", "473").replace("\"nenn_kw\":60", "\"nenn_kw\":0");
        assertThat(kunde(w, put(w.pfad()).content(nullKw)).status()).as("Nennleistung > 0").isEqualTo(400);
        assertThat(zeilen(w)).isZero();
    }

    // ============================================================================ Strukturänderung (I3)

    @Test
    void jedeAenderungDerErklaerungSetztDieStufeZurueckUndStehtImProtokoll() throws Exception {
        Welt w = welt();
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "473"))));
        root.update("UPDATE steuerungsverbund SET stufe = 'geprueft' WHERE site_id = ?", w.an1());
        long geraete = protokollZahl(w, "geraete");
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "473").replace("\"nenn_kw\":60",
                "\"nenn_kw\":55"))));
        assertThat(stufe(w)).isEqualTo("beobachtet");
        assertThat(protokollZahl(w, "geraete")).isEqualTo(geraete + 1);
        JsonNode e = ok(kunde(w, get(w.pfad() + "/einrichten")));
        assertThat(woerter(e.path("hinweise"))).as("Bestand 60 kW, erklärt 55 kW: Hinweis, keine Ablehnung")
                .contains(GemeinsameSteuerungErklaerung.NENNLEISTUNG_WEICHT_AB);
        // Vorbehalt erklärt senken ohne Messung: gilt (erst das Scharfschalten des Betreibers macht ihn wirksam)
        root.update("UPDATE steuerungsverbund SET stufe = 'geprueft' WHERE site_id = ?", w.an1());
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "450"))));
        assertThat(stufe(w)).isEqualTo("beobachtet");
        assertThat(protokollZahl(w, "vorbehalt")).isEqualTo(2);
    }

    /**
     * B4: trägt eine Messung den Vorbehalt (IP-13 hat 473 → 495 erhöht), gewinnt sie — ein kleinerer erklärter Wert
     * ist 409 {@code vorbehalt_gemessen}, derselbe ändert nichts, ein größerer gilt als erklärt.
     */
    @Test
    void gemessenGewinntGegenEinenKleinerenErklaertenVorbehalt() throws Exception {
        Welt w = welt();
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "473"))));
        UUID v = root.queryForObject("SELECT id FROM steuerungsverbund WHERE site_id = ?", UUID.class, w.an1());
        root.update("UPDATE steuerungsverbund SET vorbehalt_bezug_kw = 495, vorbehalt_von = 'Vorbehalt aus "
                + "Messwerten', vorbehalt_am = TIMESTAMPTZ '2027-06-02T02:52:00Z' WHERE id = ?", v);
        root.update("INSERT INTO steuerungsverbund_vorbehalt (tenant_id, site_id, steuerungsverbund_id, art, zustand, "
                + "alt_kw, neu_kw, hoechstwert_kw, zeitraum_von, zeitraum_bis, messtage, fassung, erstellt_von, "
                + "erstellt_am) VALUES (?, ?, ?, 'erhoeht', 'wirksam', 473, 495, 450, DATE '2026-06-02', "
                + "DATE '2027-06-01', 40, '1', 'Vorbehalt aus Messwerten', TIMESTAMPTZ '2027-06-02T02:52:00Z')",
                w.mandant(), w.an1(), v);
        assertThat(ok(kunde(w, get(w.pfad() + "/einrichten"))).path("vorbehalt").path("bezug_herkunft").asText())
                .isEqualTo("gemessen");
        Antwort kleiner = kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "473")));
        assertThat(kleiner.status()).isEqualTo(409);
        assertThat(kleiner.code()).isEqualTo("vorbehalt_gemessen");
        long vorher = zeilen(w);
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "495"))));
        assertThat(zeilen(w)).as("derselbe Wert ändert nichts").isEqualTo(vorher);
        assertThat(ok(kunde(w, get(w.pfad() + "/einrichten"))).path("vorbehalt").path("bezug_herkunft").asText())
                .isEqualTo("gemessen");
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "500"))));
        JsonNode e = ok(kunde(w, get(w.pfad() + "/einrichten")));
        assertThat(e.path("vorbehalt").path("bezug_kw").decimalValue()).isEqualByComparingTo("500");
        assertThat(e.path("vorbehalt").path("bezug_herkunft").asText()).isEqualTo("erklaert");
    }

    @Test
    void inAnteileAktivVerlangtAendernErstAnhalten() throws Exception {
        Welt w = welt();
        ok(kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "473"))));
        root.update("UPDATE steuerungsverbund SET stufe = 'anteile_aktiv' WHERE site_id = ?", w.an1());
        Antwort a = kunde(w, put(w.pfad()).content(erklaerung(w, w.k13(), "\"keine\"", "480")));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.code()).isEqualTo("erst_anhalten");
    }

    // ============================================================================ Zaun und Bestand

    @Test
    void fremdeAnlageUndFremdeKomponenteSindNichtGefunden() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        assertThat(kunde(w, get(fremd.pfad() + "/einrichten")).status()).isEqualTo(404);
        assertThat(kunde(w, get(fremd.pfad() + "/komponenten/" + fremd.k1() + "/rueckfall")).status()).isEqualTo(404);
        assertThat(kunde(w, get(w.pfad() + "/komponenten/" + fremd.k1() + "/rueckfall")).status()).isEqualTo(404);
        assertThat(kunde(w, put(w.pfad() + "/komponenten/" + fremd.k1() + "/rueckfall").content(
                "{\"richtung\":\"einspeisung\",\"rueckfall\":\"laeuft_frei\"}")).status()).isEqualTo(404);
        assertThat(kunde(w, put(w.pfad() + "/komponenten/" + w.k1() + "/rueckfall").content(
                "{\"richtung\":\"einspeisung\",\"rueckfall\":\"faellt_auf_wert\"}")).status())
                .as("faellt_auf_wert ohne kW").isEqualTo(400);
    }

    // ============================================================================ Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Einrichten #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                t, u);
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)", t,
                an1, st1, LocalDate.parse("2024-01-01"));
        UUID na1 = root.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, "
                + "anschluss_kva, vereinbart_kw, messung) VALUES (?, ?, 'NA-1', 'Übergabestation NA-1', 630, 550, "
                + "'RLM') RETURNING id", UUID.class, t, st1);
        root.update("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", t, an1, na1);
        root.update("INSERT INTO netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab, einspeisegrenze_kw, "
                + "bezugsgrenze_kw, created_by) VALUES (?, ?, DATE '2024-01-01', 100, 550, 'test')", t, na1);
        UUID e1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name) VALUES (?, ?, ?, "
                + "'Box Halle 1') RETURNING id", UUID.class, t, an1, "E-1-" + nr);
        UUID e4 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name) VALUES (?, ?, ?, "
                + "'Box Verwaltung') RETURNING id", UUID.class, t, an1, "E-4-" + nr);
        // Der Speicher hängt an Box Halle 1 — sie führt (Anlagen-Rollen an die führende Box)
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, "
                + "roundtrip_efficiency_pct, device_id) VALUES (?, ?, 'battery', 200, 100, 100, 92, ?)", t, an1, e1);
        UUID dq1 = quelle(t, an1, "DQ-1", "10.0." + nr + ".1:502", e1);
        UUID dq2 = quelle(t, an1, "DQ-2", "10.0." + nr + ".2:502", e1);
        UUID dq8 = quelle(t, an1, "DQ-8", "10.0." + nr + ".8:502", e4);
        UUID dq9 = quelle(t, an1, "DQ-9", "10.0." + nr + ".9:502", e4);
        UUID dq10 = quelle(t, an1, "DQ-10", "10.0." + nr + ".10:502", e4);
        komponente(t, an1, "grid-meter", "grid-meter", false, dq2, null);
        UUID k1 = komponente(t, an1, "pv-generation", "producer", true, dq1, 100);
        UUID k2 = komponente(t, an1, "battery-hybrid", "battery-hybrid", true, dq1, null);
        UUID k12 = komponente(t, an1, "pv-generation", "producer", true, dq8, 60);
        List<UUID> k13 = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            UUID k = komponente(t, an1, "wallbox", "wallbox", true, dq9, null);
            root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                    + "VALUES (?, ?, ?, 'continuous', 22)", k, t, an1);
            k13.add(k);
        }
        return new Welt(t, an1, e1, e4, dq2, dq10, k1, k2, k12, k13);
    }

    private static UUID quelle(UUID t, UUID site, String kennzeichen, String adresse, UUID box) {
        UUID dq = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, '{1}', 10) RETURNING id", UUID.class, t,
                site, kennzeichen, adresse);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT tenant_id, id, ?, protokoll, adresse, date_trunc('minute', now()) - interval "
                + "'1 day' FROM data_source WHERE id = ?", box, dq);
        return dq;
    }

    private static UUID komponente(UUID t, UUID site, String rolle, String typ, boolean steuerbar, UUID quelle,
            Integer kwp) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, control, "
                + "data_source_id, capacity_kwp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z') "
                + "RETURNING id", UUID.class, t, site, rolle, typ, steuerbar, quelle, kwp);
    }

    /** Der Körper von PUT: V-1 mit den Geräten je Box; {@code ladepunkte} = die erklärten Ladepunkte an E-4. */
    private static String erklaerung(Welt w, List<UUID> ladepunkte, String erzeuger, String bezugKw) {
        StringBuilder e4 = new StringBuilder("{\"komponente_id\":\"" + w.k12()
                + "\",\"richtung\":\"einspeisung\",\"nenn_kw\":60}");
        ladepunkte.forEach(k -> e4.append(",{\"komponente_id\":\"").append(k)
                .append("\",\"richtung\":\"bezug\",\"nenn_kw\":22}"));
        return "{\"mitglieder\":["
                + "{\"box_id\":\"" + w.e1() + "\",\"rolle\":\"fuehrt\",\"messpunkt_id\":\"" + w.dq2() + "\","
                + "\"geraete\":[{\"komponente_id\":\"" + w.k1() + "\",\"richtung\":\"einspeisung\",\"nenn_kw\":100},"
                + "{\"komponente_id\":\"" + w.k2() + "\",\"richtung\":\"bezug\",\"nenn_kw\":100}]},"
                + "{\"box_id\":\"" + w.e4() + "\",\"rolle\":\"steuert_mit\",\"messpunkt_id\":\"" + w.dq10() + "\","
                + "\"geraete\":[" + e4 + "]}]"
                + (erzeuger == null ? "" : ",\"ungesteuerte_erzeuger\":" + erzeuger)
                + ",\"vorbehalt\":{\"bezug_kw\":" + bezugKw + "}}";
    }

    private static JsonNode box(JsonNode e, UUID box) {
        for (JsonNode b : e.path("boxen")) {
            if (b.path("box_id").asText().equals(box.toString())) {
                return b;
            }
        }
        throw new AssertionError("keine Box " + box + " in " + e);
    }

    private static JsonNode komponente(JsonNode box, UUID k) {
        for (JsonNode x : box.path("komponenten")) {
            if (x.path("komponente_id").asText().equals(k.toString())) {
                return x;
            }
        }
        throw new AssertionError("keine Komponente " + k + " in " + box);
    }

    private static JsonNode geraet(JsonNode box, UUID k) {
        for (JsonNode x : box.path("geraete")) {
            if (x.path("komponente_id").asText().equals(k.toString())) {
                return x;
            }
        }
        throw new AssertionError("kein Gerät " + k + " in " + box);
    }

    private static JsonNode mitglied(JsonNode zustand, UUID box) {
        for (JsonNode m : zustand.path("mitglieder")) {
            if (m.path("box_id").asText().equals(box.toString())) {
                return m;
            }
        }
        throw new AssertionError("kein Mitglied " + box);
    }

    private static java.math.BigDecimal anteil(JsonNode richtung, UUID box) {
        for (JsonNode a : richtung.path("anteile")) {
            if (a.path("box_id").asText().equals(box.toString())) {
                return a.path("kw").decimalValue();
            }
        }
        throw new AssertionError("kein Anteil " + box + " in " + richtung);
    }

    private static List<String> woerter(JsonNode hinweise) {
        List<String> w = new ArrayList<>();
        hinweise.forEach(h -> w.add(h.path("wort").asText()));
        return w;
    }

    private static long zeilen(Welt w) {
        return root.queryForObject("SELECT (SELECT count(*) FROM steuerungsverbund WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM steuerungsverbund_mitglied WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM steuerungsverbund_geraet WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM steuerungsverbund_erzeuger WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM steuerungsverbund_aenderung WHERE tenant_id = ?)", Long.class, w.mandant(),
                w.mandant(), w.mandant(), w.mandant(), w.mandant());
    }

    private static String stufe(Welt w) {
        return root.queryForObject("SELECT stufe FROM steuerungsverbund WHERE site_id = ?", String.class, w.an1());
    }

    private static List<String> protokoll(Welt w) {
        return root.queryForList("SELECT DISTINCT art FROM steuerungsverbund_aenderung WHERE site_id = ?", String.class,
                w.an1());
    }

    private static long protokollZahl(Welt w, String art) {
        return root.queryForObject("SELECT count(*) FROM steuerungsverbund_aenderung WHERE site_id = ? AND art = ?",
                Long.class, w.an1(), art);
    }

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    /** Der Kundenadministrator (Token mit Mandant, ohne Plattform-Rolle). */
    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON).with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        }))).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
