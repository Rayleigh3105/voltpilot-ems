package com.voltpilot.ingest;

import java.util.UUID;
import java.util.function.BiConsumer;
import org.slf4j.MDC;
import org.springframework.integration.config.GlobalChannelInterceptor;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.stereotype.Component;

/**
 * Die zwei Kennungen der Log-Zeile (docs/k8s-readiness.md, Abschnitt "Logs") für die Dauer EINER
 * MQTT-Nachricht - der Verarbeitungseinheit des ingest.
 *
 * <p>Jeder MQTT-Adapter reicht seine Nachricht über einen {@code DirectChannel} an den Handler, also im
 * selben Faden und innerhalb von {@code send}. Dieser Interceptor liegt um genau dieses {@code send} und
 * gilt für jeden Kanal, der auf {@code InboundChannel} endet; {@code NachrichtenVorgangTest} hält fest,
 * dass das alle Adapter sind.
 *
 * <ul>
 *   <li>{@code request_id}: die Kennung, die Spring Integration der Nachricht beim Eingang gibt. Sie wird
 *       nicht eigens gewürfelt, weil der Adapter dieselbe Kennung als {@code id=} in seine eigene Zeile
 *       "Unhandled exception for GenericMessage [...]" schreibt - die entsteht erst nach {@code send},
 *       also außerhalb dieser Klammer, und lässt sich so trotzdem zuordnen.</li>
 *   <li>{@code tenant_id}: das Mandanten-Segment aus {@code ems/{tenant}/{site}/{device}/...}, wenn es
 *       eine UUID ist. {@code provision/{ref}/hello} hat keinen Mandanten; das Feld fehlt dann.</li>
 * </ul>
 */
@Component
@GlobalChannelInterceptor(patterns = "*InboundChannel")
public class NachrichtenVorgang implements ChannelInterceptor {

    static final String REQUEST_ID = "request_id";
    static final String TENANT_ID = "tenant_id";
    private static final String EMS = "ems/";

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        UUID id = message.getHeaders().getId();
        MDC.put(REQUEST_ID, (id != null ? id : UUID.randomUUID()).toString());
        setze(TENANT_ID, mandant(message.getHeaders().get(MqttHeaders.RECEIVED_TOPIC)));
        return message;
    }

    @Override
    public void afterSendCompletion(Message<?> message, MessageChannel channel, boolean sent, Exception ex) {
        MDC.remove(REQUEST_ID);
        MDC.remove(TENANT_ID);
    }

    /**
     * Für einen Rückruf, der erst NACH dem Handler auf einem fremden Faden läuft (die Quittung von Redpanda):
     * trägt die Kennungen des aufrufenden Fadens hinüber, damit auch "produce failed" zu seiner Nachricht
     * und seinem Mandanten gehört. Danach steht auf dem fremden Faden wieder, was vorher dort stand.
     */
    static <T> BiConsumer<T, Throwable> fortsetzen(BiConsumer<T, Throwable> rueckruf) {
        String vorgang = MDC.get(REQUEST_ID);
        String mandant = MDC.get(TENANT_ID);
        return (ergebnis, fehler) -> {
            String vorgangVorher = MDC.get(REQUEST_ID);
            String mandantVorher = MDC.get(TENANT_ID);
            setze(REQUEST_ID, vorgang);
            setze(TENANT_ID, mandant);
            try {
                rueckruf.accept(ergebnis, fehler);
            } finally {
                setze(REQUEST_ID, vorgangVorher);
                setze(TENANT_ID, mandantVorher);
            }
        };
    }

    private static String mandant(Object topic) {
        if (!(topic instanceof String t) || !t.startsWith(EMS)) {
            return null;
        }
        int ende = t.indexOf('/', EMS.length());
        if (ende < 0) {
            return null;
        }
        try {
            return UUID.fromString(t.substring(EMS.length(), ende)).toString();
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static void setze(String schluessel, String wert) {
        if (wert == null) {
            MDC.remove(schluessel);
        } else {
            MDC.put(schluessel, wert);
        }
    }
}
