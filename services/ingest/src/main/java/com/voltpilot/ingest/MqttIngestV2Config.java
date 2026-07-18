package com.voltpilot.ingest;

import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.mqtt.core.MqttPahoClientFactory;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;
import org.springframework.integration.mqtt.support.DefaultPahoMessageConverter;
import org.springframework.messaging.MessageChannel;

/**
 * Second inbound MQTT adapter: the v2 entity telemetry uplink on
 * {@code ems/+/+/+/v2/telemetry} (contract:
 * docs/contracts/v2/mqtt-telemetry-2.0.md). Lives NEXT TO the v1 adapter in
 * {@link MqttIngestConfig} - dual-consume (v2 README coexistence philosophy
 * #2); the v1 flow is byte-identical untouched. Reuses the shared
 * {@link MqttPahoClientFactory} (same broker/credentials), mirroring the
 * provisioning adapter pattern.
 *
 * <p>Feature-flagged: {@code voltpilot.telemetry-v2.enabled=false} removes the
 * whole v2 leg (enabled by default, like provisioning).
 */
@Configuration
@ConditionalOnProperty(name = "voltpilot.telemetry-v2.enabled", havingValue = "true",
        matchIfMissing = true)
public class MqttIngestV2Config {

    static final String V2_CHANNEL = "mqttV2InboundChannel";

    @Bean(name = V2_CHANNEL)
    public MessageChannel mqttV2InboundChannel() {
        return new DirectChannel();
    }

    @Bean
    public MqttPahoMessageDrivenChannelAdapter mqttV2InboundAdapter(
            MqttPahoClientFactory clientFactory,
            @Value("${voltpilot.mqtt.client-id:voltpilot-ingest}") String clientIdPrefix,
            @Value("${voltpilot.mqtt.telemetry-v2-topic-filter:ems/+/+/+/v2/telemetry}") String topicFilter,
            @Value("${voltpilot.mqtt.qos:1}") int qos) {
        MqttPahoMessageDrivenChannelAdapter adapter = new MqttPahoMessageDrivenChannelAdapter(
                clientIdPrefix + "-v2-" + UUID.randomUUID(), clientFactory, topicFilter);
        adapter.setQos(qos);
        adapter.setCompletionTimeout(5000);
        adapter.setDisconnectCompletionTimeout(5000);
        adapter.setConverter(new DefaultPahoMessageConverter());
        adapter.setOutputChannelName(V2_CHANNEL);
        return adapter;
    }
}
