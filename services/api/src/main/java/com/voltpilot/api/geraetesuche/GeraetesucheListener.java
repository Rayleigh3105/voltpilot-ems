package com.voltpilot.api.geraetesuche;

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
 * Empfang von Zwischenstand {@code …/v2/geraetesuche-stand} und Ergebnis {@code …/v2/geraetesuche-ergebnis}
 * ({@code docs/contracts/v2/mqtt-geraetesuche.md} §5/§6; Muster {@code SprungprobeBerichtListener}), eigener
 * Paho-Client, nicht über Ingest. Die Vertragsprüfung ({@link GeraetesucheBericht}) prüft Topic- und
 * Payload-Identität, die Bereichsregel der Netze und jedes Fundes und überliest, was der Vertrag zu überlesen sagt -
 * eine MAC, ein Telefon als Fund, ein Fund außerhalb der Netze erreichen so nie eine Tabelle (DP-3 A). Erst dann
 * schreibt der {@link GeraetesucheDienst} fort, und nur an einer offenen Suche dieser Box.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class GeraetesucheListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(GeraetesucheListener.class);
    private static final String STAND_FILTER = "ems/+/+/+/v2/" + GeraetesucheVertrag.TOPIC_STAND;
    private static final String ERGEBNIS_FILTER = "ems/+/+/+/v2/" + GeraetesucheVertrag.TOPIC_ERGEBNIS;

    private final GeraetesucheDienst dienst;
    private final ObjectMapper mapper;
    /**
     * Ein Client mit fester ID und dauerhafter Sitzung (wie der Sprungprobe-Bericht): Stand und Ergebnis sind NICHT
     * retained, und was die Box sendet, während die api neu startet, hält nur die Sitzung beim Broker.
     */
    private final BrokerVerbindung verbindung;

    public GeraetesucheListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            GeraetesucheDienst dienst, ObjectMapper mapper) {
        this.dienst = dienst;
        this.mapper = mapper;
        this.verbindung = new BrokerVerbindung(log, "geraetesuche", brokerUrl, "voltpilot-api-geraetesuche", false,
                username, password, (client, quittung) -> client.subscribe(
                        new String[] {STAND_FILTER, ERGEBNIS_FILTER}, new int[] {1, 1}, null, quittung),
                this::empfangen);
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    /** Wie {@code SprungprobeBerichtListener}: Erstaufbau im Takt, danach verbindet nur Paho neu. */
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
        try {
            handle(topic, message.getPayload(), Instant.now());
        } catch (Exception e) {
            log.warn("geraetesuche message on {} rejected: {}", topic, e.getMessage());
        }
    }

    /** Prüft und übergibt; false = verworfen (ungültig oder keine offene Suche dieser Box). */
    public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
        if (kundenbereichBeendet(topic)) return false; // Kundenbereich beendet: verworfen und gezählt
        if (topic != null && topic.endsWith("/" + GeraetesucheVertrag.TOPIC_STAND)) {
            GeraetesucheBericht.Stand s = GeraetesucheBericht.stand(topic, payload, mapper);
            return s != null && imMandanten(s.tenantId(), () -> dienst.standEmpfangen(s, empfangenUm));
        }
        GeraetesucheBericht.Ergebnis e = GeraetesucheBericht.ergebnis(topic, payload, mapper);
        return e != null && imMandanten(e.tenantId(), () -> dienst.ergebnisEmpfangen(e, empfangenUm));
    }

    private static boolean imMandanten(UUID tenant, java.util.function.BooleanSupplier schritt) {
        TenantContext.set(tenant);
        try {
            return schritt.getAsBoolean();
        } finally {
            TenantContext.clear();
        }
    }
}
