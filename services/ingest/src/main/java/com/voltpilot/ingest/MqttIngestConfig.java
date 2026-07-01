package com.voltpilot.ingest;

import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.mqtt.core.DefaultMqttPahoClientFactory;
import org.springframework.integration.mqtt.core.MqttPahoClientFactory;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;
import org.springframework.integration.mqtt.support.DefaultPahoMessageConverter;
import org.springframework.messaging.MessageChannel;

/**
 * MQTT ingress from EMQX. A Paho v3 message-driven adapter subscribes to the
 * telemetry topic filter at QoS1 and drops each message onto
 * {@code mqttInboundChannel}, where {@link TelemetryIngestHandler} validates and
 * forwards it to Redpanda. Stateless; auto-reconnects to the broker.
 */
@Configuration
public class MqttIngestConfig {

    static final String INBOUND_CHANNEL = "mqttInboundChannel";

    @Bean
    public MqttPahoClientFactory mqttClientFactory(
            @Value("${voltpilot.mqtt.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.mqtt.username:}") String username,
            @Value("${voltpilot.mqtt.password:}") String password) {
        DefaultMqttPahoClientFactory factory = new DefaultMqttPahoClientFactory();
        MqttConnectOptions options = new MqttConnectOptions();
        options.setServerURIs(new String[] {brokerUrl});
        options.setCleanSession(true);
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

    @Bean(name = INBOUND_CHANNEL)
    public MessageChannel mqttInboundChannel() {
        return new DirectChannel();
    }

    @Bean
    public MqttPahoMessageDrivenChannelAdapter mqttInboundAdapter(
            MqttPahoClientFactory clientFactory,
            @Value("${voltpilot.mqtt.client-id:voltpilot-ingest}") String clientIdPrefix,
            @Value("${voltpilot.mqtt.telemetry-topic-filter:ems/+/+/+/telemetry}") String topicFilter,
            @Value("${voltpilot.mqtt.qos:1}") int qos) {
        // Client ids must be unique per connection; suffix with a random token so
        // multiple replicas (or restarts) never clash on the broker.
        String clientId = clientIdPrefix + "-" + UUID.randomUUID();
        MqttPahoMessageDrivenChannelAdapter adapter =
                new MqttPahoMessageDrivenChannelAdapter(clientId, clientFactory, topicFilter);
        adapter.setQos(qos);
        adapter.setCompletionTimeout(5000);
        adapter.setDisconnectCompletionTimeout(5000);
        adapter.setConverter(new DefaultPahoMessageConverter());
        adapter.setOutputChannel(mqttInboundChannel());
        return adapter;
    }
}
