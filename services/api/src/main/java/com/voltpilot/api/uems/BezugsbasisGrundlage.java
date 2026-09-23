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
 *
 * <p>Modelle (IP-10, M2–M4): je Monat mit Zahl zusätzlich der Wert der zweiten Variablen mit ihrer Fassung; Koeffizienten,
 * R², Streuung und Spannweite je Variable rechnet {@link BezugsbasisRegeln#modell} aus den gespeicherten Monatspaaren —
 * hier wird nichts gerechnet, nur übergeben und eingefroren. Grenzen beim Bilden: {@code zu_wenig_perioden} (G1),
 * {@code variable_fehlt} (G2); eine abhängige zweite Variable (G4) wird nicht aufgenommen und steht mit r in
 * {@code abgelehnte_variablen}.
 */
public class BezugsbasisGrundlage {

    /** Der Kennzahl-Wert ohne Zahl, weil der Monat noch nie gebildet wurde (dasselbe Wort wie der Werte-Leser). */
    static final String NOCH_NICHT_GEBILDET = KennzahlWerteService.NOCH_NICHT_GEBILDET;

    private static final ObjectMapper KANON = new ObjectMapper();
    private static final JsonNodeFactory F = JsonNodeFactory.withExactBigDecimals(true);
    private static final Pattern AB = Pattern.compile("(?<![0-9A-Za-z])ab ([0-9]{2}\\.[0-9]{2}\\.[0-9]{4})");

    /** Variable 1 (V2): der Nenner der Kennzahl, als Bezugsgröße mit der Fassung des letzten Monats mit Wert. */
    public record Variable(UUID bezugsgroesseId, String kennzeichen, Integer fassung, BigDecimal von, BigDecimal bis) {}

    /** Ein Monatswert einer Variablen (Bezugsgröße) mit der Fassung, die in dem Monat wirksam war. */
    public record Monatswert(BigDecimal wert, Integer fassung, List<String> kennzeichen) {}

    /** Die zweite Variable eines Modells mit zwei Einflussgrößen: Monatswerte der Referenzperiode (fehlend = kein Eintrag). */
    public record ZweiteVariable(UUID bezugsgroesseId, String kennzeichen, String einheit, Map<YearMonth, Monatswert> werte) {}

    /** Das eingefrorene Modell (M2/M4): Koeffizienten, Güte, und was abgelehnt wurde (G4). */
    public record Modell(Map<String, String> koeffizienten, String r2, String streuungProzent,
            List<Map<String, Object>> abgelehnt) {}

    /**
     * Die gebildete Grundlage. {@code basiswert} ist {@code null} genau dann, wenn {@code grund} gesetzt ist
     * ({@code keine_werte}, beim Modell auch {@code zu_wenig_perioden} oder {@code variable_fehlt} mit
     * {@code fehlend}); {@code text} und {@code pruefsumme} sind dann ebenfalls {@code null} — eine halbe Herkunft wird
     * nie ausgeliefert. {@code methode} ist die gerechnete Methode: nach einer G4-Ablehnung ein Modell mit einer
     * Einflussgröße; {@code variablen} sind Variable 1 (Nenner) und gegebenenfalls Variable 2.
     */
    public record Ergebnis(int monate, String datenlage, List<Map<String, Object>> gruende, List<String> vorbehalte,
            String basiswert, String grund, String methode, List<Variable> variablen, Modell modell,
            List<String> kennzeichen, List<String> fehlend, String text, String pruefsumme) {

        /** Variable 1 (V2), der Nenner — oder {@code null} bei einer Zusammenfassung. */
        public Variable variable() {
            return variablen.isEmpty() ? null : variablen.get(0);
        }

        static Ergebnis ohne(String grund, int monate, List<String> fehlend) {
            return new Ergebnis(monate, null, List.of(), List.of(), null, grund, null, List.of(), null, List.of(),
                    List.copyOf(fehlend), null, null);
        }
    }

    private final KennzahlWerteLeser leser;

    public BezugsbasisGrundlage(JdbcTemplate jdbc) {
        this.leser = new KennzahlWerteLeser(jdbc);
    }

    /**
     * Bildet die Grundlage der Kennzahl {@code kennzahl} (Kennzeichen {@code kennzeichen}) für die Monate
     * {@code von … bis} mit der Methode {@code methode}. {@code nenner} ist die Bezugsgröße des Nenners (Variable 1)
     * oder {@code null} (Zusammenfassung, Nenner aus Paaren); {@code nennerArt} ihre Art (M3: {@code gradtagzahl}).
     * {@code zweite} ist Variable 2 eines Modells mit zwei Einflussgrößen, sonst {@code null}.
     */
    public Ergebnis bilden(UUID kennzahl, String kennzeichen, String rechenform, int definitionFassung,
            String referenzperiode, YearMonth von, YearMonth bis, String methode, UUID nenner, String nennerKennzeichen,
            String nennerArt, ZweiteVariable zweite) {
        boolean istModell = !BezugsbasisService.VERHAELTNIS.equals(methode);
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
                .filter(z -> z.version() != null || istModell && nennerNull(z)).map(KennzahlWerteLeser.Zeile::id).toList());

        ArrayNode perioden = F.arrayNode();
        List<BezugsbasisRegeln.Paar> paare = new ArrayList<>();
        List<BezugsbasisRegeln.Reihe> reihe = new ArrayList<>();
        List<String> variableFehlt = new ArrayList<>();
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
            // M3: ein Monat mit Nenner 0 (etwa null Gradtage im Sommer) hat keinen Kennzahl-Wert, ist für ein Modell aber
            // ein Paar wie jedes andere — der Zähler hängt dann allein an der Konstante. Das Verhältnis zählt ihn nicht.
            boolean paarOhneZahl = istModell && z != null && nennerNull(z);
            if (!paarOhneZahl
                    && (z == null || z.version() == null || z.wert() == null || z.zaehler() == null || z.nenner() == null)) {
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
            if (paarOhneZahl) {
                kz.put("grund", z.grund());
            }
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
            List<String> werte = new ArrayList<>(List.of(z.nenner().toPlainString()));
            if (zweite != null) {
                Monatswert v2 = zweite.werte().get(m);
                if (v2 == null || v2.wert() == null) {
                    variableFehlt.add(m.toString());
                } else {
                    ObjectNode v = p.putArray("variablen").addObject();
                    v.put("position", 2);
                    v.put("objekt", zweite.kennzeichen());
                    v.put("wert", v2.wert());
                    v.put("einheit", zweite.einheit());
                    v.put("fassung", v2.fassung());
                    ArrayNode vk = v.putArray("kennzeichen");
                    v2.kennzeichen().forEach(vk::add);
                    werte.add(v2.wert().toPlainString());
                }
            }
            reihe.add(new BezugsbasisRegeln.Reihe(z.zaehler().toPlainString(), werte));
            minNenner = minNenner == null || z.nenner().compareTo(minNenner) < 0 ? z.nenner() : minNenner;
            maxNenner = maxNenner == null || z.nenner().compareTo(maxNenner) > 0 ? z.nenner() : maxNenner;
            if (!paarOhneZahl && !"endgueltig".equals(z.zustand())) {
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
            return Ergebnis.ohne("keine_werte", 0, List.of());
        }
        int n = (Integer) basis.get("monate");
        // G2: ein Modell rechnet nur mit einer Variablen in JEDEM Monat mit Zahl — fehlt sie, gibt es kein Modell.
        if (istModell && !variableFehlt.isEmpty()) {
            return Ergebnis.ohne("variable_fehlt", n, variableFehlt);
        }
        Map<String, Object> modell = istModell ? BezugsbasisRegeln.modell(methode, reihe) : null;
        if (modell != null && modell.get("grund") != null) {
            return Ergebnis.ohne((String) modell.get("grund"), n, List.of());
        }
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
        String gerechnet = modell == null ? methode : (String) modell.get("methode");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> spannweiten = modell == null ? List.of()
                : (List<Map<String, Object>>) modell.get("spannweite");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> abgelehnt = modell == null ? List.of()
                : (List<Map<String, Object>>) modell.get("abgelehnt");
        List<Variable> variablen = new ArrayList<>();
        if (nenner != null) {
            variablen.add(new Variable(nenner, nennerKennzeichen, nennerFassung, minNenner, maxNenner));
        }
        if (zweite != null && spannweiten.size() == 2) {
            Integer f2 = null;
            for (YearMonth m : monate) {
                Monatswert v2 = aktuell.containsKey(m) ? zweite.werte().get(m) : null;
                f2 = v2 != null && v2.fassung() != null ? v2.fassung() : f2;
            }
            variablen.add(new Variable(zweite.bezugsgroesseId(), zweite.kennzeichen(), f2,
                    new BigDecimal((String) spannweiten.get(1).get("von")),
                    new BigDecimal((String) spannweiten.get(1).get("bis"))));
        }
        List<Map<String, Object>> abgelehnteVariablen = new ArrayList<>();
        for (Map<String, Object> a : abgelehnt) {
            abgelehnteVariablen.add(eintrag("objekt", zweite == null ? null : zweite.kennzeichen(), "position",
                    a.get("variable"), "grund", a.get("grund"), "r", new BigDecimal((String) a.get("r")), "startwert_r",
                    new BigDecimal(BezugsbasisRegeln.STARTWERTE.abhaengig_r())));
        }
        // M3/G5: ein Verhältnis über eine Gradtagzahl kennt keine Grundlast — das sagt jede Zahl daraus.
        List<String> kennzeichenDerFassung = !istModell && "gradtagzahl".equals(nennerArt)
                ? List.of("ohne Grundlast") : List.of();

        ObjectNode g = F.objectNode();
        g.put("referenzperiode", referenzperiode);
        g.put("methode", gerechnet);
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
        for (int i = 0; i < variablen.size(); i++) {
            Variable variable = variablen.get(i);
            ObjectNode v = var.addObject();
            v.put("position", i + 1);
            v.put("rolle", i == 0 ? "nenner" : "variable");
            v.put("objekt", variable.kennzeichen());
            v.put("fassung", variable.fassung());
            ObjectNode s = v.putObject("spannweite");
            s.put("von", variable.von());
            s.put("bis", variable.bis());
            if (modell != null) {
                // M2: das Toleranzband der Spannweite (G3 prüft es im Vergleich, IP-13) — eingefroren wie der Rest.
                s.put("toleriert_von", new BigDecimal((String) spannweiten.get(i).get("toleriert_von")));
                s.put("toleriert_bis", new BigDecimal((String) spannweiten.get(i).get("toleriert_bis")));
            }
        }
        g.putArray("faktoren");
        g.put("basiswert", new BigDecimal((String) basis.get("basiswert")));
        Modell eingefroren = null;
        if (modell != null) {
            @SuppressWarnings("unchecked")
            Map<String, String> koeffizienten = (Map<String, String>) modell.get("koeffizienten");
            ObjectNode ko = g.putObject("koeffizienten");
            koeffizienten.forEach((k, v) -> ko.put(k, new BigDecimal(v)));
            g.put("r2", new BigDecimal((String) modell.get("r2")));
            g.put("streuung_prozent", new BigDecimal((String) modell.get("streuung_prozent")));
            g.set("abgelehnte_variablen", KANON.valueToTree(abgelehnteVariablen));
            eingefroren = new Modell(Map.copyOf(koeffizienten), (String) modell.get("r2"),
                    (String) modell.get("streuung_prozent"), List.copyOf(abgelehnteVariablen));
        }
        if (!kennzeichenDerFassung.isEmpty()) {
            g.set("kennzeichen", KANON.valueToTree(kennzeichenDerFassung));
        }
        String text = kanonisch(g);
        return new Ergebnis(n, datenlage, List.copyOf(gruende), List.copyOf(vorbehalte), (String) basis.get("basiswert"),
                null, gerechnet, List.copyOf(variablen), eingefroren, kennzeichenDerFassung, List.of(), text,
                pruefsumme(text));
    }

    private static boolean nennerNull(KennzahlWerteLeser.Zeile z) {
        return KennzahlRegeln.NENNER_NULL.equals(z.grund()) && z.zaehler() != null && z.nenner() != null
                && z.nenner().signum() == 0;
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
