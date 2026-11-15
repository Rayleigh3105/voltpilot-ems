package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * <b>Der Vertrag hinter dem Alarm „Der MQTT-Broker verwirft Nachrichten“</b> (Lasttest vp-lasttest, Befunde B2 und
 * B7, Rang 2). Der Broker verwirft still, wenn ein Abonnent nicht nachkommt: die Warteschlange der Sitzung ist voll
 * (EMQX-Vorgabe 1 000), die Box hat ihr PUBACK, niemand merkt etwas. Im Lasttest waren es bei 500 Boxen 66 322
 * verworfene Zustellungen an die Status-Abos der api. Zählen kann das nur der Broker.
 *
 * <p>Das gitops-Repo scrapt dafür {@code GET :18083/api/v5/prometheus/stats} und alarmiert auf
 * {@code increase(emqx_delivery_dropped_queue_full[15m]) > 0} (docs/k8s-readiness.md, „Broker-Verluste“). Dieser
 * Test hält die drei Annahmen dahinter an DEMSELBEN Abbild fest, das {@code docker-compose.prod.yml} betreibt (aus
 * der Datei gelesen, nicht abgetippt): der Pfad antwortet ohne Anmeldung, der Zähler heißt so und ist ein
 * {@code counter}, und er steigt genau in dem Fall, den der Lasttest gemessen hat. Wechselt jemand das Abbild und
 * eine der drei bricht, wird hier ein Test rot - nicht im Betrieb still der Alarm blind.
 */
@Testcontainers(disabledWithoutDocker = true)
class BrokerVerlustMetrikTest {

    /** Die Zähler, die das gitops-Repo behält (Relabeling im ServiceMonitor {@code emqx}). */
    static final List<String> BEHALTENE_ZAEHLER = List.of("emqx_delivery_dropped_queue_full",
            "emqx_delivery_dropped", "emqx_messages_delivered", "emqx_connections_count");

    static final String ABBILD = emqxAbbildAusProduktion();

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(DockerImageName.parse(ABBILD))
            .withExposedPorts(1883, 18083)
            .waitingFor(Wait.forLogMessage(".*is running now.*", 1).withStartupTimeout(Duration.ofMinutes(2)));

    /** Das EMQX-Abbild des Dienstes {@code emqx} in {@code docker-compose.prod.yml}. */
    static String emqxAbbildAusProduktion() {
        try {
            Matcher m = Pattern.compile("(?m)^\\s+image:\\s*(emqx/emqx:\\S+)\\s*$")
                    .matcher(Files.readString(Path.of("../../docker-compose.prod.yml"), StandardCharsets.UTF_8));
            if (!m.find()) {
                throw new IllegalStateException("docker-compose.prod.yml nennt kein emqx/emqx-Abbild");
            }
            return m.group(1);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String stats() throws Exception {
        HttpResponse<String> r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://"
                + EMQX.getHost() + ":" + EMQX.getMappedPort(18083) + "/api/v5/prometheus/stats"))
                .timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(r.statusCode()).as("Prometheus-Pfad ohne Anmeldung").isEqualTo(200);
        return r.body();
    }

    private static long wert(String stats, String name) {
        Matcher m = Pattern.compile("(?m)^" + name + " (\\S+)$").matcher(stats);
        assertThat(m.find()).as("Zeile %s im Abruf", name).isTrue();
        return (long) Double.parseDouble(m.group(1));
    }

    @Test
    void derPfadAntwortetOhneAnmeldungUndNenntDieBehaltenenZaehler() throws Exception {
        String stats = stats();
        assertThat(stats).contains("# TYPE emqx_delivery_dropped_queue_full counter");
        for (String name : BEHALTENE_ZAEHLER) {
            wert(stats, name);
        }
    }

    /**
     * Der Fall aus dem Lasttest im Kleinen: ein Abonnent mit dauerhafter Sitzung (wie die Boxen und die
     * Status-Abos) liest nicht mit, 1 500 Nachrichten mit QoS 1 laufen auf seine Warteschlange von 1 000. Jede
     * Nachricht wird dem Absender quittiert - verloren gehen die, die nicht mehr in die Warteschlange passen.
     */
    @Test
    void einAbonnentDerNichtNachkommtErscheintAlsVerworfeneZustellung() throws Exception {
        String broker = "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
        long vorher = wert(stats(), "emqx_delivery_dropped_queue_full");

        MqttClient abonnent = new MqttClient(broker, "vertrag-langsamer-abonnent", new MemoryPersistence());
        MqttConnectOptions dauerhaft = new MqttConnectOptions();
        dauerhaft.setCleanSession(false);
        abonnent.connect(dauerhaft);
        abonnent.subscribe("ems/vertrag/anlage/box/status", 1);
        abonnent.disconnect(); // die Sitzung bleibt am Broker und sammelt, liest aber nicht
        abonnent.close();

        MqttClient box = new MqttClient(broker, "vertrag-box", new MemoryPersistence());
        box.connect();
        int gesendet = 1_500;
        for (int i = 0; i < gesendet; i++) {
            box.publish("ems/vertrag/anlage/box/status", ("{\"n\":" + i + "}").getBytes(StandardCharsets.UTF_8),
                    1, false); // blockiert bis zum PUBACK: jede Nachricht gilt der Box als zugestellt
        }
        box.disconnect();
        box.close();

        long verworfen = 0;
        for (int versuch = 0; versuch < 20 && verworfen == 0; versuch++) {
            verworfen = wert(stats(), "emqx_delivery_dropped_queue_full") - vorher;
            if (verworfen == 0) {
                Thread.sleep(250);
            }
        }
        // Gemessen an 5.8.3: 499 (1 000 in der Warteschlange, eine im Flug).
        assertThat(verworfen).as("verworfen bei %d gesendeten", gesendet).isBetween(400L, 500L);
        assertThat(wert(stats(), "emqx_delivery_dropped")).isGreaterThanOrEqualTo(verworfen);
    }
}
