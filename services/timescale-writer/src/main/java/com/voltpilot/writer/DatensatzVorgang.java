package com.voltpilot.writer;

import java.util.UUID;
import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.MDC;
import org.springframework.kafka.listener.RecordInterceptor;
import org.springframework.stereotype.Component;

/**
 * Die zwei Kennungen der Log-Zeile (docs/k8s-readiness.md, Abschnitt "Logs") für die Dauer EINES
 * Datensatzes - der Verarbeitungseinheit des Writers ({@code ack-mode: record}).
 *
 * <p>Spring Boot hängt die eine {@code RecordInterceptor}-Bean an die Fabrik aller
 * {@code @KafkaListener}; kein Verbraucher muss dafür etwas tun.
 *
 * <ul>
 *   <li>{@code request_id}: {@code topic-partition@offset}. Nicht gewürfelt, weil diese Schreibweise
 *       drei Dinge zugleich leistet: jede erneute Zustellung desselben Datensatzes trägt dieselbe
 *       Kennung, der Datensatz ist damit im Broker auffindbar, und Spring Kafka nennt ihn in seinen
 *       eigenen Zeilen genauso ("Backoff ... exhausted for telemetry.raw-0@42") - die entstehen erst
 *       nach {@link #afterRecord}, also außerhalb dieser Klammer, und lassen sich so trotzdem
 *       zuordnen.</li>
 *   <li>{@code tenant_id}: das erste Segment des Schlüssels {@code {tenant_id}:{site_id}[:{device_id}]}
 *       (docs/contracts/telemetry-raw.event.schema.json), wenn es eine UUID ist. Ob der Inhalt
 *       dazu passt, prüft weiter der Verbraucher; bei anderem oder fehlendem Schlüssel fehlt das
 *       Feld.</li>
 * </ul>
 */
@Component
public class DatensatzVorgang implements RecordInterceptor<Object, Object> {

    static final String REQUEST_ID = "request_id";
    static final String TENANT_ID = "tenant_id";

    @Override
    public ConsumerRecord<Object, Object> intercept(ConsumerRecord<Object, Object> record,
            Consumer<Object, Object> consumer) {
        MDC.put(REQUEST_ID, record.topic() + "-" + record.partition() + "@" + record.offset());
        String mandant = mandant(record.key());
        if (mandant == null) {
            MDC.remove(TENANT_ID);
        } else {
            MDC.put(TENANT_ID, mandant);
        }
        return record;
    }

    @Override
    public void afterRecord(ConsumerRecord<Object, Object> record, Consumer<Object, Object> consumer) {
        MDC.remove(REQUEST_ID);
        MDC.remove(TENANT_ID);
    }

    private static String mandant(Object schluessel) {
        if (!(schluessel instanceof String s)) {
            return null;
        }
        int ende = s.indexOf(':');
        if (ende < 0) {
            return null;
        }
        try {
            return UUID.fromString(s.substring(0, ende)).toString();
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
