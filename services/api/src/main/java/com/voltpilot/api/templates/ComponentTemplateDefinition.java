package com.voltpilot.api.templates;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.components.SelfBuildDefinition;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Die REINEN Regeln einer geprüften Vorlage (Einheitsmodell Stufe 6).
 *
 * <p>Ohne DB, ohne Spring, ohne Uhr - das Haus-Muster von {@code Tagesprotokoll},
 * {@code FleetPflege}, {@code RolloutStates} und {@code SelfBuildDefinition}: die
 * Regel, die eine Vorlage annehmbar macht, ist Docker-frei prüfbar, und der
 * Dienst darüber ist reine Verdrahtung.
 *
 * <p><b>Warum eine Vorlage überhaupt validiert wird.</b> Sie ist die einzige
 * Stelle des Einheitsmodells, an der eine Aussage über ein PRODUKT skaliert:
 * eine falsche geprüfte Vorlage erreicht jede Anlage, die sie wählt (Konzept
 * Teil 9 Risiko 4). Deshalb prüft der Server die FORM, bevor er sie ablegt -
 * und sammelt wie {@link SelfBuildDefinition#validate} ALLE Mängel, statt beim
 * ersten abzubrechen.
 *
 * <p><b>⚠ Die Ehrlichkeitsregel der zwei nullbaren Spalten wird hier
 * ERZWUNGEN.</b> {@code channels} und {@code writes} sind absent = „diese
 * Vorlage erklärt es hier nicht"; ein leeres Array {@code []} wäre die
 * Behauptung „es gibt keine" und wird ABGELEHNT statt still zu NULL gemacht
 * (V20260815000000:85-113 begründet die Spalten genau so). Eine stille
 * Umdeutung hätte aus der Ehrlichkeitsregel eine Formalie gemacht.
 *
 * <p><b>⚠ Das Vokabular kommt aus EINER Quelle.</b> Einheiten und die
 * Slug-Ableitung teilt diese Klasse wörtlich mit {@link SelfBuildDefinition} -
 * ein zweites Einheiten-Verzeichnis wäre genau die Doppeldeutigkeit, die das
 * Einheitsmodell beseitigt (ein Kunde, der dieselbe Vorlage einmal als
 * Selbstbau und einmal als geprüfte Vorlage sieht, muss dieselben Wörter
 * lesen).
 */
public final class ComponentTemplateDefinition {

    /** Die Herkunft, die ein Admin schreiben darf. {@code builtin} gehört dem Seeder. */
    public static final String KIND_ADMIN = BuiltinComponentTemplates.KIND_CERTIFIED;

    /**
     * Die Prüf-Zustände, die ein Admin setzen darf. {@code builtin} fehlt
     * ABSICHTLICH: das Wort sagt „wird mit der Edge-Software ausgeliefert", und
     * eine von Hand eingetragene Vorlage wird das nie - sie von Hand so zu
     * nennen wäre eine Aussage über den Auslieferweg, die niemand einlöst.
     */
    public static final List<String> CERT_STATUSES =
            List.of("certified", "in_certification", "not_certified");

    /** Anbindungs-Arten, die eine geprüfte Vorlage heute beschreiben kann. */
    public static final List<String> COMMUNICATIONS =
            List.of("modbus_tcp", "solarman_v5", "fronius_solar_api", "fronius_sunspec",
                    "sunspec_tcp", "kaco_http", "kaco_modbus", "goe_http_api", "shelly_http");

    /** Feld-Arten des Verbindungs-Formulars (das Vokabular der `:8484`-Seite). */
    private static final List<String> FIELD_TYPES = List.of("text", "number", "select", "checkbox");

    private static final List<String> REGISTER_KINDS = List.of("holding", "input");
    private static final List<String> DATA_TYPES = List.of("u16", "s16", "u32", "s32", "float32");
    private static final List<String> WORD_ORDERS = List.of("big", "little");

    /** Schreib-Arten. Es gibt bewusst nur zwei - nie einen freien Schreib-Baustein (k6 §2.4). */
    private static final List<String> WRITE_KINDS = List.of("on_off", "setpoint");

    /**
     * Modbus-Funktionscodes fürs Schreiben: 5 (Coil), 6 (Einzelregister),
     * 16 (Registerblock). Die Deye/Fronius-Lehre „FC6 wird angenommen, aber
     * nicht übernommen" ist der Grund, warum 16 dazugehört.
     */
    private static final Set<Integer> WRITE_FCS = Set.of(5, 6, 16);

    private static final Pattern KEY = Pattern.compile("^[a-z][a-z0-9_]{0,63}$");

    /** Höchstlänge eines Anzeigetexts - dieselbe Grenze wie beim Selbstbau. */
    private static final int MAX_LABEL = 120;

    private static final int MAX_FIELDS = 12;
    private static final int MAX_CHANNELS = 32;
    private static final int MAX_WRITES = 8;

    private ComponentTemplateDefinition() {}

    /**
     * Das Ergebnis der Prüfung: entweder die Mängel oder die normalisierten
     * JSON-Bytes, die abgelegt werden.
     *
     * <p>{@code channelsJson}/{@code writesJson} sind {@code null}, wenn die
     * Vorlage sie nicht erklärt - genau die Spalten-Semantik.
     */
    public record Result(List<String> errors, String transportSchemaJson, String channelsJson,
            String writesJson) {

        public boolean ok() {
            return errors.isEmpty();
        }
    }

    /** Die Eingabe einer Vorlagen-Fassung, so wie der Assistent sie später liest. */
    public record Input(String brand, String brandLabel, String model, String modelLabel,
            String family, String familyLabel, String communication, String communicationLabel,
            JsonNode transportSchema, JsonNode channels, JsonNode writes, BigDecimal ratedKw,
            Integer controlTier, String certificationStatus, String certificationNote,
            String note) {}

    /**
     * Prüft und normalisiert eine ganze Vorlagen-Fassung.
     *
     * @return {@link Result} - bei Mängeln mit deutschen Sätzen, sonst mit den
     *     abzulegenden JSON-Bytes
     */
    public static Result validate(Input in) {
        List<String> errors = new ArrayList<>();
        if (in == null) {
            return new Result(List.of("Es wurde keine Vorlage übergeben."), null, null, null);
        }

        requireSlug(in.brand(), "Die Marke", errors);
        requireText(in.brandLabel(), "Der Anzeigename der Marke", errors);
        requireSlug(in.model(), "Das Modell", errors);
        requireText(in.modelLabel(), "Der Anzeigename des Modells", errors);

        if (in.family() != null && !in.family().isBlank() && !KEY.matcher(in.family()).matches()) {
            errors.add("Das Decode-Profil („family“) darf nur Kleinbuchstaben, Ziffern und "
                    + "Unterstriche enthalten.");
        }

        String comm = in.communication() == null ? "" : in.communication().trim();
        if (comm.isEmpty()) {
            errors.add("Bitte wählen Sie die Anbindungs-Art.");
        } else if (!COMMUNICATIONS.contains(comm)) {
            errors.add("Die Anbindungs-Art „" + comm + "“ kennen wir nicht. Möglich sind: "
                    + String.join(", ", COMMUNICATIONS) + ".");
        }

        if (in.ratedKw() != null && in.ratedKw().signum() <= 0) {
            errors.add("Die Nennleistung muss größer als 0 sein. Lassen Sie das Feld weg, wenn "
                    + "sie nicht bekannt ist - 0 wäre eine Aussage über das Gerät, die niemand "
                    + "belegt hat.");
        }
        if (in.controlTier() != null && (in.controlTier() < 0 || in.controlTier() > 3)) {
            errors.add("Die Steuer-Stufe muss zwischen 0 und 3 liegen.");
        }

        String status = in.certificationStatus() == null ? "" : in.certificationStatus().trim();
        if (!CERT_STATUSES.contains(status)) {
            errors.add("Der Prüf-Zustand muss einer von " + String.join(", ", CERT_STATUSES)
                    + " sein.");
        }

        String schema = checkTransportSchema(in.transportSchema(), errors);
        String channels = checkChannels(in.channels(), errors);
        String writes = checkWrites(in.writes(), errors);

        // Eine Vorlage, die schreiben lässt, aber als ungeprüft eingetragen ist,
        // wäre ein Widerspruch in sich: „wir stehen nicht dafür ein" neben
        // „hier ist der Schreibweg". Die Freigabe-Stufe 2 heißt GEPRÜFTE
        // Vorlage (Konzept §3.3.2) - ohne Prüfung gehört der Schreibweg dem
        // Selbstbau-Pfad mit seinem eigenen Schalt-Test.
        if (writes != null && !"certified".equals(status)) {
            errors.add("Eine Vorlage mit Schreib-Definition muss den Prüf-Zustand „certified“ "
                    + "tragen. Ohne Prüfung steht die Plattform nicht für den Schreibweg ein.");
        }

        if (in.certificationNote() != null && in.certificationNote().length() > 500) {
            errors.add("Die Prüf-Notiz ist zu lang (höchstens 500 Zeichen).");
        }
        if (in.note() != null && in.note().length() > 500) {
            errors.add("Die Notiz ist zu lang (höchstens 500 Zeichen).");
        }

        return new Result(List.copyOf(errors), schema, channels, writes);
    }

    /**
     * Der Vorlagen-Schlüssel wird ABGELEITET, nie getippt.
     *
     * <p>Er ist per Kontrakt OPAK (V20260815000000:56-60) - wer ihn tippen
     * ließe, machte aus einer internen Kennung ein Formularfeld, das jemand
     * „schöner“ machen will. Die Form spiegelt die eingebaute
     * ({@code builtin:<marke>:<modell>}), damit beide Herkünfte im selben
     * Muster lesbar bleiben.
     */
    public static String refFor(String brand, String model) {
        String b = brand == null ? "" : brand.trim().toLowerCase(Locale.ROOT);
        String m = model == null ? "" : model.trim().toLowerCase(Locale.ROOT);
        return KIND_ADMIN + ":" + b + ":" + m;
    }

    private static void requireSlug(String value, String what, List<String> errors) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) {
            errors.add(what + " fehlt.");
        } else if (!KEY.matcher(v).matches()) {
            errors.add(what + " darf nur Kleinbuchstaben, Ziffern und Unterstriche enthalten und "
                    + "muss mit einem Buchstaben beginnen.");
        }
    }

    private static void requireText(String value, String what, List<String> errors) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) {
            errors.add(what + " fehlt.");
        } else if (v.length() > MAX_LABEL) {
            errors.add(what + " ist zu lang (höchstens " + MAX_LABEL + " Zeichen).");
        }
    }

    private static String checkTransportSchema(JsonNode node, List<String> errors) {
        if (node == null || node.isNull() || !node.isArray() || node.isEmpty()) {
            errors.add("Bitte beschreiben Sie mindestens ein Verbindungsfeld - ohne Feld kann "
                    + "niemand die Adresse des Geräts eintragen.");
            return null;
        }
        if (node.size() > MAX_FIELDS) {
            errors.add("Höchstens " + MAX_FIELDS + " Verbindungsfelder je Vorlage.");
        }
        Set<String> keys = new LinkedHashSet<>();
        int i = 0;
        for (JsonNode f : node) {
            i++;
            String where = "Verbindungsfeld " + i;
            if (!f.isObject()) {
                errors.add(where + " ist kein Feld.");
                continue;
            }
            String key = text(f, "key");
            if (key.isEmpty() || !KEY.matcher(key).matches()) {
                errors.add(where + ": der Feldname fehlt oder enthält unerlaubte Zeichen.");
            } else if (!keys.add(key)) {
                errors.add(where + ": den Feldnamen „" + key + "“ gibt es schon.");
            }
            if (text(f, "label").isEmpty()) {
                errors.add(where + ": die Beschriftung fehlt.");
            }
            String type = text(f, "type");
            if (type.isEmpty()) {
                type = "text";
            }
            if (!FIELD_TYPES.contains(type)) {
                errors.add(where + ": die Feld-Art „" + type + "“ kennen wir nicht.");
            }
            if ("select".equals(type)) {
                JsonNode options = f.get("options");
                if (options == null || !options.isArray() || options.isEmpty()) {
                    errors.add(where + ": eine Auswahl braucht mindestens eine Option.");
                } else {
                    for (JsonNode o : options) {
                        if (!o.isObject() || text(o, "value").isEmpty()
                                || text(o, "label").isEmpty()) {
                            errors.add(where + ": jede Option braucht Wert und Beschriftung.");
                            break;
                        }
                    }
                }
            }
        }
        return node.toString();
    }

    private static String checkChannels(JsonNode node, List<String> errors) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isArray()) {
            errors.add("Die Messwert-Liste muss eine Liste sein.");
            return null;
        }
        if (node.isEmpty()) {
            errors.add(emptyList("Messwert-Liste", "liefert keine Messwerte"));
            return null;
        }
        if (node.size() > MAX_CHANNELS) {
            errors.add("Höchstens " + MAX_CHANNELS + " Messwerte je Vorlage.");
        }
        Set<String> slugs = new LinkedHashSet<>();
        int i = 0;
        for (JsonNode c : node) {
            i++;
            String where = "Messwert " + i;
            if (!c.isObject()) {
                errors.add(where + " ist kein Messwert.");
                continue;
            }
            String label = text(c, "label");
            if (label.isEmpty()) {
                errors.add(where + ": die Bezeichnung fehlt.");
            }
            String slug = text(c, "slug");
            if (slug.isEmpty()) {
                slug = SelfBuildDefinition.slug(label, slugs);
                if (slug == null) {
                    errors.add(where + ": aus der Bezeichnung lässt sich kein Kennwort ableiten.");
                }
            } else if (!KEY.matcher(slug).matches()) {
                errors.add(where + ": das Kennwort enthält unerlaubte Zeichen.");
            } else if (!slugs.add(slug)) {
                errors.add(where + ": das Kennwort „" + slug + "“ gibt es schon.");
            }
            String unit = text(c, "unit");
            if (!unit.isEmpty() && !SelfBuildDefinition.UNITS.contains(unit)) {
                errors.add(where + ": die Einheit „" + unit + "“ kennen wir nicht.");
            }
            checkRegister(c.get("register"), where, false, errors);
            JsonNode scale = c.get("scale");
            if (scale != null && !scale.isNull()
                    && (!scale.isNumber() || scale.doubleValue() == 0.0)) {
                errors.add(where + ": der Faktor muss eine Zahl ungleich 0 sein.");
            }
        }
        return node.toString();
    }

    private static String checkWrites(JsonNode node, List<String> errors) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isArray()) {
            errors.add("Die Schreib-Liste muss eine Liste sein.");
            return null;
        }
        if (node.isEmpty()) {
            errors.add(emptyList("Schreib-Liste", "kann nichts schalten"));
            return null;
        }
        if (node.size() > MAX_WRITES) {
            errors.add("Höchstens " + MAX_WRITES + " Schreib-Fähigkeiten je Vorlage.");
        }
        Set<String> keys = new LinkedHashSet<>();
        int i = 0;
        for (JsonNode w : node) {
            i++;
            String where = "Schreib-Fähigkeit " + i;
            if (!w.isObject()) {
                errors.add(where + " ist keine Schreib-Fähigkeit.");
                continue;
            }
            String key = text(w, "key");
            if (key.isEmpty() || !KEY.matcher(key).matches()) {
                errors.add(where + ": der Name fehlt oder enthält unerlaubte Zeichen.");
            } else if (!keys.add(key)) {
                errors.add(where + ": den Namen „" + key + "“ gibt es schon.");
            }
            if (text(w, "label").isEmpty()) {
                errors.add(where + ": die Beschriftung fehlt.");
            }
            String kind = text(w, "kind");
            if (!WRITE_KINDS.contains(kind)) {
                errors.add(where + ": die Schalt-Art muss „on_off“ oder „setpoint“ sein.");
                continue;
            }
            checkRegister(w.get("register"), where, true, errors);

            if ("on_off".equals(kind)) {
                if (!w.hasNonNull("on_value") || !w.hasNonNull("off_value")) {
                    errors.add(where + ": ein Schalter braucht den Ein- UND den Aus-Wert. "
                            + "Es werden nur Konstanten geschrieben, nie ein freier Wert.");
                }
            } else {
                JsonNode min = w.get("min");
                JsonNode max = w.get("max");
                if (min == null || !min.isNumber() || max == null || !max.isNumber()) {
                    errors.add(where + ": ein Sollwert braucht seine Klemme (kleinster und "
                            + "größter erlaubter Wert).");
                } else if (min.doubleValue() >= max.doubleValue()) {
                    errors.add(where + ": der kleinste Wert muss unter dem größten liegen.");
                }
                String unit = text(w, "unit");
                if (!unit.isEmpty() && !SelfBuildDefinition.UNITS.contains(unit)) {
                    errors.add(where + ": die Einheit „" + unit + "“ kennen wir nicht.");
                }
            }

            // Der Sicherheitswert ist die dritte k6-Leitplanke: was geschrieben
            // wird, wenn die Steuerung verstummt oder die Freigabe zurückgenommen
            // wird. Eine Schreib-Fähigkeit ohne ihn hinterließe ein Gerät im
            // zuletzt befohlenen Zustand - genau der Ausfall, den das Konzept
            // ausschließt.
            if (!w.hasNonNull("safe_value")) {
                errors.add(where + ": der Sicherheitswert fehlt. Er ist das, was bei Stille oder "
                        + "einem Widerruf geschrieben wird.");
            }

            JsonNode watchdog = w.get("watchdog");
            if (watchdog != null && !watchdog.isNull()) {
                if (!watchdog.isObject() || !watchdog.hasNonNull("register")
                        || !watchdog.hasNonNull("value")
                        || !watchdog.hasNonNull("interval_s")) {
                    errors.add(where + ": der Geräte-Wachhund braucht Register, Wert und "
                            + "Auffrisch-Abstand.");
                }
            }
        }
        return node.toString();
    }

    private static void checkRegister(JsonNode reg, String where, boolean write,
            List<String> errors) {
        if (reg == null || !reg.isObject()) {
            errors.add(where + ": die Register-Angabe fehlt.");
            return;
        }
        JsonNode address = reg.get("address");
        if (address == null || !address.isInt() || address.asInt() < 0 || address.asInt() > 65535) {
            errors.add(where + ": die Register-Adresse muss zwischen 0 und 65535 liegen.");
        }
        String dataType = text(reg, "data_type");
        if (!dataType.isEmpty() && !DATA_TYPES.contains(dataType)) {
            errors.add(where + ": den Datentyp „" + dataType + "“ kennen wir nicht.");
        }
        String wordOrder = text(reg, "word_order");
        if (!wordOrder.isEmpty() && !WORD_ORDERS.contains(wordOrder)) {
            errors.add(where + ": die Wortreihenfolge muss „big“ oder „little“ sein.");
        }
        if (write) {
            JsonNode fc = reg.get("fc");
            if (fc == null || !fc.isInt() || !WRITE_FCS.contains(fc.asInt())) {
                errors.add(where + ": der Funktionscode muss 5, 6 oder 16 sein.");
            }
        } else {
            String kind = text(reg, "kind");
            if (!kind.isEmpty() && !REGISTER_KINDS.contains(kind)) {
                errors.add(where + ": die Register-Art muss „holding“ oder „input“ sein.");
            }
        }
    }

    /**
     * Der Satz zur Ehrlichkeitsregel. Er nennt den WEG (das Feld weglassen),
     * statt nur abzulehnen - dieselbe Haltung wie {@code HOST_NOT_PRIVATE}.
     */
    private static String emptyList(String what, String claim) {
        return "Die " + what + " ist leer. Eine leere Liste behauptet „" + claim
                + "“. Lassen Sie das Feld weg, wenn die Vorlage es hier nicht erklärt.";
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || !v.isTextual() ? "" : v.asText().trim();
    }
}
