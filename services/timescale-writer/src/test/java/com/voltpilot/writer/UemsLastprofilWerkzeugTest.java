package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.errors.TopicExistsException;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.kafka.config.KafkaListenerEndpointRegistry;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-14 IP-8: kurzer geraffter Werkzeug-Beleg auf der Testcontainers-Strecke von AP-07 IP-21.
 *
 * <p>Der Test startet den Python-Lastmodus fuer zwei simulierte Minuten, saeht nur die dazu
 * benoetigten Test-Stammdaten und spielt dessen 2.0-Umschlaege ab {@code measurements.raw} durch
 * den echten Writer in TimescaleDB. Das ist keine 24-h-Abnahme und beruehrt keinen lokalen Stack.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
class UemsLastprofilWerkzeugTest {

    private static final String TOPIC = "measurements.raw";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static List<JsonNode> zustellungen;

    @Autowired
    MeterRegistry meters;

    @Container
    static final RedpandaContainer REDPANDA =
            new RedpandaContainer(DockerImageName.parse("redpandadata/redpanda:v24.2.7"));

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withInitScript("writer-schema.sql");

    @BeforeAll
    static void lastprofilErzeugenUndStammdatenSaeen() throws Exception {
        Path wurzel = Path.of("../..").toAbsolutePath().normalize();
        Process run = new ProcessBuilder("python3", "uems_lastprofil.py", "--profil", "dauerlast",
                "--minuten", "2", "--seed", "14008", "--zustellungen")
                .directory(wurzel.resolve("tools/edge-simulator").toFile())
                .redirectErrorStream(true)
                .start();
        String ausgabe = new String(run.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(run.waitFor()).as(ausgabe).isZero();
        zustellungen = new ArrayList<>();
        for (String zeile : ausgabe.lines().filter(z -> !z.isBlank()).toList()) {
            zustellungen.add(MAPPER.readTree(zeile));
        }
        assertThat(zustellungen).hasSize(16); // 2 min × 4 Boxen × (256 + 69)
        String tenant = zustellungen.get(0).path("nutzlast").path("tenant_id").asText();
        EreignisTabelleImTest.anlegen(POSTGRES, tenant);
        saeen();
    }

    @AfterAll
    static void zuhoererBeenden(@Autowired KafkaListenerEndpointRegistry zuhoerer) {
        zuhoerer.stop();
    }

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("spring.kafka.bootstrap-servers", REDPANDA::getBootstrapServers);
        registry.add("voltpilot.redpanda.measurements-topic", () -> TOPIC);
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> "voltpilot_app");
        registry.add("spring.datasource.password", () -> APP_PW);
    }

    @Test
    void zweiMinutenVierBoxenLandenMitExakterRateImWriter() throws Exception {
        createTopic();
        List<String> keys = new ArrayList<>();
        List<String> pakete = new ArrayList<>();
        Set<String> boxen = new LinkedHashSet<>();
        for (JsonNode zustellung : zustellungen) {
            JsonNode n = zustellung.path("nutzlast");
            boxen.add(n.path("device_id").asText());
            keys.add(n.path("tenant_id").asText() + ":" + n.path("site_id").asText()
                    + ":" + n.path("device_id").asText());
            pakete.add(raw(zustellung));
        }

        long beginn = System.nanoTime();
        senden(keys, pakete);
        warteBis(() -> zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id IN ("
                + sqlListe(boxen) + ")"), 2_600);
        double dauerS = (System.nanoTime() - beginn) / 1_000_000_000.0;

        assertThat(boxen).hasSize(4);
        for (String box : boxen) {
            assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='"
                    + box + "'")).as(box).isEqualTo(650);
        }
        assertThat(zaehle("SELECT count(DISTINCT entity_id) FROM device_measurement_sample "
                + "WHERE device_id IN (" + sqlListe(boxen) + ")")).isEqualTo(100);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id IN ("
                + sqlListe(boxen) + ") AND (role <> 'fuehrend' OR delivery <> 'direkt')")).isZero();
        assertThat(meters.find(WriterVerwerfMetriken.UMSCHLAEGE).counters().stream()
                .mapToDouble(Counter::count).sum()).as("gültige Umschläge").isZero();
        assertThat(meters.find(WriterVerwerfMetriken.SAMPLES).counters().stream()
                .mapToDouble(Counter::count).sum()).as("gültige Samples").isZero();
        System.out.printf("AP14_LASTPROFIL_WERKZEUG samples=2600 boxen=4 minuten=2 "
                + "writer_dauer_s=%.3f writer_rate_samples_min=%.2f%n", dauerS, 2_600 / dauerS * 60);
    }

    private static void saeen() throws Exception {
        JsonNode erste = zustellungen.get(0).path("nutzlast");
        String tenant = erste.path("tenant_id").asText();
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO tenant(id,name) VALUES ('" + tenant + "','Lastprofil') "
                    + "ON CONFLICT DO NOTHING");
            Set<String> boxen = new LinkedHashSet<>();
            Set<String> reihen = new LinkedHashSet<>();
            Set<String> punkte = new LinkedHashSet<>();
            Map<String, String> quelleJeBox = new LinkedHashMap<>();
            for (JsonNode zustellung : zustellungen) {
                JsonNode n = zustellung.path("nutzlast");
                String box = n.path("device_id").asText();
                String site = n.path("site_id").asText();
                if (boxen.add(box)) {
                    String quelle = uuid("quelle:" + box);
                    quelleJeBox.put(box, quelle);
                    st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + box + "','"
                            + tenant + "','" + site + "')");
                    st.execute("INSERT INTO data_source(id,tenant_id,kennzeichen,kadenz_s) VALUES ('"
                            + quelle + "','" + tenant + "','last-" + box
                            + "',60)");
                    st.execute("INSERT INTO data_source_assignment(tenant_id,data_source_id,device_id,"
                            + "effective_from) VALUES ('" + tenant + "','" + quelle + "','" + box
                            + "','2026-01-01T00:00:00Z')");
                }
                for (JsonNode sample : n.path("samples")) {
                    String punkt = sample.path("point_key").asText();
                    if (!punkte.add(box + "|" + punkt)) {
                        continue;
                    }
                    String reihe = punkt.substring(0, punkt.lastIndexOf(".k-"));
                    String entity = uuid("entity:" + reihe);
                    String geraet = uuid("geraet:" + reihe);
                    String messstelle = uuid("messstelle:" + reihe);
                    if (reihen.add(reihe)) {
                        st.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,device_id,"
                                + "data_source_id) VALUES ('" + entity + "','" + tenant + "','" + site
                                + "','grid','" + box + "','" + quelleJeBox.get(box) + "')");
                        st.execute("INSERT INTO geraet(id,tenant_id,site_id,kennzeichen,einbau_kennzeichen,"
                                + "seriennummer,eingebaut_am) VALUES ('" + geraet + "','" + tenant + "','"
                                + site + "','LAST','LAST','" + reihe + "','2026-01-01T00:00:00Z')");
                        st.execute("INSERT INTO geraet_komponente(tenant_id,geraet_id,entity_id,gueltig_ab) "
                                + "VALUES ('" + tenant + "','" + geraet + "','" + entity
                                + "','2026-01-01T00:00:00Z')");
                    }
                    st.execute("INSERT INTO measurement_catalog_point_metadata VALUES ('"
                            + n.path("catalog_version").asText() + "','" + punkt + "','counter',900)");
                    st.execute("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,"
                            + "point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,"
                            + "changed_by,apply_status,applied_at,retention_class,raw_retention_days,"
                            + "long_term_cadence_s,long_term_strategy,entity_id) VALUES ('" + tenant
                            + "','" + site + "','" + box + "','" + punkt + "',true,60,1,"
                            + "'2026-01-01T00:00:00Z','" + n.path("catalog_version").asText()
                            + "','abnahme','applied','2026-01-01T00:00:00Z','energy_counter',90,900,"
                            + "'fifteen_minute','" + entity + "')");
                    st.execute("INSERT INTO messstelle_quelle(tenant_id,messstelle_id,entity_id,geraet_id,"
                            + "kanal,rolle,gueltig_ab) VALUES ('" + tenant + "','" + messstelle + "','"
                            + entity + "','" + geraet + "','" + punkt
                            + "','fuehrend','2026-01-01T00:00:00Z')");
                }
            }
        }
    }

    private static String raw(JsonNode zustellung) throws Exception {
        JsonNode n = zustellung.path("nutzlast");
        var out = MAPPER.createObjectNode();
        out.put("schema_version", "1.0");
        out.put("event_id", UUID.randomUUID().toString());
        for (String feld : List.of("tenant_id", "site_id", "device_id", "catalog_version",
                "observed_at")) {
            out.put(feld, n.path(feld).asText());
        }
        out.put("sequence", n.path("sequence").asLong());
        out.put("ingested_at", zustellung.path("eingangszeit").asText());
        out.put("source_topic", zustellung.path("topic").asText());
        out.put("dropped_samples", 0);
        out.put("gap", false);
        out.set("samples", n.path("samples"));
        return MAPPER.writeValueAsString(out);
    }

    private static void senden(List<String> keys, List<String> pakete) throws Exception {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(props)) {
            for (int i = 0; i < pakete.size(); i++) {
                producer.send(new ProducerRecord<>(TOPIC, keys.get(i), pakete.get(i))).get();
            }
            producer.flush();
        }
    }

    private static void createTopic() throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(TOPIC, 1, (short) 1))).all().get();
        } catch (java.util.concurrent.ExecutionException e) {
            if (!(e.getCause() instanceof TopicExistsException)) {
                throw e;
            }
        }
    }

    private static void warteBis(Zaehlung zaehlung, long erwartet) throws Exception {
        long millis = Duration.ofSeconds(30).toMillis() + erwartet * 100L;
        long deadline = System.nanoTime()
                + Duration.ofMillis(Math.min(millis, Duration.ofMinutes(5).toMillis())).toNanos();
        long ist = -1;
        while (System.nanoTime() < deadline) {
            ist = zaehlung.zaehle();
            if (ist == erwartet) {
                return;
            }
            Thread.sleep(250);
        }
        throw new AssertionError("Lastprofil kam nicht vollstaendig im Writer an: "
                + ist + " statt " + erwartet + " Proben");
    }

    private static Connection admin() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
    }

    private static long zaehle(String sql) throws Exception {
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getLong(1) : -1;
        }
    }

    private static String uuid(String text) {
        return UUID.nameUUIDFromBytes(text.getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static String sqlListe(Set<String> werte) {
        return werte.stream().map(w -> "'" + w + "'").reduce((a, b) -> a + "," + b).orElse("NULL");
    }

    private interface Zaehlung {
        long zaehle() throws Exception;
    }
}
