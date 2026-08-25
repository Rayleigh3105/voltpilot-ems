package com.voltpilot.ingest;

import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.mqtt.core.DefaultMqttPahoClientFactory;
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

    @Bean(name = "measurementMqttClientFactory")
    MqttPahoClientFactory measurementMqttClientFactory(
            @Value("${voltpilot.mqtt.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.mqtt.username:}") String username,
            @Value("${voltpilot.mqtt.password:}") String password) {
        var factory = new DefaultMqttPahoClientFactory();
        var options = new MqttConnectOptions();
        options.setServerURIs(new String[] {brokerUrl});
        options.setCleanSession(false);
        options.setAutomaticReconnect(true);
        options.setConnectionTimeout(10);
        options.setKeepAliveInterval(30);
        if (username != null && !username.isBlank()) {
            options.setUserName(username);
            options.setPassword(password == null ? new char[0] : password.toCharArray());
        }
        factory.setConnectionOptions(options);
        return factory;
    }

    @Bean
    MqttPahoMessageDrivenChannelAdapter mqttMeasurementInboundAdapter(
            @Qualifier("measurementMqttClientFactory") MqttPahoClientFactory factory,
            @Value("${voltpilot.mqtt.client-id:voltpilot-ingest}") String id,
            @Value("${voltpilot.mqtt.measurement-topic-filter:ems/+/+/+/v2/measurement-samples}")
                    String filter,
            @Value("${voltpilot.mqtt.qos:1}") int qos) {
        var adapter = new MqttPahoMessageDrivenChannelAdapter(
                id + "-measurements", factory, filter);
        adapter.setQos(qos);
        adapter.setManualAcks(true);
        adapter.setConverter(new DefaultPahoMessageConverter());
        adapter.setOutputChannelName(CHANNEL);
        return adapter;
    }
}
