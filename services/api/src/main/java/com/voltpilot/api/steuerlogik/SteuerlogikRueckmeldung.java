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
    static final int MAX_STELLWERTE = 64;
    static final int MAX_WARUM = 24;
    static final int MAX_BEDINGUNGEN = 12;
    static final int MAX_WERTE = 3;
    static final int MAX_MELDUNGEN = 8;

    /** Mitlaufend (Stufe 2) oder scharf (Stufe 3); ein anderes Wort verwirft den Lauf. */
    private static final Set<String> ZUSTAENDE = Set.of("mitlaufend", "scharf");
    private static final Set<String> WARUM_WAS = Set.of("an", "aus", "schritt");
    private static final Set<String> WARUM_MODUS = Set.of("alle", "eines");
    private static final Pattern CODE = Pattern.compile("^[a-z][a-z0-9_-]{0,39}$");
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
            Instant scharfSeit = instant(l.path("scharf_seit").asText(null));
            if ("scharf".equals(zustand) && scharfSeit != null) sauber.put("scharf_seit", scharfSeit.toString());
            ObjectNode halt = grund(l.get("halt"), mapper);
            if (halt != null) sauber.set("halt", halt);
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
                    if (g.path("name").isTextual()) one.put("name", text(g.path("name"), 40));
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
                    ObjectNode befehl = stand(g.get("befehl"), mapper);
                    if (befehl != null) one.set("befehl", befehl);
                    if (g.path("halter").isTextual() && CODE.matcher(g.path("halter").asText()).matches()) {
                        one.put("halter", g.path("halter").asText());
                    }
                    ObjectNode schutz = grund(g.get("schutz"), mapper);
                    if (schutz != null) one.set("schutz", schutz);
                    ObjectNode konflikt = grund(g.get("konflikt"), mapper);
                    if (konflikt != null) one.set("konflikt", konflikt);
                }
            }
            ObjectNode stell = stellwerte(l.get("stellwerte"), mapper);
            if (stell != null) sauber.set("stellwerte", stell);
            ArrayNode warum = warum(l.get("warum"), mapper);
            if (warum != null) sauber.set("warum", warum);
            ArrayNode meldungen = meldungen(l.get("meldungen"), mapper);
            if (meldungen != null) sauber.set("meldungen", meldungen);
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

    /** Ein Grund in Code und Satz ({@code halt}, {@code schutz}, {@code konflikt}); sonst {@code null}. */
    static ObjectNode grund(JsonNode g, ObjectMapper mapper) {
        if (g == null || !g.isObject() || !CODE.matcher(g.path("code").asText("")).matches()
                || !g.path("text").isTextual()) {
            return null;
        }
        ObjectNode out = mapper.createObjectNode();
        out.put("code", g.path("code").asText());
        out.put("text", text(g.path("text"), 200));
        return out;
    }

    /** Die gestellten Werte mit Stand, Anzeige und Hilfesatz; ein Wert nur in der Form des Dokuments. */
    static ObjectNode stellwerte(JsonNode s, ObjectMapper mapper) {
        if (s == null || !s.isObject() || !s.path("stand").isIntegralNumber() || s.path("stand").asLong() < 0) {
            return null;
        }
        ObjectNode out = mapper.createObjectNode();
        out.put("stand", s.path("stand").asLong());
        ArrayNode werte = out.putArray("werte");
        for (JsonNode w : s.path("werte")) {
            if (werte.size() >= MAX_STELLWERTE) break;
            JsonNode wert = formDesDokuments(w.get("wert"), mapper);
            if (!KENNUNG.matcher(w.path("kennung").asText("")).matches() || wert == null) continue;
            ObjectNode one = werte.addObject();
            one.put("kennung", w.path("kennung").asText());
            one.set("wert", wert);
            one.put("text", text(w.path("text"), 80));
            if (w.path("hilfe").isTextual()) one.put("hilfe", text(w.path("hilfe"), 300));
        }
        return out;
    }

    /** Ein Wert in der Form des Dokuments: Wort oder Zahl mit Einheit als Text, Zahl, Ja/Nein oder Zeitplan. */
    static JsonNode formDesDokuments(JsonNode w, ObjectMapper mapper) {
        if (w == null) return null;
        if (w.isTextual()) return w.asText().length() <= 80 ? w : null;
        if (w.isNumber()) return Double.isFinite(w.asDouble()) ? w : null;
        if (w.isBoolean()) return w;
        if (w.isArray() && w.size() <= 8) {
            ArrayNode plan = mapper.createArrayNode();
            for (JsonNode f : w) {
                if (!f.isObject()) return null;
                ObjectNode one = plan.addObject();
                for (String k : List.of("days", "from", "to")) {
                    if (!f.path(k).isTextual() || f.path(k).asText().length() > 40) return null;
                    one.put(k, f.path(k).asText());
                }
            }
            return plan;
        }
        return null;
    }

    /** Die Liste "Warum?": je Gruppe die benannten Bedingungen mit Haken (ok null = unbekannt) und Werten. */
    static ArrayNode warum(JsonNode liste, ObjectMapper mapper) {
        if (liste == null || !liste.isArray()) return null;
        ArrayNode out = mapper.createArrayNode();
        for (JsonNode g : liste) {
            if (out.size() >= MAX_WARUM) break;
            if (!KENNUNG.matcher(g.path("zustand").asText("")).matches() || !WARUM_WAS.contains(g.path("was").asText())
                    || !WARUM_MODUS.contains(g.path("modus").asText())) {
                continue;
            }
            ObjectNode one = out.addObject();
            one.put("zustand", g.path("zustand").asText());
            one.put("name", text(g.path("name"), 80));
            // Die Überschrift für den Kunden (Satz der Logik oder aus dem Wortschatz der Box, nie eine Kennung).
            if (g.path("satz").isTextual()) one.put("satz", text(g.path("satz"), 160));
            if (g.path("eigen").asBoolean(false)) one.put("eigen", true);
            one.put("was", g.path("was").asText());
            if (g.path("schritt").isTextual()) one.put("schritt", text(g.path("schritt"), 40));
            one.put("modus", g.path("modus").asText());
            if (g.path("wartet_s").isInt()) one.put("wartet_s", zahl(g.path("wartet_s"), MAX_SEKUNDEN));
            ArrayNode bed = one.putArray("bedingungen");
            for (JsonNode b : g.path("bedingungen")) {
                if (bed.size() >= MAX_BEDINGUNGEN) break;
                if (!b.path("name").isTextual()) continue;
                ObjectNode bn = bed.addObject();
                bn.put("name", text(b.path("name"), 120));
                if (b.path("ok").isBoolean()) {
                    bn.put("ok", b.path("ok").asBoolean());
                } else {
                    bn.putNull("ok");
                }
                // Ein Satz, nie eine Formel: allgemein heißt, die Box konnte die Bedingung nicht übersetzen.
                if (b.path("allgemein").asBoolean(false)) bn.put("allgemein", true);
                ArrayNode werte = bn.putArray("werte");
                for (JsonNode w : b.path("werte")) {
                    if (werte.size() >= MAX_WERTE) break;
                    if (!w.path("name").isTextual() || !w.path("text").isTextual()) continue;
                    werte.addObject().put("name", text(w.path("name"), 80)).put("text", text(w.path("text"), 40));
                }
            }
        }
        return out;
    }

    /** Die eigenen Meldungen der Logik (notifications), jüngste zuletzt. */
    static ArrayNode meldungen(JsonNode liste, ObjectMapper mapper) {
        if (liste == null || !liste.isArray()) return null;
        ArrayNode out = mapper.createArrayNode();
        for (JsonNode m : liste) {
            if (out.size() >= MAX_MELDUNGEN) break;
            Instant t = instant(m.path("t").asText(null));
            if (!m.path("nr").isIntegralNumber() || m.path("nr").asLong() < 1 || t == null
                    || !m.path("text").isTextual()) {
                continue;
            }
            ObjectNode one = out.addObject();
            one.put("nr", m.path("nr").asLong());
            one.put("t", t.toString());
            ArrayNode an = one.putArray("an");
            for (JsonNode a : m.path("an")) {
                if (an.size() < 4 && a.isTextual() && KENNUNG.matcher(a.asText()).matches()) an.add(a.asText());
            }
            one.put("text", text(m.path("text"), 300));
        }
        return out;
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
