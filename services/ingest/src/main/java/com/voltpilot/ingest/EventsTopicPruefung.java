package com.voltpilot.ingest;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.stereotype.Component;

/**
 * Gibt es das Redpanda-Topic {@code events.raw}? (UEMS AP-07 IP-5, Deploy-Schutz, Entscheid
 * b07-recreate D.) Eine Sendung an ein fehlendes Topic blockiert den Producer
 * {@code max.block.ms} lang; deshalb gilt, solange es fehlt: {@link EventsRawProducer} sendet
 * nichts (nur Log + Zähler, der Messwert-Weg läuft weiter), der Box-Adapter verbindet sich nicht
 * ({@link BoxEreignisTor}), und die Datenannahme meldet sich nicht bereit
 * ({@link EventsTopicHealthIndicator} in der Readiness-Gruppe).
 *
 * <p>Gefragt wird über den Kafka-Admin-Client mit kurzer Frist, höchstens alle
 * {@link #ERNEUT_NACH}; ist das Topic EINMAL gesehen, gilt es für die Lebenszeit des Prozesses
 * (zwischengespeichert) — ein späterer Redpanda-Aussetzer nimmt den Pod nie aus der Readiness
 * (docs/k8s-readiness.md: externe Systeme gehören nicht in die Probe).
 */
@Component
public class EventsTopicPruefung {

    private static final Logger log = LoggerFactory.getLogger(EventsTopicPruefung.class);

    /** Frist einer Anfrage an Redpanda. */
    static final Duration FRIST = Duration.ofSeconds(3);
    /** Solange das Topic fehlt, wird höchstens so oft erneut gefragt (die Probe fragt häufiger). */
    static final Duration ERNEUT_NACH = Duration.ofSeconds(10);
    /** Solange das Topic fehlt, steht höchstens so oft eine WARN-Zeile im Log (sonst DEBUG). */
    static final Duration WARNUNG_ALLE = Duration.ofMinutes(10);

    private final Supplier<Admin> admin;
    private final String topic;
    private volatile boolean vorhanden;
    private long naechsteFrageNanos;
    private Long letzteWarnungNanos;

    @Autowired
    public EventsTopicPruefung(KafkaAdmin kafkaAdmin,
            @Value("${voltpilot.redpanda.events-topic:events.raw}") String topic) {
        this(() -> Admin.create(konfiguration(kafkaAdmin)), topic);
    }

    EventsTopicPruefung(Supplier<Admin> admin, String topic) {
        this.admin = admin;
        this.topic = topic;
        this.naechsteFrageNanos = System.nanoTime();
    }

    /** {@code true}, sobald das Topic einmal gesehen wurde; bis dahin fragt sie Redpanda (gedrosselt). */
    public synchronized boolean vorhanden() {
        if (vorhanden) {
            return true;
        }
        long jetzt = System.nanoTime();
        if (jetzt - naechsteFrageNanos < 0) {
            return false;
        }
        naechsteFrageNanos = jetzt + ERNEUT_NACH.toNanos();
        Admin a = null;
        try {
            a = admin.get();
            Set<String> namen = a.listTopics().names().get(FRIST.toMillis(), TimeUnit.MILLISECONDS);
            if (namen.contains(topic)) {
                vorhanden = true;
                log.info("Redpanda-Topic {} vorhanden - die Datenannahme ist bereit", topic);
                return true;
            }
            melde(jetzt, "Redpanda-Topic " + topic + " FEHLT - die Datenannahme bleibt NICHT bereit "
                    + "(readiness DOWN), Ereignisse stehen nur im Log, Box-Ereignisse werden nicht "
                    + "angenommen, bis es angelegt ist (services/ingest/README.md, Topics)");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            melde(jetzt, "Redpanda-Topic " + topic + " nicht prüfbar (" + e + ") - die Datenannahme "
                    + "bleibt NICHT bereit (readiness DOWN)");
        } finally {
            if (a != null) {
                a.close(Duration.ofSeconds(1));
            }
        }
        return false;
    }

    /** Die erste Meldung und danach höchstens eine je {@link #WARNUNG_ALLE} als WARN, sonst DEBUG. */
    private void melde(long jetzt, String text) {
        if (letzteWarnungNanos == null || jetzt - letzteWarnungNanos - WARNUNG_ALLE.toNanos() >= 0) {
            letzteWarnungNanos = jetzt;
            log.warn(text);
        } else {
            log.debug(text);
        }
    }

    private static Map<String, Object> konfiguration(KafkaAdmin kafkaAdmin) {
        Map<String, Object> k = new HashMap<>(kafkaAdmin.getConfigurationProperties());
        k.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, (int) FRIST.toMillis());
        k.put(AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG, (int) FRIST.toMillis());
        return k;
    }
}
