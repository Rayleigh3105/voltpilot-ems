package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
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
import org.springframework.kafka.config.KafkaListenerEndpointRegistry;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-07 IP-21 — die Störungs-Szenarien des Simulators durch die ECHTE Strecke.
 *
 * <p>Der Simulator (AP-07 IP-20, {@code tools/edge-simulator/uems_szenarien.py}) schreibt das
 * Drehbuch: je Szenario die Zustellungen mit ihren vollständigen Nutzlasten, die erwarteten
 * {@code events.raw}-Ereignisse und die erwarteten Zeilen je Messstelle. Dieser Lauf spielt
 * genau diese Zustellungen über ein echtes Redpanda in den echten Writer und vergleicht,
 * was in einer echten TimescaleDB liegt.
 *
 * <p><b>Der Java-Lauf startet kein Python.</b> Das Drehbuch steht als erzeugte Datei
 * {@code tools/edge-simulator/abnahme/ap07-szenarien.json} im Baum; sie trägt eine Prüfsumme
 * über ihren eigenen Inhalt, die hier nachgerechnet wird, und
 * {@code test_ap07_abnahme_fixture.py} hält sie an den Simulator. Laufen beide auseinander,
 * ist der Wächter rot — nie still ein anderes Drehbuch.
 *
 * <p><b>Die Naht zur Datenannahme.</b> Gespielt wird der Weg AB {@code measurements.raw}, also
 * Writer → Datenbank. Der Schritt davor (MQTT → Datenannahme → {@code measurements.raw}) ist
 * die Sache von {@code services/ingest}; A13 lebt genau dort, und der Drehbuch-Eintrag sagt,
 * welche drei Zustellungen die Datenannahme abweist. Dieser Lauf spielt darum für A13 nur die
 * ANGENOMMENEN Zustellungen und prüft, dass die abgewiesenen nach der Regel der Datenannahme
 * abgewiesen GEHÖREN — den Nachweis, dass sie es werden, führt {@code MesszeitregelTest}.
 *
 * <p>Wegwerf-Container auf zufälligen Ports; ohne Docker wird übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
class UemsStreckeAbnahmeTest {

    /** Das Drehbuch liegt neben seinem Erzeuger, nicht als Kopie je Maven-Modul. */
    private static final Path DREHBUCH =
            Path.of("../../tools/edge-simulator/abnahme/ap07-szenarien.json");

    private static final String MEASUREMENTS_RAW_TOPIC = "measurements.raw";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Die Datenannahme weist eine Messzeit ab, die weiter als das in der Zukunft liegt. */
    private static final Duration UHR_TOLERANZ = Duration.ofMinutes(5);

    /**
     * Arten, die ein TAKT in {@code services/api} schreibt, nie der Writer beim Einlauf:
     * {@code data_gap} und {@code backfill} der Lücken-Melder (AP-07 IP-9),
     * {@code late_arrival} der {@code SpaetankunftMelder} (IP-13). Der Writer sieht beim
     * Einlauf einen einzelnen Wert — ob dessen Viertelstunde schon endgültig war oder ob eine
     * Reihe schweigt, weiß er nicht und darf er nicht raten.
     */
    private static final Set<String> MELDER_ARTEN =
            Set.of("data_gap", "backfill", "late_arrival");

    private static JsonNode drehbuch;

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
    static void drehbuchLesenUndSaeen() throws Exception {
        drehbuch = MAPPER.readTree(Files.readString(DREHBUCH, StandardCharsets.UTF_8));
        String tenant = drehbuch.path("szenarien").get(0).path("stammdaten").path("tenant_id").asText();
        EreignisTabelleImTest.anlegen(POSTGRES, tenant);
        try (Connection c = admin(); Statement st = c.createStatement()) {
            for (JsonNode szenario : drehbuch.path("szenarien")) {
                saee(st, szenario);
            }
        }
    }

    @org.junit.jupiter.api.AfterAll
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

    // ================================================== Der Wächter über dem Drehbuch

    /**
     * Die Prüfsumme deckt den ganzen Inhalt: wer die Datei von Hand anfasst, ohne
     * {@code make abnahme} zu fahren, macht diesen Lauf rot — und nicht die Abnahme still falsch.
     */
    @Test
    void dasDrehbuchIstDasDesSimulators() throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        String ist = HexFormat.of().formatHex(md.digest(Files.readAllBytes(DREHBUCH)));
        String genannt = Files.readString(Path.of(DREHBUCH + ".sha256"), StandardCharsets.UTF_8).trim();
        assertThat(ist)
                .as("sha256 über die Bytes der Vorlage — `make abnahme` erzeugt sie neu")
                .isEqualTo(genannt);
        assertThat(schluessel()).containsExactly("A1", "A3", "A4", "A6", "A13");
    }

    // ================================================== Die fünf Szenarien durch die Strecke

    /** A1: dieselben 256 Werte dreimal — einmal gespeichert, ein {@code sequence_reset}. */
    @Test
    void a1_dieWiederholungVerdoppeltKeinenVerbrauch() throws Exception {
        spielenUndPruefen("A1");
    }

    /** A3: 3,5 Stunden Ausfall, 210 Takte aus der Outbox — jeder Takt landet genau einmal. */
    @Test
    void a3_dieNachlieferungFuelltDenAusfall() throws Exception {
        spielenUndPruefen("A3");
    }

    /** A4: der Puffer hat verdrängt — die Lücke bleibt Lücke, der Rest kommt an. */
    @Test
    void a4_dieVerdraengtenMesszeitenBleibenLuecke() throws Exception {
        spielenUndPruefen("A4");
    }

    /**
     * A6: nach der Übergabe ist der Nachzügler der alten Box mit Messzeit VOR dem Wechsel
     * führend, mit Messzeit danach ein Spiegel — die Rolle entscheidet die Zuständigkeit zur
     * MESSZEIT, nie die Eingangszeit (W8).
     */
    @Test
    void a6_derNachzueglerIstFuehrendDerSpaetereEinSpiegel() throws Exception {
        spielenUndPruefen("A6");
    }

    /**
     * A13: die drei vorgehenden Zustellungen gehören nicht in die Strecke. Gespielt werden
     * nur die angenommenen; dass die anderen an der Datenannahme scheitern, ist ihr Vertrag
     * und wird dort geprüft ({@code MesszeitregelTest}). Hier wird belegt, dass sie nach
     * derselben Regel abzuweisen sind — sonst prüfte die Abnahme eine andere Grenze.
     */
    @Test
    void a13_keinWertInDerZukunft() throws Exception {
        JsonNode szenario = szenario("A13");
        List<JsonNode> abgewiesen = new ArrayList<>();
        for (JsonNode z : szenario.path("zustellungen")) {
            if (vorgehend(z)) {
                abgewiesen.add(z);
            }
        }
        assertThat(abgewiesen).as("drei Umschläge mit Messzeit in der Zukunft").hasSize(3);
        Set<Long> sequenzen = new LinkedHashSet<>();
        abgewiesen.forEach(z -> sequenzen.add(z.path("sequenz").asLong()));
        assertThat(ereignisSequenzen(szenario, "clock_ahead"))
                .as("das Drehbuch meldet genau diese Sequenzen als clock_ahead")
                .isEqualTo(sequenzen);

        spielenUndPruefen("A13");

        // Und keine einzige Zeile trägt eine Messzeit nach ihrer Eingangszeit.
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE time > received_at"))
                .as("keine Rohwerte in der Zukunft").isZero();
    }

    // ================================================== Werkzeug

    /**
     * Spielt die angenommenen Zustellungen eines Szenarios und vergleicht Zeilen und
     * Ereignisse mit dem Drehbuch.
     */
    private void spielenUndPruefen(String schluessel) throws Exception {
        JsonNode szenario = szenario(schluessel);
        createTopic();

        List<String> umschlaege = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        for (JsonNode z : szenario.path("zustellungen")) {
            if (!"measurement-samples".equals(z.path("strom").asText()) || vorgehend(z)) {
                continue;   // Ereignis-Umschläge und die Uhrfehler gehören der Datenannahme
            }
            umschlaege.add(umschlag(schluessel, z));
            JsonNode n = z.path("nutzlast");
            keys.add(n.path("tenant_id").asText() + ":" + n.path("site_id").asText() + ":"
                    + je(schluessel, n.path("device_id").asText()));
        }
        assertThat(umschlaege).as(schluessel + ": es wird wirklich gespielt").isNotEmpty();
        senden(keys, umschlaege);

        // Erst überhaupt etwas, dann die Zahlen: ein verworfener Umschlag ist im Writer nur
        // eine WARN-Zeile. Ohne diesen Vorlauf liefe jede Reihe in ihre volle Wartezeit und
        // meldete „0 statt N", statt zu sagen, dass gar nichts angekommen ist.
        warteBis(schluessel + ": kein einziger Wert ist angekommen — verwirft der Writer den "
                        + "Umschlag? (WARN „Skipping invalid measurements.raw event\")",
                () -> zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id IN ("
                        + boxen(szenario) + ")") > 0);

        // Erwartet wird JE MESSSTELLE UND ROLLE. Die Zahl kommt NICHT aus der Aufzählung des
        // Drehbuchs, sondern aus den gespielten Zustellungen unter den beiden Regeln, die die
        // Datenbank durchsetzt: Idempotenz über (Reihe, Messkanal, Messzeit) und die Rolle aus
        // der Zuständigkeit ZUR MESSZEIT. Was das Drehbuch sagt, wird daneben geprüft — und
        // wo beide auseinandergehen, sagt die Abweichung genau, worin.
        Map<String, Long> erwartet = ausDenZustellungen(szenario);
        Map<String, Long> lautDrehbuch = new TreeMap<>();
        for (JsonNode r : szenario.path("erwartete_reihen")) {
            lautDrehbuch.merge(r.path("messstelle").asText() + "/" + r.path("rolle").asText(),
                    r.path("rohzeilen").asLong(), Long::sum);
        }
        // Das Drehbuch zählt nur die Reihen AUF, um die es dem Abnahmefall geht; A3 spielt
        // daneben die Kontrollgruppe MS-05…MS-08 („MS-01…MS-08 ohne Ereignis"), die es nicht
        // nennt. Es muss also Teilmenge sein — wo es eine Reihe nennt, muss die Zahl stimmen.
        Map<String, Long> strittig = new TreeMap<>();
        lautDrehbuch.forEach((k, v) -> {
            if (!v.equals(erwartet.get(k))) {
                strittig.put(k, v);
            }
        });
        if (!strittig.isEmpty()) {
            // ⚠ A6, Befund am Drehbuch: der „Nachzügler mit Messzeit VOR dem Wechsel"
            // (Sequenz 90 503) trägt 05:29:50 — GENAU die Messzeit des Umschlags 90 502, der
            // schon liegt. Die Idempotenz (E3) speichert ihn zu Recht kein zweites Mal, also
            // sind es 6 führende Zeilen je Reihe und nicht 7. Der Fall kann damit nicht
            // zeigen, was er zeigen will; dass ein später eintreffender Wert der ALTEN Box mit
            // Messzeit vor dem Wechsel führend ist, beweist
            // WriterPipeTest#derNachzueglerIstFuehrendUndDerSpaetereEinSpiegel mit eigenen
            // Messzeiten. Wir folgen den Zeitstempeln, nicht dem Abnahmetext.
            assertThat(schluessel)
                    .as("nur A6 weicht bekannt ab; jede andere Abweichung ist neu und zu klären:"
                            + " aus den Zustellungen " + erwartet + " vs. Drehbuch " + strittig)
                    .isEqualTo("A6");
        }
        Map<String, String> entity = new LinkedHashMap<>();
        for (JsonNode r : szenario.path("stammdaten").path("reihen")) {
            entity.put(r.path("messstelle").asText(), je(schluessel, r.path("entity_id").asText()));
        }

        for (Map.Entry<String, Long> e : erwartet.entrySet()) {
            String[] teile = e.getKey().split("/");
            String id = entity.get(teile[0]);
            assertThat(id).as(schluessel + ": " + teile[0] + " hat Stammdaten").isNotNull();
            warte(schluessel + ": " + teile[0] + " als " + teile[1],
                    () -> zaehle("SELECT count(*) FROM device_measurement_sample WHERE entity_id='"
                            + id + "' AND role='" + teile[1] + "' AND time >= '"
                            + fruehesteMesszeit(szenario) + "' AND time <= '"
                            + spaetesteMesszeit(szenario) + "'"),
                    e.getValue(), () -> reihenBeleg(id));
        }

        // Die erwarteten Ereignisse — aber nur die, die der WRITER schreibt.
        for (String art : writerEreignisarten(szenario)) {
            if (MELDER_ARTEN.contains(art)) {
                // ⚠ Befund am Drehbuch: `data_gap` und `backfill` trägt das Drehbuch als
                // urheber `writer`. Geschrieben werden sie aber vom LÜCKEN-MELDER (AP-07
                // IP-9, ein Takt in services/api, urheber `cloud`) — der Writer sieht beim
                // Einlauf nur den einzelnen Wert und kann eine Lücke gar nicht kennen.
                // Dieser Lauf belegt darum, dass sie hier NICHT entstehen; dass sie
                // entstehen, zeigt UemsLueckenMelderTest.
                assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE art='" + art
                        + "' AND urheber='writer' AND device_id IN (" + boxen(szenario) + ")"))
                        .as(schluessel + ": " + art + " ist Sache des Lücken-Melders, "
                                + "nicht des Writers")
                        .isZero();
                continue;
            }
            warte(schluessel + ": Ereignis " + art + " ist festgehalten",
                    () -> zaehle("SELECT count(*) FROM messreihe_ereignis WHERE art='" + art
                            + "' AND urheber='writer' AND device_id IN (" + boxen(szenario) + ")"),
                    erwarteteZahl(szenario, art),
                    () -> beleg(szenario, art));
        }

        // Die Sequenzregel gilt IMMER, auch wo das Drehbuch sie nicht aufzählt.
        for (String art : List.of("sequence_gap", "sequence_reset")) {
            long ausDenSequenzen = ausDenSequenzen(szenario, art);
            if (ausDenSequenzen == 0 || writerEreignisarten(szenario).contains(art)) {
                continue;
            }
            warte(schluessel + ": " + art + " nach der Sequenzregel",
                    () -> zaehle("SELECT count(*) FROM messreihe_ereignis WHERE art='" + art
                            + "' AND urheber='writer' AND device_id IN (" + boxen(szenario) + ")"),
                    ausDenSequenzen, () -> beleg(szenario, art));
        }
    }

    /**
     * Die Zeilen, die aus den GESPIELTEN Zustellungen entstehen müssen, je Messstelle und
     * Rolle. Zwei Regeln, beide von der Datenbank durchgesetzt:
     *
     * <ul>
     *   <li><b>Idempotenz</b> — ein Wert ist (Reihe, Messkanal, Messzeit); dieselbe Messzeit
     *       ein zweites Mal ist kein zweiter Wert ({@code uq_device_measurement_sample_reihe});
     *   <li><b>Rolle zur MESSZEIT</b> — führend, wenn die liefernde Box zu dieser Messzeit
     *       zuständig war, sonst Spiegel (W8: Spiegel statt Verwerfen).
     * </ul>
     */
    private static Map<String, Long> ausDenZustellungen(JsonNode szenario) {
        Map<String, java.util.Set<String>> schluessel = new TreeMap<>();
        Map<String, String> punktZuReihe = new LinkedHashMap<>();
        for (JsonNode r : szenario.path("stammdaten").path("reihen")) {
            punktZuReihe.put(r.path("point_key").asText(), r.path("messstelle").asText());
        }

        for (JsonNode z : szenario.path("zustellungen")) {
            if (!"measurement-samples".equals(z.path("strom").asText()) || vorgehend(z)) {
                continue;
            }
            String box = z.path("nutzlast").path("device_id").asText();
            for (JsonNode sample : z.path("nutzlast").path("samples")) {
                String punkt = sample.path("point_key").asText();
                String reihe = punktZuReihe.get(punkt);
                if (reihe == null) {
                    // A1 hängt einen Kanal-Index an: custom.ms-10.…-bezug.07
                    reihe = punktZuReihe.get(punkt.substring(0, Math.max(0,
                            punkt.lastIndexOf('.'))));
                }
                if (reihe == null) {
                    continue;
                }
                String messzeit = sample.path("observed_at").asText();
                String rolle = zustaendig(szenario, box, messzeit) ? "fuehrend" : "spiegel";
                schluessel.computeIfAbsent(reihe + "/" + rolle, k -> new LinkedHashSet<>())
                        .add(punkt + "@" + messzeit);
            }
        }

        Map<String, Long> zahlen = new TreeMap<>();
        schluessel.forEach((k, v) -> zahlen.put(k, (long) v.size()));
        return zahlen;
    }

    /** War diese Box zu dieser Messzeit zuständig? Halboffen: [von, bis). */
    private static boolean zustaendig(JsonNode szenario, String box, String messzeit) {
        for (JsonNode z : szenario.path("stammdaten").path("zustaendigkeiten")) {
            if (!box.equals(z.path("device_id").asText())) {
                continue;
            }
            boolean nachVon = messzeit.compareTo(z.path("von").asText()) >= 0;
            boolean vorBis = z.path("bis").isNull()
                    || messzeit.compareTo(z.path("bis").asText()) < 0;
            if (nachVon && vorBis) {
                return true;
            }
        }
        return false;
    }

    /** Eine Zustellung, deren Messzeiten weiter als die Toleranz in der Zukunft stehen. */
    private static boolean vorgehend(JsonNode z) {
        Instant eingang = Instant.parse(z.path("eingangszeit").asText());
        for (JsonNode s : z.path("nutzlast").path("samples")) {
            if (Instant.parse(s.path("observed_at").asText()).isAfter(eingang.plus(UHR_TOLERANZ))) {
                return true;
            }
        }
        return false;
    }

    /** Der {@code measurements.raw}-Umschlag, den die Datenannahme aus diesem Publish baut. */
    private static String umschlag(String sz, JsonNode z) throws Exception {
        JsonNode n = z.path("nutzlast");
        var out = MAPPER.createObjectNode();
        out.put("schema_version", "1.0");
        out.put("event_id", java.util.UUID.randomUUID().toString());
        out.put("tenant_id", n.path("tenant_id").asText());
        out.put("site_id", n.path("site_id").asText());
        out.put("device_id", je(sz, n.path("device_id").asText()));
        out.put("catalog_version", n.path("catalog_version").asText());
        out.put("sequence", n.path("sequence").asLong());
        out.put("observed_at", n.path("observed_at").asText());
        out.put("ingested_at", z.path("eingangszeit").asText());
        // ⚠ Der Writer prüft Topic und Umschlag auf IDENTITÄT
        // (`ems/<mandant>/<anlage>/<box>/v2/measurement-samples`). Das Topic des Drehbuchs
        // nennt die Ahrenberg-Box; hier gilt die je Szenario abgebildete. Wer das Topic
        // einfach kopiert, bekommt 234 stille `Skipping invalid measurements.raw event`.
        out.put("source_topic", "ems/" + n.path("tenant_id").asText() + "/"
                + n.path("site_id").asText() + "/" + je(sz, n.path("device_id").asText())
                + "/v2/measurement-samples");
        out.put("dropped_samples", 0);
        out.put("gap", false);
        // ⚠ Die Datenannahme reicht die 2.1-Herkunftsfelder NICHT weiter: sie prüft
        // `applied_revision` und `entity_id` und lässt beide dann fallen
        // (MeasurementSamplesValidator: "ingest validates them but does not forward them").
        // Der Umschlag der Strecke ist darum 1.0 mit genau den 2.0-Feldern — und der Writer
        // schlägt Komponente, Fassung und Rolle ZUR MESSZEIT selbst nach (IP-7). Genau das
        // soll diese Abnahme prüfen; ein Umschlag mit Herkunft am Draht würde sie umgehen.
        var samples = MAPPER.createArrayNode();
        for (JsonNode s : n.path("samples")) {
            var kopie = (com.fasterxml.jackson.databind.node.ObjectNode) s.deepCopy();
            kopie.remove("entity_id");
            samples.add(kopie);
        }
        out.set("samples", samples);
        return MAPPER.writeValueAsString(out);
    }

    /** Stammdaten EINES Szenarios: Box, Quelle mit Zuständigkeit, Gerät, Bindung, Auswahl. */
    private static void saee(Statement st, JsonNode szenario) throws Exception {
        JsonNode stamm = szenario.path("stammdaten");
        String tenant = stamm.path("tenant_id").asText();
        String sz = szenario.path("szenario").asText();

        for (JsonNode b : stamm.path("boxen")) {
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('"
                    + je(sz, b.path("device_id").asText()) + "','" + tenant + "','"
                    + b.path("site_id").asText() + "') ON CONFLICT DO NOTHING");
        }
        Set<String> quellen = new LinkedHashSet<>();
        for (JsonNode z : stamm.path("zustaendigkeiten")) {
            String quelle = z.path("datenquelle_id").asText();
            if (quellen.add(quelle)) {
                st.execute("INSERT INTO data_source(id,tenant_id,kennzeichen,kadenz_s) VALUES ('"
                        + quelle + "','" + tenant + "','" + z.path("kennzeichen").asText() + "',"
                        + z.path("kadenz_s").asLong() + ") ON CONFLICT DO NOTHING");
            }
            st.execute("INSERT INTO data_source_assignment(tenant_id,data_source_id,device_id,"
                    + "effective_from,effective_to) VALUES ('" + tenant + "','" + quelle + "','"
                    + je(sz, z.path("device_id").asText()) + "','" + z.path("von").asText() + "',"
                    + (z.path("bis").isNull() ? "NULL" : "'" + z.path("bis").asText() + "'") + ")");
        }
        for (JsonNode r : stamm.path("reihen")) {
            String geraet = r.path("geraet_id").asText();
            String entity = je(sz, r.path("entity_id").asText());
            st.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,device_id,"
                    + "data_source_id) VALUES ('" + entity + "','" + tenant + "','"
                    + r.path("site_id").asText() + "','grid','"
                    + je(sz, r.path("device_id").asText())
                    + "','" + r.path("datenquelle_id").asText() + "') ON CONFLICT DO NOTHING");
            st.execute("INSERT INTO geraet(id,tenant_id,site_id,kennzeichen,einbau_kennzeichen,"
                    + "seriennummer,eingebaut_am) VALUES ('" + geraet + "','" + tenant + "','"
                    + r.path("site_id").asText() + "','" + r.path("komponente").asText() + "','"
                    + r.path("einbau_kennzeichen").asText() + "','SN-"
                    + r.path("einbau_kennzeichen").asText() + "','"
                    + r.path("eingebaut_am").asText() + "') ON CONFLICT DO NOTHING");
            st.execute("INSERT INTO geraet_komponente(tenant_id,geraet_id,entity_id,gueltig_ab) "
                    + "VALUES ('" + tenant + "','" + geraet + "','" + entity + "','"
                    + r.path("eingebaut_am").asText() + "')");
        }

        // Jeder Punktschlüssel am Draht braucht Katalogeintrag, Auswahl und Bindung. A1
        // hängt einen Kanal-Index an (256 Punkte über fünf Reihen) — gesät wird darum,
        // was das Drehbuch WIRKLICH sendet, nicht der eine Punkt je Reihe.
        Map<String, JsonNode> reiheZuEntity = new LinkedHashMap<>();
        for (JsonNode r : stamm.path("reihen")) {
            reiheZuEntity.put(r.path("entity_id").asText(), r);   // Kennung des Drehbuchs
        }
        Set<String> gesaet = new LinkedHashSet<>();
        for (JsonNode z : szenario.path("zustellungen")) {
            JsonNode n = z.path("nutzlast");
            for (JsonNode s : n.path("samples")) {
                String punkt = s.path("point_key").asText();
                String drehbuchEntity = s.path("entity_id").asText(null);
                JsonNode r = drehbuchEntity == null ? null : reiheZuEntity.get(drehbuchEntity);
                if (r == null || !gesaet.add(n.path("device_id").asText() + "|" + punkt)) {
                    continue;
                }
                String entity = je(sz, drehbuchEntity);
                String box = je(sz, n.path("device_id").asText());
                st.execute("INSERT INTO measurement_catalog_point_metadata VALUES ('"
                        + n.path("catalog_version").asText() + "','" + punkt
                        + "','counter',900) ON CONFLICT DO NOTHING");
                st.execute("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,"
                        + "point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,"
                        + "changed_by,apply_status,applied_at,retention_class,raw_retention_days,"
                        + "long_term_cadence_s,long_term_strategy,entity_id) VALUES ('" + tenant
                        + "','" + n.path("site_id").asText() + "','" + box
                        + "','" + punkt + "',true,60,"
                        + n.path("applied_revision").asLong(1) + ",'"
                        + r.path("eingebaut_am").asText() + "','"
                        + n.path("catalog_version").asText() + "','abnahme','applied','"
                        + r.path("eingebaut_am").asText() + "','energy_counter',90,900,"
                        + "'fifteen_minute','" + entity + "')");
                st.execute("INSERT INTO messstelle_quelle(tenant_id,messstelle_id,entity_id,"
                        + "geraet_id,kanal,rolle,gueltig_ab) VALUES ('" + tenant + "','"
                        + r.path("messstelle_id").asText() + "','" + entity + "','"
                        + r.path("geraet_id").asText() + "','" + punkt + "','fuehrend','"
                        + r.path("gebunden_ab").asText() + "')");
            }
        }
        for (JsonNode r : stamm.path("reihen")) {
            st.execute("INSERT INTO messstelle_kennzeichen(tenant_id,kennzeichen,messstelle_id) "
                    + "VALUES ('" + tenant + "','" + szenario.path("szenario").asText() + "-"
                    + r.path("messstelle").asText() + "','" + r.path("messstelle_id").asText()
                    + "') ON CONFLICT DO NOTHING");
        }
    }

    /**
     * Die fünf Szenarien benutzen dieselben Ahrenberg-Kennungen (Box E-2 liest in A1, A3 und
     * A4). Nacheinander in EINER Datenbank würden sie sich Box, Komponente und Zuständigkeit
     * gegenseitig überschreiben — {@code device.id} und {@code measurement_point.id} sind
     * Primärschlüssel. Jede dieser beiden Kennungen bekommt darum je Szenario eine eigene,
     * deterministisch abgeleitete. An der Strecke ändert das nichts: sie liest Kennungen, sie
     * deutet sie nicht. Gerät, Messstelle und Datenquelle sind schon im Drehbuch je Szenario
     * eigen und bleiben, wie sie dort stehen.
     */
    private static String je(String schluessel, String kennung) {
        return java.util.UUID.nameUUIDFromBytes((schluessel + ":" + kennung)
                .getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static List<String> schluessel() {
        List<String> alle = new ArrayList<>();
        drehbuch.path("szenarien").forEach(s -> alle.add(s.path("szenario").asText()));
        return alle;
    }

    private static JsonNode szenario(String schluessel) {
        for (JsonNode s : drehbuch.path("szenarien")) {
            if (schluessel.equals(s.path("szenario").asText())) {
                return s;
            }
        }
        throw new AssertionError("kein Szenario " + schluessel + " im Drehbuch");
    }

    private static Set<String> writerEreignisarten(JsonNode szenario) {
        Set<String> arten = new LinkedHashSet<>();
        for (JsonNode e : szenario.path("erwartete_ereignisse")) {
            if ("writer".equals(e.path("urheber").asText())) {
                arten.add(e.path("ereignis").path("art").asText());
            }
        }
        return arten;
    }

    /**
     * Wie oft dieses Ereignis zu erwarten ist. Für die Sequenz-Arten NICHT aus der Aufzählung
     * des Drehbuchs, sondern aus der Regel des Vertrags: {@code sequence_gap} und
     * {@code sequence_reset} entstehen EINMAL JE UMSCHLAG, dessen Sequenz springt
     * ({@code MesswertEreignisse}). ⚠ Befund am Drehbuch: es zählt für A4 nur den EINEN
     * Sprung des Abnahmetextes (48 214 → 48 402) auf, gespielt werden aber vier
     * aufeinanderfolgende Sprünge (7 → 48 402 → 52 002 → 55 601 → 62 001) und ein
     * Rücksprung (48 213 → 7), den es gar nicht nennt. Der Writer hat recht, die
     * Aufzählung ist unvollständig — darum rechnet dieser Lauf nach der Regel.
     */
    private static long erwarteteZahl(JsonNode szenario, String art) {
        if ("sequence_gap".equals(art) || "sequence_reset".equals(art)) {
            return ausDenSequenzen(szenario, art);
        }
        if ("unassigned_reader".equals(art)) {
            return ausDenSpiegeln(szenario);
        }
        return ereignisSequenzenOderZahl(szenario, art);
    }

    /**
     * {@code unassigned_reader} entsteht EINMAL je Umschlag, Box und Datenquelle — gebündelt
     * als Zeitraum über die gespiegelten Messzeiten, mit {@code anzahl}, und gedrosselt auf
     * höchstens einmal je Stunde je Box und Datenquelle ({@code MesswertEreignisse}).
     *
     * <p>⚠ Befund am Drehbuch: A6 zählt VIER auf, eine je Messstelle. Das widerspricht der
     * Bündelung und dem Abnahmetext A9 selbst („≤ 1 je Stunde"). Gespielt wird EIN Umschlag
     * mit gespiegelten Werten, also ist EINS richtig.
     */
    private static long ausDenSpiegeln(JsonNode szenario) {
        Set<String> gedrosselt = new LinkedHashSet<>();
        for (JsonNode z : szenario.path("zustellungen")) {
            if (!"measurement-samples".equals(z.path("strom").asText()) || vorgehend(z)) {
                continue;
            }
            String box = z.path("nutzlast").path("device_id").asText();
            for (JsonNode sample : z.path("nutzlast").path("samples")) {
                String messzeit = sample.path("observed_at").asText();
                if (!zustaendig(szenario, box, messzeit)) {
                    gedrosselt.add(box + "|" + messzeit.substring(0, 13));   // Box je Stunde
                    break;
                }
            }
        }
        return gedrosselt.size();
    }

    /** Sprünge der Sequenz je Box über die GESPIELTEN Umschläge, in ihrer Reihenfolge. */
    private static long ausDenSequenzen(JsonNode szenario, String art) {
        Map<String, Long> letzte = new LinkedHashMap<>();
        long n = 0;
        for (JsonNode z : szenario.path("zustellungen")) {
            if (!"measurement-samples".equals(z.path("strom").asText()) || vorgehend(z)
                    || z.path("nutzlast").path("samples").isEmpty()) {
                continue;   // leere und abgewiesene Umschläge erreichen den Writer nie
            }
            String box = z.path("nutzlast").path("device_id").asText();
            long seq = z.path("sequenz").asLong();
            Long vor = letzte.put(box, seq);
            if (vor == null) {
                continue;   // der erste Umschlag einer Box hat keinen Vorgänger
            }
            if ("sequence_gap".equals(art) && seq > vor + 1) {
                n++;
            }
            if ("sequence_reset".equals(art) && seq < vor) {
                n++;
            }
        }
        return n;
    }

    private static int ereignisSequenzenOderZahl(JsonNode szenario, String art) {
        int n = 0;
        for (JsonNode e : szenario.path("erwartete_ereignisse")) {
            if ("writer".equals(e.path("urheber").asText())
                    && art.equals(e.path("ereignis").path("art").asText())) {
                n++;
            }
        }
        return n;
    }

    private static Set<Long> ereignisSequenzen(JsonNode szenario, String art) {
        Set<Long> seq = new LinkedHashSet<>();
        for (JsonNode e : szenario.path("erwartete_ereignisse")) {
            if (art.equals(e.path("ereignis").path("art").asText())) {
                seq.add(e.path("ereignis").path("sequenz").asLong());
            }
        }
        return seq;
    }

    private static String boxen(JsonNode szenario) {
        StringBuilder sb = new StringBuilder();
        for (JsonNode b : szenario.path("stammdaten").path("boxen")) {
            sb.append(sb.length() == 0 ? "" : ",").append("'")
                    .append(je(szenario.path("szenario").asText(), b.path("device_id").asText()))
                    .append("'");
        }
        return sb.toString();
    }

    private static String fruehesteMesszeit(JsonNode szenario) {
        return grenze(szenario, true);
    }

    private static String spaetesteMesszeit(JsonNode szenario) {
        return grenze(szenario, false);
    }

    private static String grenze(JsonNode szenario, boolean frueheste) {
        String grenze = null;
        for (JsonNode z : szenario.path("zustellungen")) {
            for (JsonNode s : z.path("nutzlast").path("samples")) {
                String t = s.path("observed_at").asText();
                if (grenze == null || (frueheste ? t.compareTo(grenze) < 0 : t.compareTo(grenze) > 0)) {
                    grenze = t;
                }
            }
        }
        return grenze;
    }

    private void senden(List<String> keys, List<String> pakete) throws Exception {
        try (KafkaProducer<String, String> producer = producer()) {
            for (int i = 0; i < pakete.size(); i++) {
                producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, keys.get(i),
                        pakete.get(i))).get();
            }
            producer.flush();
        }
    }

    private static KafkaProducer<String, String> producer() {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        return new KafkaProducer<>(props);
    }

    private static void createTopic() throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(MEASUREMENTS_RAW_TOPIC, 1, (short) 1)))
                    .all().get();
        } catch (java.util.concurrent.ExecutionException e) {
            if (!(e.getCause() instanceof TopicExistsException)) {
                throw e;
            }
        }
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

    private void warteBis(String was, Bedingung bedingung) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        while (System.nanoTime() < deadline) {
            if (bedingung.erfuellt()) {
                return;
            }
            Thread.sleep(250);
        }
        throw new AssertionError(was);
    }

    private interface Bedingung {
        boolean erfuellt() throws Exception;
    }

    private void warte(String was, Zaehlung zaehlung, long erwartet) throws Exception {
        warte(was, zaehlung, erwartet, () -> "");
    }

    /**
     * Wartet auf eine Zahl und sagt bei Misserfolg, was statt dessen DA ist. Eine Abnahme, die
     * nur „6 statt 7" meldet, zwingt den nächsten Leser in einen zweiten Lauf.
     */
    private void warte(String was, Zaehlung zaehlung, long erwartet, Beleg beleg)
            throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        long ist = -1;
        while (System.nanoTime() < deadline) {
            ist = zaehlung.zaehle();
            if (ist == erwartet) {
                return;
            }
            Thread.sleep(250);
        }
        throw new AssertionError(was + ": " + ist + " statt " + erwartet + "\n" + beleg.text());
    }

    private interface Beleg {
        String text() throws Exception;
    }

    /** Jede Zeile dieser Reihe mit Messzeit, Rolle und Box — der Beleg für „6 statt 7". */
    private static String reihenBeleg(String entity) throws Exception {
        StringBuilder sb = new StringBuilder("  Zeilen dieser Reihe:\n");
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT time, role, device_id, edge_sequence, "
                        + "delivery FROM device_measurement_sample WHERE entity_id='" + entity
                        + "' ORDER BY time LIMIT 40")) {
            while (rs.next()) {
                sb.append("    ").append(rs.getString(1)).append(" / ").append(rs.getString(2))
                        .append(" / ").append(rs.getString(3)).append(" / ").append(rs.getLong(4))
                        .append(" / ").append(rs.getString(5)).append("\n");
            }
        }
        return sb.toString();
    }

    /** Was WIRKLICH in der Ereignis-Tabelle steht — die Zeilen, nicht nur ihre Zahl. */
    private static String beleg(JsonNode szenario, String art) throws Exception {
        StringBuilder sb = new StringBuilder("  gefunden für art=" + art + ":\n");
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT art, urheber, entity_id, messkanal, "
                        + "nutzlast FROM messreihe_ereignis WHERE device_id IN ("
                        + boxen(szenario) + ") ORDER BY art, entity_id LIMIT 40")) {
            while (rs.next()) {
                sb.append("    ").append(rs.getString(1)).append(" / ").append(rs.getString(2))
                        .append(" / ").append(rs.getString(3)).append(" / ")
                        .append(rs.getString(4)).append(" / ").append(rs.getString(5))
                        .append("\n");
            }
        }
        return sb.toString();
    }

    private interface Zaehlung {
        long zaehle() throws Exception;
    }
}
