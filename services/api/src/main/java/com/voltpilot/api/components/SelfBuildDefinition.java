package com.voltpilot.api.components;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Die REGELN der Selbstbau-Tür (Einheitsmodell Stufe 3, Konzept
 * vp-modbus-baukasten-k6 §2.3/§2.6) - rein, ohne Datenbank, ohne Spring, ohne
 * Uhr.
 *
 * <p>Sie liegt aus demselben Grund hier wie {@code Tagesprotokoll},
 * {@code FleetPflege} und {@code SlotEconomics}: was ein Kunde eintippen darf,
 * ist eine Aussage über Sicherheit und Ehrlichkeit, und die gehört an einen
 * Ort, an dem sie ohne Docker vollständig geprüft werden kann.
 *
 * <p><b>Die vier Regelgruppen und warum es sie gibt:</b>
 *
 * <ul>
 *   <li><b>LAN-only</b> ({@link #isPrivateHost}) - der Zwilling der
 *       Box-Regel {@code edge-app/core/internal/probe.IsPrivateHost}, Form für
 *       Form. Ohne sie wäre der Baukasten ein Portscanner, den ein
 *       Portal-Fehler aufs offene Internet richten könnte. <b>Die Box prüft
 *       unabhängig noch einmal</b> - sie glaubt der Cloud nichts (die
 *       OTA-Sidecar-Disziplin); diese Kopie fängt den Tippfehler dort ab, wo er
 *       entsteht, statt ihn eine Broker-Runde später zu melden.</li>
 *   <li><b>Poll-Budget</b> (§2.6) - höchstens {@link #MAX_CHANNELS} Kanäle je
 *       Gerät, Mindestabstand ≥ {@link #MIN_INTERVAL_S} s. Am anderen Ende
 *       hängt ein echtes Modbus-Gerät; viele Kundengeräte bedienen genau einen
 *       TCP-Client und steigen unter Last aus.</li>
 *   <li><b>Kanal-Form</b> - Klartext-Name, Einheit, Register, Datentyp,
 *       Skalierung. Der {@code slug} wird ABGELEITET, nie getippt: der Kunde
 *       benennt einen Messwert, keine Kennung.</li>
 *   <li><b>Plausibilität</b> ({@link #hints}) - <b>Hinweise, keine Sperren</b>.
 *       Ein Register, das wir für unplausibel halten, kann am echten Gerät
 *       richtig sein; wir wissen es nicht besser als das Handbuch, das der
 *       Kunde vor sich liegen hat.</li>
 * </ul>
 */
public final class SelfBuildDefinition {

    /** Die Anbindungs-Art, die eine Selbstbau-Komponente trägt. */
    public static final String COMMUNICATION = "modbus_baukasten";

    /** Die Herkunft, mit der eine Selbstbau-Komponente gestempelt wird. */
    public static final String SOURCE_KIND = "custom";

    /** Der Entitätstyp einer nur messenden Selbstbau-Komponente. */
    public static final String ENTITY_TYPE = "modbus-generic";

    /** Höchstens so viele Kanäle je Gerät (§2.6). */
    public static final int MAX_CHANNELS = 16;

    /** Der kleinste erlaubte Abstand zwischen zwei Lesungen EINES Kanals (§2.6). */
    public static final int MIN_INTERVAL_S = 5;

    /** Die Vorgabe, mit der der Assistent eine neue Kanal-Zeile anlegt (§2.3). */
    public static final int DEFAULT_INTERVAL_S = 10;

    /** Obergrenze, damit ein Abstand nicht faktisch „nie“ bedeutet. */
    public static final int MAX_INTERVAL_S = 3600;

    private static final Set<String> REGISTER_KINDS = Set.of("holding", "input");
    private static final Set<String> DATA_TYPES = Set.of("u16", "s16", "u32", "s32", "float32");
    private static final Set<String> WORD_ORDERS = Set.of("big", "little");

    /**
     * Die Einheiten, die der Assistent anbietet (§2.2 „kuratierte Auswahl“).
     * Der leere String bedeutet ausdrücklich „ohne Einheit“ - eine Zahl ohne
     * Einheit ist eine ehrliche Angabe, eine erfundene Einheit nicht.
     */
    public static final List<String> UNITS =
            List.of("", "kW", "W", "kWh", "°C", "%", "A", "V", "Hz", "bar", "l/min");

    /** Die LAN-Endungen, die ein Gerät im eigenen Netz wirklich beantwortet. */
    private static final List<String> LAN_SUFFIXES =
            List.of(".local", ".lan", ".home", ".home.arpa", ".internal", ".intern");

    private SelfBuildDefinition() {
    }

    /** Ein Kanal, wie ihn der Assistent schickt. */
    public record Channel(String label, String unit, String registerKind, Integer address,
            String dataType, String wordOrder, Double scale, Double offset,
            Integer minReadIntervalS) {

        /** Braucht dieser Datentyp zwei Register - und damit eine Wortreihenfolge? */
        public boolean isWide() {
            return "u32".equals(dataType) || "s32".equals(dataType) || "float32".equals(dataType);
        }

        int effectiveInterval() {
            return minReadIntervalS == null ? DEFAULT_INTERVAL_S : minReadIntervalS;
        }
    }

    /** Die Verbindung zum Gerät. */
    public record Transport(String host, Integer port, Integer unitId) {

        public int effectivePort() {
            return port == null ? 502 : port;
        }

        public int effectiveUnitId() {
            return unitId == null ? 1 : unitId;
        }
    }

    /**
     * Ein normalisierter Kanal: der Slug ist abgeleitet, alle Vorgaben sind
     * gefüllt. Das ist die Form, die gespeichert und in den Flow kompiliert
     * wird - danach rät niemand mehr an einer Vorgabe herum.
     */
    public record NormalizedChannel(String slug, String label, String unit, String registerKind,
            int address, String dataType, String wordOrder, double scale, double offset,
            int minReadIntervalS) {
    }

    /** Das Ergebnis einer Prüfung: entweder Fehler, oder die normalisierte Form. */
    public record Result(List<String> errors, Transport transport,
            List<NormalizedChannel> channels) {

        public boolean ok() {
            return errors.isEmpty();
        }

        /** Der schnellste Lese-Takt des Geräts - der Auslöser des Flows. */
        public int triggerIntervalS() {
            return channels.stream().mapToInt(NormalizedChannel::minReadIntervalS)
                    .min().orElse(DEFAULT_INTERVAL_S);
        }
    }

    /**
     * Prüft und normalisiert eine ganze Definition.
     *
     * <p>Es werden ALLE Fehler gesammelt statt beim ersten abzubrechen: ein
     * Formular, das seine Mängel einzeln nacheinander meldet, macht aus einem
     * Tippfehler drei Runden.
     */
    public static Result validate(Transport transport, List<Channel> channels) {
        List<String> errors = new ArrayList<>();
        checkTransport(transport, errors);

        List<Channel> list = channels == null ? List.of() : channels;
        if (list.isEmpty()) {
            errors.add("Bitte legen Sie mindestens einen Messwert an - ohne Messwert liest das "
                    + "Gerät nichts.");
        }
        if (list.size() > MAX_CHANNELS) {
            errors.add("Höchstens " + MAX_CHANNELS + " Messwerte je Gerät. Mehr Lesungen halten "
                    + "viele Geräte nicht aus.");
        }

        List<NormalizedChannel> out = new ArrayList<>();
        Set<String> slugs = new LinkedHashSet<>();
        Set<String> registerKeys = new LinkedHashSet<>();
        int i = 0;
        for (Channel c : list) {
            i++;
            NormalizedChannel n = checkChannel(c, i, slugs, errors);
            if (n == null) {
                continue;
            }
            // Zwei Kanäle auf demselben Register sind kein Fehler des Geräts,
            // aber zwei Namen für dieselbe Zahl - und im Flow zwei Lesungen
            // desselben Registers, also doppelte Last ohne Gegenwert.
            String key = n.registerKind() + ":" + n.address() + ":" + n.dataType();
            if (!registerKeys.add(key)) {
                errors.add("Messwert " + i + " („" + n.label() + "“) liest dasselbe Register wie "
                        + "ein Messwert davor. Bitte eine andere Adresse wählen.");
                continue;
            }
            out.add(n);
        }
        return new Result(List.copyOf(errors), transport, List.copyOf(out));
    }

    private static void checkTransport(Transport t, List<String> errors) {
        String host = t == null || t.host() == null ? "" : t.host().trim();
        if (host.isEmpty()) {
            errors.add("Bitte tragen Sie die Adresse des Geräts in Ihrem Netzwerk ein.");
        } else if (!isPrivateHost(host)) {
            errors.add(HOST_NOT_PRIVATE);
        }
        if (t != null && t.port() != null && (t.port() < 1 || t.port() > 65535)) {
            errors.add("Der Port muss zwischen 1 und 65535 liegen.");
        }
        if (t != null && t.unitId() != null && (t.unitId() < 0 || t.unitId() > 255)) {
            errors.add("Die Unit-ID muss zwischen 0 und 255 liegen.");
        }
    }

    /**
     * Der Satz zur LAN-Regel. Er nennt den WEG (die IP eintragen), statt nur
     * abzulehnen - ein nackter Name ist der häufigste Fall, und er ist nicht
     * falsch, nur nicht nachweisbar privat.
     */
    public static final String HOST_NOT_PRIVATE =
            "Diese Adresse liegt nicht nachweisbar in Ihrem eigenen Netzwerk. VoltPilot liest nur "
                    + "Geräte im Heimnetz - bitte tragen Sie die IP-Adresse des Geräts ein "
                    + "(z. B. 192.168.1.50).";

    private static NormalizedChannel checkChannel(Channel c, int index, Set<String> slugs,
            List<String> errors) {
        String where = "Messwert " + index;
        if (c == null) {
            errors.add(where + " ist leer.");
            return null;
        }
        String label = c.label() == null ? "" : c.label().trim();
        if (label.isEmpty()) {
            errors.add(where + ": bitte einen Namen vergeben (zum Beispiel „Wassertemperatur“).");
            return null;
        }
        if (label.length() > 80) {
            errors.add(where + ": der Name ist zu lang (höchstens 80 Zeichen).");
            return null;
        }

        String slug = slug(label, slugs);
        if (slug == null) {
            errors.add(where + " („" + label + "“): aus diesem Namen lässt sich keine Kennung "
                    + "bilden. Bitte Buchstaben oder Ziffern verwenden.");
            return null;
        }

        String unit = c.unit() == null ? "" : c.unit().trim();
        if (!UNITS.contains(unit)) {
            errors.add(where + ": diese Einheit kennen wir nicht.");
            return null;
        }

        String kind = c.registerKind() == null ? "holding" : c.registerKind().trim();
        if (!REGISTER_KINDS.contains(kind)) {
            errors.add(where + ": bitte Holding-Register (FC3) oder Input-Register (FC4) wählen.");
            return null;
        }
        if (c.address() == null || c.address() < 0 || c.address() > 65535) {
            errors.add(where + ": die Registeradresse muss zwischen 0 und 65535 liegen "
                    + "(0-basiert - 40001 aus dem Handbuch ist Adresse 0).");
            return null;
        }
        String type = c.dataType() == null ? "u16" : c.dataType().trim();
        if (!DATA_TYPES.contains(type)) {
            errors.add(where + ": diesen Datentyp kennen wir nicht.");
            return null;
        }
        String order = c.wordOrder() == null || c.wordOrder().isBlank() ? "big"
                : c.wordOrder().trim();
        if (!WORD_ORDERS.contains(order)) {
            errors.add(where + ": die Wortreihenfolge muss „big“ oder „little“ sein.");
            return null;
        }
        double scale = c.scale() == null ? 1.0 : c.scale();
        double offset = c.offset() == null ? 0.0 : c.offset();
        if (!Double.isFinite(scale) || scale == 0.0) {
            errors.add(where + ": die Skalierung muss eine Zahl ungleich 0 sein.");
            return null;
        }
        if (!Double.isFinite(offset)) {
            errors.add(where + ": der Offset muss eine Zahl sein.");
            return null;
        }
        int interval = c.effectiveInterval();
        if (interval < MIN_INTERVAL_S) {
            errors.add(where + ": der Mindestabstand muss mindestens " + MIN_INTERVAL_S
                    + " Sekunden betragen - häufigeres Lesen überfordert viele Geräte.");
            return null;
        }
        if (interval > MAX_INTERVAL_S) {
            errors.add(where + ": der Mindestabstand darf höchstens " + MAX_INTERVAL_S
                    + " Sekunden betragen.");
            return null;
        }
        slugs.add(slug);
        return new NormalizedChannel(slug, label, unit, kind, c.address(), type, order, scale,
                offset, interval);
    }

    /**
     * Leitet die Kennung eines Messwerts aus seinem Klartext-Namen ab.
     *
     * <p>Sie folgt dem OFFENEN Kanal-Vokabular der Registry
     * ({@code ^[a-z][a-z0-9_]{0,63}$}) - deshalb ist sie hier und nicht im
     * Portal: der Server ist der Zaun, und ein selbst getippter Kanalname wäre
     * eine zweite Wahrheit über denselben Messwert.
     *
     * <p>Ein Name, der schon vergeben ist, bekommt eine Zählung angehängt: zwei
     * Register dürfen legitim „Temperatur“ heißen, aber nie denselben Kanal
     * beschreiben.
     *
     * @return die Kennung, oder {@code null} wenn der Name keine hergibt
     */
    public static String slug(String label, Set<String> taken) {
        // ⚠ Die deutsche Umschrift läuft VOR der Zerlegung. Andersherum hat
        // NFD das „ä" längst in a + Trema zerlegt, die Ersetzung findet nichts
        // mehr, und der anschließende Marken-Strip macht aus „Zähler" ein
        // „zahler" - im Test genau so aufgefallen. Die Zerlegung danach ist
        // trotzdem nötig: sie räumt die übrigen Akzente (é, ñ) weg.
        String base = (label == null ? "" : label).toLowerCase(Locale.GERMAN)
                .replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss");
        base = Normalizer.normalize(base, Normalizer.Form.NFD)
                .replaceAll("\\p{M}+", "")
                .replaceAll("[^a-z0-9]+", "_")
                .replaceAll("^_+", "")
                .replaceAll("_+$", "");
        if (base.isEmpty()) {
            return null;
        }
        if (!Character.isLetter(base.charAt(0))) {
            base = "m_" + base;
        }
        if (base.length() > 64) {
            base = base.substring(0, 64).replaceAll("_+$", "");
        }
        if (taken == null || !taken.contains(base)) {
            return base;
        }
        for (int n = 2; n < 100; n++) {
            String suffix = "_" + n;
            String head = base.length() + suffix.length() > 64
                    ? base.substring(0, 64 - suffix.length()) : base;
            String candidate = head + suffix;
            if (!taken.contains(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Die Plausibilitäts-Hinweise zu einem gemessenen Wert (§2.3 „Sanity-
     * Hinweise statt Blockaden").
     *
     * <p>Sie sind der Moment, in dem ein Skalierungsfehler SICHTBAR wird - der
     * ganze Grund, warum die Live-Vorschau Roh- und skalierten Wert
     * nebeneinander zeigt. Es ist ausdrücklich eine BEOBACHTUNG, keine
     * Ablehnung: ein Register, das wir für unplausibel halten, kann am echten
     * Gerät richtig sein.
     *
     * @param unit die gewählte Einheit
     * @param value der SKALIERTE Wert, wie ihn das Gerät gerade geliefert hat
     * @return null wenn nichts auffällt
     */
    public static String hint(String unit, Double value) {
        if (value == null || !Double.isFinite(value)) {
            return null;
        }
        double v = value;
        if ("%".equals(unit) && (v < 0 || v > 100)) {
            return "Ein Prozentwert außerhalb 0-100 sieht nach einer falschen Skalierung aus.";
        }
        if ("°C".equals(unit) && (v < -50 || v > 200)) {
            return "Diese Temperatur sieht nach einer falschen Skalierung aus - viele Geräte "
                    + "liefern Zehntelgrad (Skalierung 0,1).";
        }
        if ("kW".equals(unit) && Math.abs(v) > 1000) {
            return "Über 1.000 kW sieht nach einer falschen Skalierung aus - viele Geräte liefern "
                    + "Watt (Skalierung 0,001).";
        }
        if ("V".equals(unit) && v > 1000) {
            return "Über 1.000 V sieht nach einer falschen Skalierung aus - viele Geräte liefern "
                    + "Zehntelvolt (Skalierung 0,1).";
        }
        return null;
    }

    /**
     * Die vorgerechnete Leselast (§2.6) - der Satz, den der Assistent zeigt,
     * BEVOR der Kunde speichert.
     */
    public static String readLoadNote(List<NormalizedChannel> channels) {
        if (channels == null || channels.isEmpty()) {
            return null;
        }
        double perSecond = 0;
        for (NormalizedChannel c : channels) {
            perSecond += 1.0 / c.minReadIntervalS();
        }
        String rounded = String.format(Locale.GERMAN, "%.1f", perSecond);
        String note = channels.size() + (channels.size() == 1 ? " Messwert" : " Messwerte")
                + " ergeben rund " + rounded + " Lesungen pro Sekunde.";
        // Die Grenze ist Erfahrung, keine Physik: ab hier lohnt der Hinweis,
        // weil empfindliche Geräte (Solarman-Logger, billige Gateways) unter
        // dieser Last aussteigen - sichtbar als Lücken, nie als falsche Werte.
        if (perSecond > 1.0) {
            note += " Bei empfindlichen Geräten besser den Abstand erhöhen.";
        }
        return note;
    }

    /**
     * Der Java-Zwilling von {@code probe.IsPrivateHost} (Go), Form für Form.
     *
     * <p><b>Es ist eine WHITELIST dessen, was sich aus der Zeichenkette BELEGEN
     * lässt.</b> Ein nackter Hostname wird deshalb abgelehnt, obwohl das etwas
     * Bequemlichkeit kostet: er wird über die Suchdomänen der Box aufgelöst, ist
     * also nicht nachweisbar privat - und eine Regel, die ihr eigenes
     * Versprechen nicht prüfen kann, ist keine. Eine Blacklist wäre eine
     * Adressklasse davon entfernt, falsch zu sein.
     *
     * <p>⚠ Wer diese Regel ändert, ändert BEIDE Seiten - die Box prüft
     * unabhängig, und die zwei dürfen nie verschiedene Antworten geben.
     */
    public static boolean isPrivateHost(String host) {
        String h = host == null ? "" : host.trim();
        if (h.isEmpty()) {
            return false;
        }
        if (h.startsWith("[")) {
            h = h.substring(1);
        }
        if (h.endsWith("]")) {
            h = h.substring(0, h.length() - 1);
        }
        if (h.endsWith(".")) {
            h = h.substring(0, h.length() - 1);
        }
        if (h.isEmpty()) {
            return false;
        }
        byte[] literal = parseIpLiteral(h);
        if (literal != null) {
            return isPrivateIp(literal);
        }
        String lower = h.toLowerCase(Locale.ROOT);
        for (char bad : new char[] {' ', '/', '\\', '@', ':'}) {
            if (lower.indexOf(bad) >= 0) {
                return false;
            }
        }
        for (String suffix : LAN_SUFFIXES) {
            if (lower.endsWith(suffix)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Parst NUR ein IP-Literal - und niemals einen Namen.
     *
     * <p>⚠ {@code InetAddress.getByName} würde einen Hostnamen im Zweifel per
     * DNS AUFLÖSEN. Auf einem Validierungspfad wäre das gleich doppelt falsch:
     * es machte aus einer Formatprüfung einen Netzzugriff (mit dem Timeout des
     * Auflösers im Request-Thread), und es beantwortete die Frage „ist diese
     * ZEICHENKETTE nachweisbar privat" mit dem, was ein Auflöser gerade
     * behauptet. Deshalb wird vorher auf die Literal-Form geprüft.
     */
    private static byte[] parseIpLiteral(String h) {
        boolean v4 = h.indexOf('.') >= 0 && h.chars().allMatch(c -> c == '.' || (c >= '0' && c <= '9'));
        boolean v6 = h.indexOf(':') >= 0;
        if (!v4 && !v6) {
            return null;
        }
        try {
            return InetAddress.getByName(h).getAddress();
        } catch (UnknownHostException e) {
            return null;
        }
    }

    private static boolean isPrivateIp(byte[] addr) {
        if (addr.length == 4) {
            int a = addr[0] & 0xff;
            int b = addr[1] & 0xff;
            if (a == 10 || a == 127) {
                return true;
            }
            if (a == 172 && b >= 16 && b <= 31) {
                return true;
            }
            if (a == 192 && b == 168) {
                return true;
            }
            if (a == 169 && b == 254) {
                return true;
            }
            // CGNAT 100.64.0.0/10 - nicht öffentlich routbar, und echte
            // Kunden-Router vergeben sie.
            return a == 100 && b >= 64 && b <= 127;
        }
        if (addr.length == 16) {
            // Eine IPv4-abgebildete Adresse wird nach ihrer v4-Hälfte beurteilt.
            boolean mapped = true;
            for (int i = 0; i < 10; i++) {
                if (addr[i] != 0) {
                    mapped = false;
                    break;
                }
            }
            if (mapped && (addr[10] & 0xff) == 0xff && (addr[11] & 0xff) == 0xff) {
                return isPrivateIp(new byte[] {addr[12], addr[13], addr[14], addr[15]});
            }
            int first = addr[0] & 0xff;
            if ((first & 0xfe) == 0xfc) {
                return true; // fc00::/7 unique local
            }
            if (first == 0xfe && (addr[1] & 0xc0) == 0x80) {
                return true; // fe80::/10 link local
            }
            for (int i = 0; i < 15; i++) {
                if (addr[i] != 0) {
                    return false;
                }
            }
            return addr[15] == 1; // ::1
        }
        return false;
    }
}
