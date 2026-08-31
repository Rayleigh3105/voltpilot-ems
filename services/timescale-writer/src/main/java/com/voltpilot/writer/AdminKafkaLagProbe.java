package com.voltpilot.writer;

import com.voltpilot.writer.KafkaConsumerLag.PartitionOffsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.ListOffsetsResult.ListOffsetsResultInfo;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;

/**
 * Der Broker-Blick: fragt ueber den Kafka-{@link Admin} die committeten Offsets
 * der Consumer-Gruppe und die Log-Enden ihrer Partitionen ab. Die REGELN
 * (Differenz, Aggregation) stehen in {@link KafkaConsumerLag}; hier steht nur
 * die zwei Admin-Abfragen.
 *
 * <p>Ein einziger {@link Admin} wird gehalten und wiederverwendet (er ist
 * thread-safe und baut Verbindungen erst bei Bedarf auf, ist also auch dann
 * konstruierbar, wenn der Broker beim Start noch nicht oben ist). Beide
 * Abfragen sind zeitbegrenzt, damit ein haengender Broker den 60-s-Takt nicht
 * blockiert.
 */
public class AdminKafkaLagProbe implements KafkaLagProbe, AutoCloseable {

    private final Admin admin;
    private final String groupId;
    private final Duration timeout;

    public AdminKafkaLagProbe(Admin admin, String groupId, Duration timeout) {
        this.admin = admin;
        this.groupId = groupId;
        this.timeout = timeout;
    }

    @Override
    public List<PartitionOffsets> currentOffsets() throws Exception {
        long ms = Math.max(1L, timeout.toMillis());

        Map<TopicPartition, OffsetAndMetadata> committed = admin
                .listConsumerGroupOffsets(groupId)
                .partitionsToOffsetAndMetadata()
                .get(ms, TimeUnit.MILLISECONDS);
        if (committed == null || committed.isEmpty()) {
            // Nie konsumiert (oder Offsets abgelaufen) - kein Rueckstand zu melden.
            return List.of();
        }

        // Nur Partitionen mit einem echten committeten Offset; ein null-Eintrag
        // (theoretisch moeglich) wird ausgelassen, kein Wert erfunden.
        Map<TopicPartition, OffsetSpec> latestSpec = committed.entrySet().stream()
                .filter(e -> e.getValue() != null)
                .collect(Collectors.toMap(Map.Entry::getKey, e -> OffsetSpec.latest()));
        if (latestSpec.isEmpty()) {
            return List.of();
        }

        Map<TopicPartition, ListOffsetsResultInfo> ends = admin
                .listOffsets(latestSpec)
                .all()
                .get(ms, TimeUnit.MILLISECONDS);

        List<PartitionOffsets> out = new ArrayList<>(latestSpec.size());
        for (Map.Entry<TopicPartition, OffsetSpec> e : latestSpec.entrySet()) {
            TopicPartition tp = e.getKey();
            ListOffsetsResultInfo end = ends.get(tp);
            if (end == null) {
                // Kein Log-Ende gelesen -> nicht berechenbar, also auslassen.
                continue;
            }
            out.add(new PartitionOffsets(
                    tp.topic(), tp.partition(),
                    committed.get(tp).offset(), end.offset()));
        }
        return out;
    }

    @Override
    public void close() {
        admin.close(Duration.ofSeconds(5));
    }
}
