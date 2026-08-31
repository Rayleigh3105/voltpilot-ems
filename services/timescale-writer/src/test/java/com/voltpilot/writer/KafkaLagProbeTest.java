package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.writer.KafkaConsumerLag.PartitionOffsets;
import com.voltpilot.writer.KafkaConsumerLag.TopicLag;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Kafka-Lag-Blick gegen einen ECHTEN Redpanda - das AdminClient-Geflecht,
 * das {@code KafkaConsumerLagScrapeTest} bewusst wegattrappt: committete Offsets
 * der Gruppe abfragen, die Log-Enden dazu, die Differenz. Bewiesen wird bis in
 * den Scrape-Rumpf. Auto-Skip ohne Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
class KafkaLagProbeTest {

    private static final String GROUP = "timescale-writer";
    private static final String TOPIC = "lag.test.topic";

    @Container
    static final RedpandaContainer REDPANDA =
            new RedpandaContainer(DockerImageName.parse("redpandadata/redpanda:v24.2.7"));

    private static Admin admin() {
        return Admin.create(Map.of(
                AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers()));
    }

    private static Properties producerProps() {
        Properties p = new Properties();
        p.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        p.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        p.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        return p;
    }

    private static Properties consumerProps(String group) {
        Properties p = new Properties();
        p.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        p.put(ConsumerConfig.GROUP_ID_CONFIG, group);
        p.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        p.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        p.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        return p;
    }

    @Test
    void theProbeReportsTheBacklogOfACommittedGroupAndTheCollectorRendersIt() throws Exception {
        try (Admin a = admin()) {
            a.createTopics(List.of(new NewTopic(TOPIC, 1, (short) 1))).all().get();
        }
        // 50 Nachrichten -> Log-Ende 50.
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(producerProps())) {
            for (int i = 0; i < 50; i++) {
                producer.send(new ProducerRecord<>(TOPIC, "k", "v" + i)).get();
            }
        }
        // Committeter Offset 30, ohne wirklich zu konsumieren (assign + commit).
        TopicPartition tp = new TopicPartition(TOPIC, 0);
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(consumerProps(GROUP))) {
            consumer.assign(List.of(tp));
            consumer.commitSync(Map.of(tp, new OffsetAndMetadata(30)));
        }

        try (AdminKafkaLagProbe probe =
                new AdminKafkaLagProbe(admin(), GROUP, Duration.ofSeconds(10))) {
            List<PartitionOffsets> offsets = probe.currentOffsets();
            assertThat(offsets).hasSize(1);
            PartitionOffsets p = offsets.get(0);
            assertThat(p.topic()).isEqualTo(TOPIC);
            assertThat(p.partition()).isZero();
            assertThat(p.committed()).isEqualTo(30);
            assertThat(p.endOffset()).isEqualTo(50);
            assertThat(KafkaConsumerLag.perTopic(offsets))
                    .containsExactly(new TopicLag(TOPIC, 20));

            // ... und der Sammler rendert genau das.
            PrometheusMeterRegistry registry =
                    new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
            new KafkaLagMetricsCollector(probe, registry, GROUP, Clock.systemUTC()).collect();
            assertThat(registry.scrape()).contains(
                    "voltpilot_kafka_consumer_lag{group=\"" + GROUP + "\",topic=\""
                            + TOPIC + "\"} 20.0");
        }
    }

    @Test
    void aGroupThatNeverCommittedReportsNoBacklog() throws Exception {
        try (AdminKafkaLagProbe probe =
                new AdminKafkaLagProbe(admin(), "brand-new-group", Duration.ofSeconds(10))) {
            assertThat(probe.currentOffsets()).isEmpty();
        }
    }
}
