package com.voltpilot.api.components;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Die REGELN des BMS-unabhängigen Batterie-Anschlusses, Ebene 1
 * (Konzept {@code vp-deye-diybms-luecke-l5} §3.2b, Paket P5) - rein, ohne
 * Datenbank, ohne Spring, ohne Uhr.
 *
 * <p>Sie liegt neben {@link SelfBuildDefinition} und aus demselben Grund: was
 * ein Kunde über sein eigenes Gerät eintippen darf, ist eine Aussage über
 * Sicherheit und Ehrlichkeit, und die gehört an einen Ort, an dem sie ohne
 * Docker vollständig geprüft werden kann.
 *
 * <p><b>Worum es geht.</b> Weder ein Deye im Spannungsmodus noch ein DIYBMS
 * ohne Shunt MESSEN einen Ladestand; der Kunde rechnet ihn heute selbst in
 * seinem Node-RED. VoltPilot baut das Verfahren generisch nach: EBENE 1 (dieser
 * Bausatz) holt die ROHWERTE aus irgendeiner Quelle und bildet sie auf die
 * Standard-Batteriekanäle ab; EBENE 2 (P5b) leitet daraus später den Ladestand
 * ab. DIYBMS ist nur ein Beispiel - ein Pylontech, Seplos oder JK fällt mit
 * demselben Modell und nur Feld-Zuordnung als Aufwand hinein.
 *
 * <p><b>Die Regelgruppen und warum es sie gibt:</b>
 *
 * <ul>
 *   <li><b>LAN-only.</b> Derselbe Zaun wie beim Modbus-Baukasten, Form für
 *       Form: {@link SelfBuildDefinition#isPrivateHost} ist die EINE Regel,
 *       die Java und Go teilen - hier wird sie benutzt, nicht kopiert. Ohne
 *       sie wäre der Anschluss ein Weg, die Box an einen fremden Broker im
 *       Internet zu hängen.</li>
 *   <li><b>Geschlossene Ziel-Kanäle.</b> Eine Zuordnung darf NUR auf einen
 *       Standard-Batteriekanal zeigen, und welche das sind, sagt der
 *       Typkatalog ({@code entitytypes/catalog.json},
 *       {@code user-defined-battery.default_measure}) - deshalb reist die
 *       erlaubte Liste als Parameter herein statt hier ein zweites Mal zu
 *       stehen. Ein Wort außerhalb des Vokabulars wird VERWORFEN, nie
 *       geraten.</li>
 *   <li><b>Aggregat über viele Topics.</b> Der ganze Grund für diesen
 *       Bausatz: das DIYBMS des Kunden veröffentlicht 11 Bänke × 16 Zellen
 *       einzeln. Eine Zuordnung „ein Topic → ein Kanal" hätte den realen Fall
 *       nicht abgebildet; {@code min}/{@code max} über einen Topic-FILTER
 *       macht daraus {@code cell_min_mv} und {@code cell_max_mv}.</li>
 *   <li><b>Ehrlichkeit.</b> Ein {@code sentinel} ist ein ausdrücklich
 *       benannter Rohwert, der „nicht gemessen" heißt; ein Wahrheitswert kennt
 *       keine Skalierung; eine Skalierung 0 löschte jede Messung. Und eine
 *       Batterie ohne eine einzige Zuordnung wäre eine Komponente, die nichts
 *       liest.</li>
 *   <li><b>Der Ladestand braucht einen EINGANG.</b> Wer die Methode
 *       {@code direct} wählt, muss {@code soc_pct} auch zugeordnet haben - die
 *       Ableitungs-Methoden aus P5b (Kennlinie, Ladungszählung) sind hier
 *       ausdrücklich noch nicht da und werden benannt abgelehnt statt still
 *       gespeichert.</li>
 * </ul>
 */
public final class UserDefinedBatteryDefinition {

    /**
     * Die Anbindungs-Art, die eine so angeschlossene Batterie trägt.
     *
     * <p>⚠ Der Wert wird VERBATIM mit der Box geteilt
     * ({@code edge-app/core/internal/componentapply.CommunicationMqttLocal}):
     * dort ist er - wie {@code modbus_baukasten} - die Marke dafür, dass diese
     * Komponente NICHT über die Selbstverdrahtung gelesen wird, sondern über
     * ihren generierten Flow. Beide Seiten gehören zusammen geändert, sonst
     * lässt eine Box einen ganzen Registry-Push fallen, den sie nur
     * überspringen sollte.
     */
    public static final String COMMUNICATION = "mqtt_local";

    /** Die Herkunft, mit der eine so angelegte Batterie gestempelt wird. */
    public static final String SOURCE_KIND = "custom";

    /** Der Entitätstyp, den dieser Weg anlegt. */
    public static final String ENTITY_TYPE = "user-defined-battery";

    /** Der voreingestellte Port eines lokalen MQTT-Brokers. */
    public static final int DEFAULT_PORT = 1883;

    /** Höchstens so viele Zuordnungen je Batterie (11 Standard-Kanäle + Luft). */
    public static final int MAX_MAPPINGS = 16;

    /** Der Takt, in dem der Knoten seine Kanäle veröffentlicht. */
    public static final int DEFAULT_PUBLISH_INTERVAL_S = 15;
    public static final int MIN_PUBLISH_INTERVAL_S = 5;
    public static final int MAX_PUBLISH_INTERVAL_S = 3600;

    /** Wie lange eine einzelne Probe zählt, bevor sie „alt" ist. */
    public static final int DEFAULT_STALE_S = 300;
    public static final int MIN_STALE_S = 5;
    public static final int MAX_STALE_S = 86400;

    public static final int MAX_TOPIC_LENGTH = 200;
    public static final int MAX_PATH_LENGTH = 200;

    /** Die Aggregate - der Zwilling von {@code flowc/catalog.js} MQTT_AGGREGATES. */
    public static final Set<String> AGGREGATES =
            Set.of("last", "min", "max", "sum", "avg", "count");

    /** Was eine Zuordnung liefert; {@code bool} reist als 0/1 (Telemetrie-Vertrag). */
    public static final Set<String> VALUE_TYPES = Set.of("number", "bool");

    /**
     * Die Aggregate, die einen WAHRHEITSWERT zusammenfassen dürfen.
     *
     * <p>{@code min} ist das konservative UND („jede Bank erlaubt es"),
     * {@code max} das ODER, {@code last} die einzelne Quelle. {@code sum},
     * {@code avg} und {@code count} fehlen mit Absicht: die SUMME von
     * Freigaben ist keine Freigabe, und ein Mittel von 0,5 wäre eine Zahl,
     * die kein Gerät je gemeldet hat - gerundet würde daraus ein „ja",
     * das niemand gegeben hat.
     */
    public static final Set<String> BOOL_AGGREGATES = Set.of("last", "min", "max");

    /**
     * Die SoC-Ableitungs-Methoden aus §3.2b Ebene 2. Nur {@code direct} ist in
     * diesem Paket gebaut - die anderen sind BENANNT, damit eine Anfrage danach
     * eine ehrliche Antwort bekommt statt still auf eine Vorgabe zu fallen.
     */
    public static final String SOC_DIRECT = "direct";
    public static final String SOC_OCV_CURVE = "ocv_curve";
    public static final String SOC_COULOMB = "coulomb";
    private static final Set<String> SOC_METHODS_LATER = Set.of(SOC_OCV_CURVE, SOC_COULOMB);

    private static final java.util.regex.Pattern PATH_SEGMENT =
            java.util.regex.Pattern.compile("^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$");
    private static final Set<String> FORBIDDEN_SEGMENTS =
            Set.of("__proto__", "constructor", "prototype");

    private UserDefinedBatteryDefinition() {
    }

    /** Der Broker, auf dem die Batterie spricht. */
    public record Broker(String host, Integer port) {

        public int effectivePort() {
            return port == null ? DEFAULT_PORT : port;
        }
    }

    /** Eine Feld-Zuordnung, wie sie der Assistent schickt. */
    public record Mapping(String channel, String topic, String path, String aggregate,
            String valueType, Double scale, Double offset, Double sentinel, Integer staleS,
            List<String> trueValues, List<String> falseValues) {
    }

    /** Die (vorerst nur benannte) SoC-Ableitung - der Andockpunkt für P5b. */
    public record SocDerivation(String method) {
    }

    /**
     * Eine normalisierte Zuordnung: alle Vorgaben sind gefüllt. Das ist die
     * Form, die gespeichert und in den Flow kompiliert wird - danach rät
     * niemand mehr an einer Vorgabe herum.
     */
    public record NormalizedMapping(String channel, String unit, String topic, String path,
            String aggregate, String valueType, double scale, double offset, Double sentinel,
            int staleS, List<String> trueValues, List<String> falseValues) {
    }

    /** Das Ergebnis einer Prüfung: entweder Fehler, oder die normalisierte Form. */
    public record Result(List<String> errors, Broker broker, List<NormalizedMapping> mappings,
            int publishIntervalS, SocDerivation socDerivation) {

        public boolean ok() {
            return errors.isEmpty();
        }

        /** Die Messkanäle, die diese Batterie WIRKLICH liefert. */
        public List<String> channels() {
            return mappings.stream().map(NormalizedMapping::channel).toList();
        }
    }

    /**
     * Prüft und normalisiert eine ganze Definition.
     *
     * <p>Es werden ALLE Fehler gesammelt statt beim ersten abzubrechen: ein
     * Formular, das seine Mängel einzeln nacheinander meldet, macht aus einem
     * Tippfehler drei Runden.
     *
     * @param allowedChannels Kanal → Einheit, wörtlich das
     *     {@code default_measure} des Typkatalogs. Es reist herein, damit es
     *     genau EINE Wahrheit über die Standard-Batteriekanäle gibt.
     */
    public static Result validate(Broker broker, List<Mapping> mappings, Integer publishIntervalS,
            SocDerivation soc, Map<String, String> allowedChannels) {
        List<String> errors = new ArrayList<>();
        checkBroker(broker, errors);

        int interval = publishIntervalS == null ? DEFAULT_PUBLISH_INTERVAL_S : publishIntervalS;
        if (interval < MIN_PUBLISH_INTERVAL_S || interval > MAX_PUBLISH_INTERVAL_S) {
            errors.add("Der Sende-Abstand muss zwischen " + MIN_PUBLISH_INTERVAL_S + " und "
                    + MAX_PUBLISH_INTERVAL_S + " Sekunden liegen.");
        }

        List<Mapping> list = mappings == null ? List.of() : mappings;
        if (list.isEmpty()) {
            errors.add("Bitte ordnen Sie mindestens ein Feld einem Messwert zu - ohne Zuordnung "
                    + "liest VoltPilot von dieser Batterie nichts.");
        }
        if (list.size() > MAX_MAPPINGS) {
            errors.add("Höchstens " + MAX_MAPPINGS + " Zuordnungen je Batterie.");
        }

        Map<String, String> allowed = allowedChannels == null ? Map.of() : allowedChannels;
        List<NormalizedMapping> out = new ArrayList<>();
        Set<String> taken = new LinkedHashSet<>();
        int i = 0;
        for (Mapping m : list) {
            i++;
            NormalizedMapping n = checkMapping(m, i, taken, allowed, errors);
            if (n != null) {
                out.add(n);
            }
        }

        SocDerivation derivation = checkSoc(soc, taken, errors);
        return new Result(List.copyOf(errors), broker, List.copyOf(out), interval, derivation);
    }

    private static void checkBroker(Broker b, List<String> errors) {
        String host = b == null || b.host() == null ? "" : b.host().trim();
        if (host.isEmpty()) {
            errors.add("Bitte tragen Sie die Adresse des MQTT-Brokers in Ihrem Netzwerk ein.");
        } else if (!SelfBuildDefinition.isPrivateHost(host)) {
            errors.add(SelfBuildDefinition.HOST_NOT_PRIVATE);
        }
        if (b != null && b.port() != null && (b.port() < 1 || b.port() > 65535)) {
            errors.add("Der Port muss zwischen 1 und 65535 liegen.");
        }
    }

    private static NormalizedMapping checkMapping(Mapping m, int index, Set<String> taken,
            Map<String, String> allowed, List<String> errors) {
        String where = "Zuordnung " + index;
        if (m == null) {
            errors.add(where + " ist leer.");
            return null;
        }
        String channel = m.channel() == null ? "" : m.channel().trim();
        if (!allowed.containsKey(channel)) {
            errors.add(where + ": „" + channel + "“ ist kein Batterie-Messwert. Möglich sind: "
                    + String.join(", ", allowed.keySet()) + ".");
            return null;
        }
        if (!taken.add(channel)) {
            errors.add(where + ": der Messwert „" + channel + "“ ist schon zugeordnet. "
                    + "Ein Messwert hat genau eine Quelle.");
            return null;
        }

        String topic = m.topic() == null ? "" : m.topic().trim();
        if (topic.isEmpty()) {
            errors.add(where + ": bitte das MQTT-Topic angeben (Platzhalter + und # sind "
                    + "erlaubt).");
            return null;
        }
        if (!isValidTopicFilter(topic)) {
            errors.add(where + ": „" + topic + "“ ist kein gültiger MQTT-Filter. „+“ "
                    + "steht für genau eine Ebene, „#“ nur als letzte Ebene.");
            return null;
        }

        String path = m.path() == null ? "" : m.path().trim();
        if (!isValidValuePath(path)) {
            errors.add(where + ": „" + path + "“ ist kein gültiger Wertepfad. Beispiel: "
                    + "voltage oder bms.soc; leer heißt „die Nachricht ist der Wert“.");
            return null;
        }

        String aggregate = m.aggregate() == null || m.aggregate().isBlank() ? "last"
                : m.aggregate().trim().toLowerCase(Locale.ROOT);
        if (!AGGREGATES.contains(aggregate)) {
            errors.add(where + ": diese Zusammenfassung kennen wir nicht (möglich: "
                    + String.join(", ", new java.util.TreeSet<>(AGGREGATES)) + ").");
            return null;
        }
        String valueType = m.valueType() == null || m.valueType().isBlank() ? "number"
                : m.valueType().trim().toLowerCase(Locale.ROOT);
        if (!VALUE_TYPES.contains(valueType)) {
            errors.add(where + ": der Werttyp muss „number“ oder „bool“ sein.");
            return null;
        }

        double scale = m.scale() == null ? 1.0 : m.scale();
        double offset = m.offset() == null ? 0.0 : m.offset();
        if (!Double.isFinite(scale) || scale == 0.0) {
            errors.add(where + ": die Skalierung muss eine Zahl ungleich 0 sein.");
            return null;
        }
        if (!Double.isFinite(offset)) {
            errors.add(where + ": der Offset muss eine Zahl sein.");
            return null;
        }
        if (m.sentinel() != null && !Double.isFinite(m.sentinel())) {
            errors.add(where + ": der Wert für „nicht gemessen“ muss eine Zahl sein.");
            return null;
        }
        int stale = m.staleS() == null ? DEFAULT_STALE_S : m.staleS();
        if (stale < MIN_STALE_S || stale > MAX_STALE_S) {
            errors.add(where + ": die Haltbarkeit muss zwischen " + MIN_STALE_S + " und "
                    + MAX_STALE_S + " Sekunden liegen.");
            return null;
        }
        // Ein Wahrheitswert wird nicht GEMITTELT: die Summe von Freigaben ist
        // keine Freigabe, und ein Mittel von 0,5 wäre eine Zahl, die kein
        // Gerät je gemeldet hat - gerundet würde daraus ein „ja",
        // das niemand gegeben hat.
        if ("bool".equals(valueType) && !BOOL_AGGREGATES.contains(aggregate)) {
            errors.add(where + ": ein Ja/Nein-Wert lässt sich so nicht zusammenfassen. "
                    + "Möglich sind: letzter Wert, min (alle erlauben es) und max "
                    + "(mindestens einer erlaubt es).");
            return null;
        }
        // Ein Wahrheitswert IST 0/1 - eine Skalierung darauf wäre eine
        // Erfindung, und sie stillschweigend zu übernehmen hieße, ein
        // „an" könnte 1000 bedeuten.
        if ("bool".equals(valueType) && (scale != 1.0 || offset != 0.0)) {
            errors.add(where + ": ein Ja/Nein-Wert kennt keine Skalierung - er reist als 0 "
                    + "oder 1.");
            return null;
        }
        return new NormalizedMapping(channel, allowed.get(channel), topic, path, aggregate,
                valueType, scale, offset, m.sentinel(), stale,
                words(m.trueValues()), words(m.falseValues()));
    }

    /**
     * Die SoC-Ableitung (Ebene 2, §3.2b) - hier NUR der Andockpunkt.
     *
     * <p>{@code direct} heißt „die Quelle liefert einen echten Ladestand"; sie
     * ist deshalb an einen zugeordneten {@code soc_pct} gebunden
     * (Ehrlichkeitsregel 1: kein Ladestand ohne Eingang). Die beiden
     * RECHNENDEN Methoden werden benannt abgelehnt: eine gespeicherte Methode,
     * die niemand ausführt, wäre eine Zusage ohne Werk.
     */
    private static SocDerivation checkSoc(SocDerivation soc, Set<String> mappedChannels,
            List<String> errors) {
        String method = soc == null || soc.method() == null || soc.method().isBlank() ? null
                : soc.method().trim().toLowerCase(Locale.ROOT);
        if (method == null) {
            // Ohne Angabe: „direkt", falls es einen Ladestand gibt - sonst gar
            // keine Ableitung. Eine Batterie ohne SoC-Quelle ist ein
            // legitimer Zustand (der Optimierer plant sie dann nicht, P7).
            return mappedChannels.contains("soc_pct") ? new SocDerivation(SOC_DIRECT) : null;
        }
        if (SOC_METHODS_LATER.contains(method)) {
            errors.add("Der Ladestand aus " + (SOC_OCV_CURVE.equals(method)
                    ? "einer Spannungskennlinie" : "einer Ladungszählung")
                    + " wird noch nicht berechnet. Ordnen Sie bis dahin einen gemessenen "
                    + "Ladestand zu, oder lassen Sie die Batterie ohne Ladestand laufen.");
            return null;
        }
        if (!SOC_DIRECT.equals(method)) {
            errors.add("Diese Art der Ladestand-Ermittlung kennen wir nicht.");
            return null;
        }
        if (!mappedChannels.contains("soc_pct")) {
            errors.add("Für einen übernommenen Ladestand muss „soc_pct“ zugeordnet sein - "
                    + "ohne Eingang gibt es keinen Ladestand.");
            return null;
        }
        return new SocDerivation(SOC_DIRECT);
    }

    private static List<String> words(List<String> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String w : raw) {
            if (w != null && !w.isBlank() && w.length() <= 32) {
                out.add(w.trim().toLowerCase(Locale.ROOT));
            }
        }
        return List.copyOf(out);
    }

    /**
     * Ein MQTT-Topic-Filter: {@code +} steht für GENAU eine Ebene, {@code #}
     * nur als letzte. Der Zwilling von {@code flowc/catalog.js
     * validTopicFilter} und {@code lib/mqtt-mapping.js topicMatches}.
     */
    public static boolean isValidTopicFilter(String filter) {
        if (filter == null || filter.isEmpty() || filter.length() > MAX_TOPIC_LENGTH) {
            return false;
        }
        for (int i = 0; i < filter.length(); i++) {
            if (Character.isWhitespace(filter.charAt(i))) {
                return false;
            }
        }
        String[] parts = filter.split("/", -1);
        for (int i = 0; i < parts.length; i++) {
            String seg = parts[i];
            if ("#".equals(seg)) {
                if (i != parts.length - 1) {
                    return false;
                }
            } else if (seg.indexOf('#') >= 0 || (seg.indexOf('+') >= 0 && !"+".equals(seg))) {
                return false;
            }
        }
        return true;
    }

    /**
     * Ein Wertepfad ist punkt-getrennt ({@code voltage}, {@code bms.soc}); leer
     * heißt „die Nutzlast IST der Wert". {@code __proto__} und Geschwister sind
     * überall verboten - die Box geht diesen Pfad durch eine JSON-Struktur.
     */
    public static boolean isValidValuePath(String path) {
        if (path == null || path.isEmpty()) {
            return true;
        }
        if (path.length() > MAX_PATH_LENGTH) {
            return false;
        }
        for (String seg : path.split("\\.", -1)) {
            if (!PATH_SEGMENT.matcher(seg).matches() || FORBIDDEN_SEGMENTS.contains(seg)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Die Felder, über die der Beleg eines Broker-Tests laufen WÜRDE.
     *
     * <p>Sie stehen hier, weil sie zum Anschluss gehören - benutzt werden sie
     * noch nicht: eine Live-Vorschau über den Probe-Kanal braucht ein
     * Lauschfenster statt einer Einmal-Lesung, und die ist Teil des
     * Mapping-Assistenten (P5d). Bis dahin gibt es hier bewusst keine
     * Verbindungstest-PFLICHT: sie zu fordern, ohne einen Test anzubieten,
     * wäre eine Tür, die niemand öffnen kann.
     */
    public static Map<String, Object> receiptFields(Broker b) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("host", b == null || b.host() == null ? "" : b.host().trim());
        m.put("port", b == null ? DEFAULT_PORT : b.effectivePort());
        return m;
    }
}
