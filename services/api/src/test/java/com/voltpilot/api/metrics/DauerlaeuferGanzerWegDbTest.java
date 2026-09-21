package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.ApiApplication;
import com.voltpilot.api.repo.FleetMetricsRepository;
import com.voltpilot.api.repo.UemsMetricsRepository;
import com.voltpilot.api.uems.KennzahlAufrufer;
import com.voltpilot.api.uems.KorrekturRechte;
import com.voltpilot.api.uems.LueckenMelder;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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
 * NW-6 im Kleinen (AP-14 IP-18, Kasten E11): „Geht der ganze Weg Box → Alarm-Kennzahl?“ — so weit, wie
 * das Repo ihn heute in EINEM Lauf trägt, mit der Einrichtung aus Drehbuch §14.1/§14.2 über die
 * Produktivwege.
 *
 * <p><b>Höhe dieses Laufs.</b> api, Writer und ingest sind getrennte Maven-Module; aus dem api-Modul ist
 * weder der Writer noch ingest startbar (dieselbe Naht wie NW-4, {@code UemsMesskundenLaufAbnahmeTest}).
 * Echt sind hier: jede Einrichtungs-Route (Kundenbereich über die Plattformverwaltung, Standort, zwei
 * Anlagen „nur messen“, Funktion „Messen“, zwei Boxen über {@code POST /api/v1/devices/claim} wie
 * {@code provision-device.sh}, je Messstelle eine Komponente, der Versuch der Mess-Auswahl), der
 * Lücken-Melder, der UEMS-Sammler samt Prometheus-Scrape und der Flotten-Sammler mit dem Schalter. Die
 * Umschläge sind die des echten Dauerläufers ({@code tools/edge-simulator/abnahme/dauerlaeufer-nw6.json},
 * erzeugt von {@code uems_dauerlaeufer.umschlag}, gebunden über ihre sha256). NICHT durchlaufen: MQTT,
 * ingest und der Writer — die Zeilen entstehen an der Naht genau so, wie sie der echte Writer mit diesen
 * Umschlägen schreibt; das belegt {@code DauerlaeuferWriterNahtTest} (timescale-writer, Redpanda + Writer).
 *
 * <p><b>Der Befund.</b> Die Einrichtung aus §14.2 genügt NICHT. Die Punktschlüssel des Simulators
 * ({@code custom.ms-05.wirkenergie-bezug} …) nimmt die Mess-Auswahl über keinen Produktivweg an: die
 * Katalog-Route antwortet 400, die Route für eigene Messwerte vergibt ihren Schlüssel selbst
 * ({@code custom.<32 hex>}). Ohne Auswahlzeile verwirft der Writer jeden Wert
 * ({@code MeasurementWriteRepository.java:145-150}), der Lücken-Melder schreibt keinen Stand, und das
 * Messkunden-Alter des Dauerläufers hat keine Reihe — {@code VoltPilotDauerlaeuferStumm} sieht nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(classes = ApiApplication.class)
@AutoConfigureMockMvc
class DauerlaeuferGanzerWegDbTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final Path VORLAGE =
            Path.of("..", "..", "tools", "edge-simulator", "abnahme", "dauerlaeufer-nw6.json");

    /** Das „Jetzt“ der Vorlage: ihr letzter Takt liegt eine Minute davor. */
    private static final Instant NOW = Instant.parse("2026-11-03T10:00:00Z");
    /** ingest stempelt den Eingang; wie NW-4 zwei Sekunden nach der Messzeit. */
    private static final Duration EINGANG = Duration.ofSeconds(2);
    /** Die Schwelle von {@code VoltPilotDauerlaeuferStumm}: mehr als 15 Minuten ohne Messwert. */
    private static final double STUMM_S = 900;

    private static final Pattern MESSSTELLE = Pattern.compile("^custom\\.ms-(\\d{2})\\.");

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    /** Der ECHTE Lücken-Melder; sein Takt ist im Testlauf aus, der Lauf ruft ihn mit der eigenen Uhr. */
    @Autowired
    LueckenMelder melder;

    @MockBean
    KennzahlAufrufer aufrufer;

    private final Map<String, Benutzer> personen = new LinkedHashMap<>();
    private JdbcTemplate root;
    private JdbcTemplate admin;
    private UUID kb;

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeEach
    void rechte() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        doAnswer(inv -> {
            ProtokollAkteur a = inv.getArgument(0);
            Benutzer b = personen.get(a.sub());
            return b != null ? b : KorrekturRechte.benutzer(a);
        }).when(aufrufer).benutzer(any());
        personen.put("kc-dauerlaeufer", new Benutzer("kc-dauerlaeufer", "Dauerläufer-Benutzer",
                Konto.vonCode("benutzer"), KontoZustand.AKTIV, List.of(new Zuweisung(
                        Rolle.vonCode("kundenadministrator"), null, null, null, Instant.EPOCH, null, null))));
    }

    @Test
    void nw6DerWegVomSimulatorBisZurAlarmKennzahlUndWoErHeuteAbreisst() throws Exception {
        JsonNode vorlage = vorlage();

        // ============================== §14.1 — Kundenbereich über die Plattformverwaltung
        Antwort angelegt = ok(ruf(true, HttpMethod.POST, "/api/v1/admin/tenants",
                Map.of("name", "VoltPilot Dauerläufer (intern)")), 201);
        kb = UUID.fromString(angelegt.body().path("id").asText());
        assertThat(kb.toString()).as("die Plattform vergibt die Kennung, klein und kanonisch")
                .isEqualTo(angelegt.body().path("id").asText().toLowerCase());

        // ============================== §14.2 Schritt 1 — Standort, zwei Anlagen „nur messen“, Messen
        Map<String, Object> adresse = new LinkedHashMap<>();
        adresse.put("strasse", "Werkstraße 1");
        adresse.put("plz", null);
        adresse.put("ort", "Ahrenberg");
        adresse.put("land", "DE");
        UUID standort = id(ok(ruf(false, HttpMethod.POST, "/api/v1/standorte", Map.of("name", "Werk Dauerläufer",
                "zeitzone", "Europe/Berlin", "adresse", adresse)), 201));
        Map<String, UUID> anlagen = new LinkedHashMap<>();
        anlagen.put("E-1", id(ok(ruf(false, HttpMethod.POST, "/api/v1/sites",
                Map.of("name", "AN-1 (Halle 1)", "standortId", standort.toString())), 201)));
        anlagen.put("E-2", id(ok(ruf(false, HttpMethod.POST, "/api/v1/sites",
                Map.of("name", "AN-2 (Halle 2)", "standortId", standort.toString())), 201)));
        Antwort messen = ruf(false, HttpMethod.PUT, "/api/v1/standorte/" + standort + "/funktionen/messen",
                Map.of("aktion", "einrichten"));
        assertThat(messen.status()).as(messen.text()).isIn(200, 201);

        // ============================== §14.2 Schritt 2 — zwei Boxen anmelden, wie provision-device.sh
        Map<String, UUID> boxen = new LinkedHashMap<>();
        for (String code : anlagen.keySet()) {
            boxen.put(code, id(ok(ruf(false, HttpMethod.POST, "/api/v1/devices/claim", Map.of(
                    "siteId", anlagen.get(code).toString(),
                    "externalRef", "dauerlaeufer-" + code.toLowerCase().replace("-", ""))), 201)));
        }

        // ============================== §14.2 Schritt 3 — je Messstelle eine Komponente, dann die Auswahl
        Map<String, UUID> komponente = new LinkedHashMap<>();
        Map<String, String> boxDesSchluessels = new LinkedHashMap<>();
        for (JsonNode b : vorlage.path("boxen")) {
            String code = b.path("code").asText();
            for (JsonNode k : b.path("point_keys")) {
                String messstelle = messstelle(k.asText());
                Antwort a = ruf(false, HttpMethod.POST, "/api/v1/sites/" + anlagen.get(code) + "/measurement-points",
                        Map.of("role", "consumer", "label", messstelle));
                assertThat(a.status()).as(a.text()).isIn(200, 201);
                komponente.put(k.asText(), root.queryForObject("SELECT id FROM measurement_point "
                        + "WHERE tenant_id = ? AND site_id = ? AND label = ?", UUID.class, kb, anlagen.get(code),
                        messstelle));
                boxDesSchluessels.put(k.asText(), code);
            }
        }
        assertThat(komponente).hasSize(9);

        // --- BEFUND 1: die Katalog-Route nimmt keinen Schlüssel des Simulators an.
        for (Map.Entry<String, UUID> e : komponente.entrySet()) {
            UUID box = boxen.get(boxDesSchluessels.get(e.getKey()));
            Antwort a = ruf(false, HttpMethod.PUT, "/api/v1/devices/" + box + "/measurement-selection/" + e.getKey()
                    + "?entityId=" + e.getValue(), Map.of("expectedRevision", revision(box),
                    "idempotencyKey", UUID.randomUUID().toString(), "enabled", true));
            assertThat(a.status()).as(e.getKey() + ": " + a.text()).isEqualTo(400);
            assertThat(a.text()).contains("Dieser Katalog-Messpunkt ist nicht lesbar oder unbekannt.");
        }

        // --- BEFUND 2: die Route für eigene Messwerte ordnet zu, vergibt den Schlüssel aber selbst.
        String ms05 = "custom.ms-05.wirkenergie-bezug";
        UUID e1 = boxen.get("E-1");
        Antwort eigen = ok(ruf(false, HttpMethod.POST, "/api/v1/devices/" + e1 + "/measurement-selection/custom"
                + "?entityId=" + komponente.get(ms05), Map.of("expectedRevision", revision(e1),
                "idempotencyKey", UUID.randomUUID().toString(), "definition", eigenerZaehlerstand())), 200);
        List<String> vergeben = new ArrayList<>();
        eigen.body().path("selections").forEach(s -> vergeben.add(s.path("pointKey").asText()));
        assertThat(vergeben).hasSize(1).allMatch(k -> k.matches("custom\\.[0-9a-f]{32}")).doesNotContain(ms05);
        assertThat(zahl("SELECT count(*) FROM device_measurement_selection WHERE tenant_id = ? "
                + "AND point_key LIKE 'custom.ms-%'", kb))
                .as("keine Auswahlzeile für die Schlüssel des Simulators: der Writer verwirft jeden Wert "
                        + "(MeasurementWriteRepository.java:145-150)").isZero();

        // --- Die Folge am echten Lücken-Melder und Sammler: es kommt nichts an, das Alter hat keine Reihe.
        MutableUhr uhr = new MutableUhr(NOW.minus(Duration.ofMinutes(10)));
        melder.lauf(uhr.instant());
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        UemsMetricsCollector sammler = new UemsMetricsCollector(new UemsMetricsRepository(admin),
                new UemsLaeuferMelder(registry), new MockEnvironment(), registry, uhr);
        sammler.collect();
        String alter = UemsMetricsCollector.MESSWERT_ALTER + "{tenant=\"" + kb + "\"}";
        assertThat(zeile(registry.scrape(), alter)).as("heute: der Alarm hat keine Reihe").isNull();

        // ============================== Naht zum Writer: die Zeilen, die er schriebe, WENN die Zuordnung stünde
        // Genau die Zeilen, die DauerlaeuferWriterNahtTest am echten Writer mit voll eingerichteter, aber nie
        // quittierter Auswahl sieht: der erste Takt ohne Zuordnung (keine Fassung), ab dem zweiten mit
        // Komponente und Rolle „beobachtung“. Die Werte kommen Zahl für Zahl aus den Umschlägen des
        // Dauerläufers; Mandant, Anlage und Box sind die, die die Plattform eben vergeben hat.
        Instant ersterTakt = Instant.parse(vorlage.path("zustellungen").get(0).path("nutzlast")
                .path("observed_at").asText());
        List<Object[]> zugeordnet = new ArrayList<>();
        List<Object[]> ohneZuordnung = new ArrayList<>();
        for (JsonNode z : vorlage.path("zustellungen")) {
            JsonNode n = z.path("nutzlast");
            String code = z.path("box").asText();
            assertThat(z.path("topic").asText()).isEqualTo("ems/" + n.path("tenant_id").asText() + "/"
                    + n.path("site_id").asText() + "/" + n.path("device_id").asText() + "/v2/measurement-samples");
            for (JsonNode s : n.path("samples")) {
                Instant messzeit = Instant.parse(s.path("observed_at").asText());
                boolean erster = messzeit.equals(ersterTakt);
                (erster ? ohneZuordnung : zugeordnet).add(new Object[] {Timestamp.from(messzeit),
                        Timestamp.from(messzeit.plus(EINGANG)), kb, anlagen.get(code), boxen.get(code),
                        s.path("point_key").asText(), s.path("raw").decimalValue(), s.path("decoded").decimalValue(),
                        s.path("quality").asText(), n.path("catalog_version").asText(), n.path("sequence").asLong(),
                        erster ? null : komponente.get(s.path("point_key").asText())});
            }
        }
        assertThat(ohneZuordnung).hasSize(9);
        assertThat(zugeordnet).hasSize(4 * 9);
        String spalten = "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, entity_id, "
                + "aggregation_kind, applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, "
                + "?, ?, ?, ?, ?, ?::uuid, 'counter', ";
        root.batchUpdate(spalten + "NULL, NULL, NULL, NULL, NULL)", ohneZuordnung);
        root.batchUpdate(spalten + "1, 'counter', 'beobachtung', 'direkt', 2)", zugeordnet);

        // ============================== NW-6 (1): der Melder schreibt seinen Stand, das Alter ist klein
        uhr.stellen(NOW.plus(Duration.ofSeconds(90)));
        melder.lauf(uhr.instant());
        Instant juengster = Instant.parse("2026-11-03T09:59:00Z").plus(EINGANG);
        assertThat(root.queryForList("SELECT zuletzt FROM messreihe_luecke_stand WHERE tenant_id = ? AND art = 'box' "
                + "ORDER BY device_id", Timestamp.class, kb)).extracting(Timestamp::toInstant)
                .as("je Box ein Stand, aus den zugeordneten Werten").containsExactly(juengster, juengster);
        sammler.collect();
        assertThat(wert(registry.scrape(), alter)).as("Dauerbetrieb: frisch")
                .isEqualTo(Duration.between(juengster, uhr.instant()).toSeconds()).isLessThan(STUMM_S);
        assertThat(registry.scrape()).as("PR 37 vergleicht das Etikett wörtlich: kanonisch, klein")
                .contains("tenant=\"" + kb.toString().toLowerCase() + "\"");

        // ============================== NW-6 (2): Zufuhr angehalten, die Uhr 16 Minuten weiter — nicht gewartet
        uhr.stellen(uhr.instant().plus(Duration.ofMinutes(16)));
        melder.lauf(uhr.instant());
        sammler.collect();
        assertThat(wert(registry.scrape(), alter)).as("über der Grenze von VoltPilotDauerlaeuferStumm")
                .isEqualTo(Duration.between(juengster, uhr.instant()).toSeconds()).isGreaterThan(STUMM_S);

        // ============================== NW-6 (3): mit Schalter fehlt er in jeder Flottenkennzahl
        String ohne = flotte(Optional.empty());
        String mit = flotte(Dauerlaeufer.kennung(kb.toString().toUpperCase()));
        for (UUID anlage : anlagen.values()) {
            assertThat(ohne).as("ohne Schalter zählt er mit — der Ausschluss ist nicht leer")
                    .contains("site=\"" + anlage + "\"");
        }
        assertThat(wert(mit, FleetMetricsCollector.SITES + " "))
                .as("der Nenner verliert genau die zwei echten Anlagen des Dauerläufers")
                .isEqualTo(wert(ohne, FleetMetricsCollector.SITES + " ") - 2);
        assertThat(mit.lines().filter(l -> l.startsWith("voltpilot_site")))
                .isNotEmpty()
                .noneMatch(l -> l.contains(kb.toString()))
                .noneMatch(l -> anlagen.values().stream().anyMatch(a -> l.contains(a.toString())));
        assertThat(wert(registry.scrape(), alter)).as("das Messkunden-Alter bleibt sichtbar").isGreaterThan(STUMM_S);
    }

    // ---------------------------------------------------------------------------------------------

    /** Die Vorlage des Simulators — nur geglaubt, wenn ihre Bytes zur danebenliegenden Summe passen. */
    private static JsonNode vorlage() throws Exception {
        byte[] bytes = Files.readAllBytes(VORLAGE);
        String summe = Files.readString(Path.of(VORLAGE + ".sha256"), StandardCharsets.UTF_8).strip();
        assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                .as("Vorlage von Hand geändert? `make abnahme` in tools/edge-simulator").isEqualTo(summe);
        return MAPPER.readTree(bytes);
    }

    private static String messstelle(String pointKey) {
        Matcher m = MESSSTELLE.matcher(pointKey);
        assertThat(m.find()).as(pointKey).isTrue();
        return "MS-" + m.group(1);
    }

    /** Ein lesbarer Zählerstand als eigener Messwert — so, wie ihn das Portal anlegt. */
    private static Map<String, Object> eigenerZaehlerstand() {
        return Map.ofEntries(
                Map.entry("label", "MS-05 Wirkenergie Bezug"),
                Map.entry("sourceKind", "modbus_holding"),
                Map.entry("address", 231),
                Map.entry("selector", "holding:0x00e7"),
                Map.entry("valueType", "uint32"),
                Map.entry("widthBits", 32),
                Map.entry("signed", false),
                Map.entry("endian", "big"),
                Map.entry("scale", 0.1),
                Map.entry("unit", "kWh"),
                Map.entry("cadenceS", 60),
                Map.entry("retentionClass", "energy_counter"),
                Map.entry("readOnly", true));
    }

    private long revision(UUID box) throws Exception {
        return ok(ruf(false, HttpMethod.GET, "/api/v1/devices/" + box + "/measurement-selection", null), 200)
                .body().path("desiredRevision").asLong();
    }

    private String flotte(Optional<UUID> dauerlaeufer) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new FleetMetricsCollector(new FleetMetricsRepository(admin), registry,
                Clock.fixed(NOW, ZoneOffset.UTC), dauerlaeufer).collect();
        return registry.scrape();
    }

    private long zahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static UUID id(Antwort a) {
        return UUID.fromString(a.body().path("id").asText());
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.text()).isEqualTo(status);
        return a;
    }

    /** {@code plattform}: die Plattformverwaltung (§14.1); sonst der Benutzer im Dauerläufer (§14.2). */
    private Antwort ruf(boolean plattform, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, URI.create(pfad))
                .with(plattform
                        ? jwt().jwt(j -> j.subject("kc-betreiber").claim("preferred_username", "Betreiber"))
                                .authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))
                        : jwt().jwt(j -> {
                            j.subject("kc-dauerlaeufer");
                            j.claim("preferred_username", "Dauerläufer-Benutzer");
                            j.claim("tenant_id", kb.toString());
                        }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(),
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text), text);
    }

    private static String zeile(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    private static double wert(String scrape, String prefix) {
        String z = zeile(scrape, prefix);
        assertThat(z).as(prefix).isNotNull();
        return Double.parseDouble(z.substring(z.lastIndexOf(' ') + 1));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource d = new PGSimpleDataSource();
        d.setUrl(POSTGRES.getJdbcUrl());
        d.setUser(user);
        d.setPassword(password);
        return d;
    }

    /** Eine Uhr, die der Test stellt — der Simulator steht, die Zeit läuft, niemand wartet. */
    private static final class MutableUhr extends Clock {
        private Instant jetzt;

        MutableUhr(Instant start) {
            this.jetzt = start;
        }

        void stellen(Instant neu) {
            jetzt = neu;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return jetzt;
        }
    }
}
