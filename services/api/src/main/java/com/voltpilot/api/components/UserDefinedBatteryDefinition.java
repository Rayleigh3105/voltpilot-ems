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

    /** Der Kanal, den jede Ableitung füllt. */
    public static final String SOC_CHANNEL = "soc_pct";

    /**
     * Der Kanal, der die HERKUNFT des Ladestands trägt (P5b).
     *
     * <p>⚠ Warum ein CODE und kein Wort: die Telemetrie-Kanäle sind per
     * Vertrag ZAHLEN ({@code edge-entity.schema.json $defs.channels},
     * {@code telemetry_v2.value} ist {@code DOUBLE PRECISION}). Ein Wort hätte
     * einen Umbau der ganzen Ingest-Kette gebraucht; ein Code reist durch die
     * BEWIESENE Kette unverändert und steht JE MESSZEITPUNKT in der Historie -
     * genau die Eigenschaft, die §3.2b verlangt („die Historie behält die
     * damalige Quelle"). Es gibt bewusst keine 0 für „unbekannt": ein
     * unbekannter Ladestand ist ein ABWESENDER Kanal, nie eine gemeldete Null.
     *
     * <p>1 = gemessen · 2 = berechnet:kennlinie · 3 = berechnet:ladungszählung.
     * Der Zwilling von {@code lib/soc-derivation.js SOURCE_CODES}.
     */
    public static final String SOC_SOURCE_CHANNEL = "soc_source_code";

    public static final int SOC_CODE_GEMESSEN = 1;
    public static final int SOC_CODE_KENNLINIE = 2;
    public static final int SOC_CODE_LADUNGSZAEHLUNG = 3;

    /**
     * Die SoC-Ableitungs-Methoden aus §3.2b Ebene 2 - seit P5b alle drei
     * gebaut. Der Zwilling von {@code lib/soc-derivation.js METHODS} und
     * {@code flowc/catalog.js SOC_METHODS}.
     */
    public static final String SOC_DIRECT = "direct";
    public static final String SOC_OCV_CURVE = "ocv_curve";
    public static final String SOC_COULOMB = "coulomb";
    public static final Set<String> SOC_METHODS =
            Set.of(SOC_DIRECT, SOC_OCV_CURVE, SOC_COULOMB);

    /**
     * Die Eingänge einer Ableitung: Rolle → Vorgabe-Kanal. Der Nutzer darf
     * jede Rolle auf einen ANDEREN Standard-Kanal legen; ein Kanal außerhalb
     * des Typkatalogs wird - wie überall in diesem Bausatz - VERWORFEN.
     */
    public static final Map<String, String> SOC_INPUT_DEFAULTS = Map.of(
            "soc", "soc_pct",
            "cell_min", "cell_min_mv",
            "cell_max", "cell_max_mv",
            "voltage", "voltage_v",
            "current", "current_a",
            "power", "power_kw");

    /** Schranken einer Kennlinie - der Zwilling von {@code lib/soc-derivation.js}. */
    public static final int MIN_CURVE_POINTS = 2;
    public static final int MAX_CURVE_POINTS = 64;
    public static final double MIN_CELL_V = 0.5;
    public static final double MAX_CELL_V = 5.0;

    /** Wie lange ein eingefrorener Ladestand überhaupt noch gehalten wird. */
    public static final int DEFAULT_HOLD_S = 900;
    public static final int MIN_HOLD_S = 60;
    public static final int MAX_HOLD_S = 86400;

    /** Das Rundungsraster des Ergebnisses (HA-Vorbild: 0,1 %). */
    public static final double DEFAULT_ROUND_PCT = 0.1;
    public static final double MAX_ROUND_PCT = 5.0;

    public static final int MAX_CELLS_IN_SERIES = 1024;
    public static final double MAX_CAPACITY_KWH = 10000.0;

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

    /**
     * Die SoC-Ableitung (Ebene 2, P5b) - Methode, Eingänge, Rechenwerte.
     *
     * <p>{@code inputs} ist Rolle → Kanalname und immer VOLLSTÄNDIG gefüllt:
     * nach der Prüfung rät weder die Box noch ein späterer Leser an einer
     * Vorgabe herum.
     */
    public record SocDerivation(String method, boolean preferDirect, Map<String, String> inputs,
            SocParams params, String template, int holdS) {
    }

    /** Der Anker einer Ladungszählung: hier stand der Speicher, und zwar da. */
    public record SocAnchor(double socPct, String at) {
    }

    /**
     * Die Rekalibrierung an den Spannungs-ENDPUNKTEN: erreicht die höchste
     * Zelle {@code fullCellMv}, gilt der Speicher als {@code fullSocPct} voll;
     * fällt die niedrigste auf {@code emptyCellMv}, als {@code emptySocPct}.
     * Eine Messung schlägt eine Integration - das ist das ganze Gegenmittel
     * gegen die Drift der Zählung.
     */
    public record SocRecalibrate(Double fullCellMv, Double fullSocPct, Double emptyCellMv,
            Double emptySocPct) {
    }

    /** Die Rechenwerte einer Ableitung; eine Kennlinie ist [[Zell-V, %], …]. */
    public record SocParams(List<double[]> curveCharge, List<double[]> curveDischarge,
            Integer cellsInSeries, boolean conservativeMin, double roundPct, Double capacityKwh,
            Double efficiencyPct, Double nominalVoltageV, Double refTempC, SocAnchor anchor,
            SocRecalibrate recalibrate) {
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

        SocDerivation derivation = checkSoc(soc, taken, allowed, errors);
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
        // Die HERKUNFT des Ladestands entsteht in der Ebene 2 und wird nie
        // gelesen: kein BMS der Welt veroeffentlicht sie. Sie zuzuordnen hiesse,
        // eine Rechnung als Messung auszugeben.
        if (SOC_SOURCE_CHANNEL.equals(channel)) {
            errors.add(where + ": „" + SOC_SOURCE_CHANNEL + "“ lässt sich nicht zuordnen - "
                    + "die Herkunft des Ladestands entsteht bei der Ableitung, sie wird nicht "
                    + "gemessen.");
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
     * Die SoC-Ableitung (Ebene 2, §3.2b / Paket P5b) - die ganze Regel.
     *
     * <p><b>Die Ehrlichkeitsregel, an der jede Zeile hier hängt: kein
     * Ladestand ohne EINGANG.</b> Jede Methode wird gegen die TATSÄCHLICH
     * zugeordneten Kanäle geprüft, nie gegen die Wunschliste:
     *
     * <ul>
     *   <li>{@code direct} braucht ein zugeordnetes {@code soc_pct} - „die
     *       Quelle liefert einen echten Ladestand" wäre sonst eine Behauptung
     *       über eine Quelle, die schweigt.</li>
     *   <li>{@code ocv_curve} braucht eine Zellspannung (die niedrigste
     *       und/oder die höchste) ODER Packspannung samt Zellzahl in Reihe -
     *       und mindestens die Ladekurve. Eine geratene Kennlinie wäre
     *       schlimmer als gar keine.</li>
     *   <li>{@code coulomb} braucht eine Leistung (oder Strom samt Spannung),
     *       eine nutzbare Kapazität UND einen ANKER: eine Zählung, die bei
     *       einem geratenen Startwert beginnt, ist eine Behauptung mit
     *       Nachkommastellen. Ein zugeordnetes {@code soc_pct} ist der beste
     *       Anker, den es gibt, und zählt deshalb als einer.</li>
     * </ul>
     *
     * <p><b>Die Auswahl-Logik</b> aus §3.2b („bevorzugt (a), sobald
     * {@code soc_pct} gemappt und frisch ist; sonst (b) oder (c)") ist bewusst
     * eine LAUFZEIT-Vorrangregel und keine Formular-Verzweigung: die Box nimmt
     * eine frische Messung immer vor die eigene Rechnung, und
     * {@code preferDirect = false} schaltet das nur für den Vergleichsbetrieb
     * ab. Hier steht deshalb allein, ob die gewählte Methode überhaupt rechnen
     * KANN.
     *
     * @param mappedChannels die Kanäle, die die Zuordnung wirklich liefert
     * @param allowed das Vokabular des Typkatalogs (Kanal → Einheit)
     */
    private static SocDerivation checkSoc(SocDerivation soc, Set<String> mappedChannels,
            Map<String, String> allowed, List<String> errors) {
        String method = soc == null || soc.method() == null || soc.method().isBlank() ? null
                : soc.method().trim().toLowerCase(Locale.ROOT);
        if (method == null) {
            // Ohne Angabe: „direkt", falls es einen Ladestand gibt - sonst gar
            // keine Ableitung. Eine Batterie ohne SoC-Quelle ist ein legitimer
            // Zustand (der Optimierer plant sie dann nicht, P7).
            return mappedChannels.contains("soc_pct")
                    ? new SocDerivation(SOC_DIRECT, true, SOC_INPUT_DEFAULTS, emptyParams(), null,
                            DEFAULT_HOLD_S)
                    : null;
        }
        if (!SOC_METHODS.contains(method)) {
            errors.add("Diese Art der Ladestand-Ermittlung kennen wir nicht.");
            return null;
        }

        Map<String, String> inputs = socInputs(soc, allowed, errors);
        SocParams params = socParams(soc, errors);
        int holdS = soc.holdS() <= 0 ? DEFAULT_HOLD_S : soc.holdS();
        if (holdS < MIN_HOLD_S || holdS > MAX_HOLD_S) {
            errors.add("Die Haltefrist muss zwischen " + MIN_HOLD_S + " und " + MAX_HOLD_S
                    + " Sekunden liegen.");
        }
        if (inputs == null || params == null) {
            return null;
        }
        // Ein Eingang zählt nur, wenn sein Kanal auch WIRKLICH zugeordnet ist.
        java.util.function.Predicate<String> has =
                role -> mappedChannels.contains(inputs.get(role));

        if (SOC_DIRECT.equals(method) && !has.test("soc")) {
            errors.add("Für einen übernommenen Ladestand muss „" + inputs.get("soc")
                    + "“ zugeordnet sein - ohne Eingang gibt es keinen Ladestand.");
            return null;
        }
        if (SOC_OCV_CURVE.equals(method)) {
            if (params.curveCharge() == null) {
                errors.add("Für die Spannungskennlinie fehlt die Ladekurve. Wählen Sie eine "
                        + "Vorlage oder tragen Sie die Stützpunkte Ihrer Zelle ein.");
                return null;
            }
            boolean cells = has.test("cell_min") || has.test("cell_max");
            boolean pack = has.test("voltage") && params.cellsInSeries() != null;
            if (!cells && !pack) {
                errors.add("Für die Spannungskennlinie braucht VoltPilot eine Zellspannung "
                        + "(„cell_min_mv“ und/oder „cell_max_mv“) oder die Packspannung "
                        + "(„voltage_v“) samt Zellzahl in Reihe.");
                return null;
            }
        }
        if (SOC_COULOMB.equals(method)) {
            if (params.capacityKwh() == null) {
                errors.add("Für die Ladungszählung fehlt die nutzbare Kapazität in kWh.");
                return null;
            }
            boolean power = has.test("power");
            boolean current = has.test("current")
                    && (has.test("voltage") || params.nominalVoltageV() != null);
            if (!power && !current) {
                errors.add("Für die Ladungszählung braucht VoltPilot die Batterie-Leistung "
                        + "(„power_kw“) oder den Strom („current_a“) samt Spannung.");
                return null;
            }
            // Der ANKER ist die halbe Methode: ohne Startpunkt zählt niemand.
            if (params.anchor() == null && !has.test("soc")) {
                errors.add("Die Ladungszählung braucht einen Startwert: entweder einen Anker "
                        + "(Ladestand samt Zeitpunkt) oder einen zugeordneten gemessenen "
                        + "Ladestand, an dem sie sich ausrichtet.");
                return null;
            }
        }

        String template = soc.template() == null || soc.template().isBlank() ? null
                : soc.template().trim();
        return new SocDerivation(method, soc.preferDirect(), inputs, params, template, holdS);
    }

    /** Die leeren Rechenwerte - was {@code direct} braucht, und sonst nichts. */
    private static SocParams emptyParams() {
        return new SocParams(null, null, null, true, DEFAULT_ROUND_PCT, null, null, null, null,
                null, null);
    }

    /**
     * Rolle → Kanal, vollständig gefüllt.
     *
     * <p>Ein Kanal außerhalb des Typkatalogs wird VERWORFEN, nie geraten -
     * dieselbe Regel wie bei einer Zuordnung. Dass ein Kanal auch wirklich
     * ZUGEORDNET ist, prüft danach die Methode selbst: ein benannter Eingang
     * ohne Quelle ist kein Tippfehler, sondern eine fehlende Messung.
     */
    private static Map<String, String> socInputs(SocDerivation soc, Map<String, String> allowed,
            List<String> errors) {
        Map<String, String> raw = soc.inputs() == null ? Map.of() : soc.inputs();
        Map<String, String> out = new LinkedHashMap<>();
        boolean ok = true;
        for (Map.Entry<String, String> role : new java.util.TreeMap<>(SOC_INPUT_DEFAULTS)
                .entrySet()) {
            String named = raw.get(role.getKey());
            String channel = named == null || named.isBlank() ? role.getValue() : named.trim();
            if (!allowed.containsKey(channel)) {
                errors.add("Der Eingang „" + role.getKey() + "“ zeigt auf „" + channel
                        + "“ - das ist kein Batterie-Messwert.");
                ok = false;
                continue;
            }
            out.put(role.getKey(), channel);
        }
        return ok ? Map.copyOf(out) : null;
    }

    /** Die Rechenwerte - jede Schranke einzeln, alle Fehler gesammelt. */
    private static SocParams socParams(SocDerivation soc, List<String> errors) {
        SocParams p = soc.params();
        if (p == null) {
            return emptyParams();
        }
        int before = errors.size();
        List<double[]> charge = checkCurve(p.curveCharge(), "Ladekurve", errors);
        List<double[]> discharge = checkCurve(p.curveDischarge(), "Entladekurve", errors);

        Integer cells = p.cellsInSeries();
        if (cells != null && (cells < 1 || cells > MAX_CELLS_IN_SERIES)) {
            errors.add("Die Zellzahl in Reihe muss zwischen 1 und " + MAX_CELLS_IN_SERIES
                    + " liegen.");
        }
        double round = p.roundPct() <= 0 ? DEFAULT_ROUND_PCT : p.roundPct();
        if (round <= 0 || round > MAX_ROUND_PCT) {
            errors.add("Das Rundungsraster muss größer als 0 und höchstens " + MAX_ROUND_PCT
                    + " Prozent sein.");
        }
        Double capacity = p.capacityKwh();
        if (capacity != null && (!Double.isFinite(capacity) || capacity <= 0
                || capacity > MAX_CAPACITY_KWH)) {
            errors.add("Die nutzbare Kapazität muss zwischen 0 und " + MAX_CAPACITY_KWH
                    + " kWh liegen.");
        }
        Double efficiency = p.efficiencyPct();
        if (efficiency != null && (!Double.isFinite(efficiency) || efficiency <= 0
                || efficiency > 100)) {
            errors.add("Der Wirkungsgrad muss zwischen 0 und 100 Prozent liegen.");
        }
        Double nominal = p.nominalVoltageV();
        if (nominal != null && (!Double.isFinite(nominal) || nominal <= 0 || nominal > 1500)) {
            errors.add("Die Nennspannung muss zwischen 0 und 1500 V liegen.");
        }
        Double refTemp = p.refTempC();
        if (refTemp != null && (!Double.isFinite(refTemp) || refTemp < -40 || refTemp > 100)) {
            errors.add("Die Referenztemperatur muss zwischen -40 und 100 °C liegen.");
        }
        SocAnchor anchor = checkAnchor(p.anchor(), errors);
        SocRecalibrate recal = checkRecalibrate(p.recalibrate(), errors);
        if (errors.size() != before) {
            return null;
        }
        return new SocParams(charge, discharge, cells, p.conservativeMin(), round, capacity,
                efficiency, nominal, refTemp, anchor, recal);
    }

    /**
     * Eine OCV-Kennlinie: 2 bis {@value #MAX_CURVE_POINTS} Stützpunkte
     * [Zellspannung in V, Ladestand in %], aufsteigend nach Spannung UND nach
     * Ladestand.
     *
     * <p>⚠ Die Monotonie ist keine Formalie: eine Kurve, die bei STEIGENDER
     * Spannung fällt, beschreibt keine Lithium-Zelle - sie ist ein Tippfehler,
     * der stillschweigend einen falschen Ladestand ausgerechnet hätte. Und
     * außerhalb der Enden wird später GEKLEMMT statt extrapoliert, weshalb
     * eine Kurve ihr eigenes Spannungsfenster ehrlich nennen muss.
     *
     * <p>Öffentlich, weil {@code SocCurveTemplateCatalog} die ausgelieferten
     * VORLAGEN durch exakt dieselbe Prüfung schickt: eine Vorlage, die die
     * Regel ihrer eigenen Fläche nicht besteht, wäre eine Falle mit Gütesiegel.
     */
    public static List<double[]> checkCurve(List<double[]> raw, String what,
            List<String> errors) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        if (raw.size() < MIN_CURVE_POINTS || raw.size() > MAX_CURVE_POINTS) {
            errors.add(what + ": es braucht " + MIN_CURVE_POINTS + " bis " + MAX_CURVE_POINTS
                    + " Stützpunkte.");
            return null;
        }
        List<double[]> out = new ArrayList<>();
        for (double[] point : raw) {
            if (point == null || point.length < 2) {
                errors.add(what + ": ein Stützpunkt braucht Spannung und Ladestand.");
                return null;
            }
            double volt = point[0];
            double pct = point[1];
            if (!Double.isFinite(volt) || volt < MIN_CELL_V || volt > MAX_CELL_V) {
                errors.add(what + ": die Zellspannung " + volt + " V liegt außerhalb von "
                        + MIN_CELL_V + " bis " + MAX_CELL_V + " V.");
                return null;
            }
            if (!Double.isFinite(pct) || pct < 0 || pct > 100) {
                errors.add(what + ": der Ladestand " + pct + " % liegt außerhalb von 0 bis 100.");
                return null;
            }
            out.add(new double[] {volt, pct});
        }
        out.sort((a, b) -> Double.compare(a[0], b[0]));
        for (int i = 1; i < out.size(); i++) {
            if (out.get(i)[0] == out.get(i - 1)[0]) {
                errors.add(what + ": die Zellspannung " + out.get(i)[0]
                        + " V steht zweimal in der Tabelle.");
                return null;
            }
            if (out.get(i)[1] < out.get(i - 1)[1]) {
                errors.add(what + ": bei " + out.get(i)[0] + " V steht ein KLEINERER Ladestand "
                        + "als bei der niedrigeren Spannung davor - eine Kennlinie steigt.");
                return null;
            }
        }
        return List.copyOf(out);
    }

    private static SocAnchor checkAnchor(SocAnchor anchor, List<String> errors) {
        if (anchor == null) {
            return null;
        }
        if (!Double.isFinite(anchor.socPct()) || anchor.socPct() < 0 || anchor.socPct() > 100) {
            errors.add("Der Anker-Ladestand muss zwischen 0 und 100 Prozent liegen.");
            return null;
        }
        return anchor;
    }

    private static SocRecalibrate checkRecalibrate(SocRecalibrate r, List<String> errors) {
        if (r == null) {
            return null;
        }
        boolean full = r.fullCellMv() != null || r.fullSocPct() != null;
        boolean empty = r.emptyCellMv() != null || r.emptySocPct() != null;
        // Ein halber Endpunkt ist keiner: „ab 4060 mV" ohne Ziel-Ladestand
        // hätte die Box raten lassen, worauf sie zurücksetzt.
        if (full && (r.fullCellMv() == null || r.fullSocPct() == null)) {
            errors.add("Der VOLL-Endpunkt braucht beides: die Zellspannung und den Ladestand.");
            return null;
        }
        if (empty && (r.emptyCellMv() == null || r.emptySocPct() == null)) {
            errors.add("Der LEER-Endpunkt braucht beides: die Zellspannung und den Ladestand.");
            return null;
        }
        if (!full && !empty) {
            return null;
        }
        if (full && (r.fullSocPct() < 0 || r.fullSocPct() > 100)) {
            errors.add("Der Ladestand des VOLL-Endpunkts muss zwischen 0 und 100 Prozent liegen.");
            return null;
        }
        if (empty && (r.emptySocPct() < 0 || r.emptySocPct() > 100)) {
            errors.add("Der Ladestand des LEER-Endpunkts muss zwischen 0 und 100 Prozent liegen.");
            return null;
        }
        if (full && empty && r.emptyCellMv() >= r.fullCellMv()) {
            errors.add("Der LEER-Endpunkt muss unter dem VOLL-Endpunkt liegen.");
            return null;
        }
        return r;
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
