package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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
 * Die Routen der Gemeinsamen Steuerung (UEMS AP-15 IP-5, I1–I6, W2/Z1, W9, G6/Z3) über die echte Kette: je Wort des
 * Ablehnungs-Vokabulars ein Fall, die Rechte (Kunde richtet ein und hält an, NUR die Plattform schaltet scharf und
 * bestätigt), Mandant/Anlage nie aus dem Körper, und der Bestand (I6, R22).
 *
 * <p>Die Welt ist Ahrenberg aus der Referenzdatei 1.5: Anlage AN-1 „Werk Ahrenberg – Halle 1“ am Netzanschluss NA-1
 * (630 kVA, 550 kW vereinbart) mit Box Halle 1 (E-1, führt, Messpunkt DQ-2 = Netzzähler) und Box Verwaltung (E-4,
 * steuert mit, Messpunkt DQ-10); Anlage AN-2 „Halle 2“ am NA-2 (250 kVA, 200 kW) desselben Standorts ST-1 (R20).
 * Die Naht {@link SteuerungsverbundNachweise} läuft ECHT ({@link SteuerungsverbundNachweiseHeute}); wo ein Fall eine
 * Quelle braucht, die erst ein späteres Paket liefert, stellt ihn der Spion.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GemeinsameSteuerungApiTest {

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

    @SpyBean
    SteuerungsverbundNachweiseHeute nachweise;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Ahrenberg: Mandant, Standort ST-1, AN-1 mit E-1/E-4 und DQ-2/DQ-10, AN-2 mit E-2 und NA-1/NA-2. */
    private record Welt(UUID mandant, UUID st1, UUID an1, UUID an2, UUID na1, UUID na2, UUID e1, UUID e4, UUID e2,
            UUID dq2, UUID dq10) {
        String pfad() {
            return "/api/v1/sites/" + an1 + "/gemeinsame-steuerung";
        }

        String admin() {
            return "/api/v1/admin/sites/" + an1 + "/gemeinsame-steuerung";
        }
    }

    private record Antwort(int status, JsonNode body) {
        String code() {
            return body.path("code").asText();
        }

        List<String> fehlt() {
            List<String> w = new ArrayList<>();
            body.path("fehlt").forEach(b -> w.add(b.path("wort").asText()));
            return w;
        }
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    // ============================================================================ Bestand (I6, R22) und Z1

    @Test
    void ohneGemeinsameSteuerungNichtEingerichtetUndNichtsAendertSich() throws Exception {
        Welt w = welt(true, true);
        long vorher = zeilen(w);
        Antwort a = kunde(w, get(w.pfad()));
        assertThat(a.status()).isEqualTo(200);
        assertThat(a.body().path("eingerichtet").asBoolean()).isFalse();
        assertThat(a.body().path("zustand").asText()).isEqualTo("nicht_eingerichtet");
        assertThat(a.body().path("mitglieder")).isEmpty();
        assertThat(a.body().path("fehlt")).isEmpty();
        assertThat(a.body().path("stufe").isNull()).isTrue();
        assertThat(a.body().path("warnung_fuehrung").isNull()).isTrue();
        assertThat(zeilen(w)).as("Lesen legt nichts an (I6)").isEqualTo(vorher).isZero();
    }

    @Test
    void z1WarntOhneGemeinsameSteuerungWennFuehrendeBoxNichtDieSpeicherBoxIst() throws Exception {
        Welt w = welt(true, true);
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, "
                + "roundtrip_efficiency_pct, device_id) VALUES (?, ?, 'battery', 200, 100, 100, 92, ?)", w.mandant(),
                w.an1(), w.e1());
        assertThat(kunde(w, get(w.pfad())).body().path("warnung_fuehrung").isNull())
                .as("Speicher an der führenden Box: keine Warnung").isTrue();
        root.update("UPDATE site SET lead_device_id = ? WHERE id = ?", w.e4(), w.an1());
        JsonNode warnung = kunde(w, get(w.pfad())).body().path("warnung_fuehrung");
        assertThat(warnung.path("wort").asText()).isEqualTo("fuehrende_box_ist_nicht_speicher_box");
        assertThat(warnung.path("fuehrende_box_id").asText()).isEqualTo(w.e4().toString());
        assertThat(warnung.path("speicher_box_id").asText()).isEqualTo(w.e1().toString());
        assertThat(zeilen(w)).isZero();
    }

    // ============================================================================ je Ablehnung ein Fall

    /** R20 (T1): Box Halle 2 gehört zu AN-2 an NA-2 — sie wird kein Mitglied von AN-1, nichts wird geschrieben. */
    @Test
    void r20BoxEinerAnderenAnlageWirdKeinMitglied() throws Exception {
        Welt w = welt(true, true);
        Antwort a = kunde(w, put(w.pfad()).content(mitglieder(w.e1(), "fuehrt", w.dq2(), w.e2(), "steuert_mit", null)));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.code()).isEqualTo("box_nicht_in_anlage");
        assertThat(a.body().path("fehlt").get(0).path("box_id").asText()).isEqualTo(w.e2().toString());
        assertThat(zeilen(w)).as("abgelehnt = nichts geschrieben").isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM anlage_netzanschluss WHERE site_id = ? "
                + "AND netzanschluss_id = ?", Long.class, w.an2(), w.na2())).as("AN-2 bleibt an NA-2").isOne();
    }

    /** T1 beim Scharfschalten: eine ausgebaute Box ist nicht mehr in der Anlage. */
    @Test
    void ausgebauteBoxIstBeimScharfschaltenNichtInDerAnlage() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        root.update("UPDATE device SET ausgebaut_am = now(), status = 'ausgebaut' WHERE id = ?", w.e4());
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.code()).isEqualTo("box_nicht_in_anlage");
    }

    @Test
    void ohneNetzanschlussBleibtS0UndScharfschaltenSagtKeinNetzanschluss() throws Exception {
        Welt w = welt(false, true);
        Antwort e = einrichten(w);
        assertThat(e.body().path("zustand").asText()).isEqualTo("erklaert");
        assertThat(e.body().path("stufe").asText()).isEqualTo("S0");
        assertThat(e.body().path("naechster_schritt").asText()).isEqualTo("beobachtet");
        assertThat(e.fehlt()).as("ohne Bindung gilt auch das Grenzblatt von NA-1 nicht")
                .containsExactly("kein_netzanschluss", "grenze_fehlt");
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.code()).isEqualTo("kein_netzanschluss");
    }

    @Test
    void ohneBeideGrenzenSagtScharfschaltenGrenzeFehlt() throws Exception {
        Welt w = welt(true, false);
        grenze(w, null, "550");
        assertThat(einrichten(w).fehlt()).containsExactly("grenze_fehlt");
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.code()).isEqualTo("grenze_fehlt");
    }

    /** R14/I2: die Fähigkeit kennt heute keine Box — die Anlage kommt bis S1 und wird NIE scharf (der sichere Zustand). */
    @Test
    void heuteKommtDieAnlageBisS1UndScharfschaltenSagtFaehigkeitFehlt() throws Exception {
        Welt w = welt(true, true);
        Antwort e = einrichten(w);
        assertThat(e.status()).isEqualTo(200);
        assertThat(e.body().path("zustand").asText()).isEqualTo("beobachtet");
        assertThat(e.body().path("stufe").asText()).isEqualTo("S1");
        assertThat(e.body().path("naechster_schritt").asText()).isEqualTo("anteile_aktiv");
        assertThat(e.fehlt()).containsExactly("faehigkeit_fehlt", "faehigkeit_fehlt", "nachweis_fehlt",
                "nachweis_fehlt", "auslegung_passt_nicht", "vorgabe_signal_nicht_an_jeder_box",
                "vorgabe_signal_nicht_an_jeder_box");
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.code()).isEqualTo("faehigkeit_fehlt");
        assertThat(a.fehlt()).isEqualTo(e.fehlt());
        assertThat(stufe(w)).isEqualTo("beobachtet");
        assertThat(epoche(w)).isZero();
    }

    @Test
    void mitFaehigkeitFehltDerNachweis() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        doReturn(true).when(nachweise).faehigkeit(any());
        assertThat(plattform(w, post(w.admin() + "/scharfschalten")).code()).isEqualTo("nachweis_fehlt");
    }

    @Test
    void ohneRechenbareAuslegungPasstSieNicht() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        faehigUndGeprueft();
        assertThat(plattform(w, post(w.admin() + "/scharfschalten")).code()).isEqualTo("auslegung_passt_nicht");
    }

    /** R2 „ohne Rückfallwert an K-12“: Grenze 70 kW, Rückfälle 40 + 60 = 100 kW — passt nicht, Richtung Einspeisung. */
    @Test
    void r2RueckfaelleUeberDerGrenzePassenNicht() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        faehigUndGeprueft();
        auslegung(w, "70");
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.code()).isEqualTo("auslegung_passt_nicht");
        assertThat(a.body().path("fehlt").get(0).path("richtung").asText()).isEqualTo("einspeisung");
    }

    /** B1/W2: der Netzzähler DQ-2 wird von Box Verwaltung gelesen, nicht von der führenden Box Halle 1. */
    @Test
    void fuehrendeBoxDieDenNetzzaehlerNichtLiestMisstNicht() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        faehigUndGeprueft();
        auslegung(w, "100");
        root.update("UPDATE data_source_assignment SET effective_to = date_trunc('minute', now()) "
                + "WHERE data_source_id = ?", w.dq2());
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT tenant_id, id, ?, protokoll, adresse, date_trunc('minute', now()) "
                + "FROM data_source WHERE id = ?", w.e4(), w.dq2());
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.code()).isEqualTo("fuehrende_box_misst_nicht");
        assertThat(a.body().path("fehlt").get(0).path("box_id").asText()).isEqualTo(w.e1().toString());
    }

    /** R18 (G6, Z3): das Signal nach § 14a liegt nur an Box Halle 1, die Ladepunkte hängen an Box Verwaltung. */
    @Test
    void r18VorgabeSignalNurAnBoxHalle1() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        faehigUndGeprueft();
        auslegung(w, "100");
        doReturn(true).when(nachweise).vorgabeSignal(any(), eq(w.e1()));
        doReturn(false).when(nachweise).vorgabeSignal(any(), eq(w.e4()));
        doReturn(true).when(nachweise).verbraucher14a(any(), eq(w.e4()));
        doReturn(false).when(nachweise).verbraucher14a(any(), eq(w.e1()));
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.code()).isEqualTo("vorgabe_signal_nicht_an_jeder_box");
        assertThat(a.body().path("fehlt")).hasSize(1);
        assertThat(a.body().path("fehlt").get(0).path("box_id").asText()).isEqualTo(w.e4().toString());
        assertThat(stufe(w)).as("scharf_ohne_signal_an_e4 = false").isEqualTo("beobachtet");
    }

    /** B3: der Messpunkt der mitsteuernden Box wird von keiner Box gelesen. */
    @Test
    void mitsteuerndeBoxDieIhrenMesspunktNichtLiestMisstNicht() throws Exception {
        Welt w = welt(true, true);
        root.update("UPDATE data_source_assignment SET effective_to = date_trunc('minute', now()) "
                + "WHERE data_source_id = ?", w.dq10());
        Antwort e = einrichten(w);
        assertThat(e.body().path("zustand").asText()).isEqualTo("erklaert");
        assertThat(e.fehlt()).containsExactly("mitsteuernde_box_misst_nicht");
    }

    // ============================================================================ Übergänge und Rechte

    /**
     * I4/I5/W9: der Kundenadministrator richtet ein und hält an, schaltet aber NICHT scharf (403) und bestätigt nicht;
     * die Plattform schaltet mit allen Nachweisen scharf — neue Epoche, Mitglieder bestätigt.
     */
    @Test
    void nurDiePlattformSchaltetScharfDerKundeHaeltAn() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        allesDa(w);
        assertThat(kunde(w, post(w.admin() + "/scharfschalten")).status()).isEqualTo(403);
        assertThat(kunde(w, post(w.admin() + "/mitglieder/" + w.e4() + "/bestaetigen")).status()).isEqualTo(403);
        assertThat(stufe(w)).isEqualTo("beobachtet");

        Antwort s = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(s.status()).as(s.body().toString()).isEqualTo(200);
        assertThat(s.body().path("zustand").asText()).isEqualTo("anteile_aktiv");
        assertThat(s.body().path("stufe").asText()).isEqualTo("S3");
        assertThat(s.body().path("epoche").asLong()).isOne();
        s.body().path("mitglieder").forEach(m -> assertThat(m.path("bestaetigt_am").isNull()).isFalse());
        assertThat(plattform(w, post(w.admin() + "/scharfschalten")).code()).isEqualTo("bereits_aktiv");

        Antwort aendern = kunde(w, put(w.pfad()).content(mitglieder(w.e1(), "fuehrt", w.dq2(), null, null, null)));
        assertThat(aendern.code()).isEqualTo("erst_anhalten");

        Antwort h = kunde(w, post(w.pfad() + "/anhalten"));
        assertThat(h.status()).isEqualTo(200);
        assertThat(h.body().path("zustand").asText()).isEqualTo("angehalten");
        assertThat(h.body().path("epoche").asLong()).as("Anhalten nimmt keine Anteile weg").isOne();
        assertThat(kunde(w, post(w.pfad() + "/aufloesen")).code()).isEqualTo("anteile_in_kraft");

        Antwort f = kunde(w, post(w.pfad() + "/fortsetzen"));
        assertThat(f.status()).isEqualTo(200);
        assertThat(f.body().path("zustand").asText()).isEqualTo("anteile_aktiv");
        assertThat(f.body().path("epoche").asLong()).as("Fortsetzen ist kein neues Scharfschalten").isOne();
        assertThat(protokoll(w)).contains("eingerichtet", "mitglied", "stufe", "epoche");
    }

    @Test
    void mitgliedBestaetigenNurDiePlattformUndNurEinmal() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        Antwort b = plattform(w, post(w.admin() + "/mitglieder/" + w.e4() + "/bestaetigen"));
        assertThat(b.status()).isEqualTo(200);
        JsonNode e4 = mitglied(b.body(), w.e4());
        assertThat(e4.path("bestaetigt_am").isNull()).isFalse();
        assertThat(mitglied(b.body(), w.e1()).path("bestaetigt_am").isNull()).isTrue();
        assertThat(plattform(w, post(w.admin() + "/mitglieder/" + w.e4() + "/bestaetigen")).code())
                .isEqualTo("bereits_bestaetigt");
        assertThat(plattform(w, post(w.admin() + "/mitglieder/" + w.e2() + "/bestaetigen")).code())
                .isEqualTo("kein_mitglied");
    }

    @Test
    void uebergaengeOhneGemeinsameSteuerungUndAusDerFalschenStufe() throws Exception {
        Welt w = welt(true, true);
        assertThat(kunde(w, post(w.pfad() + "/anhalten")).code()).isEqualTo("nicht_eingerichtet");
        assertThat(plattform(w, post(w.admin() + "/scharfschalten")).code()).isEqualTo("nicht_eingerichtet");
        assertThat(zeilen(w)).isZero();
        einrichten(w);
        assertThat(kunde(w, post(w.pfad() + "/anhalten")).code()).isEqualTo("nicht_aktiv");
        assertThat(kunde(w, post(w.pfad() + "/fortsetzen")).code()).isEqualTo("nicht_angehalten");
        Antwort a = kunde(w, post(w.pfad() + "/aufloesen"));
        assertThat(a.status()).isEqualTo(200);
        assertThat(a.body().path("zustand").asText()).isEqualTo("aufgeloest");
        assertThat(a.body().path("mitglieder")).isEmpty();
        Antwort wieder = einrichten(w);
        assertThat(wieder.body().path("zustand").asText()).as("wieder einrichten nach dem Auflösen").isEqualTo(
                "beobachtet");
    }

    @Test
    void aendernBeendetNurWasSichAendert() throws Exception {
        Welt w = welt(true, true);
        einrichten(w);
        long vorher = root.queryForObject("SELECT count(*) FROM steuerungsverbund_mitglied WHERE site_id = ?",
                Long.class, w.an1());
        Antwort gleich = einrichten(w);
        assertThat(gleich.status()).isEqualTo(200);
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_mitglied WHERE site_id = ?",
                Long.class, w.an1())).as("derselbe Stand schreibt nichts").isEqualTo(vorher);
        Antwort ohneE4 = kunde(w, put(w.pfad()).content(mitglieder(w.e1(), "fuehrt", w.dq2(), null, null, null)));
        assertThat(ohneE4.status()).isEqualTo(200);
        assertThat(ohneE4.body().path("mitglieder")).hasSize(1);
    }

    // ============================================================================ Mandant nie aus dem Körper, Zaun

    @Test
    void mandantOderAnlageImKoerperSind400() throws Exception {
        Welt w = welt(true, true);
        String mitMandant = "{\"tenant_id\":\"" + w.mandant() + "\",\"mitglieder\":[{\"box_id\":\"" + w.e1()
                + "\",\"rolle\":\"fuehrt\",\"messpunkt_id\":\"" + w.dq2() + "\"}]}";
        Antwort a = kunde(w, put(w.pfad()).content(mitMandant));
        assertThat(a.status()).isEqualTo(400);
        assertThat(a.code()).isEqualTo("anfrage_ungueltig");
        String mitAnlage = "{\"mitglieder\":[{\"box_id\":\"" + w.e1() + "\",\"rolle\":\"fuehrt\",\"messpunkt_id\":\""
                + w.dq2() + "\",\"site_id\":\"" + w.an2() + "\"}]}";
        assertThat(kunde(w, put(w.pfad()).content(mitAnlage)).status()).isEqualTo(400);
        assertThat(kunde(w, post(w.pfad() + "/anhalten").content("{\"site_id\":\"" + w.an2() + "\"}")).status())
                .isEqualTo(400);
        assertThat(plattform(w, post(w.admin() + "/scharfschalten").content("{\"tenant_id\":\"" + w.mandant()
                + "\"}")).status()).isEqualTo(400);
        Antwort liest = kunde(w, put(w.pfad()).content(mitglieder(w.e1(), "liest", w.dq2(), null, null, null)));
        assertThat(liest.code()).as("Lesen macht kein Mitglied (T6)").isEqualTo("anfrage_ungueltig");
        assertThat(zeilen(w)).isZero();
    }

    @Test
    void fremdeAnlageIstNichtGefunden() throws Exception {
        Welt w = welt(true, true);
        Welt fremd = welt(true, true);
        Antwort a = kunde(w, get(fremd.pfad()));
        assertThat(a.status()).isEqualTo(404);
        assertThat(a.code()).isEqualTo("nicht_gefunden");
        assertThat(kunde(w, put(fremd.pfad()).content(mitglieder(fremd.e1(), "fuehrt", fremd.dq2(), null, null,
                null))).status()).isEqualTo(404);
        assertThat(plattform(w, post(fremd.admin() + "/scharfschalten")).status()).isEqualTo(404);
        assertThat(zeilen(fremd)).isZero();
    }

    // ============================================================================ Gerüst

    /**
     * Ahrenberg. {@code gebunden}: AN-1 hängt an NA-1; {@code grenzen}: Grenzblatt NA-1 100 kW / 550 kW (R1). DQ-2 liest
     * E-1, DQ-10 liest E-4 — seit gestern.
     */
    private Welt welt(boolean gebunden, boolean grenzen) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Gemeinsame Steuerung #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                t, u);
        UUID an1 = anlage(t, st1, "Werk Ahrenberg – Halle 1");
        UUID an2 = anlage(t, st1, "Werk Ahrenberg – Halle 2");
        UUID na1 = netzanschluss(t, st1, "NA-1", 630, 550);
        UUID na2 = netzanschluss(t, st1, "NA-2", 250, 200);
        if (gebunden) {
            binden(t, an1, na1);
        }
        binden(t, an2, na2);
        UUID e1 = box(t, an1, "E-1-" + nr);
        UUID e4 = box(t, an1, "E-4-" + nr);
        UUID e2 = box(t, an2, "E-2-" + nr);
        UUID dq2 = quelle(t, an1, "DQ-2", "10.0.1.2:502", e1);
        UUID dq10 = quelle(t, an1, "DQ-10", "10.0.4.10:502", e4);
        Welt w = new Welt(t, st1, an1, an2, na1, na2, e1, e4, e2, dq2, dq10);
        if (grenzen) {
            grenze(w, "100", "550");
        }
        return w;
    }

    private static UUID anlage(UUID t, UUID st, String name) {
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class, t,
                name);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)", t,
                site, st, LocalDate.parse("2024-01-01"));
        return site;
    }

    private static UUID netzanschluss(UUID t, UUID st, String kennzeichen, int kva, int kw) {
        return root.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, "
                + "anschluss_kva, vereinbart_kw, messung) VALUES (?, ?, ?, ?, ?, ?, 'RLM') RETURNING id", UUID.class, t,
                st, kennzeichen, "Übergabestation " + kennzeichen, kva, kw);
    }

    private static void binden(UUID t, UUID site, UUID na) {
        root.update("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", t, site, na);
    }

    private static UUID box(UUID t, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, site, ref);
    }

    private static UUID quelle(UUID t, UUID site, String kennzeichen, String adresse, UUID box) {
        UUID dq = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, '{1}', 10) RETURNING id", UUID.class, t,
                site, kennzeichen, adresse);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT tenant_id, id, ?, protokoll, adresse, date_trunc('minute', now()) - interval '1 day' "
                + "FROM data_source WHERE id = ?", box, dq);
        return dq;
    }

    private static void grenze(Welt w, String einspeisung, String bezug) {
        root.update("INSERT INTO netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab, einspeisegrenze_kw, "
                + "bezugsgrenze_kw, created_by) VALUES (?, ?, DATE '2024-01-01', ?::numeric, ?::numeric, 'test')",
                w.mandant(), w.na1(), einspeisung, bezug);
    }

    /** E-1 führt am Netzzähler DQ-2, E-4 steuert mit am Abgangszähler DQ-10 (V-1). */
    private Antwort einrichten(Welt w) throws Exception {
        Antwort a = kunde(w, put(w.pfad()).content(mitglieder(w.e1(), "fuehrt", w.dq2(), w.e4(), "steuert_mit",
                w.dq10())));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a;
    }

    private void faehigUndGeprueft() {
        doReturn(true).when(nachweise).faehigkeit(any());
        doReturn(true).when(nachweise).sprungprobe(any(), any());
    }

    /**
     * Die Auslegung aus R1 (Einspeisung: E-1 Nenn 100 / Rückfall 40, E-4 Nenn 60 / Rückfall 60, Vorbehalt 0; Bezug:
     * Grenze 550, Vorbehalt 473, E-1 0 / 0, E-4 Nenn 132 / Rückfall 24,6) — nur die Einspeisegrenze wird variiert.
     */
    private void auslegung(Welt w, String einspeisegrenze) {
        Map<Grenzart, SteuerungsverbundRegeln.Richtung> m = Map.of(
                Grenzart.EINSPEISUNG, new SteuerungsverbundRegeln.Richtung(new BigDecimal(einspeisegrenze),
                        BigDecimal.ZERO, Map.of(
                                w.e1().toString(), leistung("100", "40"),
                                w.e4().toString(), leistung("60", "60"))),
                Grenzart.BEZUG, new SteuerungsverbundRegeln.Richtung(new BigDecimal("550"), new BigDecimal("473"),
                        Map.of(w.e1().toString(), leistung("100", "0"),
                                w.e4().toString(), leistung("132", "24.6"))));
        doReturn(Optional.of(m)).when(nachweise).auslegung(eq(w.an1()), any(), any());
    }

    /** Alle Quellen da, G6 erfüllt: das Signal liegt an beiden Boxen. */
    private void allesDa(Welt w) {
        faehigUndGeprueft();
        auslegung(w, "100");
        doReturn(true).when(nachweise).vorgabeSignal(any(), any());
    }

    private static SteuerungsverbundRegeln.Leistung leistung(String nenn, String rueckfall) {
        return new SteuerungsverbundRegeln.Leistung(new BigDecimal(nenn), new BigDecimal(rueckfall));
    }

    private static String mitglieder(UUID b1, String r1, UUID m1, UUID b2, String r2, UUID m2) {
        StringBuilder s = new StringBuilder("{\"mitglieder\":[").append(mitglied(b1, r1, m1));
        if (b2 != null) {
            s.append(',').append(mitglied(b2, r2, m2));
        }
        return s.append("]}").toString();
    }

    private static String mitglied(UUID box, String rolle, UUID messpunkt) {
        return "{\"box_id\":\"" + box + "\",\"rolle\":\"" + rolle + "\",\"messpunkt_id\":"
                + (messpunkt == null ? "null" : "\"" + messpunkt + "\"") + "}";
    }

    private static JsonNode mitglied(JsonNode zustand, UUID box) {
        for (JsonNode m : zustand.path("mitglieder")) {
            if (m.path("box_id").asText().equals(box.toString())) {
                return m;
            }
        }
        throw new AssertionError("kein Mitglied " + box);
    }

    private static long zeilen(Welt w) {
        return root.queryForObject("SELECT (SELECT count(*) FROM steuerungsverbund WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM steuerungsverbund_mitglied WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM steuerungsverbund_aenderung WHERE tenant_id = ?)", Long.class, w.mandant(),
                w.mandant(), w.mandant());
    }

    private static String stufe(Welt w) {
        return root.queryForObject("SELECT stufe FROM steuerungsverbund WHERE site_id = ?", String.class, w.an1());
    }

    private static long epoche(Welt w) {
        return root.queryForObject("SELECT epoche FROM steuerungsverbund WHERE site_id = ?", Long.class, w.an1());
    }

    private static List<String> protokoll(Welt w) {
        return root.queryForList("SELECT DISTINCT art FROM steuerungsverbund_aenderung WHERE site_id = ?", String.class,
                w.an1());
    }

    /** Der Kundenadministrator (Token mit Mandant, ohne Plattform-Rolle). */
    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        })));
    }

    /** VoltPilot-Betrieb am Umschalter {@code X-Tenant-Id}. */
    private Antwort plattform(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.header("X-Tenant-Id", w.mandant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))));
    }

    private Antwort ruf(MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON)).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
