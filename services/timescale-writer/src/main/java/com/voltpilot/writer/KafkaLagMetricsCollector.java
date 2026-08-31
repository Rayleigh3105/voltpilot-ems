package com.voltpilot.writer;

import com.voltpilot.writer.KafkaConsumerLag.PartitionOffsets;
import com.voltpilot.writer.KafkaConsumerLag.TopicLag;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Haengt den Kafka-Consumer-Lag aus {@link KafkaLagProbe} als Prometheus-Messwert
 * {@code voltpilot_kafka_consumer_lag{group,topic}} auf. Die REGELN stehen in
 * {@link KafkaConsumerLag}; hier steht nur die Verdrahtung. Aufbau und Disziplin
 * folgen dem api-Sammler {@code FleetMetricsCollector}: getaktet (nie pro
 * Scrape), Alter beim Scrape gerechnet, wirft NIE, {@code @Autowired} am
 * Produktions-Konstruktor (die {@code BrokerAuthzReloader}-Falle).
 *
 * <p><b>Warum hier, im Writer.</b> Der Writer IST der Konsument von {@code
 * telemetry.raw}, also gehoert die Lag-Metrik zu ihm (er hat spring-kafka und
 * damit den {@code kafka-clients}-{@link org.apache.kafka.clients.admin.Admin}).
 * Prometheus scrapt jeden Pod fuer sich; der Writer bekommt dafuer sein eigenes
 * {@code /metrics} (siehe application.yml), unauthentifiziert wie beim api.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.kafka-lag.enabled", havingValue = "true",
        matchIfMissing = true)
public class KafkaLagMetricsCollector {

    private static final Logger log = LoggerFactory.getLogger(KafkaLagMetricsCollector.class);

    /**
     * Rueckstand der Consumer-Gruppe je Topic (Summe ueber Partitionen). Der
     * Gesamt-Rueckstand ist {@code sum(voltpilot_kafka_consumer_lag)} in der
     * Alarm-Regel - kein vorgerechnetes Total (Prometheus-Konvention).
     */
    public static final String CONSUMER_LAG = "voltpilot_kafka_consumer_lag";

    /** Sekunden seit dem letzten ERFOLGREICHEN Lag-Poll DIESES Sammlers. */
    public static final String COLLECT_AGE = "voltpilot_kafka_consumer_lag_collect_age_seconds";

    private final KafkaLagProbe probe;
    private final String groupId;
    private final Clock clock;

    private final MultiGauge lag;
    private final AtomicReference<Instant> lastCollect = new AtomicReference<>();
    private volatile boolean failing;

    @Autowired
    public KafkaLagMetricsCollector(KafkaLagProbe probe, MeterRegistry registry,
            @Value("${spring.kafka.consumer.group-id:timescale-writer}") String groupId) {
        this(probe, registry, groupId, Clock.systemUTC());
    }

    /**
     * Test-Naht mit steuerbarer Uhr. <b>Der Produktions-Konstruktor oben MUSS
     * {@code @Autowired} tragen</b> - siehe die Klassen-Doku.
     */
    KafkaLagMetricsCollector(KafkaLagProbe probe, MeterRegistry registry, String groupId,
            Clock clock) {
        this.probe = probe;
        this.groupId = groupId;
        this.clock = clock;

        // OHNE Micrometer-baseUnit - die Einheit steckt im Sinn (Nachrichten),
        // nicht im Namen; eine baseUnit haengte sonst ein Suffix an.
        this.lag = MultiGauge.builder(CONSUMER_LAG)
                .description("Kafka-Consumer-Lag je Topic (committeter Offset bis Log-Ende);"
                        + " der Gruppen-Gesamt-Lag ist sum(voltpilot_kafka_consumer_lag)")
                .register(registry);

        Gauge.builder(COLLECT_AGE, this::collectAgeSeconds)
                .description("Sekunden seit dem letzten erfolgreichen Lag-Poll;"
                        + " waechst, wenn der Broker nicht erreichbar ist")
                .register(registry);
    }

    /**
     * Ein Poll-Lauf. Wirft NIE: ein Sammler, der an einem Durchlauf stirbt,
     * hoert auf zu sammeln - hier waere die Folge, dass die Alarm-Grundlage
     * still verschwindet. Ein fehlgeschlagener Lauf laesst den letzten Stand
     * stehen; dass er alt ist, sagt {@code
     * voltpilot_kafka_consumer_lag_collect_age_seconds}.
     */
    @Scheduled(fixedDelayString = "${voltpilot.metrics.kafka-lag.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.kafka-lag.initial-delay-ms:20000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("kafka lag metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("kafka lag metrics collection failed: {}", e.getMessage());
            } else {
                log.debug("kafka lag metrics collection still failing: {}", e.getMessage());
            }
        }
    }

    /** Pollt und veroeffentlicht einen Stand. Paket-sichtbar fuer die Tests. */
    void collect() throws Exception {
        List<PartitionOffsets> offsets = probe.currentOffsets();
        List<TopicLag> perTopic = KafkaConsumerLag.perTopic(offsets);

        List<MultiGauge.Row<?>> rows = new ArrayList<>(perTopic.size());
        for (TopicLag t : perTopic) {
            rows.add(MultiGauge.Row.of(
                    Tags.of("group", groupId, "topic", t.topic()), t.lag()));
        }
        lag.register(rows, true);

        this.lastCollect.set(clock.instant());
        log.debug("kafka lag collected: group={}, {} topic(s)", groupId, perTopic.size());
    }

    private double collectAgeSeconds() {
        Instant last = lastCollect.get();
        // Vor dem ersten Poll gibt es kein Alter - NaN, nie eine 0.
        Instant now = clock.instant();
        return last == null ? Double.NaN : Math.max(0.0, Duration.between(last, now).getSeconds());
    }
}
