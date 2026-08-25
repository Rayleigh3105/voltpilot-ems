package com.voltpilot.ingest;

import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.mqtt.core.MqttPahoClientFactory;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;
import org.springframework.integration.mqtt.support.DefaultPahoMessageConverter;
import org.springframework.messaging.MessageChannel;

@Configuration
public class MqttMeasurementIngestConfig {
    static final String CHANNEL = "mqttMeasurementInboundChannel";

    @Bean(name = CHANNEL)
    MessageChannel mqttMeasurementInboundChannel() {
        return new DirectChannel();
    }

    @Bean
    MqttPahoMessageDrivenChannelAdapter mqttMeasurementInboundAdapter(
            MqttPahoClientFactory factory,
            @Value("${voltpilot.mqtt.client-id:voltpilot-ingest}") String id,
            @Value("${voltpilot.mqtt.measurement-topic-filter:ems/+/+/+/v2/measurement-samples}")
                    String filter,
            @Value("${voltpilot.mqtt.qos:1}") int qos) {
        var adapter = new MqttPahoMessageDrivenChannelAdapter(
                id + "-measurements-" + UUID.randomUUID(), factory, filter);
        adapter.setQos(qos);
        adapter.setConverter(new DefaultPahoMessageConverter());
        adapter.setOutputChannelName(CHANNEL);
        return adapter;
    }
}
