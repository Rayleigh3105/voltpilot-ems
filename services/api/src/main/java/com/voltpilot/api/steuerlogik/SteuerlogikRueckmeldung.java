package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.SteuerlogikRepository;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Liest den Block {@code logik} eines Herzschlags nach {@code docs/contracts/v2/steuerlogik-rueckmeldung.md}: nur
 * bekannte Felder in ihren Grenzen, alles andere fällt weg. Ein Lauf ohne gültige Identität (flow_id, Fassung,
 * Hash, Zustand, seit) fällt ganz weg; eine einzelne kaputte Zeile des Protokolls oder ein kaputtes Gerät nur für
 * sich. Gespeichert wird je Lauf die bereinigte Form ohne das Protokoll; das Protokoll geht zeilenweise in die
 * eigene Tabelle. Die Vektoren stehen in {@code steuerlogik-rueckmeldung-vectors.json}.
 */
public final class SteuerlogikRueckmeldung {

    /** Grenzen des Vertrags. */
    static final int MAX_LAEUFE = 8;
    static final int MAX_WECHSEL = 16;
    static final int MAX_GERAETE = 16;
    static final int MAX_ZUSTAENDE = 64;
    static final int MAX_UNBEKANNT = 32;
    static final int MAX_SEKUNDEN = 2 * 86400;
    static final int MAX_WECHSEL_JE_TAG = 100000;

    private static final Set<String> ZUSTAENDE = Set.of("mitlaufend");
    private static final Set<String> WAS = Set.of("wunsch", "ist");
    /** Die Arten einer Lage-Zeile (steuerlogik.schema.json, status[].type). */
    private static final Set<String> LAGE_ARTEN = Set.of("solar", "grid", "waiting", "idle", "fault");
    private static final Pattern HASH = Pattern.compile("^sha256:[0-9a-f]{64}$");
    private static final Pattern KENNUNG = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");
    private static final Pattern ENTITY = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

    private SteuerlogikRueckmeldung() {
    }

    /** Was aus einem Block hervorgeht: die Läufe und die Zeilen des Protokolls. */
    public record Gelesen(List<SteuerlogikRepository.Lauf> laeufe, List<SteuerlogikRepository.Wechsel> wechsel) {}

    public static Gelesen lies(JsonNode block, UUID deviceId, ObjectMapper mapper) {
        List<SteuerlogikRepository.Lauf> laeufe = new ArrayList<>();
        List<SteuerlogikRepository.Wechsel> wechsel = new ArrayList<>();
        JsonNode liste = block == null ? null : block.get("laeufe");
        if (liste == null || !liste.isArray()) return new Gelesen(laeufe, wechsel);
        Set<UUID> gesehen = new java.util.HashSet<>();
        for (JsonNode l : liste) {
            if (laeufe.size() >= MAX_LAEUFE) break;
            UUID logikId = uuid(l.path("flow_id").asText(null));
            int fassung = l.path("flow_version").isInt() ? l.path("flow_version").asInt() : 0;
            String hash = l.path("content_hash").asText("");
            String zustand = l.path("zustand").asText("");
            Instant seit = instant(l.path("seit").asText(null));
            if (logikId == null || fassung < 1 || !HASH.matcher(hash).matches() || !ZUSTAENDE.contains(zustand)
                    || seit == null || !gesehen.add(logikId)) {
                continue;
            }
            ObjectNode sauber = mapper.createObjectNode();
            sauber.put("flow_id", logikId.toString());
            sauber.put("flow_version", fassung);
            sauber.put("content_hash", hash);
            sauber.put("name", text(l.path("name"), 80));
            sauber.put("zustand", zustand);
            sauber.put("seit", seit.toString());
            String tag = l.path("tag").asText(null);
            if (tag != null && istTag(tag)) sauber.put("tag", tag);
            JsonNode lage = l.get("lage");
            if (lage != null && lage.isObject() && lage.path("titel").isTextual() && lage.path("nr").isInt()) {
                ObjectNode ln = sauber.putObject("lage");
                ln.put("nr", lage.path("nr").asInt());
                ln.put("titel", text(lage.path("titel"), 80));
                if (LAGE_ARTEN.contains(lage.path("art").asText())) ln.put("art", lage.path("art").asText());
                if (lage.path("satz").isTextual()) ln.put("satz", text(lage.path("satz"), 300));
            }
            JsonNode zst = l.get("zustaende");
            if (zst != null && zst.isObject()) {
                ObjectNode zn = sauber.putObject("zustaende");
                Iterator<Map.Entry<String, JsonNode>> it = zst.fields();
                while (it.hasNext() && zn.size() < MAX_ZUSTAENDE) {
                    Map.Entry<String, JsonNode> e = it.next();
                    if (KENNUNG.matcher(e.getKey()).matches() && e.getValue().isTextual()) {
                        zn.put(e.getKey(), text(e.getValue(), 32));
                    }
                }
            }
            JsonNode unb = l.get("unbekannt");
            if (unb != null && unb.isArray()) {
                ArrayNode un = sauber.putArray("unbekannt");
                for (JsonNode u : unb) {
                    if (un.size() >= MAX_UNBEKANNT) break;
                    if (u.isTextual() && KENNUNG.matcher(u.asText()).matches()) un.add(u.asText());
                }
            }
            sauber.put("fehler", zahl(l.path("fehler"), MAX_WECHSEL_JE_TAG));
            JsonNode ger = l.get("geraete");
            if (ger != null && ger.isObject()) {
                ObjectNode gn = sauber.putObject("geraete");
                Iterator<Map.Entry<String, JsonNode>> it = ger.fields();
                while (it.hasNext() && gn.size() < MAX_GERAETE) {
                    Map.Entry<String, JsonNode> e = it.next();
                    JsonNode g = e.getValue();
                    if (!KENNUNG.matcher(e.getKey()).matches() || !g.isObject()
                            || !ENTITY.matcher(g.path("entity_id").asText("")).matches()) {
                        continue;
                    }
                    ObjectNode one = gn.putObject(e.getKey());
                    one.put("entity_id", g.path("entity_id").asText());
                    ObjectNode w = stand(g.get("wunsch"), mapper);
                    if (w != null) one.set("wunsch", w);
                    ObjectNode i = stand(g.get("ist"), mapper);
                    if (i != null) one.set("ist", i);
                    for (String f : List.of("verglichen_s", "abweichend_s", "laengste_abweichung_s")) {
                        one.put(f, zahl(g.path(f), MAX_SEKUNDEN));
                    }
                    for (String f : List.of("wunsch_wechsel", "ist_wechsel")) {
                        one.put(f, zahl(g.path(f), MAX_WECHSEL_JE_TAG));
                    }
                }
            }
            laeufe.add(new SteuerlogikRepository.Lauf(deviceId, logikId, fassung, hash, zustand, seit,
                    sauber.toString(), null));
            JsonNode ws = l.get("wechsel");
            if (ws != null && ws.isArray()) {
                int n = 0;
                for (JsonNode w : ws) {
                    if (n++ >= MAX_WECHSEL) break;
                    long nr = w.path("nr").canConvertToLong() && w.path("nr").isIntegralNumber()
                            ? w.path("nr").asLong() : 0;
                    Instant t = instant(w.path("t").asText(null));
                    String geraet = w.path("geraet").asText("");
                    String was = w.path("was").asText("");
                    if (nr < 1 || t == null || !KENNUNG.matcher(geraet).matches() || !WAS.contains(was)) continue;
                    ObjectNode neu = stand(w.get("neu"), mapper);
                    ObjectNode andere = stand(w.get("andere"), mapper);
                    wechsel.add(new SteuerlogikRepository.Wechsel(deviceId, logikId, fassung, seit, nr, t, geraet,
                            was, neu == null ? null : neu.toString(), andere == null ? null : andere.toString(),
                            w.path("lage").isTextual() ? text(w.path("lage"), 80) : null));
                }
            }
        }
        return new Gelesen(laeufe, wechsel);
    }

    /** Ein Schaltstand: nur die bekannten Felder; leer heißt unbekannt ({@code null}). */
    static ObjectNode stand(JsonNode s, ObjectMapper mapper) {
        if (s == null || !s.isObject()) return null;
        ObjectNode out = mapper.createObjectNode();
        if (s.path("stufe").isInt() && s.path("stufe").asInt() >= 0 && s.path("stufe").asInt() <= 64) {
            out.put("stufe", s.path("stufe").asInt());
        }
        if (s.path("ein").isBoolean()) out.put("ein", s.path("ein").asBoolean());
        if (s.path("sollwert").isNumber() && Double.isFinite(s.path("sollwert").asDouble())
                && Math.abs(s.path("sollwert").asDouble()) <= 1000) {
            out.put("sollwert", s.path("sollwert").asDouble());
        }
        if (s.path("betriebsart").isTextual() && KENNUNG.matcher(s.path("betriebsart").asText()).matches()) {
            out.put("betriebsart", s.path("betriebsart").asText());
        }
        if (s.path("anteil").isNumber() && s.path("anteil").asDouble() >= 0 && s.path("anteil").asDouble() <= 100) {
            out.put("anteil", s.path("anteil").asDouble());
        }
        return out.isEmpty() ? null : out;
    }

    private static int zahl(JsonNode n, int max) {
        if (!n.isInt()) return 0;
        int v = n.asInt();
        return v < 0 ? 0 : Math.min(v, max);
    }

    private static String text(JsonNode n, int max) {
        String s = n.isTextual() ? n.asText() : "";
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static UUID uuid(String s) {
        if (s == null) return null;
        try {
            return UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static Instant instant(String s) {
        if (s == null) return null;
        try {
            return Instant.parse(s);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static boolean istTag(String s) {
        try {
            LocalDate.parse(s);
            return true;
        } catch (DateTimeParseException e) {
            return false;
        }
    }
}
