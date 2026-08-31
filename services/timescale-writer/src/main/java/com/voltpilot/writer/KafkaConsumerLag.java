package com.voltpilot.writer;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die REINEN Regeln hinter dem Kafka-Consumer-Lag: aus je Partition dem
 * committeten Offset und dem Log-Ende die Rueckstands-Zahl je Topic. Ohne
 * Broker pruefbar (das {@code FleetMetrics}/{@code DbHealthMetrics}-Muster);
 * {@link KafkaLagMetricsCollector} haengt sie an Micrometer, {@link
 * AdminKafkaLagProbe} liefert die Offsets vom echten Broker.
 *
 * <p><b>Der Anlass (Scout vp-scale-readiness-p4 §5.1/§6.3).</b> Der Writer
 * konsumiert {@code telemetry.raw} single-threaded; ein Store-and-forward-Edge,
 * der nach Stunden offline zurueckkommt, spielt Tausende Samples nach, und 20
 * davon gleichzeitig = ein sechsstelliger Rueckstau. Es gab bis heute KEINE
 * Metrik dafuer - man saehe den Rueckstau nur an alternden Messwerten. Der Lag
 * je Consumer-Gruppe macht ihn beobachtbar, BEVOR die Daten veralten.
 *
 * <p><b>Der Weg (AdminClient-Poll, nicht die client-seitige {@code
 * records-lag}).</b> Der Lag = Log-Ende minus committeter Offset, ueber den
 * AdminClient abgefragt. Das ist robuster als die client-seitige
 * {@code records-lag}-Metrik des Konsumenten: die verschwindet, sobald der
 * Konsument nicht (mehr) FETCHT - also genau dann, wenn er haengt oder tot ist,
 * der Fall, den man am dringendsten sehen will. Der AdminClient-Blick zeigt den
 * Rueckstau auch dann, weil der committete Offset in der Gruppe stehenbleibt.
 */
public final class KafkaConsumerLag {

    private KafkaConsumerLag() {
    }

    /**
     * Committeter Offset und Log-Ende EINER Partition.
     *
     * <p>Beide sind absolute Offsets; der Lag ist die Differenz. Eine Partition
     * ohne beides taucht hier gar nicht auf (siehe {@link AdminKafkaLagProbe}) -
     * kein erfundener Wert.
     */
    public record PartitionOffsets(String topic, int partition, long committed, long endOffset) {
    }

    /** Der Rueckstand EINES Topics (Summe ueber seine Partitionen). */
    public record TopicLag(String topic, long lag) {
    }

    /**
     * Lag einer Partition: {@code max(0, Log-Ende - committet)}.
     *
     * <p>Bei 0 abgeschnitten: ein committeter Offset knapp ueber dem gemeldeten
     * Log-Ende ist ein Rennen zwischen den zwei Admin-Abfragen (das Ende wurde
     * einen Tick vor dem Commit gelesen), kein negativer Rueckstand. „Kein
     * Rueckstand" ist die ehrliche Lesart, und eine Regel {@code > Schwelle}
     * kaeme zur selben Aussage.
     */
    public static long partitionLag(long committed, long endOffset) {
        return Math.max(0L, endOffset - committed);
    }

    /**
     * Rueckstand je Topic (Summe ueber die Partitionen), in stabiler
     * Einfuege-Reihenfolge. Der Gesamt-Rueckstand der Gruppe ist {@code
     * sum(voltpilot_kafka_consumer_lag)} in der Alarm-Regel - kein vorgerechnetes
     * Total (Prometheus-Konvention, verhindert Doppelzaehlung).
     */
    public static List<TopicLag> perTopic(Collection<PartitionOffsets> partitions) {
        Map<String, Long> byTopic = new LinkedHashMap<>();
        for (PartitionOffsets p : partitions) {
            byTopic.merge(p.topic(), partitionLag(p.committed(), p.endOffset()), Long::sum);
        }
        List<TopicLag> out = new ArrayList<>(byTopic.size());
        byTopic.forEach((topic, lag) -> out.add(new TopicLag(topic, lag)));
        return out;
    }
}
