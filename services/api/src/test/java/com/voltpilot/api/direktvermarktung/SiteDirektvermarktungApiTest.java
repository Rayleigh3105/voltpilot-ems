package com.voltpilot.api.direktvermarktung;

import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.OVPN_GUELTIG;
import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.baueZip;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Der Anschluss einer Anlage an einen Direktvermarkter über die echte API und Datenbank (Konzept
 * vp-direktvermarktung-konzept d2 §5.7/§6, Entscheidungen E1-E6 = A). Der Partnerkatalog ist hier ein
 * fester Testdouble ({@code luox}) statt der echten {@code catalog/direktvermarkter/}-Dateien (eigener,
 * paralleler Auftrag) - die Katalog-Route selbst hat {@link PartnerKatalogTest}.
 *
 * <p>Deckt: wählen → zustimmen → Startdatum (vergangen: Vermarktungsart sofort um, künftig: erst der
 * Nachtlauf), beenden (vergangen vs. künftig), Wechsel (zwei Einträge nebeneinander, nie zwei ohne Ende),
 * die 409-Ablehnungen, RLS (eine fremde Anlage ist 404), das Recht ({@code anlage.verwalten|lesend}) und
 * die Plattform-Liste.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SiteDirektvermarktungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    private static final PartnerProfil LUOX = new PartnerProfil("luox", "luox energy", "2026-06-02",
            new PartnerProfil.Vertrag("https://direktvermarktung.luox-energy.de/erloesrechner?spid=voltpilot",
                    "spid=voltpilot", "erloesrechner_mit_abschluss"), null);
    /** Wie {@code LUOX}, aber mit Gegenstellen-Schranke ({@code zugang.vpn.gegenstellen}) im Profil. */
    private static final PartnerProfil LUOX_MIT_GEGENSTELLEN = new PartnerProfil(LUOX.partner(), LUOX.name(),
            LUOX.fassung(), LUOX.vertrag(),
            new PartnerProfil.Zugang(new PartnerProfil.Vpn(List.of("*.luox-energy.de"))));
    private static final PartnerProfil LUOX_MIT_FREMDER_GEGENSTELLE = new PartnerProfil(LUOX.partner(), LUOX.name(),
            LUOX.fassung(), LUOX.vertrag(),
            new PartnerProfil.Zugang(new PartnerProfil.Vpn(List.of("vpn.anderer.de"))));
    private static final PartnerProfil ANDERER = new PartnerProfil("anderer", "Anderer Partner", "2026-01-01", null,
            null);

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

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
        registry.add("voltpilot.direktvermarktung.partnerzugang-schluessel",
                ZugangsdateiTestfixturen::testSchluesselBase64);
    }

    @Autowired MockMvc mvc;
    @MockitoBean PartnerKatalog katalog;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID site) {
        String basis() {
            return "/api/v1/sites/" + site + "/direktvermarktung";
        }

        String sub() {
            return "sub-kundenadministrator-" + mandant;
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @Test
    void waehlenZustimmenStartdatumVergangenStelltVermarktungsartSofortUm() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        when(katalog.alle()).thenReturn(List.of(LUOX));
        Welt w = welt();

        Antwort leer = als(w, get(w.basis()));
        assertThat(leer.status()).isEqualTo(200);
        assertThat(leer.body().path("aktuell").isNull()).isTrue();
        assertThat(leer.body().path("darf").asBoolean()).isTrue();
        assertThat(leer.body().path("katalog")).hasSize(1);

        Antwort gewaehlt = als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}")
                .contentType(MediaType.APPLICATION_JSON));
        assertThat(gewaehlt.status()).as(gewaehlt.body().toString()).isEqualTo(200);
        assertThat(gewaehlt.body().path("aktuell").path("zustand").asText()).isEqualTo("entwurf");
        assertThat(gewaehlt.body().path("partner").path("name").asText()).isEqualTo("luox energy");

        // Ein zweiter Entwurf ohne Ende ist abgelehnt (die Anlage hat schon einen aktiven Eintrag).
        Antwort zweiterVersuch = als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}")
                .contentType(MediaType.APPLICATION_JSON));
        assertThat(zweiterVersuch.status()).isEqualTo(409);
        assertThat(zweiterVersuch.body().path("grund").asText()).isEqualTo("schon_eingerichtet");

        Antwort zugestimmt = als(w, post(w.basis() + "/zustimmen")
                .content("{\"textfassung\":\"luox darf sehen und begrenzen.\"}").contentType(MediaType.APPLICATION_JSON));
        assertThat(zugestimmt.body().path("aktuell").path("zustand").asText()).isEqualTo("wartet_auf_zugang");
        assertThat(zugestimmt.body().path("aktuell").path("zustimmungVon").asText()).isEqualTo(w.sub());

        // Startdatum in der Vergangenheit: die Vermarktungsart steht SOFORT auf Direktvermarktung.
        LocalDate gestern = LocalDate.now().minusDays(1);
        Antwort start = als(w, put(w.basis() + "/startdatum").content("{\"startdatum\":\"" + gestern + "\"}")
                .contentType(MediaType.APPLICATION_JSON));
        assertThat(start.body().path("aktuell").path("startdatum").asText()).isEqualTo(gestern.toString());
        assertThat(root.queryForObject("SELECT plant_kind FROM site WHERE id = ?", String.class, w.site()))
                .isEqualTo("direktvermarktung");

        // Beenden mit vergangenem Datum: sofort beendet, Vermarktungsart faellt zurueck. "Aktuell" ist danach leer -
        // ein beendeter Eintrag ist kein aktiver Anschluss mehr ("Nicht verbunden", Konzept §7.6).
        LocalDate vorgestern = LocalDate.now().minusDays(2);
        Antwort beendet = als(w, post(w.basis() + "/beenden").content("{\"ende\":\"" + vorgestern + "\"}")
                .contentType(MediaType.APPLICATION_JSON));
        assertThat(beendet.body().path("aktuell").isMissingNode()
                || beendet.body().path("aktuell").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT zustand FROM direktvermarktung WHERE site_id = ?", String.class,
                w.site())).isEqualTo("beendet");
        assertThat(root.queryForObject("SELECT plant_kind FROM site WHERE id = ?", String.class, w.site()))
                .isEqualTo("eigenverbrauch");

        List<String> ereignisse = root.queryForList("SELECT ereignis FROM direktvermarktung_protokoll "
                + "WHERE site_id = ? ORDER BY am, id", String.class, w.site());
        assertThat(ereignisse).containsExactly("gewaehlt", "zugestimmt", "startdatum_gesetzt", "beendet");
    }

    @Test
    void beendenMitKuenftigemDatumBleibtEndetBisZumNachtlauf() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        when(katalog.alle()).thenReturn(List.of(LUOX));
        Welt w = welt();
        als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}").contentType(MediaType.APPLICATION_JSON));
        // Startdatum in der Vergangenheit: die Vermarktungsart steht auf Direktvermarktung.
        als(w, put(w.basis() + "/startdatum").content("{\"startdatum\":\"" + LocalDate.now().minusDays(1) + "\"}")
                .contentType(MediaType.APPLICATION_JSON));

        LocalDate naechstenMonat = LocalDate.now().plusMonths(1);
        Antwort beendet = als(w, post(w.basis() + "/beenden").content("{\"ende\":\"" + naechstenMonat + "\"}")
                .contentType(MediaType.APPLICATION_JSON));
        assertThat(beendet.body().path("aktuell").path("zustand").asText()).isEqualTo("endet");
        // Noch nicht zurueckgefallen: das Ende liegt in der Zukunft, der Nachtlauf holt es erst am Tag selbst nach.
        assertThat(root.queryForObject("SELECT plant_kind FROM site WHERE id = ?", String.class, w.site()))
                .isEqualTo("direktvermarktung");
    }

    @Test
    void wechselLegtZweitenEintragAnOhneDenErstenZuBeendenVorDemStichtag() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        when(katalog.finde("anderer")).thenReturn(ANDERER);
        when(katalog.alle()).thenReturn(List.of(LUOX, ANDERER));
        Welt w = welt();
        als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}").contentType(MediaType.APPLICATION_JSON));

        LocalDate stichtag = LocalDate.now().plusMonths(1);
        Antwort wechsel = als(w, post(w.basis() + "/wechseln")
                .content("{\"partner\":\"anderer\",\"stichtag\":\"" + stichtag + "\"}")
                .contentType(MediaType.APPLICATION_JSON));
        assertThat(wechsel.status()).as(wechsel.body().toString()).isEqualTo(200);
        assertThat(wechsel.body().path("aktuell").path("partner").asText()).isEqualTo("luox");
        assertThat(wechsel.body().path("aktuell").path("zustand").asText()).isEqualTo("endet");
        assertThat(wechsel.body().path("geplant").path("partner").asText()).isEqualTo("anderer");
        assertThat(wechsel.body().path("geplant").path("zustand").asText()).isEqualTo("entwurf");

        Integer anzahl = root.queryForObject("SELECT count(*) FROM direktvermarktung WHERE site_id = ?",
                Integer.class, w.site());
        assertThat(anzahl).isEqualTo(2);
    }

    @Test
    void fremdeAnlageIst404UndUnbekannterPartnerIst409() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        when(katalog.finde("spuk")).thenReturn(null);
        Welt w = welt();
        Welt fremd = welt();

        assertThat(als(w, get(fremd.basis())).status()).isEqualTo(404);
        Antwort unbekannt = als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"spuk\"}")
                .contentType(MediaType.APPLICATION_JSON));
        assertThat(unbekannt.status()).isEqualTo(409);
        assertThat(unbekannt.body().path("grund").asText()).isEqualTo("partner_unbekannt");
    }

    @Test
    void adminListeZeigtAktiveAnschluesse() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        Welt w = welt();
        als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}").contentType(MediaType.APPLICATION_JSON));

        Map<String, Object> c = new HashMap<>();
        c.put("sub", "admin-sub");
        c.put("preferred_username", "admin");
        c.put("realm_access", Map.of("roles", List.of("platform-admin")));
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), c);
        MvcResult res = mvc.perform(get("/api/v1/admin/direktvermarktung")
                .with(authentication(new KeycloakRealmRoleConverter().convert(jwt)))).andReturn();
        assertThat(res.getResponse().getStatus()).isEqualTo(200);
        JsonNode liste = MAPPER.readTree(res.getResponse().getContentAsString(StandardCharsets.UTF_8));
        boolean enthaelt = false;
        for (JsonNode z : liste) {
            if (w.site().toString().equals(z.path("siteId").asText())) enthaelt = true;
        }
        assertThat(enthaelt).isTrue();
    }

    /**
     * ⚠ {@code abfragen_je_minute} ist {@code NUMERIC(6,2)} - pgJDBC liefert dafür ein
     * {@link java.math.BigDecimal}; ein roher {@code (Double)}-Cast auf {@code rs.getObject(...)} warf
     * {@code ClassCastException}, sobald die Spalte je nicht NULL war (kein bisheriger Test setzte sie).
     */
    @Test
    void standZeigtDenHerzschlagMitNichtGanzzahligerAbfragerate() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        Welt w = welt();
        als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}").contentType(MediaType.APPLICATION_JSON));
        root.update("INSERT INTO direktvermarktung_stand (site_id, tenant_id, handshake_am, letzte_abfrage_am, "
                + "abfragen_je_minute, vorgabe_pct, lebenszeichen_am) VALUES (?, ?, now(), now(), 4.25, 100, now())",
                w.site(), w.mandant());

        Antwort res = als(w, get(w.basis()));
        assertThat(res.status()).isEqualTo(200);
        assertThat(res.body().path("stand").path("abfragenJeMinute").asDouble()).isEqualTo(4.25);
    }

    /**
     * §5.7 "Die Zugangsdatei": ZIP + Passwort gegen die echte Route, echte Verschlüsselung
     * (Testschlüssel aus {@link ZugangsdateiTestfixturen#testSchluesselBase64()}), echte Datenbank - nie
     * Chiffrat, Nonce oder Passwort in der Antwort; der erste Upload setzt den Zustand auf "verbindet".
     */
    @Test
    void zugangHochladenLegtDieVerschluesselteZeileAnUndSetztVerbindet() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        Welt w = welt();
        als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}").contentType(MediaType.APPLICATION_JSON));
        als(w, post(w.basis() + "/zustimmen").content("{\"textfassung\":\"luox darf sehen und begrenzen.\"}")
                .contentType(MediaType.APPLICATION_JSON));

        byte[] zip = baueZip("geheim123", Map.of("ABC_1234567.ovpn", OVPN_GUELTIG));
        Antwort res = als(w, zugangUpload(w, zip, "ABC_1234567.zip", "geheim123"));
        assertThat(res.status()).as(res.body().toString()).isEqualTo(200);
        assertThat(res.body().path("name").asText()).isEqualTo("ABC_1234567");
        assertThat(res.body().path("fingerabdruck").asText()).matches("^[0-9a-f]{2}(:[0-9a-f]{2}){31}$");
        assertThat(res.body().toString()).doesNotContainIgnoringCase("chiffrat").doesNotContainIgnoringCase("nonce")
                .doesNotContain("geheim123");

        assertThat(root.queryForObject("SELECT zustand FROM direktvermarktung WHERE site_id = ?", String.class,
                w.site())).isEqualTo("verbindet");
        Map<String, Object> zeile = root.queryForMap(
                "SELECT hochgeladen_von, gueltig_bis FROM direktvermarktung_zugang WHERE site_id = ?", w.site());
        assertThat(zeile.get("hochgeladen_von")).isEqualTo(w.sub());
        assertThat(zeile.get("gueltig_bis")).isNotNull();
        assertThat(root.queryForList("SELECT ereignis FROM direktvermarktung_protokoll WHERE site_id = ? "
                + "ORDER BY am, id", String.class, w.site())).contains("zugang_hochgeladen");
    }

    @Test
    void zugangHochladenMitFalschemPasswortLehntAbOhneDasPasswortZuNennen() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        Welt w = welt();
        als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}").contentType(MediaType.APPLICATION_JSON));
        als(w, post(w.basis() + "/zustimmen").content("{\"textfassung\":\"x\"}").contentType(MediaType.APPLICATION_JSON));

        byte[] zip = baueZip("geheim123", Map.of("ABC.ovpn", OVPN_GUELTIG));
        Antwort res = als(w, zugangUpload(w, zip, "ABC.zip", "falsch"));
        assertThat(res.status()).isEqualTo(409);
        assertThat(res.body().path("grund").asText()).isEqualTo("passwort_falsch");
        assertThat(root.queryForObject("SELECT count(*) FROM direktvermarktung_zugang WHERE site_id = ?",
                Integer.class, w.site())).isZero();
    }

    /**
     * Die Gegenstellen-Schranke des Partnerprofils ({@code zugang.vpn.gegenstellen}): das Fixture-Paket
     * nennt {@code vpn.luox-energy.de} als Gegenstelle - mit passendem Muster geht der Upload durch, mit
     * fremdem Muster ist die Datei "keine Zugangsdatei" (derselbe stille Satz wie jede andere Ablehnung,
     * er nennt nie, welche Gegenstelle erwartet war).
     */
    @Test
    void zugangHochladenMitPassenderGegenstelleGehtDurchMitFremderNicht() throws Exception {
        // Die plattformweite Fingerabdruck-Eindeutigkeit sieht auch die Uploads der ANDEREN Tests dieser
        // Klasse (ein Zertifikat-Fixture, eine Datenbank) - für den positiven Fall muss die Tafel leer sein.
        root.update("DELETE FROM direktvermarktung_zugang");
        when(katalog.finde("luox")).thenReturn(LUOX_MIT_GEGENSTELLEN);
        Welt w = welt();
        als(w, post(w.basis() + "/waehlen").content("{\"partner\":\"luox\"}").contentType(MediaType.APPLICATION_JSON));
        als(w, post(w.basis() + "/zustimmen").content("{\"textfassung\":\"x\"}").contentType(MediaType.APPLICATION_JSON));
        byte[] zip = baueZip("geheim123", Map.of("ABC.ovpn", OVPN_GUELTIG));
        Antwort res = als(w, zugangUpload(w, zip, "ABC.zip", "geheim123"));
        assertThat(res.status()).as(res.body().toString()).isEqualTo(200);

        when(katalog.finde("luox")).thenReturn(LUOX_MIT_FREMDER_GEGENSTELLE);
        Welt fremd = welt();
        als(fremd, post(fremd.basis() + "/waehlen").content("{\"partner\":\"luox\"}")
                .contentType(MediaType.APPLICATION_JSON));
        als(fremd, post(fremd.basis() + "/zustimmen").content("{\"textfassung\":\"x\"}")
                .contentType(MediaType.APPLICATION_JSON));
        Antwort abgelehnt = als(fremd, zugangUpload(fremd, zip, "ABC.zip", "geheim123"));
        assertThat(abgelehnt.status()).isEqualTo(409);
        assertThat(abgelehnt.body().path("grund").asText()).isEqualTo("keine_zugangsdatei");
        assertThat(abgelehnt.body().toString()).doesNotContain("vpn.anderer.de");
        assertThat(root.queryForObject("SELECT count(*) FROM direktvermarktung_zugang WHERE site_id = ?",
                Integer.class, fremd.site())).isZero();
    }

    /** Der Katalog der Status-Antwort trägt die Gegenstellen-Schranke NICHT nach außen (WRITE_ONLY). */
    @Test
    void katalogAntwortNenntKeineGegenstellen() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX_MIT_GEGENSTELLEN);
        when(katalog.alle()).thenReturn(List.of(LUOX_MIT_GEGENSTELLEN));
        Welt w = welt();
        Antwort res = als(w, get(w.basis()));
        assertThat(res.status()).isEqualTo(200);
        assertThat(res.body().toString()).doesNotContain("gegenstellen").doesNotContain("*.luox-energy.de");
        assertThat(res.body().path("katalog").get(0).path("partner").asText()).isEqualTo("luox");
    }

    /**
     * Die plattformweite Eindeutigkeit (Migration V20261125140000, {@link FingerabdruckEindeutigkeit}):
     * dasselbe Zertifikat über eine ANDERE Anlage (anderer Mandant) hochgeladen ist "schon_in_verwendung" -
     * der Satz nennt nie, wo es schon steht.
     */
    @Test
    void zweiteAnlageMitDemselbenZertifikatIstSchonInVerwendung() throws Exception {
        when(katalog.finde("luox")).thenReturn(LUOX);
        Welt erste = welt();
        als(erste, post(erste.basis() + "/waehlen").content("{\"partner\":\"luox\"}")
                .contentType(MediaType.APPLICATION_JSON));
        als(erste, post(erste.basis() + "/zustimmen").content("{\"textfassung\":\"x\"}")
                .contentType(MediaType.APPLICATION_JSON));
        byte[] zip = baueZip("geheim123", Map.of("ABC.ovpn", OVPN_GUELTIG));
        als(erste, zugangUpload(erste, zip, "ABC.zip", "geheim123"));

        Welt zweite = welt();
        als(zweite, post(zweite.basis() + "/waehlen").content("{\"partner\":\"luox\"}")
                .contentType(MediaType.APPLICATION_JSON));
        als(zweite, post(zweite.basis() + "/zustimmen").content("{\"textfassung\":\"x\"}")
                .contentType(MediaType.APPLICATION_JSON));
        Antwort res = als(zweite, zugangUpload(zweite, zip, "ABC.zip", "geheim123"));
        assertThat(res.status()).as(res.body().toString()).isEqualTo(409);
        assertThat(res.body().path("grund").asText()).isEqualTo("schon_in_verwendung");
        assertThat(res.body().path("message").asText()).doesNotContain(erste.site().toString());
    }

    private static org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder zugangUpload(
            Welt w, byte[] zip, String dateiname, String passwort) {
        return multipart(w.basis() + "/zugang")
                .file(new MockMultipartFile("datei", dateiname, "application/zip", zip))
                .file(new MockMultipartFile("passwort", "", "text/plain", passwort.getBytes(StandardCharsets.UTF_8)));
    }

    // --- Welt ----------------------------------------------------------------------------------------------------

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Direktvermarktung #" + nr);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) VALUES (?, 'Haus "
                + nr + "', 48.137, 11.575) RETURNING id", UUID.class, t);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                + "'Person', 'aktiv')", t, "sub-kundenadministrator-" + t);
        return new Welt(t, site);
    }

    private Antwort als(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return antwort(mvc.perform(r.with(authentifizierung(w))).andReturn());
    }

    /** Multipart-Anfragen (Upload) teilen keinen Supertyp mit {@link MockHttpServletRequestBuilder}. */
    private Antwort als(Welt w, org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder r)
            throws Exception {
        return antwort(mvc.perform(r.with(authentifizierung(w))).andReturn());
    }

    private static org.springframework.test.web.servlet.request.RequestPostProcessor authentifizierung(Welt w) {
        Map<String, Object> c = new HashMap<>();
        c.put("sub", w.sub());
        c.put("preferred_username", w.sub());
        c.put("realm_access", Map.of("roles", List.of()));
        c.put("tenant_id", w.mandant().toString());
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), c);
        return authentication(new KeycloakRealmRoleConverter().convert(jwt));
    }

    private static Antwort antwort(MvcResult res) throws Exception {
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
