package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Der ERGEBNIS-ZUSTAND einer abgeleiteten Zahl und ihre Sätze als Vertrag (UEMS AP-08 IP-8, §4.1,
 * §4.5, E10, E11): eine Zahl ohne ihren Zustand ist eine Behauptung.
 *
 * <p>Der Vertrag steht in {@code docs/contracts/v2/ergebnis-zustand-vectors.json} (Prosa:
 * {@code ergebnis-zustand.md}); der TS-Zwilling ist {@code frontend/portal/src/uemsErgebnis.ts}.
 * Wer eine Regel oder einen Satz ändert, ändert die Vektor-Datei UND beide Zwillinge.
 *
 * <p>Vier Dinge wohnen hier, und nur hier:
 *
 * <ol>
 *   <li><b>Das geschlossene Zustands-Vokabular</b> — vollständig · unvollständig · keine Werte ·
 *       mit Ersatzwert — mit der Regel, wann eine Zahl dasteht und was die Kennzeichen dazu sagen
 *       müssen ({@link #pruefe}).
 *   <li><b>Die geschlossene Liste der Kennzeichen-Sätze</b> mit Wortlaut, Platzhaltern und Rang.
 *       {@link VerbrauchRegeln} formuliert keinen Satz mehr selbst, sie RUFT die Sprech-Funktionen
 *       dieser Klasse an ({@link #geraetegrenze}, {@link #neustart}, …). Die Reihenfolge ist
 *       Vertrag: der Rang steigt nie, die Sätze der Gerätegrenze stehen in fester Folge.
 *   <li><b>Die Rundung als Funktion des Vertrags (E11)</b> — die EBENE bestimmt die
 *       Nachkommastellen, nie die Fläche ({@link #zahl}). Gerechnet wird ungerundet; gerundet wird
 *       nur hier, beim Anzeigen. Eine Rundungsdifferenz wird genannt ({@link #rundungsdifferenz}).
 *   <li><b>Die Sommerzeit-Beschriftung (E10)</b> — Ortszeit des Standorts, die doppelte Stunde mit
 *       MESZ/MEZ, die fehlende erscheint nicht ({@link #raster}, {@link #tagesdauer}); die
 *       Stundenzahl wird bei {@link BezugsPeriode#stundenDesTages} bestellt, nie hier gezählt.
 * </ol>
 *
 * <p><b>Rein:</b> ohne Spring, ohne Datenbank, ohne Uhr. Die Sprech-Funktionen prüfen die
 * eingesetzten Werte NICHT — sie liegen im Rechenweg der Verdichtung, und ein Satz darf dort nie
 * eine Menge kosten. Ob jeder erzeugte Satz auf sein Muster passt, beweisen die Vektor-Tests.
 */
public final class ErgebnisZustand {

    private ErgebnisZustand() {}

    // ------------------------------------------------------------------ Zustände (§4.5)

    public static final String VOLLSTAENDIG = "vollständig";
    public static final String UNVOLLSTAENDIG = "unvollständig";
    public static final String KEINE_WERTE = "keine Werte";
    public static final String MIT_ERSATZWERT = "mit Ersatzwert";

    public static final String ZAHL_PFLICHT = "pflicht";
    public static final String ZAHL_ERLAUBT = "erlaubt";
    public static final String ZAHL_VERBOTEN = "verboten";

    public static final String KEIN_FEHLBESTAND = "kein_fehlbestand";
    public static final String MINDESTENS_EIN_FEHLBESTAND = "mindestens_ein_fehlbestand";
    public static final String FREI = "frei";

    /** Ein Zustandswort mit seiner Regel für Zahl und Kennzeichen. */
    public record Zustand(String wort, String zahl, String kennzeichen) {}

    public static final List<Zustand> ZUSTAENDE = List.of(
            new Zustand(VOLLSTAENDIG, ZAHL_PFLICHT, KEIN_FEHLBESTAND),
            new Zustand(UNVOLLSTAENDIG, ZAHL_ERLAUBT, MINDESTENS_EIN_FEHLBESTAND),
            new Zustand(KEINE_WERTE, ZAHL_VERBOTEN, KEIN_FEHLBESTAND),
            new Zustand(MIT_ERSATZWERT, ZAHL_PFLICHT, FREI));

    // ------------------------------------------------------------------ Kennzeichen

    /** Je Platzhalter-Art der Ausdruck, der den eingesetzten Text erkennt (ohne fangende Gruppe). */
    public static final Map<String, String> PLATZHALTER = Map.of(
            "uhr", "(?:[01][0-9]|2[0-3]):[0-5][0-9](?: (?:MESZ|MEZ|UTC[+-](?:[01][0-9]|2[0-3]):[0-5][0-9]))?",
            "text", ".+",
            "ganzzahl", "(?:0|[1-9][0-9]*)",
            "ganzzahl_ab_2", "(?:[2-9]|[1-9][0-9]+)",
            "sekunden", "[0-5][0-9]",
            "dezimal_punkt", "(?:0|[1-9][0-9]*)\\.[0-9]{3}",
            "dezimal_klartext", "(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?",
            // Eine Menge in der Anzeige-Einheit mit den Stellen der KENNZEICHEN_EBENE (seit 1.3).
            "menge", "(?:0|[1-9][0-9]{0,2}(?:\\.[0-9]{3})*),[0-9]\u00A0(?:kWh|kvarh|m³)",
            // Seit 1.4 (AP-08 IP-13): der Name einer Ersatzwert-Methode in Kundensprache und die Kennung.
            "ersatzwert_methode", "(?:Zuwachs gleichmäßig verteilen|Zuwachs nach dem Profil der Vorperiode verteilen"
                    + "|Zuwachs nach dem Profil der Vergleichsquelle verteilen|Ablesestand nachtragen"
                    + "|Wert eingeben \\(mit Beleg\\)|Vorperiode übernehmen|Vergleichsquelle übernehmen)",
            "ersatzwert_kennung", "EW-[0-9]{4}-[0-9]{4,}");

    /**
     * Ein Kennzeichen-Satz der geschlossenen Liste.
     *
     * @param muster der Wortlaut; {@code {name}} ist ein Platzhalter
     * @param platzhalter je Platzhalter seine Art aus {@link #PLATZHALTER}
     * @param wort das Wort des Kennzeichen-Vokabulars, {@code null} = keins (Befund)
     * @param rang die Reihenfolge — in einer Liste steigt der Rang nie
     * @param fehlbestand ob der Satz einen nicht gezählten Teil nennt
     * @param einmalig ob der Satz höchstens einmal in einer Liste steht
     * @param folgtAuf der unmittelbar vorangehende Satz muss eines dieser Muster sein, sonst
     *     {@code null}
     * @param verlangtDanach der unmittelbar folgende Satz muss dieses Muster sein, sonst {@code null}
     */
    public record Muster(
            String schluessel,
            String muster,
            Map<String, String> platzhalter,
            String wort,
            int rang,
            boolean fehlbestand,
            boolean einmalig,
            List<String> folgtAuf,
            String verlangtDanach) {}

    private static final String UHR = "uhr";

    public static final List<Muster> KENNZEICHEN = List.of(
            new Muster("anteil_positiv", "positiver Anteil von {quelle}", Map.of("quelle", "text"),
                    "positiver Anteil", 10, false, true, null, null),
            new Muster("anteil_negativ", "negativer Anteil von {quelle}", Map.of("quelle", "text"),
                    "negativer Anteil", 10, false, true, null, null),
            new Muster("anfang_nicht_gemessen", "Anfang nicht gemessen (kein Stand an der Periodengrenze)",
                    Map.of(), null, 20, true, true, null, null),
            new Muster("ende_nicht_gemessen", "Ende nicht gemessen (kein Stand an der Periodengrenze)",
                    Map.of(), null, 21, true, true, null, null),
            new Muster("nur_ein_stand", "nur ein Stand in der Periode — keine Menge bildbar",
                    Map.of(), null, 22, true, true, null, null),
            new Muster("geraetegrenze_mit", "Gerätegrenze {uhr} mit Ableseständen", Map.of(UHR, UHR),
                    "Gerätegrenze", 30, false, false, null, null),
            new Muster("geraetegrenze_ohne", "Gerätegrenze {uhr} ohne Ablesestände", Map.of(UHR, UHR),
                    "Gerätegrenze", 30, false, false, null, "zuwachs_nicht_messbar"),
            new Muster("zuwachs_nicht_messbar", "Zuwachs am Wechsel nicht messbar (Ablesestände fehlen)",
                    Map.of(), "Gerätegrenze", 30, true, false, List.of("geraetegrenze_ohne"), null),
            new Muster("luecke_am_wechsel", "Lücke am Wechsel {von}–{bis} (nicht aufgefüllt)",
                    Map.of("von", UHR, "bis", UHR), "Gerätegrenze", 30, false, false,
                    List.of("geraetegrenze_mit", "zuwachs_nicht_messbar"), null),
            new Muster("ueberlauf", "Überlauf {uhr} (Wertebereich {modul})",
                    Map.of(UHR, UHR, "modul", "dezimal_klartext"), "Überlauf", 30, false, false, null, null),
            new Muster("ruecksetzung", "Rücksetzung {uhr} ohne Endstand — bis zu 1 Kadenz nicht gezählt",
                    Map.of(UHR, UHR), "Rücksetzung", 30, true, false, null, null),
            new Muster("luecke_zuwachs",
                    "Lücke {von}–{bis}: Zuwachs {zuwachs} gemessen, nicht auf Viertelstunden verteilbar",
                    Map.of("von", UHR, "bis", UHR, "zuwachs", "menge"), "Lücke: Zuwachs gemessen",
                    30, false, false, null, null),
            new Muster("luecke_zuwachs_ohne_einheit",
                    "Lücke {von}–{bis}: Zuwachs gemessen, nicht auf Viertelstunden verteilbar",
                    Map.of("von", UHR, "bis", UHR), "Lücke: Zuwachs gemessen", 30, false, false, null, null),
            new Muster("neustart", "Neustart {uhr}: bis zu {verlust_s} s Zählung möglicherweise verloren",
                    Map.of(UHR, UHR, "verlust_s", "ganzzahl"), "Neustart-Verlust", 40, true, false, null, null),
            new Muster("intervallmenge_fehlt",
                    "1 von {erwartet} Intervallmengen fehlt — Menge ist die Summe der gemessenen",
                    Map.of("erwartet", "ganzzahl"), null, 50, true, true, null, null),
            new Muster("intervallmengen_fehlen",
                    "{fehlend} von {erwartet} Intervallmengen fehlen — Menge ist die Summe der gemessenen",
                    Map.of("fehlend", "ganzzahl_ab_2", "erwartet", "ganzzahl"), null, 50, true, true, null, null),
            new Muster("gemessene_zeit", "gemessene Zeit {minuten}:{sekunden} min von {periode_min} min",
                    Map.of("minuten", "ganzzahl", "sekunden", "sekunden", "periode_min", "ganzzahl"), null,
                    50, true, true, null, null),
            new Muster("aus_leistung_integriert",
                    "aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit)", Map.of(),
                    "aus Leistung integriert", 60, false, true, null, null),
            // Seit 1.4 (AP-08 IP-13): zuletzt, was ein Mensch gesetzt hat — nach allem, was gemessen ist.
            new Muster("mit_ersatzwert", "mit Ersatzwert (Methode „{methode}“, {kennung})",
                    Map.of("methode", "ersatzwert_methode", "kennung", "ersatzwert_kennung"),
                    "mit Ersatzwert (Methode …)", 70, false, false, null, null),
            // Seit 1.5 (AP-08 IP-17): ganz zuletzt die Version — sie sagt etwas über die ganze Zahl, nicht über
            // einen Teil. Version 1 ist das Original und nie „korrigiert“.
            new Muster("korrigiert", "korrigiert (Version {version})", Map.of("version", "ganzzahl_ab_2"),
                    "korrigiert (Version n)", 80, false, true, null, null));

    /**
     * Ein Wortlaut, den eine frühere Fassung sprach und der gespeichert sein kann. Er wird als das
     * Muster {@code schluessel} ERKANNT (gleicher Rang, gleiches Wort), aber nie mehr gesprochen.
     *
     * @param bisFassung die letzte Fassung des Vertrags, die ihn sprach
     */
    public record FruehereFassung(String schluessel, String muster, Map<String, String> platzhalter, String bisFassung) {}

    public static final List<FruehereFassung> FRUEHERE_FASSUNGEN = List.of(
            // Falscher Dativ; in endgültigen Viertelstunden gespeichert und von Tag/Monat/Jahr übernommen.
            new FruehereFassung("geraetegrenze_mit", "Gerätegrenze {uhr} mit Ablesestände", Map.of(UHR, UHR), "1.0"),
            // Punkt, drei Stellen, ohne Einheit („Zuwachs 337.600“); seit AP-08 IP-6 gespeichert.
            new FruehereFassung("luecke_zuwachs",
                    "Lücke {von}–{bis}: Zuwachs {zuwachs} gemessen, nicht auf Viertelstunden verteilbar",
                    Map.of("von", UHR, "bis", UHR, "zuwachs", "dezimal_punkt"), "1.2"));

    /** Ein Wort des Vokabulars, dessen Wortlaut ein späteres Paket festlegt. */
    public record Vorgesehen(String wort, String anfang, String wortlautMit) {}

    public static final List<Vorgesehen> VORGESEHEN = List.of(
            new Vorgesehen("nachgeliefert", "nachgeliefert", "AP-08 IP-10 (Chip „nachgeliefert“ am Verlauf)"),
            new Vorgesehen("vorläufig", "vorläufig",
                    "AP-08 IP-9 (Fassung vorläufig/endgültig im Lese-Modell)"),
            new Vorgesehen("endgültig", "endgültig",
                    "AP-08 IP-9 (Fassung vorläufig/endgültig im Lese-Modell)"),
            new Vorgesehen("Ablesezeitraum", "Ablesezeitraum",
                    "AP-09 (Ablesungen einer Messstelle ohne Datenquelle, F17)"));

    private static final Pattern PLATZ = Pattern.compile("\\{([a-z_]+)\\}");

    private record Erkenner(Muster muster, Pattern ausdruck, List<String> namen, boolean fruehereFassung) {}

    private static final Map<String, Muster> JE_SCHLUESSEL = new LinkedHashMap<>();
    private static final List<Erkenner> ERKENNER = new ArrayList<>();

    static {
        for (Muster m : KENNZEICHEN) {
            JE_SCHLUESSEL.put(m.schluessel(), m);
            ERKENNER.add(erkenner(m, m.muster(), m.platzhalter(), false));
        }
        for (FruehereFassung f : FRUEHERE_FASSUNGEN) {
            ERKENNER.add(erkenner(muster(f.schluessel()), f.muster(), f.platzhalter(), true));
        }
    }

    private static Erkenner erkenner(Muster m, String text, Map<String, String> platzhalter, boolean frueher) {
        StringBuilder ausdruck = new StringBuilder("^");
        List<String> namen = new ArrayList<>();
        Matcher p = PLATZ.matcher(text);
        int stelle = 0;
        while (p.find()) {
            ausdruck.append(Pattern.quote(text.substring(stelle, p.start())));
            namen.add(p.group(1));
            ausdruck.append('(').append(PLATZHALTER.get(platzhalter.get(p.group(1)))).append(')');
            stelle = p.end();
        }
        ausdruck.append(Pattern.quote(text.substring(stelle))).append('$');
        return new Erkenner(m, Pattern.compile(ausdruck.toString()), List.copyOf(namen), frueher);
    }

    /** Das Muster zu einem Schlüssel; ein unbekannter Schlüssel ist ein Programmfehler. */
    public static Muster muster(String schluessel) {
        Muster m = JE_SCHLUESSEL.get(schluessel);
        if (m == null) {
            throw new IllegalArgumentException("unbekanntes Kennzeichen " + schluessel);
        }
        return m;
    }

    /**
     * Den Satz eines Musters sprechen. Geprüft wird nur, dass GENAU die Platzhalter des Musters
     * belegt sind (Programmfehler) — die Werte selbst nicht (siehe Klassenkommentar).
     */
    public static String sprich(String schluessel, Map<String, String> werte) {
        Muster m = muster(schluessel);
        if (!m.platzhalter().keySet().equals(werte.keySet())) {
            throw new IllegalArgumentException("Kennzeichen " + schluessel + " braucht " + m.platzhalter().keySet()
                    + ", bekam " + werte.keySet());
        }
        Matcher p = PLATZ.matcher(m.muster());
        StringBuilder satz = new StringBuilder();
        while (p.find()) {
            p.appendReplacement(satz, Matcher.quoteReplacement(werte.get(p.group(1))));
        }
        p.appendTail(satz);
        return satz.toString();
    }

    /** Der feste Anfang eines Musters bis zum ersten Platzhalter — zum Wiedererkennen per Präfix. */
    public static String anfang(String schluessel) {
        String text = muster(schluessel).muster();
        int platz = text.indexOf('{');
        return platz < 0 ? text : text.substring(0, platz);
    }

    public static final String ANFANG_NICHT_GEMESSEN = sprich("anfang_nicht_gemessen", Map.of());
    public static final String ENDE_NICHT_GEMESSEN = sprich("ende_nicht_gemessen", Map.of());
    public static final String NUR_EIN_STAND = sprich("nur_ein_stand", Map.of());
    public static final String ZUWACHS_NICHT_MESSBAR = sprich("zuwachs_nicht_messbar", Map.of());
    public static final String AUS_LEISTUNG_INTEGRIERT = sprich("aus_leistung_integriert", Map.of());

    /** „positiver Anteil von K-3 · Wirkleistung“ — steht vor allen anderen (Rang 10). */
    public static String anteil(boolean positiv, String quelle) {
        return sprich(positiv ? "anteil_positiv" : "anteil_negativ", Map.of("quelle", quelle));
    }

    /** „Gerätegrenze 10:40 mit Ableseständen“ bzw. „… ohne Ablesestände“. */
    public static String geraetegrenze(String uhr, boolean mitAblesestaenden) {
        return sprich(mitAblesestaenden ? "geraetegrenze_mit" : "geraetegrenze_ohne", Map.of(UHR, uhr));
    }

    /** „Lücke am Wechsel 10:39–10:47 (nicht aufgefüllt)“. */
    public static String lueckeAmWechsel(String von, String bis) {
        return sprich("luecke_am_wechsel", Map.of("von", von, "bis", bis));
    }

    /** „Überlauf 10:03 (Wertebereich 65536)“. */
    public static String ueberlauf(String uhr, BigDecimal wertebereichModul) {
        return sprich("ueberlauf", Map.of(UHR, uhr, "modul", wertebereichModul.toPlainString()));
    }

    /** „Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt“. */
    public static String ruecksetzung(String uhr) {
        return sprich("ruecksetzung", Map.of(UHR, uhr));
    }

    /**
     * „Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, …“ — {@code zuwachs} UNGERUNDET in der
     * gespeicherten {@code einheit} der Reihe; gesprochen in ihrer Anzeige-Einheit mit den Stellen der
     * {@link #KENNZEICHEN_EBENE} ({@link #menge}). Hat die Einheit keine Anzeige-Einheit (unbekannt,
     * VAh, …), steht der Satz ohne Zahl — eine Zahl ohne Einheit liest sich um den Faktor 1 000 falsch.
     */
    public static String lueckeZuwachs(String von, String bis, BigDecimal zuwachs, String einheit) {
        if (anzeigeEinheit(einheit) == null) {
            return sprich("luecke_zuwachs_ohne_einheit", Map.of("von", von, "bis", bis));
        }
        return sprich("luecke_zuwachs",
                Map.of("von", von, "bis", bis, "zuwachs", menge(zuwachs, einheit, KENNZEICHEN_EBENE)));
    }

    /**
     * E7 — der Name jeder Ersatzwert-Methode in Kundensprache, in der Reihenfolge des Vokabulars
     * ({@code events-vocabulary-vectors.json} {@code vokabular.ersatzwert_methode[].name}). Das Kennzeichen
     * spricht den Namen, nie das Vertragswort.
     */
    public static final Map<String, String> ERSATZWERT_METHODE_NAME = namen(
            "gleichmaessig_verteilen", "Zuwachs gleichmäßig verteilen",
            "profil_vorperiode", "Zuwachs nach dem Profil der Vorperiode verteilen",
            "profil_vergleichsquelle", "Zuwachs nach dem Profil der Vergleichsquelle verteilen",
            "ablesestand_nachtragen", "Ablesestand nachtragen",
            "wert_eingeben", "Wert eingeben (mit Beleg)",
            "vorperiode_uebernehmen", "Vorperiode übernehmen",
            "vergleichsquelle_uebernehmen", "Vergleichsquelle übernehmen");

    private static Map<String, String> namen(String... paare) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            out.put(paare[i], paare[i + 1]);
        }
        return java.util.Collections.unmodifiableMap(out);
    }

    /** „mit Ersatzwert (Methode „Zuwachs gleichmäßig verteilen“, EW-2026-0003)“ — Rang 70, seit 1.4. */
    public static String ersatzwert(String methode, String kennung) {
        String name = ERSATZWERT_METHODE_NAME.get(methode);
        if (name == null) {
            throw new IllegalArgumentException("unbekannte Ersatzwert-Methode " + methode);
        }
        return sprich("mit_ersatzwert", Map.of("methode", name, "kennung", kennung));
    }

    /**
     * „korrigiert (Version 2)“ — Rang 80, seit 1.5 (AP-08 IP-17). Gesprochen von der Korrektur-Kaskade an jeder
     * Stufe, deren Version sie schreibt; Version 1 ist das Original und hat den Satz nie.
     */
    public static String korrigiert(int version) {
        if (version < 2) {
            throw new IllegalArgumentException("Version " + version + " ist nie korrigiert");
        }
        return sprich("korrigiert", Map.of("version", String.valueOf(version)));
    }

    /** Ob ein Satz das Kennzeichen „korrigiert (Version n)“ ist — die Kaskade vergleicht Zahlen OHNE ihn. */
    public static boolean istKorrigiert(String satz) {
        Erkannt e = erkenne(satz);
        return e != null && "korrigiert".equals(e.muster().schluessel());
    }

    /** „Neustart 10:22: bis zu 120 s Zählung möglicherweise verloren“. */
    public static String neustart(String uhr, long verlustS) {
        return sprich("neustart", Map.of(UHR, uhr, "verlust_s", Long.toString(verlustS)));
    }

    /** „1 von 15 Intervallmengen fehlt …“ bzw. „2 von 30 Intervallmengen fehlen …“. */
    public static String intervallmengenFehlen(int fehlend, int erwartet) {
        return fehlend == 1
                ? sprich("intervallmenge_fehlt", Map.of("erwartet", Integer.toString(erwartet)))
                : sprich("intervallmengen_fehlen",
                        Map.of("fehlend", Integer.toString(fehlend), "erwartet", Integer.toString(erwartet)));
    }

    /** „gemessene Zeit 13:50 min von 15 min“. */
    public static String gemesseneZeit(long gemessenS, long periodeMin) {
        return sprich("gemessene_zeit", Map.of(
                "minuten", Long.toString(gemessenS / 60),
                "sekunden", String.format(Locale.ROOT, "%02d", gemessenS % 60),
                "periode_min", Long.toString(periodeMin)));
    }

    /**
     * Ein erkannter Satz: sein Muster und die eingesetzten Werte.
     *
     * @param fruehereFassung der Satz trägt den Wortlaut einer früheren Fassung (gespeichert, nie
     *     mehr gesprochen)
     */
    public record Erkannt(Muster muster, Map<String, String> werte, boolean fruehereFassung) {}

    /**
     * Welches Muster ein Satz trägt, oder {@code null}, wenn er keines trägt. Passt ein Satz auf
     * zwei Muster, ist die LISTE falsch — das ist ein Vertragsfehler, kein Befund.
     */
    public static Erkannt erkenne(String satz) {
        Erkannt treffer = null;
        for (Erkenner e : ERKENNER) {
            Matcher m = e.ausdruck().matcher(satz);
            if (!m.matches()) {
                continue;
            }
            if (treffer != null) {
                throw new IllegalStateException("„" + satz + "“ passt auf " + treffer.muster().schluessel()
                        + " und " + e.muster().schluessel());
            }
            Map<String, String> werte = new LinkedHashMap<>();
            for (int i = 0; i < e.namen().size(); i++) {
                werte.put(e.namen().get(i), m.group(i + 1));
            }
            treffer = new Erkannt(e.muster(), Map.copyOf(werte), e.fruehereFassung());
        }
        return treffer;
    }

    /** Ob ein Satz mit einem vorgesehenen Wort beginnt, dessen Wortlaut noch nicht Vertrag ist. */
    public static boolean vorgesehen(String satz) {
        return erkenne(satz) == null && VORGESEHEN.stream().anyMatch(v -> satz.startsWith(v.anfang()));
    }

    // ------------------------------------------------------------------ Prüfen und Sprechen

    public static final String ZUSTAND_UNBEKANNT = "zustand_unbekannt";
    public static final String EINHEIT_UNBEKANNT = "einheit_unbekannt";
    public static final String EBENE_UNBEKANNT = "ebene_unbekannt";
    public static final String EBENE_FEHLT = "ebene_fehlt";
    public static final String ZAHL_FEHLT = "zahl_fehlt";
    public static final String ZAHL_VERBOTEN_VERSTOSS = "zahl_verboten";
    public static final String KENNZEICHEN_UNBEKANNT = "kennzeichen_unbekannt";
    public static final String KENNZEICHEN_VORGESEHEN = "kennzeichen_vorgesehen";
    public static final String KENNZEICHEN_DOPPELT = "kennzeichen_doppelt";
    public static final String KENNZEICHEN_REIHENFOLGE = "kennzeichen_reihenfolge";
    public static final String KENNZEICHEN_FOLGE = "kennzeichen_folge";
    public static final String VOLLSTAENDIG_MIT_FEHLBESTAND = "vollstaendig_mit_fehlbestand";
    public static final String UNVOLLSTAENDIG_OHNE_GRUND = "unvollstaendig_ohne_grund";
    public static final String KEINE_WERTE_MIT_FEHLBESTAND = "keine_werte_mit_fehlbestand";

    /** Das geschlossene Vokabular der Verstöße — in dieser Reihenfolge meldet {@link #pruefe} sie. */
    public static final List<String> VERSTOESSE = List.of(
            ZUSTAND_UNBEKANNT, EINHEIT_UNBEKANNT, EBENE_UNBEKANNT, EBENE_FEHLT, ZAHL_FEHLT,
            ZAHL_VERBOTEN_VERSTOSS, KENNZEICHEN_UNBEKANNT, KENNZEICHEN_VORGESEHEN, KENNZEICHEN_DOPPELT,
            KENNZEICHEN_REIHENFOLGE, KENNZEICHEN_FOLGE, VOLLSTAENDIG_MIT_FEHLBESTAND, UNVOLLSTAENDIG_OHNE_GRUND,
            KEINE_WERTE_MIT_FEHLBESTAND);

    /**
     * Ein abgeleitetes Ergebnis, wie eine Fläche es zeigt.
     *
     * @param wert die Zahl, ungerundet; {@code null} = keine Zahl (nie 0)
     * @param ebene {@code viertelstunde} … {@code jahr}; für kWh Pflicht
     * @param abdeckungProzent der Verlauf in Prozent, {@code null} = nicht nennen
     */
    public record Ergebnis(
            BigDecimal wert,
            String einheit,
            String ebene,
            String zustand,
            BigDecimal abdeckungProzent,
            List<String> kennzeichen) {}

    /** Alle Verstöße eines Ergebnisses gegen den Vertrag, geordnet und ohne Doppel; leer = gültig. */
    public static List<String> pruefe(Ergebnis e) {
        Set<String> v = new HashSet<>(pruefeZahl(e.einheit(), e.ebene()));
        Zustand z = ZUSTAENDE.stream().filter(x -> x.wort().equals(e.zustand())).findFirst().orElse(null);
        if (z == null) {
            v.add(ZUSTAND_UNBEKANNT);
        } else if (ZAHL_PFLICHT.equals(z.zahl()) && e.wert() == null) {
            v.add(ZAHL_FEHLT);
        } else if (ZAHL_VERBOTEN.equals(z.zahl()) && e.wert() != null) {
            v.add(ZAHL_VERBOTEN_VERSTOSS);
        }

        List<String> saetze = e.kennzeichen();
        List<Erkannt> erkannt = saetze.stream().map(ErgebnisZustand::erkenne).toList();
        Set<String> gesehen = new HashSet<>();
        int rang = Integer.MIN_VALUE;
        boolean fehlbestand = false;
        for (int i = 0; i < saetze.size(); i++) {
            Erkannt k = erkannt.get(i);
            if (k == null) {
                v.add(vorgesehen(saetze.get(i)) ? KENNZEICHEN_VORGESEHEN : KENNZEICHEN_UNBEKANNT);
                continue;
            }
            Muster m = k.muster();
            if (!gesehen.add(m.schluessel()) && m.einmalig()) {
                v.add(KENNZEICHEN_DOPPELT);
            }
            if (m.rang() < rang) {
                v.add(KENNZEICHEN_REIHENFOLGE);
            }
            rang = Math.max(rang, m.rang());
            Erkannt davor = i > 0 ? erkannt.get(i - 1) : null;
            if (m.folgtAuf() != null && (davor == null || !m.folgtAuf().contains(davor.muster().schluessel()))) {
                v.add(KENNZEICHEN_FOLGE);
            }
            Erkannt danach = i + 1 < saetze.size() ? erkannt.get(i + 1) : null;
            if (m.verlangtDanach() != null
                    && (danach == null || !m.verlangtDanach().equals(danach.muster().schluessel()))) {
                v.add(KENNZEICHEN_FOLGE);
            }
            fehlbestand |= m.fehlbestand();
        }

        if (z != null) {
            if (KEIN_FEHLBESTAND.equals(z.kennzeichen()) && fehlbestand) {
                v.add(VOLLSTAENDIG.equals(z.wort()) ? VOLLSTAENDIG_MIT_FEHLBESTAND : KEINE_WERTE_MIT_FEHLBESTAND);
            }
            if (MINDESTENS_EIN_FEHLBESTAND.equals(z.kennzeichen()) && !fehlbestand) {
                v.add(UNVOLLSTAENDIG_OHNE_GRUND);
            }
        }
        return VERSTOESSE.stream().filter(v::contains).toList();
    }

    /**
     * Der Kundensatz eines gültigen Ergebnisses: Zahl · Zustand · Verlauf · Kennzeichen
     * („2.304 kWh · vollständig · Verlauf 85 %“). Ein ungültiges wird nicht gesprochen.
     */
    public static String satz(Ergebnis e) {
        List<String> verstoesse = pruefe(e);
        if (!verstoesse.isEmpty()) {
            throw new IllegalArgumentException("Ergebnis verletzt den Vertrag: " + verstoesse);
        }
        List<String> teile = new ArrayList<>();
        teile.add(zahl(e.wert(), e.einheit(), e.ebene()));
        teile.add(e.zustand());
        if (e.abdeckungProzent() != null) {
            teile.add(ABDECKUNG + zahl(e.abdeckungProzent(), PROZENT, null));
        }
        teile.addAll(e.kennzeichen());
        return String.join(TRENNER, teile);
    }

    public static final String TRENNER = " · ";
    public static final String OHNE_ZAHL = "—";
    private static final String ABDECKUNG = "Verlauf ";

    // ------------------------------------------------------------------ Rundung (E11)

    public static final List<String> EBENEN = List.of("viertelstunde", "stunde", "tag", "monat", "jahr");

    public static final String KWH = "kWh";
    public static final String KW = "kW";
    public static final String PROZENT = "%";
    public static final String KUBIKMETER = "m³";
    /** Scheinleistung (Anschlussleistung) — „Leistung eine Nachkommastelle“ wie kW (E11, seit 1.2). */
    public static final String KVA = "kVA";
    /** Blindarbeit — Arbeit wie die Wirkarbeit, darum dieselben Stellen je Ebene wie kWh (seit 1.3). */
    public static final String KVARH = "kvarh";

    /** Die Stellen je Einheit und Ebene; {@code ebene == null} = für jede Ebene gleich. */
    public record Stellen(String einheit, String ebene, int stellen) {}

    public static final List<Stellen> STELLEN = List.of(
            new Stellen(KWH, "viertelstunde", 1),
            new Stellen(KWH, "stunde", 1),
            new Stellen(KWH, "tag", 0),
            new Stellen(KWH, "monat", 0),
            new Stellen(KWH, "jahr", 0),
            new Stellen(KVARH, "viertelstunde", 1),
            new Stellen(KVARH, "stunde", 1),
            new Stellen(KVARH, "tag", 0),
            new Stellen(KVARH, "monat", 0),
            new Stellen(KVARH, "jahr", 0),
            new Stellen(KW, null, 1),
            new Stellen(PROZENT, null, 0),
            new Stellen(KUBIKMETER, null, 1),
            new Stellen(KVA, null, 1));

    public static final String TAUSENDER = ".";
    public static final String DEZIMAL = ",";
    /** U+00A0 — geschütztes Leerzeichen vor der Einheit. */
    public static final String VOR_EINHEIT = " ";
    /** U+2212 — das Minuszeichen der Anzeige, nicht der ASCII-Bindestrich. */
    public static final String MINUS = "−";

    /** Die Verstöße von Einheit und Ebene allein; leer = anzeigbar. */
    public static List<String> pruefeZahl(String einheit, String ebene) {
        List<String> v = new ArrayList<>();
        if (STELLEN.stream().noneMatch(s -> s.einheit().equals(einheit))) {
            v.add(EINHEIT_UNBEKANNT);
        }
        if (ebene != null && !EBENEN.contains(ebene)) {
            v.add(EBENE_UNBEKANNT);
        } else if (ebene == null && (KWH.equals(einheit) || KVARH.equals(einheit))) {
            v.add(EBENE_FEHLT);
        }
        return List.copyOf(v);
    }

    /** Die Nachkommastellen — bestimmt von Einheit und EBENE, nie von der Fläche. */
    public static int stellen(String einheit, String ebene) {
        List<String> v = pruefeZahl(einheit, ebene);
        if (!v.isEmpty()) {
            throw new IllegalArgumentException("keine Anzeige für " + einheit + " / " + ebene + ": " + v);
        }
        return STELLEN.stream()
                .filter(s -> s.einheit().equals(einheit) && (s.ebene() == null || s.ebene().equals(ebene)))
                .findFirst()
                .orElseThrow()
                .stellen();
    }

    /**
     * E11 — die angezeigte Zahl mit Einheit: kaufmännisch gerundet auf die Stellen der Ebene,
     * Tausenderpunkt, Komma, geschütztes Leerzeichen („2.304 kWh“, „96,5 kW“, „85 %“). Kein Wert
     * ist „—“, nie 0. Gerechnet wird damit nie.
     */
    public static String zahl(BigDecimal wert, String einheit, String ebene) {
        int stellen = stellen(einheit, ebene);
        return wert == null ? OHNE_ZAHL : text(wert.setScale(stellen, RoundingMode.HALF_UP), einheit);
    }

    private static String text(BigDecimal gerundet, String einheit) {
        String klartext = gerundet.abs().toPlainString();
        int punkt = klartext.indexOf('.');
        String ganz = punkt < 0 ? klartext : klartext.substring(0, punkt);
        StringBuilder gruppiert = new StringBuilder();
        for (int i = 0; i < ganz.length(); i++) {
            if (i > 0 && (ganz.length() - i) % 3 == 0) {
                gruppiert.append(TAUSENDER);
            }
            gruppiert.append(ganz.charAt(i));
        }
        if (punkt >= 0) {
            gruppiert.append(DEZIMAL).append(klartext.substring(punkt + 1));
        }
        return (gerundet.signum() < 0 ? MINUS : "") + gruppiert + VOR_EINHEIT + einheit;
    }

    /**
     * Die Anzeige-Einheit einer GESPEICHERTEN Einheit (seit 1.3, Ableitung aus E11): gespeichert bleibt,
     * was der Zähler liefert; angezeigt wird kWh für Wirkarbeit, kvarh für Blindarbeit, m³ für Volumen —
     * „1.482.300 kWh“, nie „1.482,3 MWh“.
     *
     * @param faktor gespeicherter Wert × faktor = Wert in der Anzeige-Einheit
     */
    public record AnzeigeEinheit(String gespeichert, String angezeigt, BigDecimal faktor) {}

    public static final List<AnzeigeEinheit> ANZEIGE_EINHEITEN = List.of(
            new AnzeigeEinheit("Wh", KWH, new BigDecimal("0.001")),
            new AnzeigeEinheit("kWh", KWH, BigDecimal.ONE),
            new AnzeigeEinheit("MWh", KWH, new BigDecimal("1000")),
            new AnzeigeEinheit("varh", KVARH, new BigDecimal("0.001")),
            new AnzeigeEinheit("kvarh", KVARH, BigDecimal.ONE),
            new AnzeigeEinheit(KUBIKMETER, KUBIKMETER, BigDecimal.ONE));

    /**
     * Die Ebene, deren Stellen eine Menge IN einem Kennzeichen spricht: ein Satz wandert unverändert von
     * der Viertelstunde in Tag, Monat und Jahr, darf also nicht je Periode anders runden (seit 1.3).
     */
    public static final String KENNZEICHEN_EBENE = "viertelstunde";

    /** Die Anzeige-Einheit zu einer gespeicherten Einheit; {@code null}, wenn es keine gibt. */
    public static AnzeigeEinheit anzeigeEinheit(String gespeichert) {
        return ANZEIGE_EINHEITEN.stream().filter(a -> a.gespeichert().equals(gespeichert)).findFirst().orElse(null);
    }

    /** Die Verstöße einer gespeicherten Einheit und Ebene; leer = anzeigbar. */
    public static List<String> pruefeMenge(String gespeichert, String ebene) {
        AnzeigeEinheit a = anzeigeEinheit(gespeichert);
        return a == null ? List.of(EINHEIT_UNBEKANNT) : pruefeZahl(a.angezeigt(), ebene);
    }

    /**
     * E11 für eine Menge in ihrer GESPEICHERTEN Einheit: in die Anzeige-Einheit umgerechnet, dann
     * {@link #zahl} („337600 Wh“ → „337,6 kWh“ an der Viertelstunde). Kein Wert ist „—“.
     */
    public static String menge(BigDecimal wert, String gespeichert, String ebene) {
        List<String> v = pruefeMenge(gespeichert, ebene);
        if (!v.isEmpty()) {
            throw new IllegalArgumentException("keine Anzeige für " + gespeichert + " / " + ebene + ": " + v);
        }
        AnzeigeEinheit a = anzeigeEinheit(gespeichert);
        return zahl(wert == null ? null : wert.multiply(a.faktor()), a.angezeigt(), ebene);
    }

    /** Eine genannte Rundungsdifferenz; {@code differenz}/{@code satz} sind {@code null}, wenn es keine gibt. */
    public record Rundungsdifferenz(String summeDerAngezeigten, String differenz, String satz) {}

    /**
     * E11 — die Differenz zwischen der Summe der ANGEZEIGTEN Teile und der angezeigten Summe
     * (angezeigte Teile minus angezeigte Summe). Sie wird genannt, nie in einen Teil „korrigiert“.
     */
    public static Rundungsdifferenz rundungsdifferenz(
            String einheit, List<BigDecimal> teile, String ebeneTeile, BigDecimal summe, String ebeneSumme) {
        int st = stellen(einheit, ebeneTeile);
        int ss = stellen(einheit, ebeneSumme);
        BigDecimal angezeigt = BigDecimal.ZERO.setScale(st);
        for (BigDecimal t : teile) {
            angezeigt = angezeigt.add(t.setScale(st, RoundingMode.HALF_UP));
        }
        BigDecimal differenz = angezeigt.subtract(summe.setScale(ss, RoundingMode.HALF_UP))
                .setScale(Math.max(st, ss), RoundingMode.UNNECESSARY);
        String summeText = text(angezeigt, einheit);
        if (differenz.signum() == 0) {
            return new Rundungsdifferenz(summeText, null, null);
        }
        String differenzText = text(differenz, einheit);
        return new Rundungsdifferenz(summeText, differenzText,
                "Summe der angezeigten Werte " + summeText + TRENNER + "Rundungsdifferenz " + differenzText);
    }

    // ------------------------------------------------------------------ Sommerzeit (E10)

    public static final Map<Long, String> TAGESDAUER = Map.of(
            23L, "23 Stunden (Zeitumstellung)",
            25L, "25 Stunden (Zeitumstellung)");

    /** Die Schrittweite je Raster, in Minuten. */
    public static final Map<String, Integer> SCHRITTE = Map.of("viertelstunde", 15, "stunde", 60);

    private static final ZoneOffset MEZ = ZoneOffset.ofHours(1);
    private static final ZoneOffset MESZ = ZoneOffset.ofHours(2);
    private static final DateTimeFormatter WANDUHR = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);
    /** ISO-8601 mit Offset — {@code xxx} schreibt auch UTC als {@code +00:00}, nie {@code Z}. */
    private static final DateTimeFormatter EXPORT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx", Locale.ROOT);

    /**
     * E10 — was die Tageskarte über die Länge des Tages sagt: „25 Stunden (Zeitumstellung)“ bzw.
     * „23 Stunden (Zeitumstellung)“, an einem 24-Stunden-Tag nichts ({@code null}).
     */
    public static String tagesdauer(LocalDate tag, ZoneId zone) {
        return TAGESDAUER.get(BezugsPeriode.stundenDesTages(tag, zone));
    }

    /** Ein Feld des Rasters: die Beschriftung und sein Beginn als ISO-8601 mit Offset (Export). */
    public record Feld(String beschriftung, String von) {}

    /**
     * E10 — die Viertelstunden oder Stunden eines Kalendertages in der Ortszeit des Standorts.
     * Eine Beschriftung, die an diesem Tag zweimal vorkommt, trägt ihren Zusatz: MESZ/MEZ in einer
     * Zone mit Normalzeit UTC+01:00, sonst ihren Offset („UTC+00:00“). Die fehlende Stunde erscheint
     * nicht. Die Beschriftung ist die Wanduhr des Beginns plus Schritt.
     */
    public static List<Feld> raster(LocalDate tag, ZoneId zone, String schritt) {
        Integer minuten = SCHRITTE.get(schritt);
        if (minuten == null) {
            throw new IllegalArgumentException("unbekannter Schritt " + schritt + " — bekannt sind " + SCHRITTE.keySet());
        }
        Instant ende = tag.plusDays(1).atStartOfDay(zone).toInstant();
        ZoneOffset normalzeit = normalzeit(zone, tag.getYear());
        List<String[]> roh = new ArrayList<>();
        for (Instant t = tag.atStartOfDay(zone).toInstant(); t.isBefore(ende); t = t.plusSeconds(minuten * 60L)) {
            ZoneOffset offset = zone.getRules().getOffset(t);
            LocalDateTime wand = LocalDateTime.ofInstant(t, offset);
            roh.add(new String[] {
                WANDUHR.format(wand) + "–" + WANDUHR.format(wand.plusMinutes(minuten)),
                zusatz(normalzeit, offset),
                EXPORT.format(t.atOffset(offset))
            });
        }
        Set<String> einmal = new HashSet<>();
        Set<String> doppelt = new LinkedHashSet<>();
        for (String[] r : roh) {
            if (!einmal.add(r[0])) {
                doppelt.add(r[0]);
            }
        }
        return roh.stream()
                .map(r -> new Feld(doppelt.contains(r[0]) ? r[0] + " " + r[1] : r[0], r[2]))
                .toList();
    }

    /**
     * E10 — die Uhrzeit IN einem Kennzeichen: Wanduhr {@code HH:mm} in {@code zone}. Gibt es diese
     * Wanduhr an dem Tag zweimal (die doppelte Stunde am Sommerzeit-Ende), trägt sie denselben
     * Zusatz wie {@link #raster}: „02:30 MESZ“ bzw. „02:30 MEZ“, in anderen Zonen den Offset.
     */
    public static String uhr(Instant zeit, ZoneId zone) {
        ZoneOffset offset = zone.getRules().getOffset(zeit);
        LocalDateTime wand = LocalDateTime.ofInstant(zeit, offset);
        String text = WANDUHR.format(wand);
        if (zone.getRules().getValidOffsets(wand).size() < 2) {
            return text;
        }
        return text + " " + zusatz(normalzeit(zone, wand.getYear()), offset);
    }

    private static ZoneOffset normalzeit(ZoneId zone, int jahr) {
        return zone.getRules().getOffset(LocalDate.of(jahr, 1, 1).atStartOfDay().toInstant(ZoneOffset.UTC));
    }

    private static String zusatz(ZoneOffset normalzeit, ZoneOffset offset) {
        if (normalzeit.equals(MEZ) && (offset.equals(MEZ) || offset.equals(MESZ))) {
            return offset.equals(MEZ) ? "MEZ" : "MESZ";
        }
        int s = offset.getTotalSeconds();
        return String.format(Locale.ROOT, "UTC%s%02d:%02d", s < 0 ? "-" : "+", Math.abs(s) / 3600, Math.abs(s) % 3600 / 60);
    }
}
