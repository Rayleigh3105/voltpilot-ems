package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Die STUFE eines Heizstabs, wie die Box sie im Herzschlag meldet (Heizstab-Konzept V1;
 * docs/contracts/v2/heizstab-shelly.md {@code consumers.{id}.stage}, heizstab-regler.md
 * {@code consumers.{id}.heizstab}), und die angenommene Energie, die das Ledger daraus rechnet.
 *
 * <p><b>Warum die Energie hier fortgeschrieben wird.</b> Ohne Leistungsmessung ist die Energie
 * eines Relais "angenommen" (Stufe 3). Bisher war das Nennleistung × Laufzeit. Ein Heizstab, der
 * eine von drei Phasen heizt, liefert aber nur ein Drittel - das Ledger hätte dreifach zu viel
 * gezählt. Die Box meldet je Herzschlag ihre Tageslaufzeit und die bestätigte Stufe; die
 * Laufzeit-Differenz zweier Herzschläge lief mit der Stufe des ersten. Der Tageswechsel folgt dem
 * Zähler der Box (fällt er, beginnt ein neuer Tag) - dieselbe Tagesgrenze wie die Laufzeit.
 *
 * <p>Gelesen wird nur ein geprüfter Auszug; was nicht passt, fehlt (nie erfunden).
 */
public final class HeizstabStufe {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Die Codes des Reglers der Box (heizstab-regler.md, geschlossen). */
    public static final Set<String> REGLER_CODES = Set.of("ueberschuss", "kein_ueberschuss",
            "ueberschuss_pruefen", "mindestpause", "mindestlauf", "haltezeit", "schaltgrenze",
            "messwerte_fehlen", "hoechste_stufe", "stufen_unbekannt");

    private static final double MAX_KW = 100.0;

    private HeizstabStufe() {
    }

    /** Die gemeldete Stufe (Auszug von {@code stage}). */
    public record Stufe(int befohlen, Double befohlenKw, Integer bestaetigt, Double bestaetigtKw,
            List<Integer> ausgaengeAn, String abweichungSeit, String am) {

        /** Die kW, mit denen die Stufe lief: bestätigt, sonst befohlen (nie erfunden). */
        public Double laufKw() {
            return bestaetigtKw != null ? bestaetigtKw : befohlenKw;
        }

        /** Als gespeicherter Auszug (stufe_json). */
        public String alsJson() {
            ObjectNode n = JSON.createObjectNode();
            n.put("commanded", befohlen);
            if (befohlenKw != null) {
                n.put("commanded_kw", befohlenKw);
            }
            if (bestaetigt != null) {
                n.put("confirmed", bestaetigt);
            }
            if (bestaetigtKw != null) {
                n.put("confirmed_kw", bestaetigtKw);
            }
            var arr = n.putArray("outputs_on");
            ausgaengeAn.forEach(arr::add);
            if (abweichungSeit != null) {
                n.put("mismatch_since", abweichungSeit);
            }
            if (am != null) {
                n.put("at", am);
            }
            return n.toString();
        }
    }

    /** Der {@code stage}-Block eines Herzschlag-Eintrags; null, wenn er fehlt oder nicht passt. */
    public static Stufe stufe(JsonNode entry) {
        JsonNode s = entry == null ? null : entry.get("stage");
        if (s == null || !s.isObject()) {
            return null;
        }
        Integer befohlen = ganzzahl(s.get("commanded"), 0, 4);
        if (befohlen == null) {
            return null;
        }
        List<Integer> an = new ArrayList<>();
        JsonNode outs = s.get("outputs_on");
        if (outs != null && outs.isArray()) {
            for (JsonNode o : outs) {
                Integer ch = ganzzahl(o, 0, 3);
                if (ch != null && !an.contains(ch) && an.size() < 4) {
                    an.add(ch);
                }
            }
        }
        return new Stufe(befohlen, kw(s.get("commanded_kw")), ganzzahl(s.get("confirmed"), 0, 4),
                kw(s.get("confirmed_kw")), List.copyOf(an), zeit(s.get("mismatch_since")), zeit(s.get("at")));
    }

    /** Der {@code heizstab}-Block (Befund des Reglers) als geprüfter Auszug; null, wenn er fehlt. */
    public static String reglerJson(JsonNode entry) {
        JsonNode h = entry == null ? null : entry.get("heizstab");
        if (h == null || !h.isObject()) {
            return null;
        }
        Integer stufe = ganzzahl(h.get("stufe"), 0, 16);
        String code = h.path("code").asText("");
        if (stufe == null || !REGLER_CODES.contains(code)) {
            return null;
        }
        ObjectNode n = JSON.createObjectNode();
        n.put("stufe", stufe);
        Integer ausgaenge = ganzzahl(h.get("ausgaenge"), 0, 4);
        if (ausgaenge != null) {
            n.put("ausgaenge", ausgaenge);
        }
        Double k = kw(h.get("kw"));
        if (k != null) {
            n.put("kw", k);
        }
        n.put("code", code);
        String grund = h.path("grund").asText("");
        if (!grund.isBlank()) {
            n.put("grund", grund.length() > 200 ? grund.substring(0, 200) : grund);
        }
        JsonNode v = h.get("verfuegbar_kw");
        if (v != null && v.isNumber() && Double.isFinite(v.asDouble()) && Math.abs(v.asDouble()) <= MAX_KW) {
            n.put("verfuegbar_kw", v.asDouble());
        }
        String ab = zeit(h.get("hoeher_ab"));
        if (ab != null) {
            n.put("hoeher_ab", ab);
        }
        String seit = zeit(h.get("seit"));
        if (seit != null) {
            n.put("seit", seit);
        }
        return n.toString();
    }

    /**
     * Die angenommene Energie des Tages nach diesem Herzschlag (kWh, 3 Stellen).
     *
     * @param vorher die Zeile des vorigen Herzschlags (oder null)
     * @param laufzeitJetzt die Tageslaufzeit der Box jetzt (s), null = unbekannt
     * @param stufeJetzt die jetzt gemeldete Stufe, null = kein Stufen-Verbraucher
     * @return null, wenn dieser Verbraucher keine Stufe meldet
     */
    public static BigDecimal energieFortschreiben(VorigeStufe vorher, Integer laufzeitJetzt, Stufe stufeJetzt) {
        if (stufeJetzt == null) {
            return null;
        }
        BigDecimal basis = vorher == null || vorher.energieKwh() == null ? BigDecimal.ZERO : vorher.energieKwh();
        if (laufzeitJetzt == null) {
            return vorher == null ? null : vorher.energieKwh();
        }
        Integer laufzeitVorher = vorher == null ? null : vorher.laufzeitSekunden();
        int delta;
        if (laufzeitVorher == null || laufzeitJetzt < laufzeitVorher || vorher.energieKwh() == null) {
            // Erster Herzschlag dieses Tages (oder überhaupt): die Laufzeit seit Tagesbeginn.
            basis = BigDecimal.ZERO;
            delta = laufzeitJetzt;
        } else {
            delta = laufzeitJetzt - laufzeitVorher;
        }
        Double kw = vorher != null && vorher.stufe() != null && vorher.stufe().laufKw() != null
                ? vorher.stufe().laufKw() : stufeJetzt.laufKw();
        if (kw == null || delta <= 0) {
            return basis.setScale(3, RoundingMode.HALF_UP);
        }
        return basis.add(BigDecimal.valueOf(kw).multiply(BigDecimal.valueOf(delta))
                .divide(BigDecimal.valueOf(3600), 3, RoundingMode.HALF_UP));
    }

    /** Was der vorige Herzschlag zur Fortschreibung beiträgt. */
    public record VorigeStufe(Stufe stufe, Integer laufzeitSekunden, BigDecimal energieKwh) {
    }

    /** Liest einen gespeicherten Auszug (stufe_json) zurück. */
    public static Stufe ausJson(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            ObjectNode wrap = JSON.createObjectNode();
            wrap.set("stage", JSON.readTree(json));
            return stufe(wrap);
        } catch (Exception e) {
            return null;
        }
    }

    private static Integer ganzzahl(JsonNode n, int min, int max) {
        if (n == null || !n.isIntegralNumber()) {
            return null;
        }
        int v = n.asInt();
        return v < min || v > max ? null : v;
    }

    private static Double kw(JsonNode n) {
        if (n == null || !n.isNumber()) {
            return null;
        }
        double v = n.asDouble();
        return Double.isFinite(v) && v >= 0 && v <= MAX_KW ? v : null;
    }

    private static String zeit(JsonNode n) {
        if (n == null || !n.isTextual()) {
            return null;
        }
        try {
            return Instant.parse(n.asText()).toString();
        } catch (Exception e) {
            return null;
        }
    }
}
