package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
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
 * Die Bilanz je Anlage (UEMS AP-10 IP-9) gegen die echte Kette: Sicherheit, RLS, Flyway-Schema
 * ({@code V20260913235700}), die Stellung als EINZIGE Quelle der Terme des Rests (E3), der Live-Wert über
 * den PR-688-Weg (F18) und „Rest anlegen“ nur auf menschlichen Wunsch, nie zweimal (E18).
 *
 * <p>Die Welt ist Halle 2 des Referenzunternehmens Ahrenberg ({@code uems-referenzunternehmen.json}):
 * MS-10 „Netzbezug Halle 2“ (Hauptzähler), MS-11 … MS-14 Unterzähler von MS-10, die Momentanleistungen der
 * Momentaufnahme 20.10.2026 10:15 (96,5 · 61,2 · 14,8 · 7,9 · 11,0 kW). Jede Messstelle hat ihre eigene Box
 * (die Werte liegen je Box und Kanal), eine führende Wirkenergie (Zähler) und eine führende Wirkleistung.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BilanzApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String LEISTUNG = "sunspec.model_203.w";
    private static final String KATALOG = "2026.09.11.1";

    /** Die Momentaufnahme 20.10.2026 10:15 (F18) in W, wie der Kanal sie liefert. */
    private static final Map<String, Double> MOMENTAUFNAHME_W = Map.of(
            "MS-10", 96_500.0, "MS-11", 61_200.0, "MS-12", 14_800.0, "MS-13", 7_900.0, "MS-14", 11_000.0);

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
    BilanzService bilanzService;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private static final AtomicInteger SEQ = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ============================================================================ F18: Live

    /**
     * F18 über die Route: der Rest JETZT = 96,5 − (61,2 + 14,8 + 7,9 + 11,0) = 1,6 kW. Ist MS-14 älter als
     * seine Toleranz, ist der Live-Wert {@code null} mit {@code fehlende: [MS-14: veraltet]} — nie 12,6 kW,
     * nie 0, nie der letzte bekannte Wert. Die Route liest nur: der Bestand bleibt Zeile für Zeile stehen.
     */
    @Test
    void f18DerRestJetztIst16KwUndNullSobaldEinTermVeraltetIst() throws Exception {
        Welt w = halle2();
        leistungen(w, Instant.now());

        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        JsonNode bilanz = ok(ruf(w, HttpMethod.GET, bilanzPfad(w), null), 200);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("die Bilanz liest nur").isEmpty();

        JsonNode hz = hauptzaehler(bilanz, "MS-10");
        JsonNode live = hz.get("live");
        assertThat(live.get("wert").asDouble()).isEqualTo(1.6);
        assertThat(live.get("einheit").asText()).isEqualTo("kW");
        assertThat(live.get("unvollstaendig").asBoolean()).isFalse();
        assertThat(live.get("fehlende")).isEmpty();
        assertThat(live.has("kennzeichen")).as("das befristete Kennzeichen ist mit AP-10 IP-10 entfallen").isFalse();
        // Die Terme des Tages kommen aus der Stellung: MS-10 fließt zu, MS-11 … MS-14 sind zugeordnet.
        JsonNode terme = hz.get("abschnitte").get(0).get("terme");
        assertThat(terme).extracting(t -> t.get("messstelle").asText() + ":" + t.get("rolle").asText())
                .containsExactly("MS-10:zufluss", "MS-11:zugeordnet", "MS-12:zugeordnet", "MS-13:zugeordnet",
                        "MS-14:zugeordnet");

        // MS-14 meldet sich seit 20 Minuten nicht: null, nie 12,6 kW.
        root.update("DELETE FROM device_measurement_sample WHERE device_id = ? AND point_key = ?",
                w.boxen().get("MS-14"), LEISTUNG);
        probe(w, "MS-14", LEISTUNG, MOMENTAUFNAHME_W.get("MS-14"), Instant.now().minus(Duration.ofMinutes(20)));
        JsonNode veraltet = hauptzaehler(ok(ruf(w, HttpMethod.GET, bilanzPfad(w), null), 200), "MS-10").get("live");
        assertThat(veraltet.get("wert").isNull()).as("null, nie 12,6 kW und nie 0").isTrue();
        assertThat(veraltet.get("unvollstaendig").asBoolean()).isTrue();
        assertThat(veraltet.get("fehlende")).hasSize(1);
        assertThat(veraltet.get("fehlende").get(0).get("term").asText()).isEqualTo("MS-14");
        assertThat(veraltet.get("fehlende").get(0).get("grund").asText()).isEqualTo("veraltet");
        assertThat(veraltet.get("stand").isNull()).isTrue();
    }

    /**
     * Die Rest-Messstelle antwortet über die PR-688-Routen mit derselben Rechnung aus der Stellung (kW). Das
     * befristete Kennzeichen „vorläufig (Geräte-Verdichtung)“ (AP-10 IP-9) ist mit IP-10 entfallen: die
     * Periodenwerte liegen jetzt in der Speicherklasse, der Live-Wert bleibt live. Ohne Terme ist ein Rest nie „0“.
     */
    @Test
    void dieRestMessstelleRechnetLiveAusDerStellungOhneBefristetesKennzeichen() throws Exception {
        Welt w = halle2();
        leistungen(w, Instant.now());
        JsonNode angelegt = ok(ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest",
                Map.of("hauptzaehler_id", w.messstellen().get("MS-10").toString())), 201);
        String rest = angelegt.get("messstelle").get("id").asText();

        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + rest + "/wert", null), 200);
        assertThat(wert.get("wert").asDouble()).isEqualTo(1.6);
        assertThat(wert.get("einheit").asText()).isEqualTo("kW");
        assertThat(wert.has("kennzeichen")).isFalse();

        JsonNode verlauf = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + rest + "/verlauf", null), 200);
        assertThat(verlauf.has("kennzeichen")).isFalse();
        assertThat(verlauf.get("einheit").asText()).isEqualTo("kW");

        // Die Formel des Rests IST die Stellung: eine Fassung vom Typ rest, kein einziger Term.
        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + rest + "/formel?am="
                + LocalDate.now(ZoneId.of("Europe/Berlin")), null), 200);
        assertThat(formel.toString()).contains("\"rest\"");
        assertThat(formel.get("terme")).isEmpty();
        assertThat(formel.get("formel_vorhanden").asBoolean()).as("die Formel eines Rests IST die Stellung").isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ?::uuid",
                Long.class, rest)).isZero();
        // Eine Formel-Fassung einzutragen ergibt für einen Rest keinen Sinn — abgelehnt, nichts geschrieben.
        Antwort fassung = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + rest + "/formel/fassungen",
                Map.of("gueltig_ab", LocalDate.now().plusDays(1).toString(), "terme", List.of(Map.of(
                        "eingang_art", "messstelle", "quell_messstelle_id", w.messstellen().get("MS-11").toString(),
                        "vorzeichen", "+"))));
        assertThat(fassung.status()).isEqualTo(400);
        assertThat(fassung.body().get("feld").asText()).isEqualTo("formel_typ");
        // Die Datenbank hält es auch gegen einen Schreiber am Schreibweg vorbei.
        assertThat(sqlState(() -> root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, "
                + "eingang_art, quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?::uuid, 0, 'messstelle', ?, '+', 1)",
                w.mandant(), rest, w.messstellen().get("MS-11")))).contains("Ein Rest speichert keine Terme");
    }

    // ================================================================= E18: Rest anlegen

    /**
     * E18 — der Vorschlag „Rest anlegen“ steht je Hauptzähler ohne Rest-Messstelle da, mit vorbelegtem Namen;
     * bestätigt entsteht GENAU EINE Messstelle (Kennzeichen automatisch, Urheber im Protokoll). Zweimal
     * bestätigt: 200 {@code neu = false}, dieselbe Messstelle, nichts Neues.
     */
    @Test
    void derVorschlagZweimalBestaetigtErgibtEineMessstelle() throws Exception {
        Welt w = halle2();
        JsonNode vorher = hauptzaehler(ok(ruf(w, HttpMethod.GET, bilanzPfad(w), null), 200), "MS-10");
        assertThat(vorher.get("rest_messstelle").isNull()).isTrue();
        assertThat(vorher.get("vorschlag").get("aktion").asText()).isEqualTo("rest_anlegen");
        assertThat(vorher.get("vorschlag").get("hauptzaehler_id").asText())
                .isEqualTo(w.messstellen().get("MS-10").toString());
        assertThat(vorher.get("vorschlag").get("name").asText()).isEqualTo(w.anlageName() + " nicht zugeordnet");
        // Sehen ist nicht Besitzen: die Zeile ist da, die Messstelle nicht.
        assertThat(berechnete(w)).isZero();

        Map<String, Object> klick = Map.of("hauptzaehler_id", w.messstellen().get("MS-10").toString());
        JsonNode erst = ok(ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest", klick), 201);
        assertThat(erst.get("neu").asBoolean()).isTrue();
        assertThat(erst.get("hauptzaehler").get("kennzeichen").asText()).isEqualTo("MS-10");
        JsonNode ms = erst.get("messstelle");
        assertThat(ms.get("kennzeichen").asText()).matches("MS-\\d{4}");
        assertThat(ms.get("name").asText()).isEqualTo(w.anlageName() + " nicht zugeordnet");
        assertThat(ms.get("art").asText()).isEqualTo("berechnet");
        assertThat(ms.toString()).contains("\"Wirkenergie\"").contains("\"Bezug\"").contains("\"Intervallmenge\"");

        JsonNode zweit = ok(ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest", klick), 200);
        assertThat(zweit.get("neu").asBoolean()).isFalse();
        assertThat(zweit.get("messstelle").get("id").asText()).isEqualTo(ms.get("id").asText());
        assertThat(berechnete(w)).isEqualTo(1);
        assertThat(root.queryForList("SELECT art || ':' || actor_sub FROM messstelle_aenderung WHERE messstelle_id = ?::uuid",
                String.class, ms.get("id").asText())).containsExactly("angelegt:sub-" + w.mandant());
        assertThat(root.queryForObject("SELECT neu->>'herkunft' FROM messstelle_aenderung WHERE messstelle_id = ?::uuid",
                String.class, ms.get("id").asText())).isEqualTo("vorschlag_rest_anlegen");
    }

    /** Ein Hauptzähler, der schon eine Rest-Messstelle hat, bekommt KEINEN Vorschlag — die Zeile zeigt sie. */
    @Test
    void einHauptzaehlerMitRestMessstelleBekommtKeinenVorschlag() throws Exception {
        Welt w = halle2();
        JsonNode angelegt = ok(ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest",
                Map.of("hauptzaehler_id", w.messstellen().get("MS-10").toString(), "name", "Halle 2 nicht zugeordnet")),
                201);
        JsonNode hz = hauptzaehler(ok(ruf(w, HttpMethod.GET, bilanzPfad(w), null), 200), "MS-10");
        assertThat(hz.get("vorschlag").isNull()).isTrue();
        assertThat(hz.get("rest_messstelle").get("id").asText()).isEqualTo(angelegt.get("messstelle").get("id").asText());
        assertThat(hz.get("rest_messstelle").get("name").asText()).isEqualTo("Halle 2 nicht zugeordnet");
        // Die Rest-Zeile steht trotzdem da — sie hing nie an der Messstelle.
        assertThat(hz.get("abschnitte").get(0).get("werte").get(0).get("rest").get("kundensatz").isNull()).isFalse();
    }

    /**
     * Zwei Menschen klicken GLEICHZEITIG: es entsteht genau eine Messstelle, beide Antworten nennen sie.
     * Die Sperre je Hauptzähler reiht die Transaktionen, der eindeutige Index steht dahinter.
     */
    @Test
    void zweiGleichzeitigeKlicksErgebenEineMessstelle() throws Exception {
        Welt w = halle2();
        Map<String, Object> klick = Map.of("hauptzaehler_id", w.messstellen().get("MS-10").toString());
        int n = 4;
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            List<Future<Antwort>> antworten = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                Callable<Antwort> c = () -> {
                    start.await();
                    return ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest", klick);
                };
                antworten.add(pool.submit(c));
            }
            start.countDown();
            List<Integer> status = new ArrayList<>();
            List<String> ids = new ArrayList<>();
            for (Future<Antwort> f : antworten) {
                Antwort a = f.get();
                status.add(a.status());
                ids.add(a.body().get("messstelle").get("id").asText());
            }
            assertThat(status).containsOnly(200, 201);
            assertThat(status.stream().filter(s -> s == 201)).hasSize(1);
            assertThat(ids).containsOnly(ids.get(0));
        } finally {
            pool.shutdownNow();
        }
        assertThat(berechnete(w)).isEqualTo(1);
    }

    /** Nur ein Hauptzähler Bezug DIESER Anlage bekommt einen Rest; eine Ablehnung schreibt nichts. */
    @Test
    void einUnterzaehlerBekommtKeinenRestUndDieAnfrageWirdStrengGelesen() throws Exception {
        Welt w = halle2();
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        Antwort unter = ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest",
                Map.of("hauptzaehler_id", w.messstellen().get("MS-11").toString()));
        assertThat(unter.status()).isEqualTo(422);
        assertThat(unter.body().get("code").asText()).isEqualTo("rest_ohne_hauptzaehler");
        assertThat(unter.body().get("hauptzaehler").asText()).isEqualTo("MS-11");
        Antwort camel = ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest",
                Map.of("hauptzaehlerId", w.messstellen().get("MS-10").toString()));
        assertThat(camel.status()).isEqualTo(400);
        assertThat(camel.body().get("feld").asText()).isEqualTo("hauptzaehlerId");
        Antwort periode = ruf(w, HttpMethod.GET, bilanzPfad(w) + "?periode=woche", null);
        assertThat(periode.status()).isEqualTo(400);
        assertThat(periode.body().get("feld").asText()).isEqualTo("periode");
        assertThat(ruf(w, HttpMethod.GET, bilanzPfad(w) + "?am=13.09.2026", null).body().get("feld").asText())
                .isEqualTo("am");
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    // ============================================================= E3: der Rest folgt der Stellung

    /**
     * DER KERN VON E3: der Rest ist eine Rechnung aus der Stellung, keine gespeicherte Zahl. MS-14 zieht am
     * 02.03.2026 in eine andere Anlage um (Unterzähler von MS-20). Niemand fasst eine Formel an — die
     * Rest-Messstelle von MS-10 behält Zeile für Zeile ihre Fassung und hat weiter keinen Term — und doch
     * rechnet der Rest am 02.03. ohne MS-14 (100 − 60 − 20 − 5 = 15 kWh), am 01.03. weiter mit ihm (5 kWh).
     * Der Monat März zeigt die zwei Abschnitte Tag für Tag.
     */
    @Test
    void eineGeaenderteStellungAendertDenRestOhneDassEtwasNachgepflegtWird() throws Exception {
        Welt w = halle2();
        LocalDate erster = LocalDate.parse("2026-03-01");
        LocalDate zweiter = LocalDate.parse("2026-03-02");
        for (LocalDate tag : List.of(erster, zweiter)) {
            tageswert(w, "MS-10", tag, "100");
            tageswert(w, "MS-11", tag, "60");
            tageswert(w, "MS-12", tag, "20");
            tageswert(w, "MS-13", tag, "5");
            tageswert(w, "MS-14", tag, "10");
        }
        ok(ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest",
                Map.of("hauptzaehler_id", w.messstellen().get("MS-10").toString())), 201);

        JsonNode vorUmzug = tag(w, zweiter);
        assertThat(rest(vorUmzug)).isEqualByComparingTo("5");
        assertThat(rest(vorUmzug).toPlainString()).isNotEqualTo("0");
        assertThat(texte(rest(vorUmzug, "kennzeichen"))).contains("berechnet (Differenz)", "nicht zugeordnet");
        assertThat(vorUmzug.get("rest").get("kundensatz").asText()).isEqualTo("5 kWh sind keiner Messstelle zugeordnet");
        assertThat(vorUmzug.get("zugeordnet").get("menge").decimalValue()).isEqualByComparingTo("95");
        assertThat(vorUmzug.get("zugeordnet").get("mit_werten").asInt()).isEqualTo(4);

        String formelVorher = Bestandsschutz.inhalt(root, "messstelle_formel_fassung", "tenant_id = ?", w.mandant());
        String termeVorher = Bestandsschutz.inhalt(root, "messstelle_formel_term", "tenant_id = ?", w.mandant());

        // Der Umzug: nur die STELLUNG ändert sich (wie PUT …/stellung es schreibt) — keine Formel.
        UUID anlage2 = anlage(w, "Werk Ahrenberg – Halle 3");
        UUID ms20 = messstelle(w, "MS-20", anlage2, "Hauptzähler", null, "2020-01-01");
        root.update("UPDATE messstelle_stellung SET gueltig_bis = ? WHERE messstelle_id = ?", erster,
                w.messstellen().get("MS-14"));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,'Unterzähler',?,?)", w.mandant(), w.messstellen().get("MS-14"), anlage2,
                ms20, zweiter);

        JsonNode nachUmzug = tag(w, zweiter);
        assertThat(rest(nachUmzug)).as("100 − 60 − 20 − 5").isEqualByComparingTo("15");
        assertThat(nachUmzug.get("eingaenge")).extracting(e -> e.get("messstelle").asText())
                .containsExactly("MS-10", "MS-11", "MS-12", "MS-13");
        assertThat(rest(tag(w, erster))).as("der Vortag rechnet mit seiner Stellung").isEqualByComparingTo("5");

        assertThat(Bestandsschutz.inhalt(root, "messstelle_formel_fassung", "tenant_id = ?", w.mandant()))
                .as("keine Formel wurde nachgepflegt").isEqualTo(formelVorher);
        assertThat(Bestandsschutz.inhalt(root, "messstelle_formel_term", "tenant_id = ?", w.mandant()))
                .as("ein Rest hat keine Terme").isEqualTo(termeVorher);

        // Der Monat: zwei Abschnitte, jeder Tag für Tag — eine Zahl über den ganzen März bringt IP-10.
        JsonNode maerz = hauptzaehler(ok(ruf(w, HttpMethod.GET, bilanzPfad(w) + "?periode=monat&am=2026-03-15", null),
                200), "MS-10");
        assertThat(maerz.get("stellung_geaendert").asBoolean()).isTrue();
        assertThat(maerz.get("abschnitte")).hasSize(2);
        assertThat(maerz.get("abschnitte").get(0).get("bis").asText()).isEqualTo("2026-03-01");
        assertThat(maerz.get("abschnitte").get(1).get("von").asText()).isEqualTo("2026-03-02");
        assertThat(maerz.get("abschnitte").get(1).get("raster").asText()).isEqualTo("tag");
        JsonNode dritter = maerz.get("abschnitte").get(1).get("werte").get(1);
        assertThat(dritter.get("von").asText()).isEqualTo("2026-03-03");
        assertThat(dritter.get("rest").get("menge").isNull()).as("ohne Tageswerte keine Werte — nie 0").isTrue();
        assertThat(dritter.get("rest").get("kundensatz").asText()).isEqualTo("nicht zugeordnet: keine Werte");

        // Halle 3 sieht MS-14 ab dem 02.03. als zugeordnet — derselbe Umzug, dieselbe Stellung.
        JsonNode halle3 = hauptzaehler(ok(ruf(w, HttpMethod.GET, "/api/v1/sites/" + anlage2 + "/bilanz?periode=tag&am="
                + zweiter, null), 200), "MS-20");
        assertThat(halle3.get("abschnitte").get(0).get("terme")).extracting(t -> t.get("messstelle").asText())
                .containsExactly("MS-20", "MS-14");
    }

    // ================================================================ Register-Aggregat

    /**
     * AP-10 IP-12: der Rest der Bilanz je Anlage trägt seine HERKUNFT. Werk Lindach am 18.10.2026 (F1): gelesen am
     * 19.10.2026 um 00:12 (MESZ), liefert die Route am Rest den Satz Zeichen für Zeichen wie die Prüfung
     * {@code herkunft} von F1 — Rest-Messstelle MS-22 mit Formel-Fassung 1, die drei Eingänge aus der Stellung mit
     * Rolle und Version. Ohne bestätigte Rest-Messstelle (Halle 2) gibt es keinen halben Satz: {@code satz} null,
     * {@code fehlt} nennt Messstelle und Formel-Fassung.
     */
    @Test
    void f1DerRestDerBilanzTraegtSeineHerkunftByteGleichZumVektor() throws Exception {
        LocalDate tag = LocalDate.parse("2026-10-18");
        Welt w = lindach();
        tageswert(w, "MS-16", tag, "100");
        tageswert(w, "MS-17", tag, "60");
        tageswert(w, "MS-18", tag, "30");
        bilanzService.uhrStellen(Clock.fixed(Instant.parse("2026-10-18T22:12:00Z"), ZoneId.of("UTC")));
        try {
            JsonNode hz = hauptzaehler(ok(ruf(w, HttpMethod.GET, bilanzPfad(w) + "?periode=tag&am=" + tag, null), 200),
                    "MS-16");
            JsonNode werte = hz.get("abschnitte").get(0).get("werte").get(0);
            assertThat(rest(werte)).isEqualByComparingTo("10");
            assertThat(BilanzwertHerkunftVektor.route(rest(werte, "herkunft")))
                    .isEqualTo(BilanzwertHerkunftVektor.umschlag("bilanz-vectors.json", "F1"));

            Welt ohneRest = halle2();
            tageswert(ohneRest, "MS-10", tag, "100");
            JsonNode herkunft = rest(tag(ohneRest, tag), "herkunft");
            assertThat(herkunft.get("satz").isNull()).as("kein halber Satz").isTrue();
            assertThat(texte(herkunft.get("fehlt"))).containsExactly("messstelle", "formel_fassung");
        } finally {
            bilanzService.uhrStellen(Clock.systemUTC());
        }
    }

    /**
     * Berechnete Messstellen zählen im Register-Aggregat mit (bis IP-9: „berechnete zählen erst mit AP-10“):
     * die Rest-Messstelle ist „Vollständig“, solange alle Eingänge der Stellung liefern, und „Unvollständig
     * (fehlt: MS-12)“, wenn einer schweigt — dann liefert sie im Aggregat nicht.
     */
    @Test
    void berechneteMessstellenZaehlenImRegisterAggregatMit() throws Exception {
        Welt w = halle2();
        Instant jetzt = Instant.now();
        leistungen(w, jetzt);
        for (String kz : MOMENTAUFNAHME_W.keySet()) {
            probe(w, kz, ENERGIE, 1000.0, jetzt);
        }
        String rest = ok(ruf(w, HttpMethod.POST, bilanzPfad(w) + "/rest",
                Map.of("hauptzaehler_id", w.messstellen().get("MS-10").toString())), 201)
                .get("messstelle").get("kennzeichen").asText();

        JsonNode register = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen", null), 200);
        assertThat(register.get("aggregat").get("unternehmen").get("gesamt").asInt()).isEqualTo(6);
        assertThat(register.get("aggregat").get("unternehmen").get("erfuellt").asInt()).isEqualTo(6);
        JsonNode zeile = registerZeile(register, rest);
        assertThat(zeile.get("beobachtung").isNull()).isTrue();
        assertThat(zeile.get("berechnung").get("zustand").asText()).isEqualTo("vollstaendig");
        assertThat(zeile.get("berechnung").get("text").asText()).isEqualTo("Vollständig");
        assertThat(registerZeile(register, "MS-11").get("berechnung").isNull()).isTrue();

        // MS-12 schweigt seit einer Stunde: die gemessene liefert nicht, der Rest ist unvollständig.
        root.update("DELETE FROM device_measurement_sample WHERE device_id = ? AND point_key = ?",
                w.boxen().get("MS-12"), ENERGIE);
        probe(w, "MS-12", ENERGIE, 1000.0, jetzt.minus(Duration.ofHours(1)));
        JsonNode spaeter = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen", null), 200);
        assertThat(spaeter.get("aggregat").get("unternehmen").get("gesamt").asInt()).isEqualTo(6);
        assertThat(spaeter.get("aggregat").get("unternehmen").get("erfuellt").asInt()).isEqualTo(4);
        JsonNode unvollstaendig = registerZeile(spaeter, rest).get("berechnung");
        assertThat(unvollstaendig.get("zustand").asText()).isEqualTo("unvollstaendig");
        assertThat(texte(unvollstaendig.get("fehlend"))).containsExactly("MS-12");
        assertThat(unvollstaendig.get("text").asText()).contains("(fehlt: MS-12)");
    }

    // ============================================================= Mandantenzaun

    /** Eine fremde Anlage ist 404 — lesen UND anlegen; ein fremder Hauptzähler ist nicht da; nichts entsteht. */
    @Test
    void eineFremdeAnlageIst404UndDerMandantenzaunHaelt() throws Exception {
        Welt a = halle2();
        Welt b = halle2();
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        assertThat(ruf(b, HttpMethod.GET, bilanzPfad(a), null).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.POST, bilanzPfad(a) + "/rest",
                Map.of("hauptzaehler_id", a.messstellen().get("MS-10").toString())).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.POST, bilanzPfad(b) + "/rest",
                Map.of("hauptzaehler_id", a.messstellen().get("MS-10").toString())).status()).isEqualTo(404);
        assertThat(ruf(a, HttpMethod.GET, "/api/v1/sites/" + UUID.randomUUID() + "/bilanz", null).status()).isEqualTo(404);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        // Die eigene Bilanz nennt nur die eigenen Messstellen.
        JsonNode eigene = ok(ruf(b, HttpMethod.GET, bilanzPfad(b), null), 200);
        assertThat(eigene.get("hauptzaehler")).hasSize(1);
        assertThat(eigene.get("hauptzaehler").get(0).get("messstelle").get("id").asText())
                .isEqualTo(b.messstellen().get("MS-10").toString());
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID anlage, String anlageName, Map<String, UUID> messstellen,
            Map<String, UUID> komponenten, Map<String, UUID> boxen) {}

    /** Halle 2: MS-10 Hauptzähler, MS-11 … MS-14 Unterzähler von MS-10, jeweils mit Energie und Leistung. */
    private Welt halle2() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Bilanz-Probe #" + nr);
        String name = "Werk Ahrenberg – Halle 2 #" + nr;
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        Welt w = new Welt(t, anlage, name, new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>());
        UUID ms10 = messstelle(w, "MS-10", anlage, "Hauptzähler", null, "2020-01-01");
        for (String kz : List.of("MS-11", "MS-12", "MS-13", "MS-14")) {
            messstelle(w, kz, anlage, "Unterzähler", ms10, "2020-01-01");
        }
        return w;
    }

    /** Werk Lindach (AN-3, F1): MS-16 Hauptzähler, MS-17/MS-18 Unterzähler, die bestätigte Rest-Messstelle MS-22. */
    private Welt lindach() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Bilanz-Probe Lindach #" + nr);
        String name = "Werk Lindach #" + nr;
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        Welt w = new Welt(t, anlage, name, new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>());
        UUID ms16 = messstelle(w, "MS-16", anlage, "Hauptzähler", null, "2020-01-01");
        messstelle(w, "MS-17", anlage, "Unterzähler", ms16, "2020-01-01");
        messstelle(w, "MS-18", anlage, "Unterzähler", ms16, "2020-01-01");
        UUID ms22 = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-22', 'Lindach nicht zugeordnet', 'berechnet', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art, rest_hauptzaehler_id) VALUES (?, ?, 1, 'rest', 'anlage', 'sub-test', "
                + "'Test', 'kunde', ?)", t, ms22, ms16);
        w.messstellen().put("MS-22", ms22);
        return w;
    }

    private UUID anlage(Welt w, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, w.mandant(), name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
    }

    /** Box, Komponente, Mess-Selektion beider Kanäle, Messstelle mit Nebengröße, zwei führende Quellen, Stellung. */
    private UUID messstelle(Welt w, String kennzeichen, UUID anlage, String stellung, UUID unterzaehlerVon, String ab) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-BILANZ-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, anlage,
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        for (String kanal : List.of(ENERGIE, LEISTUNG)) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                    + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, anlage, box, komponente, kanal, KATALOG);
        }
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_groesse (tenant_id, messstelle_id, medium, groesse, richtung, einheit, wertart) "
                + "VALUES (?, ?, 'Strom', 'Wirkleistung', 'Bezug', 'kW', 'Momentanwert')", t, messstelle);
        Timestamp beginn = Timestamp.from(Instant.parse(ab + "T00:00:00Z"));
        Timestamp eingetragen = Timestamp.from(Instant.parse(ab + "T00:01:00Z"));
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, beginn, eingetragen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkleistung','Bezug',?,?,?,'gauge','momentanwert','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, LEISTUNG, beginn, eingetragen);
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, anlage, stellung, unterzaehlerVon, LocalDate.parse(ab));
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
        w.boxen().put(kennzeichen, box);
        return messstelle;
    }

    /** Die Momentaufnahme 20.10.2026 10:15 als frische Leistungswerte (W) — je Box und Kanal. */
    private void leistungen(Welt w, Instant zeit) {
        MOMENTAUFNAHME_W.forEach((kz, watt) -> probe(w, kz, LEISTUNG, watt, zeit));
    }

    private void probe(Welt w, String kennzeichen, String kanal, double wert, Instant zeit) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind) "
                + "VALUES (?, ?, ?, (SELECT site_id FROM device WHERE id = ?), ?, ?, ?, ?, 'good', ?, ?, ?)",
                Timestamp.from(zeit), Timestamp.from(zeit), w.mandant(), w.boxen().get(kennzeichen),
                w.boxen().get(kennzeichen), kanal, wert, wert, KATALOG, SEQ.incrementAndGet(),
                ENERGIE.equals(kanal) ? "counter" : "gauge");
    }

    /** Ein endgültiger, vollständiger Tageswert der Reihe einer Messstelle (Speicherklasse AP-07, Menge AP-08 IP-5). */
    private void tageswert(Welt w, String kennzeichen, LocalDate tag, String menge) {
        ZoneId zone = ZoneId.of("Europe/Berlin");
        Instant beginn = tag.atStartOfDay(zone).toInstant();
        Instant ende = tag.plusDays(1).atStartOfDay(zone).toInstant();
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, site_id, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, stand_anfang, "
                + "stand_ende, erhalten, erwartet, abdeckung_prozent, n_good, box, rolle, zustand, endgueltig_ab, version, "
                + "menge, menge_zustand) VALUES (?, ?, ?, ?, (SELECT site_id FROM device WHERE id = ?), 'Europe/Berlin', "
                + "'vorgabe', ?, ?, 24, 96, 96, 96, 'counter', 0, ?::numeric, 1440, 1440, 100, 1440, ?, 'fuehrend', "
                + "'endgueltig', ?, 1, ?::numeric, 'vollständig')",
                tag, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE, w.boxen().get(kennzeichen),
                Timestamp.from(beginn), Timestamp.from(ende), menge, w.boxen().get(kennzeichen),
                Timestamp.from(ende.plus(Duration.ofDays(7))), menge);
    }

    // ================================================================ das Gerüst

    private static String bilanzPfad(Welt w) {
        return "/api/v1/sites/" + w.anlage() + "/bilanz";
    }

    private JsonNode tag(Welt w, LocalDate tag) throws Exception {
        JsonNode hz = hauptzaehler(ok(ruf(w, HttpMethod.GET, bilanzPfad(w) + "?periode=tag&am=" + tag, null), 200),
                "MS-10");
        assertThat(hz.get("abschnitte")).hasSize(1);
        return hz.get("abschnitte").get(0).get("werte").get(0);
    }

    private static java.math.BigDecimal rest(JsonNode werte) {
        JsonNode menge = werte.get("rest").get("menge");
        assertThat(menge.isNull()).as("Rest " + werte.get("rest")).isFalse();
        return menge.decimalValue();
    }

    private static JsonNode rest(JsonNode werte, String feld) {
        return werte.get("rest").get(feld);
    }

    private static JsonNode hauptzaehler(JsonNode bilanz, String kennzeichen) {
        for (JsonNode hz : bilanz.get("hauptzaehler")) {
            if (hz.get("messstelle").get("kennzeichen").asText().equals(kennzeichen)) {
                return hz;
            }
        }
        throw new AssertionError(kennzeichen + " fehlt in " + bilanz);
    }

    private static JsonNode registerZeile(JsonNode register, String kennzeichen) {
        for (JsonNode z : register.get("register")) {
            if (z.get("kennzeichen").asText().equals(kennzeichen)) {
                return z;
            }
        }
        throw new AssertionError(kennzeichen + " fehlt im Register");
    }

    private long berechnete(Welt w) {
        return root.queryForObject("SELECT count(*) FROM messstelle WHERE tenant_id = ? AND art = 'berechnet'", Long.class,
                w.mandant());
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static String sqlState(Runnable r) {
        try {
            r.run();
            return "kein Fehler";
        } catch (RuntimeException e) {
            return String.valueOf(e.getMessage());
        }
    }

    private record Antwort(int status, JsonNode body) {}

    private static JsonNode ok(Antwort a, int status) {
        assertThat(a.status()).as("Antwort " + a.body()).isEqualTo(status);
        return a.body();
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + w.mandant());
                    j.claim("name", "Ines Test");
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
