package com.voltpilot.ingest.provisioning;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.IMqttAsyncClient;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.integration.annotation.ServiceActivator;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.mqtt.core.MqttPahoClientFactory;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;
import org.springframework.integration.mqtt.support.DefaultPahoMessageConverter;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.handler.annotation.Header;

/**
 * Wiring for the zero-touch provisioning resolver
 * (docs/contracts/mqtt-provisioning.schema.json): a second Paho inbound adapter
 * subscribes to {@code provision/+/hello} on the SAME broker as telemetry, and
 * {@link ProvisioningHandler} answers claimed refs with a RETAINED
 * {@code provision/{ref}/config} published through a dedicated outbound client.
 *
 * <p>Enabled by default (the resolver is part of the ingest deployment);
 * {@code voltpilot.provisioning.enabled=false} turns the whole block off. The
 * device lookup uses lazy plain JDBC ({@link JdbcDeviceDirectory}), so ingest
 * still starts and streams telemetry when the DB is unreachable.
 */
@Configuration
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true",
        matchIfMissing = true)
public class ProvisioningConfig {

    static final String PROVISION_CHANNEL = "provisionInboundChannel";

    @Bean
    public DeviceDirectory deviceDirectory(
            @Value("${voltpilot.provisioning.db.jdbc-url:jdbc:postgresql://localhost:5432/voltpilot}") String jdbcUrl,
            @Value("${voltpilot.provisioning.db.username:voltpilot}") String username,
            @Value("${voltpilot.provisioning.db.password:voltpilot_dev_pw}") String password) {
        return new JdbcDeviceDirectory(jdbcUrl, username, password);
    }

    @Bean(name = PROVISION_CHANNEL)
    public MessageChannel provisionInboundChannel() {
        return new DirectChannel();
    }

    @Bean
    public MqttPahoMessageDrivenChannelAdapter provisionInboundAdapter(
            MqttPahoClientFactory clientFactory,
            @Value("${voltpilot.mqtt.client-id:voltpilot-ingest}") String clientIdPrefix,
            @Value("${voltpilot.provisioning.hello-topic-filter:provision/+/hello}") String topicFilter,
            @Value("${voltpilot.mqtt.qos:1}") int qos) {
        MqttPahoMessageDrivenChannelAdapter adapter = new MqttPahoMessageDrivenChannelAdapter(
                clientIdPrefix + "-provision-" + UUID.randomUUID(), clientFactory, topicFilter);
        adapter.setQos(qos);
        adapter.setCompletionTimeout(5000);
        adapter.setDisconnectCompletionTimeout(5000);
        adapter.setConverter(new DefaultPahoMessageConverter());
        adapter.setOutputChannel(provisionInboundChannel());
        return adapter;
    }

    /**
     * Outbound retained publish through a Paho client from the shared factory
     * (same broker/credentials as the inbound adapters).
     */
    @Bean
    public ProvisioningHandler.RetainedConfigPublisher retainedConfigPublisher(
            MqttPahoClientFactory clientFactory,
            @Value("${voltpilot.mqtt.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.mqtt.client-id:voltpilot-ingest}") String clientIdPrefix) {
        String clientId = clientIdPrefix + "-provision-out-" + UUID.randomUUID();
        return new PahoRetainedConfigPublisher(clientFactory, brokerUrl, clientId);
    }

    /**
     * Lazily-connected retained-config publisher. Implements {@link AutoCloseable}
     * so Spring disconnects + closes the Paho client on context shutdown - Paho's
     * client threads are not daemon threads and {@code automaticReconnect} keeps a
     * reconnect loop alive, so an un-closed client would linger past shutdown.
     */
    static final class PahoRetainedConfigPublisher
            implements ProvisioningHandler.RetainedConfigPublisher, AutoCloseable {

        private final MqttPahoClientFactory clientFactory;
        private final String brokerUrl;
        private final String clientId;
        private final Object lock = new Object();
        private IMqttAsyncClient client;

        PahoRetainedConfigPublisher(MqttPahoClientFactory clientFactory, String brokerUrl,
                String clientId) {
            this.clientFactory = clientFactory;
            this.brokerUrl = brokerUrl;
            this.clientId = clientId;
        }

        @Override
        public void publishRetained(String topic, String payload) throws Exception {
            synchronized (lock) {
                if (client == null) {
                    client = clientFactory.getAsyncClientInstance(brokerUrl, clientId);
                }
                if (!client.isConnected()) {
                    client.connect(clientFactory.getConnectionOptions()).waitForCompletion(5000);
                }
                MqttMessage message = new MqttMessage(payload.getBytes(StandardCharsets.UTF_8));
                message.setQos(1);
                message.setRetained(true);
                client.publish(topic, message).waitForCompletion(5000);
            }
        }

        @Override
        public void close() {
            synchronized (lock) {
                if (client == null) {
                    return;
                }
                try {
                    if (client.isConnected()) {
                        client.disconnect().waitForCompletion(5000);
                    }
                } catch (Exception ignored) {
                    // shutdown must proceed
                }
                try {
                    client.close();
                } catch (Exception ignored) {
                    // shutdown must proceed
                }
                client = null;
            }
        }
    }

    @Bean
    public ProvisioningHandler provisioningHandler(DeviceDirectory directory,
            ProvisioningHandler.RetainedConfigPublisher publisher, ObjectMapper mapper) {
        return new ProvisioningHandler(directory, publisher, mapper);
    }

    /** Bridges the Spring Integration channel onto the plain handler. */
    @Bean
    public ProvisioningEndpoint provisioningEndpoint(ProvisioningHandler handler) {
        return new ProvisioningEndpoint(handler);
    }

    public static class ProvisioningEndpoint {

        private final ProvisioningHandler handler;

        ProvisioningEndpoint(ProvisioningHandler handler) {
            this.handler = handler;
        }

        @ServiceActivator(inputChannel = PROVISION_CHANNEL)
        public void handle(Message<String> message,
                @Header(MqttHeaders.RECEIVED_TOPIC) String topic) {
            handler.onHello(topic, message.getPayload());
        }
    }
}
