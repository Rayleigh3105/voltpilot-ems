package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.VerteilungAbgelehnt.Ablehnung;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
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
 * Die Verteilungs-Schnittstelle (UEMS AP-10 IP-8) gegen die echte Kette: {@code PUT/GET
 * /api/v1/messstellen/{id}/verteilung}, die Kostenstellen aus AP-10 IP-7 und der Leseweg des Formel-Terms. Die
 * Kennzeichen, Anteile und Tage stammen aus dem Referenzunternehmen (F10, F12, F13).
 *
 * <ul>
 *   <li>F10/F13: ein Satz mit ZWEI Zielen in EINER Transaktion — der Wechsel 70/30 → 60/40 geht nur durch, weil
 *       die Datenbank die 100 % zur Commit-Zeit prüft ({@code UemsMessstelleVerteilungMigrationTest} zeigt,
 *       dass dieselbe Folge sofort geprüft scheitert); GENAU EIN Protokolleintrag, GENAU EIN Ereignis;</li>
 *   <li>F10: 90 % sind 422 {@code verteilung_summe}, und nichts wird geschrieben;</li>
 *   <li>F12: der Anteil endet mit seiner Kostenstelle, danach „nicht verteilt“ — nie 0 %;</li>
 *   <li>E12: der Januar je Ziel ist die Summe der Tagesanteile (10 000 / 5 500 kWh), gelesen über die EINE
 *       Stelle {@link AnteilLeseweg#lies};</li>
 *   <li>Korrektur am selben Tag, leerer Satz, Wiederholung, Mandantenzaun, strenge Anfrage.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VerteilungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String KST = "/api/v1/unternehmen/kostenstellen";

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
    AnteilLeseweg leseweg;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID messstelle, String kennzeichen) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ======================================================== F10 + F13: zwei Ziele, eine Transaktion

    @Test
    void einSatzMitZweiZielenInEinerTransaktionUndDerWechselMittenImMonat() throws Exception {
        Welt w = welt();
        UUID k4100 = kostenstelle(w, "4100", "Spritzguss", "2026-10-01", null);
        UUID k4200 = kostenstelle(w, "4200", "Montage", "2026-10-01", null);

        // F10: MS-07 fest 70 % an 4100, 30 % an 4200 — beide Zeilen in EINER Anfrage.
        Antwort erst = ok(ruf(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "70", k4200, "30")), 200);
        assertThat(anteile(erst)).containsExactly("4100=70 2026-10-01..offen", "4200=30 2026-10-01..offen");
        Antwort amTag = ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2026-10-01", null), 200);
        assertThat(amTag.body().get("zustand").asText()).isEqualTo("verteilt");
        Antwort davor = ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2026-09-30", null), 200);
        assertThat(davor.body().get("zustand").asText()).as("nie „zu 0 % verteilt“").isEqualTo("nicht verteilt");
        assertThat(davor.body().get("anteile")).isEmpty();

        // F13: ab dem 15.01.2027 60/40 — die laufende endet am 14.01. Zwei Ziele, vier Zeilen, EINE Transaktion;
        // zwischen den Anweisungen ist es nie 100 %, am Commit genau.
        Antwort wechsel = ok(ruf(w, HttpMethod.PUT, pfad(w), satz("2027-01-15", false, k4100, "60", k4200, "40")), 200);
        assertThat(anteile(wechsel)).containsExactly("4100=70 2026-10-01..2027-01-14", "4200=30 2026-10-01..2027-01-14",
                "4100=60 2027-01-15..offen", "4200=40 2027-01-15..offen");
        assertThat(anteile(ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2027-01-14", null), 200)))
                .containsExactly("4100=70 2026-10-01..2027-01-14", "4200=30 2026-10-01..2027-01-14");

        // GENAU EIN Protokolleintrag und GENAU EIN Ereignis je Schreibvorgang.
        assertThat(root.queryForList("SELECT art || ' ' || to_char(gilt_ab AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') "
                + "FROM messstelle_aenderung WHERE messstelle_id = ? ORDER BY id", String.class, w.messstelle()))
                .containsExactly("verteilung_geaendert 2026-10-01 00:00", "verteilung_geaendert 2027-01-15 00:00");
        assertThat(root.queryForObject("SELECT neu::text FROM messstelle_aenderung WHERE messstelle_id = ? ORDER BY id "
                + "DESC LIMIT 1", String.class, w.messstelle())).contains("\"kostenstelle\": \"4100\"")
                .contains("\"anteil_prozent\": \"60\"");
        assertThat(root.queryForList("SELECT to_char(zeit AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') || ' ' || urheber "
                + "|| ' ' || (kennungen->>'messstelle') || ' ' || ((nutzlast->>'eingetragen_am') IS NOT NULL) FROM messreihe_ereignis "
                + "WHERE tenant_id = ? AND art = 'verteilung_geaendert' ORDER BY eingang, zeit", String.class, w.mandant()))
                .containsExactly("2026-09-30T22:00 kunde " + w.kennzeichen() + " true",
                        "2027-01-14T23:00 kunde " + w.kennzeichen() + " true");
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? AND messstelle_id = ? "
                + "AND art = 'verteilung_geaendert'", Long.class, w.mandant(), w.messstelle())).isEqualTo(2);

        // E12: der Januar je Ziel ist die Summe der Tagesanteile — über DIE EINE Stelle des Formel-Terms.
        assertThat(januar(w, k4100)).isEqualByComparingTo("10000");
        assertThat(januar(w, k4200)).isEqualByComparingTo("5500");

        // Derselbe Satz noch einmal: nichts — keine Zeile, kein Protokoll, kein Ereignis.
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        ok(ruf(w, HttpMethod.PUT, pfad(w), satz("2027-01-15", false, k4100, "60", k4200, "40")), 200);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    /**
     * Rückwirkend ist erlaubt, aber nie unsichtbar: am 20.01.2027 ab dem 15.01. eingetragen trägt der Protokolleintrag
     * sein Abzeichen — hier relativ zu heute, weil die Datenbank „gilt ab vor dem Eintrag“ gegen ihre eigene Uhr hält.
     */
    @Test
    void eineRueckwirkendeVerteilungTraegtIhrAbzeichen() throws Exception {
        Welt w = welt();
        UUID k4100 = kostenstelle(w, "4100", "Spritzguss", "2026-01-01", null);
        UUID k4200 = kostenstelle(w, "4200", "Montage", "2026-01-01", null);
        LocalDate vorFuenfTagen = LocalDate.now(java.time.ZoneId.of("Europe/Berlin")).minusDays(5);
        ok(ruf(w, HttpMethod.PUT, pfad(w), satz(vorFuenfTagen.toString(), false, k4100, "70", k4200, "30")), 200);
        assertThat(root.queryForObject("SELECT rueckwirkend FROM messstelle_aenderung WHERE messstelle_id = ?",
                Boolean.class, w.messstelle())).isTrue();
    }

    // ============================================================================ F10: 90 % → 422

    @Test
    void neunzigProzentSindEinFehlerUndNichtsWirdGeschrieben() throws Exception {
        Welt w = welt();
        UUID k4100 = kostenstelle(w, "4100", "Spritzguss", "2026-10-01", null);
        UUID k4200 = kostenstelle(w, "4200", "Montage", "2026-10-01", null);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        Antwort neunzig = abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "60", k4200, "30"),
                "verteilung_summe");
        assertThat(neunzig.body().get("summe").asText()).isEqualTo("90");
        assertThat(neunzig.body().get("tag").asText()).isEqualTo("2026-10-01");
        assertThat(abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "70", k4200, "40"),
                "verteilung_summe").body().get("summe").asText()).as("110 % nie still normiert").isEqualTo("110");
        Antwort gerundet = abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "33.33", k4200, "66.67"),
                "anteil_ungueltig");
        assertThat(gerundet.body().get("kennzeichen").asText()).isEqualTo("4100");
        abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "100", k4200, "0"), "anteil_ungueltig");
        abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-09-30", false, k4100, "70", k4200, "30"), "ziel_besteht_nicht");
        abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "70", UUID.randomUUID(), "30"),
                "kostenstelle_unbekannt");
        assertThat(abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "70", k4100, "30"),
                "anfrage_ungueltig").body().get("feld").asText()).isEqualTo("zeilen[].kostenstelle_id");
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("keine Zeile, kein Protokoll, kein Ereignis").isEmpty();
    }

    // ================================================================= F12: Ziel endet → Zeile endet

    @Test
    void einAnteilEndetMitSeinerKostenstelleDanachNichtVerteilt() throws Exception {
        Welt w = welt();
        UUID k9000 = kostenstelle(w, "9000", "Infrastruktur", "2026-10-01", "2026-12-31");
        UUID k9100 = kostenstelle(w, "9100", "Verwaltung", "2026-10-01", null);
        UUID k9010 = kostenstelle(w, "9010", "Druckluft", "2027-01-01", null);
        UUID k9020 = kostenstelle(w, "9020", "Kühlung", "2027-01-01", null);

        Antwort pv = ok(ruf(w, HttpMethod.PUT, pfad(w), satz1("2026-10-01", k9000, "100")), 200);
        assertThat(anteile(pv)).containsExactly("9000=100 2026-10-01..2026-12-31");
        assertThat(pv.body().at("/anteile/0/endet_mit_kostenstelle").asBoolean()).isTrue();
        assertThat(ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2026-12-31", null), 200).body().get("zustand").asText())
                .isEqualTo("verteilt");
        Antwort januar = ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2027-01-01", null), 200);
        assertThat(januar.body().get("zustand").asText()).as("nie still auf 9010/9020").isEqualTo("nicht verteilt");

        // Ein Satz, dessen Ziele an verschiedenen Tagen enden, ließe ab 01.01.2027 50 % stehen.
        Antwort rest = abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-12-01", false, k9000, "50", k9100, "50"),
                "verteilung_summe");
        assertThat(rest.body().get("summe").asText()).isEqualTo("50");
        assertThat(rest.body().get("tag").asText()).isEqualTo("2027-01-01");
        abgelehnt(w, HttpMethod.PUT, pfad(w), satz1("2027-01-01", k9000, "100"), "ziel_besteht_nicht");

        // Die Seite der Kostenstelle (Trigger-Paar aus AP-10 IP-7): 9000 früher beenden ist 409 mit der Liste.
        Antwort ende = ruf(w, HttpMethod.PUT, KST + "/" + k9000 + "/beenden", Map.of("gueltig_bis", "2026-11-30"));
        assertThat(ende.status()).as(ende.body().toString()).isEqualTo(409);
        assertThat(ende.body().get("code").asText()).isEqualTo("zuordnung_besteht");
        assertThat(ende.body().at("/zuordnungen/0/art").asText()).isEqualTo("verteilung");
        assertThat(ende.body().at("/zuordnungen/0/kennzeichen").asText()).isEqualTo(w.kennzeichen());

        // Die Nachfolger ab 2027: die alte Zeile endete schon mit 9000 und bleibt unberührt.
        Antwort nachfolger = ok(ruf(w, HttpMethod.PUT, pfad(w), satz("2027-01-01", false, k9010, "50", k9020, "50")), 200);
        assertThat(anteile(nachfolger)).containsExactly("9000=100 2026-10-01..2026-12-31", "9010=50 2027-01-01..offen",
                "9020=50 2027-01-01..offen");
    }

    // ============================================================ Korrektur, leerer Satz, Zaun, Form

    @Test
    void eineKorrekturHebtAufUndEinLeererSatzHeisstNichtVerteilt() throws Exception {
        Welt w = welt();
        UUID k4100 = kostenstelle(w, "4100", "Spritzguss", "2026-10-01", null);
        UUID k4200 = kostenstelle(w, "4200", "Montage", "2026-10-01", null);
        ok(ruf(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "70", k4200, "30")), 200);

        Antwort ueberlappt = abgelehnt(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", false, k4100, "65", k4200, "35"),
                "formel_fassung_ueberlappt");
        assertThat(ueberlappt.body().get("laufend_ab").asText()).isEqualTo("2026-10-01");
        Antwort korrigiert = ok(ruf(w, HttpMethod.PUT, pfad(w), satz("2026-10-01", true, k4100, "65", k4200, "35")), 200);
        assertThat(anteile(korrigiert)).containsExactly("4100=65 2026-10-01..offen", "4200=35 2026-10-01..offen");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_verteilung WHERE messstelle_id = ? "
                + "AND aufgehoben_am IS NOT NULL", Long.class, w.messstelle())).as("aufgehoben, lesbar, nie gelöscht")
                .isEqualTo(2);

        // Ab 01.02.2027 nicht verteilt: ein leerer Satz beendet die laufende am 31.01.
        Antwort leer = ok(ruf(w, HttpMethod.PUT, pfad(w), satzLeer("2027-02-01")), 200);
        assertThat(anteile(leer)).containsExactly("4100=65 2026-10-01..2027-01-31", "4200=35 2026-10-01..2027-01-31");
        Antwort feb = ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2027-02-01", null), 200);
        assertThat(feb.body().get("zustand").asText()).isEqualTo("nicht verteilt");
        assertThat(root.queryForList("SELECT neu->>'korrektur' FROM messstelle_aenderung WHERE messstelle_id = ? "
                + "ORDER BY id", String.class, w.messstelle())).containsExactly("false", "true", "false");
    }

    @Test
    void fremdIst404UndDieAnfrageWirdStrengGelesen() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID k4100 = kostenstelle(a, "4100", "Spritzguss", "2026-10-01", null);
        UUID eigene = kostenstelle(b, "4100", "Spritzguss", "2026-10-01", null);
        abgelehnt(b, HttpMethod.GET, pfad(a), null, "nicht_gefunden");
        abgelehnt(b, HttpMethod.PUT, pfad(a), satz1("2026-10-01", eigene, "100"), "nicht_gefunden");
        abgelehnt(b, HttpMethod.PUT, pfad(b), satz1("2026-10-01", k4100, "100"), "kostenstelle_unbekannt");
        abgelehnt(a, HttpMethod.GET, "/api/v1/messstellen/kein-uuid/verteilung", null, "nicht_gefunden");

        Map<String, Object> camel = satz1("2026-10-01", k4100, "100");
        camel.put("gueltigAb", "2026-10-01");
        assertThat(abgelehnt(a, HttpMethod.PUT, pfad(a), camel, "anfrage_ungueltig").body().get("feld").asText())
                .isEqualTo("gueltigAb");
        Map<String, Object> ohneZeilen = new LinkedHashMap<>(Map.of("gueltig_ab", "2026-10-01"));
        assertThat(abgelehnt(a, HttpMethod.PUT, pfad(a), ohneZeilen, "anfrage_ungueltig").body().get("feld").asText())
                .isEqualTo("zeilen");
        // Ein Anteil als JSON-Zahl wird als sein Dezimaltext gelesen.
        Map<String, Object> zahl = new LinkedHashMap<>();
        zahl.put("gueltig_ab", "2026-10-01");
        zahl.put("zeilen", List.of(Map.of("kostenstelle_id", k4100.toString(), "anteil_prozent", 100)));
        assertThat(anteile(ok(ruf(a, HttpMethod.PUT, pfad(a), zahl), 200))).containsExactly("4100=100 2026-10-01..offen");

        root.update("UPDATE messstelle SET archiviert_am = now() WHERE id = ?", b.messstelle());
        abgelehnt(b, HttpMethod.PUT, pfad(b), satz1("2026-10-01", eigene, "100"), "messstelle_archiviert");
    }

    // ============================================================================== Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Verteilung #" + nr);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", t);
        String kz = "MS-0" + (7 + nr % 2);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, 'Druckluft Kompressoren K1+K2', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t, kz);
        return new Welt(t, ms, kz);
    }

    private UUID kostenstelle(Welt w, String kennzeichen, String name, String ab, String bis) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("gueltig_ab", ab);
        m.put("gueltig_bis", bis);
        return UUID.fromString(ok(ruf(w, HttpMethod.POST, KST, m), 201).body().get("id").asText());
    }

    /** Die Summe der Tagesanteile im Januar 2027 bei 500 kWh je Tag (F13) — über den Leseweg des Formel-Terms. */
    private BigDecimal januar(Welt w, UUID kostenstelle) {
        TenantContext.set(w.mandant());
        try {
            BigDecimal summe = BigDecimal.ZERO;
            for (LocalDate d = LocalDate.of(2027, 1, 1); !d.isAfter(LocalDate.of(2027, 1, 31)); d = d.plusDays(1)) {
                VerteilungRegeln.TermUrteil u = leseweg.lies(AnteilLeseweg.VERTEILUNG, null, w.messstelle(), kostenstelle,
                        d).urteil(new BigDecimal("500"));
                assertThat(u.fehler()).as(d.toString()).isNull();
                summe = summe.add(u.menge());
            }
            return summe;
        } finally {
            TenantContext.clear();
        }
    }

    private static String pfad(Welt w) {
        return "/api/v1/messstellen/" + w.messstelle() + "/verteilung";
    }

    private static Map<String, Object> satz(String ab, boolean korrektur, UUID k1, String a1, UUID k2, String a2) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab);
        m.put("zeilen", List.of(Map.of("kostenstelle_id", k1.toString(), "anteil_prozent", a1),
                Map.of("kostenstelle_id", k2.toString(), "anteil_prozent", a2)));
        m.put("korrektur", korrektur);
        return m;
    }

    private static Map<String, Object> satz1(String ab, UUID k, String anteil) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab);
        m.put("zeilen", List.of(Map.of("kostenstelle_id", k.toString(), "anteil_prozent", anteil)));
        return m;
    }

    private static Map<String, Object> satzLeer(String ab) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab);
        m.put("zeilen", List.of());
        return m;
    }

    private static List<String> anteile(Antwort a) {
        List<String> aus = new ArrayList<>();
        a.body().get("anteile").forEach(z -> aus.add(z.at("/kostenstelle/kennzeichen").asText() + "="
                + z.get("anteil_prozent").asText() + " " + z.get("gueltig_ab").asText() + ".."
                + (z.get("gueltig_bis").isNull() ? "offen" : z.get("gueltig_bis").asText())));
        return aus;
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(status);
        return a;
    }

    /** Die Ablehnung: Status und Kundensatz des Codes aus dem geschlossenen Satz. */
    private Antwort abgelehnt(Welt w, HttpMethod methode, String pfad, Object body, String code) throws Exception {
        Antwort a = ruf(w, methode, pfad, body);
        Ablehnung soll = Arrays.stream(Ablehnung.values()).filter(x -> x.code().equals(code)).findFirst().orElseThrow();
        assertThat(a.body().path("code").asText()).as(a.body().toString()).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.status());
        assertThat(a.body().path("message").asText()).isEqualTo(soll.satz());
        return a;
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
