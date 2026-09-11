package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Die Regeln der EINSTELLUNGS-FASSUNGEN je Quelle (UEMS AP-04 IP-11, E4 = A, E5 = A; Vertrag
 * {@code docs/contracts/v2/quelle-einstellung.md}): welche Werte eine Art trägt, wie eine neue
 * Fassung sich zwischen die bestehenden legt, was der Kunde darüber liest, und welche Fassungen die
 * heutige Verbindung einer Komponente schon enthält.
 *
 * <p>Rein — keine Datenbank, keine Uhr. Gepinnt von {@code quelle-einstellung-vectors.json}; der
 * TS-Zwilling ist {@code frontend/portal/src/uemsEinstellung.ts}, die SQL-Seite der Migration
 * V20260911280000 ({@code uems_einstellung_wert_gueltig}, {@code uems_einstellungen_aus_verbindung})
 * fährt dieselben Fälle. Wer eine Regel ändert, ändert jede Seite UND die Datei.
 *
 * <p><b>Die Wirkung (E5):</b> nur ab {@code gueltig_ab}. Keine dieser Regeln ändert einen
 * gespeicherten Wert oder ordnet eine Neuberechnung an — ein falsch erfasster Zeitraum wird über eine
 * Korrektur (AP-08) berichtigt, und genau das sagen die Folgen-Sätze.
 */
public final class QuelleEinstellungRegeln {

    private QuelleEinstellungRegeln() {}

    /** In ihr stehen die Zeitpunkte der Folgen-Sätze. */
    public static final ZoneId ZEITZONE = ZoneId.of("Europe/Berlin");

    /** Betragsgrenze jeder Zahl eines Werts (einschließlich). */
    public static final BigDecimal ZAHL_GRENZE = new BigDecimal("1000000000");

    public static final int EINHEIT_MAX_ZEICHEN = 32;

    /** Die Anschluss-Art des Modbus-Baukastens: seine Kanäle tragen Skalierung und Offset. */
    public static final String SELBSTBAU_KOMMUNIKATION = "modbus_baukasten";

    /** Die Auswahl des Verbindungsfelds {@code power_scale}; 0 heißt automatisch. */
    public static final List<Integer> LEISTUNGSSKALIERUNG_STUFEN = List.of(0, 1, 10);

    /**
     * Die Kanäle der beiden Verbindungs-Vorzeichen — das des Netzes und das der Batterie stehen je an
     * ihrem Kanal der Lesung, damit zwei Fassungen derselben Art nicht auf dieselbe Quelle fallen.
     */
    public static final Map<String, String> VERBINDUNGS_KANAELE = verbindungsKanaele();

    /** Das geschlossene Vokabular der Arten (AP-04 §4.4), in der Reihenfolge des Vertrags. */
    public enum Art {
        WANDLER_STROM("wandler_strom", "Wandlerverhältnis Strom", List.of("primaer_a", "sekundaer_a"),
                "{primaer_a}/{sekundaer_a} A"),
        WANDLER_SPANNUNG("wandler_spannung", "Spannungswandler", List.of("primaer_v", "sekundaer_v"),
                "{primaer_v}/{sekundaer_v} V"),
        SKALIERUNG("skalierung", "Skalierung", List.of("faktor"), "×{faktor}"),
        OFFSET("offset", "Offset", List.of("wert", "einheit"), "{wert} {einheit}"),
        VORZEICHEN_UMGEKEHRT("vorzeichen_umgekehrt", "Vorzeichen umgekehrt", List.of("umgekehrt"),
                "{umgekehrt}"),
        IMPULSWERTIGKEIT("impulswertigkeit", "Impulswertigkeit", List.of("impulse_je_kwh"),
                "{impulse_je_kwh} Impulse je kWh"),
        ZAEHLERKONSTANTE("zaehlerkonstante", "Zählerkonstante", List.of("je_kwh"), "{je_kwh} je kWh");

        private final String code;
        private final String kundenwort;
        private final List<String> felder;
        private final String text;

        Art(String code, String kundenwort, List<String> felder, String text) {
            this.code = code;
            this.kundenwort = kundenwort;
            this.felder = felder;
            this.text = text;
        }

        public String code() {
            return code;
        }

        public String kundenwort() {
            return kundenwort;
        }

        public List<String> felder() {
            return felder;
        }

        public String text() {
            return text;
        }

        /** Die Art zu ihrem Code; {@code null} außerhalb des Vokabulars — nie geraten. */
        public static Art von(String code) {
            for (Art a : values()) {
                if (a.code.equals(code)) {
                    return a;
                }
            }
            return null;
        }

        public boolean istWandler() {
            return this == WANDLER_STROM || this == WANDLER_SPANNUNG;
        }
    }

    /** Wie eine Fassung wirkt (E5): von VoltPilot beim Erfassen angewendet oder im Gerät eingestellt. */
    public static final List<String> ANWENDUNGEN = List.of("angewendet", "dokumentiert");
    public static final String ANGEWENDET = "angewendet";
    public static final String DOKUMENTIERT = "dokumentiert";

    /** Woher eine Fassung stammt: aus der heutigen Verbindung, mit ihrer Änderung, eingetragen. */
    public static final List<String> HERKUENFTE = List.of("bestand", "verbindung", "eintrag");
    public static final String BESTAND = "bestand";
    public static final String VERBINDUNG = "verbindung";
    public static final String EINTRAG = "eintrag";

    /** Abgeleitet, nie gespeichert. {@code null} (dokumentiert) steht nicht in der Liste. */
    public static final List<String> ZUSTELLUNGEN = List.of("verbindung", "ausstehend");
    public static final List<String> STATUS = List.of("geplant", "gueltig", "beendet");

    /** Die Codes der Regeln mit ihrem HTTP-Status, in Prüfreihenfolge. */
    public enum Fehler {
        WERT_UNGUELTIG("wert_ungueltig", 400),
        ZEITPUNKT_UNGUELTIG("zeitpunkt_ungueltig", 400),
        VOR_BEGINN("vor_beginn", 422),
        NACH_ENDE("nach_ende", 422),
        TATSAECHLICH_UNGUELTIG("tatsaechlich_ungueltig", 422),
        BEGINN_BELEGT("beginn_belegt", 409),
        UNVERAENDERT("unveraendert", 400);

        private final String code;
        private final int status;

        Fehler(String code, int status) {
            this.code = code;
            this.status = status;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }
    }

    /** Die Kundensätze mit ihren Platzhaltern — dieselben Zeichen wie {@code texte} der Vektor-Datei. */
    public static final Map<String, String> TEXTE = texte();

    // ------------------------------------------------------------------ Werte

    /** Hat {@code wert} genau die Form, die {@code art} verlangt? */
    public static boolean wertGueltig(String art, JsonNode wert) {
        Art a = Art.von(art);
        if (a == null || wert == null || !wert.isObject()) {
            return false;
        }
        Set<String> felder = felder(wert);
        return switch (a) {
            case WANDLER_STROM, WANDLER_SPANNUNG -> felder.equals(new TreeSet<>(a.felder()))
                    && positiv(wert.get(a.felder().get(0))) && positiv(wert.get(a.felder().get(1)));
            case SKALIERUNG -> (felder.equals(Set.of("faktor")) && zahl(wert.get("faktor"))
                    && wert.get("faktor").decimalValue().signum() != 0)
                    || (felder.equals(Set.of("automatisch")) && wert.get("automatisch").isBoolean()
                            && wert.get("automatisch").booleanValue());
            case OFFSET -> felder.equals(new TreeSet<>(a.felder())) && zahl(wert.get("wert"))
                    && wert.get("einheit").isTextual()
                    && wert.get("einheit").textValue().length() <= EINHEIT_MAX_ZEICHEN;
            case VORZEICHEN_UMGEKEHRT -> felder.equals(Set.of("umgekehrt")) && wert.get("umgekehrt").isBoolean();
            case IMPULSWERTIGKEIT, ZAEHLERKONSTANTE -> felder.equals(Set.of(a.felder().get(0)))
                    && positiv(wert.get(a.felder().get(0)));
        };
    }

    /** „600/5 A", „×10", „automatisch", „-2 °C" — {@code null} für einen ungültigen Wert. */
    public static String wertText(String art, JsonNode wert) {
        if (!wertGueltig(art, wert)) {
            return null;
        }
        Art a = Art.von(art);
        if (a == Art.SKALIERUNG && wert.has("automatisch")) {
            return TEXTE.get("automatisch");
        }
        if (a == Art.OFFSET) {
            String einheit = wert.get("einheit").textValue();
            String z = zahlText(wert.get("wert").decimalValue());
            return einheit.isEmpty() ? z : z + " " + einheit;
        }
        if (a == Art.VORZEICHEN_UMGEKEHRT) {
            return TEXTE.get(wert.get("umgekehrt").booleanValue() ? "ja" : "nein");
        }
        String text = a.text();
        for (String f : a.felder()) {
            text = text.replace("{" + f + "}", zahlText(wert.get(f).decimalValue()));
        }
        return text;
    }

    /** Dieselben Felder mit denselben Werten — Zahlen nach ihrem Wert (600 = 600.0). */
    public static boolean gleicherWert(JsonNode a, JsonNode b) {
        if (a == null || b == null || !a.isObject() || !b.isObject() || !felder(a).equals(felder(b))) {
            return false;
        }
        for (String f : felder(a)) {
            JsonNode x = a.get(f);
            JsonNode y = b.get(f);
            if (x.isNumber() && y.isNumber()) {
                if (x.decimalValue().compareTo(y.decimalValue()) != 0) {
                    return false;
                }
            } else if (!x.equals(y)) {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------ Fassung

    /** Eine bestehende Fassung derselben Quelle und Art. */
    public record Bestehende(String id, JsonNode wert, String anwendung, Instant gueltigAb, Instant gueltigBis) {}

    /** Die neue Fassung, wie sie beantragt ist. */
    public record Neu(String art, JsonNode wert, String anwendung, Instant gueltigAb, Instant tatsaechlichAb) {}

    /**
     * @param beginn Beginn der Quelle — der Einbau ({@code eingebaut_am}) bzw. die Speisung der
     *     Komponente durch ihn ({@code gueltig_ab})
     * @param ende ihr Ende ({@code ausgebaut_am} bzw. das Ende der Speisung); {@code null} = offen
     */
    public record Eingang(Instant beginn, Instant ende, List<Bestehende> bestehende, Neu neu, Instant jetzt) {}

    /** Die Fassung, die die neue beendet, und ab wann. */
    public record Beendet(String id, Instant gueltigBis) {}

    /**
     * Das Urteil: entweder {@code fehler}, oder der Plan — die zu {@code gueltigAb} gültige Fassung
     * endet dort ({@code beendet}), die neue gilt {@code [gueltigAb, gueltigBis)}.
     */
    public record Urteil(Fehler fehler, Beendet beendet, Instant gueltigAb, Instant gueltigBis,
            Boolean rueckwirkend, Bestehende vorgaenger) {

        public boolean ok() {
            return fehler == null;
        }

        static Urteil abgelehnt(Fehler f) {
            return new Urteil(f, null, null, null, null, null);
        }
    }

    /**
     * Legt eine neue Fassung zwischen die bestehenden derselben Quelle und Art — Prüfreihenfolge:
     * Wert → Zeitpunkt auf der Minute → vor Beginn → am oder nach dem Ende → tatsächlich-Zeitpunkt
     * → Beginn belegt → unverändert. Die neue beendet die zu ihrem Beginn gültige genau dort und
     * gilt bis zum Beginn der nächsten späteren (höchstens bis zum Ende der Quelle).
     */
    public static Urteil neueFassung(Eingang e) {
        Neu neu = e.neu();
        if (!wertGueltig(neu.art(), neu.wert())) {
            return Urteil.abgelehnt(Fehler.WERT_UNGUELTIG);
        }
        if (!aufMinute(neu.gueltigAb()) || (neu.tatsaechlichAb() != null && !aufMinute(neu.tatsaechlichAb()))) {
            return Urteil.abgelehnt(Fehler.ZEITPUNKT_UNGUELTIG);
        }
        if (neu.gueltigAb().isBefore(e.beginn())) {
            return Urteil.abgelehnt(Fehler.VOR_BEGINN);
        }
        if (e.ende() != null && !neu.gueltigAb().isBefore(e.ende())) {
            return Urteil.abgelehnt(Fehler.NACH_ENDE);
        }
        if (neu.tatsaechlichAb() != null && (!neu.tatsaechlichAb().isBefore(neu.gueltigAb())
                || neu.tatsaechlichAb().isBefore(e.beginn()))) {
            return Urteil.abgelehnt(Fehler.TATSAECHLICH_UNGUELTIG);
        }
        for (Bestehende b : e.bestehende()) {
            if (b.gueltigAb().equals(neu.gueltigAb())) {
                return Urteil.abgelehnt(Fehler.BEGINN_BELEGT);
            }
        }
        Bestehende vorgaenger = gueltigZu(e.bestehende(), neu.gueltigAb());
        if (vorgaenger != null && gleicherWert(vorgaenger.wert(), neu.wert())
                && vorgaenger.anwendung().equals(neu.anwendung())) {
            return Urteil.abgelehnt(Fehler.UNVERAENDERT);
        }
        Instant bis = e.bestehende().stream().map(Bestehende::gueltigAb)
                .filter(ab -> ab.isAfter(neu.gueltigAb())).min(Comparator.naturalOrder()).orElse(null);
        if (e.ende() != null && (bis == null || bis.isAfter(e.ende()))) {
            bis = e.ende();
        }
        boolean rueckwirkend = neu.gueltigAb().isBefore(e.jetzt().truncatedTo(ChronoUnit.MINUTES));
        Beendet beendet = vorgaenger == null ? null : new Beendet(vorgaenger.id(), neu.gueltigAb());
        return new Urteil(null, beendet, neu.gueltigAb(), bis, rueckwirkend, vorgaenger);
    }

    /** Die Fassung, die zu {@code t} gilt ({@code ab <= t < bis}); {@code null}, wenn keine. */
    public static Bestehende gueltigZu(List<Bestehende> fassungen, Instant t) {
        for (Bestehende b : fassungen) {
            if (!b.gueltigAb().isAfter(t) && (b.gueltigBis() == null || t.isBefore(b.gueltigBis()))) {
                return b;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ Folgen

    /** Die Fassung, die vorher galt — ihr Wert steht im Folgen-Satz. */
    public record Vorgaenger(JsonNode wert, String anwendung) {}

    /**
     * Die Folgen-Karte (AP-04 §5.7, A5) als Kundensätze: was unverändert bleibt, welcher Zeitraum
     * womit erfasst ist, und wie die Fassung wirkt. Sie nennen nie eine Neuberechnung — es gibt keine.
     */
    public static List<String> folgen(String art, String herkunft, JsonNode wert, String anwendung,
            Instant gueltigAb, Instant tatsaechlichAb, Vorgaenger vorgaenger) {
        List<String> saetze = new ArrayList<>();
        saetze.add(TEXTE.get("werte_bleiben").replace("{ab}", zeitpunktText(gueltigAb)));
        if (tatsaechlichAb != null) {
            String vorlage = vorgaenger == null ? TEXTE.get("zeitraum_ohne") : TEXTE.get("zeitraum_mit")
                    .replace("{wert}", wertText(art, vorgaenger.wert()));
            saetze.add(vorlage.replace("{von}", zeitpunktText(tatsaechlichAb))
                    .replace("{bis}", zeitpunktText(gueltigAb)));
        } else {
            Art a = Art.von(art);
            saetze.add(TEXTE.get(a != null && a.istWandler() ? "frueher_wandler" : "frueher_einstellung"));
        }
        if (DOKUMENTIERT.equals(anwendung)) {
            saetze.add(TEXTE.get("dokumentiert"));
        } else if (EINTRAG.equals(herkunft)) {
            saetze.add(TEXTE.get("zustellung_ausstehend"));
        } else {
            saetze.add(TEXTE.get("mit_verbindung"));
        }
        return saetze;
    }

    /** „15.01.2027, 09:00 Uhr" — und um Mitternacht nur der Tag, „01.02.2027"; in Europe/Berlin. */
    public static String zeitpunktText(Instant t) {
        ZonedDateTime z = t.atZone(ZEITZONE);
        String tag = z.format(DateTimeFormatter.ofPattern("dd.MM.yyyy"));
        if (z.getHour() == 0 && z.getMinute() == 0) {
            return TEXTE.get("zeitpunkt_tag").replace("{tag}", tag);
        }
        return TEXTE.get("zeitpunkt_minute").replace("{tag}", tag)
                .replace("{stunde}", String.format("%02d", z.getHour()))
                .replace("{minute}", String.format("%02d", z.getMinute()));
    }

    // ------------------------------------------------------------------ Anzeige

    /** geplant (beginnt später) · gueltig · beendet (ab {@code bis}). */
    public static String status(Instant ab, Instant bis, Instant jetzt) {
        if (jetzt.isBefore(ab)) {
            return "geplant";
        }
        return bis != null && !jetzt.isBefore(bis) ? "beendet" : "gueltig";
    }

    /**
     * {@code verbindung}: die Box wendet die Fassung heute mit der Verbindung an; {@code ausstehend}:
     * angewendet eingetragen, die Zustellung (AP-06) steht aus; {@code null}: dokumentiert.
     */
    public static String zustellung(String anwendung, String herkunft) {
        if (!ANGEWENDET.equals(anwendung)) {
            return null;
        }
        return EINTRAG.equals(herkunft) ? "ausstehend" : "verbindung";
    }

    /** „angewendet — Zustellung ausstehend" bzw. „im Gerät eingestellt — dokumentiert". */
    public static String anwendungText(String anwendung, String herkunft) {
        String z = zustellung(anwendung, herkunft);
        if (z == null) {
            return TEXTE.get("anwendung_dokumentiert");
        }
        return TEXTE.get("ausstehend".equals(z) ? "anwendung_ausstehend" : "anwendung_verbindung");
    }

    // ------------------------------------------------------------------ Verbindung

    /** Eine Fassung, die die Verbindung einer Komponente enthält: Kanal ({@code null} = die Komponente), Art, Wert. */
    public record Abgeleitet(String kanal, String art, JsonNode wert) {}

    /**
     * Die Einstellungen, die die heutige Verbindung einer Komponente schon trägt — die Fassung 1 der
     * Bestands-Ableitung (SQL-Zwilling {@code uems_einstellungen_aus_verbindung}). Nur was genau in
     * der Form steht, die die Box liest; eine Stufe außerhalb der Auswahl oder ein Wahrheitswert als
     * Text wird nie geraten.
     */
    public static List<Abgeleitet> ausVerbindung(String kommunikation, JsonNode verbindung) {
        List<Abgeleitet> out = new ArrayList<>();
        if (verbindung == null || !verbindung.isObject()) {
            return out;
        }
        if (SELBSTBAU_KOMMUNIKATION.equals(kommunikation)) {
            JsonNode kanaele = verbindung.get("channels");
            if (kanaele == null || !kanaele.isArray()) {
                return out;
            }
            for (JsonNode c : kanaele) {
                JsonNode slug = c.get("slug");
                if (!c.isObject() || slug == null || !slug.isTextual() || slug.textValue().isBlank()) {
                    continue;
                }
                JsonNode faktor = c.get("scale");
                if (zahl(faktor) && faktor.decimalValue().signum() != 0) {
                    out.add(new Abgeleitet(slug.textValue(), Art.SKALIERUNG.code(),
                            objekt().set("faktor", zahlKnoten(faktor))));
                }
                JsonNode offset = c.get("offset");
                JsonNode einheit = c.get("unit");
                String e = einheit != null && einheit.isTextual() ? einheit.textValue() : "";
                if (zahl(offset) && e.length() <= EINHEIT_MAX_ZEICHEN) {
                    ObjectNode w = objekt();
                    w.set("wert", zahlKnoten(offset));
                    w.put("einheit", e);
                    out.add(new Abgeleitet(slug.textValue(), Art.OFFSET.code(), w));
                }
            }
            return out;
        }
        Integer stufe = leistungsskalierung(verbindung.get("power_scale"));
        if (stufe != null) {
            out.add(new Abgeleitet(null, Art.SKALIERUNG.code(), stufe == 0
                    ? objekt().put("automatisch", true) : objekt().put("faktor", stufe)));
        }
        for (Map.Entry<String, String> k : VERBINDUNGS_KANAELE.entrySet()) {
            JsonNode flag = verbindung.get(k.getKey());
            if (flag != null && flag.isBoolean()) {
                out.add(new Abgeleitet(k.getValue(), Art.VORZEICHEN_UMGEKEHRT.code(),
                        objekt().put("umgekehrt", flag.booleanValue())));
            }
        }
        return out;
    }

    /**
     * Was eine Änderung der Verbindung an Einstellungen ändert: jede Fassung der neuen Verbindung,
     * deren Wert die alte nicht (oder anders) trug. Ein entferntes Feld schreibt nichts.
     */
    public static List<Abgeleitet> aenderungen(String kommunikation, JsonNode alt, JsonNode neu) {
        List<Abgeleitet> vorher = ausVerbindung(kommunikation, alt);
        List<Abgeleitet> out = new ArrayList<>();
        for (Abgeleitet n : ausVerbindung(kommunikation, neu)) {
            boolean gleich = vorher.stream().anyMatch(v -> v.art().equals(n.art())
                    && java.util.Objects.equals(v.kanal(), n.kanal()) && gleicherWert(v.wert(), n.wert()));
            if (!gleich) {
                out.add(n);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ Gerüst

    private static Integer leistungsskalierung(JsonNode n) {
        if (n == null) {
            return null;
        }
        if (n.isNumber()) {
            BigDecimal d = n.decimalValue().stripTrailingZeros();
            if (d.scale() <= 0) {
                for (Integer s : LEISTUNGSSKALIERUNG_STUFEN) {
                    if (d.compareTo(BigDecimal.valueOf(s)) == 0) {
                        return s;
                    }
                }
            }
            return null;
        }
        if (n.isTextual()) {
            for (Integer s : LEISTUNGSSKALIERUNG_STUFEN) {
                if (String.valueOf(s).equals(n.textValue())) {
                    return s;
                }
            }
        }
        return null;
    }

    private static boolean aufMinute(Instant t) {
        return t.getNano() == 0 && t.getEpochSecond() % 60 == 0;
    }

    private static boolean zahl(JsonNode n) {
        return n != null && n.isNumber() && n.decimalValue().abs().compareTo(ZAHL_GRENZE) <= 0;
    }

    private static boolean positiv(JsonNode n) {
        return zahl(n) && n.decimalValue().signum() > 0;
    }

    private static Set<String> felder(JsonNode objekt) {
        Set<String> out = new TreeSet<>();
        Iterator<String> it = objekt.fieldNames();
        it.forEachRemaining(out::add);
        return out;
    }

    private static ObjectNode objekt() {
        return JsonNodeFactory.instance.objectNode();
    }

    /** Die Zahl so, wie sie steht — nie über einen double umgerechnet. */
    private static JsonNode zahlKnoten(JsonNode n) {
        return JsonNodeFactory.instance.numberNode(n.decimalValue().stripTrailingZeros().scale() <= 0
                ? n.decimalValue().setScale(0, java.math.RoundingMode.UNNECESSARY)
                : n.decimalValue().stripTrailingZeros());
    }

    /** „1.000", „12,5", „-2", „0,001" — Tausenderpunkt, Dezimalkomma, keine überflüssige Null. */
    static String zahlText(BigDecimal zahl) {
        String plain = zahl.signum() == 0 ? "0" : zahl.stripTrailingZeros().toPlainString();
        boolean negativ = plain.startsWith("-");
        if (negativ) {
            plain = plain.substring(1);
        }
        int punkt = plain.indexOf('.');
        String ganz = punkt < 0 ? plain : plain.substring(0, punkt);
        String rest = punkt < 0 ? "" : plain.substring(punkt + 1);
        StringBuilder g = new StringBuilder();
        for (int i = 0; i < ganz.length(); i++) {
            if (i > 0 && (ganz.length() - i) % 3 == 0) {
                g.append('.');
            }
            g.append(ganz.charAt(i));
        }
        return (negativ ? "-" : "") + g + (rest.isEmpty() ? "" : "," + rest);
    }

    private static Map<String, String> verbindungsKanaele() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("invert_grid_sign", "power_kw");
        m.put("invert_batt_sign", "battery_power_kw");
        return java.util.Collections.unmodifiableMap(m);
    }

    private static Map<String, String> texte() {
        Map<String, String> t = new LinkedHashMap<>();
        t.put("werte_bleiben", "Werte vor dem {ab} bleiben unverändert.");
        t.put("zeitraum_mit", "Der Zeitraum vom {von} bis {bis} ist mit {wert} erfasst. Berichtigen Sie ihn "
                + "über eine Korrektur, sobald Korrekturen verfügbar sind.");
        t.put("zeitraum_ohne", "Der Zeitraum vom {von} bis {bis} ist ohne diese Einstellung erfasst. "
                + "Berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.");
        t.put("frueher_wandler", "Wenn der Wandler schon früher getauscht wurde, ist der Zeitraum dazwischen "
                + "falsch erfasst — berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.");
        t.put("frueher_einstellung", "Wenn die Einstellung schon früher geändert wurde, ist der Zeitraum "
                + "dazwischen falsch erfasst — berichtigen Sie ihn über eine Korrektur, sobald Korrekturen "
                + "verfügbar sind.");
        t.put("dokumentiert", "VoltPilot rechnet nichts um — das Gerät wendet die Einstellung selbst an.");
        t.put("zustellung_ausstehend", "Die Zustellung an die VoltPilot-Box steht noch aus; bis dahin erfasst "
                + "sie wie bisher. Bereits erfasste Werte berechnet VoltPilot nie neu.");
        t.put("mit_verbindung", "Die VoltPilot-Box wendet die Einstellung mit der Verbindung der Komponente "
                + "an. Bereits erfasste Werte berechnet VoltPilot nie neu.");
        t.put("anwendung_dokumentiert", "im Gerät eingestellt — dokumentiert");
        t.put("anwendung_ausstehend", "angewendet — Zustellung ausstehend");
        t.put("anwendung_verbindung", "angewendet — mit der Verbindung zugestellt");
        t.put("automatisch", "automatisch");
        t.put("ja", "ja");
        t.put("nein", "nein");
        t.put("zeitpunkt_tag", "{tag}");
        t.put("zeitpunkt_minute", "{tag}, {stunde}:{minute} Uhr");
        return java.util.Collections.unmodifiableMap(t);
    }
}
