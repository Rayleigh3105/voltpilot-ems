package com.voltpilot.writer;

import java.time.Duration;
import org.apache.kafka.clients.admin.Admin;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Verdrahtet den Kafka-Lag-Sammler: den Broker-Blick ({@link AdminKafkaLagProbe}
 * aus der schon konfigurierten {@link KafkaAdmin}) und Springs
 * {@code @Scheduled}-Unterstuetzung.
 *
 * <p>Eigener Schalter {@code voltpilot.metrics.kafka-lag.enabled} (Vorgabe AN),
 * gemeinsam mit {@link KafkaLagMetricsCollector}: abgeschaltet entsteht weder
 * ein {@link Admin}-Client noch ein Scheduler-Thread-Pool. Der Writer hatte bis
 * hierher gar keinen getakteten Job, dies ist der erste - deshalb bringt er sein
 * eigenes {@code @EnableScheduling} mit.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.metrics.kafka-lag.enabled", havingValue = "true",
        matchIfMissing = true)
public class KafkaLagMetricsConfig {

    /**
     * Ein wiederverwendeter {@link Admin} aus der Kafka-Konfiguration des
     * Dienstes (Bootstrap-Server, Sicherheit) - Spring schliesst ihn beim
     * Herunterfahren ({@code destroyMethod = "close"}). Er wird auch dann
     * gebaut, wenn der Broker beim Start noch nicht oben ist (Verbindungen
     * entstehen erst bei Bedarf).
     */
    @Bean(destroyMethod = "close")
    public AdminKafkaLagProbe kafkaLagProbe(
            KafkaAdmin kafkaAdmin,
            @Value("${spring.kafka.consumer.group-id:timescale-writer}") String groupId,
            @Value("${voltpilot.metrics.kafka-lag.timeout:PT10S}") Duration timeout) {
        return new AdminKafkaLagProbe(
                Admin.create(kafkaAdmin.getConfigurationProperties()), groupId, timeout);
    }
}
