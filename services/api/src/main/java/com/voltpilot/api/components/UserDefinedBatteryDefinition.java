package com.voltpilot.api.components;

import java.util.ArrayList;
import java.util.Collection;
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

    /**
     * Dieselbe Marke für den ZWEITEN Ebene-1-Lesetyp: die Batterie hängt an
     * ihrer eigenen HTTP/JSON-Auskunft im Heimnetz (P5-HTTP).
     *
     * <p>⚠ Auch dieser Wert wird VERBATIM mit der Box geteilt
     * ({@code edge-app/core/internal/componentapply.CommunicationHTTPLocal}),
     * und die ROLLOUT-Reihenfolge gilt wörtlich wie bei {@link #COMMUNICATION}:
     * eine Box OHNE die Konstante lässt den ganzen Registry-Push fallen, statt
     * diese eine Komponente zu überspringen. Das Edge-Release muss eine Anlage
     * also erreichen, BEVOR dort die erste HTTP-Batterie entsteht.
     */
    public static final String COMMUNICATION_HTTP = "http_local";

    /**
     * Die beiden TRANSPORTE der Ebene 1 - das Wort, das in
     * {@code connection_json.transport} steht und im Portal die Anschlussart
     * ist. Ein Wort außerhalb dieser Liste wird VERWORFEN, nie geraten.
     */
    public static final String TRANSPORT_MQTT = "mqtt_local";
    public static final String TRANSPORT_HTTP = "http_local";
    public static final Set<String> TRANSPORTS = Set.of(TRANSPORT_MQTT, TRANSPORT_HTTP);

    /** Die Herkunft, mit der eine so angelegte Batterie gestempelt wird. */
    public static final String SOURCE_KIND = "custom";

    /** Der Entitätstyp, den dieser Weg anlegt. */
    public static final String ENTITY_TYPE = "user-defined-battery";

    /** Der voreingestellte Port eines lokalen MQTT-Brokers. */
    public static final int DEFAULT_PORT = 1883;

    // ---- Der HTTP/JSON-Lesetyp (P5-HTTP) ----------------------------------

    /** Die voreingestellten Ports einer Web-Auskunft im Heimnetz. */
    public static final int DEFAULT_HTTP_PORT = 80;
    public static final int DEFAULT_HTTPS_PORT = 443;

    /** Wie lange die Box auf eine Antwort wartet, bevor sie „keine Antwort" sagt. */
    public static final int DEFAULT_TIMEOUT_MS = 5000;
    public static final int MIN_TIMEOUT_MS = 500;
    public static final int MAX_TIMEOUT_MS = 30000;

    public static final int MAX_URL_PATH_LENGTH = 200;

    /**
     * Die Anmelde-Arten, die dieser Lesetyp kennt - der Zwilling von
     * {@code flowc/catalog.js HTTP_AUTH_MODES} und
     * {@code vp-palette/lib/http-mapping.js AUTH_MODES}.
     *
     * <p>{@code header} ist der DIYBMS-Fall (ein frei benannter Kopfzeilen-
     * Schlüssel, typisch {@code ApiKey}), {@code bearer} das
     * {@code Authorization: Bearer …}, {@code basic} das klassische HTTP-Basic.
     * {@code none} ist die Vorgabe, weil die meisten BMS im Heimnetz gar nichts
     * verlangen.
     */
    public static final String AUTH_NONE = "none";
    public static final String AUTH_HEADER = "header";
    public static final String AUTH_BEARER = "bearer";
    public static final String AUTH_BASIC = "basic";
    public static final Set<String> AUTH_MODES =
            Set.of(AUTH_NONE, AUTH_HEADER, AUTH_BEARER, AUTH_BASIC);

    /**
     * Der SCHLÜSSEL, unter dem das Geheimnis in {@code connection_json} wohnt.
     *
     * <p>⚠ Er steht auf der OBERSTEN Ebene und heißt so, weil
     * {@link ComponentSecrets#isSecretKey} genau daran greift: jede Auflistung
     * maskiert ihn dadurch OHNE eine Vorlage, aus der die Geheimnis-Schlüssel
     * sonst kämen. Ein verschachteltes {@code auth.secret} wäre der Maske
     * entgangen - und ein Kennwort im Browser gewesen.
     *
     * <p>⚠ Und er reist NIE im Flow-Dokument: das ist über
     * {@code GET /sites/{siteId}/flows/{flowId}/versions/{v}} für jeden
     * Portal-Benutzer des Mandanten lesbar. Der Weg zur Box ist der
     * Registry-Push ({@code driver.connection.auth_secret}), aus dem der
     * {@code vp-http-read}-Knoten ihn über die per-Gerät ausgerollte
     * Entitäts-Konfiguration liest.
     */
    public static final String SECRET_FIELD = "auth_secret";

    private static final java.util.regex.Pattern HEADER_NAME =
            java.util.regex.Pattern.compile("^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$");
    private static final java.util.regex.Pattern VALUE_PATH_SEGMENT =
            java.util.regex.Pattern.compile("^(\\*|[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$");

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

    // ---- Der SCHUTZ-/GRENZBAUSTEIN (P5c) ----------------------------------

    /**
     * Die vier Kanäle, die der Schutzbaustein FÜLLT (P5c, Konzept
     * {@code vp-deye-diybms-luecke-l5} §3.2b „OPTIONAL - Schutz-/Grenzbaustein"
     * und §3.3).
     *
     * <p>Er ist der GENERISCHE Nachbau dessen, was der Kunde heute in seinem
     * eigenen Node-RED fährt: aus dem Ladestand eine Strom-TREPPE je Richtung,
     * aus den Zellspannungen ein RIEGEL mit Hysterese. Ergebnis sind
     * {@code charge_limit_a} / {@code discharge_limit_a} und die beiden
     * Freigaben.
     *
     * <p>⚠ <b>Diese Stufe SCHREIBT auf kein Gerät.</b> Die Grenzen werden
     * BEREITGESTELLT - als Messkanäle für die Anzeige und als Kappe für den
     * Wächter auf der Box ({@code guards.Clamp}), unter der jeder
     * VoltPilot-Sollwert bleiben muss. Geräte-Stromgrenzen zu SCHREIBEN bleibt
     * einem zertifizierten Steuerpfad vorbehalten ({@code
     * ControlCertificationService}); bis dahin ist der Kundenflow der aktive
     * Schreiber, und die Kommando-Transparenz kennt ihn als fremden Einfluss.
     */
    public static final String CHARGE_LIMIT_CHANNEL = "charge_limit_a";
    public static final String DISCHARGE_LIMIT_CHANNEL = "discharge_limit_a";
    public static final String CHARGE_ALLOWED_CHANNEL = "charge_allowed";
    public static final String DISCHARGE_ALLOWED_CHANNEL = "discharge_allowed";

    /**
     * Die EINGÄNGE des Schutzbausteins: Rolle → Vorgabe-Kanal.
     *
     * <p>Weniger als bei der SoC-Ableitung, und mit Absicht: der Schutz kennt
     * nur den Ladestand (für die Treppe) und die beiden Extremzellen (für den
     * Riegel). Eine Leistung oder ein Strom wäre hier kein Eingang, sondern
     * eine zweite Rechnung.
     */
    public static final Map<String, String> PROTECTION_INPUT_DEFAULTS = Map.of(
            "soc", SOC_CHANNEL,
            "cell_min", "cell_min_mv",
            "cell_max", "cell_max_mv");

    /** Schranken einer Strom-Treppe - der Zwilling von {@code lib/limit-protection.js}. */
    public static final int MIN_STEPS = 1;
    public static final int MAX_STEPS = 32;
    public static final double MAX_CURRENT_A = 2000.0;

    /** Das Rundungsraster eines Stroms (der Kundenflow: ganze Ampere). */
    public static final double DEFAULT_ROUND_A = 1.0;
    public static final double MAX_ROUND_A = 10.0;

    // ---- Die SPEISER-BINDUNG (P6) -----------------------------------------

    /**
     * Die drei AUSDRÜCKLICHEN Antworten auf „wozu gehört diese Batterie?"
     * (Captain-Entscheid E6 (a), 09.09.2026).
     *
     * <ul>
     *   <li>{@link #BINDING_UNBOUND} - sie steht für sich. Ein Topologie-Knoten
     *       mit eigenen Messwerten, der NICHT in die Energiebilanz eingeht: die
     *       Stufe-3-Zusage, die der Assistent dem Kunden schon gedruckt hat.
     *       <b>Das ist die Vorgabe</b>, denn eine Bindung, die von selbst
     *       entsteht, ist geraten - und ein geratener Ladestand ist genau die
     *       erfundene Messung, die P7 gerade aus dem Optimierer entfernt hat.</li>
     *   <li>{@link #BINDING_FEEDS_INVERTER} - sie hängt an einem
     *       Hybrid-Wechselrichter und ist dessen SPEISER: Ladestand, Grenzen und
     *       Freigaben des Speicher-Knotens kommen von ihr, die LEISTUNG bleibt
     *       beim Wechselrichter, wo sie gemessen wird.</li>
     *   <li>{@link #BINDING_STANDALONE} - es gibt keinen Hybriden; sie IST der
     *       Speicher-Knoten und liefert dann auch die Leistung.</li>
     * </ul>
     */
    public static final String BINDING_UNBOUND = "unbound";
    public static final String BINDING_FEEDS_INVERTER = "feeds_inverter";
    public static final String BINDING_STANDALONE = "standalone";
    public static final Set<String> BINDING_MODES =
            Set.of(BINDING_UNBOUND, BINDING_FEEDS_INVERTER, BINDING_STANDALONE);

    /**
     * Die Kanäle, die eine GEBUNDENE Batterie in den Speicher-Knoten einspeist -
     * in dieser Reihenfolge, damit die geschriebenen Rollen-Zuordnungen
     * deterministisch sind.
     *
     * <p>⚠ {@code power_kw} steht bewusst NICHT dabei: es ist der eine Kanal,
     * über den die beiden Fälle sich unterscheiden. Beim Speiser misst der
     * Wechselrichter die Batterieleistung ohnehin - sie ein zweites Mal zu
     * zählen wäre schlicht falsch.
     */
    public static final List<String> BOUND_CHANNELS = List.of(
            SOC_CHANNEL, "charge_limit_a", "discharge_limit_a",
            "charge_allowed", "discharge_allowed");

    /**
     * Der Leistungs-Kanal, den NUR der eigenständige Fall mitgibt (Fall (2)).
     */
    public static final String POWER_CHANNEL = "power_kw";

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

    /**
     * Der ENDPUNKT der Web-Auskunft (P5-HTTP): die Adresse, die die Box im Takt
     * abfragt.
     *
     * <p>Der Pfad reist AUSGESCHRIEBEN - inklusive einer etwaigen
     * Abfrage-Zeichenkette. Die Box hängt nichts an und rät nichts dazu; ein
     * Endpunkt, den der Kunde aus seiner BMS-Dokumentation abschreibt, ist genau
     * der, der abgefragt wird.
     */
    public record Endpoint(String host, Integer port, String path, Boolean tls,
            Integer timeoutMs) {

        public boolean secure() {
            return Boolean.TRUE.equals(tls);
        }

        public int effectivePort() {
            return port == null ? (secure() ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT) : port;
        }

        public String effectivePath() {
            return path == null || path.isBlank() ? "/" : path.trim();
        }

        public int effectiveTimeoutMs() {
            return timeoutMs == null ? DEFAULT_TIMEOUT_MS : timeoutMs;
        }
    }

    /**
     * Die ANMELDUNG am Endpunkt (P5-HTTP) - Art, Name und (nur serverseitig)
     * der Wert.
     *
     * <p>⚠ {@code secret} verlässt den Server nur in EINE Richtung: in den
     * Registry-Push zur Box. Zum Portal reist an seiner Stelle die Maske
     * ({@link ComponentSecrets#MASK}), und ein Speichern, das die Maske oder gar
     * nichts schickt, BEHÄLT den gespeicherten Wert - dieselbe Disziplin wie
     * beim Katalog-Gerät. Im Flow-Dokument kommt er überhaupt nicht vor.
     *
     * @param mode einer aus {@link #AUTH_MODES}
     * @param header der Name der Kopfzeile - nur bei {@link #AUTH_HEADER}, und
     *     dort Pflicht
     * @param username der Benutzername - nur bei {@link #AUTH_BASIC}, und dort
     *     Pflicht. Er ist KEIN Geheimnis und reist deshalb auch im Flow.
     * @param secret der Wert; {@code null} heißt „unverändert" (beim Ändern)
     *     bzw. „keiner" (beim Anlegen)
     */
    public record Auth(String mode, String header, String username, String secret) {

        public String effectiveMode() {
            return mode == null || mode.isBlank() ? AUTH_NONE : mode.trim().toLowerCase(Locale.ROOT);
        }

        public boolean needsSecret() {
            return !AUTH_NONE.equals(effectiveMode());
        }
    }

    /** Die Vorgabe: keine Anmeldung - die meisten BMS im Heimnetz verlangen keine. */
    public static final Auth NO_AUTH = new Auth(AUTH_NONE, null, null, null);

    /**
     * Die SPEISER-BINDUNG einer Batterie (P6): wozu sie in dieser Anlage
     * gehört, und - beim Speiser - an WELCHEM Wechselrichter sie hängt.
     *
     * @param mode einer aus {@link #BINDING_MODES}
     * @param inverterEntityId die Entität des Hybrid-Wechselrichters; nur bei
     *     {@link #BINDING_FEEDS_INVERTER} gesetzt und dort PFLICHT - „hängt an
     *     irgendeinem" wäre keine ausdrückliche Bindung
     */
    public record Binding(String mode, String inverterEntityId) {

        /** Speist diese Batterie den Speicher-Knoten überhaupt? */
        public boolean feedsStorage() {
            return BINDING_FEEDS_INVERTER.equals(mode) || BINDING_STANDALONE.equals(mode);
        }

        /** Liefert sie AUCH die Leistung (nur der eigenständige Fall)? */
        public boolean suppliesPower() {
            return BINDING_STANDALONE.equals(mode);
        }
    }

    /** Die Vorgabe: ungebunden - nichts geschieht von selbst (E6). */
    public static final Binding UNBOUND = new Binding(BINDING_UNBOUND, null);

    /**
     * WELCHE Kanäle diese Bindung in den Speicher-Knoten einspeist - die EINE
     * Wahrheit, aus der die Rollen-Zuordnungen entstehen und gegen die sie beim
     * Ändern wieder aufgeräumt werden.
     *
     * <p>Nur Kanäle, die diese Batterie WIRKLICH liefert, stehen darin: eine
     * Rolle für einen Kanal zu schreiben, den niemand meldet, verspräche einen
     * Messwert, den es nicht gibt.
     */
    public static List<String> boundChannels(Binding binding, Collection<String> available) {
        if (binding == null || !binding.feedsStorage()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String c : BOUND_CHANNELS) {
            if (available.contains(c)) {
                out.add(c);
            }
        }
        if (binding.suppliesPower() && available.contains(POWER_CHANNEL)) {
            out.add(POWER_CHANNEL);
        }
        return List.copyOf(out);
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

    /**
     * Der SCHUTZ-/GRENZBAUSTEIN (P5c) - Treppen, Riegel, Rundung, Haltefrist.
     *
     * <p>Beide Hälften sind OPTIONAL und unabhängig: eine Richtung ohne Treppe
     * hat keine Strom-Grenze (der Riegel spricht trotzdem), ein Riegel ohne
     * Treppe schützt trotzdem. Nur BEIDES wegzulassen wird abgelehnt - ein
     * Schutzbaustein, der nichts prüft, wäre eine Zusage ohne Wirkung.
     *
     * @param inputs Rolle → Kanalname, nach der Prüfung immer VOLLSTÄNDIG
     *     gefüllt
     * @param template die VORLAGE, aus der Treppen und Schwellen kommen, wenn
     *     keine eigenen dastehen
     */
    public record Protection(ProtectionDirection charge, ProtectionDirection discharge,
            Hysteresis hysteresis, Map<String, String> inputs, double roundA, int holdS,
            String template) {

        /** Sagt dieser Baustein über das LADEN überhaupt etwas? */
        public boolean speaksAboutCharge() {
            return charge != null || (hysteresis != null && hysteresis.chargeStopV() != null);
        }

        /** Und über das ENTLADEN? */
        public boolean speaksAboutDischarge() {
            return discharge != null
                    || (hysteresis != null && hysteresis.dischargeStopV() != null);
        }

        /**
         * Die Kanäle, die dieser Baustein WIRKLICH füllt.
         *
         * <p>Eine gesperrte Richtung meldet BEIDES (Freigabe = 0 UND Grenze =
         * 0), deshalb bringt schon ein Riegel den Grenz-Kanal seiner Richtung
         * mit - sonst hätte die Sperre keinen Platz, an dem sie steht.
         */
        public List<String> channels() {
            List<String> out = new ArrayList<>();
            if (speaksAboutCharge()) {
                out.add(CHARGE_LIMIT_CHANNEL);
            }
            if (speaksAboutDischarge()) {
                out.add(DISCHARGE_LIMIT_CHANNEL);
            }
            if (hysteresis != null && hysteresis.chargeStopV() != null) {
                out.add(CHARGE_ALLOWED_CHANNEL);
            }
            if (hysteresis != null && hysteresis.dischargeStopV() != null) {
                out.add(DISCHARGE_ALLOWED_CHANNEL);
            }
            return List.copyOf(out);
        }
    }

    /**
     * EINE Richtung des Schutzbausteins: die Strom-Treppe samt Geräte-Maximum.
     *
     * @param steps Stützpunkte {@code [Ladestand in %, Strom in A]}; „der
     *     letzte Stützpunkt mit Schwelle &le; SoC gewinnt"
     * @param maxA das GERÄTE-Maximum, auf das jedes Treppen-Ergebnis geklemmt
     *     wird - die halbe Aussage einer Treppe und deshalb Pflicht
     */
    public record ProtectionDirection(List<double[]> steps, double maxA) {
    }

    /**
     * Der ZELLSPANNUNGS-RIEGEL, in VOLT je Zelle.
     *
     * <p>Beide Richtungen sind einzeln optional; wo eine Schwelle steht, muss
     * auch ihre Geschwister-Schwelle stehen. Beim LADEN liegt die Freigabe
     * UNTER dem Stopp, beim ENTLADEN darüber - andersherum wäre es keine
     * Hysterese, sondern ein Riegel, der sich im Moment des Zuschiebens selbst
     * wieder öffnet.
     */
    public record Hysteresis(Double chargeStopV, Double chargeResumeV, Double dischargeStopV,
            Double dischargeResumeV) {
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

    /**
     * Das Ergebnis einer Prüfung: entweder Fehler, oder die normalisierte Form.
     *
     * <p>{@code transport} entscheidet, WELCHE Hälfte gefüllt ist: bei
     * {@link #TRANSPORT_MQTT} der {@code broker}, bei {@link #TRANSPORT_HTTP}
     * {@code endpoint} + {@code auth}. Beide Hälften gleichzeitig zu führen
     * wäre eine Anbindung mit zwei Adressen - genau die Doppeldeutigkeit, die
     * dieser Bausatz vermeidet.
     */
    public record Result(List<String> errors, String transport, Broker broker,
            Endpoint endpoint, Auth auth, List<NormalizedMapping> mappings,
            int publishIntervalS, SocDerivation socDerivation, Binding binding,
            Protection protection) {

        public boolean ok() {
            return errors.isEmpty();
        }

        /** Liest diese Batterie über ihre Web-Auskunft statt über MQTT? */
        public boolean http() {
            return TRANSPORT_HTTP.equals(transport);
        }

        /** Die Marke, mit der die Komponente gestempelt wird (die Box liest sie). */
        public String communication() {
            return http() ? COMMUNICATION_HTTP : COMMUNICATION;
        }

        /** Die Anmeldung, nie {@code null} - ohne Angabe „keine". */
        public Auth authOrNone() {
            return auth == null ? NO_AUTH : auth;
        }

        /**
         * Die Messkanäle, die diese Batterie WIRKLICH liefert - die
         * zugeordneten UND die aus ihnen abgeleiteten.
         *
         * <p>⚠ Der abgeleitete Ladestand gehört dazu, und aus demselben Grund,
         * aus dem die Liste sonst so knapp ist: rechnet eine Kennlinie ihn aus,
         * dann liefert diese Batterie {@code soc_pct} - er steht nur nicht in
         * der Zuordnung, weil ihn niemand sendet. Ohne ihn könnte die
         * Speiser-Bindung (P6) genau den Kanal nicht einspeisen, für den es sie
         * gibt.
         */
        public List<String> channels() {
            LinkedHashSet<String> out = new LinkedHashSet<>();
            mappings.forEach(m -> out.add(m.channel()));
            if (socDerivation != null) {
                out.add(SOC_CHANNEL);
                out.add(SOC_SOURCE_CHANNEL);
            }
            // Und seit P5c dasselbe für die Grenzen: rechnet der Schutzbaustein
            // sie aus, dann LIEFERT diese Batterie sie - sie stehen nur nicht
            // in der Zuordnung, weil sie niemand sendet. Ohne sie könnte die
            // Speiser-Bindung (P6) genau die Kanäle nicht einspeisen, für die
            // es diesen Baustein gibt, und der generierte Flow fiele bei der
            // Aktivierung durch (er fordert sie als `measure:` an).
            if (protection != null) {
                out.addAll(protection.channels());
            }
            return List.copyOf(out);
        }

        /** Die Bindung, nie {@code null} - ohne Angabe die ungebundene Vorgabe. */
        public Binding bindingOrUnbound() {
            return binding == null ? UNBOUND : binding;
        }

        /** Die Kanäle, die diese Batterie in den Speicher-Knoten einspeist (P6). */
        public List<String> boundChannels() {
            return UserDefinedBatteryDefinition.boundChannels(bindingOrUnbound(), channels());
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
        return validate(broker, mappings, publishIntervalS, soc, allowedChannels, null);
    }

    /**
     * Dieselbe Prüfung samt der SPEISER-BINDUNG (P6).
     *
     * @param binding wozu diese Batterie in der Anlage gehört; {@code null} =
     *     ungebunden. Ob der genannte Wechselrichter EXISTIERT, entscheidet der
     *     {@link UserDefinedBatteryService} - das ist eine Frage an die
     *     Datenbank, und diese Klasse bleibt rein.
     */
    public static Result validate(Broker broker, List<Mapping> mappings, Integer publishIntervalS,
            SocDerivation soc, Map<String, String> allowedChannels, Binding binding) {
        return validate(TRANSPORT_MQTT, broker, null, null, mappings, publishIntervalS, soc,
                allowedChannels, binding);
    }

    /**
     * Dieselbe Prüfung ohne den SCHUTZ-/GRENZBAUSTEIN (P5c) - der Weg, den jede
     * Batterie ohne einen solchen Block geht.
     */
    public static Result validate(String transport, Broker broker, Endpoint endpoint, Auth auth,
            List<Mapping> mappings, Integer publishIntervalS, SocDerivation soc,
            Map<String, String> allowedChannels, Binding binding) {
        return validate(transport, broker, endpoint, auth, mappings, publishIntervalS, soc,
                allowedChannels, binding, null);
    }

    /**
     * Dieselbe Prüfung für BEIDE Ebene-1-Transporte (P5-HTTP).
     *
     * <p><b>Was sich zwischen ihnen unterscheidet und was nicht.</b> Alles
     * hinter der Zuordnung ist IDENTISCH - dieselben Ziel-Kanäle, dieselben
     * Aggregate, dieselbe Ehrlichkeitsregel, dieselbe SoC-Ableitung (P5b),
     * dieselbe Speiser-Bindung (P6). Verschieden ist nur, WOHER der Rohwert
     * kommt:
     *
     * <ul>
     *   <li><b>MQTT</b>: ein Broker plus je Zuordnung ein Topic-FILTER und eine
     *       Haltbarkeit ({@code stale_s}) - viele Nachrichten, je eine
     *       Quelle.</li>
     *   <li><b>HTTP</b>: ein Endpunkt plus je Zuordnung ein WERTEPFAD, der den
     *       Platzhalter {@code *} tragen darf ({@code cells.*.v}) - EIN Dokument,
     *       und das Aggregat lebt darin. Eine Haltbarkeit gibt es nicht: eine
     *       Antwort ist EIN Zeitpunkt, und was sie nicht enthält, fehlt. Ein
     *       {@code stale_s} wäre die stille Erlaubnis, einen alten Messwert mit
     *       frischem Zeitstempel zu senden.</li>
     * </ul>
     *
     * @param transport {@link #TRANSPORT_MQTT} oder {@link #TRANSPORT_HTTP}
     * @param endpoint nur beim HTTP-Transport; dort Pflicht
     * @param auth nur beim HTTP-Transport; {@code null} = keine Anmeldung
     */
    public static Result validate(String transport, Broker broker, Endpoint endpoint, Auth auth,
            List<Mapping> mappings, Integer publishIntervalS, SocDerivation soc,
            Map<String, String> allowedChannels, Binding binding, Protection protection) {
        List<String> errors = new ArrayList<>();
        String kind = transport == null || transport.isBlank() ? TRANSPORT_MQTT
                : transport.trim().toLowerCase(Locale.ROOT);
        if (!TRANSPORTS.contains(kind)) {
            // Ein Wort außerhalb des Vokabulars wird VERWORFEN, nie geraten -
            // ein stillschweigend als MQTT gelesener Anschluss würde einen
            // Broker abonnieren, den der Kunde nie genannt hat.
            errors.add("„" + transport + "“ ist keine bekannte Anschlussart für diese Batterie.");
            return new Result(List.copyOf(errors), null, broker, endpoint, auth, List.of(),
                    DEFAULT_PUBLISH_INTERVAL_S, null, UNBOUND, null);
        }
        boolean http = TRANSPORT_HTTP.equals(kind);
        Auth checkedAuth = null;
        if (http) {
            checkEndpoint(endpoint, errors);
            checkedAuth = checkAuth(auth, errors);
        } else {
            checkBroker(broker, errors);
        }

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
            NormalizedMapping n = http ? checkHttpMapping(m, i, taken, allowed, errors)
                    : checkMapping(m, i, taken, allowed, errors);
            if (n != null) {
                out.add(n);
            }
        }

        SocDerivation derivation = checkSoc(soc, taken, allowed, errors);
        Protection guard = checkProtection(protection, taken, derivation, allowed, errors);
        // Die Bindung sieht seit P5c AUCH die Kanäle des Schutzbausteins: eine
        // Batterie, die nur Grenzen und Freigaben liefert, kann den
        // Speicher-Knoten sehr wohl speisen - ihre Hülle ist genau das, was er
        // von ihr braucht.
        Set<String> supplied = new LinkedHashSet<>(taken);
        if (guard != null) {
            supplied.addAll(guard.channels());
        }
        Binding bound = checkBinding(binding, supplied, derivation != null, errors);
        return new Result(List.copyOf(errors), kind, http ? null : broker,
                http ? endpoint : null, http ? checkedAuth : null, List.copyOf(out), interval,
                derivation, bound, guard);
    }

    /**
     * Prüft die SPEISER-BINDUNG (P6, Captain-Entscheid E6 (a)).
     *
     * <p><b>Die Regeln, und warum es sie gibt:</b>
     *
     * <ul>
     *   <li><b>Ein unbekanntes Wort wird VERWORFEN, nie geraten</b> - die
     *       Hausregel über geschlossene Vokabulare. Eine stillschweigend als
     *       „ungebunden" gelesene Bindung wäre der schlimmste Ausgang: der Kunde
     *       hätte sie ausgesprochen und die Anlage täte, als habe er
     *       geschwiegen.</li>
     *   <li><b>Ein Speiser braucht seinen Wechselrichter.</b> „Hängt an
     *       irgendeinem" ist keine ausdrückliche Bindung, und die Anzeige
     *       „Ladestand von: …" hätte kein Gegenüber.</li>
     *   <li><b>Eine Bindung ohne einzuspeisenden Kanal wird abgelehnt.</b> Wer
     *       nur Zellspannungen abbildet und weder Ladestand noch Grenzen
     *       liefert, kann den Speicher-Knoten nicht speisen - die Bindung
     *       anzunehmen hiesse, eine Wirkung zu versprechen, die ausbleibt.</li>
     * </ul>
     */
    private static Binding checkBinding(Binding binding, Set<String> taken, boolean derivesSoc,
            List<String> errors) {
        if (binding == null || binding.mode() == null || binding.mode().isBlank()) {
            return UNBOUND;
        }
        String mode = binding.mode().trim();
        if (!BINDING_MODES.contains(mode)) {
            errors.add("„" + mode + "“ ist keine bekannte Zuordnung für diese Batterie. "
                    + "Möglich sind: " + BINDING_UNBOUND + ", " + BINDING_FEEDS_INVERTER + ", "
                    + BINDING_STANDALONE + ".");
            return null;
        }
        String inverter = binding.inverterEntityId() == null ? ""
                : binding.inverterEntityId().trim();
        if (BINDING_UNBOUND.equals(mode)) {
            return UNBOUND;
        }
        if (BINDING_FEEDS_INVERTER.equals(mode) && inverter.isEmpty()) {
            errors.add("Bitte wählen Sie den Wechselrichter, an dem diese Batterie hängt - "
                    + "ohne ihn bleibt offen, wessen Ladestand sie liefert.");
            return null;
        }
        LinkedHashSet<String> available = new LinkedHashSet<>(taken);
        if (derivesSoc) {
            available.add(SOC_CHANNEL);
        }
        Binding out = new Binding(mode,
                BINDING_FEEDS_INVERTER.equals(mode) ? inverter : null);
        if (boundChannels(out, available).isEmpty()) {
            errors.add("Diese Batterie kann den Speicher noch nicht speisen: dafür braucht sie "
                    + "einen Ladestand oder wenigstens eine Grenze bzw. Freigabe. Ordnen Sie "
                    + "einen dieser Messwerte zu - oder lassen Sie die Batterie für sich stehen.");
            return null;
        }
        return out;
    }

    /**
     * Prüft den ENDPUNKT der Web-Auskunft (P5-HTTP).
     *
     * <p><b>Dieselbe LAN-Regel wie überall</b> ({@link
     * SelfBuildDefinition#isPrivateHost}) - ohne sie wäre dieser Anschluss ein
     * Weg, die Box mit einem Kunden-Zugangsschlüssel gegen einen fremden Server
     * im Internet zu richten.
     *
     * <p><b>Und der PFAD ist ein Pfad, keine zweite Adresse.</b> Er beginnt mit
     * „/“, trägt keinen Leerraum und darf nicht mit „//“ beginnen: „//host/x“
     * wäre eine protokoll-relative URL und damit ein anderes Ziel als das
     * geprüfte.
     */
    private static void checkEndpoint(Endpoint e, List<String> errors) {
        String host = e == null || e.host() == null ? "" : e.host().trim();
        if (host.isEmpty()) {
            errors.add("Bitte tragen Sie die Adresse ein, unter der die Web-Auskunft Ihres "
                    + "BMS erreichbar ist.");
        } else if (!SelfBuildDefinition.isPrivateHost(host)) {
            errors.add(SelfBuildDefinition.HOST_NOT_PRIVATE);
        }
        if (e == null) {
            errors.add("Bitte tragen Sie den Pfad der JSON-Auskunft ein, zum Beispiel /ha.");
            return;
        }
        if (e.port() != null && (e.port() < 1 || e.port() > 65535)) {
            errors.add("Der Port muss zwischen 1 und 65535 liegen.");
        }
        String path = e.path() == null ? "" : e.path().trim();
        if (path.isEmpty()) {
            errors.add("Bitte tragen Sie den Pfad der JSON-Auskunft ein, zum Beispiel /ha.");
        } else if (!isValidUrlPath(path)) {
            errors.add("„" + path + "“ ist kein gültiger Pfad. Er beginnt mit „/“ und enthält "
                    + "keine Leerzeichen - zum Beispiel /ha oder /api/status?filter=soc.");
        }
        if (e.timeoutMs() != null
                && (e.timeoutMs() < MIN_TIMEOUT_MS || e.timeoutMs() > MAX_TIMEOUT_MS)) {
            errors.add("Die Zeitgrenze muss zwischen " + MIN_TIMEOUT_MS + " und " + MAX_TIMEOUT_MS
                    + " Millisekunden liegen.");
        }
    }

    /**
     * Prüft die ANMELDUNG (P5-HTTP).
     *
     * <p><b>Das Geheimnis wird hier NICHT verlangt</b>, und das ist Absicht:
     * beim Ändern schickt das Portal die Maske oder gar nichts, und der Server
     * setzt den gespeicherten Wert wieder ein
     * ({@link UserDefinedBatteryService}). Was hier geprüft wird, ist die FORM -
     * die Art, der Name der Kopfzeile, der Benutzername.
     *
     * <p>Der Kopfzeilen-NAME ist ein RFC-7230-Token: alles andere wäre eine
     * Einladung, über einen Zeilenumbruch eine zweite Kopfzeile
     * einzuschmuggeln.
     */
    private static Auth checkAuth(Auth auth, List<String> errors) {
        Auth a = auth == null ? NO_AUTH : auth;
        String mode = a.effectiveMode();
        if (!AUTH_MODES.contains(mode)) {
            errors.add("Diese Art der Anmeldung kennen wir nicht.");
            return null;
        }
        String header = a.header() == null ? "" : a.header().trim();
        String user = a.username() == null ? "" : a.username().trim();
        if (AUTH_HEADER.equals(mode)) {
            if (header.isEmpty()) {
                errors.add("Bitte tragen Sie den Namen der Kopfzeile ein, in der der Schlüssel "
                        + "erwartet wird - beim DIYBMS zum Beispiel „ApiKey“.");
                return null;
            }
            if (!HEADER_NAME.matcher(header).matches()) {
                errors.add("„" + header + "“ ist kein gültiger Name für eine Kopfzeile.");
                return null;
            }
        }
        if (AUTH_BASIC.equals(mode)) {
            if (user.isEmpty() || user.length() > 64 || user.contains(":")
                    || user.chars().anyMatch(Character::isWhitespace)) {
                errors.add("Bitte tragen Sie den Benutzernamen ein, mit dem sich VoltPilot "
                        + "anmelden soll.");
                return null;
            }
        }
        String secret = a.secret() == null ? null : a.secret();
        return new Auth(mode, AUTH_HEADER.equals(mode) ? header : null,
                AUTH_BASIC.equals(mode) ? user : null, secret);
    }

    /** Ein URL-Pfad: mit „/“ beginnend, ohne Leerraum, nie protokoll-relativ. */
    public static boolean isValidUrlPath(String path) {
        if (path == null || path.isEmpty() || path.length() > MAX_URL_PATH_LENGTH) {
            return false;
        }
        if (path.charAt(0) != '/' || path.startsWith("//")) {
            return false;
        }
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (Character.isWhitespace(c) || c < 0x20 || c == '\\' || c == '<' || c == '>'
                    || c == '"' || c == '\'' || c == '`') {
                return false;
            }
        }
        return true;
    }

    /**
     * Ein WERTEPFAD des HTTP-Lesetyps: punkt-getrennt, mit dem Platzhalter
     * {@code *} als GANZEM Segment.
     *
     * <p>⚠ Er darf - anders als beim MQTT-Lesetyp - nicht LEER sein. Bei MQTT
     * heißt ein leerer Pfad „die Nachricht IST der Wert" (der häufigste
     * MQTT-Fall: ein Topic, eine nackte Zahl); eine HTTP-Antwort ist dagegen ein
     * Dokument, und ein leerer Pfad wäre die Aufforderung, es als Zahl zu lesen.
     *
     * <p>Der Platzhalter ist das Gegenstück zum Topic-Filter: {@code cells.*.v}
     * trifft jede Zelle einer Liste, so wie {@code emon/diybms/+/+} jedes
     * Zell-Topic trifft - und erst dadurch bekommt {@code min}/{@code max} an
     * einem HTTP-Anschluss überhaupt eine Bedeutung.
     */
    public static boolean isValidHttpValuePath(String path) {
        if (path == null || path.isEmpty() || path.length() > MAX_PATH_LENGTH) {
            return false;
        }
        for (String segment : path.split("\\.", -1)) {
            if (!VALUE_PATH_SEGMENT.matcher(segment).matches()
                    || FORBIDDEN_SEGMENTS.contains(segment)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Eine Feld-Zuordnung des HTTP-Lesetyps.
     *
     * <p>Sie ist die MQTT-Prüfung Zeile für Zeile - dieselben Ziel-Kanäle,
     * dieselben Aggregate, dieselbe Wahrheitswert-Regel, dieselbe
     * Skalierungs-Regel - mit genau zwei Unterschieden: statt eines Topic-
     * Filters steht ein Wertepfad (der pflicht ist), und es gibt keine
     * Haltbarkeit.
     */
    private static NormalizedMapping checkHttpMapping(Mapping m, int index, Set<String> taken,
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

        String path = m.path() == null ? "" : m.path().trim();
        if (path.isEmpty()) {
            errors.add(where + ": bitte tragen Sie ein, wo der Wert in der Antwort steht - "
                    + "zum Beispiel soc oder bms.soc; „*“ steht für jede Ebene.");
            return null;
        }
        if (!isValidHttpValuePath(path)) {
            errors.add(where + ": „" + path + "“ ist kein gültiger Wertepfad. Beispiele: soc, "
                    + "bms.soc, cells.*.v.");
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
        if ("bool".equals(valueType) && !BOOL_AGGREGATES.contains(aggregate)) {
            errors.add(where + ": ein Ja/Nein-Wert lässt sich so nicht zusammenfassen. "
                    + "Möglich sind: letzter Wert, min (alle erlauben es) und max "
                    + "(mindestens einer erlaubt es).");
            return null;
        }
        if ("bool".equals(valueType) && (scale != 1.0 || offset != 0.0)) {
            errors.add(where + ": ein Ja/Nein-Wert kennt keine Skalierung - er reist als 0 "
                    + "oder 1.");
            return null;
        }
        // topic und staleS bleiben leer: dieser Lesetyp hat weder ein Topic
        // noch eine Haltbarkeit, und ein gefüllter Vorgabewert wäre ein Feld,
        // das etwas verspricht, was nirgends stattfindet.
        return new NormalizedMapping(channel, allowed.get(channel), "", path, aggregate,
                valueType, scale, offset, m.sentinel(), 0,
                words(m.trueValues()), words(m.falseValues()));
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

    /**
     * Prüft den SCHUTZ-/GRENZBAUSTEIN (P5c).
     *
     * <p><b>Die Regeln, und warum es sie gibt:</b>
     *
     * <ul>
     *   <li><b>Ein Baustein ohne Treppe UND ohne Riegel wird abgelehnt.</b> Er
     *       prüfte nichts, veröffentlichte nichts und stünde trotzdem als
     *       „Schutz" im Formular - eine Zusage ohne Wirkung ist schlimmer als
     *       keine.</li>
     *   <li><b>Ein Kanal hat genau EINEN Autor.</b> Wer {@code charge_limit_a}
     *       schon aus seinem BMS ZUORDNET, bekommt ihn nicht zusätzlich
     *       gerechnet: zwei Schreiber auf einem Kanal ergeben eine Historie, in
     *       der die Zustellreihenfolge entscheidet, welche Grenze galt. Der
     *       Kunde wählt - Zuordnung oder Baustein.</li>
     *   <li><b>Eine Treppe braucht den LADESTAND.</b> Ohne Ableitung und ohne
     *       zugeordneten {@code soc_pct} rechnet sie nie etwas aus; sie
     *       anzunehmen hiesse, eine Grenze zu versprechen, die ausbleibt. Der
     *       RIEGEL braucht ihn ausdrücklich NICHT - ein Hartstopp steht auf der
     *       Zellspannung allein.</li>
     *   <li><b>Ein Riegel braucht seine Zellspannung.</b> Wer den Lade-Riegel
     *       setzt, muss {@code cell_max_mv} liefern, wer den Entlade-Riegel
     *       setzt, {@code cell_min_mv} - dieselbe „kein Ergebnis ohne
     *       Eingang"-Regel wie bei der SoC-Ableitung.</li>
     *   <li><b>Die Freigabe liegt beim Laden UNTER dem Stopp</b> und beim
     *       Entladen darüber. Andersherum wäre es keine Hysterese, sondern ein
     *       Riegel, der sich im Moment des Zuschiebens selbst wieder öffnet.</li>
     * </ul>
     *
     * @param mappedChannels die Kanäle, die die Zuordnung wirklich liefert
     * @param soc die geprüfte SoC-Ableitung ({@code null} = es gibt keinen
     *     Ladestand)
     */
    private static Protection checkProtection(Protection p, Set<String> mappedChannels,
            SocDerivation soc, Map<String, String> allowed, List<String> errors) {
        if (p == null) {
            return null;
        }
        int before = errors.size();

        ProtectionDirection charge = checkDirection(p.charge(), "Die Ladegrenze", errors);
        ProtectionDirection discharge = checkDirection(p.discharge(), "Die Entladegrenze",
                errors);
        Hysteresis hysteresis = checkHysteresis(p.hysteresis(), errors);
        Map<String, String> inputs = protectionInputs(p, allowed, errors);
        double round = p.roundA() <= 0 ? DEFAULT_ROUND_A : p.roundA();
        if (round <= 0 || round > MAX_ROUND_A) {
            errors.add("Das Rundungsraster der Ströme muss größer als 0 und höchstens "
                    + MAX_ROUND_A + " Ampere sein.");
        }
        int holdS = p.holdS() <= 0 ? DEFAULT_HOLD_S : p.holdS();
        if (holdS < MIN_HOLD_S || holdS > MAX_HOLD_S) {
            errors.add("Die Haltefrist des Schutzbausteins muss zwischen " + MIN_HOLD_S + " und "
                    + MAX_HOLD_S + " Sekunden liegen.");
        }
        if (errors.size() != before || inputs == null) {
            return null;
        }

        boolean hasCharge = hysteresis != null && hysteresis.chargeStopV() != null;
        boolean hasDischarge = hysteresis != null && hysteresis.dischargeStopV() != null;
        if (charge == null && discharge == null && !hasCharge && !hasDischarge) {
            errors.add("Dieser Schutz prüft nichts. Tragen Sie eine Strom-Treppe ein oder "
                    + "legen Sie eine Zellspannungs-Grenze fest.");
            return null;
        }

        Protection checked = new Protection(charge, discharge, hysteresis, inputs, round, holdS,
                p.template() == null || p.template().isBlank() ? null : p.template().trim());

        // Ein Kanal hat genau EINEN Autor.
        for (String channel : checked.channels()) {
            if (mappedChannels.contains(channel)) {
                errors.add("„" + channel + "“ wird schon aus Ihrer Quelle gelesen und kann "
                        + "nicht zusätzlich berechnet werden. Entfernen Sie entweder die "
                        + "Zuordnung oder diesen Teil des Schutzes - ein Messwert hat genau "
                        + "eine Quelle.");
                return null;
            }
        }

        // Eine Treppe ohne Ladestand rechnet nie.
        boolean hasSoc = soc != null || mappedChannels.contains(inputs.get("soc"));
        if ((charge != null || discharge != null) && !hasSoc) {
            errors.add("Die Strom-Treppe braucht einen Ladestand. Ordnen Sie „"
                    + inputs.get("soc") + "“ zu oder lassen Sie ihn berechnen - eine Treppe "
                    + "ohne Ladestand ergibt nie eine Grenze.");
            return null;
        }
        if (hasCharge && !mappedChannels.contains(inputs.get("cell_max"))) {
            errors.add("Die Lade-Abschaltung braucht die höchste Zellspannung („"
                    + inputs.get("cell_max") + "“) - ohne sie kann VoltPilot sie nie auslösen.");
            return null;
        }
        if (hasDischarge && !mappedChannels.contains(inputs.get("cell_min"))) {
            errors.add("Die Entlade-Abschaltung braucht die niedrigste Zellspannung („"
                    + inputs.get("cell_min") + "“) - ohne sie kann VoltPilot sie nie auslösen.");
            return null;
        }
        return checked;
    }

    /**
     * Eine Strom-Treppe: 1 bis {@value #MAX_STEPS} Stufen
     * {@code [Ladestand in %, Strom in A]}, plus das Geräte-Maximum.
     *
     * <p>⚠ Anders als eine OCV-Kennlinie darf eine Treppe FALLEN (die Ladekurve
     * des Kunden geht von 270 A auf 22 A) und ebenso STEIGEN (seine
     * Entladekurve von 74 A auf 342 A). Es gibt hier deshalb bewusst KEINE
     * Monotonie-Regel - verboten ist nur die doppelte Schwelle, die zweideutig
     * wäre.
     *
     * <p>Öffentlich, weil {@code ProtectionProfileCatalog} die ausgelieferten
     * VORLAGEN durch exakt dieselbe Prüfung schickt.
     */
    public static ProtectionDirection checkDirection(ProtectionDirection dir, String what,
            List<String> errors) {
        if (dir == null) {
            return null;
        }
        List<double[]> raw = dir.steps();
        if (raw == null || raw.size() < MIN_STEPS || raw.size() > MAX_STEPS) {
            errors.add(what + " braucht " + MIN_STEPS + " bis " + MAX_STEPS + " Stufen.");
            return null;
        }
        List<double[]> out = new ArrayList<>();
        for (double[] step : raw) {
            if (step == null || step.length < 2) {
                errors.add(what + ": eine Stufe braucht Ladestand und Strom.");
                return null;
            }
            double pct = step[0];
            double amps = step[1];
            if (!Double.isFinite(pct) || pct < 0 || pct > 100) {
                errors.add(what + ": der Ladestand " + pct + " % liegt außerhalb von 0 bis 100.");
                return null;
            }
            if (!Double.isFinite(amps) || amps < 0 || amps > MAX_CURRENT_A) {
                errors.add(what + ": der Strom " + amps + " A liegt außerhalb von 0 bis "
                        + MAX_CURRENT_A + " A.");
                return null;
            }
            out.add(new double[] {pct, amps});
        }
        out.sort((a, b) -> Double.compare(a[0], b[0]));
        for (int i = 1; i < out.size(); i++) {
            if (out.get(i)[0] == out.get(i - 1)[0]) {
                errors.add(what + ": der Ladestand " + out.get(i)[0]
                        + " % steht zweimal in der Tabelle.");
                return null;
            }
        }
        double maxA = dir.maxA();
        if (!Double.isFinite(maxA) || maxA < 0 || maxA > MAX_CURRENT_A) {
            errors.add(what + " braucht ein Geräte-Maximum zwischen 0 und " + MAX_CURRENT_A
                    + " A - ohne es wäre die Treppe nur die halbe Aussage.");
            return null;
        }
        return new ProtectionDirection(List.copyOf(out), maxA);
    }

    /** Der Zellspannungs-Riegel; öffentlich aus demselben Grund wie oben. */
    public static Hysteresis checkHysteresis(Hysteresis h, List<String> errors) {
        if (h == null) {
            return null;
        }
        Double cs = h.chargeStopV();
        Double cr = h.chargeResumeV();
        Double ds = h.dischargeStopV();
        Double dr = h.dischargeResumeV();
        if ((cs == null) != (cr == null)) {
            errors.add("Die Lade-Abschaltung braucht BEIDE Spannungen: die, bei der sie "
                    + "abschaltet, und die, bei der sie wieder freigibt.");
            return null;
        }
        if ((ds == null) != (dr == null)) {
            errors.add("Die Entlade-Abschaltung braucht BEIDE Spannungen: die, bei der sie "
                    + "abschaltet, und die, bei der sie wieder freigibt.");
            return null;
        }
        if (cs == null && ds == null) {
            return null;
        }
        if (cs != null) {
            if (!inCellRange(cs) || !inCellRange(cr)) {
                errors.add("Die Lade-Abschaltung muss zwischen " + MIN_CELL_V + " und "
                        + MAX_CELL_V + " V je Zelle liegen.");
                return null;
            }
            if (!(cr < cs)) {
                errors.add("Die Lade-Freigabe muss UNTER der Lade-Abschaltung liegen - sonst "
                        + "gibt der Schutz im selben Moment wieder frei, in dem er abschaltet.");
                return null;
            }
        }
        if (ds != null) {
            if (!inCellRange(ds) || !inCellRange(dr)) {
                errors.add("Die Entlade-Abschaltung muss zwischen " + MIN_CELL_V + " und "
                        + MAX_CELL_V + " V je Zelle liegen.");
                return null;
            }
            if (!(dr > ds)) {
                errors.add("Die Entlade-Freigabe muss ÜBER der Entlade-Abschaltung liegen - "
                        + "sonst gibt der Schutz im selben Moment wieder frei, in dem er "
                        + "abschaltet.");
                return null;
            }
        }
        return new Hysteresis(cs, cr, ds, dr);
    }

    private static boolean inCellRange(Double v) {
        return v != null && Double.isFinite(v) && v >= MIN_CELL_V && v <= MAX_CELL_V;
    }

    /**
     * Rolle → Kanal für den Schutzbaustein, vollständig gefüllt. Ein Kanal
     * außerhalb des Typkatalogs wird VERWORFEN, nie geraten.
     */
    private static Map<String, String> protectionInputs(Protection p,
            Map<String, String> allowed, List<String> errors) {
        Map<String, String> raw = p.inputs() == null ? Map.of() : p.inputs();
        Map<String, String> out = new LinkedHashMap<>();
        boolean ok = true;
        for (Map.Entry<String, String> role : new java.util.TreeMap<>(PROTECTION_INPUT_DEFAULTS)
                .entrySet()) {
            String named = raw.get(role.getKey());
            String channel = named == null || named.isBlank() ? role.getValue() : named.trim();
            if (!allowed.containsKey(channel)) {
                errors.add("Der Eingang „" + role.getKey() + "“ des Schutzes zeigt auf „"
                        + channel + "“ - das ist kein Batterie-Messwert.");
                ok = false;
                continue;
            }
            out.put(role.getKey(), channel);
        }
        return ok ? Map.copyOf(out) : null;
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
