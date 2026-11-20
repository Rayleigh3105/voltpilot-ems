package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Das VoltPilot-Koppelbild v1 aus Sicht der Cloud (PFC200 Stufe 4, {@code docs/contracts/v2/koppelbild.md} §7 und
 * §15): die Wörter des Vertrags, der Herzschlag-Block {@code koppel} der Box, die Form eines Angebots, an der eine
 * Freigabe hängt, und die Fähigkeit {@code actuate}, die ein freigegebener Stellplatz im Registry-Push trägt. Rein:
 * keine Datenbank, keine Uhr.
 *
 * <p><b>Anzeige, nie Soll-Stand.</b> Der Block {@code koppel} sagt, was die Box sah und was die SPS quittierte; die
 * Cloud übernimmt daraus nichts in den Soll-Stand außer dem Wegfall einer Freigabe, deren Angebot sich geändert hat.
 * Gelesen wird nur, was der Vertrag kennt, in seinen Grenzen; ein unbekanntes Wort ist kein Wert (null, nie 0), ein
 * Eintrag ohne gültige Steuerung oder Lage fällt ganz weg.
 *
 * <p>Werte des Bilds sind ganze Einheiten: {@code limit_w}/{@code setpoint_w} W, {@code limit_pct} 0,1 %,
 * {@code on_off} 0/1, {@code mode} 1 … 8, {@code setpoint_c} 0,1 °C. Der Schiedsrichter der Box rechnet in kW, %, °C
 * und Betriebsart-Wörtern; die Box rechnet beim Schreiben zurück (§15, halb vom Nullpunkt weg).
 */
public final class Koppelbild {

    /** Das Fähigkeitswort der Box (edge-supports.md): nur Edge Light liest und schreibt das Koppelbild. */
    public static final String FAEHIGKEIT = "koppelbild";
    /** Stellplätze je Fassung 1.0. */
    public static final int PLAETZE = 8;
    /** So lange gilt ein Testwunsch des Schalt-Tests (§15: 30 s). */
    public static final int TEST_TTL_S = 30;
    /** Höchstens so viele Steuerungen je Block; mehr verwirft der Leser. */
    static final int MAX_STEUERUNGEN = 16;

    public static final List<String> LAGEN = List.of("bereit", "gesperrt", "sps_neustart", "sps_steht",
            "zweiter_schreiber", "steuerung_fremd", "nicht_lesbar", "keine_antwort", "ohne_soll");
    public static final List<String> KOPF_URTEILE = List.of("keins", "angenommen", "signatur_fremd", "version_fremd",
            "wortfolge_falsch", "siegel_falsch", "steuerung_fremd", "kopf_ungueltig", "abgelaufen", "gesperrt");
    public static final List<String> Q_URTEILE = List.of("kein_wunsch", "angenommen", "begrenzt", "art_fremd",
            "wert_ungueltig", "nicht_bereit", "ueberstimmt", "abgelaufen");
    public static final List<String> ZIELE = List.of("erzeugung_gesamt", "erzeugungseinheit", "speicher",
            "verbraucher", "netzbezug", "einspeisung", "probe");
    public static final List<String> GRUENDE = List.of("keiner", "markt", "netz", "regel", "hand", "test");
    public static final List<String> Q_BITS = List.of("fernsteuerung_frei", "edge_lebt", "hand_ort");
    public static final List<String> A_BITS = List.of("bereit", "grund_stoerung", "grund_hand_ort", "grund_wartung",
            "grund_vorrang", "grund_sonstiger");

    /** Art des Angebots → Kommando des Schiedsrichters der Box (§15). */
    public static final Map<String, String> KOMMANDO = kommandos();

    /** Ein Schalt-Test gilt als bestanden, wenn die SPS den Testwunsch zu genau seiner Folge so quittiert. */
    public static final Set<String> TEST_ANGENOMMEN = Set.of("angenommen", "begrenzt", "ueberstimmt");

    /** Lagen, in denen die Steuerung keine Telegramme der Box annimmt (Alarm „Steuerung nimmt Wünsche nicht an“). */
    public static final Set<String> NIMMT_NICHT_AN_LAGEN = Set.of("steuerung_fremd", "nicht_lesbar", "sps_steht",
            "keine_antwort", "ohne_soll");
    /** Urteile über das Telegramm, mit denen es nichts bewirkt hat (§5 Gründe 1 bis 6). */
    public static final Set<String> NIMMT_NICHT_AN_KOPF = Set.of("signatur_fremd", "version_fremd",
            "wortfolge_falsch", "siegel_falsch", "steuerung_fremd", "kopf_ungueltig");

    /** Das Typ-Maximum S32 ist kein Wert. */
    static final long S32_MIN = -2_147_483_647L;
    static final long S32_MAX = 2_147_483_646L;

    private static final Pattern BIBLIOTHEK = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})$");
    private static final Pattern WORT = Pattern.compile("^[a-z][a-z0-9_]{0,63}$");
    private static final Pattern KENNZEICHEN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

    private Koppelbild() {
    }

    private static Map<String, String> kommandos() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("limit_w", "limit_kw");
        m.put("limit_pct", "limit_pct");
        m.put("setpoint_w", "setpoint_kw");
        m.put("on_off", "on_off");
        m.put("mode", "mode");
        m.put("setpoint_c", "setpoint_c");
        return java.util.Collections.unmodifiableMap(m);
    }

    /** Das Kommando zu einer Art; null für eine unbekannte Art. */
    public static String kommando(String art) {
        return art == null ? null : KOMMANDO.get(art);
    }

    // ------------------------------------------------------------------ die Form eines Angebots

    /**
     * Die Form eines Angebots: Art, Ziel, Nummer und Band in den ganzen Einheiten des Bilds. An ihr hängen Test-Beleg
     * und Freigabe - ändert das Anlagenprogramm eines davon, ist es eine andere Zusage.
     */
    public record Angebot(String art, String ziel, int nr, long min, long max) {

        /** Liegt ein Testwert im Band? */
        public boolean imBand(long wert) {
            return wert >= min && wert <= max;
        }

        public String kommando() {
            return Koppelbild.kommando(art);
        }
    }

    /**
     * Passt das Band in das natürliche Band seiner Art und ist es nicht verkehrt (§7, K27)? Sonst nimmt die Box das
     * Angebot nicht als Fähigkeit, und die Cloud auch nicht.
     */
    public static boolean bandGueltig(String art, long min, long max) {
        if (min > max || min < S32_MIN || max > S32_MAX) {
            return false;
        }
        return switch (art) {
            case "limit_w" -> min >= 0;
            case "limit_pct" -> min >= 0 && max <= 1000;
            case "on_off" -> min >= 0 && max <= 1;
            case "mode" -> min >= 1 && max <= 8;
            case "setpoint_w", "setpoint_c" -> true;
            default -> false;
        };
    }

    /**
     * Die Fähigkeit {@code actuate} eines freigegebenen Stellplatzes im Registry-Push (§15, edge-entity
     * {@code platz}): das Kommando des Schiedsrichters, der Stellplatz, das Ziel des Angebots (die Box gibt die
     * Erzeugungsgrenze des Fahrplans nur an {@code limit_kw} auf {@code erzeugung_gesamt}) und das Band in den Einheiten des
     * Schiedsrichters - W als kW, 0,1 % als %, 0,1 °C als °C mit Schritt 0,1, eine Betriebsart als Wörter „1“ bis „8“
     * im Band, ein/aus ohne Band.
     */
    public static ObjectNode faehigkeit(ObjectMapper json, int platz, Angebot a) {
        ObjectNode cap = json.createObjectNode();
        cap.put("command", kommando(a.art()));
        cap.put("platz", platz);
        cap.put("ziel", a.ziel());
        switch (a.art()) {
            case "limit_w", "setpoint_w" -> {
                cap.put("min", a.min() / 1000.0);
                cap.put("max", a.max() / 1000.0);
            }
            case "limit_pct" -> {
                cap.put("min", a.min() / 10.0);
                cap.put("max", a.max() / 10.0);
            }
            case "setpoint_c" -> {
                cap.put("min", a.min() / 10.0);
                cap.put("max", a.max() / 10.0);
                cap.put("step", 0.1);
            }
            case "mode" -> {
                ArrayNode modes = cap.putArray("modes");
                for (long m = Math.max(1, a.min()); m <= Math.min(8, a.max()); m++) {
                    modes.add(Long.toString(m));
                }
            }
            default -> {
                // on_off: aus oder ein, kein Band
            }
        }
        return cap;
    }

    // ------------------------------------------------------------------ Sätze

    /** Ein Wert des Bilds in Kundensprache: „200,0 kW“, „60,0 %“, „ein“, „Betriebsart 3“, „45,0 °C“. */
    public static String wertText(String art, long wert) {
        return switch (art) {
            case "limit_w", "setpoint_w" -> String.format(Locale.GERMANY, "%.1f kW", wert / 1000.0);
            case "limit_pct" -> String.format(Locale.GERMANY, "%.1f %%", wert / 10.0);
            case "on_off" -> wert == 0 ? "aus" : "ein";
            case "mode" -> "Betriebsart " + wert;
            case "setpoint_c" -> String.format(Locale.GERMANY, "%.1f °C", wert / 10.0);
            default -> Long.toString(wert);
        };
    }

    /** Das Band eines Angebots in Kundensprache: „0,0 kW bis 265,0 kW“. */
    public static String bandText(Angebot a) {
        return wertText(a.art(), a.min()) + " bis " + wertText(a.art(), a.max());
    }

    // ------------------------------------------------------------------ Bibliothek

    /** Die Fassung „H.N“ als Wort 0xHHNN; null, wenn sie fehlt oder nicht lesbar ist. */
    public static Integer bibliothek(String text) {
        if (text == null) {
            return null;
        }
        var m = BIBLIOTHEK.matcher(text);
        if (!m.matches()) {
            return null;
        }
        int haupt = Integer.parseInt(m.group(1));
        int neben = Integer.parseInt(m.group(2));
        return haupt > 255 || neben > 255 ? null : (haupt << 8) | neben;
    }

    /** „1.0“ aus 0x0100. */
    public static String bibliothekText(int wort) {
        return (wort >> 8) + "." + (wort & 0xFF);
    }

    // ------------------------------------------------------------------ der Herzschlag-Block

    /** Ein Stellplatz im Block: Angebot (mit Bits) oder keines, Wunsch der Box, Quittung der SPS. */
    public record Platz(int platz, Angebot angebot, List<String> bits, Wunsch wunsch, boolean test, String urteil,
            Integer folge, Long wirksam) {
    }

    /** Der Wunsch der Box auf einem Stellplatz; {@code grund} null = ein Wort, das der Vertrag nicht kennt. */
    public record Wunsch(String art, String grund, long wert, int folge) {
    }

    /**
     * Der Stand EINER Steuerung im Block. Ohne lesbare Lesung ({@code gelesenAt == null}) sind Kopf und Stellplätze
     * null; {@code qBits == null} heißt „nicht gelesen“, nie „alle aus“.
     */
    public record Stand(String dataSourceId, String lage, String grund, Instant gelesenAt, String bibliothek,
            String kopfUrteil, Integer restS, List<String> qBits, Integer angenommenZaehler,
            Integer abgelehntZaehler, List<Platz> plaetze) {

        /** Ein Stellplatz des Stands; null, wenn er nicht darin steht (oder ohne lesbare Lesung). */
        public Platz platz(int nr) {
            if (plaetze == null) {
                return null;
            }
            return plaetze.stream().filter(p -> p.platz() == nr).findFirst().orElse(null);
        }

        /** Das Angebot eines Stellplatzes; null ohne eines. */
        public Angebot angebot(int nr) {
            Platz p = platz(nr);
            return p == null ? null : p.angebot();
        }
    }

    /** Ein Eintrag des Blocks, wie er gespeichert wird: die Komponente der Steuerung und ihr bereinigter Stand. */
    public record Eintrag(UUID steuerung, Stand stand) {
    }

    /**
     * Liest den Block {@code koppel}: höchstens {@value #MAX_STEUERUNGEN} Steuerungen, jede nur einmal. {@code null},
     * wenn der Herzschlag keinen Block trägt (eine ältere Box, ein anderes Programm) - dann bleibt der gespeicherte
     * Stand stehen; eine leere Liste heißt „keine Steuerung mit Erzeuger-Plan“.
     */
    public static List<Eintrag> lies(JsonNode block) {
        if (block == null || !block.isArray()) {
            return null;
        }
        List<Eintrag> out = new ArrayList<>();
        Set<UUID> gesehen = new HashSet<>();
        for (JsonNode e : block) {
            if (out.size() >= MAX_STEUERUNGEN) {
                break;
            }
            UUID steuerung = uuid(e.path("steuerung").asText(null));
            Stand s = stand(e);
            if (steuerung == null || s == null || !gesehen.add(steuerung)) {
                continue;
            }
            out.add(new Eintrag(steuerung, s));
        }
        return out;
    }

    /** Der Stand eines Eintrags (auch eines gespeicherten) - null ohne gültige Lage. */
    public static Stand stand(JsonNode e) {
        if (e == null || !e.isObject()) {
            return null;
        }
        String lage = e.path("lage").asText("");
        if (!LAGEN.contains(lage)) {
            return null;
        }
        String ds = e.path("data_source_id").asText(null);
        String grund = e.path("grund").asText(null);
        Instant gelesen = instant(e.path("gelesen_at").asText(null));
        String bibliothek = e.path("bibliothek").isTextual() && bibliothek(e.path("bibliothek").asText()) != null
                ? e.path("bibliothek").asText() : null;
        List<Platz> plaetze = null;
        JsonNode pl = e.get("plaetze");
        if (pl != null && pl.isArray()) {
            plaetze = new ArrayList<>();
            Set<Integer> nummern = new HashSet<>();
            for (JsonNode p : pl) {
                Platz platz = platz(p);
                if (platz != null && nummern.add(platz.platz())) {
                    plaetze.add(platz);
                }
            }
            plaetze.sort(java.util.Comparator.comparingInt(Platz::platz));
            plaetze = List.copyOf(plaetze);
        }
        return new Stand(ds != null && KENNZEICHEN.matcher(ds).matches() ? ds : null, lage,
                grund != null && WORT.matcher(grund).matches() ? grund : null, gelesen, bibliothek,
                wort(e.path("kopf_urteil"), KOPF_URTEILE), zahl(e.path("rest_s"), 0, 65534),
                woerter(e.get("q_bits"), Q_BITS), zahl(e.path("angenommen_zaehler"), 0, 65535),
                zahl(e.path("abgelehnt_zaehler"), 0, 65535), plaetze);
    }

    private static Platz platz(JsonNode p) {
        if (p == null || !p.isObject()) {
            return null;
        }
        Integer nr = zahl(p.path("platz"), 1, PLAETZE);
        if (nr == null) {
            return null;
        }
        Angebot angebot = null;
        List<String> bits = null;
        JsonNode a = p.get("angebot");
        if (a != null && a.isObject()) {
            String art = a.path("art").asText("");
            String ziel = a.path("ziel").asText("");
            Integer anr = zahl(a.path("nr"), 0, 65535);
            Long min = grosszahl(a.path("min"));
            Long max = grosszahl(a.path("max"));
            if (KOMMANDO.containsKey(art) && ZIELE.contains(ziel) && anr != null && min != null && max != null
                    && bandGueltig(art, min, max)) {
                angebot = new Angebot(art, ziel, anr, min, max);
                bits = woerter(a.get("bits"), A_BITS);
                if (bits == null) {
                    bits = List.of();
                }
            }
        }
        Wunsch wunsch = null;
        JsonNode w = p.get("wunsch");
        if (w != null && w.isObject()) {
            String art = w.path("art").asText("");
            Long wert = grosszahl(w.path("wert"));
            Integer folge = zahl(w.path("folge"), 0, 65535);
            if (KOMMANDO.containsKey(art) && wert != null && folge != null) {
                wunsch = new Wunsch(art, wort(w.path("grund"), GRUENDE), wert, folge);
            }
        }
        return new Platz(nr, angebot, bits, wunsch, p.path("test").asBoolean(false), wort(p.path("urteil"), Q_URTEILE),
                zahl(p.path("folge"), 0, 65535), grosszahl(p.path("wirksam")));
    }

    /** Der Stand als JSON, wie er gespeichert wird - nur bekannte Felder, ein fehlender Wert fehlt. */
    public static ObjectNode json(ObjectMapper mapper, Stand s) {
        ObjectNode o = mapper.createObjectNode();
        if (s.dataSourceId() != null) o.put("data_source_id", s.dataSourceId());
        o.put("lage", s.lage());
        if (s.grund() != null) o.put("grund", s.grund());
        if (s.gelesenAt() != null) o.put("gelesen_at", s.gelesenAt().toString());
        if (s.bibliothek() != null) o.put("bibliothek", s.bibliothek());
        if (s.kopfUrteil() != null) o.put("kopf_urteil", s.kopfUrteil());
        if (s.restS() != null) o.put("rest_s", s.restS());
        if (s.qBits() != null) {
            ArrayNode q = o.putArray("q_bits");
            s.qBits().forEach(q::add);
        }
        if (s.angenommenZaehler() != null) o.put("angenommen_zaehler", s.angenommenZaehler());
        if (s.abgelehntZaehler() != null) o.put("abgelehnt_zaehler", s.abgelehntZaehler());
        if (s.plaetze() != null) {
            ArrayNode pl = o.putArray("plaetze");
            for (Platz p : s.plaetze()) {
                ObjectNode n = pl.addObject();
                n.put("platz", p.platz());
                if (p.angebot() != null) {
                    ObjectNode a = n.putObject("angebot");
                    a.put("art", p.angebot().art());
                    a.put("ziel", p.angebot().ziel());
                    a.put("nr", p.angebot().nr());
                    a.put("min", p.angebot().min());
                    a.put("max", p.angebot().max());
                    ArrayNode b = a.putArray("bits");
                    p.bits().forEach(b::add);
                }
                if (p.wunsch() != null) {
                    ObjectNode w = n.putObject("wunsch");
                    w.put("art", p.wunsch().art());
                    if (p.wunsch().grund() != null) w.put("grund", p.wunsch().grund());
                    w.put("wert", p.wunsch().wert());
                    w.put("folge", p.wunsch().folge());
                }
                n.put("test", p.test());
                if (p.urteil() != null) n.put("urteil", p.urteil());
                if (p.folge() != null) n.put("folge", p.folge());
                if (p.wirksam() != null) n.put("wirksam", p.wirksam());
            }
        }
        return o;
    }

    /**
     * Hat sich das Angebot eines Stellplatzes gegenüber der Form einer Freigabe geändert? Nur ein Stand, der die
     * Stellplätze überhaupt kennt, urteilt - ohne lesbare Lesung ist es unbekannt, nie „weg“; ebenso, wenn eine fremde
     * Steuerung antwortet (ihr Angebot ist nicht das dieser Anlage). In einem lesbaren Stand ist ein fehlender
     * Stellplatz ein weggefallenes Angebot.
     */
    public static boolean angebotGeaendert(Stand s, int platz, Angebot form) {
        if (s == null || s.plaetze() == null || "steuerung_fremd".equals(s.lage())) {
            return false;
        }
        return !form.equals(s.angebot(platz));
    }

    // ------------------------------------------------------------------ Hilfen

    private static String wort(JsonNode n, List<String> vokabular) {
        return n != null && n.isTextual() && vokabular.contains(n.asText()) ? n.asText() : null;
    }

    /** Die bekannten Wörter einer Liste, in der Reihenfolge des Vertrags; null, wenn keine Liste da ist. */
    private static List<String> woerter(JsonNode n, List<String> vokabular) {
        if (n == null || !n.isArray()) {
            return null;
        }
        Set<String> da = new HashSet<>();
        n.forEach(x -> {
            if (x.isTextual()) da.add(x.asText());
        });
        return vokabular.stream().filter(da::contains).toList();
    }

    private static Integer zahl(JsonNode n, int min, int max) {
        if (n == null || !n.isIntegralNumber() || !n.canConvertToInt()) {
            return null;
        }
        int v = n.asInt();
        return v >= min && v <= max ? v : null;
    }

    private static Long grosszahl(JsonNode n) {
        if (n == null || !n.isIntegralNumber() || !n.canConvertToLong()) {
            return null;
        }
        long v = n.asLong();
        return v >= S32_MIN && v <= S32_MAX ? v : null;
    }

    private static UUID uuid(String s) {
        try {
            return s == null ? null : UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static Instant instant(String s) {
        try {
            return s == null ? null : Instant.parse(s);
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
