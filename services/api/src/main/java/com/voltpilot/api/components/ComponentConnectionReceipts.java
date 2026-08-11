package com.voltpilot.api.components;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Die VERBINDUNGSTEST-PFLICHT (Einheitsmodell Stufe 1, Konzept
 * vp-komponenten-einheit-h2 §4.2.4 „Verbindungstest-PFLICHT vor dem
 * Speichern - der Assistent lässt kein Blind-Soll zu").
 *
 * <p><b>Warum es das gibt.</b> Seit dieser Stufe ist das gespeicherte Soll der
 * LESEPFAD einer Anlage: ein Tippfehler in der IP macht die Anlage blind, und
 * zwar so lange, bis jemand hinsieht. Die Klasse „Tippfehler" ist genau die,
 * die ein Test abfängt - also darf ein Gerät erst gespeichert werden, wenn es
 * nachweislich geantwortet hat.
 *
 * <p><b>Was ein Beleg IST.</b> Ein erfolgreicher Verbindungstest über den
 * Probe-Kanal, ausgeführt für DIESE Anlage mit GENAU DIESEN Verbindungsdaten.
 * Der Schlüssel ist deshalb der Fingerabdruck über (Anlage, Vorlage,
 * Verbindungsfelder): ein Beleg für ein anderes Gerät oder eine geänderte IP
 * passt nicht mehr, und ein zweites Feld zu ändern erzwingt einen neuen Test.
 *
 * <p><b>Was ein Beleg NICHT ist.</b> Kein Sicherheitsmerkmal - er ist nicht
 * geheim, und er autorisiert nichts. Er beantwortet ausschließlich die Frage
 * „hat dieses Gerät gerade geantwortet?". Deshalb lebt er im Speicher (das
 * {@code SimulationJobRegistry}/{@code ProbeRegistry}-Muster): ein api-Neustart
 * lässt den Kunden einmal erneut auf „Verbindung testen" klicken, und das ist
 * die richtige Antwort auf „wir wissen es nicht mehr".
 *
 * <p>Der Beleg VERFÄLLT ({@link #TTL}) - eine Anlage, die vor Stunden geantwortet
 * hat, sagt nichts über jetzt.
 */
@Component
public class ComponentConnectionReceipts {

    /**
     * Wie lange ein bestandener Test zum Speichern berechtigt. Großzügig genug,
     * dass der Kunde den Assistenten in Ruhe zu Ende gehen kann, kurz genug,
     * dass „hat geantwortet" noch eine Aussage über jetzt ist.
     */
    public static final Duration TTL = Duration.ofMinutes(30);

    /**
     * Obergrenze der gehaltenen Belege. Ein Assistent hält eine Handvoll; die
     * Grenze existiert nur, damit eine Schleife irgendwo im Portal den Speicher
     * dieser api nie unbegrenzt füllen kann.
     */
    private static final int MAX_ENTRIES = 5000;

    private final Map<String, Instant> issued = new ConcurrentHashMap<>();
    private final Clock clock;

    /**
     * Die Produktions-Bindung.
     *
     * <p>⚠ Das {@code @Autowired} ist TRAGEND, nicht Zierde: mit ZWEI
     * Konstruktoren und keiner Annotation kann Spring den Injektions-Konstruktor
     * nicht wählen und der Kontext startet gar nicht erst (die dokumentierte
     * {@code BrokerAuthzReloader}-Falle, die genau so einmal in prod stand).
     */
    @Autowired
    public ComponentConnectionReceipts() {
        this(Clock.systemUTC());
    }

    /** Test-Naht: eine steuerbare Uhr für die Verfalls-Regel. */
    ComponentConnectionReceipts(Clock clock) {
        this.clock = clock;
    }

    /** Hinterlegt den Beleg eines bestandenen Tests. */
    public void record(UUID siteId, String templateRef, Map<String, Object> connection) {
        prune();
        issued.put(key(siteId, templateRef, connection), clock.instant());
    }

    /**
     * Ob für genau diese Anlage + Vorlage + Verbindung ein gültiger Beleg
     * vorliegt. Ein abgelaufener Beleg gilt NICHT und wird gleich entfernt.
     */
    public boolean has(UUID siteId, String templateRef, Map<String, Object> connection) {
        String k = key(siteId, templateRef, connection);
        Instant at = issued.get(k);
        if (at == null) {
            return false;
        }
        if (Duration.between(at, clock.instant()).compareTo(TTL) > 0) {
            issued.remove(k);
            return false;
        }
        return true;
    }

    /**
     * Der Fingerabdruck. Die Verbindungsfelder werden SORTIERT und als
     * Klartext-Paare zusammengesetzt, damit zwei logisch gleiche Formulare
     * denselben Schlüssel ergeben, egal in welcher Reihenfolge das Portal sie
     * geschickt hat - sonst hinge die Pflicht an einer Serialisierungs-Laune.
     */
    private static String key(UUID siteId, String templateRef, Map<String, Object> connection) {
        StringBuilder sb = new StringBuilder();
        sb.append(siteId).append('\n').append(templateRef == null ? "" : templateRef).append('\n');
        Map<String, Object> sorted = new TreeMap<>(connection == null ? Map.of() : connection);
        sorted.forEach((k, v) -> sb.append(k).append('=').append(v).append('\n'));
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(sb.toString().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /** Entfernt abgelaufene Belege und deckelt die Menge. */
    private void prune() {
        Instant now = clock.instant();
        issued.entrySet().removeIf(e -> Duration.between(e.getValue(), now).compareTo(TTL) > 0);
        if (issued.size() < MAX_ENTRIES) {
            return;
        }
        Iterator<Map.Entry<String, Instant>> it = issued.entrySet().iterator();
        while (it.hasNext() && issued.size() >= MAX_ENTRIES) {
            it.next();
            it.remove();
        }
    }
}
