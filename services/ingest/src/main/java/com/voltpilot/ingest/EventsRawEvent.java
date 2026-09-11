package com.voltpilot.ingest;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * EIN Ereignis auf dem Redpanda-Topic {@code events.raw} (Vertrag
 * {@code docs/contracts/v2/events-raw.event.schema.json} 1.0, Schlüssel
 * {@code {tenant_id}:{site_id}}). Zwei Wege der Datenannahme führen hinein: ein Eintrag eines
 * geprüften Box-Umschlags (Urheber {@code box}; {@code device_id}, {@code source_topic},
 * {@code sequence}, {@code observed_at} Pflicht, {@code ereignis.box} = {@code device_id}) und
 * die eigenen Ablehnungen der Datenannahme (Urheber {@code datenannahme}; die Umschlag-Felder
 * fehlen — der Bezug steht im Ereignis: {@code box}, {@code strom}, {@code sequenz}). Zeiten sind
 * UTC auf die Sekunde; ein abwesendes Feld fehlt, nie {@code null}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EventsRawEvent(
        String schema_version,
        UUID event_id,
        UUID tenant_id,
        UUID site_id,
        String urheber,
        String ingested_at,
        UUID device_id,
        String source_topic,
        Long sequence,
        String observed_at,
        JsonNode ereignis) {

    public static final String SCHEMA_VERSION = "1.0";

    public String kafkaKey() {
        return tenant_id + ":" + site_id;
    }

    /** Ein Eintrag eines angenommenen Box-Umschlags; {@code box} kommt aus dem Topic, nie aus dem Umschlag. */
    static EventsRawEvent box(Annahme.Absender a, String sourceTopic, String observedAt,
            ObjectNode eintrag, Instant eingang) {
        ObjectNode ereignis = eintrag.deepCopy();
        ereignis.put("box", a.deviceId().toString());
        return new EventsRawEvent(SCHEMA_VERSION, UUID.randomUUID(), a.tenantId(), a.siteId(),
                "box", zeit(eingang), a.deviceId(), sourceTopic, a.sequenz(), observedAt, ereignis);
    }

    /**
     * Eine gebündelte Ablehnung der Datenannahme. {@code zeitpunkt} ist die Eingangszeit (die
     * Achse dieser Arten). Die {@code ereignis_id} ist eine Namens-UUID aus Topic, Umschlag, Art
     * und Grund: dieselbe Zustellung zweimal (QoS 1, Wiederholung nach einem Fehler) trägt
     * dieselbe Kennung, wie der Vertrag es für eine Wiederholung verlangt.
     */
    static EventsRawEvent datenannahme(Annahme.Absender a, Ablehnungen.Ablehnung ablehnung,
            String sourceTopic, String payload, Instant eingang) {
        ObjectNode e = JsonNodeFactory.instance.objectNode();
        e.put("ereignis_id", ereignisId(sourceTopic, payload, ablehnung).toString());
        e.put("art", ablehnung.art().code());
        e.put("zeitpunkt", zeit(eingang));
        e.put("box", a.deviceId().toString());
        e.put("strom", a.strom());
        if (ablehnung.grund() != null) {
            e.put("grund", ablehnung.grund().code());
        }
        if (ablehnung.sekunden() != null) {
            e.put(ablehnung.art().sekundenFeld(), ablehnung.sekunden());
        }
        if (ablehnung.anzahl() > 0) {
            e.put("anzahl", ablehnung.anzahl());
        }
        if (a.sequenz() != null) {
            e.put("sequenz", a.sequenz());
        }
        return new EventsRawEvent(SCHEMA_VERSION, UUID.randomUUID(), a.tenantId(), a.siteId(),
                "datenannahme", zeit(eingang), null, null, null, null, e);
    }

    /** Die gebündelten Ablehnungen einer Annahme, je eine als Ereignis der Datenannahme. */
    static List<EventsRawEvent> ablehnungen(Annahme<?> annahme, String sourceTopic, String payload,
            Instant eingang) {
        return annahme.ablehnungen().stream()
                .map(a -> datenannahme(annahme.absender(), a, sourceTopic, payload, eingang))
                .toList();
    }

    /**
     * Die Abweisung des GANZEN Umschlags als EIN {@code rejected}, adressiert an den Absender aus
     * dem Topic. Leer, wenn das Topic keinen lesbaren Absender trägt — dann bleibt nur das Log.
     */
    static Optional<EventsRawEvent> abweisung(UmschlagAbgewiesen e, String sourceTopic,
            String payload, Instant eingang) {
        Ablehnungen.Ablehnung a = new Ablehnungen.Ablehnung(Ereignisart.REJECTED, e.grund(),
                e.anzahl() == null ? 0 : e.anzahl(), null);
        return Annahme.Absender.ausTopic(sourceTopic, e.sequenz())
                .map(absender -> datenannahme(absender, a, sourceTopic, payload, eingang));
    }

    private static UUID ereignisId(String topic, String payload, Ablehnungen.Ablehnung a) {
        String name = "datenannahme\n" + topic + "\n" + payload + "\n" + a.art().code() + "\n"
                + (a.grund() == null ? "" : a.grund().code());
        return UUID.nameUUIDFromBytes(name.getBytes(StandardCharsets.UTF_8));
    }

    /** UTC auf die Sekunde ({@code …T08:15:00Z}), wie {@code #/$defs/zeit_utc} es verlangt. */
    static String zeit(Instant t) {
        return t.truncatedTo(ChronoUnit.SECONDS).toString();
    }
}
