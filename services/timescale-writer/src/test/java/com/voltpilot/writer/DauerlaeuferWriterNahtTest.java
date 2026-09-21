package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
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
 * NW-6 im Kleinen, die Writer-Hälfte (AP-14 IP-18): Was macht der ECHTE Writer mit den Umschlägen des
 * Dauerläufers? Die api-Hälfte (Einrichtung über die Portalwege, Lücken-Melder, Sammler, Schalter) geht
 * {@code DauerlaeuferGanzerWegDbTest} im api-Modul; beide lesen dieselbe Vorlage.
 *
 * <p>Echt: Redpanda, der Writer mit seinem Nachschlag der Herkunft. Die Datenbank ist der Spiegel
 * {@code writer-schema.sql} (die Bühne von {@link UemsStreckeAbnahmeTest}); diese Bühne hat keine Routen,
 * die Stammdaten stehen darum per INSERT darin. NICHT durchlaufen: MQTT und ingest. Der Umschlag wird wie
 * in {@link UemsStreckeAbnahmeTest} zum {@code measurements.raw}-Ereignis. Dass die echte Datenannahme aus
 * jedem Umschlag genau dieses Ereignis bildet (nur {@code event_id} neu), belegt
 * {@code DauerlaeuferVorlageAnnahmeTest} in services/ingest.
 *
 * <p>Beide Boxen so, wie Drehbuch §14.2 die Einrichtung hinterlässt (in der api über die Routen belegt):
 * Auswahl mit den Schlüsseln, die die Plattform vergeben und der Simulator gelernt hat, je Messstelle eine
 * Komponente mit Datenquelle, die Box für sie zuständig, Gerät eingebaut — und die Auswahl QUITTIERT:
 * {@code applied_at} aus der Quittung des Simulators ({@code einrichtung[].quittung} der Vorlage), wie
 * {@code MeasurementConfigStatusListener} sie schreibt. Dann trägt schon der erste Wert je Schlüssel seine
 * Zuordnung, auch wenn alle Takte im selben 60-s-Fenster des Nachschlags ankommen.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
class DauerlaeuferWriterNahtTest {

    private static final Path VORLAGE =
            Path.of("../../tools/edge-simulator/abnahme/dauerlaeufer-nw6.json");
    private static final String MEASUREMENTS_RAW_TOPIC = "measurements.raw";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    /** ingest stempelt den Eingang; wie in der api-Hälfte zwei Sekunden nach der Messzeit. */
    private static final Duration EINGANG = Duration.ofSeconds(2);
    /** Eingerichtet zwei Tage vor der Vorlage — Auswahl, Zuständigkeit und Einbau gelten längst. */
    private static final String EINGERICHTET = "2026-11-01T00:00:00Z";

    private static JsonNode vorlage;
    private static final Map<String, JsonNode> BOX = new LinkedHashMap<>();

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
    static void vorlageLesenUndEinrichten() throws Exception {
        byte[] bytes = Files.readAllBytes(VORLAGE);
        String summe = Files.readString(Path.of(VORLAGE + ".sha256"), StandardCharsets.UTF_8).strip();
        assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                .as("Vorlage von Hand geändert? `make abnahme` in tools/edge-simulator").isEqualTo(summe);
        vorlage = MAPPER.readTree(bytes);
        vorlage.path("boxen").forEach(b -> BOX.put(b.path("code").asText(), b));
        String tenant = vorlage.path("tenant_id").asText();
        EreignisTabelleImTest.anlegen(POSTGRES, tenant);

        try (Connection c = admin()) {
            for (JsonNode b : BOX.values()) {
                exec(c, "INSERT INTO device (id, tenant_id, site_id) VALUES (?::uuid, ?::uuid, ?::uuid)",
                        b.path("device_id").asText(), tenant, b.path("site_id").asText());
            }
            String katalog = vorlage.path("zustellungen").get(0).path("nutzlast").path("catalog_version").asText();
            for (JsonNode e : vorlage.path("einrichtung")) {
                JsonNode b = BOX.get(e.path("box").asText());
                String site = b.path("site_id").asText();
                String box = b.path("device_id").asText();
                String applied = e.at("/quittung/nutzlast/applied_at").asText();
                String quelle = UUID.randomUUID().toString();
                exec(c, "INSERT INTO data_source (id, tenant_id, kennzeichen, kadenz_s) VALUES (?::uuid, ?::uuid, "
                        + "?, 60)", quelle, tenant, "DQ-" + b.path("code").asText());
                exec(c, "INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, effective_from, "
                        + "effective_to) VALUES (?::uuid, ?::uuid, ?::uuid, ?::timestamptz, NULL)", tenant, quelle,
                        box, EINGERICHTET);
                int revision = 0;
                for (JsonNode m : b.path("messstellen")) {
                    String punkt = m.path("point_key").asText();
                    String komponente = m.path("entity_id").asText();
                    String geraet = UUID.randomUUID().toString();
                    String messstelle = m.path("messstelle").asText();
                    revision++; // „Eigenen Messwert hinzufügen“ je Messstelle: eine Revision je Aufruf
                    exec(c, "INSERT INTO measurement_point (id, tenant_id, site_id, role, label, device_id, "
                            + "data_source_id) VALUES (?::uuid, ?::uuid, ?::uuid, 'consumer', ?, ?::uuid, ?::uuid)",
                            komponente, tenant, site, messstelle, box, quelle);
                    exec(c, "INSERT INTO geraet (id, tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                            + "seriennummer, eingebaut_am) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?::timestamptz)",
                            geraet, tenant, site, messstelle, "Z-" + messstelle, "SN-" + messstelle, EINGERICHTET);
                    exec(c, "INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab) VALUES "
                            + "(?::uuid, ?::uuid, ?::uuid, ?::timestamptz)", tenant, geraet, komponente, EINGERICHTET);
                    exec(c, "INSERT INTO measurement_catalog_point_metadata VALUES (?, ?, 'counter', 900) "
                            + "ON CONFLICT DO NOTHING", katalog, punkt);
                    // Wie die api sie nach der Quittung hinterlässt: angewendet, applied_at aus der Quittung.
                    exec(c, "INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, point_key, "
                            + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                            + "apply_status, applied_at, retention_class, raw_retention_days, long_term_cadence_s, "
                            + "long_term_strategy, entity_id) VALUES (?::uuid, ?::uuid, ?::uuid, ?, true, 60, ?, "
                            + "?::timestamptz, ?, 'nw6', 'applied', ?::timestamptz, 'energy_counter', 90, 900, "
                            + "'fifteen_minute', ?::uuid)",
                            tenant, site, box, punkt, revision, EINGERICHTET, katalog, applied, komponente);
                }
            }
        }
    }

    @AfterAll
    static void zuhoererBeenden(@Autowired KafkaListenerEndpointRegistry zuhoerer) {
        zuhoerer.stop();
    }

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("spring.kafka.bootstrap-servers", REDPANDA::getBootstrapServers);
        registry.add("voltpilot.redpanda.measurements-topic", () -> MEASUREMENTS_RAW_TOPIC);
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> "voltpilot_app");
        registry.add("spring.datasource.password", () -> APP_PW);
    }

    @Autowired
    HerkunftNachschlag nachschlag;

    @Test
    void dieUmschlaegeDesDauerlaeufersAmEchtenWriter() throws Exception {
        // EINE Partition: ist der letzte Umschlag (E-2) geschrieben, sind alle davor gelesen.
        try (Admin a = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            try {
                a.createTopics(List.of(new NewTopic(MEASUREMENTS_RAW_TOPIC, 1, (short) 1))).all().get();
            } catch (ExecutionException e) {
                if (!(e.getCause() instanceof TopicExistsException)) {
                    throw e;
                }
            }
            assertThat(a.describeTopics(List.of(MEASUREMENTS_RAW_TOPIC)).allTopicNames().get()
                    .get(MEASUREMENTS_RAW_TOPIC).partitions()).hasSize(1);
        }
        List<JsonNode> zustellungen = new ArrayList<>();
        vorlage.path("zustellungen").forEach(zustellungen::add);
        String e1 = BOX.get("E-1").path("device_id").asText();
        String e2 = BOX.get("E-2").path("device_id").asText();
        int takte = zustellungen.size() / 2;

        // Alle fünf Takte in EINEM Zug — innerhalb der 60 s, die der Nachschlag seine Zeitleisten hält
        // (HerkunftNachschlag.CACHE_TTL_MS). Ohne Quittung blieb so JEDER Wert ohne Zuordnung (PR 999);
        // mit ihr steht die Fassung schon vor dem ersten Wert.
        senden(zustellungen);
        warte(e1, takte * 4L);
        warte(e2, takte * 5L);

        for (String box : List.of(e1, e2)) {
            int jeTakt = box.equals(e1) ? 4 : 5;
            List<String> jeMesszeit = zeilen("SELECT to_char(time AT TIME ZONE 'UTC', 'HH24:MI') || ' ' "
                    + "|| count(entity_id) || '/' || count(*) || ' ' || coalesce(string_agg(DISTINCT role, ','), '-') "
                    + "FROM device_measurement_sample WHERE device_id = '" + box + "' GROUP BY time ORDER BY time");
            String voll = jeTakt + "/" + jeTakt + " beobachtung";
            assertThat(jeMesszeit).as("je Messzeit: zugeordnet/geschrieben und Rolle — auch der erste Takt")
                    .containsExactly("09:55 " + voll, "09:56 " + voll, "09:57 " + voll, "09:58 " + voll,
                            "09:59 " + voll);
            // Der erste Wert setzt nur noch die Marke; applied_at bleibt das der Quittung.
            assertThat(zeilen("SELECT DISTINCT apply_status || ' ' || to_char(applied_at AT TIME ZONE 'UTC', "
                    + "'HH24:MI') FROM device_measurement_selection WHERE device_id = '" + box + "'"))
                    .as("applied_at aus der Quittung, nicht aus dem ersten Wert").containsExactly("first_sample 09:50");
            assertThat(zahl("SELECT count(*) FROM device_measurement_sample s JOIN device_measurement_selection a "
                    + "ON a.device_id = s.device_id AND a.point_key = s.point_key WHERE s.device_id = '" + box
                    + "' AND s.applied_revision = a.desired_revision AND s.entity_id = a.entity_id"))
                    .as("jeder Wert mit der Fassung und der Komponente seiner Auswahlzeile").isEqualTo(takte * jeTakt);
        }
        // Die Naht zur api-Hälfte: genau diese Spalten schreibt DauerlaeuferGanzerWegDbTest.
        assertThat(zeilen("SELECT DISTINCT concat_ws(' ', role, delivery, value_kind, delay_s, aggregation_kind, "
                + "extract(epoch FROM received_at - time)) FROM device_measurement_sample"))
                .containsExactly("beobachtung direkt counter 2 counter 2.000000");
    }

    private void senden(List<JsonNode> zustellungen) throws Exception {
        try (KafkaProducer<String, String> producer = producer()) {
            for (JsonNode z : zustellungen) {
                JsonNode n = z.path("nutzlast");
                producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, n.path("tenant_id").asText() + ":"
                        + n.path("site_id").asText() + ":" + n.path("device_id").asText(), ereignis(z))).get();
            }
            producer.flush();
        }
    }

    private static void warte(String box, long erwartet) throws Exception {
        String sql = "SELECT count(*) FROM device_measurement_sample WHERE device_id = '" + box + "'";
        long frist = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        while (zahl(sql) < erwartet && System.nanoTime() < frist) {
            Thread.sleep(250);
        }
        assertThat(zahl(sql)).as(box + ": jeder Wert der Vorlage ist geschrieben").isEqualTo(erwartet);
    }

    /** Der Umschlag als {@code measurements.raw}-Ereignis — die Felder, die ingest durchreicht. */
    private static String ereignis(JsonNode z) throws Exception {
        JsonNode n = z.path("nutzlast");
        ObjectNode out = MAPPER.createObjectNode();
        out.put("schema_version", "1.0");
        out.put("event_id", UUID.randomUUID().toString());
        out.put("tenant_id", n.path("tenant_id").asText());
        out.put("site_id", n.path("site_id").asText());
        out.put("device_id", n.path("device_id").asText());
        out.put("catalog_version", n.path("catalog_version").asText());
        out.put("sequence", n.path("sequence").asLong());
        out.put("observed_at", n.path("observed_at").asText());
        out.put("ingested_at", Instant.parse(n.path("observed_at").asText()).plus(EINGANG).toString());
        out.put("source_topic", z.path("topic").asText());
        out.put("dropped_samples", 0);
        out.put("gap", false);
        out.set("samples", n.path("samples").deepCopy());
        return MAPPER.writeValueAsString(out);
    }

    private static KafkaProducer<String, String> producer() {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        return new KafkaProducer<>(props);
    }

    private static Connection admin() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }

    private static long zahl(String sql) throws Exception {
        try (Connection c = admin(); PreparedStatement ps = c.prepareStatement(sql); ResultSet rs = ps.executeQuery()) {
            return rs.next() ? rs.getLong(1) : -1;
        }
    }

    private static List<String> zeilen(String sql) throws Exception {
        List<String> out = new ArrayList<>();
        try (Connection c = admin(); PreparedStatement ps = c.prepareStatement(sql); ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                out.add(rs.getString(1));
            }
        }
        return out;
    }
}
