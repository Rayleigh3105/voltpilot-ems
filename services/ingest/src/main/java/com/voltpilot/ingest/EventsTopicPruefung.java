package com.voltpilot.ingest;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.common.errors.TopicExistsException;
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
 * <p><b>Fehlt das Topic, legt sie es selbst an</b> ({@code voltpilot.redpanda.events-topic-anlegen},
 * Vorgabe an, seit 15.09.2026): mit den Werten, mit denen {@code redpanda-init} die Nachbar-Topics
 * anlegt (3 Partitionen, 1 Replikat), liest es danach zurück und ist erst dann bereit. Ein
 * vorhandenes Topic wird nie ein zweites Mal angelegt und nie angepasst; weicht es ab, steht das
 * als WARN im Log und als Detail {@code abweichung} am Health-Beitrag. Schlägt das Anlegen fehl
 * (keine Rechte, Broker weg), bleibt sie nicht bereit, mit dem Grund im Log. Abgeschaltet prüft
 * sie nur, wie vor dem 15.09.2026. <b>Warum der Code das darf</b>, obwohl Punkt 4 von b07-recreate D
 * es ausschloss: jener Punkt war eine Abgrenzung ohne Sicherheitsgrund (D löste den
 * Recreate-Stillstand ohne Anlage), der Captain will seit 15.09.2026 kein Topic mehr von Hand
 * anlegen, und ein falsch eingestelltes Topic entsteht nur, wenn der Broker es beim ersten Senden
 * mit seinen Vorgabewerten anlegt — genau das verhindert der ausdrückliche Weg vor dem Senden.
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

    /** Ob die Prüfung ein fehlendes Topic anlegt, und mit welchen Einstellungen. */
    record Anlage(boolean an, int partitionen, short replikate) {
        /** Nur prüfen, nie anlegen. */
        static final Anlage AUS = new Anlage(false, 0, (short) 0);
    }

    private final Supplier<Admin> admin;
    private final String topic;
    private final Anlage anlage;
    private volatile boolean vorhanden;
    private volatile String abweichung;
    private long naechsteFrageNanos;
    private Long letzteWarnungNanos;

    @Autowired
    public EventsTopicPruefung(KafkaAdmin kafkaAdmin,
            @Value("${voltpilot.redpanda.events-topic:events.raw}") String topic,
            @Value("${voltpilot.redpanda.events-topic-anlegen.enabled:true}") boolean anlegen,
            @Value("${voltpilot.redpanda.events-topic-anlegen.partitionen:3}") int partitionen,
            @Value("${voltpilot.redpanda.events-topic-anlegen.replikate:1}") short replikate) {
        this(() -> Admin.create(konfiguration(kafkaAdmin)), topic,
                new Anlage(anlegen, partitionen, replikate));
    }

    /** Nur prüfen, nie anlegen (Gegenprobe gegen ein echtes Redpanda). */
    public EventsTopicPruefung(KafkaAdmin kafkaAdmin, String topic) {
        this(() -> Admin.create(konfiguration(kafkaAdmin)), topic, Anlage.AUS);
    }

    EventsTopicPruefung(Supplier<Admin> admin, String topic) {
        this(admin, topic, Anlage.AUS);
    }

    EventsTopicPruefung(Supplier<Admin> admin, String topic, Anlage anlage) {
        this.admin = admin;
        this.topic = topic;
        this.anlage = anlage;
        this.naechsteFrageNanos = System.nanoTime();
    }

    /**
     * {@code true}, sobald das Topic einmal gesehen (oder angelegt und zurückgelesen) wurde; bis
     * dahin fragt sie Redpanda (gedrosselt).
     */
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
            if (!namen.contains(topic)) {
                if (!anlage.an()) {
                    melde(jetzt, "Redpanda-Topic " + topic + " FEHLT - die Datenannahme bleibt NICHT bereit "
                            + "(readiness DOWN), Ereignisse stehen nur im Log, Box-Ereignisse werden nicht "
                            + "angenommen, bis es angelegt ist (services/ingest/README.md, Topics)");
                    return false;
                }
                if (!legeAn(a, jetzt)) {
                    return false;
                }
            }
            if (anlage.an()) {
                vergleiche(a);
            }
            vorhanden = true;
            log.info("Redpanda-Topic {} vorhanden - die Datenannahme ist bereit", topic);
            return true;
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

    /** Die Abweichung eines vorhandenen Topics von der Anlage, sofern eine gesehen wurde. */
    public Optional<String> abweichung() {
        return Optional.ofNullable(abweichung);
    }

    /** Legt das fehlende Topic an; {@code false} = nicht angelegt, der Grund steht im Log. */
    private boolean legeAn(Admin a, long jetzt) throws InterruptedException {
        Throwable grund;
        try {
            a.createTopics(List.of(new NewTopic(topic, anlage.partitionen(), anlage.replikate())))
                    .all().get(FRIST.toMillis(), TimeUnit.MILLISECONDS);
            log.info("Redpanda-Topic {} fehlte - von der Datenannahme angelegt mit {} Partitionen und {} "
                    + "Replikat(en)", topic, anlage.partitionen(), anlage.replikate());
            return true;
        } catch (ExecutionException e) {
            if (e.getCause() instanceof TopicExistsException) {
                // Zeitgleich anderswo angelegt (zweiter Pod, Betrieb): es gilt, was dort steht.
                return true;
            }
            grund = e.getCause();
        } catch (TimeoutException e) {
            grund = e;
        }
        melde(jetzt, "Redpanda-Topic " + topic + " FEHLT und konnte nicht angelegt werden (" + grund
                + ") - die Datenannahme bleibt NICHT bereit (readiness DOWN), Ereignisse stehen nur im "
                + "Log, Box-Ereignisse werden nicht angenommen; anlegen mit `rpk topic create " + topic
                + " --partitions " + anlage.partitionen() + " --replicas " + anlage.replikate()
                + "` oder der Datenannahme das Recht dazu geben (services/ingest/README.md, Topics)");
        return false;
    }

    /**
     * Weicht das Topic von der Anlage ab, wird das gemeldet und NICHT angepasst: Partitionen eines
     * Topics mit Daten umzuverteilen verschiebt die Schlüssel, und weniger Partitionen gehen gar
     * nicht — das entscheidet der Betrieb, nicht ein Dienststart.
     */
    private void vergleiche(Admin a) throws Exception {
        TopicDescription d = a.describeTopics(List.of(topic)).allTopicNames()
                .get(FRIST.toMillis(), TimeUnit.MILLISECONDS).get(topic);
        int partitionen = d.partitions().size();
        int replikate = d.partitions().isEmpty() ? 0 : d.partitions().get(0).replicas().size();
        if (partitionen != anlage.partitionen() || replikate != anlage.replikate()) {
            abweichung = partitionen + " Partitionen und " + replikate + " Replikat(e), erwartet "
                    + anlage.partitionen() + " und " + anlage.replikate();
            log.warn("Redpanda-Topic {} weicht ab: {} - es wird NICHT angepasst (Partitionen und "
                    + "Replikate eines Topics mit Daten ändert der Betrieb, services/ingest/README.md, "
                    + "Topics)", topic, abweichung);
        }
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
