package com.voltpilot.ingest;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.mqtt.core.MqttPahoClientFactory;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;
import org.springframework.integration.mqtt.support.DefaultPahoMessageConverter;
import org.springframework.messaging.MessageChannel;

/**
 * Der Box-Ereignis-Uplink {@code ems/+/+/+/v2/events} (Vertrag
 * {@code docs/contracts/v2/mqtt-events-2.1.schema.json}, UEMS AP-07 IP-5). Gebaut wie der
 * {@code measurement-samples}-Adapter: dieselbe Fabrik mit PERSISTENTER Sitzung, feste
 * Client-Kennung, manuelle Quittung — ein Ereignis darf beim Neustart der Datenannahme nicht
 * verloren gehen. Eine ältere Box sendet hier einfach nichts. OHNE Autostart: das
 * {@link BoxEreignisTor} startet den Adapter erst, wenn es das Topic {@code events.raw} gibt.
 */
@Configuration
public class MqttEventsIngestConfig {
    static final String CHANNEL = "mqttEventsInboundChannel";
    static final String ADAPTER = "mqttEventsInboundAdapter";

    @Bean(name = CHANNEL)
    MessageChannel mqttEventsInboundChannel() {
        return new DirectChannel();
    }

    @Bean(name = ADAPTER)
    MqttPahoMessageDrivenChannelAdapter mqttEventsInboundAdapter(
            @Qualifier("measurementMqttClientFactory") MqttPahoClientFactory factory,
            @Value("${voltpilot.mqtt.client-id:voltpilot-ingest}") String id,
            @Value("${voltpilot.mqtt.events-topic-filter:ems/+/+/+/v2/events}") String filter,
            @Value("${voltpilot.mqtt.qos:1}") int qos) {
        var adapter = new MqttPahoMessageDrivenChannelAdapter(id + "-events", factory, filter);
        adapter.setQos(qos);
        adapter.setManualAcks(true);
        adapter.setConverter(new DefaultPahoMessageConverter());
        adapter.setOutputChannelName(CHANNEL);
        adapter.setAutoStartup(false);
        return adapter;
    }
}
