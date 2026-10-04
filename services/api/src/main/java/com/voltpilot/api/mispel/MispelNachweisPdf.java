package com.voltpilot.api.mispel;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.mispel.MispelNachweis.Abschnitt;
import com.voltpilot.api.mispel.MispelNachweis.Empfaenger;
import com.voltpilot.api.mispel.MispelNachweis.Formel;
import com.voltpilot.api.mispel.MispelNachweis.Formelsatz;
import com.voltpilot.api.mispel.MispelNachweis.Jahr;
import com.voltpilot.api.mispel.MispelNachweis.Lauf;
import com.voltpilot.api.mispel.MispelNachweis.Monat;
import com.voltpilot.api.mispel.MispelNachweis.Wert;
import com.voltpilot.api.uems.BerichtPdf;
import com.voltpilot.api.uems.BerichtPdf.Setzer;
import com.voltpilot.api.uems.BerichtPdf.Spalte;
import java.io.IOException;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;

/**
 * MiSpeL MP-16: der Nachweis der Abgrenzungsoption als PDF — mit dem Setzer der Berichts-PDFs ({@link BerichtPdf#setzen}:
 * Apache PDFBox, Liberation Sans, A4). Rein und deterministisch: dieselben Läufe und derselbe Empfänger geben dieselben
 * Bytes; das Datum im Dokument ist die Rechenzeit des jüngsten Laufs, die {@code /ID} kommt aus den Prüfsummen.
 *
 * <p>Inhalt wie der CSV ({@link MispelNachweis#csv}), nur ohne die Viertelstundenwerte — die stehen im CSV derselben
 * Prüfsummen. Ein vorläufiger Stand trägt auf jeder Seite das Wasserzeichen {@link #WASSERZEICHEN} und heißt nie
 * „Mengenbestimmung“ (Bauplan § 8.5).
 */
public final class MispelNachweisPdf {

    public static final String WASSERZEICHEN = "vorläufig – keine Mengenbestimmung";
    private static final DateTimeFormatter UHR = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");

    /**
     * MP-16b: der längste Wert, den die Wertspalte ohne Umbruch tragen muss — zehn Vorkommastellen (bis knapp 10 TWh je
     * Zeitraum), Vorzeichen, drei Nachkommastellen und Einheit. Faktoren haben eine Vorkommastelle, „nicht bestimmbar“
     * ist kürzer.
     */
    static final String LAENGSTER_WERT = "-9999999999,999 kWh";
    /** Freiraum zwischen einem rechtsbündigen Wert und dem Text der Nachbarspalte rechts daneben (pt). */
    static final float RINNE = 6;
    static final Spalte WERT = new Spalte("Wert", 100, true, RINNE);
    static final List<Spalte> FORMELSATZ_SPALTEN = List.of(new Spalte("Nr.", 64, false),
            new Spalte("Rechenweg", 110, false), new Spalte("Begriff", 0, false), WERT);
    static final List<Spalte> JAHR_SPALTEN = List.of(new Spalte("Nr.", 64, false),
            new Spalte("Begriff und Rechenweg", 0, false), WERT, new Spalte("Fundstelle", 96, false));
    static final List<Spalte> ERGEBNIS_SPALTEN = List.of(new Spalte("Zeitraum", 52, false), new Spalte("Nr.", 54, false),
            new Spalte("Begriff", 0, false), WERT, new Spalte("Fundstelle", 92, false));
    static final List<Spalte> LUECKEN_SPALTEN = List.of(new Spalte("Zeitraum", 58, false),
            new Spalte("fehlender Eingang", 96, false), new Spalte("Anzahl", 50, true, RINNE), new Spalte("erste", 0, false));

    private MispelNachweisPdf() {}

    public static byte[] datei(Monat m, Empfaenger e) {
        List<String> pruefsummen = m.laeufe().stream().map(l -> l.zeile().pruefsumme()).toList();
        String zeitraum = MispelNachweis.monatsname(m.monat());
        return BerichtPdf.setzen(MispelNachweis.titel(m), e.bezeichnung() + " · " + zeitraum, juengste(m.laeufe()),
                MispelNachweis.ZONE, kennung(m.anlage(), m.monat().toString(), e, pruefsummen),
                m.giltAlsNachweis() ? null : WASSERZEICHEN,
                fuesse(m.anlage(), zeitraum, e, m.stand(), pruefsummen), s -> {
                    s.titel(MispelNachweis.titel(m));
                    stand(s, m.giltAlsNachweis(), m.gruende());
                    List<String[]> p = kopf(e, m.anlage(), m.laeufe());
                    p.add(3, new String[] {"Kalendermonat", zeitraum + " (" + tage(m.monat().atDay(1),
                            m.monat().atEndOfMonth()) + ")"});
                    if ("lieferant".equals(e.schluessel())) {
                        p.add(new String[] {"Frist", MispelNachweis.frist(m.monat().getYear())});
                    }
                    s.paare(p);
                    s.ueberschrift("Ergebnis für den " + e.bezeichnung());
                    ergebnis(s, MispelNachweis.ergebnis(m, e), m.laeufe());
                    laeufe(s, m.laeufe(), m.abdeckung());
                    messkonzept(s, m.laeufe());
                    s.ueberschrift("Formelsatz und Zwischenwerte");
                    for (Lauf l : m.laeufe()) {
                        Formelsatz f = MispelNachweis.FORMELSAETZE.get(l.zeile().formelsatz());
                        s.zwischentitel(l.schluessel() + " · " + tage(l.ersterTag(), l.letzterTag()) + " · Formelsatz "
                                + l.zeile().formelsatz() + (f == null ? "" : " – " + f.bezeichnung() + " (" + f.fundstelle()
                                + ")"));
                        List<List<List<String>>> zeilen = new ArrayList<>();
                        for (Wert w : MispelNachweis.monatswerte(l)) {
                            Formel fo = w.formel();
                            zeilen.add(List.of(List.of(w.nr()), List.of(fo.rechenweg()), List.of(fo.begriff()),
                                    List.of(wert(w))));
                        }
                        s.tabelle(FORMELSATZ_SPALTEN, zeilen);
                    }
                    luecken(s, m.laeufe());
                    hinweise(s, "Die Viertelstundenwerte (Eingänge und Zwischenwerte je Viertelstunde) stehen im CSV "
                            + "derselben Prüfsummen.");
                });
    }

    public static byte[] datei(Jahr j, Empfaenger e) {
        List<String> pruefsummen = j.laeufe().stream().map(l -> l.zeile().pruefsumme()).toList();
        String zeitraum = "Kalenderjahr " + j.jahr();
        return BerichtPdf.setzen(MispelNachweis.titel(j), e.bezeichnung() + " · " + zeitraum, juengste(j.laeufe()),
                MispelNachweis.ZONE, kennung(j.anlage(), String.valueOf(j.jahr()), e, pruefsummen),
                j.giltAlsNachweis() ? null : WASSERZEICHEN,
                fuesse(j.anlage(), zeitraum, e, j.stand(), pruefsummen), s -> {
                    s.titel(MispelNachweis.titel(j));
                    stand(s, j.giltAlsNachweis(), j.gruende());
                    List<String[]> p = kopf(e, j.anlage(), j.laeufe());
                    p.add(3, new String[] {"Kalenderjahr", String.valueOf(j.jahr())});
                    p.add(4, new String[] {"Bestimmung nach Anlage 1", "ab " + MispelNachweis.TAG.format(
                            j.laeufe().get(0).ersterTag()) + (j.abdeckung().get(0).lauf() == null
                            ? "; davor kein Lauf in diesem Jahr" : "")});
                    if ("lieferant".equals(e.schluessel())) {
                        p.add(new String[] {"Frist", MispelNachweis.frist(j.jahr())});
                    }
                    s.paare(p);
                    s.ueberschrift("Ergebnis für den " + e.bezeichnung() + " – Kalenderjahr " + j.jahr());
                    List<List<List<String>>> zeilen = new ArrayList<>();
                    for (Wert w : MispelNachweis.ergebnis(j, e)) {
                        Formel f = w.formel();
                        zeilen.add(List.of(List.of(w.nr()), List.of(f.begriff(), f.rechenweg()), List.of(wert(w)),
                                List.of(f.fundstelle())));
                    }
                    if (zeilen.isEmpty()) {
                        s.hinweis(ohneErgebnis(j.laeufe()));
                    } else {
                        s.tabelle(JAHR_SPALTEN, zeilen);
                    }
                    s.ueberschrift("Monatswerte (Summanden von ∑J)");
                    ergebnis(s, MispelNachweis.monatswerte(j, e), j.laeufe());
                    laeufe(s, j.laeufe(), j.abdeckung());
                    hinweise(s, "Formelsatz, Messkonzept und Zwischenwerte je Monat stehen im Monatsnachweis derselben "
                            + "Prüfsumme.");
                });
    }

    // ------------------------------------------------------------------ Bausteine

    private static void stand(Setzer s, boolean nachweis, List<String> gruende) throws IOException {
        if (nachweis) {
            s.satz("Endgültig: auf mess- und eichrechtskonformen Viertelstundenwerten des Messstellenbetreibers "
                    + "(Tenor S. 28; § 21 Abs. 4 S. 2 EnFG). Dieser Nachweis ist eine Mengenbestimmung im Sinne der "
                    + "Festlegung.");
        } else {
            s.satz("Vorläufig – keine Mengenbestimmung im Sinne der Festlegung, nur eine Vorschau. Gründe: "
                    + String.join("; ", gruende.stream().map(MispelNachweisPdf::grund).toList()) + ".");
        }
        s.abstand(4);
    }

    private static List<String[]> kopf(Empfaenger e, UUID anlage, List<Lauf> laeufe) {
        List<String[]> p = new ArrayList<>();
        p.add(new String[] {"Für", e.bezeichnung()});
        p.add(new String[] {"Grundlage", e.grundlage()});
        p.add(new String[] {"Anlage (Einspeisestelle)", anlage.toString()});
        p.add(new String[] {"Formelsatz", String.join(", ", new LinkedHashSet<>(laeufe.stream().map(l -> {
            Formelsatz f = MispelNachweis.FORMELSAETZE.get(l.zeile().formelsatz());
            return l.zeile().formelsatz() + (f == null ? "" : " – " + f.bezeichnung());
        }).toList()))});
        p.add(new String[] {"Wertequelle", wertequelle(MispelNachweis.wertequelle(laeufe))});
        p.add(new String[] {"Festlegung", MispelNachweis.festlegung(laeufe)});
        p.add(new String[] {"Vertrag und Rechenwerk", String.join(", ", new LinkedHashSet<>(laeufe.stream().map(l ->
                l.nachweis().path("vertrag").asText() + " " + l.zeile().vertragVersion() + " · Rechenwerk "
                        + l.zeile().rechenwerkVersion()).toList())) + " · Nachweis " + MispelNachweis.FASSUNG});
        return p;
    }

    private static void ergebnis(Setzer s, List<Wert> werte, List<Lauf> laeufe) throws IOException {
        if (werte.isEmpty()) {
            s.hinweis(ohneErgebnis(laeufe));
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        for (Wert w : werte) {
            Formel f = w.formel();
            zeilen.add(List.of(List.of(w.schluessel()), List.of(w.nr()), List.of(f.begriff()), List.of(wert(w)),
                    List.of(f.fundstelle())));
        }
        s.tabelle(ERGEBNIS_SPALTEN, zeilen);
    }

    private static String ohneErgebnis(List<Lauf> laeufe) {
        return "Für diesen Empfänger weist der Formelsatz keinen Wert aus: A10 und A11 haben keine Förderseite (Anlage 1 "
                + "Abschn. 10, S. 94–101). Formelsatz: " + String.join(", ", new LinkedHashSet<>(laeufe.stream()
                .map(l -> l.zeile().formelsatz()).toList())) + ".";
    }

    private static void laeufe(Setzer s, List<Lauf> laeufe, List<Abschnitt> abdeckung) throws IOException {
        s.ueberschrift("Läufe des Rechenwerks");
        List<List<List<String>>> zeilen = new ArrayList<>();
        for (Lauf l : laeufe) {
            var z = l.zeile();
            List<String> stand = new ArrayList<>(List.of(stand(z.stand())));
            l.nachweis().path("stand_gruende").forEach(g -> stand.add(grund(g.asText())));
            zeilen.add(List.of(List.of(l.schluessel(), tage(l.ersterTag(), l.letzterTag())),
                    List.of("Fassung " + z.fassung(), "gerechnet " + UHR.format(z.gerechnetAm().atZone(MispelNachweis.ZONE))),
                    stand,
                    List.of(wertequelle(z.wertequelle()), z.viertelstundenGerechnet() + " von "
                            + z.viertelstundenErwartet() + " Viertelstunden"),
                    List.of(z.pruefsumme())));
        }
        s.tabelle(List.of(new Spalte("Zeitraum", 92, false), new Spalte("Fassung", 96, false),
                new Spalte("Stand", 0, false), new Spalte("Werte", 96, false), new Spalte("Prüfsumme (SHA-256)", 112,
                false)), zeilen);
        List<Abschnitt> ohne = abdeckung.stream().filter(a -> a.lauf() == null).toList();
        if (!ohne.isEmpty()) {
            s.hinweis("Ohne Lauf: " + String.join("; ", ohne.stream().map(a -> tage(a.ersterTag(), a.letzterTag()))
                    .toList()) + ".");
        }
    }

    private static void messkonzept(Setzer s, List<Lauf> laeufe) throws IOException {
        s.ueberschrift("Messkonzept (Zähler der Festlegung)");
        List<List<List<String>>> zeilen = new ArrayList<>();
        for (Lauf l : laeufe) {
            for (JsonNode z : l.nachweis().path("zaehler")) {
                zeilen.add(List.of(List.of(l.schluessel()), List.of(text(z, "eingang"), text(z, "rolle")),
                        List.of(text(z, "messstelle"), text(z, "zaehlpunkt")),
                        List.of(text(z, "messstellenbetreiber"), wertequelle(text(z, "wertequelle"))),
                        List.of(text(z, "eichstatus") + (z.hasNonNull("eichfrist_bis") ? " bis "
                                + MispelNachweis.TAG.format(LocalDate.parse(text(z, "eichfrist_bis"))) : ""),
                                "Urteil: " + text(z, "urteil"))));
            }
        }
        s.tabelle(List.of(new Spalte("Zeitraum", 58, false), new Spalte("Eingang, Rolle", 70, false),
                new Spalte("Messstelle, Zählpunkt", 0, false), new Spalte("Messstellenbetreiber, Werte", 120, false),
                new Spalte("Eichung, Urteil", 100, false)), zeilen);
    }

    private static void luecken(Setzer s, List<Lauf> laeufe) throws IOException {
        List<List<List<String>>> zeilen = new ArrayList<>();
        for (Lauf l : laeufe) {
            l.nachweis().path("viertelstunden").path("luecken_je_eingang").fields().forEachRemaining(a -> {
                List<String> erste = new ArrayList<>();
                a.getValue().path("erste").forEach(t -> erste.add(t.asText()));
                zeilen.add(List.of(List.of(l.schluessel()), List.of(a.getKey()),
                        List.of(a.getValue().path("anzahl").asText()),
                        List.of(String.join(", ", erste.subList(0, Math.min(4, erste.size())))
                                + (erste.size() > 4 ? " …" : ""))));
            });
        }
        if (zeilen.isEmpty()) {
            return;
        }
        s.ueberschrift("Lücken (nicht als Null gerechnet)");
        s.tabelle(LUECKEN_SPALTEN, zeilen);
    }

    private static void hinweise(Setzer s, String zusatz) throws IOException {
        s.ueberschrift("Hinweise");
        for (String h : MispelNachweis.HINWEISE) {
            s.hinweis(h);
            s.abstand(3);
        }
        s.hinweis(zusatz);
    }

    private static List<String> fuesse(UUID anlage, String zeitraum, Empfaenger e, String stand,
            List<String> pruefsummen) {
        return List.of("MiSpeL-Nachweis Abgrenzungsoption · Anlage " + anlage + " · " + zeitraum + " · für "
                        + e.bezeichnung() + " · " + stand(stand),
                pruefsummen.size() == 1 ? "Prüfsumme des Nachweis-Datensatzes " + pruefsummen.get(0)
                        : "Prüfsummen der " + pruefsummen.size() + " Nachweis-Datensätze: siehe „Läufe des Rechenwerks“");
    }

    private static String kennung(UUID anlage, String zeitraum, Empfaenger e, List<String> pruefsummen) {
        return "mispel-abgrenzung|" + MispelNachweis.FASSUNG + "|" + anlage + "|" + zeitraum + "|" + e.schluessel()
                + "|" + String.join(",", pruefsummen);
    }

    private static Instant juengste(List<Lauf> laeufe) {
        return laeufe.stream().map(l -> l.zeile().gerechnetAm()).max(Comparator.naturalOrder()).orElseThrow();
    }

    /** Die Anzeigezahl mit Dezimalkomma und Einheit; „nicht bestimmbar“ ohne Wert. */
    static String wert(Wert w) {
        BigDecimal g = MispelNachweis.gerundet(w.nr(), w.wert());
        if (g == null) {
            return "nicht bestimmbar";
        }
        String e = MispelNachweis.einheit(w.nr());
        return MispelNachweis.zahl(g) + (e.isEmpty() ? "" : " " + e);
    }

    /** Ein Grund für „vorläufig“ in Worten (der CSV trägt den Code). */
    static String grund(String code) {
        int d = code.indexOf(':');
        String art = d < 0 ? code : code.substring(0, d);
        String zu = d < 0 ? "" : code.substring(d + 1);
        return switch (art) {
            case "lauf_vorlaeufig" -> "Lauf " + zu + " ist vorläufig";
            case "zeitraum_luecke" -> "kein Lauf " + strecke(zu);
            case "nicht_bis_jahresende" -> "kein Lauf " + strecke(zu) + " (bis Jahresende)";
            case "luecken" -> "Viertelstunden ohne Wert (Lücken)";
            case "wertequelle_geraet" -> "Gerätewerte statt Werte des Messstellenbetreibers";
            case "viertelstunden_vorlaeufig" -> "Viertelstundenwerte noch vorläufig";
            case "aw_rueckfall" -> "AW>0-Zeiten aus dem Rückfall statt der Liste der ÜNB";
            case "zeitraum_offen" -> "Zeitraum noch nicht vorbei";
            default -> art.startsWith("zaehler_") ? "Zähler " + zu + ": " + art.substring("zaehler_".length()) : code;
        };
    }

    private static String strecke(String vonBis) {
        String[] t = vonBis.split("/");
        return t.length == 2 ? "vom " + MispelNachweis.TAG.format(LocalDate.parse(t[0])) + " bis "
                + MispelNachweis.TAG.format(LocalDate.parse(t[1])) : vonBis;
    }

    private static String tage(LocalDate erster, LocalDate letzter) {
        return MispelNachweis.TAG.format(erster) + " bis " + MispelNachweis.TAG.format(letzter);
    }

    private static String stand(String stand) {
        return MispelNachweis.ENDGUELTIG.equals(stand) ? "endgültig" : "vorläufig";
    }

    private static String wertequelle(String w) {
        return MispelAbgrenzungService.MSB.equals(w) ? "Messstellenbetreiber"
                : MispelAbgrenzungService.GERAET.equals(w) ? "Gerät (Box)" : String.valueOf(w);
    }

    private static String text(JsonNode n, String feld) {
        JsonNode v = n.path(feld);
        return v.isMissingNode() || v.isNull() ? "–" : v.asText();
    }
}
