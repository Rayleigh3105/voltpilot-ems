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
 * in {@link UemsStreckeAbnahmeTest} zum {@code measurements.raw}-Ereignis; ingest reicht die 2.0-Felder
 * unverändert weiter und stempelt den Eingang.
 *
 * <ul>
 *   <li><b>E-1</b> so, wie Drehbuch §14.2 die Einrichtung heute hinterlässt: KEINE Auswahlzeile, weil die
 *       Routen die Schlüssel des Simulators nicht annehmen.
 *   <li><b>E-2</b> mit allem, was der Writer für {@code entity_id} braucht: Auswahl mit Komponente,
 *       Datenquelle an der Komponente, E-2 für sie zuständig, Gerät eingebaut. Aber wie beim Simulator
 *       OHNE Quittung der Box: {@code applied_at} ist leer.
 * </ul>
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
            JsonNode e2 = BOX.get("E-2");
            String site = e2.path("site_id").asText();
            String box = e2.path("device_id").asText();
            String quelle = UUID.randomUUID().toString();
            exec(c, "INSERT INTO data_source (id, tenant_id, kennzeichen, kadenz_s) VALUES (?::uuid, ?::uuid, "
                    + "'DQ-E2', 60)", quelle, tenant);
            exec(c, "INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, effective_from, "
                    + "effective_to) VALUES (?::uuid, ?::uuid, ?::uuid, ?::timestamptz, NULL)", tenant, quelle, box,
                    EINGERICHTET);
            String katalog = vorlage.path("zustellungen").get(0).path("nutzlast").path("catalog_version").asText();
            for (JsonNode k : e2.path("point_keys")) {
                String punkt = k.asText();
                String komponente = UUID.randomUUID().toString();
                String geraet = UUID.randomUUID().toString();
                String messstelle = "MS-" + punkt.substring("custom.ms-".length(), "custom.ms-".length() + 2);
                exec(c, "INSERT INTO measurement_point (id, tenant_id, site_id, role, label, device_id, "
                        + "data_source_id) VALUES (?::uuid, ?::uuid, ?::uuid, 'consumer', ?, ?::uuid, ?::uuid)",
                        komponente, tenant, site, messstelle, box, quelle);
                exec(c, "INSERT INTO geraet (id, tenant_id, site_id, kennzeichen, einbau_kennzeichen, seriennummer, "
                        + "eingebaut_am) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?::timestamptz)", geraet, tenant,
                        site, messstelle, "Z-" + messstelle, "SN-" + messstelle, EINGERICHTET);
                exec(c, "INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab) VALUES "
                        + "(?::uuid, ?::uuid, ?::uuid, ?::timestamptz)", tenant, geraet, komponente, EINGERICHTET);
                exec(c, "INSERT INTO measurement_catalog_point_metadata VALUES (?, ?, 'counter', 900) "
                        + "ON CONFLICT DO NOTHING", katalog, punkt);
                // Wie POST …/measurement-selection/custom sie anlegt: gewünscht, noch nicht quittiert.
                exec(c, "INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, point_key, enabled, "
                        + "cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                        + "applied_at, retention_class, raw_retention_days, long_term_cadence_s, long_term_strategy, "
                        + "entity_id) VALUES (?::uuid, ?::uuid, ?::uuid, ?, true, 60, 1, ?::timestamptz, ?, 'nw6', "
                        + "'pending_edge', NULL, 'energy_counter', 90, 900, 'fifteen_minute', ?::uuid)",
                        tenant, site, box, punkt, EINGERICHTET, katalog, komponente);
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
        int jeTakt = BOX.get("E-2").path("point_keys").size();
        int takte = zustellungen.size() / 2;

        // Takt 1, dann die 60 s, die in Produktion bis zum nächsten Takt vergehen: so lange hält der
        // Nachschlag seine Zeitleisten (HerkunftNachschlag.CACHE_TTL_MS). Hier nicht gewartet, sondern
        // verfallen lassen. Danach die Takte 2 bis 5.
        senden(zustellungen.subList(0, 2));
        warte(e2, jeTakt);
        nachschlag.vergessen();
        senden(zustellungen.subList(2, zustellungen.size()));
        warte(e2, takte * jeTakt);

        // E-1, wie §14.2 die Einrichtung heute hinterlässt: ohne Auswahlzeile nimmt der Writer nichts an.
        assertThat(zahl("SELECT count(*) FROM device_measurement_sample WHERE device_id = '" + e1 + "'"))
                .as("E-1 ohne Auswahl: jeder Wert verworfen (MeasurementWriteRepository.java:145-150)").isZero();

        // E-2, voll eingerichtet, nie quittiert. Der erste Wert je Schlüssel findet keine Fassung
        // (MesswertHerkunft.java:437) und bleibt ohne Zuordnung; erst er setzt applied_at
        // (MeasurementWriteRepository.java:451). Ab dem zweiten Takt trägt jeder Wert entity_id, Rolle
        // „beobachtung“ (E-2 zuständig, keine Messstelle gebunden) — die zählt der Lücken-Melder.
        List<String> jeMesszeit = zeilen("SELECT to_char(time AT TIME ZONE 'UTC', 'HH24:MI') || ' ' "
                + "|| count(entity_id) || '/' || count(*) || ' ' || coalesce(string_agg(DISTINCT role, ','), '-') "
                + "FROM device_measurement_sample WHERE device_id = '" + e2 + "' GROUP BY time ORDER BY time");
        assertThat(jeMesszeit).as("je Messzeit: zugeordnet/geschrieben und Rolle").containsExactly(
                "09:55 0/5 -", "09:56 5/5 beobachtung", "09:57 5/5 beobachtung", "09:58 5/5 beobachtung",
                "09:59 5/5 beobachtung");
        assertThat(zeilen("SELECT DISTINCT apply_status || ' ' || to_char(applied_at AT TIME ZONE 'UTC', 'HH24:MI') "
                + "FROM device_measurement_selection WHERE device_id = '" + e2 + "'"))
                .as("die Erstwert-Marke ersetzt die fehlende Quittung").containsExactly("first_sample 09:55");
        // Die Naht zur api-Hälfte: genau diese Spalten schreibt DauerlaeuferGanzerWegDbTest.
        assertThat(zeilen("SELECT DISTINCT concat_ws(' ', role, delivery, value_kind, applied_revision, delay_s, "
                + "aggregation_kind, extract(epoch FROM received_at - time)) FROM device_measurement_sample "
                + "WHERE device_id = '" + e2 + "' AND entity_id IS NOT NULL"))
                .containsExactly("beobachtung direkt counter 1 2 counter 2.000000");
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
        assertThat(zahl(sql)).as("E-2: jeder Wert der Vorlage ist geschrieben").isEqualTo(erwartet);
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
