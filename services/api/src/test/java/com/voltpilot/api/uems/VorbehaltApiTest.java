package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.metrics.VorbehaltMetrik;
import com.voltpilot.api.repo.VorbehaltMetrikRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Angabe;
import com.voltpilot.api.uems.SteuerungsverbundAnteilDienst.Ergebnis;
import com.voltpilot.api.uems.SteuerungsverbundAnteilRepository.DokumentZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
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
 * Der Vorbehalt aus Messwerten (UEMS AP-15 IP-13, B4, W10, A20, R23) auf dem echten Weg: Tages-Höchstwerte der
 * Verbund-Bilanz → Lauf → Vorbehalt, Protokoll, Zeile → Zweischritt → GET, Admin-Freigabe und Zähler. Die Tage stehen
 * als Bilanz-Zeilen (wie IP-12 sie schreibt; dass eine unvollständige Viertelstunde dort nicht zählt, beweist
 * {@code VerbundBilanzApiTest#unvollstaendigeViertelstundeZaehltNichtFuerDenHoechstwert}).
 *
 * <p>Welt wie {@code SteuerungsverbundAnteilDienstTest}: AN-1 am Anschluss 550 kW, E-1 führt (Speicher 100 kW, Rückfall
 * 0), E-4 steuert mit (Ladepark 6 × 22 kW, Rückfall je 4,1), Vorbehalt erklärt 473 kW → E-4 77 kW am Bezug.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VorbehaltApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final LocalDate HEUTE = LocalDate.parse("2027-10-20");

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
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    /**
     * Der Draht im Test: jede Nutzlast je Topic. Die wirksamen Anteile kommen aus der echten Quelle (IP-17); ohne
     * Herzschlag-Block ist „alt“ das gesendete und quittierte Dokument.
     */
    @TestConfiguration
    static class Draht {
        static final List<Map.Entry<String, byte[]>> GESENDET = new ArrayList<>();

        @Bean
        VerbundAnteileVersand testVersand() {
            return (topic, nutzlast) -> {
                synchronized (GESENDET) {
                    GESENDET.add(Map.entry(topic, nutzlast));
                }
                return true;
            };
        }
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    SteuerungsverbundAnteilDienst dienst;
    @Autowired
    SteuerungsverbundRepository verbuende;
    @Autowired
    SteuerungsverbundAnteilRepository anteile;
    @Autowired
    GeraeteRueckfallDienst rueckfaelle;
    @Autowired
    VorbehaltDienst vorbehalt;
    @Autowired
    VorbehaltRepository zeilen;
    @Autowired
    VorbehaltMetrikRepository metrik;
    @Autowired
    ObjectMapper mapper;
    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private static final ProtokollAkteur BETREIBER = new ProtokollAkteur("sub-betrieb", "Betrieb",
            "voltpilot_betrieb", "voltpilot");

    private record Welt(UUID mandant, UUID anlage, UUID verbund, UUID e1, UUID e4) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void leer() {
        synchronized (Draht.GESENDET) {
            Draht.GESENDET.clear();
        }
    }

    @AfterEach
    void ohneMandant() {
        TenantContext.clear();
    }

    // ============================================================================ die Fälle der Zelle

    /** R23: 450 kW → 495 kW selbsttätig; der Ladepark (E-4) fällt von 77 auf 55 kW; Protokoll und Zähler. */
    @Test
    void r23ErhoehtSelbsttaetigVerengtImZweischrittMitProtokollUndZaehler() throws Exception {
        Welt w = scharf(ahrenberg("473"));
        assertThat(kw(letztes(w), Grenzart.BEZUG, w.e4())).isEqualByComparingTo("77.0");
        tage(w, "2027-09-20", "2027-10-18", "430");
        tage(w, "2027-10-19", "2027-10-19", "450");
        SimpleMeterRegistry reg = new SimpleMeterRegistry();
        VorbehaltMetrik zaehler = new VorbehaltMetrik(metrik, reg);
        zaehler.collect();
        assertThat(zaehlerstand(reg, w)).as("die Reihe steht vor der ersten Erhöhung auf 0").isZero();
        leer();

        assertThat(laeufer().lauf(HEUTE)).isGreaterThanOrEqualTo(1);

        TenantContext.set(w.mandant());
        SteuerungsverbundAnteilRepository.Vorbehalt vb = anteile.vorbehalt(w.verbund());
        assertThat(vb.kw().get(Grenzart.BEZUG)).isEqualByComparingTo("495.0");
        assertThat(vb.kw().get(Grenzart.EINSPEISUNG)).as("die Einspeiseseite bleibt erklärt").isEqualByComparingTo("0");
        assertThat(vb.von()).isEqualTo("Vorbehalt aus Messwerten");
        // der Zweischritt verengt: E-4 77 → 55 kW; nur verengen = schon der erste Schritt ist der Zielstand
        DokumentZeile d = letztes(w);
        assertThat(d.anlass()).isEqualTo("aendern");
        assertThat(d.epoche()).as("eine Änderung setzt keine neue Epoche").isEqualTo(1);
        assertThat(d.revision()).isEqualTo(3);
        assertThat(kw(d, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("55.0");
        assertThat(kw(d, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("0.0");
        assertThat(d.verengteBoxen()).containsExactly(w.e4().toString());
        assertThat(d.schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(topics()).as("an beide Boxen").hasSize(2);
        quittung(w, w.e4(), 1, 3);
        assertThat(root.queryForObject("SELECT quittiert_revision FROM steuerungsverbund_mitglied WHERE device_id = ?",
                Long.class, w.e4())).as("Quittung der verengten Box").isEqualTo(3);

        TenantContext.set(w.mandant());
        List<VorbehaltRepository.Zeile> z = zeilen.zeilen(w.verbund());
        assertThat(z).hasSize(1);
        assertThat(z.get(0).art()).isEqualTo("erhoeht");
        assertThat(z.get(0).zustand()).isEqualTo("wirksam");
        assertThat(z.get(0).altKw()).isEqualByComparingTo("473");
        assertThat(z.get(0).neuKw()).isEqualByComparingTo("495.0");
        assertThat(z.get(0).hoechstwertKw()).isEqualByComparingTo("450");
        assertThat(z.get(0).hoechstwertVon()).isEqualTo(Instant.parse("2027-10-19T10:00:00Z"));
        assertThat(z.get(0).zeitraumVon()).isEqualTo(LocalDate.parse("2026-10-20"));
        assertThat(z.get(0).zeitraumBis()).isEqualTo(LocalDate.parse("2027-10-19"));
        assertThat(z.get(0).messtage()).isEqualTo(30);
        assertThat(z.get(0).anteile()).isEqualTo("veroeffentlicht");

        Map<String, Object> p = root.queryForMap("SELECT alt::text AS alt, neu::text AS neu, grund, actor_name, "
                + "actor_art, actor_sub FROM steuerungsverbund_aenderung WHERE site_id = ? AND art = 'vorbehalt'",
                w.anlage());
        assertThat(p.get("grund")).isEqualTo(VorbehaltDienst.GRUND_ERHOEHT);
        assertThat(p.get("actor_name")).isEqualTo("Vorbehalt aus Messwerten");
        assertThat(p.get("actor_art")).isEqualTo("voltpilot");
        assertThat(p.get("actor_sub")).isNull();
        assertThat(MAPPER.readTree((String) p.get("alt")).path("kw").decimalValue()).isEqualByComparingTo("473");
        JsonNode neu = MAPPER.readTree((String) p.get("neu"));
        assertThat(neu.path("kw").decimalValue()).isEqualByComparingTo("495.0");
        assertThat(neu.path("hoechstwert_kw").decimalValue()).isEqualByComparingTo("450");
        assertThat(neu.path("herkunft").asText()).isEqualTo("gemessen");

        zaehler.collect();
        assertThat(zaehlerstand(reg, w)).isEqualTo(1d);

        JsonNode g = lesen(w).body();
        assertThat(g.path("vorbehalt").path("bezug").path("kw").decimalValue()).isEqualByComparingTo("495.0");
        assertThat(g.path("vorbehalt").path("bezug").path("herkunft").asText()).isEqualTo("gemessen");
        assertThat(g.path("vorbehalt").path("bezug").path("zweischritt").asText()).isEqualTo("veroeffentlicht");
        assertThat(g.path("vorbehalt").path("einspeisung").path("herkunft").asText()).isEqualTo("erklaert");
        assertThat(g.path("vorbehalt").path("vorschlag").isNull()).isTrue();

        // ein zweiter Lauf am selben Tag: die Messung verlangt nicht mehr — nichts Neues, kein Zählschritt
        leer();
        laeufer().lauf(HEUTE);
        TenantContext.set(w.mandant());
        assertThat(zeilen.zeilen(w.verbund())).hasSize(1);
        assertThat(topics()).isEmpty();
        zaehler.collect();
        assertThat(zaehlerstand(reg, w)).isEqualTo(1d);
    }

    /**
     * 430 kW → 473 kW: gegen erklärte 500 kW ist das eine SENKUNG — nur ein Vorschlag. Die Kundenroute kann nicht
     * senken (403 auf der Admin-Route, 400 für ein Vorbehalt-Feld im PUT); erst die Freigabe der Plattform-Rolle wirkt,
     * danach Zweischritt (erweitern: Übergang, Quittung, Ziel).
     */
    @Test
    void senkenBleibtVorschlagKundeKannNichtSenkenAdminFreigabeWirkt() throws Exception {
        Welt w = scharf(ahrenberg("500"));
        assertThat(kw(letztes(w), Grenzart.BEZUG, w.e4())).isEqualByComparingTo("50.0");
        tage(w, "2027-09-20", "2027-10-19", "430");
        SimpleMeterRegistry reg = new SimpleMeterRegistry();
        VorbehaltMetrik zaehler = new VorbehaltMetrik(metrik, reg);
        leer();

        laeufer().lauf(HEUTE);
        laeufer().lauf(HEUTE);

        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).as("senken wirkt nicht selbsttätig")
                .isEqualByComparingTo("500");
        List<VorbehaltRepository.Zeile> z = zeilen.zeilen(w.verbund());
        assertThat(z).as("ein zweiter Lauf legt denselben Vorschlag nicht noch einmal an").hasSize(1);
        assertThat(z.get(0).art()).isEqualTo("vorschlag");
        assertThat(z.get(0).zustand()).isEqualTo("offen");
        assertThat(z.get(0).neuKw()).isEqualByComparingTo("473.0");
        assertThat(topics()).isEmpty();
        assertThat(protokollVorbehalt(w)).isZero();
        zaehler.collect();
        assertThat(zaehlerstand(reg, w)).as("senken ist keine Erhöhung").isZero();

        JsonNode g = lesen(w).body();
        JsonNode v = g.path("vorbehalt").path("vorschlag");
        assertThat(v.path("alt_kw").decimalValue()).isEqualByComparingTo("500");
        assertThat(v.path("neu_kw").decimalValue()).isEqualByComparingTo("473.0");
        assertThat(v.path("hoechstwert_kw").decimalValue()).isEqualByComparingTo("430");
        assertThat(v.path("messtage").asInt()).isEqualTo(30);
        assertThat(v.path("zeitraum_bis").asText()).isEqualTo("2027-10-19");
        assertThat(g.path("vorbehalt").path("bezug").path("herkunft").asText()).isEqualTo("erklaert");

        String gs = "/api/v1/sites/" + w.anlage() + "/gemeinsame-steuerung";
        String freigabe = "/api/v1/admin/sites/" + w.anlage() + "/gemeinsame-steuerung/vorbehalt/freigeben";
        assertThat(kunde(w, post(freigabe)).status()).as("die Kundenroute kann nicht senken").isEqualTo(403);
        Antwort putMitVorbehalt = kunde(w, put(gs).content("{\"vorbehalt_bezug_kw\":473}"));
        assertThat(putMitVorbehalt.status()).isEqualTo(400);
        assertThat(putMitVorbehalt.body().path("code").asText()).isEqualTo("anfrage_ungueltig");
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).isEqualByComparingTo("500");

        Antwort frei = plattform(w, post(freigabe));
        assertThat(frei.status()).as(frei.body().toString()).isEqualTo(200);
        assertThat(frei.body().path("vorbehalt").path("bezug").path("kw").decimalValue())
                .isEqualByComparingTo("473.0");
        assertThat(frei.body().path("vorbehalt").path("bezug").path("herkunft").asText()).isEqualTo("gemessen");
        assertThat(frei.body().path("vorbehalt").path("vorschlag").isNull()).isTrue();
        TenantContext.set(w.mandant());
        assertThat(zeilen.zeilen(w.verbund()).get(0).zustand()).isEqualTo("freigegeben");
        assertThat(zeilen.zeilen(w.verbund()).get(0).entschiedenVon()).isEqualTo("VoltPilot Betrieb");
        Map<String, Object> p = root.queryForMap("SELECT grund, actor_name FROM steuerungsverbund_aenderung "
                + "WHERE site_id = ? AND art = 'vorbehalt'", w.anlage());
        assertThat(p.get("grund")).isEqualTo(VorbehaltDienst.GRUND_FREIGEGEBEN);
        assertThat(p.get("actor_name")).isEqualTo("VoltPilot Betrieb");
        // erweitern im Zweischritt: der Übergang hält E-4 noch auf 50, der Zielstand gibt 77 nach der Quittung
        DokumentZeile uebergang = letztes(w);
        assertThat(uebergang.schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(kw(uebergang, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("50.0");
        quittung(w, w.e1(), 1, uebergang.revision());
        quittung(w, w.e4(), 1, uebergang.revision());
        DokumentZeile ziel = letztes(w);
        assertThat(ziel.schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(kw(ziel, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("77.0");

        Antwort nochmal = plattform(w, post(freigabe));
        assertThat(nochmal.status()).isEqualTo(409);
        assertThat(nochmal.body().path("code").asText()).isEqualTo(GemeinsameSteuerungAbgelehnt.KEIN_VORSCHLAG);
        zaehler.collect();
        assertThat(zaehlerstand(reg, w)).isZero();
    }

    /**
     * Die Lücke verändert nichts; unter 30 Messtagen gilt der erklärte Wert weiter; 430 kW → 473 kW bestätigt ihn.
     */
    @Test
    void lueckeVeraendertNichtsUndUnter30MesstagenGiltDerErklaerteWert() throws Exception {
        Welt w = scharf(ahrenberg("473"));
        tage(w, "2027-09-30", "2027-10-19", "400");
        leer();

        laeufer().lauf(HEUTE);
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).as("20 Messtage: der erklärte Wert")
                .isEqualByComparingTo("473");
        assertThat(zeilen.zeilen(w.verbund())).as("kein Vorschlag vor 30 Messtagen").isEmpty();

        tage(w, "2027-09-20", "2027-09-29", null);
        laeufer().lauf(HEUTE);
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).as("zehn Lückentage zählen nicht")
                .isEqualByComparingTo("473");
        assertThat(zeilen.zeilen(w.verbund())).isEmpty();

        tage(w, "2027-09-01", "2027-09-10", "430");
        assertThat(vorbehalt.pruefen(w.anlage(), HEUTE).orElseThrow().urteil().neuKw()).as("430 kW → 473 kW")
                .isEqualByComparingTo("473.0");
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).isEqualByComparingTo("473");
        assertThat(zeilen.zeilen(w.verbund())).as("unverändert: keine Zeile").isEmpty();
        assertThat(topics()).isEmpty();
        assertThat(protokollVorbehalt(w)).isZero();
    }

    /**
     * Passt die Auslegung mit dem erhöhten Vorbehalt nicht mehr, wird NICHTS erweitert: der Vorbehalt steht erhöht,
     * die Boxen halten ihr letztes Dokument (E-4 77 kW), die Zeile sagt warum, der Zähler zählt — das ist der Alarm.
     */
    @Test
    void auslegungPasstNichtMehrErweitertNichtsUndZaehlt() throws Exception {
        Welt w = scharf(ahrenberg("473"));
        tage(w, "2027-09-20", "2027-10-19", "510");
        long vorher = dokumente(w);
        SimpleMeterRegistry reg = new SimpleMeterRegistry();
        VorbehaltMetrik zaehler = new VorbehaltMetrik(metrik, reg);
        leer();

        laeufer().lauf(HEUTE);

        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).isEqualByComparingTo("561.0");
        assertThat(zeilen.zeilen(w.verbund()).get(0).anteile()).isEqualTo("auslegung_passt_nicht");
        assertThat(dokumente(w)).as("kein neues Dokument").isEqualTo(vorher);
        assertThat(kw(letztes(w), Grenzart.BEZUG, w.e4())).isEqualByComparingTo("77.0");
        assertThat(topics()).isEmpty();
        zaehler.collect();
        assertThat(zaehlerstand(reg, w)).isEqualTo(1d);
        JsonNode g = lesen(w).body();
        assertThat(g.path("vorbehalt").path("bezug").path("zweischritt").asText()).isEqualTo("auslegung_passt_nicht");
    }

    /** Läuft beim Erhöhen noch ein Zweischritt, holt der nächste Lauf die Verengung nach. */
    @Test
    void laufenderZweischrittWirdNachgeholt() throws Exception {
        Welt w = ahrenberg("473");
        TenantContext.set(w.mandant());
        assertThat(dienst.anteileScharfschalten(w.anlage(), BETREIBER).veroeffentlicht()).isTrue();
        tage(w, "2027-09-20", "2027-10-19", "450");

        laeufer().lauf(HEUTE);
        TenantContext.set(w.mandant());
        assertThat(zeilen.zeilen(w.verbund()).get(0).anteile()).isEqualTo("zweischritt_laeuft");

        quittung(w, w.e1(), 1, 1);
        quittung(w, w.e1(), 1, 2);
        quittung(w, w.e4(), 1, 2);
        laeufer().lauf(HEUTE);
        TenantContext.set(w.mandant());
        assertThat(zeilen.zeilen(w.verbund()).get(0).anteile()).isEqualTo("veroeffentlicht");
        assertThat(kw(letztes(w), Grenzart.BEZUG, w.e4())).isEqualByComparingTo("55.0");
    }

    /** Eine Anlage ohne Gemeinsame Steuerung: kein Lauf, keine Zeile, keine Metrik-Reihe, keine Auskunft. */
    @Test
    void ohneGemeinsameSteuerungKeinLaufKeineZeileKeineReihe() throws Exception {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Ohne Verbund') RETURNING id", UUID.class);
        UUID an = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle') RETURNING id",
                UUID.class, t);

        laeufer().lauf(HEUTE);

        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_vorbehalt WHERE tenant_id = ?",
                Long.class, t)).isZero();
        assertThat(metrik.staende()).noneMatch(s -> s.tenantId().equals(t));
        SimpleMeterRegistry reg = new SimpleMeterRegistry();
        new VorbehaltMetrik(metrik, reg).collect();
        assertThat(reg.find(VorbehaltMetrik.ERHOEHT).tags("tenant", t.toString()).functionCounters()).isEmpty();
        Antwort g = lesen(new Welt(t, an, null, null, null));
        assertThat(g.body().path("eingerichtet").asBoolean()).isFalse();
        assertThat(g.body().path("vorbehalt").isNull()).isTrue();
    }

    @Test
    void rlsForceEngeRechteUndOffboarding() throws Exception {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'steuerungsverbund_vorbehalt'", Boolean.class)).isTrue();
        assertThat(recht(APP_USER, "DELETE")).isFalse();
        assertThat(recht(APP_USER, "INSERT")).isTrue();
        assertThat(Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, "
                + "'steuerungsverbund_vorbehalt', 'neu_kw', 'UPDATE')", Boolean.class, APP_USER)))
                .as("Zahl und Herkunft ändert niemand").isFalse();

        Welt w = scharf(ahrenberg("500"));
        Welt fremd = ahrenberg("500");
        tage(w, "2027-09-20", "2027-10-19", "430");
        laeufer().lauf(HEUTE);
        TenantContext.set(fremd.mandant());
        assertThat(zeilen.zeilen(w.verbund())).as("RLS: fremde Zeilen sind unsichtbar").isEmpty();
        TenantContext.clear();
        new com.voltpilot.api.repo.TenantRepository(new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW))).offboard(w.mandant());
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_vorbehalt WHERE tenant_id = ?",
                Long.class, w.mandant())).isZero();
    }

    // ============================================================================ der Viertelstunden-Takt (IP-13 Folge)

    /** Die Viertelstunde, in der das Ungeregelte auf 450 kW steigt (10:00–10:15 Europe/Berlin, R23 Schritt 1). */
    private static final Instant Q450 = Instant.parse("2027-10-20T08:00:00Z");

    /**
     * R23 als Ablauf mit gespeicherten Viertelstunden (AP-08) und dem Baustein der Bilanz: gestern und heute bis 10:00
     * 430 kW Ungeregeltes (Netzpunkt 507 kW − Ladepark 77 kW), 10:00–10:15 steigt es auf 450 kW (Netzpunkt 527 kW).
     * Nach der ERSTEN vollständigen Viertelstunde verengt der Takt: 10:15 Ende der Viertelstunde, 10:25 reif und
     * geprüft — Vorbehalt 495 kW, Zweischritt, E-4 77 → 55 kW. Eine noch laufende Viertelstunde (10:15–10:30, schon
     * mit 480 kW verdichtet) zählt nicht; zweimal derselbe Takt tut nichts doppelt.
     */
    @Test
    void taktR23ErhoehtNachDerErstenVollstaendigenViertelstunde() throws Exception {
        Gemessen g = gemessen("473");
        Welt w = scharf(g.welt());
        assertThat(kw(letztes(w), Grenzart.BEZUG, w.e4())).isEqualByComparingTo("77.0");
        viertelstunde(g.netz(), Q450, "131.75");
        viertelstunde(g.abgang(), Q450, "19.25");
        // die laufende Viertelstunde 10:15–10:30 mit 480 kW (Netzpunkt 557 kW): noch nicht reif
        viertelstunde(g.netz(), Q450.plusSeconds(900), "139.25");
        viertelstunde(g.abgang(), Q450.plusSeconds(900), "19.25");
        SimpleMeterRegistry reg = new SimpleMeterRegistry();
        VorbehaltMetrik zaehler = new VorbehaltMetrik(metrik, reg);
        zaehler.collect();
        leer();

        // 10:24:59 — die Viertelstunde 10:00–10:15 ist noch nicht reif (Verdichtung): nichts
        assertThat(takt().lauf(Instant.parse("2027-10-20T08:24:59Z"))).isZero();
        TenantContext.set(w.mandant());
        assertThat(zeilen.zeilen(w.verbund())).isEmpty();
        assertThat(topics()).isEmpty();

        // 10:25 — reif: 450 × 1,1 = 495 kW > 473 kW
        assertThat(takt().lauf(Instant.parse("2027-10-20T08:25:00Z"))).isEqualTo(1);
        TenantContext.set(w.mandant());
        SteuerungsverbundAnteilRepository.Vorbehalt vb = anteile.vorbehalt(w.verbund());
        assertThat(vb.kw().get(Grenzart.BEZUG)).as("aus 450 kW, nicht aus der laufenden 480")
                .isEqualByComparingTo("495.0");
        assertThat(vb.kw().get(Grenzart.EINSPEISUNG)).isEqualByComparingTo("0");
        assertThat(vb.von()).isEqualTo("Vorbehalt aus Messwerten");
        DokumentZeile d = letztes(w);
        assertThat(d.anlass()).isEqualTo("aendern");
        assertThat(kw(d, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("55.0");
        assertThat(kw(d, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("0.0");
        assertThat(d.verengteBoxen()).containsExactly(w.e4().toString());
        assertThat(d.schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(topics()).as("an beide Boxen, im selben Takt").hasSize(2);

        TenantContext.set(w.mandant());
        List<VorbehaltRepository.Zeile> z = zeilen.zeilen(w.verbund());
        assertThat(z).hasSize(1);
        assertThat(z.get(0).art()).isEqualTo("erhoeht");
        assertThat(z.get(0).zustand()).isEqualTo("wirksam");
        assertThat(z.get(0).altKw()).isEqualByComparingTo("473");
        assertThat(z.get(0).hoechstwertKw()).isEqualByComparingTo("450");
        assertThat(z.get(0).hoechstwertVon()).isEqualTo(Q450);
        assertThat(z.get(0).zeitraumVon()).isEqualTo(LocalDate.parse("2027-10-19"));
        assertThat(z.get(0).zeitraumBis()).isEqualTo(LocalDate.parse("2027-10-20"));
        assertThat(z.get(0).messtage()).isEqualTo(2);
        assertThat(z.get(0).anteile()).isEqualTo("veroeffentlicht");
        Map<String, Object> p = root.queryForMap("SELECT neu::text AS neu, grund FROM steuerungsverbund_aenderung "
                + "WHERE site_id = ? AND art = 'vorbehalt'", w.anlage());
        assertThat(p.get("grund")).isEqualTo(VorbehaltDienst.GRUND_ERHOEHT);
        JsonNode neu = MAPPER.readTree((String) p.get("neu"));
        assertThat(neu.path("pruefung").asText()).isEqualTo("viertelstunde");
        assertThat(neu.path("hoechstwert_von").asText()).isEqualTo(Q450.toString());
        zaehler.collect();
        assertThat(zaehlerstand(reg, w)).isEqualTo(1d);

        // zweimal derselbe Takt — und der nächste: die Messung verlangt nicht mehr, nichts doppelt
        leer();
        assertThat(takt().lauf(Instant.parse("2027-10-20T08:25:00Z"))).isZero();
        assertThat(takt().lauf(Instant.parse("2027-10-20T08:40:00Z"))).as("jetzt mit der 480er Viertelstunde")
                .isEqualTo(1);
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG))
                .as("B4: die nächste reife Viertelstunde bringt 480 kW — 528 kW > 495 kW, wieder selbsttätig")
                .isEqualByComparingTo("528.0");
        assertThat(zeilen.zeilen(w.verbund()).get(0).anteile())
                .as("550 − 528 = 22 kW reichen nicht für die Rückfälle der Wallboxen (6 × 4,1 kW): nichts erweitert")
                .isEqualTo("auslegung_passt_nicht");
        leer();
        assertThat(takt().lauf(Instant.parse("2027-10-20T08:40:00Z"))).isZero();
        TenantContext.set(w.mandant());
        assertThat(zeilen.zeilen(w.verbund())).hasSize(2);
        assertThat(topics()).isEmpty();
        assertThat(protokollVorbehalt(w)).isEqualTo(2);
    }

    /**
     * Eine unvollständige Viertelstunde verändert nichts (B5); kommt sie vollständig nach (Nachlieferung, AP-07: der
     * Verdichter bildet die Zeile neu), zählt sie im nächsten Takt — ohne dass jemand sie anstoßen muss.
     */
    @Test
    void taktUnvollstaendigeViertelstundeNichtsSpaetankunftWirdNachgeholt() throws Exception {
        Gemessen g = gemessen("473");
        Welt w = scharf(g.welt());
        viertelstunde(g.netz(), Q450, "131.75");
        viertelstunde(g.abgang(), Q450, "19.25");
        assertThat(root.update("UPDATE messreihe_viertelstunde SET menge_zustand = 'unvollständig', erhalten = 9 "
                + "WHERE entity_id = ? AND intervall_beginn = ?", g.abgang(), Timestamp.from(Q450))).isEqualTo(1);
        leer();

        assertThat(takt().lauf(Instant.parse("2027-10-20T08:25:00Z"))).isZero();
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).isEqualByComparingTo("473");
        assertThat(zeilen.zeilen(w.verbund())).isEmpty();
        assertThat(topics()).isEmpty();
        assertThat(protokollVorbehalt(w)).isZero();

        // Spätankunft: die Werte der Box kommen nach, die Viertelstunde ist jetzt vollständig
        assertThat(root.update("UPDATE messreihe_viertelstunde SET menge_zustand = 'vollständig', erhalten = 15, "
                + "n_nachgeliefert = 6, zustellart = 'gemischt' WHERE entity_id = ? AND intervall_beginn = ?", g.abgang(),
                Timestamp.from(Q450))).isEqualTo(1);
        assertThat(takt().lauf(Instant.parse("2027-10-20T13:10:00Z"))).isEqualTo(1);
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).isEqualByComparingTo("495.0");
        assertThat(zeilen.zeilen(w.verbund()).get(0).hoechstwertVon()).isEqualTo(Q450);
        assertThat(kw(letztes(w), Grenzart.BEZUG, w.e4())).isEqualByComparingTo("55.0");
    }

    /**
     * Der Takt senkt nie — nicht einmal als Vorschlag: gegen erklärte 500 kW verlangen 430 kW nur 473 kW. Das bleibt dem
     * Tageslauf (mit 30 Messtagen und Freigabe).
     */
    @Test
    void taktSchlaegtNieEtwasZumSenkenVor() throws Exception {
        Gemessen g = gemessen("500");
        Welt w = scharf(g.welt());
        long vorher = dokumente(w);
        leer();

        assertThat(takt().lauf(Instant.parse("2027-10-20T08:25:00Z"))).isZero();

        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).isEqualByComparingTo("500");
        assertThat(zeilen.zeilen(w.verbund())).isEmpty();
        assertThat(dokumente(w)).isEqualTo(vorher);
        assertThat(topics()).isEmpty();
        assertThat(protokollVorbehalt(w)).isZero();
    }

    /** Ohne Gemeinsame Steuerung: der Takt findet keine Anlage, schreibt keine Zeile. */
    @Test
    void taktOhneGemeinsameSteuerungKeineZeile() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Ohne Verbund, Takt') RETURNING id",
                UUID.class);
        root.update("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle')", t);

        takt().lauf(Instant.parse("2027-10-20T08:25:00Z"));

        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_vorbehalt WHERE tenant_id = ?",
                Long.class, t)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_aenderung WHERE tenant_id = ?",
                Long.class, t)).isZero();
    }

    // ============================================================================ Gerüst

    private VorbehaltLaeufer laeufer() {
        return new VorbehaltLaeufer(admin, vorbehalt);
    }

    private VorbehaltViertelstundeLaeufer takt() {
        return new VorbehaltViertelstundeLaeufer(admin, vorbehalt);
    }

    private record Gemessen(Welt welt, UUID netz, UUID abgang) {}

    /**
     * Wie {@link #ahrenberg}, aber gemessen: E-4 steuert mit über DQ-10 (Abgangszähler Ladepark), am Netzpunkt DQ-2 der
     * Hauptzähler; gestern und heute bis 10:00 Europe/Berlin vollständige Viertelstunden — Netzpunkt 507 kW Bezug
     * (126,75 kWh), Ladepark 77 kW Bezug (19,25 kWh), also 430 kW Ungeregeltes.
     */
    private Gemessen gemessen(String vorbehaltKw) {
        Welt w = ahrenberg(vorbehaltKw, true);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", w.mandant());
        UUID dq2 = root.queryForObject("SELECT data_source_id FROM steuerungsverbund_mitglied WHERE device_id = ?",
                UUID.class, w.e1());
        UUID dq10 = root.queryForObject("SELECT data_source_id FROM steuerungsverbund_mitglied WHERE device_id = ?",
                UUID.class, w.e4());
        UUID netz = messstelle(w, w.e1(), dq2, "MS-NZ", "126.75");
        UUID abgang = messstelle(w, w.e4(), dq10, "MS-LP", "19.25");
        return new Gemessen(w, netz, abgang);
    }

    /** Komponente an Box und Quelle, Mess-Selektion, Messstelle Wirkenergie Bezug, vollständige Viertelstunden. */
    private static UUID messstelle(Welt w, UUID box, UUID quelle, String kennzeichen, String kwh) {
        String kanal = "sunspec.model_203.totwhimp";
        String k = kennzeichen + "-" + NR.get();
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, data_source_id, communication, connection_json, created_at) VALUES (?, ?, "
                + "'modbus-generic', ?, 'modbus-generic', ?, ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, "
                + "'2020-01-01T00:00:00Z') RETURNING id", UUID.class, w.mandant(), w.anlage(), "Zähler " + k, box,
                quelle);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), '2026.09.11.1', "
                + "'test', 'pending_edge', 'energy_counter', 'fifteen_minute')", w.mandant(), w.anlage(), box,
                komponente, kanal);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, w.mandant(), k, "Zähler " + k);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, "
                + "actor_art) VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',"
                + "'2027-01-01T00:00:00Z',false,'2027-01-01T00:01:00Z','test','voltpilot')", w.mandant(), ms,
                komponente, geraet, kanal);
        // gestern (Europe/Berlin, 2027-10-19) ganz und heute bis 10:00 — 136 Viertelstunden
        assertThat(root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, entity_id, "
                + "messkanal, erhalten, erwartet, kadenz_s, kadenz_herkunft, endgueltig_ab, wertart, menge, "
                + "menge_zustand) SELECT q, ?, ?, ?, 15, 15, 60, 'auswahl', q + interval '10095 minutes', 'counter', "
                + "?::numeric, 'vollständig' FROM generate_series(TIMESTAMPTZ '2027-10-18T22:00:00Z', "
                + "TIMESTAMPTZ '2027-10-20T07:45:00Z', interval '15 minutes') AS q", w.mandant(), komponente, kanal,
                kwh)).isEqualTo(136);
        return komponente;
    }

    /** Eine weitere vollständige Viertelstunde (oder eine vorhandene überschrieben) mit {@code kwh}. */
    private static void viertelstunde(UUID komponente, Instant beginn, String kwh) {
        root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, entity_id, messkanal, erhalten, "
                + "erwartet, kadenz_s, kadenz_herkunft, endgueltig_ab, wertart, menge, menge_zustand) SELECT ?, "
                + "tenant_id, entity_id, messkanal, 15, 15, 60, 'auswahl', ?::timestamptz + interval '10095 minutes', "
                + "'counter', ?::numeric, 'vollständig' FROM messreihe_viertelstunde WHERE entity_id = ? LIMIT 1 "
                + "ON CONFLICT DO NOTHING", Timestamp.from(beginn), Timestamp.from(beginn), kwh, komponente);
        root.update("UPDATE messreihe_viertelstunde SET menge = ?::numeric WHERE entity_id = ? "
                + "AND intervall_beginn = ?", kwh, komponente, Timestamp.from(beginn));
    }

    private Welt ahrenberg(String vorbehaltKw) {
        return ahrenberg(vorbehaltKw, false);
    }

    /** AN-1 mit E-1 (führt) und E-4 (steuert mit), Stufe S1, erklärter Vorbehalt der Bezugsseite. */
    private Welt ahrenberg(String vorbehaltKw, boolean e4MitMesspunkt) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Ahrenberg Vorbehalt #" + nr);
        UUID an = root.queryForObject("INSERT INTO site (tenant_id, name, max_feed_in_kw) VALUES (?, 'Halle 1', 100) "
                + "RETURNING id", UUID.class, t);
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw) VALUES (?, ?, 550)", an, t);
        UUID e1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an, "vb-e1-" + nr);
        UUID e4 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an, "vb-e4-" + nr);
        UUID dq2 = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-2', 'modbus_tcp', ?, '{1}', 10) RETURNING id", UUID.class,
                t, an, "10.1." + nr + ".2:502");
        UUID dq10 = !e4MitMesspunkt ? null : root.queryForObject("INSERT INTO data_source (tenant_id, site_id, "
                + "kennzeichen, protokoll, adresse, geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-10', 'modbus_tcp', ?, "
                + "'{1}', 10) RETURNING id", UUID.class, t, an, "10.1." + nr + ".10:502");
        TenantContext.set(t);
        UUID v = verbuende.einrichten(t, an, "test");
        verbuende.stufeSetzen(v, Stufe.BEOBACHTET);
        Instant ab = Instant.parse("2026-01-01T00:00:00Z");
        verbuende.mitgliedAufnehmen(t, v, e1, Rolle.FUEHRT, dq2, ab, null, "test");
        verbuende.mitgliedAufnehmen(t, v, e4, Rolle.STEUERT_MIT, dq10, ab, null, "test");
        Welt w = new Welt(t, an, v, e1, e4);
        anteile.vorbehaltSetzen(v, BigDecimal.ZERO, new BigDecimal(vorbehaltKw), "betreiber@voltpilot.test");
        geraet(w, e1, "pv-generation", Grenzart.EINSPEISUNG, "100", "40");
        geraet(w, e1, "battery-hybrid", Grenzart.BEZUG, "100", "0");
        geraet(w, e4, "pv-generation", Grenzart.EINSPEISUNG, "60", null);
        for (int i = 0; i < 6; i++) {
            geraet(w, e4, "wallbox", Grenzart.BEZUG, "22", "4.1");
        }
        TenantContext.clear();
        return w;
    }

    /** Scharf (LA2) und beide Schritte quittiert: das Zieldokument ist in Kraft. */
    private Welt scharf(Welt w) throws Exception {
        TenantContext.set(w.mandant());
        Ergebnis s1 = dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        assertThat(s1.veroeffentlicht()).isTrue();
        quittung(w, w.e1(), 1, 1);
        quittung(w, w.e1(), 1, 2);
        quittung(w, w.e4(), 1, 2);
        assertThat(letztes(w).schritt()).isEqualTo(Schritt.ZIEL);
        return w;
    }

    private void geraet(Welt w, UUID box, String rolle, Grenzart richtung, String nenn, String rueckfall) {
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, created_at) "
                + "VALUES (?, ?, ?, '2026-01-01T00:00:00Z') RETURNING id", UUID.class, w.mandant(), w.anlage(), rolle);
        anteile.geraetEintragen(w.mandant(), w.verbund(), box, k, richtung, new BigDecimal(nenn), true, null, "test");
        if (rueckfall != null) {
            rueckfaelle.hinterlegen(k, richtung, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal(rueckfall),
                    60), null, "installateur@ahrenberg.test");
        }
    }

    /**
     * Tage der Verbund-Bilanz, wie IP-12 sie schreibt: mit Höchstwert {@code kw} (10:00 UTC) — oder, ohne ihn, als
     * Lücke (unbekannt, keine belegte Viertelstunde).
     */
    private static void tage(Welt w, String von, String bis, String kw) {
        boolean luecke = kw == null;
        root.update("INSERT INTO steuerungsverbund_bilanz (tenant_id, site_id, steuerungsverbund_id, tag, zustand, "
                + "grund, viertelstunden_erwartet, viertelstunden_plausibel, viertelstunden_unplausibel, "
                + "viertelstunden_unbekannt, grundlage, stufe_vorher, gerechnet_von, hoechstes_ungeregeltes_kw, "
                + "hoechstes_von) SELECT ?, ?, ?, d::date, ?, ?, 96, ?, 0, ?, '{}'::jsonb, 'anteile_aktiv', "
                + "'Verbund-Bilanz', ?::numeric, CASE WHEN ? THEN NULL ELSE d + interval '10 hours' END "
                + "FROM generate_series(?::timestamptz, ?::timestamptz, interval '1 day') AS d",
                w.mandant(), w.anlage(), w.verbund(), luecke ? "unbekannt" : "plausibel", luecke ? "luecke" : null,
                luecke ? 0 : 96, luecke ? 96 : 0, kw, luecke, von + "T00:00:00Z", bis + "T00:00:00Z");
    }

    private void quittung(Welt w, UUID box, long epoche, long revision) {
        VerbundAnteileResultListener listener = new VerbundAnteileResultListener("tcp://nie:1883", "", "", dienst,
                mapper);
        TenantContext.clear();
        byte[] nutzlast = ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + w.mandant() + "\",\"site_id\":\""
                + w.anlage() + "\",\"device_id\":\"" + box + "\",\"epoche\":" + epoche + ",\"revision\":" + revision
                + ",\"urteil\":\"angenommen\",\"ts\":\"2027-10-20T09:00:05Z\"}").getBytes(StandardCharsets.UTF_8);
        assertThat(listener.handle(VerbundAnteileDokument.resultTopic(w.mandant(), w.anlage(), box), nutzlast,
                Instant.now())).isTrue();
    }

    private DokumentZeile letztes(Welt w) {
        TenantContext.set(w.mandant());
        return anteile.dokumente(w.verbund()).get(0);
    }

    private long dokumente(Welt w) {
        TenantContext.set(w.mandant());
        return anteile.dokumente(w.verbund()).size();
    }

    private static BigDecimal kw(DokumentZeile d, Grenzart r, UUID box) {
        return d.tabelle().anteile().get(r).get(box.toString());
    }

    private static long protokollVorbehalt(Welt w) {
        return root.queryForObject("SELECT count(*) FROM steuerungsverbund_aenderung WHERE site_id = ? "
                + "AND art = 'vorbehalt'", Long.class, w.anlage());
    }

    private static double zaehlerstand(SimpleMeterRegistry reg, Welt w) {
        return reg.get(VorbehaltMetrik.ERHOEHT).tags("tenant", w.mandant().toString(), "site", w.anlage().toString())
                .functionCounter().count();
    }

    private List<String> topics() {
        synchronized (Draht.GESENDET) {
            return Draht.GESENDET.stream().map(Map.Entry::getKey).toList();
        }
    }

    private static boolean recht(String rolle, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, 'steuerungsverbund_vorbehalt', "
                + "?)", Boolean.class, rolle, recht));
    }

    private record Antwort(int status, JsonNode body) {}

    private Antwort lesen(Welt w) throws Exception {
        return kunde(w, get("/api/v1/sites/" + w.anlage() + "/gemeinsame-steuerung"));
    }

    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        })));
    }

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
