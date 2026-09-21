package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
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
 * Der Grenz-Nachweis am Netzanschluss über die echte Route (UEMS AP-15 IP-31, NW-8, M-1, B5):
 * {@code GET /api/v1/standorte/{id}/netzanschluesse/{id}/grenznachweis?monat=} gegen gespeicherte Viertelstunden am
 * Hauptzähler (AP-08, gelesen über {@link MessstelleWerteService}) und die wirksame Grenze je Tag
 * ({@link GrenzeAufloesung}). Die Fälle der §8-Zelle: sauberer Monat, Überschreitung, Lücke — dazu Grenzwechsel
 * mitten im Monat, Anschluss ohne Grenze, ohne Hauptzähler, ohne abgeschlossenen Tag und der Zaun.
 *
 * <p>Der Monat ist September 2026 in Europe/Berlin: 30 Tage × 96 = 2 880 Viertelstunden, jede mit 100 kWh = 400 kW.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class NetzanschlussGrenznachweisApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String KANAL = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final Instant JETZT = Instant.parse("2026-10-05T10:00:00Z");
    private static final int VIERTELSTUNDEN = 30 * 96;

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
    GrenzNachweisService nachweise;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Ein Kundenbereich: Standort ST-1, Anlage AN-1 ab 01.08.2026 am Netzanschluss NA-1. */
    private record Welt(UUID mandant, UUID st1, UUID an1, UUID na1) {
        String nachweis(String monat) {
            return "/api/v1/standorte/" + st1 + "/netzanschluesse/" + na1 + "/grenznachweis"
                    + (monat == null ? "" : "?monat=" + monat);
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void uhr() {
        nachweise.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));
    }

    @AfterEach
    void uhrZurueck() {
        nachweise.uhrStellen(Clock.systemUTC());
    }

    // ============================================================================ die drei Fälle der Zelle

    @Test
    void saubererMonatIstEingehaltenUndBelegt() throws Exception {
        Welt w = welt();
        grenze(w, "2026-09-01", "100", "500");
        UUID entity = hauptzaehler(w, "MS-01");
        viertelstunden(w, entity);

        JsonNode n = ok(ruf(w, w.nachweis("2026-09"))).body();
        assertThat(n.path("monat").asText()).isEqualTo("2026-09");
        assertThat(n.path("von").asText()).isEqualTo("2026-09-01");
        assertThat(n.path("bis").asText()).isEqualTo("2026-09-30");
        assertThat(n.path("zeitzone").asText()).isEqualTo("Europe/Berlin");
        assertThat(n.path("grenze_geprueft").asBoolean()).isTrue();
        assertThat(n.path("grund").isNull()).isTrue();
        assertThat(n.path("urteil").asText()).isEqualTo("eingehalten");

        JsonNode bezug = richtung(n, "bezug");
        assertThat(bezug.path("grenze_geprueft").asBoolean()).isTrue();
        assertThat(bezug.path("urteil").asText()).isEqualTo("eingehalten");
        assertThat(bezug.path("viertelstunden").toString())
                .isEqualTo("{\"erwartet\":2880,\"belegt\":2880,\"unvollstaendig\":0,\"fehlend\":0}");
        assertThat(bezug.path("belegt_prozent").asInt()).isEqualTo(100);
        assertThat(bezug.path("hoechstes_mittel").path("mittel_kw").decimalValue()).isEqualByComparingTo("400");
        assertThat(bezug.path("hoechstes_mittel").path("grenze_kw").decimalValue()).isEqualByComparingTo("500");
        assertThat(bezug.path("hoechstes_mittel").path("abstand_kw").decimalValue()).isEqualByComparingTo("-100");
        assertThat(bezug.path("hoechstes_mittel").path("von").asText()).isEqualTo("2026-09-01T00:00:00+02:00");
        assertThat(bezug.path("darueber").toString()).isEqualTo("{\"viertelstunden\":0,\"minuten\":0}");
        assertThat(bezug.path("unterbrechungen")).isEmpty();
        assertThat(bezug.path("hauptzaehler").get(0).path("kennzeichen").asText()).isEqualTo("MS-01");
        assertThat(bezug.path("grenzen").toString()).isEqualTo(
                "[{\"von\":\"2026-09-01\",\"bis\":\"2026-09-30\",\"kw\":500,\"quelle\":\"netzanschluss\"}]");
        assertThat(bezug.path("augenblick").path("status").asText()).as("M-2 wird nicht erfunden")
                .isEqualTo("nicht_gemessen");
        assertThat(bezug.has("ausserhalb_zugriff")).isFalse();

        JsonNode einspeisung = richtung(n, "einspeisung");
        assertThat(einspeisung.path("grenze_geprueft").asBoolean()).as("Grenze ohne Hauptzähler Abgabe").isFalse();
        assertThat(einspeisung.path("grund").asText()).isEqualTo("kein_hauptzaehler");
        assertThat(einspeisung.path("urteil").isNull()).isTrue();
        assertThat(einspeisung.path("viertelstunden").isNull()).isTrue();
    }

    @Test
    void ueberschreitungNenntHoechstwertMinutenUndUnterbrechungen() throws Exception {
        Welt w = welt();
        grenze(w, "2026-09-01", null, "500");
        UUID entity = hauptzaehler(w, "MS-01");
        viertelstunden(w, entity);
        // 10.09. 08:00–08:45 Ortszeit: 560, 560, 600 kW — EINE Unterbrechung; 20.09. 14:00: 520 kW — die zweite.
        menge(w, entity, "2026-09-10T06:00:00Z", "140");
        menge(w, entity, "2026-09-10T06:15:00Z", "140");
        menge(w, entity, "2026-09-10T06:30:00Z", "150");
        menge(w, entity, "2026-09-20T12:00:00Z", "130");

        JsonNode n = ok(ruf(w, w.nachweis("2026-09"))).body();
        assertThat(n.path("urteil").asText()).isEqualTo("ueberschritten");
        JsonNode bezug = richtung(n, "bezug");
        assertThat(bezug.path("urteil").asText()).isEqualTo("ueberschritten");
        assertThat(bezug.path("belegt_prozent").asInt()).isEqualTo(100);
        assertThat(bezug.path("hoechstes_mittel").path("mittel_kw").decimalValue()).isEqualByComparingTo("600");
        assertThat(bezug.path("hoechstes_mittel").path("abstand_kw").decimalValue()).isEqualByComparingTo("100");
        assertThat(bezug.path("hoechstes_mittel").path("von").asText()).isEqualTo("2026-09-10T08:30:00+02:00");
        assertThat(bezug.path("darueber").toString()).isEqualTo("{\"viertelstunden\":4,\"minuten\":60}");
        JsonNode u = bezug.path("unterbrechungen");
        assertThat(u).hasSize(2);
        assertThat(u.get(0).path("von").asText()).isEqualTo("2026-09-10T08:00:00+02:00");
        assertThat(u.get(0).path("bis").asText()).isEqualTo("2026-09-10T08:45:00+02:00");
        assertThat(u.get(0).path("minuten").asLong()).isEqualTo(45);
        assertThat(u.get(0).path("hoechstwert_kw").decimalValue()).isEqualByComparingTo("600");
        assertThat(u.get(0).path("grenze_kw").decimalValue()).isEqualByComparingTo("500");
        assertThat(u.get(1).path("von").asText()).isEqualTo("2026-09-20T14:00:00+02:00");
        assertThat(u.get(1).path("minuten").asLong()).isEqualTo(15);
        assertThat(u.get(1).path("hoechstwert_kw").decimalValue()).isEqualByComparingTo("520");
        assertThat(richtung(n, "einspeisung").path("grund").asText()).as("keine Einspeisegrenze")
                .isEqualTo("keine_grenze");
    }

    @Test
    void lueckeIstNichtBelegtNieEingehalten() throws Exception {
        Welt w = welt();
        grenze(w, "2026-09-01", null, "500");
        UUID entity = hauptzaehler(w, "MS-01");
        viertelstunden(w, entity);
        // 15.09. fehlt ganz (96 Viertelstunden), zwei Viertelstunden am 16.09. sind unvollständig.
        root.update("DELETE FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?", entity, ts("2026-09-14T22:00:00Z"), ts("2026-09-15T22:00:00Z"));
        root.update("UPDATE messreihe_viertelstunde SET menge_zustand = 'unvollständig', erhalten = 10 "
                + "WHERE entity_id = ? AND intervall_beginn IN (?, ?)", entity, ts("2026-09-16T08:00:00Z"),
                ts("2026-09-16T08:15:00Z"));

        JsonNode n = ok(ruf(w, w.nachweis("2026-09"))).body();
        assertThat(n.path("grenze_geprueft").asBoolean()).isTrue();
        assertThat(n.path("urteil").asText()).isEqualTo("nicht_belegt");
        JsonNode bezug = richtung(n, "bezug");
        assertThat(bezug.path("urteil").asText()).as("B5: eine Lücke ist kein sauberer Wert").isEqualTo("nicht_belegt");
        assertThat(bezug.path("viertelstunden").toString())
                .isEqualTo("{\"erwartet\":2880,\"belegt\":2782,\"unvollstaendig\":2,\"fehlend\":96}");
        assertThat(bezug.path("belegt_prozent").asInt()).as("abgerundet, nie 100 mit Lücke").isEqualTo(96);
        assertThat(bezug.path("hoechstes_mittel").path("mittel_kw").decimalValue()).isEqualByComparingTo("400");
        assertThat(bezug.path("unterbrechungen")).isEmpty();
    }

    // ============================================================================ Grenzwechsel und Gründe

    @Test
    void grenzwechselMittenImMonatPrueftJedenTagGegenSeineGrenze() throws Exception {
        Welt w = welt();
        grenze(w, "2026-09-01", null, "500");
        grenze(w, "2026-09-16", null, "380");
        // Die Anlage bringt 450 kW mit — ab dem 16. ist der Anschluss enger.
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw) VALUES (?, ?, 450)", w.an1(),
                w.mandant());
        UUID entity = hauptzaehler(w, "MS-01");
        viertelstunden(w, entity);

        JsonNode bezug = richtung(ok(ruf(w, w.nachweis("2026-09"))).body(), "bezug");
        assertThat(bezug.path("grenzen").toString()).isEqualTo("[{\"von\":\"2026-09-01\",\"bis\":\"2026-09-15\","
                + "\"kw\":450,\"quelle\":\"anlage\"},{\"von\":\"2026-09-16\",\"bis\":\"2026-09-30\",\"kw\":380,"
                + "\"quelle\":\"netzanschluss\"}]");
        assertThat(bezug.path("urteil").asText()).isEqualTo("ueberschritten");
        assertThat(bezug.path("darueber").toString()).isEqualTo("{\"viertelstunden\":1440,\"minuten\":21600}");
        assertThat(bezug.path("unterbrechungen")).hasSize(1);
        assertThat(bezug.path("unterbrechungen").get(0).path("von").asText()).isEqualTo("2026-09-16T00:00:00+02:00");
        assertThat(bezug.path("unterbrechungen").get(0).path("bis").asText()).isEqualTo("2026-10-01T00:00:00+02:00");
        assertThat(bezug.path("hoechstes_mittel").path("grenze_kw").decimalValue()).isEqualByComparingTo("380");
        assertThat(bezug.path("hoechstes_mittel").path("abstand_kw").decimalValue()).isEqualByComparingTo("20");
    }

    @Test
    void ohneGrenzeOderOhneHauptzaehlerBleibtGrenzeGeprueftFalschUndSagtWarum() throws Exception {
        Welt ohneGrenze = welt();
        viertelstunden(ohneGrenze, hauptzaehler(ohneGrenze, "MS-01"));
        JsonNode a = ok(ruf(ohneGrenze, ohneGrenze.nachweis("2026-09"))).body();
        assertThat(a.path("grenze_geprueft").asBoolean()).isFalse();
        assertThat(a.path("grund").asText()).isEqualTo("keine_grenze");
        assertThat(a.path("urteil").isNull()).isTrue();
        assertThat(richtung(a, "bezug").path("grund").asText()).isEqualTo("keine_grenze");

        Welt ohneZaehler = welt();
        grenze(ohneZaehler, "2026-09-01", "100", "500");
        JsonNode b = ok(ruf(ohneZaehler, ohneZaehler.nachweis("2026-09"))).body();
        assertThat(b.path("grenze_geprueft").asBoolean()).isFalse();
        assertThat(b.path("grund").asText()).isEqualTo("kein_hauptzaehler");
        assertThat(richtung(b, "bezug").path("grenzen").get(0).path("kw").decimalValue()).isEqualByComparingTo("500");

        JsonNode c = ok(ruf(ohneZaehler, ohneZaehler.nachweis("2026-11"))).body();
        assertThat(c.path("grund").asText()).as("ein künftiger Monat hat keinen abgeschlossenen Tag")
                .isEqualTo("kein_abgeschlossener_tag");
        assertThat(c.path("von").isNull()).isTrue();

        JsonNode d = ok(ruf(ohneZaehler, ohneZaehler.nachweis(null))).body();
        assertThat(d.path("monat").asText()).as("ohne Monat der laufende am Standort").isEqualTo("2026-10");
        assertThat(d.path("bis").asText()).as("heute gehört nicht dazu").isEqualTo("2026-10-04");
    }

    @Test
    void fremderAnschlussUnbekannterUndFalscherMonat() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        assertThat(ruf(fremd, w.nachweis("2026-09")).status()).as("fremder Kundenbereich").isEqualTo(404);
        assertThat(ruf(w, "/api/v1/standorte/" + w.st1() + "/netzanschluesse/" + UUID.randomUUID()
                + "/grenznachweis").status()).isEqualTo(404);
        Antwort falsch = ruf(w, w.nachweis("2026-13"));
        assertThat(falsch.status()).isEqualTo(400);
        assertThat(falsch.body().path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(falsch.body().path("feld").asText()).isEqualTo("monat");
    }

    // ============================================================================ Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Grenz-Nachweis #" + nr);
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
                + "anschluss_kva, vereinbart_kw, messung) VALUES (?, ?, 'NA-1', 'Übergabestation Werk Ahrenberg', 630, "
                + "550, 'RLM') RETURNING id", UUID.class, t, st1);
        root.update("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2026-08-01')", t, an1, na1);
        return new Welt(t, st1, an1, na1);
    }

    private static void grenze(Welt w, String ab, String einspeisung, String bezug) {
        root.update("INSERT INTO netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab, einspeisegrenze_kw, "
                + "bezugsgrenze_kw, created_by) VALUES (?, ?, ?, ?::numeric, ?::numeric, 'test')", w.mandant(), w.na1(),
                LocalDate.parse(ab), einspeisung, bezug);
    }

    /** Box, Komponente, Mess-Selektion, Messstelle Wirkenergie Bezug, führende Quelle und Stellung Hauptzähler. */
    private static UUID hauptzaehler(Welt w, String kennzeichen) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, w.an1(), "VP-GRENZ-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, w.an1(),
                "Netzzähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, w.an1(), box, komponente, KANAL, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, 'Netzzähler', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t, kennzeichen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, KANAL, ts("2026-07-31T22:00:00Z"), ts("2026-07-31T22:01:00Z"));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?, ?, ?, 'Hauptzähler', DATE '2026-08-01')", t, messstelle, w.an1());
        return komponente;
    }

    /** Jede Viertelstunde des Septembers (Ortszeit) mit 100 kWh = 400 kW, vollständig. */
    private static void viertelstunden(Welt w, UUID entity) {
        int n = root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, entity_id, messkanal, "
                + "erhalten, erwartet, kadenz_s, kadenz_herkunft, endgueltig_ab, wertart, menge, menge_zustand) "
                + "SELECT t, ?, ?, ?, 15, 15, 60, 'auswahl', t + interval '10095 minutes', 'counter', 100, 'vollständig' "
                + "FROM generate_series(timestamptz '2026-08-31T22:00:00Z', timestamptz '2026-09-30T21:45:00Z', "
                + "interval '15 minutes') AS t", w.mandant(), entity, KANAL);
        assertThat(n).isEqualTo(VIERTELSTUNDEN);
    }

    private static void menge(Welt w, UUID entity, String beginn, String kwh) {
        assertThat(root.update("UPDATE messreihe_viertelstunde SET menge = ?::numeric WHERE tenant_id = ? "
                + "AND entity_id = ? AND intervall_beginn = ?", kwh, w.mandant(), entity, ts(beginn))).isEqualTo(1);
    }

    private static Timestamp ts(String zeit) {
        return Timestamp.from(Instant.parse(zeit));
    }

    private static JsonNode richtung(JsonNode n, String richtung) {
        List<JsonNode> out = new ArrayList<>();
        n.path("richtungen").forEach(r -> {
            if (richtung.equals(r.path("richtung").asText())) {
                out.add(r);
            }
        });
        assertThat(out).as("Richtung " + richtung).hasSize(1);
        return out.get(0);
    }

    private static Antwort ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a;
    }

    private Antwort ruf(Welt w, String pfad) throws Exception {
        MvcResult r = mvc.perform(get(pfad).with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
