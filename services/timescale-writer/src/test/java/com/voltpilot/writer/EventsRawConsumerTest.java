package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.function.LongSupplier;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.errors.TopicExistsException;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * The events.raw path end to end (UEMS AP-07 IP-8): Redpanda -> {@link EventsRawConsumer} ->
 * the writer twin of the vocabulary -> {@code messreihe_ereignis} as Flyway builds it (the real
 * migration, {@link EreignisTabelleImTest}).
 *
 * <p>The events are the cases of {@code docs/contracts/v2/events-vocabulary-vectors.json} (the
 * one example source), wrapped into events.raw records of the contract's Kundenbereich
 * ({@code kennungen}): one per originator (box, datenannahme, writer, cloud, kunde); a record
 * delivered twice (one row); a Fortschreibung (another row, the first report stays) and two
 * inadmissible ones; and records the contract drops - each dropped with its reason in the
 * metric, none stored.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
class EventsRawConsumerTest {

    private static final String TOPIC = "events.raw";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VEKTOREN =
            Path.of("..", "..", "docs", "contracts", "v2", "events-vocabulary-vectors.json");

    /** Kundenbereich, Anlagen and the box E-2′ as the vector file's {@code kennungen} name them. */
    private static final String KB = "a4e0b000-0000-4000-8000-000000000001";
    private static final String AN1 = "a4e0b000-0000-4000-8000-0000000000a1";
    private static final String E2STRICH = "a4e0b000-0000-4000-8000-0000000002e2";
    private static final String FREMD = "f4e0b000-0000-4000-8000-000000000001";

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

    private static JsonNode faelle;
    private static UUID dq3;
    private static UUID dq4;
    private static UUID ms06;

    @Autowired
    MeterRegistry meters;

    @BeforeAll
    static void ereignisTabelle() throws Exception {
        EreignisTabelleImTest.anlegen(POSTGRES, KB, FREMD);
        faelle = MAPPER.readTree(Files.readString(VEKTOREN)).path("cases");
        dq3 = UUID.randomUUID();
        dq4 = UUID.randomUUID();
        ms06 = UUID.randomUUID();
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO data_source (id, tenant_id, kennzeichen) VALUES ('" + dq3 + "','"
                    + KB + "','DQ-3'), ('" + dq4 + "','" + KB + "','DQ-4')");
            st.execute("INSERT INTO messstelle_kennzeichen (tenant_id, kennzeichen, messstelle_id) "
                    + "VALUES ('" + KB + "','MS-06','" + ms06 + "')");
        }
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(TOPIC, 1, (short) 1))).all().get();
        } catch (ExecutionException e) {
            if (!(e.getCause() instanceof TopicExistsException)) {
                throw e;
            }
        }
    }

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("spring.kafka.bootstrap-servers", REDPANDA::getBootstrapServers);
        registry.add("voltpilot.redpanda.events-topic", () -> TOPIC);
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> "voltpilot_app");
        registry.add("spring.datasource.password", () -> APP_PW);
    }

    @Test
    void jeUrheberEineNachrichtWirdAngehaengtUndIhrBezugAufgeloest() throws Exception {
        JsonNode umschlag = fall("umschlag-e2strich-bereichsbegrenzung-ek3").path("input").path("umschlag");
        ObjectNode box = ((ObjectNode) umschlag.path("events").get(0).deepCopy())
                .put("box", umschlag.path("device_id").asText());
        senden(boxRecord(umschlag, box),
                cloudRecord("datenannahme", ereignis("lindach-uhr-14-minuten-vor"), "2026-10-20T08:15:02Z"),
                cloudRecord("writer", ereignis("ms06-abweichender-wert-1039"), "2026-11-18T09:40:08Z"),
                cloudRecord("cloud", ereignis("uebergabe-dq3-offen-bis-zur-quittung"), "2027-04-10T05:30:00Z"),
                cloudRecord("kunde", ereignis("ms06-zaehlerwechsel-z5a-z5b"), "2026-11-18T10:05:00Z"));
        warte("five reports", () -> zaehle("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id IN ("
                + "'e7e00000-0000-4000-8000-000000000053','e7e00000-0000-4000-8000-000000000070',"
                + "'e7e00000-0000-4000-8000-000000000026','e7e00000-0000-4000-8000-000000000030',"
                + "'e7e00000-0000-4000-8000-000000000020')"), 5);

        // The box: its device from the topic, DQ-4 resolved, K-8.3 kept as reported (no code
        // table for components - the column stays empty, never guessed).
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id="
                + "'e7e00000-0000-4000-8000-000000000053' AND art='range_limit' AND urheber='box' "
                + "AND device_id='" + E2STRICH + "' AND data_source_id='" + dq4 + "' AND entity_id IS NULL "
                + "AND kennungen->>'komponente'='K-8.3' AND nutzlast='{\"statuswort\":4}'::jsonb "
                + "AND zeit='2026-12-14T08:20:00Z' AND eingang='2026-12-14T08:20:06Z' AND NOT aus_bestand"))
                .isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id="
                + "'e7e00000-0000-4000-8000-000000000070' AND art='clock_ahead' AND urheber='datenannahme' "
                + "AND device_id IS NULL AND kennungen->>'box'='E-3' AND (nutzlast->>'vor_s')::int=840"))
                .isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id="
                + "'e7e00000-0000-4000-8000-000000000026' AND art='duplicate_conflict' AND urheber='writer' "
                + "AND messstelle_id='" + ms06 + "' AND messkanal='Wirkenergie Bezug' "
                + "AND nutzlast->'sequenzen'='[48213,48214]'::jsonb")).isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id="
                + "'e7e00000-0000-4000-8000-000000000030' AND art='handover' AND urheber='cloud' "
                + "AND data_source_id='" + dq3 + "' AND von='2027-04-10T05:30:00Z' AND zeit=von "
                + "AND bis IS NULL AND site_id='" + AN1 + "'")).isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id="
                + "'e7e00000-0000-4000-8000-000000000020' AND art='device_boundary' AND urheber='kunde' "
                + "AND messstelle_id='" + ms06 + "' AND nutzlast->>'einbau_neu'='Z-5b'")).isOne();
        assertThat(sichtbar(KB, "'e7e00000-0000-4000-8000-000000000053'")).isOne();
        assertThat(sichtbar(FREMD, "'e7e00000-0000-4000-8000-000000000053'")).isZero();
    }

    @Test
    void eineErneutZugestellteNachrichtErzeugtKeineZweiteZeile() throws Exception {
        double vorher = zaehler("wiederholung", "");
        String record = cloudRecord("writer", ereignis("ek3-zaehler-zurueckgesetzt"), "2026-11-02T08:12:01Z");
        senden(record, record);
        warte("the repeat was judged", () -> (long) (zaehler("wiederholung", "") - vorher), 1);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis "
                + "WHERE ereignis_id='e7e00000-0000-4000-8000-000000000040'")).isOne();
    }

    @Test
    void eineFortschreibungWirdEineWeitereZeileUndEineUnzulaessigeWirdVerworfen() throws Exception {
        double vorher = zaehler("verworfen", "fortschreibung_unzulaessig");
        JsonNode fall = fall("ausfall-e2-luecke-geschlossen-box-tausch-ohne-nachlieferung").path("input");
        senden(cloudRecord("cloud", fall.path("alt"), "2026-11-03T13:10:00Z"),
                cloudRecord("cloud", fall.path("neu"), "2026-11-04T08:41:00Z"),
                cloudRecord("cloud", fall("fortschreibung-aendert-von-verworfen").at("/input/neu"),
                        "2026-11-04T08:42:00Z"),
                cloudRecord("cloud", fall("fortschreibung-verschiebt-geschlossenes-ende-verworfen")
                        .at("/input/neu"), "2026-11-04T08:43:00Z"));
        warte("two inadmissible Fortschreibungen",
                () -> (long) (zaehler("verworfen", "fortschreibung_unzulaessig") - vorher), 2);
        String id = "ereignis_id='e7e00000-0000-4000-8000-000000000002'";
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE " + id)).isEqualTo(2);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE " + id
                + " AND bis IS NULL AND eingang='2026-11-03T13:10:00Z'")).as("the first report stays").isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE " + id
                + " AND bis='2026-11-04T08:40:00Z' AND data_source_id='" + dq4 + "'")).isOne();
    }

    @Test
    void wasDerVertragVerwirftWirdVerworfenGezaehltUndNieGespeichert() throws Exception {
        Map<String, Double> vorher = Map.of(
                "schema_verletzt", zaehler("verworfen", "schema_verletzt"),
                "fassung_unbekannt", zaehler("verworfen", "fassung_unbekannt"),
                "wort_unbekannt", zaehler("verworfen", "wort_unbekannt"),
                "kennung_abweichend", zaehler("verworfen", "kennung_abweichend"),
                "regel_verletzt", zaehler("verworfen", "regel_verletzt"),
                "urheber_unzulaessig", zaehler("verworfen", "urheber_unzulaessig"));
        JsonNode umschlag = fall("umschlag-e2strich-bereichsbegrenzung-ek3").path("input").path("umschlag");
        ObjectNode fremdeBox = ((ObjectNode) umschlag.path("events").get(0).deepCopy())
                .put("box", "a4e0b000-0000-4000-8000-0000000000e1");
        ObjectNode ohneUmschlag = (ObjectNode) MAPPER.readTree(cloudRecord("writer",
                ereignis("sequenz-luecke-188-datenpakete"), "2026-11-03T16:33:41Z"));
        ohneUmschlag.put("urheber", "box");
        ObjectNode fassung = (ObjectNode) MAPPER.readTree(cloudRecord("writer",
                ereignis("sequenz-luecke-188-datenpakete"), "2026-11-03T16:33:41Z"));
        fassung.put("schema_version", "2.0");
        ObjectNode unbekannt = ((ObjectNode) ereignis("sequenz-luecke-188-datenpakete").deepCopy())
                .put("art", "power_failure");
        ObjectNode grenzeVonDerBox = ((ObjectNode) ereignis("ms06-zaehlerwechsel-z5a-z5b").deepCopy())
                .put("box", umschlag.path("device_id").asText());
        senden("{\"schema_version\":", ohneUmschlag.toString(), fassung.toString(),
                boxRecord(umschlag, fremdeBox),
                cloudRecord("writer", unbekannt, "2026-11-03T16:33:41Z"),
                cloudRecord("writer", ereignis("gleicher-wert-ist-kein-konflikt-verworfen"), "2026-11-18T09:40:08Z"),
                boxRecord(umschlag, grenzeVonDerBox),
                // the sentinel: same partition, so everything above was judged before it lands
                cloudRecord("writer", ereignis("sequenz-luecke-188-datenpakete"), "2026-11-03T16:33:41Z"));
        warte("the sentinel", () -> zaehle("SELECT count(*) FROM messreihe_ereignis "
                + "WHERE ereignis_id='e7e00000-0000-4000-8000-000000000007'"), 1);
        assertThat(zaehler("verworfen", "schema_verletzt") - vorher.get("schema_verletzt")).isEqualTo(2);
        assertThat(zaehler("verworfen", "fassung_unbekannt") - vorher.get("fassung_unbekannt")).isEqualTo(1);
        assertThat(zaehler("verworfen", "kennung_abweichend") - vorher.get("kennung_abweichend")).isEqualTo(1);
        assertThat(zaehler("verworfen", "wort_unbekannt") - vorher.get("wort_unbekannt")).isEqualTo(1);
        assertThat(zaehler("verworfen", "regel_verletzt") - vorher.get("regel_verletzt")).isEqualTo(1);
        // A box with the envelope of a device boundary: the box never reports one.
        assertThat(zaehler("verworfen", "urheber_unzulaessig") - vorher.get("urheber_unzulaessig"))
                .isEqualTo(1);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id IN ("
                + "'e7e00000-0000-4000-8000-000000000027')")).isZero();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE art NOT IN (SELECT art FROM "
                + "messreihe_ereignis_vokabular())")).isZero();
    }

    // ---- records ----------------------------------------------------------------------

    private static JsonNode fall(String name) {
        for (JsonNode c : faelle) {
            if (c.path("name").asText().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("no case " + name);
    }

    private static JsonNode ereignis(String name) {
        return fall(name).path("input").path("ereignis");
    }

    /** A cloud-side record (no envelope), at the Anlage AN-1 of the Kundenbereich. */
    private static String cloudRecord(String urheber, JsonNode ereignis, String ingestedAt) {
        ObjectNode r = MAPPER.createObjectNode();
        r.put("schema_version", "1.0").put("event_id", UUID.randomUUID().toString())
                .put("tenant_id", KB).put("site_id", AN1).put("urheber", urheber)
                .put("ingested_at", ingestedAt);
        r.set("ereignis", ereignis);
        return r.toString();
    }

    /** A box event the ingest decomposed out of its envelope. */
    private static String boxRecord(JsonNode umschlag, JsonNode ereignis) {
        ObjectNode r = MAPPER.createObjectNode();
        String t = umschlag.path("tenant_id").asText();
        String s = umschlag.path("site_id").asText();
        String d = umschlag.path("device_id").asText();
        r.put("schema_version", "1.0").put("event_id", UUID.randomUUID().toString())
                .put("tenant_id", t).put("site_id", s).put("urheber", "box")
                .put("ingested_at", "2026-12-14T08:20:06Z").put("device_id", d)
                .put("source_topic", "ems/" + t + "/" + s + "/" + d + "/v2/events")
                .put("sequence", umschlag.path("sequence").asLong())
                .put("observed_at", umschlag.path("observed_at").asText());
        r.set("ereignis", ereignis);
        return r.toString();
    }

    private static void senden(String... records) throws Exception {
        Properties p = new Properties();
        p.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        p.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        p.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(p)) {
            for (String r : records) {
                producer.send(new ProducerRecord<>(TOPIC, KB + ":" + AN1, r)).get();
            }
            producer.flush();
        }
    }

    // ---- reading back -----------------------------------------------------------------

    private double zaehler(String ergebnis, String grund) {
        Counter c = meters.find(EventsRawConsumer.METRIK).tag("ergebnis", ergebnis).tag("grund", grund)
                .counter();
        return c == null ? 0 : c.count();
    }

    private static void warte(String was, LongSupplier ist, long soll) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        long n = -1;
        while (System.nanoTime() < deadline) {
            n = ist.getAsLong();
            if (n >= soll) {
                return;
            }
            Thread.sleep(300);
        }
        throw new AssertionError(was + ": expected " + soll + ", saw " + n);
    }

    private static long zaehle(String sql) {
        try (Connection c = admin(); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new IllegalStateException(sql, e);
        }
    }

    /** Rows of these events as the app role sees them under the tenant. */
    private static long sichtbar(String tenant, String ids) throws Exception {
        Properties p = new Properties();
        p.put("user", "voltpilot_app");
        p.put("password", APP_PW);
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), p);
                Statement st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id','" + tenant + "',false)");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM messreihe_ereignis "
                    + "WHERE ereignis_id IN (" + ids + ")")) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    private static Connection admin() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
    }
}
