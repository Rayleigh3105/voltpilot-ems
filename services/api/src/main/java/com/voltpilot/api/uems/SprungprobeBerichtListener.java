package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import com.voltpilot.api.tenant.TenantContext;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Empfang des Sprungprobe-Berichts {@code …/v2/sprungprobe-result} (UEMS AP-15 IP-21; Vertrag
 * {@code docs/contracts/v2/mqtt-sprungprobe.md} §3; Muster {@link VerbundAnteileResultListener}). Prüft Topic- und
 * Payload-Identität ({@link SprungprobeBericht#lesen}), dann wertet {@link SprungprobeDienst#berichtEmpfangen} aus. Eine
 * Box ohne Auftrag sendet nichts: für sie läuft hier nie etwas.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class SprungprobeBerichtListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(SprungprobeBerichtListener.class);
    private static final String FILTER = "ems/+/+/+/v2/" + SprungprobeBericht.ERGEBNIS;

    private final SprungprobeDienst dienst;
    private final ObjectMapper mapper;
    /**
     * Ein Client, einmal gebaut, nie verworfen – aber mit fester ID und dauerhafter Sitzung: der Bericht ist NICHT
     * retained, und was die Box sendet, während die api neu startet, hält nur die Sitzung beim Broker. Ein zweiter
     * Client mit derselben ID entsteht hier nie mehr; im Rollout verdrängen sich alter und neuer Pod, bis der alte
     * schließt (wie der OCPP-Eingang). Die gestauten Berichte kommen vor dem SUBACK und gehen trotzdem an den Eingang.
     */
    private final BrokerVerbindung verbindung;

    public SprungprobeBerichtListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            SprungprobeDienst dienst, ObjectMapper mapper) {
        this.dienst = dienst; this.mapper = mapper;
        this.verbindung = new BrokerVerbindung(log, "sprungprobe result", brokerUrl,
                "voltpilot-api-sprungprobe-result", false, username, password,
                (client, quittung) -> client.subscribe(FILTER, 1, null, quittung), this::empfangen);
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    /** Wie {@link PlanResultListener}: Erstaufbau im Takt, danach verbindet nur Paho neu. */
    @Scheduled(fixedDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}",
            initialDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}")
    public void ensureConnected() {
        verbindung.sicherstellen();
    }

    @PreDestroy
    void stop() {
        verbindung.schliessen();
    }

    private void empfangen(String topic, MqttMessage message) {
        try { handle(topic, message.getPayload(), Instant.now()); }
        catch (Exception e) { log.warn("sprungprobe result on {} rejected: {}", topic, e.getMessage()); }
    }

    /** Prüft und übergibt; false = verworfen (ungültig oder keine laufende Probe dieser Box). */
    public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
        if (kundenbereichBeendet(topic)) return false; // Kundenbereich beendet: verworfen und gezählt
        SprungprobeBericht b = SprungprobeBericht.lesen(topic, payload, mapper);
        if (b == null) return false;
        TenantContext.set(b.tenantId());
        try {
            return dienst.berichtEmpfangen(b, empfangenUm);
        } finally {
            TenantContext.clear();
        }
    }
}
