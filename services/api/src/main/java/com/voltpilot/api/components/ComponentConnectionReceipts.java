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

    /**
     * Ein Beleg: WANN er entstand, die server-seitig ermittelte EVIDENZ des Tests
     * (Einheitsmodell Stufe 4; optional, weil der Verbindungstest der Stufe 1
     * keine hat - dort IST der Messwert die Antwort) und, seit 21.08.2026, der
     * KANAL, den das Gerät nicht liefern konnte.
     *
     * <p>{@code overrideChannel} ist der Unterschied zwischen „das Gerät hat
     * geantwortet" und „das Gerät hat vollständig geantwortet". Er ist gesetzt,
     * wenn der Test zwar wirklich gelesen hat, ein einzelner Kanal aber
     * nachweislich fehlt (heute: der Ladestand einer Batterie ohne gekoppeltes
     * BMS). Ein solcher Beleg gibt das Speichern NUR frei, wenn der Kunde genau
     * diesen Kanal ausdrücklich abgenickt hat - siehe
     * {@code ComponentService.requireTestedConnection}.
     */
    record Receipt(Instant at, String evidence, String overrideChannel) {
    }

    private final Map<String, Receipt> issued = new ConcurrentHashMap<>();
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
        record(siteId, templateRef, null, connection, null);
    }

    /**
     * Hinterlegt den Beleg MIT seiner Evidenz (Stufe 4). Die Evidenz wird
     * server-seitig aus dem Testergebnis gebildet, nie vom Aufrufer geliefert -
     * ein Nachweis, den der Client behaupten darf, ist keiner.
     */
    public void record(UUID siteId, String templateRef, Map<String, Object> connection,
            String evidence) {
        record(siteId, templateRef, null, connection, evidence);
    }

    public void record(UUID siteId, String templateRef, Integer templateVersion,
            Map<String, Object> connection) {
        record(siteId, templateRef, templateVersion, connection, null);
    }

    public void record(UUID siteId, String templateRef, Integer templateVersion,
            Map<String, Object> connection, String evidence) {
        prune();
        issued.put(key(siteId, templateRef, templateVersion, connection),
                new Receipt(clock.instant(), evidence, null));
    }

    /**
     * Hinterlegt den Beleg eines Tests, bei dem das Gerät ANTWORTETE, aber EIN
     * Kanal nachweislich fehlt (live: eine Batterie ohne gekoppeltes BMS meldet
     * dauerhaft SoC 0).
     *
     * <p><b>Warum das überhaupt ein Beleg ist.</b> Die Pflicht existiert gegen
     * das Blind-Soll - gegen den Tippfehler in der IP, der eine Anlage stumm
     * macht. Genau DAS hat dieser Test beantwortet: das Gerät ist erreichbar,
     * die Vorlage passt, die übrigen Messwerte kommen an. Er ist deshalb ein
     * halber Beleg mit Namen, kein Freibrief: {@link #overrideChannel} nennt den
     * fehlenden Kanal, und ohne die ausdrückliche Zustimmung des Kunden zu
     * GENAU diesem Kanal speichert nichts.
     *
     * <p>Der Kanal kommt aus dem Testergebnis, nie aus dem Aufruf des Clients -
     * dieselbe Regel wie bei der Evidenz: ein Nachweis, den der Client behaupten
     * darf, ist keiner.
     */
    public void recordOverridable(UUID siteId, String templateRef,
            Map<String, Object> connection, String channel) {
        recordOverridable(siteId, templateRef, null, connection, channel);
    }

    public void recordOverridable(UUID siteId, String templateRef, Integer templateVersion,
            Map<String, Object> connection, String channel) {
        prune();
        issued.put(key(siteId, templateRef, templateVersion, connection),
                new Receipt(clock.instant(), null, channel));
    }

    /**
     * Der Kanal, den der gültige Beleg als FEHLEND ausweist - oder {@code null}
     * bei einem vollständigen Test (bzw. ohne gültigen Beleg). Er folgt derselben
     * Verfalls-Regel wie {@link #has}.
     */
    public String overrideChannel(UUID siteId, String templateRef,
            Map<String, Object> connection) {
        return overrideChannel(siteId, templateRef, null, connection);
    }

    public String overrideChannel(UUID siteId, String templateRef, Integer templateVersion,
            Map<String, Object> connection) {
        if (!has(siteId, templateRef, templateVersion, connection)) {
            return null;
        }
        Receipt r = issued.get(key(siteId, templateRef, templateVersion, connection));
        return r == null ? null : r.overrideChannel();
    }

    /**
     * Die Evidenz des gueltigen Belegs, sonst {@code null}. Sie folgt derselben
     * Verfalls-Regel wie {@link #has} - eine Evidenz ohne gueltigen Beleg gibt
     * es nicht.
     */
    public String evidence(UUID siteId, String templateRef, Map<String, Object> connection) {
        return evidence(siteId, templateRef, null, connection);
    }

    public String evidence(UUID siteId, String templateRef, Integer templateVersion,
            Map<String, Object> connection) {
        if (!has(siteId, templateRef, templateVersion, connection)) {
            return null;
        }
        Receipt r = issued.get(key(siteId, templateRef, templateVersion, connection));
        return r == null ? null : r.evidence();
    }

    /**
     * Ob für genau diese Anlage + Vorlage + Verbindung ein gültiger Beleg
     * vorliegt. Ein abgelaufener Beleg gilt NICHT und wird gleich entfernt.
     */
    public boolean has(UUID siteId, String templateRef, Map<String, Object> connection) {
        return has(siteId, templateRef, null, connection);
    }

    public boolean has(UUID siteId, String templateRef, Integer templateVersion,
            Map<String, Object> connection) {
        String k = key(siteId, templateRef, templateVersion, connection);
        Receipt r = issued.get(k);
        if (r == null) {
            return false;
        }
        Instant at = r.at();
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
    private static String key(UUID siteId, String templateRef, Integer templateVersion,
            Map<String, Object> connection) {
        StringBuilder sb = new StringBuilder();
        sb.append(siteId).append('\n').append(templateRef == null ? "" : templateRef).append('\n')
                .append(templateVersion == null ? "" : templateVersion).append('\n');
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
        issued.entrySet().removeIf(e -> Duration.between(e.getValue().at(), now).compareTo(TTL) > 0);
        if (issued.size() < MAX_ENTRIES) {
            return;
        }
        Iterator<Map.Entry<String, Receipt>> it = issued.entrySet().iterator();
        while (it.hasNext() && issued.size() >= MAX_ENTRIES) {
            it.next();
            it.remove();
        }
    }
}
