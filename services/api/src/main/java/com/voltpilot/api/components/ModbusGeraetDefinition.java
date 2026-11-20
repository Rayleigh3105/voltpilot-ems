package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die REINEN Regeln des eigenen Modbus-Geräts mit Lese- UND Schreibwerten
 * (Steuerlogik K3, {@code docs/contracts/v2/modbus-geraet.md}): ein
 * Klimagerät, eine Wärmepumpe, ein Kühlstellenregler, Register für Register
 * beschrieben. Keine DB, kein Spring, keine Uhr - das
 * {@link SwitchDefinition}-Muster.
 *
 * <p>Zwilling von {@code edge-app/core/internal/modbusgeraet} (Go): dieselben
 * Regeln, dieselben Ablehnungs-Codes, gemeinsame Vektoren
 * {@code docs/contracts/v2/modbus-geraet-vectors.json}. Die Box prüft, was sie
 * bekommt, noch einmal - die Cloud glaubt sie nichts; diese Kopie fängt den
 * Fehler dort, wo er entsteht, mit einem deutschen Satz.
 *
 * <p><b>Der Grundsatz (Bericht 15.1):</b> Das Gerät regelt selbst. VoltPilot
 * verschiebt den Sollwert innerhalb des freigegebenen Bands, wählt die
 * Betriebsart aus der Liste, die der Fachbetrieb zugeordnet hat, schaltet
 * frei oder aus - und lässt ohne Wunsch und bei einer Störung des Geräts die
 * Ruhewerte stehen.
 */
public final class ModbusGeraetDefinition {

    private ModbusGeraetDefinition() {
    }

    public static final int MAX_CHANNELS = 16;
    public static final int MAX_CONTROLS = 3;
    public static final int MAX_MODES = 8;
    public static final int MIN_READ_INTERVAL_S = 5;
    public static final int DEFAULT_CHANGE_INTERVAL_S = 60;
    public static final int MIN_CHANGE_INTERVAL_S = 10;
    public static final int MAX_CHANGE_INTERVAL_S = 3600;
    public static final int MAX_RAW = 65535;

    /** Der Entitätstyp eines freigegebenen Geräts mit Schreibwerten. */
    public static final String ENTITY_TYPE = "modbus-device";

    /** Die Fähigkeit der Box, solche Geräte selbst zu lesen und zu schreiben. */
    public static final String FAEHIGKEIT = "modbus_geraet";

    /** Die Signale der Steuerlogik-Wortliste (Tabelle {@code signal}). */
    public static final List<String> SIGNALS = List.of("temperature", "room_temperature", "open", "door_open",
            "defrost", "fault", "running", "humidity", "outdoor_temperature", "supply_temperature",
            "return_temperature", "power");

    /** Die Ja/Nein-Signale: ein Bit, eine Spule oder ein diskreter Eingang. */
    public static final Set<String> BOOL_SIGNALS = Set.of("open", "door_open", "defrost", "fault", "running");

    /** Die Betriebsarten der Steuerlogik-Wortliste, in ihrer Reihenfolge. */
    public static final List<String> MODES = List.of("normal", "boost", "cool", "heat", "fan_only", "dry", "auto",
            "start");

    public static final String KIND_ON_OFF = "on_off";
    public static final String KIND_SETPOINT_C = "setpoint_c";
    public static final String KIND_MODE = "mode";

    /** Eine Ablehnung: der Code der Vektoren, die Stelle, der Satz für den Kunden. */
    public record Fehler(String code, String wo, String text) {
    }

    /** Das Ergebnis: Fehler, oder die normalisierte Definition (ohne Freigabe). */
    public record Ergebnis(List<Fehler> fehler, ObjectNode definition) {
        public boolean ok() {
            return fehler.isEmpty();
        }

        public List<String> texte() {
            return fehler.stream().map(Fehler::text).distinct().toList();
        }
    }

    private static final Map<String, String> TEXT = Map.ofEntries(
            Map.entry("transport", "Bitte tragen Sie die Adresse des Geräts ein (Port 1 bis 65535, Unit 0 bis 255)."),
            Map.entry("channel_count", "Höchstens " + MAX_CHANNELS + " Messwerte je Gerät."),
            Map.entry("channel_slug", "Jeder Messwert braucht einen eigenen Namen."),
            Map.entry("register", "Bitte prüfen Sie Registerart und Adresse (0 bis 65535). Schreiben lässt sich nur "
                    + "ein Holding-Register oder eine Spule; ein Sollwert und eine Betriebsart brauchen ein Register."),
            Map.entry("data_type", "Bitte wählen Sie einen Datentyp: u16, s16, u32, s32 oder float32 zum Lesen, "
                    + "u16 oder s16 zum Schreiben."),
            Map.entry("bit", "Ein Bit liegt in einem 16-Bit-Register und hat die Nummer 0 bis 15."),
            Map.entry("signal", "Diese Bedeutung kennt die Steuerlogik nicht."),
            Map.entry("signal_twice", "Jede Bedeutung darf an einem Gerät nur einmal vorkommen."),
            Map.entry("signal_unit", "Eine Temperatur braucht die Einheit °C, die Luftfeuchte %."),
            Map.entry("signal_bool", "Tür, Fenster, Abtauung, Störung und Betrieb sind Ja/Nein-Werte: ein Bit, "
                    + "eine Spule oder ein diskreter Eingang - und umgekehrt."),
            Map.entry("read_interval", "Der Mindestabstand zwischen zwei Lesungen ist " + MIN_READ_INTERVAL_S + " s."),
            Map.entry("control_count", "Ein Gerät hat höchstens drei Schreibwerte: Ein/Aus, Sollwert und Betriebsart."),
            Map.entry("control_kind", "Ein Schreibwert ist Ein/Aus, Sollwert in °C oder Betriebsart."),
            Map.entry("control_twice", "Jede Art von Schreibwert gibt es an einem Gerät nur einmal."),
            Map.entry("control_slug", "Jeder Schreibwert braucht einen eigenen Namen, auch gegenüber den Messwerten."),
            Map.entry("write_fc", "Eine Spule wird mit Funktionscode 5 geschrieben, ein Register mit 16 "
                    + "(Voreinstellung) oder 6."),
            Map.entry("on_off_values", "Bitte tragen Sie verschiedene Ein- und Aus-Werte ein (eine Spule kennt nur "
                    + "0 und 1)."),
            Map.entry("scale", "Die Skalierung muss eine Zahl ungleich 0 sein."),
            Map.entry("band", "Bitte tragen Sie den kleinsten und den größten Sollwert ein - außerhalb dieses Bands "
                    + "stellt VoltPilot nie."),
            Map.entry("step", "Die Schrittweite muss größer als 0 und nicht größer als das Band sein."),
            Map.entry("raw_range", "Mit dieser Skalierung lässt sich das Band nicht als Registerwert schreiben."),
            Map.entry("modes", "Bitte ordnen Sie 1 bis " + MAX_MODES + " Betriebsarten verschiedenen Werten zu "
                    + "(0 bis 65535)."),
            Map.entry("mode_word", "Diese Betriebsart kennt die Steuerlogik nicht (normal, boost, cool, heat, "
                    + "fan_only, dry, auto, start)."),
            Map.entry("rest", "Bitte tragen Sie den Ruhewert ein - er gilt ohne Wunsch und bei einer Störung des "
                    + "Geräts und muss im Band beziehungsweise in der Liste liegen."),
            Map.entry("change_interval", "Der Abstand zwischen zwei Änderungen liegt zwischen "
                    + MIN_CHANGE_INTERVAL_S + " und " + MAX_CHANGE_INTERVAL_S + " s."),
            Map.entry("cycle", "Mindestlauf und Mindestpause liegen zwischen 0 und 86400 s."),
            Map.entry("watchdog", "Bitte prüfen Sie Adresse und Wert des Watchdog-Registers (0 bis 65535)."),
            Map.entry("readback", "Ein Wort wird aus einem Register, ein Bit aus einer Spule zurückgelesen."),
            Map.entry("readback_data_type", "Zurückgelesen wird ein ganzes 16-Bit-Register."));

    /**
     * Prüft und normalisiert eine Definition in der gespeicherten Form
     * (transport, channels, controls). Fehlende Kennungen leitet sie aus dem
     * Namen ab; die Freigabe streicht sie - die setzt nur der Freigabe-Weg.
     */
    public static Ergebnis pruefe(JsonNode eingabe, ObjectMapper mapper) {
        List<Fehler> out = new ArrayList<>();
        ObjectNode def = eingabe != null && eingabe.isObject() ? ((ObjectNode) eingabe).deepCopy()
                : mapper.createObjectNode();
        def.put("schema_version", "1.0");

        JsonNode t = def.path("transport");
        String host = t.path("host").asText("").trim();
        int port = t.path("port").asInt(502);
        int unit = t.path("unit_id").asInt(1);
        if (host.isEmpty() || port < 1 || port > 65535 || unit < 0 || unit > 255) {
            fehl(out, "transport", "transport");
        } else if (!SelfBuildDefinition.isPrivateHost(host)) {
            out.add(new Fehler("transport", "transport", SelfBuildDefinition.HOST_NOT_PRIVATE));
        }

        JsonNode channels = def.path("channels");
        if (channels.size() > MAX_CHANNELS) {
            fehl(out, "channel_count", "channels");
        }
        Set<String> slugs = new HashSet<>();
        Set<String> signale = new HashSet<>();
        int i = 0;
        for (JsonNode c : channels) {
            String wo = "channels[" + i++ + "]";
            if (!c.isObject()) {
                fehl(out, "channel_slug", wo);
                continue;
            }
            String slug = slugOf((ObjectNode) c, slugs);
            if (slug == null || slugs.contains(slug)) {
                fehl(out, "channel_slug", wo);
            }
            slugs.add(slug);
            JsonNode reg = c.path("register");
            pruefeRegister(reg, wo, true, out);
            if (c.has("min_read_interval_s") && c.path("min_read_interval_s").asInt() != 0
                    && c.path("min_read_interval_s").asInt() < MIN_READ_INTERVAL_S) {
                fehl(out, "read_interval", wo);
            }
            String signal = c.path("signal").asText("");
            if (signal.isEmpty()) {
                continue;
            }
            if (!SIGNALS.contains(signal)) {
                fehl(out, "signal", wo);
                continue;
            }
            if (!signale.add(signal)) {
                fehl(out, "signal_twice", wo);
            }
            boolean bit = istBit(reg);
            String einheit = c.path("unit").asText("");
            if (BOOL_SIGNALS.contains(signal) != bit) {
                fehl(out, "signal_bool", wo);
            } else if (signal.endsWith("temperature") && !"°C".equals(einheit)) {
                fehl(out, "signal_unit", wo);
            } else if ("humidity".equals(signal) && !"%".equals(einheit)) {
                fehl(out, "signal_unit", wo);
            }
        }

        JsonNode cs = def.path("controls");
        if (!cs.isObject()) {
            return new Ergebnis(out, def);
        }
        ((ObjectNode) cs).remove("freigabe");
        JsonNode values = cs.path("values");
        if (!values.isArray() || values.size() > MAX_CONTROLS) {
            fehl(out, "control_count", "controls.values");
        }
        if (cs.has("min_change_interval_s")) {
            int iv = cs.path("min_change_interval_s").asInt(-1);
            if (iv < MIN_CHANGE_INTERVAL_S || iv > MAX_CHANGE_INTERVAL_S) {
                fehl(out, "change_interval", "controls.min_change_interval_s");
            }
        }
        for (String k : new String[] {"min_on_seconds", "min_off_seconds"}) {
            if (cs.has(k) && (cs.path(k).asInt(-1) < 0 || cs.path(k).asInt(-1) > 86400)) {
                fehl(out, "cycle", "controls." + k);
            }
        }
        if (cs.has("watchdog_address")) {
            int a = cs.path("watchdog_address").asInt(-1);
            int v = cs.path("watchdog_value").asInt(0);
            if (a < 0 || a > MAX_RAW || v < 0 || v > MAX_RAW) {
                fehl(out, "watchdog", "controls.watchdog_address");
            }
        }
        Set<String> arten = new HashSet<>();
        i = 0;
        for (JsonNode c : values) {
            String wo = "controls.values[" + i++ + "]";
            if (!c.isObject()) {
                fehl(out, "control_kind", wo);
                continue;
            }
            String slug = slugOf((ObjectNode) c, slugs);
            if (slug == null || slugs.contains(slug)) {
                fehl(out, "control_slug", wo);
            }
            slugs.add(slug);
            String kind = c.path("kind").asText("");
            if (!Set.of(KIND_ON_OFF, KIND_SETPOINT_C, KIND_MODE).contains(kind)) {
                fehl(out, "control_kind", wo);
                continue;
            }
            if (!arten.add(kind)) {
                fehl(out, "control_twice", wo);
            }
            pruefeControl(c, kind, wo, out);
        }
        return new Ergebnis(out, def);
    }

    private static String slugOf(ObjectNode c, Set<String> taken) {
        String slug = c.path("slug").asText("");
        if (slug.isEmpty()) {
            slug = SelfBuildDefinition.slug(c.path("label").asText(""), taken);
            if (slug != null) {
                c.put("slug", slug);
            }
            return slug;
        }
        return slug.matches("^[a-z][a-z0-9_]{0,63}$") ? slug : null;
    }

    private static boolean istBit(JsonNode reg) {
        String kind = reg.path("kind").asText("");
        return "coil".equals(kind) || "discrete".equals(kind) || reg.has("bit");
    }

    private static int count(JsonNode reg) {
        String dt = reg.path("data_type").asText("");
        return Set.of("u32", "s32", "float32").contains(dt) ? 2 : 1;
    }

    private static void pruefeRegister(JsonNode reg, String wo, boolean lesen, List<Fehler> out) {
        String kind = reg.path("kind").asText("");
        switch (kind) {
            case "holding", "input" -> {
                String dt = reg.path("data_type").asText("");
                if (!Set.of("", "u16", "s16", "u32", "s32", "float32").contains(dt)) {
                    fehl(out, "data_type", wo);
                }
                if (reg.has("bit")) {
                    int b = reg.path("bit").asInt(-1);
                    if (b < 0 || b > 15 || count(reg) != 1) {
                        fehl(out, "bit", wo);
                    }
                }
            }
            case "coil", "discrete" -> {
                if (reg.has("bit")) {
                    fehl(out, "bit", wo);
                }
            }
            default -> fehl(out, "register", wo);
        }
        int a = reg.path("address").isNumber() ? reg.path("address").asInt() : -1;
        if (a < 0 || a > MAX_RAW || a + count(reg) - 1 > MAX_RAW) {
            fehl(out, "register", wo);
        }
        if (!lesen && !"holding".equals(kind) && !"coil".equals(kind)) {
            fehl(out, "register", wo);
        }
    }

    private static void pruefeControl(JsonNode c, String kind, String wo, List<Fehler> out) {
        JsonNode reg = c.path("register");
        pruefeRegister(reg, wo, false, out);
        if (reg.has("bit")) {
            fehl(out, "bit", wo);
        }
        boolean coil = "coil".equals(reg.path("kind").asText(""));
        int fc = effectiveFc(c);
        if ((coil && fc != 5) || (!coil && fc != 6 && fc != 16)) {
            fehl(out, "write_fc", wo);
        }
        String dt = reg.path("data_type").asText("");
        if ("holding".equals(reg.path("kind").asText("")) && !dt.isEmpty() && !"u16".equals(dt) && !"s16".equals(dt)) {
            fehl(out, "data_type", wo);
        }
        JsonNode rb = c.path("readback");
        if (rb.isObject()) {
            pruefeRegister(rb, wo + ".readback", true, out);
            if (rb.has("bit") || count(rb) != 1) {
                fehl(out, "readback_data_type", wo + ".readback");
            }
            String rk = rb.path("kind").asText("");
            boolean bitRb = "coil".equals(rk) || "discrete".equals(rk);
            if (bitRb != coil) {
                fehl(out, "readback", wo + ".readback");
            }
        }
        JsonNode rest = c.path("rest");
        switch (kind) {
            case KIND_ON_OFF -> {
                JsonNode on = c.path("on_value");
                JsonNode off = c.path("off_value");
                if (!on.isInt() || !off.isInt() || !inRaw(on.asInt()) || !inRaw(off.asInt())
                        || on.asInt() == off.asInt() || (coil && (on.asInt() > 1 || off.asInt() > 1))) {
                    fehl(out, "on_off_values", wo);
                }
                if (!rest.isBoolean()) {
                    fehl(out, "rest", wo);
                }
            }
            case KIND_SETPOINT_C -> {
                if (coil) {
                    fehl(out, "register", wo);
                    return;
                }
                double scale = c.has("scale") ? c.path("scale").asDouble(Double.NaN) : 1;
                double offset = c.has("offset") ? c.path("offset").asDouble(Double.NaN) : 0;
                if (scale == 0 || Double.isNaN(scale) || Double.isInfinite(scale) || Double.isNaN(offset)) {
                    fehl(out, "scale", wo);
                    return;
                }
                if (!c.path("min").isNumber() || !c.path("max").isNumber()
                        || !(c.path("min").asDouble() < c.path("max").asDouble())) {
                    fehl(out, "band", wo);
                    return;
                }
                double min = c.path("min").asDouble();
                double max = c.path("max").asDouble();
                if (c.has("step") && !(c.path("step").asDouble() > 0 && c.path("step").asDouble() <= max - min)) {
                    fehl(out, "step", wo);
                }
                if (!rest.isNumber() || rest.asDouble() < min || rest.asDouble() > max) {
                    fehl(out, "rest", wo);
                    return;
                }
                for (double v : new double[] {min, max, rest.asDouble()}) {
                    if (rohSollwert(c, v) == null) {
                        fehl(out, "raw_range", wo);
                        break;
                    }
                }
            }
            case KIND_MODE -> {
                if (coil) {
                    fehl(out, "register", wo);
                    return;
                }
                JsonNode modes = c.path("modes");
                if (!modes.isObject() || modes.isEmpty() || modes.size() > MAX_MODES) {
                    fehl(out, "modes", wo);
                    return;
                }
                Set<Integer> rohe = new HashSet<>();
                var it = modes.fields();
                while (it.hasNext()) {
                    var e = it.next();
                    if (!MODES.contains(e.getKey())) {
                        fehl(out, "mode_word", wo);
                    }
                    if (!e.getValue().isInt() || !inRaw(e.getValue().asInt()) || !rohe.add(e.getValue().asInt())) {
                        fehl(out, "modes", wo);
                    }
                }
                if (!rest.isTextual() || !modes.has(rest.asText())) {
                    fehl(out, "rest", wo);
                }
            }
            default -> {
            }
        }
    }

    /** Der Funktionscode eines Schreibwerts: Spule 5, Register 16 (Voreinstellung). */
    public static int effectiveFc(JsonNode c) {
        if (c.path("write_fc").isInt() && c.path("write_fc").asInt() != 0) {
            return c.path("write_fc").asInt();
        }
        return "coil".equals(c.path("register").path("kind").asText("")) ? 5 : 16;
    }

    /**
     * Der Registerwert eines Sollwerts in °C: (Wert - offset) / scale, vom
     * Nullpunkt weg gerundet (wie die Box), s16 im Zweierkomplement; null, wenn
     * das Register ihn nicht darstellen kann.
     */
    public static Integer rohSollwert(JsonNode c, double wert) {
        double scale = c.has("scale") ? c.path("scale").asDouble() : 1;
        double offset = c.has("offset") ? c.path("offset").asDouble() : 0;
        double q = (wert - offset) / scale;
        long r = (long) (Math.signum(q) * Math.floor(Math.abs(q) + 0.5));
        String dt = c.path("register").path("data_type").asText("");
        if (dt.isEmpty() || "s16".equals(dt)) {
            if (r < -32768 || r > 32767) {
                return null;
            }
            return (int) (r & 0xFFFF);
        }
        if (r < 0 || r > MAX_RAW) {
            return null;
        }
        return (int) r;
    }

    /** Der Registerwert eines Schreibwerts für einen Testwert (Ja/Nein, °C, Betriebsart). */
    public static Integer roh(JsonNode c, JsonNode wert) {
        return switch (c.path("kind").asText("")) {
            case KIND_ON_OFF -> wert != null && wert.isBoolean()
                    ? (wert.asBoolean() ? c.path("on_value").asInt() : c.path("off_value").asInt()) : null;
            case KIND_SETPOINT_C -> wert != null && wert.isNumber() ? rohSollwert(c, wert.asDouble()) : null;
            case KIND_MODE -> wert != null && wert.isTextual() && c.path("modes").has(wert.asText())
                    ? c.path("modes").path(wert.asText()).asInt() : null;
            default -> null;
        };
    }

    /** Der Registerwert des Ruhewerts. */
    public static Integer rohRuhe(JsonNode c) {
        return roh(c, c.path("rest"));
    }

    /**
     * Ob ein Testwert im Erlaubten liegt: ein Sollwert im Band, eine
     * Betriebsart in der Liste. Er wird NICHT hineingeklemmt - ein Test ist nur
     * so viel wert wie die Zusage, dass genau dieser Wert geschrieben wurde.
     */
    public static String testwertFehler(JsonNode c, JsonNode wert) {
        String kind = c.path("kind").asText("");
        if (KIND_SETPOINT_C.equals(kind) && (wert == null || !wert.isNumber()
                || wert.asDouble() < c.path("min").asDouble() || wert.asDouble() > c.path("max").asDouble())) {
            return "Der Testwert muss zwischen " + c.path("min").asText() + " und " + c.path("max").asText()
                    + " °C liegen - außerhalb des Bands stellt VoltPilot nie.";
        }
        if (roh(c, wert) == null) {
            return "Bitte wählen Sie einen Testwert, den dieser Schreibwert kennt.";
        }
        return null;
    }

    /**
     * Die Fähigkeiten des Geräts: alle Messwerte und - erst nach der Freigabe -
     * die Schreibwerte mit Band, Schritt, Liste und Ruhewert. Diese Liste macht
     * auf der Box aus einem Sensor ein Gerät, das sich stellen lässt.
     */
    public static ObjectNode faehigkeiten(JsonNode def, boolean freigegeben, ObjectMapper mapper) {
        ObjectNode caps = mapper.createObjectNode();
        ArrayNode measure = caps.putArray("measure");
        for (JsonNode c : def.path("channels")) {
            ObjectNode m = measure.addObject();
            m.put("channel", c.path("slug").asText());
            m.put("unit", c.path("unit").asText(""));
            m.put("label", c.path("label").asText(""));
        }
        if (!freigegeben) {
            return caps;
        }
        ArrayNode actuate = caps.putArray("actuate");
        for (JsonNode c : def.path("controls").path("values")) {
            ObjectNode a = actuate.addObject();
            String kind = c.path("kind").asText();
            a.put("command", kind);
            if (KIND_SETPOINT_C.equals(kind)) {
                a.put("min", c.path("min").asDouble());
                a.put("max", c.path("max").asDouble());
                if (c.has("step")) {
                    a.put("step", c.path("step").asDouble());
                }
            }
            if (KIND_MODE.equals(kind)) {
                ArrayNode modes = a.putArray("modes");
                for (String w : MODES) {
                    if (c.path("modes").has(w)) {
                        modes.add(w);
                    }
                }
            }
            a.set("rest", c.path("rest").deepCopy());
        }
        return caps;
    }

    /**
     * Der Schutz des Geräts: vor der Freigabe nur messen; danach Ruhewerte als
     * Rückfall, der Abstand zwischen zwei Änderungen und - für Ein/Aus -
     * Mindestlauf und Mindestpause.
     */
    public static ObjectNode schutz(JsonNode def, boolean freigegeben, ObjectMapper mapper) {
        ObjectNode guards = mapper.createObjectNode();
        ObjectNode limits = guards.putObject("limits");
        if (!freigegeben) {
            guards.putObject("failsafe").put("behavior", "measure-only");
            return guards;
        }
        JsonNode cs = def.path("controls");
        limits.put("min_change_interval_s", cs.path("min_change_interval_s").asInt(DEFAULT_CHANGE_INTERVAL_S));
        for (String k : new String[] {"min_on_seconds", "min_off_seconds"}) {
            if (cs.has(k)) {
                limits.put(k, cs.path(k).asInt());
            }
        }
        guards.putObject("failsafe").put("behavior", "rest");
        return guards;
    }

    /** Der Schreibwert mit dieser Kennung, oder null. */
    public static JsonNode control(JsonNode def, String slug) {
        for (JsonNode c : def.path("controls").path("values")) {
            if (slug != null && slug.equals(c.path("slug").asText())) {
                return c;
            }
        }
        return null;
    }

    private static boolean inRaw(int v) {
        return v >= 0 && v <= MAX_RAW;
    }

    private static void fehl(List<Fehler> out, String code, String wo) {
        out.add(new Fehler(code, wo, TEXT.getOrDefault(code, code)));
    }
}
