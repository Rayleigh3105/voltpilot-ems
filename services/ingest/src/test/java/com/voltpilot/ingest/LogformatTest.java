package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.LoggerContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.boot.logging.LoggingInitializationContext;
import org.springframework.boot.logging.LoggingSystem;
import org.springframework.boot.logging.logback.LogbackLoggingSystem;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.mock.env.MockEnvironment;
import org.yaml.snakeyaml.Yaml;

/**
 * Der Vertrag der Log-Zeile (docs/k8s-readiness.md, Abschnitt "Logs") an der ausgelieferten
 * {@code logback-spring.xml} - ohne Docker, ohne Spring-Kontext. Dieselbe Klasse steht in api,
 * ingest und timescale-writer, weil dieselbe Datei in allen drei Diensten liegt.
 *
 * <p>Zwei Zusagen: Mit {@code voltpilot.logging.format=json} ist jedes Ereignis genau eine
 * JSON-Zeile mit den Feldern, die die Log-Verarbeitung im Cluster liest. Ohne den Schalter ist die
 * Zeile dieselbe wie ohne unsere Datei - verglichen wird gegen Spring Boots eingebaute Vorgabe und
 * nicht gegen ein abgeschriebenes Muster, damit auch eine Abweichung in der Stapelspur auffällt.
 */
@ExtendWith(OutputCaptureExtension.class)
class LogformatTest {

    private static final String PROBE = "com.voltpilot.logformat.Probe";
    private static final Logger log = LoggerFactory.getLogger(PROBE);
    private static final Pattern ZEITSTEMPEL =
            Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}[+-]\\d{2}:\\d{2} ");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SCHALTER = "voltpilot.logging.format";
    private static final String VORGANG = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
    private static final String MANDANT = "7f3c1e6a-2b4d-4c8e-9a10-5d6e7f8091a2";
    /** Ein und dieselbe Ausnahme für jeden Lauf: zwei Formate lassen sich nur an derselben Spur vergleichen. */
    private static final Exception FEHLER =
            new IllegalStateException("Schreiben gescheitert", new IOException("Verbindung weg"));

    private boolean warGestartet;

    /** Ob ein früherer Spring-Kontext dieser JVM das Logging schon eingerichtet hat. */
    @BeforeEach
    void zustandMerken() {
        MDC.clear();
        warGestartet = ((LoggerContext) LoggerFactory.getILoggerFactory()).getObject(LoggingSystem.class.getName()) != null;
    }

    /**
     * Die JVM so verlassen, wie sie war: Textformat, und "eingerichtet" nur, wenn sie es vorher war -
     * sonst richtet der nächste Spring-Kontext sein Logging nicht mehr selbst ein.
     */
    @AfterEach
    void vorgabeWiederherstellen() {
        MDC.clear();
        LoggingSystem system = unsereDatei();
        starte(system, Map.of());
        if (!warGestartet) {
            system.cleanUp();
        }
    }

    @Test
    void jsonSchreibtJeEreignisEineZeileMitDenVertragsfeldern(CapturedOutput ausgabe) throws Exception {
        starte(unsereDatei(), Map.of(SCHALTER, "json"));
        MDC.put("request_id", VORGANG);
        MDC.put("tenant_id", MANDANT);

        List<JsonNode> zeilen = json(ausgabe, () -> log.info("Messwert angenommen"));

        assertThat(zeilen).hasSize(1);
        JsonNode zeile = zeilen.get(0);
        assertThat(zeile.fieldNames()).toIterable().containsExactlyInAnyOrder(
                "@timestamp", "level", "logger", "thread", "message", "request_id", "tenant_id");
        assertThat(zeile.get("@timestamp").asText())
                .as("UTC mit Millisekunden, RFC 3339")
                .matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z");
        assertThat(zeile.get("level").asText()).isEqualTo("INFO");
        assertThat(zeile.get("logger").asText()).isEqualTo(PROBE);
        assertThat(zeile.get("message").asText()).isEqualTo("Messwert angenommen");
        assertThat(zeile.get("request_id").asText()).isEqualTo(VORGANG);
        assertThat(zeile.get("tenant_id").asText()).isEqualTo(MANDANT);
    }

    @Test
    void jsonLaesstUnbekannteKennungenWegStattSieLeerZuSchreiben(CapturedOutput ausgabe) throws Exception {
        starte(unsereDatei(), Map.of(SCHALTER, "json"));

        JsonNode zeile = json(ausgabe, () -> log.warn("ohne Vorgang")).get(0);

        assertThat(zeile.has("request_id")).isFalse();
        assertThat(zeile.has("tenant_id")).isFalse();
        assertThat(zeile.get("level").asText()).isEqualTo("WARN");
    }

    /** Die Sperrliste der Datei: kein MDC-Schlüssel außer den zwei vereinbarten erreicht die Zeile. */
    @Test
    void jsonNimmtKeinenWeiterenMdcSchluesselMit(CapturedOutput ausgabe) throws Exception {
        starte(unsereDatei(), Map.of(SCHALTER, "json"));
        MDC.put("request_id", VORGANG);
        MDC.put("benutzer", "erika.muster@example.org");

        List<JsonNode> zeilen = json(ausgabe, () -> log.info("angemeldet"));

        assertThat(zeilen).hasSize(1);
        assertThat(zeilen.get(0).toString()).contains(VORGANG).doesNotContain("erika").doesNotContain("benutzer");
    }

    @Test
    void jsonHaeltEineMehrzeiligeStapelspurInEinemEreignis(CapturedOutput ausgabe) throws Exception {
        starte(unsereDatei(), Map.of(SCHALTER, "json"));

        List<JsonNode> zeilen = json(ausgabe, () -> log.error("Batch verworfen\nzweite Zeile", FEHLER));

        assertThat(zeilen).as("ein Ereignis, eine Zeile").hasSize(1);
        JsonNode zeile = zeilen.get(0);
        assertThat(zeile.get("level").asText()).isEqualTo("ERROR");
        assertThat(zeile.get("message").asText()).isEqualTo("Batch verworfen\nzweite Zeile");
        assertThat(zeile.get("stack_trace").asText())
                .startsWith("java.lang.IllegalStateException: Schreiben gescheitert")
                .contains("\n\tat " + LogformatTest.class.getName())
                .contains("Caused by: java.io.IOException: Verbindung weg");
    }

    /** Volle Tiefe wie in der Textzeile - gekürzt wird erst an der Längengrenze der Datei. */
    @Test
    void jsonKuerztEineGewoehnlicheSpurNichtUndDeckeltEineEntgleiste(CapturedOutput ausgabe) throws Exception {
        starte(unsereDatei(), Map.of(SCHALTER, "json"));

        String gewoehnlich = json(ausgabe, () -> log.error("tief", tief(200))).get(0).get("stack_trace").asText();
        String entgleist = json(ausgabe, () -> log.error("endlos", tief(4000))).get(0).get("stack_trace").asText();

        assertThat(gewoehnlich.lines().filter(z -> z.contains("LogformatTest.tief")).count()).isEqualTo(201);
        assertThat(entgleist.length()).isLessThanOrEqualTo(65536);
        assertThat(entgleist).startsWith("java.lang.IllegalStateException: ganz unten");
    }

    @Test
    void ohneSchalterBleibtDieTextzeileVonSpringBootUnveraendert(CapturedOutput ausgabe) {
        String vorgabe = text(ausgabe, ohneUnsereDatei(), Map.of());
        String unsere = text(ausgabe, unsereDatei(), Map.of());

        assertThat(vorgabe).as("Vergleichsmaß darf nicht leer sein")
                .contains(" INFO ").contains("Messwert angenommen")
                .contains("java.lang.IllegalStateException: Schreiben gescheitert")
                .contains("Caused by: java.io.IOException: Verbindung weg");
        assertThat(unsere).isEqualTo(vorgabe);
    }

    @Test
    void textIstDieAusgelieferteVorgabeUndJederUnbekannteWertFaelltDaraufZurueck(CapturedOutput ausgabe) {
        String vorgabe = text(ausgabe, unsereDatei(), Map.of());

        assertThat(text(ausgabe, unsereDatei(), Map.of(SCHALTER, "text"))).isEqualTo(vorgabe);
        assertThat(text(ausgabe, unsereDatei(), Map.of(SCHALTER, "JSON"))).isEqualTo(vorgabe);
        assertThat(text(ausgabe, unsereDatei(), Map.of(SCHALTER, "jsno"))).isEqualTo(vorgabe);
        assertThat(text(ausgabe, unsereDatei(), Map.of(SCHALTER, ""))).isEqualTo(vorgabe);
    }

    /**
     * Das Glied davor: die ausgelieferte application.yml füllt den Schalter aus der Umgebungsvariablen,
     * die docs/k8s-readiness.md nennt und die das Manifest setzt - mit Vorgabe text.
     */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteAnwendungLiestDenSchalterAusVoltpilotLoggingFormat() throws Exception {
        try (InputStream yml = LogformatTest.class.getResourceAsStream("/application.yml")) {
            Map<String, Object> wurzel = (Map<String, Object>) new Yaml().loadAll(yml).iterator().next();
            Map<String, Object> logging = (Map<String, Object>) ((Map<String, Object>) wurzel.get("voltpilot")).get("logging");

            assertThat(logging).containsExactly(Map.entry("format", "${VOLTPILOT_LOGGING_FORMAT:text}"));
        }
    }

    // --- Gerüst -----------------------------------------------------------------------------

    /** Spring Boot, wie es im Dienst startet: findet {@code logback-spring.xml} auf dem Klassenpfad. */
    private static LoggingSystem unsereDatei() {
        return new LogbackLoggingSystem(LogformatTest.class.getClassLoader());
    }

    /** Spring Boot, als gäbe es unsere Datei nicht: die eingebaute Konsolen-Vorgabe. */
    private static LoggingSystem ohneUnsereDatei() {
        return new LogbackLoggingSystem(LogformatTest.class.getClassLoader()) {
            @Override
            protected String[] getStandardConfigLocations() {
                return new String[0];
            }
        };
    }

    private static void starte(LoggingSystem system, Map<String, String> eigenschaften) {
        MockEnvironment umgebung = new MockEnvironment();
        eigenschaften.forEach(umgebung::setProperty);
        system.cleanUp();
        system.beforeInitialize();
        system.initialize(new LoggingInitializationContext(umgebung), null, null);
    }

    /** Was {@code schreiben} auf stdout hinterlässt, Zeile für Zeile. */
    private static List<String> roh(CapturedOutput ausgabe, Runnable schreiben) {
        int ab = ausgabe.getOut().length();
        schreiben.run();
        return ausgabe.getOut().substring(ab).lines().toList();
    }

    /**
     * Die JSON-Zeilen dieses Tests. JEDE Zeile auf stdout muss für sich ein JSON-Objekt sein; gezählt
     * werden nur die des Probe-Loggers - in einer großen Suite schreiben Hintergrund-Fäden früherer
     * Testkontexte (Kafka-Clients, Verbindungspools) durch denselben Appender weiter.
     */
    private static List<JsonNode> json(CapturedOutput ausgabe, Runnable schreiben) throws Exception {
        List<JsonNode> zeilen = new ArrayList<>();
        for (String zeile : roh(ausgabe, schreiben)) {
            JsonNode knoten = JSON.readTree(zeile);
            assertThat(knoten.isObject()).as("JSON-Objekt: %s", zeile).isTrue();
            if (PROBE.equals(knoten.path("logger").asText())) {
                zeilen.add(knoten);
            }
        }
        return zeilen;
    }

    /**
     * Dieselben zwei Ereignisse im Textformat; der Zeitstempel ist das Einzige, was sich je Lauf ändert.
     * Ein Ereignis beginnt an einer Zeile mit Zeitstempel und reicht bis zur nächsten; die Ereignisse
     * fremder Logger (siehe {@link #json}) bleiben draußen.
     */
    private static String text(CapturedOutput ausgabe, LoggingSystem system, Map<String, String> eigenschaften) {
        starte(system, eigenschaften);
        StringBuilder eigene = new StringBuilder();
        boolean meins = false;
        for (String zeile : roh(ausgabe, () -> {
            log.info("Messwert angenommen");
            log.error("Batch verworfen", FEHLER);
        })) {
            if (ZEITSTEMPEL.matcher(zeile).find()) {
                meins = zeile.contains(" " + PROBE + " ");
            }
            if (meins) {
                eigene.append(ZEITSTEMPEL.matcher(zeile).replaceFirst("<zeit> ")).append('\n');
            }
        }
        return eigene.toString();
    }

    /** Eine Ausnahme mit {@code rest + 1} eigenen Frames. */
    private static IllegalStateException tief(int rest) {
        return rest == 0 ? new IllegalStateException("ganz unten") : tief(rest - 1);
    }
}
