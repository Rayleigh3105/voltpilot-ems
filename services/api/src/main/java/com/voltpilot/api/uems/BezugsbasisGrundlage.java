package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Die Grundlage einer Bezugsbasis-Fassung (UEMS AP-17 IP-7, F3, M1, P1–P3): eine KOPIE dessen, was Rechenlauf und
 * Kaskade für die Monate der Referenzperiode gespeichert haben — je Monat die aktuelle Zeile der Kennzahl mit Version
 * und Definitions-Fassung, Zähler und Nenner, jeder Eingang mit Wert und Version bzw. Fassung —, dazu Variablen,
 * Faktoren, Datenlage und der Basiswert. Nichts wird nachgerechnet (Herkunfts-Regel 1): die Monatszahlen sind die
 * gespeicherten, der Basiswert Σ Zähler ÷ Σ Nenner rechnet {@link BezugsbasisRegeln#basiswert}.
 *
 * <p>Der Text ist kanonisch — Schlüssel sortiert, kein Leerraum, Zahlen als Dezimaltext ohne Nullen am Ende —, dieselbe
 * Form wie die Prüfsummen von {@code bezugsbasen[]} in der Referenzdatei 1.8 ({@code UemsReferenzunternehmenVectorsTest
 * .kanonisch}); die Prüfsumme ist {@code sha256:} über seine UTF-8-Bytes, dieselbe wie {@code bericht_pruefsumme}.
 *
 * <p>Datenlage: {@code vorlaeufig} unter der Mindestlänge (P2, „n von 12 Monaten“), mit einem angeschnittenen Monat
 * („ab TT.MM.JJJJ“ im Kennzeichen der Kennzahl, P2) oder einem Wert, der noch nicht endgültig ist (P3); sonst
 * {@code vollstaendig}. Ein Monat ohne Zahl ist keine Null: er steht mit seinem Grund in der Grundlage und zählt nicht.
 */
public class BezugsbasisGrundlage {

    /** Der Kennzahl-Wert ohne Zahl, weil der Monat noch nie gebildet wurde (dasselbe Wort wie der Werte-Leser). */
    static final String NOCH_NICHT_GEBILDET = KennzahlWerteService.NOCH_NICHT_GEBILDET;

    private static final ObjectMapper KANON = new ObjectMapper();
    private static final JsonNodeFactory F = JsonNodeFactory.withExactBigDecimals(true);
    private static final Pattern AB = Pattern.compile("(?<![0-9A-Za-z])ab ([0-9]{2}\\.[0-9]{2}\\.[0-9]{4})");

    /** Variable 1 (V2): der Nenner der Kennzahl, als Bezugsgröße mit der Fassung des letzten Monats mit Wert. */
    public record Variable(UUID bezugsgroesseId, String kennzeichen, Integer fassung, BigDecimal von, BigDecimal bis) {}

    /**
     * Die gebildete Grundlage. {@code basiswert} ist {@code null} genau bei {@code grund = keine_werte}; {@code text}
     * und {@code pruefsumme} sind dann ebenfalls {@code null} — eine halbe Herkunft wird nie ausgeliefert.
     */
    public record Ergebnis(int monate, String datenlage, List<Map<String, Object>> gruende, List<String> vorbehalte,
            String basiswert, String grund, Variable variable, String text, String pruefsumme) {}

    private final KennzahlWerteLeser leser;

    public BezugsbasisGrundlage(JdbcTemplate jdbc) {
        this.leser = new KennzahlWerteLeser(jdbc);
    }

    /**
     * Bildet die Grundlage der Kennzahl {@code kennzahl} (Kennzeichen {@code kennzeichen}) für die Monate
     * {@code von … bis} mit der Methode {@code methode}. {@code nenner} ist die Bezugsgröße des Nenners (Variable 1)
     * oder {@code null} (Zusammenfassung, Nenner aus Paaren).
     */
    public Ergebnis bilden(UUID kennzahl, String kennzeichen, String rechenform, int definitionFassung,
            String referenzperiode, YearMonth von, YearMonth bis, String methode, UUID nenner, String nennerKennzeichen) {
        Map<LocalDate, List<KennzahlWerteLeser.Zeile>> jeMonat = new LinkedHashMap<>();
        leser.zeilen(kennzahl, "monat", von.atDay(1), bis.atDay(1))
                .forEach(z -> jeMonat.computeIfAbsent(z.periodeVon(), k -> new ArrayList<>()).add(z));
        List<YearMonth> monate = new ArrayList<>();
        for (YearMonth m = von; !m.isAfter(bis); m = m.plusMonths(1)) {
            monate.add(m);
        }
        Map<YearMonth, KennzahlWerteLeser.Zeile> aktuell = new LinkedHashMap<>();
        for (YearMonth m : monate) {
            KennzahlWerteLeser.Zeile z = KennzahlWerteService.waehle(jeMonat.getOrDefault(m.atDay(1), List.of()), null);
            if (z != null) {
                aktuell.put(m, z);
            }
        }
        Map<UUID, List<KennzahlWerteLeser.Eingang>> eingaenge = leser.eingaenge(aktuell.values().stream()
                .filter(z -> z.version() != null).map(KennzahlWerteLeser.Zeile::id).toList());

        ArrayNode perioden = F.arrayNode();
        List<BezugsbasisRegeln.Paar> paare = new ArrayList<>();
        List<String> ohneWert = new ArrayList<>();
        List<String> vorlaeufigeWerte = new ArrayList<>();
        List<Map<String, Object>> angeschnitten = new ArrayList<>();
        BigDecimal minNenner = null;
        BigDecimal maxNenner = null;
        Integer nennerFassung = null;
        for (YearMonth m : monate) {
            KennzahlWerteLeser.Zeile z = aktuell.get(m);
            ObjectNode p = perioden.addObject();
            p.put("periode", m.toString());
            if (z == null || z.version() == null || z.wert() == null || z.zaehler() == null || z.nenner() == null) {
                // Unbekannt ist keine Null: der Monat steht mit seinem Grund und zählt nicht.
                p.put("grund", z == null || z.grund() == null ? NOCH_NICHT_GEBILDET : z.grund());
                ohneWert.add(m.toString());
                continue;
            }
            ObjectNode kz = p.putObject("kennzahl");
            kz.put("objekt", kennzeichen);
            kz.put("wert", z.wert());
            kz.put("version", z.version());
            kz.put("definition_fassung", z.definitionFassung());
            kz.put("zustand", z.zustand());
            kz.put("menge_zustand", z.mengeZustand());
            ArrayNode kzk = kz.putArray("kennzeichen");
            z.kennzeichen().forEach(kzk::add);
            p.put("zaehler", z.zaehler());
            p.put("nenner", z.nenner());
            ArrayNode ein = p.putArray("eingaenge");
            for (KennzahlWerteLeser.Eingang e : eingaenge.getOrDefault(z.id(), List.of())) {
                ObjectNode o = ein.addObject();
                o.put("position", e.position());
                o.put("rolle", e.rolle());
                o.put("art", e.art());
                o.put("objekt", e.objekt());
                o.put("wert", e.wert());
                o.put("zaehler", e.zaehler());
                o.put("nenner", e.nenner());
                o.put("einheit", e.einheit());
                o.put("menge_zustand", e.mengeZustand());
                o.put("version", e.version());
                o.put("fassung", e.fassung());
                ArrayNode ek = o.putArray("kennzeichen");
                e.kennzeichen().forEach(ek::add);
                if (nennerKennzeichen != null && "nenner".equals(e.rolle()) && nennerKennzeichen.equals(e.objekt())) {
                    nennerFassung = e.fassung();
                }
            }
            paare.add(new BezugsbasisRegeln.Paar(z.zaehler().toPlainString(), z.nenner().toPlainString()));
            minNenner = minNenner == null || z.nenner().compareTo(minNenner) < 0 ? z.nenner() : minNenner;
            maxNenner = maxNenner == null || z.nenner().compareTo(maxNenner) > 0 ? z.nenner() : maxNenner;
            if (!"endgueltig".equals(z.zustand())) {
                vorlaeufigeWerte.add(m.toString());
            }
            for (String satz : z.kennzeichen()) {
                Matcher ab = AB.matcher(satz);
                if (ab.find()) {
                    angeschnitten.add(eintrag("periode", m.toString(), "ab", ab.group(1)));
                    break;
                }
            }
        }

        Map<String, Object> basis = BezugsbasisRegeln.basiswert(paare);
        if (basis.get("basiswert") == null) {
            return new Ergebnis(0, null, List.of(), List.of(), null, "keine_werte", null, null, null);
        }
        int n = (Integer) basis.get("monate");
        List<Map<String, Object>> gruende = new ArrayList<>();
        List<String> vorbehalte = new ArrayList<>();
        @SuppressWarnings("unchecked")
        List<String> kennzeichenDerRegel = (List<String>) basis.get("kennzeichen");
        if ("vorlaeufig".equals(basis.get("datenlage"))) {
            gruende.add(eintrag("grund", "monate", "monate", n, "mindest_monate",
                    BezugsbasisRegeln.STARTWERTE.mindest_monate(), "ohne_wert", List.copyOf(ohneWert)));
            vorbehalte.addAll(kennzeichenDerRegel);
        }
        for (Map<String, Object> a : angeschnitten) {
            Map<String, Object> g = new LinkedHashMap<>();
            g.put("grund", "angeschnitten");
            g.putAll(a);
            gruende.add(g);
            vorbehalte.add(a.get("periode") + " ab " + a.get("ab"));
        }
        if (!vorlaeufigeWerte.isEmpty()) {
            gruende.add(eintrag("grund", "vorlaeufige_werte", "perioden", List.copyOf(vorlaeufigeWerte)));
            vorbehalte.add("vorläufige Werte (" + String.join(", ", vorlaeufigeWerte) + ")");
        }
        String datenlage = gruende.isEmpty() ? "vollstaendig" : "vorlaeufig";
        Variable variable = nenner == null ? null
                : new Variable(nenner, nennerKennzeichen, nennerFassung, minNenner, maxNenner);

        ObjectNode g = F.objectNode();
        g.put("referenzperiode", referenzperiode);
        g.put("methode", methode);
        ObjectNode kz = g.putObject("kennzahl");
        kz.put("objekt", kennzeichen);
        kz.put("rechenform", rechenform);
        kz.put("definition_fassung", definitionFassung);
        g.set("perioden", perioden);
        g.put("monate", n);
        g.put("mindest_monate", BezugsbasisRegeln.STARTWERTE.mindest_monate());
        g.put("datenlage", datenlage);
        g.set("datenlage_gruende", KANON.valueToTree(gruende));
        g.set("vorbehalte", KANON.valueToTree(vorbehalte));
        ArrayNode var = g.putArray("variablen");
        if (variable != null) {
            ObjectNode v = var.addObject();
            v.put("position", 1);
            v.put("rolle", "nenner");
            v.put("objekt", variable.kennzeichen());
            v.put("fassung", variable.fassung());
            ObjectNode s = v.putObject("spannweite");
            s.put("von", variable.von());
            s.put("bis", variable.bis());
        }
        g.putArray("faktoren");
        g.put("basiswert", new BigDecimal((String) basis.get("basiswert")));
        String text = kanonisch(g);
        return new Ergebnis(n, datenlage, List.copyOf(gruende), List.copyOf(vorbehalte), (String) basis.get("basiswert"),
                null, variable, text, pruefsumme(text));
    }

    /** Kanonisch: Schlüssel sortiert, kein Leerraum, Zahlen ohne nachgestellte Nullen („46.0“ → „46“). */
    public static String kanonisch(JsonNode n) {
        if (n.isObject()) {
            List<String> namen = new ArrayList<>();
            n.fieldNames().forEachRemaining(namen::add);
            Collections.sort(namen);
            List<String> teile = new ArrayList<>();
            for (String name : namen) {
                teile.add(text(name) + ":" + kanonisch(n.get(name)));
            }
            return "{" + String.join(",", teile) + "}";
        }
        if (n.isArray()) {
            List<String> teile = new ArrayList<>();
            for (JsonNode e : n) {
                teile.add(kanonisch(e));
            }
            return "[" + String.join(",", teile) + "]";
        }
        if (n.isNumber()) {
            return n.decimalValue().stripTrailingZeros().toPlainString();
        }
        if (n.isTextual()) {
            return text(n.asText());
        }
        return n.toString();
    }

    /** {@code sha256:} + Hex über die UTF-8-Bytes — dieselbe Zahl wie {@code bericht_pruefsumme} in der Datenbank. */
    public static String pruefsumme(String text) {
        try {
            return "sha256:" + HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String text(String s) {
        try {
            return KANON.writeValueAsString(s);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Map<String, Object> eintrag(Object... paare) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            m.put((String) paare[i], paare[i + 1]);
        }
        return m;
    }
}
