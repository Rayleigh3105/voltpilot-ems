package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeResult.OpResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
 * Die Sprungprobe am ANLAGENMODELL (UEMS AP-15 IP-21, E3 = A, T5, I3; Fälle R1 und R19): keine echte Box, kein echtes
 * Gerät — der Auftrag geht an einen Versand-Doppelgänger, der Bericht der Box wird aus dem Vertrag gebaut, der
 * Netzzähler der führenden Box sind Zeilen in {@code telemetry}. Ahrenberg AN-1: Box Halle 1 (E-1, führt, Netzzähler
 * DQ-2) + Box Verwaltung (E-4, steuert mit, DQ-10). Die Uhr der Probe steht kurz NACH dem Einrichten (die Mitglieder
 * beginnen mit der laufenden Minute), die Netzpunkt-Zeilen liegen auf dieser Uhr.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SprungprobeApiTest {

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

    @Autowired
    SprungprobeDienst dienst;

    @SpyBean
    SteuerungsverbundNachweiseHeute nachweise;

    @SpyBean
    BoxFaehigkeiten faehigkeiten;

    @MockBean
    SprungprobeVersand versand;

    /** Die Erreichbarkeitsprüfung vor einem Zuständigkeitswechsel (Muster {@code GemeinsameSteuerungKeinVerbundApiTest}). */
    @MockBean
    ProbeService probes;

    @MockBean
    DatenquelleBudgetService budgets;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID an1, UUID na1, UUID e1, UUID e4, UUID dq2, UUID dq10) {
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

    @AfterEach
    void uhrZurueck() {
        dienst.uhrStellen(Clock.systemUTC());
    }

    // ============================================================================ R1 → S2

    /**
     * R1: der Sprung von Box Verwaltung (PV 55 → 25 kW) erscheint am Netzzähler von Box Halle 1 in Richtung und Größe,
     * zweimal → bestanden. Erst wenn auch die führende Box bestanden hat, steht die Anlage auf S2; dann fehlt beim
     * Scharfschalten kein Nachweis mehr. Das Kundenkonto löst nie aus.
     */
    @Test
    void r1BestandenZweimalHebtAufS2() throws Exception {
        Welt w = welt();
        vorbereitet(w);
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS).plus(2, ChronoUnit.MINUTES);

        assertThat(kunde(w, post(w.admin() + "/sprungprobe").content(auftrag(w.e4()))).status()).isEqualTo(403);

        JsonNode e4 = probe(w, w.e4(), t0, -60, -30, "erzeugung_senken", 55, 25);
        assertThat(e4.path("urteil").asText()).isEqualTo("bestanden");
        assertThat(e4.path("gilt").asBoolean()).isTrue();
        assertThat(stufe(w)).as("die führende Box hat noch keine Probe").isEqualTo("beobachtet");
        Antwort ohneE1 = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(ohneE1.code()).isEqualTo("nachweis_fehlt");
        assertThat(ohneE1.body().path("fehlt").toString()).contains(w.e1().toString())
                .doesNotContain(w.e4().toString());

        JsonNode e1 = probe(w, w.e1(), t0.plusSeconds(600), -60, -30, "erzeugung_senken", 90, 60);
        assertThat(e1.path("urteil").asText()).isEqualTo("bestanden");
        assertThat(stufe(w)).isEqualTo("geprueft");
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_aenderung WHERE site_id = ? AND art = "
                + "'stufe' AND grund = 'sprungprobe_bestanden' AND actor_name = 'Sprungprobe'", Long.class, w.an1()))
                .isOne();
        JsonNode protokoll = MAPPER.readTree(root.queryForObject("SELECT messwerte::text FROM "
                + "steuerungsverbund_sprungprobe WHERE device_id = ?", String.class, w.e4()));
        assertThat(protokoll).hasSize(2);
        assertThat(protokoll.get(0).path("erwartet_kw").decimalValue()).isEqualByComparingTo("30");
        assertThat(protokoll.get(0).path("gesehen_kw").decimalValue()).isEqualByComparingTo("30");
        assertThat(root.queryForObject("SELECT actor_name FROM steuerungsverbund_sprungprobe WHERE device_id = ?",
                String.class, w.e4())).isEqualTo("VoltPilot Betrieb");

        Antwort s = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(s.status()).as(s.body().toString()).isEqualTo(200);
        assertThat(s.body().path("zustand").asText()).isEqualTo("anteile_aktiv");
    }

    // ============================================================================ Betreiber-Blatt (IP-24)

    /**
     * IP-24: {@code GET /api/v1/admin/…/gemeinsame-steuerung} — nur die Plattform, leer ohne Gemeinsame Steuerung,
     * fremde Anlage 404; je Box Fähigkeit gemeldet/fehlt und „nicht gemeldet“ statt einer Null; das Protokoll mit
     * Abweichung je Sprung, jüngste Probe zuerst.
     */
    @Test
    void betreiberBlattZeigtBoxenProtokollUndZweischritt() throws Exception {
        Welt w = welt();
        assertThat(kunde(w, get(w.admin())).status()).isEqualTo(403);
        assertThat(plattform(w, get("/api/v1/admin/sites/" + UUID.randomUUID() + "/gemeinsame-steuerung")).status())
                .isEqualTo(404);
        Antwort leer = plattform(w, get(w.admin()));
        assertThat(leer.status()).isEqualTo(200);
        assertThat(leer.body().path("boxen")).isEmpty();
        assertThat(leer.body().path("zweischritt").isNull()).isTrue();

        vorbereitet(w);
        root.update("UPDATE device SET supports = '[\"steuerungsverbund_anteil\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.e1());
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS).plus(2, ChronoUnit.MINUTES);
        probe(w, w.e4(), t0, -60, -30, "erzeugung_senken", 55, 25);

        JsonNode blatt = plattform(w, get(w.admin())).body();
        assertThat(blatt.path("boxen")).hasSize(2);
        JsonNode e1 = box(blatt, w.e1());
        JsonNode e4 = box(blatt, w.e4());
        assertThat(e1.path("rolle").asText()).isEqualTo("fuehrt");
        assertThat(e1.path("faehigkeit").path("steuerungsverbund_anteil").asText()).isEqualTo("gemeldet");
        assertThat(e4.path("faehigkeit").path("steuerungsverbund_anteil").asText()).isEqualTo("fehlt");
        assertThat(e4.path("messpunkt").path("data_source_id").asText()).isEqualTo(w.dq10().toString());
        assertThat(e4.path("messpunkt").path("zustand").asText()).as("keine Meldung ist keine Null")
                .isEqualTo("nicht_gemeldet");
        assertThat(e4.path("waechter").isNull()).as("ohne Herzschlag-Block keine Stufe").isTrue();
        assertThat(e4.path("anteile").path("wirksam_kw").isNull()).isTrue();
        assertThat(e4.path("plan").path("veroeffentlicht").isNull()).isTrue();
        assertThat(blatt.path("zweischritt").isNull()).as("vor dem Scharfschalten kein Anteils-Dokument").isTrue();
        JsonNode protokoll = blatt.path("sprungproben");
        assertThat(protokoll).hasSize(1);
        assertThat(protokoll.get(0).path("probe").path("box_id").asText()).isEqualTo(w.e4().toString());
        assertThat(protokoll.get(0).path("probe").path("urteil").asText()).isEqualTo("bestanden");
        assertThat(protokoll.get(0).path("spruenge")).hasSize(2);
        assertThat(protokoll.get(0).path("spruenge").get(0).path("abweichung_kw").decimalValue())
                .isEqualByComparingTo("0");

        probe(w, w.e1(), t0.plusSeconds(600), -60, -30, "erzeugung_senken", 90, 60);
        assertThat(plattform(w, post(w.admin() + "/scharfschalten")).status()).isEqualTo(200);
        JsonNode scharf = plattform(w, get(w.admin())).body();
        assertThat(scharf.path("sprungproben")).hasSize(2);
        assertThat(scharf.path("sprungproben").get(0).path("probe").path("box_id").asText())
                .as("jüngste zuerst").isEqualTo(w.e1().toString());
        // der Zweischritt selbst: SteuerungsverbundAnteilDienstTest (R12, „1 von 2“) — diese Welt leitet keine Anteile ab
        assertThat(box(scharf, w.e4()).path("anteile").path("quittiert").isNull()).isTrue();
    }

    @Test
    void steckerprobeTraegtPlattformEinUndBetreiberBlattLiestSie() throws Exception {
        Welt w = welt();
        vorbereitet(w);
        String body = "{\"von\":\"2026-09-10T06:00:00Z\",\"bis\":\"2026-09-10T06:30:00Z\","
                + "\"box_id\":\"" + w.e4() + "\",\"bemerkung\":\"Kabel an Box Verwaltung gezogen\"}";

        assertThat(kunde(w, post(w.admin() + "/steckerprobe").content(body)).status()).isEqualTo(403);
        Welt fremd = welt();
        assertThat(plattform(fremd, post(w.admin() + "/steckerprobe").content(body)).status())
                .as("fremde Anlage bleibt unbekannt").isEqualTo(404);

        Antwort erstellt = plattform(w, post(w.admin() + "/steckerprobe").content(body));
        assertThat(erstellt.status()).as(erstellt.body().toString()).isEqualTo(200);
        assertThat(erstellt.body().path("box_id").asText()).isEqualTo(w.e4().toString());
        assertThat(erstellt.body().path("nachweis").path("zeitraum_von").asText())
                .isEqualTo("2026-09-10T08:00:00+02:00");
        assertThat(erstellt.body().path("nachweis").path("grund").asText()).isEqualTo("kein_hauptzaehler");

        JsonNode blatt = plattform(w, get(w.admin())).body();
        assertThat(blatt.path("steckerproben")).hasSize(1);
        assertThat(blatt.path("steckerproben").get(0).path("bemerkung").asText())
                .isEqualTo("Kabel an Box Verwaltung gezogen");
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_steckerprobe WHERE site_id = ?",
                Long.class, w.an1())).isOne();
    }

    private static JsonNode box(JsonNode blatt, UUID box) {
        for (JsonNode b : blatt.path("boxen")) {
            if (b.path("box_id").asText().equals(box.toString())) {
                return b;
            }
        }
        throw new AssertionError("Box fehlt im Blatt: " + box);
    }

    // ============================================================================ R19 → bleibt S1

    /** R19, erste Form: Box Verwaltung hängt an einem anderen Anschluss — am Netzzähler NA-1 ist nichts zu sehen. */
    @Test
    void r19AndererAnschlussNichtGesehenBleibtS1() throws Exception {
        Welt w = welt();
        vorbereitet(w);
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS).plus(2, ChronoUnit.MINUTES);
        JsonNode e4 = probe(w, w.e4(), t0, -60, -60, "erzeugung_senken", 55, 25);
        assertThat(e4.path("urteil").asText()).isEqualTo("nicht_bestanden");
        assertThat(e4.path("grund").asText()).isEqualTo("nicht_gesehen");
        assertThat(e4.path("gilt").asBoolean()).isFalse();
        assertThat(stufe(w)).isEqualTo("beobachtet");
        Antwort a = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(a.code()).isEqualTo("nachweis_fehlt");
        assertThat(a.fehlt()).containsExactly("nachweis_fehlt", "nachweis_fehlt");
    }

    /** R19, zweite Form: ein verdrehtes Vorzeichen — der Netzzähler zeigt den Sprung in der falschen Richtung. */
    @Test
    void r19VerdrehtesVorzeichenFalscheRichtung() throws Exception {
        Welt w = welt();
        vorbereitet(w);
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS).plus(2, ChronoUnit.MINUTES);
        JsonNode e4 = probe(w, w.e4(), t0, 60, 30, "erzeugung_senken", 55, 25);
        assertThat(e4.path("urteil").asText()).isEqualTo("nicht_bestanden");
        assertThat(e4.path("grund").asText()).isEqualTo("falsche_richtung");
        assertThat(stufe(w)).isEqualTo("beobachtet");
        assertThat(plattform(w, post(w.admin() + "/scharfschalten")).code()).isEqualTo("nachweis_fehlt");
    }

    // ============================================================================ unbekannt ist kein Bestanden

    /**
     * Ohne frischen Wert der führenden Box wird nicht ausgelöst (409 {@code netzpunkt_nicht_frisch}, nichts
     * gespeichert, nichts gesendet); kommt während der Probe kein Wert an, ist sie {@code nicht_auswertbar}.
     */
    @Test
    void netzpunktNichtFrischIstNichtAuswertbar() throws Exception {
        Welt w = welt();
        vorbereitet(w);
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS).plus(2, ChronoUnit.MINUTES);
        dienst.uhrStellen(Clock.fixed(t0, ZoneOffset.UTC));
        Antwort ohne = plattform(w, post(w.admin() + "/sprungprobe").content(auftrag(w.e4())));
        assertThat(ohne.code()).isEqualTo("netzpunkt_nicht_frisch");
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_sprungprobe WHERE site_id = ?",
                Long.class, w.an1())).isZero();

        telemetrie(w, t0.minusSeconds(5), -60);
        Antwort a = plattform(w, post(w.admin() + "/sprungprobe").content(auftrag(w.e4())));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(plattform(w, post(w.admin() + "/sprungprobe").content(auftrag(w.e1()))).code())
                .as("eine Probe zur Zeit").isEqualTo("sprungprobe_laeuft");
        UUID id = UUID.fromString(a.body().path("probe_id").asText());
        dienst.uhrStellen(Clock.fixed(t0.plusSeconds(240), ZoneOffset.UTC));
        assertThat(bericht(w, w.e4(), id, t0, "erzeugung_senken", 55, 25)).isTrue();
        JsonNode m = mitglied(w, w.e4());
        assertThat(m.path("urteil").asText()).isEqualTo("nicht_auswertbar");
        assertThat(m.path("grund").asText()).isEqualTo("netzpunkt_nicht_frisch");
        assertThat(stufe(w)).isEqualTo("beobachtet");
    }

    /** Nur in S1: vor dem Einrichten 409, am Kundenkonto 403, eine fremde Box ist kein Mitglied. */
    @Test
    void ausloesenNurInS1AnEinemMitglied() throws Exception {
        Welt w = welt();
        assertThat(plattform(w, post(w.admin() + "/sprungprobe").content(auftrag(w.e4()))).code())
                .isEqualTo("nicht_eingerichtet");
        vorbereitet(w);
        assertThat(plattform(w, post(w.admin() + "/sprungprobe").content(auftrag(UUID.randomUUID()))).code())
                .isEqualTo("kein_mitglied");
        assertThat(plattform(w, post(w.admin() + "/sprungprobe").content("{\"box_id\":\"" + w.e4()
                + "\",\"art\":\"erzeugung_senken\",\"sprung_kw\":51}")).status()).isEqualTo(400);
        assertThat(plattform(w, post(w.admin() + "/sprungprobe").content("{\"box_id\":\"" + w.e4()
                + "\",\"art\":\"erzeugung_anheben\",\"sprung_kw\":30}")).status()).isEqualTo(400);
        doReturn(false).when(faehigkeiten).kann(any(), eq(SprungprobeRegel.FAEHIGKEIT));
        assertThat(plattform(w, post(w.admin() + "/sprungprobe").content(auftrag(w.e4()))).code())
                .isEqualTo("sprungprobe_nicht_gemeldet");
    }

    // ============================================================================ I3

    /**
     * I3 (Befund aus IP-26): in S2 wechselt der Messpunkt von Box Verwaltung (DQ-10) als einfacher
     * Zuständigkeitswechsel — ihre Probe ist entwertet, die der führenden Box bleibt, die Anlage geht auf S1 zurück.
     * Wechselt danach der Netzzähler (DQ-2), sind die Proben ALLER Boxen entwertet.
     */
    @Test
    void i3MesspunktWechselInS2EntwertetUndFuehrtAufS1() throws Exception {
        Welt w = welt();
        vorbereitet(w);
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS).plus(2, ChronoUnit.MINUTES);
        probe(w, w.e4(), t0, -60, -30, "erzeugung_senken", 55, 25);
        probe(w, w.e1(), t0.plusSeconds(600), -60, -30, "erzeugung_senken", 90, 60);
        assertThat(stufe(w)).isEqualTo("geprueft");

        antwortet(w, w.dq10(), w.e1());
        Antwort wechsel = kunde(w, post("/api/v1/sites/" + w.an1() + "/data-sources/" + w.dq10() + "/assignments")
                .content("{\"device_id\":\"" + w.e1() + "\"}"));
        assertThat(wechsel.status()).as(wechsel.body().toString()).isEqualTo(201);
        assertThat(stufe(w)).isEqualTo("beobachtet");
        assertThat(mitglied(w, w.e4()).path("gilt").asBoolean()).isFalse();
        assertThat(mitglied(w, w.e4()).path("entwertet_am").isNull()).isFalse();
        assertThat(mitglied(w, w.e1()).path("gilt").asBoolean()).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_aenderung WHERE site_id = ? AND art = "
                + "'stufe' AND grund LIKE 'sprungprobe_entwertet%'", Long.class, w.an1())).isOne();

        antwortet(w, w.dq2(), w.e4());
        Antwort netz = kunde(w, post("/api/v1/sites/" + w.an1() + "/data-sources/" + w.dq2() + "/assignments")
                .content("{\"device_id\":\"" + w.e4() + "\"}"));
        assertThat(netz.status()).as(netz.body().toString()).isEqualTo(201);
        assertThat(mitglied(w, w.e1()).path("gilt").asBoolean()).as("Netzzähler: alle").isFalse();
    }

    // ============================================================================ Gerüst

    /**
     * Löst die Probe an {@code box} aus (Uhr {@code t0}), schreibt den Netzpunkt der führenden Box ({@code netzVorher}
     * vor und zwischen den Sprüngen, {@code netzWaehrend} in den Sprüngen) und liefert den Bericht zwei Sprünge später
     * ein; Antwort: die Sprungprobe des Mitglieds aus dem GET.
     */
    private JsonNode probe(Welt w, UUID box, Instant t0, double netzVorher, double netzWaehrend, String art,
            double vorher, double waehrend) throws Exception {
        dienst.uhrStellen(Clock.fixed(t0, ZoneOffset.UTC));
        telemetrie(w, t0.minusSeconds(5), netzVorher);
        Antwort a = plattform(w, post(w.admin() + "/sprungprobe").content("{\"box_id\":\"" + box + "\",\"art\":\""
                + art + "\",\"sprung_kw\":30}"));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(a.body().path("urteil").asText()).isEqualTo("ausgeloest");
        ArgumentCaptor<byte[]> nutzlast = ArgumentCaptor.forClass(byte[].class);
        verify(versand, org.mockito.Mockito.atLeastOnce()).senden(eq("ems/" + w.mandant() + "/" + w.an1() + "/"
                + box + "/v2/sprungprobe"), nutzlast.capture());
        JsonNode auftrag = MAPPER.readTree(nutzlast.getValue());
        assertThat(auftrag.path("dauer_s").asInt()).isEqualTo(60);
        assertThat(auftrag.path("wiederholungen").asInt()).isEqualTo(2);
        UUID id = UUID.fromString(auftrag.path("probe_id").asText());
        for (int sprung = 0; sprung < 2; sprung++) {
            Instant von = t0.plusSeconds(10 + 120L * sprung);
            if (sprung > 0) {
                telemetrie(w, von.minusSeconds(15), netzVorher); // vor dem ersten steht schon der Wert t0 − 5 s
            }
            telemetrie(w, von.minusSeconds(5), netzVorher);
            for (int s = 25; s < 60; s += 10) {
                telemetrie(w, von.plusSeconds(s), netzWaehrend);
            }
        }
        dienst.uhrStellen(Clock.fixed(t0.plusSeconds(240), ZoneOffset.UTC));
        assertThat(bericht(w, box, id, t0, art, vorher, waehrend)).isTrue();
        assertThat(bericht(w, box, id, t0, art, vorher, waehrend)).as("genau einmal ausgewertet").isFalse();
        return mitglied(w, box);
    }

    /** Der Bericht der Box, gebaut aus dem Vertrag und über die Vertragsprüfung eingeliefert. */
    private boolean bericht(Welt w, UUID box, UUID id, Instant t0, String art, double vorher, double waehrend) {
        StringBuilder sp = new StringBuilder();
        for (int sprung = 0; sprung < 2; sprung++) {
            Instant von = t0.plusSeconds(10 + 120L * sprung);
            sp.append(sprung == 0 ? "" : ",").append("{\"von\":\"").append(von).append("\",\"bis\":\"")
                    .append(von.plusSeconds(60)).append("\",\"vorher_kw\":").append(vorher)
                    .append(",\"waehrend_kw\":").append(waehrend).append('}');
        }
        String topic = "ems/" + w.mandant() + "/" + w.an1() + "/" + box + "/v2/sprungprobe-result";
        String payload = "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + w.mandant() + "\",\"site_id\":\"" + w.an1()
                + "\",\"device_id\":\"" + box + "\",\"probe_id\":\"" + id + "\",\"art\":\"" + art
                + "\",\"stellgroesse\":\"pv_kappe\",\"spruenge\":[" + sp + "],\"abgebrochen\":false,\"ts\":\""
                + t0.plusSeconds(230) + "\"}";
        SprungprobeBericht b = SprungprobeBericht.lesen(topic, payload.getBytes(StandardCharsets.UTF_8), MAPPER);
        assertThat(b).as(payload).isNotNull();
        TenantContext.set(w.mandant());
        try {
            return dienst.berichtEmpfangen(b, t0.plusSeconds(235));
        } finally {
            TenantContext.clear();
        }
    }

    /** Eingerichtet (E-1 führt an DQ-2, E-4 steuert mit an DQ-10), S1; Fähigkeit, Auslegung, Signal da. */
    private void vorbereitet(Welt w) throws Exception {
        doReturn(true).when(faehigkeiten).kann(any(), anyString());
        doReturn(true).when(nachweise).vorgabeSignal(any(), any());
        doReturn(true).when(versand).senden(anyString(), any());
        Map<Grenzart, SteuerungsverbundRegeln.Richtung> m = Map.of(
                Grenzart.EINSPEISUNG, new SteuerungsverbundRegeln.Richtung(new BigDecimal("100"), BigDecimal.ZERO,
                        Map.of(w.e1().toString(), leistung("100", "40"), w.e4().toString(), leistung("60", "60"))),
                Grenzart.BEZUG, new SteuerungsverbundRegeln.Richtung(new BigDecimal("550"), new BigDecimal("473"),
                        Map.of(w.e1().toString(), leistung("100", "0"), w.e4().toString(), leistung("132", "24.6"))));
        doReturn(Optional.of(m)).when(nachweise).auslegung(eq(w.an1()), any(), any());
        Antwort a = kunde(w, put(w.pfad()).content("{\"mitglieder\":[{\"box_id\":\"" + w.e1()
                + "\",\"rolle\":\"fuehrt\",\"messpunkt_id\":\"" + w.dq2() + "\"},{\"box_id\":\"" + w.e4()
                + "\",\"rolle\":\"steuert_mit\",\"messpunkt_id\":\"" + w.dq10() + "\"}]}"));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(stufe(w)).isEqualTo("beobachtet");
    }

    /** Die Box besteht die Erreichbarkeitsprüfung der Quelle (Voraussetzung jedes Zuständigkeitswechsels). */
    private void antwortet(Welt w, UUID dq, UUID box) throws Exception {
        when(probes.probeBox(eq(box), anyList(), any())).thenReturn(Optional.of(new ProbeResult("a1b2c3d4e5f60718",
                null, null, List.of(new OpResult("erreichbarkeit", true, 1.0, List.of(1), 1.0, null, null)))));
        Antwort p = kunde(w, post("/api/v1/sites/" + w.an1() + "/data-sources/" + dq + "/reachability-check")
                .content("{\"device_id\":\"" + box + "\",\"unit_id\":1,\"register\":0}"));
        assertThat(p.status()).as(p.body().toString()).isEqualTo(200);
    }

    private static SteuerungsverbundRegeln.Leistung leistung(String nenn, String rueckfall) {
        return new SteuerungsverbundRegeln.Leistung(new BigDecimal(nenn), new BigDecimal(rueckfall));
    }

    private static String auftrag(UUID box) {
        return "{\"box_id\":\"" + box + "\",\"art\":\"erzeugung_senken\",\"sprung_kw\":30}";
    }

    private static void telemetrie(Welt w, Instant t, double kw) {
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES (?, ?, ?, ?, ?)",
                Timestamp.from(t), w.mandant(), w.an1(), w.e1(), kw);
    }

    private JsonNode mitglied(Welt w, UUID box) throws Exception {
        Antwort g = kunde(w, get(w.pfad()));
        assertThat(g.status()).isEqualTo(200);
        for (JsonNode m : g.body().path("mitglieder")) {
            if (m.path("box_id").asText().equals(box.toString())) {
                return m.path("sprungprobe");
            }
        }
        throw new AssertionError("kein Mitglied " + box);
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Sprungprobe #" + nr);
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
        UUID e1 = box(t, an1, "SP-E-1-" + nr);
        UUID e4 = box(t, an1, "SP-E-4-" + nr);
        UUID dq2 = quelle(t, an1, "DQ-2", "10.0.1.2:502", e1);
        UUID dq10 = quelle(t, an1, "DQ-10", "10.0.4.10:502", e4);
        return new Welt(t, an1, na1, e1, e4, dq2, dq10);
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

    private static String stufe(Welt w) {
        return root.queryForObject("SELECT stufe FROM steuerungsverbund WHERE site_id = ?", String.class, w.an1());
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
