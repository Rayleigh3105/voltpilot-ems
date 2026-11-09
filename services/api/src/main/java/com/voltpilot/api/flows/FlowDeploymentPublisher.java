package com.voltpilot.api.flows;

import com.voltpilot.api.provisioning.BrokerVerbindung;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Publishes the flow deployment set to a device as ONE retained QoS1 message
 * on {@code ems/{t}/{s}/{d}/v2/flows} (flow-artifact contract §3, D-11 - the
 * proven retained-config self-wiring pattern; the topic lives in the same
 * per-device {@code v2/#} ACL subtree as the plan and the entity registry).
 *
 * <p>BEST-EFFORT exactly like {@link
 * com.voltpilot.api.entities.EntityRegistryPublisher}: a broker outage never
 * fails an activation write - re-activation (or clearing) re-publishes. Rides
 * the {@code voltpilot.provisioning.*} broker capability, no new deploy knob.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class FlowDeploymentPublisher {

    private static final Logger log = LoggerFactory.getLogger(FlowDeploymentPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private final BrokerVerbindung verbindung;

    public FlowDeploymentPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.verbindung = new BrokerVerbindung(log, "flow deployment", brokerUrl,
                "voltpilot-api-flows-" + UUID.randomUUID(), true, username, password, null, null);
    }

    /**
     * Verbindet beim Start und wartet darauf höchstens {@link BrokerVerbindung#ZEITGRENZE_MS}: der erste Versand
     * gleich danach soll noch durchgehen wie vor der Migration auf {@link BrokerVerbindung} (Befund 6/7,
     * vp-perf-robust-folge) - vorher verband ein synchrones {@code MqttClient.connect()} bis zu 5 s. Später wartet
     * kein Senden mehr auf die Verbindung; fehlt sie, meldet der Aufrufer es wie jeden anderen Verbindungsfehler,
     * und Paho verbindet selbst neu.
     */
    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        verbindung.sicherstellen();
        verbindung.erstaufbauAbwarten();
    }

    /** The retained deployment topic of one device (contract x-topic). */
    public static String flowsTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/flows";
    }

    /**
     * Publish the deployment set retained (QoS1). Returns whether the publish
     * went out; failure is logged, never thrown.
     */
    public synchronized boolean publishDeployment(UUID tenantId, UUID siteId, UUID deviceId,
            byte[] payload) {
        String topic = flowsTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            verbindung.verbundenerClient().publish(topic, message).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            log.info("published flow deployment set ({} bytes) retained to {}", payload.length,
                    topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish flow deployment to {}: {} (best-effort - re-activate "
                    + "once the broker is reachable)", topic, e.getMessage());
            return false;
        }
    }

    /** Clear the retained deployment slot (device unclaimed / all flows retired). */
    public synchronized boolean clearDeployment(UUID tenantId, UUID siteId, UUID deviceId) {
        String topic = flowsTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage empty = new MqttMessage("".getBytes(StandardCharsets.UTF_8));
            empty.setQos(1);
            empty.setRetained(true);
            verbindung.verbundenerClient().publish(topic, empty).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            return true;
        } catch (Exception e) {
            log.warn("could not clear flow deployment on {}: {}", topic, e.getMessage());
            return false;
        }
    }

    @PreDestroy
    void close() {
        verbindung.schliessen();
    }
}
