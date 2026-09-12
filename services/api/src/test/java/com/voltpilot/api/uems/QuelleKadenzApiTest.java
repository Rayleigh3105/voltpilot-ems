package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.ErwarteteKadenz.Messkanal;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die erwartete Kadenz als zeitgültiges Feld der Quellenbindung (UEMS AP-07 IP-10, Entscheid E9)
 * Ende zu Ende gegen echtes Keycloak + TimescaleDB:
 * {@code GET/POST /api/v1/messstellen/{id}/quellen/{qid}/kadenz}.
 *
 * <p>Bewiesen wird der Prüfnachweis des Konzepts (§8 IP-10, „Kadenz-Änderung gilt ab Zeitpunkt"):
 *
 * <ul>
 *   <li><b>Die Vorgabe greift, wenn nichts eingetragen ist.</b> Ohne Fassung nennt die Route die
 *       Kadenz der Mess-Selektion mit {@code herkunft: auswahl} — die Ableitung von vor diesem
 *       Paket, Zeichen für Zeichen.</li>
 *   <li><b>Eine Änderung gilt AB ihrem Zeitpunkt und nicht rückwärts.</b> Vor dem Zeitpunkt steht
 *       weiter die alte Erwartung, ab ihm die neue; die Historie trägt beide, und im Protokoll der
 *       Messstelle steht GENAU EIN Eintrag {@code kadenz_geaendert}.</li>
 *   <li><b>Die Beobachtung aus AP-04 IP-15 verhält sich unverändert</b>, solange keine ABWEICHENDE
 *       Fassung existiert: eine Fassung mit derselben Zahl lässt die Registerzeile zeichengleich;
 *       erst eine andere Zahl bewegt {@code beobachtung.kadenz_s} — und dann auch die Toleranz, wie
 *       der Zustandsvertrag es rechnet.</li>
 *   <li><b>Die Quelle der Soll-Kadenz für den Draht</b> ({@link ErwarteteKadenz}) antwortet ZUM
 *       ZEITPUNKT: vor der Änderung leer (dann gilt die Auswahl), ab ihr mit der Fassung.</li>
 *   <li>das Ablehnungs-Vokabular an der Schnittstelle — und jede Ablehnung schreibt nichts;</li>
 *   <li>eine fremde Messstelle ist 404, nie 403.</li>
 * </ul>
 *
 * <p>Die Zahlen kommen aus dem Referenzunternehmen: MS-06 „Spritzguss SG01–SG06" liest ihre
 * Wirkenergie aus K-5 (Zähler Z-5a) — die Mess-Selektion steht dort auf 60 s, die neue Fassung
 * nennt die 10 s von MS-01.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class QuelleKadenzApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Wirkenergie Bezug (Zählerstand) an K-5 — derselbe Kanal wie im Zeitstrahl von MS-06. */
    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";

    /** Was die Mess-Selektion heute sagt … */
    private static final int AUSWAHL_S = 60;
    /** … und was die Fassung ab dem Zeitpunkt sagt (die 10 s von MS-01). */
    private static final int FASSUNG_S = 10;

    private static final String BINDUNG_AB = "2026-03-12T00:00:00+01:00";
    private static final String JETZT = "2027-03-03T12:00:00+01:00";
    private static final String AENDERUNG_AB = "2027-03-01T09:00:00+01:00";
    private static final String DAVOR = "2027-02-28T09:00:00+01:00";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

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

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    QuelleKadenzService kadenzen;

    @Autowired
    MessstelleQuelleService quellen;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JsonNode referenz;
    private static JdbcTemplate root;

    /** Ein Kundenbereich mit AN-1: Box E-1, K-5 mit Gerät GR-4, eine Messstelle und ihre Bindung. */
    private record Werk(UUID tenant, Anrufer admin, UUID an1, UUID box, UUID k5, String messstelle,
            String quelle) {}

    @BeforeAll
    static void ladeReferenz() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void uhrZurueck() {
        kadenzen.uhrStellen(Clock.systemUTC());
        quellen.uhrStellen(Clock.systemUTC());
    }

    // ---- Die Vorgabe ---------------------------------------------------------------------

    /**
     * Ohne eingetragene Fassung nennt die Route die Kadenz der Mess-Selektion — dieselbe Zahl, die
     * jede Fläche vor diesem Paket abgeleitet hätte.
     */
    @Test
    void ohneFassungGiltDieVorgabeAusDerMessSelektion() {
        Werk w = werk("Vorgabe");
        JsonNode k = ok(rufe(HttpMethod.GET, kadenzPfad(w), w.admin(), null));
        assertThat(k.get("erwartet_s").asInt()).isEqualTo(AUSWAHL_S);
        assertThat(k.get("herkunft").asText()).isEqualTo("auswahl");
        assertThat(k.get("vorgabe_s").asInt()).isEqualTo(AUSWAHL_S);
        assertThat(k.get("vorgabe_herkunft").asText()).isEqualTo("auswahl");
        assertThat(k.get("gueltig").isNull()).isTrue();
        assertThat(k.get("fassungen")).isEmpty();
        assertThat(k.get("kanal").asText()).isEqualTo(ENERGIE_BEZUG);
        assertThat(k.get("quelle_id").asText()).isEqualTo(w.quelle());
    }

    // ---- Die Geltung ab Zeitpunkt --------------------------------------------------------

    /**
     * Der Prüfnachweis: eine Kadenz-Änderung gilt AB ihrem Zeitpunkt. Davor steht weiter die alte
     * Erwartung — die Vergangenheit wird nicht umgeschrieben.
     */
    @Test
    void eineAenderungGiltAbIhremZeitpunktUndNichtRueckwaerts() {
        Werk w = werk("Geltung");
        uhr(JETZT);
        JsonNode vorgang = erfolgreich(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(),
                antrag(FASSUNG_S, AENDERUNG_AB, "Zähler liest jetzt schneller")));
        JsonNode neu = vorgang.get("fassung");
        assertThat(neu.get("erwartet_s").asInt()).isEqualTo(FASSUNG_S);
        assertThat(neu.get("herkunft").asText()).isEqualTo("eintrag");
        assertThat(neu.get("status").asText()).isEqualTo("gilt");
        assertThat(neu.get("gueltig_bis").isNull()).isTrue();
        assertThat(neu.get("rueckwirkend").asBoolean()).isTrue();
        assertThat(neu.get("begruendung").asText()).isEqualTo("Zähler liest jetzt schneller");
        assertThat(vorgang.get("beendet").isNull()).as("es gab keine Vorgängerin").isTrue();
        assertThat(vorgang.at("/rueckwirkung/art").asText()).isEqualTo("rueckwirkend");

        // Davor: die Vorgabe, unverändert. Ab dem Zeitpunkt: die Fassung.
        JsonNode davor = ok(rufe(HttpMethod.GET, kadenzPfad(w) + "?stichtag=" + DAVOR, w.admin(), null));
        assertThat(davor.get("erwartet_s").asInt()).isEqualTo(AUSWAHL_S);
        assertThat(davor.get("herkunft").asText()).isEqualTo("auswahl");
        assertThat(davor.get("gueltig").isNull()).isTrue();

        JsonNode genauDann = ok(rufe(HttpMethod.GET, kadenzPfad(w) + "?stichtag=" + AENDERUNG_AB, w.admin(), null));
        assertThat(genauDann.get("erwartet_s").asInt()).isEqualTo(FASSUNG_S);
        assertThat(genauDann.get("herkunft").asText()).isEqualTo("fassung");
        assertThat(genauDann.get("vorgabe_s").asInt()).as("was ohne Fassung gälte, bleibt sichtbar")
                .isEqualTo(AUSWAHL_S);

        JsonNode heute = ok(rufe(HttpMethod.GET, kadenzPfad(w), w.admin(), null));
        assertThat(heute.get("erwartet_s").asInt()).isEqualTo(FASSUNG_S);
        assertThat(heute.get("fassungen")).hasSize(1);

        // Eine ZWEITE Änderung beendet die erste genau zu ihrem Beginn — nie früher, nie später.
        String spaeter = "2027-03-02T09:00:00+01:00";
        JsonNode zweite = erfolgreich(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(30, spaeter, null)));
        assertThat(zweite.at("/beendet/id").asText()).isEqualTo(neu.get("id").asText());
        assertThat(zeit(zweite.at("/beendet/gueltig_bis"))).isEqualTo(zeitpunkt(spaeter));
        assertThat(ok(rufe(HttpMethod.GET, kadenzPfad(w) + "?stichtag=" + AENDERUNG_AB, w.admin(), null))
                .get("erwartet_s").asInt()).as("die erste gilt in ihrem Stück weiter").isEqualTo(FASSUNG_S);
        assertThat(ok(rufe(HttpMethod.GET, kadenzPfad(w) + "?stichtag=" + DAVOR, w.admin(), null))
                .get("erwartet_s").asInt()).as("davor unverändert die Vorgabe").isEqualTo(AUSWAHL_S);

        // Je Änderung GENAU EIN Protokolleintrag an der Messstelle.
        List<Map<String, Object>> p = root.queryForList("SELECT art, gilt_ab, rueckwirkend, grund, neu::text AS neu "
                + "FROM messstelle_aenderung WHERE messstelle_id = ? AND art = 'kadenz_geaendert' ORDER BY gilt_ab",
                UUID.fromString(w.messstelle()));
        assertThat(p).hasSize(2);
        assertThat(((Timestamp) p.get(0).get("gilt_ab")).toInstant()).isEqualTo(zeitpunkt(AENDERUNG_AB));
        assertThat(p.get(0).get("rueckwirkend")).isEqualTo(true);
        assertThat(p.get(0).get("grund")).isEqualTo("Zähler liest jetzt schneller");
        assertThat((String) p.get(0).get("neu")).contains("\"erwartet_s\": " + FASSUNG_S);
    }

    // ---- Die Beobachtung (AP-04 IP-15) ---------------------------------------------------

    /**
     * Die Beobachtung „liefert Daten" verhält sich UNVERÄNDERT, solange keine abweichende Fassung
     * existiert — auch eine Fassung mit derselben Zahl lässt die Registerzeile zeichengleich. Erst
     * eine ANDERE Zahl bewegt {@code kadenz_s} und mit ihr die Toleranz des Zustandsvertrags.
     */
    @Test
    void dieBeobachtungBleibtVerhaltensgleichBisEineAbweichendeFassungExistiert() {
        Werk w = werk("Beobachtung");
        JsonNode vorher = registerZeile(w);
        assertThat(vorher.at("/beobachtung/kadenz_s").asLong()).isEqualTo(AUSWAHL_S);
        assertThat(vorher.at("/beobachtung/toleranz_s").asLong())
                .isEqualTo(ZustandAbleitung.toleranzS(AUSWAHL_S));

        // Dieselbe Zahl als Fassung: die Zeile ist ZEICHENGLEICH.
        uhr(JETZT);
        erfolgreich(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(AUSWAHL_S, BINDUNG_AB, null)));
        assertThat(registerZeile(w)).isEqualTo(vorher);

        // Eine ANDERE Zahl ab einem Zeitpunkt: davor alles wie vorher, ab ihm die neue Erwartung.
        erfolgreich(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(FASSUNG_S, AENDERUNG_AB, null)));
        assertThat(registerZeile(w, DAVOR).at("/beobachtung/kadenz_s").asLong()).isEqualTo(AUSWAHL_S);
        JsonNode danach = registerZeile(w, AENDERUNG_AB);
        assertThat(danach.at("/beobachtung/kadenz_s").asLong()).isEqualTo(FASSUNG_S);
        assertThat(danach.at("/beobachtung/toleranz_s").asLong())
                .isEqualTo(ZustandAbleitung.toleranzS(FASSUNG_S));
        // Der Zustand selbst kommt weiter allein aus dem Vertrag — ohne Werte wartet die Größe.
        assertThat(danach.at("/beobachtung/zustand").asText()).isEqualTo("wartet_auf_erste_daten");
    }

    // ---- Die Quelle für den Draht --------------------------------------------------------

    /**
     * Was der Mess-Plan-Publisher fragt, antwortet ZUM ZEITPUNKT: vor der Änderung gibt es keine
     * Fassung (dann gilt die Auswahl — am Draht ändert sich nichts), ab ihr steht die Zahl da.
     */
    @Test
    void dieQuelleDerSollKadenzAntwortetZumZeitpunkt() {
        Werk w = werk("Draht");
        uhr(JETZT);
        erfolgreich(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(FASSUNG_S, AENDERUNG_AB, null)));

        Messkanal kanal = new Messkanal(w.k5(), ENERGIE_BEZUG);
        assertThat(alsMandant(w, () -> kadenzen.fassungenJeKanal(Set.of(kanal), zeitpunkt(DAVOR)))).isEmpty();
        assertThat(alsMandant(w, () -> kadenzen.fassungenJeKanal(Set.of(kanal), zeitpunkt(AENDERUNG_AB))))
                .containsExactly(Map.entry(kanal, FASSUNG_S));
        // Der Mandantenzaun gilt auch hier: ein fremder Kundenbereich sieht nichts.
        Werk fremd = werk("Draht fremd");
        assertThat(alsMandant(fremd, () -> kadenzen.fassungenJeKanal(Set.of(kanal), zeitpunkt(JETZT)))).isEmpty();
    }

    // ---- Die Ablehnungen -----------------------------------------------------------------

    @Test
    void dasVokabularDerSchnittstelleUndJedeAblehnungSchreibtNichts() {
        Werk w = werk("Ablehnungen");
        uhr(JETZT);
        long vorher = fassungen(w);

        abgelehnt(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(0, AENDERUNG_AB, null)),
                400, "kadenz_ungueltig");
        abgelehnt(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(86401, AENDERUNG_AB, null)),
                400, "kadenz_ungueltig");
        abgelehnt(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(null, AENDERUNG_AB, null)),
                400, "kadenz_ungueltig");
        abgelehnt(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(10, "2027-03-01T09:00:30+01:00", null)),
                400, "zeitpunkt_ungueltig");
        abgelehnt(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(10, "2026-03-11T00:00:00+01:00", null)),
                422, "vor_beginn");
        ResponseEntity<JsonNode> unbekannt = rufe(HttpMethod.POST, kadenzPfad(w), w.admin(),
                Map.of("erwartet_s", 10, "kadenz_s", 10));
        abgelehnt(unbekannt, 400, "anfrage_ungueltig");
        assertThat(unbekannt.getBody().get("feld").asText()).isEqualTo("kadenz_s");
        assertThat(fassungen(w)).as("keine Ablehnung schreibt etwas").isEqualTo(vorher);

        // Eine Fassung steht; dieselbe Stelle und dieselbe Zahl noch einmal sind abgelehnt.
        erfolgreich(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(FASSUNG_S, AENDERUNG_AB, null)));
        abgelehnt(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(30, AENDERUNG_AB, null)),
                409, "beginn_belegt");
        abgelehnt(rufe(HttpMethod.POST, kadenzPfad(w), w.admin(), antrag(FASSUNG_S, "2027-03-02T09:00:00+01:00",
                null)), 400, "unveraendert");
        assertThat(fassungen(w)).isEqualTo(vorher + 1);
    }

    /** Eine fremde Messstelle ist 404, nie 403 — lesend wie schreibend. */
    @Test
    void eineFremdeMessstelleIstVierNullVier() {
        Werk w = werk("Zaun eigen");
        Werk fremd = werk("Zaun fremd");
        String fremderPfad = "/api/v1/messstellen/" + fremd.messstelle() + "/quellen/" + fremd.quelle() + "/kadenz";

        assertThat(status(rufe(HttpMethod.GET, fremderPfad, w.admin(), null))).isEqualTo(404);
        uhr(JETZT);
        assertThat(status(rufe(HttpMethod.POST, fremderPfad, w.admin(), antrag(FASSUNG_S, AENDERUNG_AB, null))))
                .isEqualTo(404);
        assertThat(fassungen(fremd)).isZero();
        // Auch eine Quelle einer ANDEREN eigenen Messstelle gehört nicht zu dieser.
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + w.messstelle() + "/quellen/"
                + fremd.quelle() + "/kadenz", w.admin(), null))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, kadenzPfad(w), null, null))).isEqualTo(401);
    }

    // ---- Gerüst --------------------------------------------------------------------------

    /** AN-1 mit Box E-1, K-5 (Gerät GR-4), Mess-Selektion 60 s, eine Messstelle und ihre Bindung. */
    private Werk werk(String zusatz) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                referenz.at("/unternehmen/name").asText() + " · " + zusatz);
        JsonNode anlage = element(referenz.get("anlagen"), "AN-1");
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage.get("name").asText(), ts(anlage.get("seit")));
        JsonNode e1 = element(referenz.get("boxen"), "E-1");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, created_at) "
                + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, t, an1,
                e1.get("seriennummer").asText() + "-" + t, ts(e1.get("in_betrieb_ab")));
        JsonNode komponente = element(referenz.get("komponenten"), "K-5");
        UUID k5 = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"ip\":\"10.0.0.5\",\"unit_id\":5}'::jsonb, ?) RETURNING id",
                UUID.class, t, an1, komponente.get("name").asText(), box, ts(komponente.get("in_betrieb_ab")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, now(), '2026.09.11.1', "
                + "'test', 'pending_edge', 'energy_counter', 'fifteen_minute')",
                t, an1, box, k5, ENERGIE_BEZUG, AUSWAHL_S);

        Anrufer admin = new Anrufer("admin", t);
        JsonNode ms06 = element(referenz.get("messstellen"), "MS-06");
        String messstelle = anlegen(admin, wieReferenz("MS-0006", ms06)).get("id").asText();
        uhr(JETZT);
        Map<String, Object> binden = new LinkedHashMap<>();
        binden.put("komponente", k5.toString());
        binden.put("kanal", ENERGIE_BEZUG);
        binden.put("rolle", "fuehrend");
        binden.put("gueltig_ab", BINDUNG_AB);
        JsonNode gebunden = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + messstelle + "/quellen",
                admin, binden));
        quellen.uhrStellen(Clock.systemUTC());
        return new Werk(t, admin, an1, box, k5, messstelle, gebunden.at("/quelle/id").asText());
    }

    private static Map<String, Object> wieReferenz(String kennzeichen, JsonNode ms) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        body.put("hauptgroesse", groesseAus(ms.get("hauptgroesse")));
        List<JsonNode> neben = new ArrayList<>();
        ms.get("nebengroessen").forEach(n -> neben.add(groesseAus(n)));
        body.put("nebengroessen", neben);
        return body;
    }

    private static JsonNode groesseAus(JsonNode g) {
        ObjectNode n = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }

    private static Map<String, Object> antrag(Integer erwartetS, String ab, String grund) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (erwartetS != null) {
            body.put("erwartet_s", erwartetS);
        }
        body.put("gueltig_ab", ab);
        if (grund != null) {
            body.put("grund", grund);
        }
        return body;
    }

    private static String kadenzPfad(Werk w) {
        return "/api/v1/messstellen/" + w.messstelle() + "/quellen/" + w.quelle() + "/kadenz";
    }

    /** Die Registerzeile dieser Messstelle zum Zeitpunkt (ohne Stichtag: jetzt). */
    private JsonNode registerZeile(Werk w) {
        return registerZeile(w, JETZT);
    }

    private JsonNode registerZeile(Werk w, String stichtag) {
        JsonNode liste = ok(rufe(HttpMethod.GET, "/api/v1/messstellen?stichtag=" + stichtag, w.admin(), null));
        for (JsonNode z : liste.get("register")) {
            if (w.messstelle().equals(z.get("id").asText())) {
                return z;
            }
        }
        throw new AssertionError("Messstelle nicht im Register: " + w.messstelle());
    }

    /**
     * Wie der Publisher fragt: der Mandant steht VOR der Abfrage im Zaun — die Verbindung bekommt
     * ihr {@code app.tenant_id}, wenn sie geholt wird, nicht danach.
     */
    private <T> T alsMandant(Werk w, java.util.function.Supplier<T> arbeit) {
        com.voltpilot.api.tenant.TenantContext.set(w.tenant());
        try {
            return arbeit.get();
        } finally {
            com.voltpilot.api.tenant.TenantContext.clear();
        }
    }

    private static long fassungen(Werk w) {
        return root.queryForObject("SELECT count(*) FROM quelle_kadenz WHERE tenant_id = ?", Long.class, w.tenant());
    }

    private void uhr(String zeitpunkt) {
        Clock c = Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), BERLIN);
        kadenzen.uhrStellen(c);
        quellen.uhrStellen(c);
    }

    private JsonNode anlegen(Anrufer wer, Map<String, Object> body) {
        return erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen", wer, body));
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        if (wer != null) {
            headers.setBearerAuth(token(wer.benutzer()));
            if (wer.kundenbereich() != null) {
                headers.set("X-Tenant-Id", wer.kundenbereich().toString());
            }
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange(java.net.URI.create("http://localhost:" + port + pfad), methode, entity, JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        return r.getBody();
    }

    private static JsonNode erfolgreich(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    private static int status(ResponseEntity<JsonNode> r) {
        return r.getStatusCode().value();
    }

    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(status);
        assertThat(r.getBody().get("code").asText()).isEqualTo(code);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(KadenzAbgelehnt.CODES).contains(code);
    }

    private String token(String benutzer) {
        Token t = TOKENS.get(benutzer);
        if (t != null && System.currentTimeMillis() - t.geholt() < 5 * 60_000) {
            return t.wert();
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", benutzer);
        form.add("password", benutzer);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        String wert = (String) body.get("access_token");
        TOKENS.put(benutzer, new Token(wert, System.currentTimeMillis()));
        return wert;
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static Timestamp ts(JsonNode n) {
        return Timestamp.from(OffsetDateTime.parse(n.asText()).toInstant());
    }

    private static Instant zeit(JsonNode n) {
        return OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static Instant zeitpunkt(String s) {
        return OffsetDateTime.parse(s).toInstant();
    }
}
