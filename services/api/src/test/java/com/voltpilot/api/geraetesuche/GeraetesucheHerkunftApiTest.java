package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
 * Die Herkunft aus der Gerätesuche (Folgepaket vp-gs-folge-herkunft): der Haken im Anlege-Weg
 * ({@code POST …/components} mit {@code geraetesuche: {suchId, fund}}), die neue Adresse über denselben Haken
 * (DP-7 A, {@code PUT …/components/{id}}) und die Aktivität der Box (Bild d1) im Kommando-Verlauf.
 *
 * <p>Die Suche entsteht über die echte Route und das echte Ergebnis der Box (Listener) - das Protokoll, aus dem die
 * Aktivität liest, ist also genau das, was der Dienst schreibt. Geprüft: ein gültiger Bezug legt an, protokolliert
 * und hält die Herkunft; ein fremder (anderer Kundenbereich, andere Anlage), unbekannter oder abgelaufener legt
 * nichts an; ohne Bezug bleibt alles wie bisher; die Herkunft überlebt den Läufer nach 30 Tagen (DP-3 A).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GeraetesucheHerkunftApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String FRONIUS = "builtin:fronius_sunspec:fronius-eco-27-3-s";
    private static final String FUND = "sunspec:192.168.178.40:502";

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
    GeraetesucheDienst dienst;

    @Autowired
    ComponentConnectionReceipts receipts;

    @MockBean
    GeraetesucheVersand versand;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private GeraetesucheListener listener;

    /** Ein Kundenbereich mit einer Anlage und ihrer Box, dazu eine zweite Anlage mit eigener Box. */
    private record Welt(UUID mandant, UUID anlage, UUID box, String boxRef, UUID andereAnlage, UUID andereBox) {
        String komponenten() {
            return "/api/v1/sites/" + anlage + "/components";
        }
    }

    private record Antwort(int status, JsonNode body) {
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void vorbereiten() {
        when(versand.senden(anyString(), any())).thenReturn(true);
        listener = new GeraetesucheListener("tcp://unused", "", "", dienst, MAPPER);
    }

    // ============================================================================ Übernehmen

    @Test
    void einGueltigerBezugLegtAnProtokolliertUndHaeltDieHerkunft() throws Exception {
        Welt w = welt();
        UUID suchId = gefunden(w, w.anlage(), w.box());
        receipts.record(w.anlage(), FRONIUS, 1, verbindung("192.168.178.40"));

        Antwort a = kunde(w, post(w.komponenten()).content(anlegen(suchId, FUND)));

        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        JsonNode zeile = erzeuger(a.body());
        UUID entity = UUID.fromString(zeile.path("id").asText());
        assertThat(zeile.path("herkunft").path("art").asText()).isEqualTo("geraetesuche");
        assertThat(zeile.path("herkunft").path("suchId").asText()).isEqualTo(suchId.toString());
        assertThat(Instant.parse(zeile.path("herkunft").path("gesuchtAm").asText()))
                .isEqualTo(ausgeloest(suchId));

        Map<String, Object> p = root.queryForMap("SELECT such_id, device_id, actor_name, actor_art, fund_schluessel, "
                + "gesucht_am FROM geraetesuche_protokoll WHERE art = 'uebernommen' AND entity_id = ?", entity);
        assertThat(p.get("such_id")).isEqualTo(suchId);
        assertThat(p.get("device_id")).as("die Box, die gefunden hat").isEqualTo(w.box());
        assertThat(p.get("actor_name")).isEqualTo("Jonas Wendlinger");
        assertThat(p.get("actor_art")).isEqualTo("kunde");
        assertThat(p.get("fund_schluessel")).isEqualTo(FUND);
        assertThat(((Timestamp) p.get("gesucht_am")).toInstant()).isEqualTo(ausgeloest(suchId));
    }

    @Test
    void einFremderUnbekannterOderAbgelaufenerBezugLegtNichtsAn() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        UUID eigene = gefunden(w, w.anlage(), w.box());
        UUID andereAnlage = gefunden(w, w.andereAnlage(), w.andereBox());
        UUID andererKunde = gefunden(fremd, fremd.anlage(), fremd.box());
        receipts.record(w.anlage(), FRONIUS, 1, verbindung("192.168.178.40"));
        long vorher = komponentenZahl(w);

        Map<String, String> faelle = new LinkedHashMap<>();
        faelle.put("fremder Kundenbereich", anlegen(andererKunde, FUND));
        faelle.put("andere Anlage desselben Kunden", anlegen(andereAnlage, FUND));
        faelle.put("unbekannter Fund", anlegen(eigene, "sunspec:192.168.178.99:502"));
        faelle.put("unbekannte Suche", anlegen(UUID.randomUUID(), FUND));
        for (Map.Entry<String, String> f : faelle.entrySet()) {
            Antwort a = kunde(w, post(w.komponenten()).content(f.getValue()));
            assertThat(a.status()).as(f.getKey() + ": " + a.body()).isEqualTo(422);
            assertThat(a.body().path("message").asText()).as(f.getKey()).contains("keiner Gerätesuche dieser Anlage");
        }

        // Abgelaufen: die Suche ist 31 Tage alt, der Läufer war nur noch nicht da.
        zurueck(eigene, Duration.ofDays(31));
        Antwort alt = kunde(w, post(w.komponenten()).content(anlegen(eigene, FUND)));
        assertThat(alt.status()).as(alt.body().toString()).isEqualTo(422);

        assertThat(komponentenZahl(w)).as("nichts angelegt").isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_protokoll WHERE art = 'uebernommen' "
                + "AND tenant_id IN (?, ?)", Long.class, w.mandant(), fremd.mandant())).isZero();
    }

    @Test
    void ohneBezugBleibtDerAnlegeWegWieBisher() throws Exception {
        Welt w = welt();
        receipts.record(w.anlage(), FRONIUS, 1, verbindung("192.168.178.41"));

        Antwort a = kunde(w, post(w.komponenten()).content(MAPPER.writeValueAsString(Map.of(
                "templateRef", FRONIUS, "role", "pv-generation", "connection", verbindung("192.168.178.41")))));

        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(erzeuger(a.body()).has("herkunft")).as("keine Herkunft, nie geraten").isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_protokoll WHERE site_id = ?", Long.class,
                w.anlage())).isZero();
    }

    @Test
    void dieHerkunftBleibtLesbarWennDerLaeuferSucheUndFundGeloeschtHat() throws Exception {
        Welt w = welt();
        UUID suchId = gefunden(w, w.anlage(), w.box());
        Instant gesucht = ausgeloest(suchId);
        receipts.record(w.anlage(), FRONIUS, 1, verbindung("192.168.178.40"));
        assertThat(kunde(w, post(w.komponenten()).content(anlegen(suchId, FUND))).status()).isEqualTo(200);

        // 31 Tage später: der Läufer löscht Suche und Funde (DP-3 A), das Protokoll bleibt.
        zurueck(suchId, Duration.ofDays(31));
        assertThat(dienst.aufraeumen()).isPositive();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche WHERE id = ?", Long.class, suchId)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_fund WHERE such_id = ?", Long.class, suchId))
                .isZero();

        JsonNode herkunft = erzeuger(kunde(w, get(w.komponenten())).body()).path("herkunft");
        assertThat(herkunft.path("art").asText()).isEqualTo("geraetesuche");
        assertThat(Instant.parse(herkunft.path("gesuchtAm").asText())).as("der Tag der Suche, nicht der des Läufers")
                .isEqualTo(gesucht);
    }

    // ============================================================================ DP-7 A: neue Adresse

    @Test
    void dieNeueAdresseUeberDenselbenHakenWirdProtokolliertOhneHerkunftZuBehaupten() throws Exception {
        Welt w = welt();
        receipts.record(w.anlage(), FRONIUS, 1, verbindung("192.168.178.35"));
        Antwort angelegt = kunde(w, post(w.komponenten()).content(MAPPER.writeValueAsString(Map.of(
                "templateRef", FRONIUS, "role", "pv-generation", "connection", verbindung("192.168.178.35")))));
        JsonNode zeile = erzeuger(angelegt.body());
        String entity = zeile.path("id").asText();
        int fassung = zeile.path("definitionVersion").asInt();

        UUID suchId = gefunden(w, w.anlage(), w.box());
        receipts.record(w.anlage(), FRONIUS, 1, verbindung("192.168.178.40"));
        UUID fremd = gefunden(w, w.andereAnlage(), w.andereBox());
        Antwort abgelehnt = kunde(w, put(w.komponenten() + "/" + entity).content(bearbeiten(fremd, fassung)));
        assertThat(abgelehnt.status()).as(abgelehnt.body().toString()).isEqualTo(422);
        assertThat(erzeuger(kunde(w, get(w.komponenten())).body()).path("definitionVersion").asInt())
                .as("nichts geändert").isEqualTo(fassung);

        Antwort a = kunde(w, put(w.komponenten() + "/" + entity).content(bearbeiten(suchId, fassung)));

        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(erzeuger(a.body()).path("connection").path("ip").asText()).isEqualTo("192.168.178.40");
        assertThat(erzeuger(a.body()).has("herkunft")).as("von Hand angelegt bleibt von Hand angelegt").isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_protokoll WHERE art = 'adresse_uebernommen' "
                + "AND entity_id = ?::uuid AND such_id = ? AND fund_schluessel = ?", Long.class, entity, suchId, FUND))
                .isOne();
    }

    // ============================================================================ Aktivität der Box (d1)

    @Test
    void dieAktivitaetDerBoxZeigtSucheUndUebernahmeDieKomponenteNurIhreUebernahme() throws Exception {
        Welt w = welt();
        UUID suchId = gefunden(w, w.anlage(), w.box());
        receipts.record(w.anlage(), FRONIUS, 1, verbindung("192.168.178.40"));
        UUID entity = UUID.fromString(erzeuger(kunde(w, post(w.komponenten()).content(anlegen(suchId, FUND)))
                .body()).path("id").asText());

        JsonNode box = verlauf(w, "device=" + w.boxRef());
        JsonNode suche = zeile(box, "geraetesuche");
        assertThat(suche.path("stream").asText()).isEqualTo("geraetesuche");
        assertThat(suche.path("source").asText()).isEqualTo("portal");
        assertThat(suche.path("urheber").path("name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(suche.path("endedAt").isNull()).as("das Ergebnis ist da").isFalse();
        assertThat(suche.path("geraetesuche").path("suchId").asText()).isEqualTo(suchId.toString());
        assertThat(suche.path("geraetesuche").path("zustand").asText()).isEqualTo("fertig");
        assertThat(suche.path("geraetesuche").path("dauerMs").asInt()).isEqualTo(38120);
        assertThat(suche.path("geraetesuche").path("zaehler").path("bereit").asInt()).isOne();
        JsonNode uebernahme = zeile(box, "geraet_uebernommen");
        assertThat(uebernahme.path("entityId").asText()).isEqualTo(entity.toString());
        assertThat(uebernahme.path("geraetesuche").path("komponente").asText()).isEqualTo("Fronius Dach");
        assertThat(uebernahme.path("geraetesuche").path("fund").asText()).isEqualTo(FUND);
        assertThat(suche.path("id").asLong()).isNotEqualTo(uebernahme.path("id").asLong()).isNegative();
        assertThat(box.path("total").asInt()).as("die Zeilen zählen mit").isEqualTo(2);

        JsonNode komponente = verlauf(w, "entity=" + entity);
        assertThat(arten(komponente)).as("die Suche gehört der Box").containsExactly("geraet_uebernommen");

        JsonNode gefiltert = verlauf(w, "device=" + w.boxRef() + "&streams=batterie");
        assertThat(arten(gefiltert)).as("ein Strom-Filter trifft keine Suche").isEmpty();
    }

    @Test
    void eineSucheOhneErgebnisHeisstNach30SekundenKeineAntwort() throws Exception {
        Welt w = welt();
        UUID suchId = gestartet(w);
        assertThat(zeile(verlauf(w, "device=" + w.boxRef()), "geraetesuche").path("geraetesuche").path("zustand")
                .asText()).isEqualTo("wartet");

        root.update("UPDATE geraetesuche SET ausgeloest_am = ausgeloest_am - interval '1 minute', "
                + "gueltig_bis = gueltig_bis - interval '1 minute' WHERE id = ?", suchId);
        JsonNode zeile = zeile(verlauf(w, "device=" + w.boxRef()), "geraetesuche");
        assertThat(zeile.path("geraetesuche").path("zustand").asText()).isEqualTo("keine_antwort");
        assertThat(zeile.path("endedAt").isNull()).isTrue();
    }

    // ============================================================================ Hilfen

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Herkunft #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Haus Weber') RETURNING id",
                UUID.class, t);
        UUID andere = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Garage') RETURNING id",
                UUID.class, t);
        String ref = "GH-" + nr;
        return new Welt(t, anlage, box(t, anlage, ref), ref, andere, box(t, andere, "GH-ANDERE-" + nr));
    }

    private static UUID box(UUID t, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, supports, "
                + "supports_reported_at, device_status_seen_at, lan_host, lan_source, lan_seen_at) VALUES (?, ?, ?, "
                + "'[\"geraetesuche\"]'::jsonb, now(), now(), '192.168.178.20', 'schnittstelle', now()) RETURNING id",
                UUID.class, t, site, ref);
    }

    /** Eine Suche über die echte Route, beendet über das echte Ergebnis der Box: ein Fronius-Fund. */
    private UUID gefunden(Welt w, UUID anlage, UUID box) throws Exception {
        Antwort a = kunde(w, post("/api/v1/sites/" + anlage + "/geraetesuche")
                .content("{\"deviceId\":\"" + box + "\"}"));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(202);
        UUID suchId = UUID.fromString(a.body().path("suchId").asText());
        ObjectNode e = MAPPER.createObjectNode().put("schema_version", "1.0").put("tenant_id", w.mandant().toString())
                .put("site_id", anlage.toString()).put("device_id", box.toString()).put("such_id", suchId.toString())
                .put("ts", Instant.now().toString()).put("zustand", "fertig").put("dauer_ms", 38120);
        e.putArray("erkenner").add("sunspec");
        e.putArray("netze").addObject().put("rolle", "kundennetz").put("netz", "192.168.178.0/24")
                .put("box_adresse", "192.168.178.20").put("erreichbar", true).put("aktiv", 9);
        ObjectNode f = e.putArray("funde").addObject().put("schluessel", FUND).put("erkenner", "sunspec")
                .put("art", "wechselrichter").put("hersteller", "fronius").put("erkennung", "sicher")
                .put("anbindung", "uebernehmen").put("liest_box_schon", false);
        f.putArray("merkmale").add("sunspec_kopf");
        f.putObject("verbindung").put("ip", "192.168.178.40").put("port", 502).put("communication", "sunspec_tcp")
                .put("unit_id", 1);
        e.putObject("weitere").put("unbekannt", 2);
        String topic = "ems/" + w.mandant() + "/" + anlage + "/" + box + "/v2/geraetesuche-ergebnis";
        assertThat(listener.handle(topic, MAPPER.writeValueAsBytes(e), Instant.now())).as(e.toString()).isTrue();
        return suchId;
    }

    /** Eine Suche, zu der die Box noch nichts gemeldet hat. */
    private UUID gestartet(Welt w) throws Exception {
        Antwort a = kunde(w, post("/api/v1/sites/" + w.anlage() + "/geraetesuche")
                .content("{\"deviceId\":\"" + w.box() + "\"}"));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(202);
        return UUID.fromString(a.body().path("suchId").asText());
    }

    /** Verschiebt eine Suche in die Vergangenheit (die Frist wandert mit, sonst greift ihr CHECK). */
    private static void zurueck(UUID suchId, Duration um) {
        assertThat(root.update("UPDATE geraetesuche SET ausgeloest_am = ausgeloest_am - ?::interval, "
                + "gueltig_bis = gueltig_bis - ?::interval, beendet_am = beendet_am - ?::interval WHERE id = ?",
                um.toString(), um.toString(), um.toString(), suchId)).isOne();
    }

    private static Instant ausgeloest(UUID suchId) {
        return root.queryForObject("SELECT ausgeloest_am FROM geraetesuche WHERE id = ?", Timestamp.class, suchId)
                .toInstant();
    }

    private static long komponentenZahl(Welt w) {
        return root.queryForObject("SELECT count(*) FROM measurement_point WHERE tenant_id = ?", Long.class,
                w.mandant());
    }

    private static Map<String, Object> verbindung(String ip) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", ip);
        c.put("port", 502);
        c.put("unit_id", 1);
        return c;
    }

    private static String anlegen(UUID suchId, String fund) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("templateRef", FRONIUS);
        body.put("role", "pv-generation");
        body.put("label", "Fronius Dach");
        body.put("connection", verbindung("192.168.178.40"));
        body.put("geraetesuche", Map.of("suchId", suchId.toString(), "fund", fund));
        return MAPPER.writeValueAsString(body);
    }

    private static String bearbeiten(UUID suchId, int fassung) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("templateRef", FRONIUS);
        body.put("role", "pv-generation");
        body.put("connection", verbindung("192.168.178.40"));
        body.put("expectedRevision", fassung);
        body.put("effectiveAt", Instant.now().toString());
        body.put("geraetesuche", Map.of("suchId", suchId.toString(), "fund", FUND));
        return MAPPER.writeValueAsString(body);
    }

    private static JsonNode erzeuger(JsonNode komponenten) {
        for (JsonNode c : komponenten.path("components")) {
            if ("pv-generation".equals(c.path("role").asText())) {
                return c;
            }
        }
        throw new AssertionError("kein Erzeuger in " + komponenten);
    }

    private JsonNode verlauf(Welt w, String frage) throws Exception {
        Antwort a = kunde(w, get("/api/v1/sites/" + w.anlage() + "/command-history?" + frage));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    private static JsonNode zeile(JsonNode verlauf, String eventKind) {
        for (JsonNode e : verlauf.path("entries")) {
            if ("geraetesuche".equals(e.path("stream").asText()) && eventKind.equals(e.path("eventKind").asText())) {
                return e;
            }
        }
        throw new AssertionError(eventKind + " in " + verlauf);
    }

    private static List<String> arten(JsonNode verlauf) {
        return MAPPER.convertValue(verlauf.path("entries"), new com.fasterxml.jackson.core.type.TypeReference<
                List<Map<String, Object>>>() { }).stream()
                .filter(e -> "geraetesuche".equals(e.get("stream")))
                .map(e -> String.valueOf(e.get("eventKind")))
                .toList();
    }

    /** Der Kundenadministrator (Token mit Mandant, ohne Plattform-Rolle). */
    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON).with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        }))).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode body;
        try {
            body = text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text);
        } catch (Exception e) {
            body = NullNode.getInstance();
        }
        return new Antwort(res.getResponse().getStatus(), body);
    }
}
