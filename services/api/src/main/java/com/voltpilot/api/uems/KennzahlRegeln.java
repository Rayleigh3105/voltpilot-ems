package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Die Regeln der KENNZAHL (UEMS AP-11 IP-3) — Vertrag {@code docs/contracts/v2/kennzahl.md}, Vektoren
 * {@code kennzahl-vectors.json}, TS-Zwilling {@code frontend/portal/src/uemsKennzahl.ts}.
 *
 * <p>Eine Kennzahl TEILT: Menge je Bezugsgröße ({@code quotient}), Teil am Ganzen ({@code anteil}), Summe durch
 * Summe über Kennzahlen oder Teilperioden ({@code zusammenfassung}). Ein Mittel von Quotienten bildet diese Klasse
 * nirgends — es gibt keine Funktion, die durch die Zahl der Teile teilt.
 *
 * <p>Wiederverwendet, nicht kopiert (E1): der Kreis ist {@link MessstelleFormelRegeln#zyklus}, eine Fassung
 * {@link MessstelleFormelRegeln#fassungEintrag} und {@link MessstelleFormelRegeln#fassungAm}, der Stichtag eines
 * Stammdatums {@link BezugsdatenRegeln#wertAm}, die Grenzen einer Periode {@link BezugsPeriode#spanneVon}, Zahl und
 * Einheit einer Anzeige {@link ErgebnisZustand}. Wer anlegen darf, entscheidet {@link RechteAbleitung#darf}; hier
 * steht nur, welche Kennung und welches Ziel eine Kennzahl dafür braucht (G1).
 *
 * <p>Rein: kein Spring, keine DB, keine Uhr. Noch ruft niemand an (Tabellen, Routen und Lauf ab AP-11 IP-4).
 */
public final class KennzahlRegeln {

    private KennzahlRegeln() {}

    // ============================================================== Vokabulare (§7)

    public static final String QUOTIENT = "quotient";
    public static final String ANTEIL = "anteil";
    public static final String ZUSAMMENFASSUNG = "zusammenfassung";
    public static final List<String> RECHENFORMEN = List.of(QUOTIENT, ANTEIL, ZUSAMMENFASSUNG);
    /** Vorgesehen, nicht gebaut (E2): {@code produkt} ist {@link #RECHENFORM_UNBEKANNT}. */
    public static final List<String> RECHENFORMEN_VORGESEHEN = List.of("produkt");

    public static final String MESSSTELLE = "messstelle";
    public static final String BEZUGSGROESSE = "bezugsgroesse";
    public static final String KENNZAHL = "kennzahl";
    /**
     * Wie eine BEZUGSFLÄCHE der Ortsstruktur in einer ANFRAGE genannt wird (AP-11 §5.1) — {@code kennzeichen} ist dann
     * das Kurzzeichen des Standorts, Gebäudes oder Bereichs. Was daraus WIRD, ist eine Bezugsgröße mit Wertart
     * {@code stammdatum} in m² (E17): kein Wort mehr in {@link #EINGANG_ARTEN}, keine zweite Rechenregel.
     */
    public static final String BEZUGSFLAECHE = "bezugsflaeche";
    public static final List<String> EINGANG_ARTEN = List.of(MESSSTELLE, BEZUGSGROESSE, KENNZAHL);
    /** Die Arten, die eine Anfrage nennen darf — {@link #EINGANG_ARTEN} und die Bezugsfläche als ihr Name. */
    public static final List<String> EINGANG_ARTEN_ANFRAGE =
            List.of(MESSSTELLE, BEZUGSGROESSE, BEZUGSFLAECHE, KENNZAHL);
    public static final List<String> EINGANG_ROLLEN = List.of("zaehler", "nenner", "paar");

    /** Die Wertart einer Bezugsgröße als Nenner (Q1): eingegeben/importiert, Stammdatum, aus einem Messkanal. */
    public static final String PERIODENWERT = "periodenwert";
    public static final String STAMMDATUM = "stammdatum";
    public static final String KANAL = "kanal";
    public static final String STAND = "stand";
    public static final String MOMENTANWERT = "Momentanwert";
    public static final String WIRKSAM = "wirksam";
    public static final String ZURUECKGENOMMEN = "zurueckgenommen";

    public static final List<String> PERIODEN = List.of("tag", "woche", "monat", "jahr");
    public static final List<String> GELTUNG_ARTEN =
            List.of("unternehmen", "standort", "gebaeude", "bereich", "prozess", "kostenstelle", "messstelle");

    /** Rang der Zustandswörter vom besten zum schlechtesten (Q3) — die Wörter des Ergebnis-Zustands. */
    public static final List<String> ZUSTAND_RANG = List.of(ErgebnisZustand.VOLLSTAENDIG,
            ErgebnisZustand.MIT_ERSATZWERT, ErgebnisZustand.UNVOLLSTAENDIG, ErgebnisZustand.KEINE_WERTE);

    public static final String UNTERGRENZE = "untergrenze";
    public static final String OBERGRENZE = "obergrenze";
    public static final String UNBESTIMMT = "unbestimmt";
    public static final List<String> RICHTUNGEN = List.of(UNTERGRENZE, OBERGRENZE, UNBESTIMMT);

    public static final String NENNER_FEHLT = "nenner_fehlt";
    public static final String NENNER_NULL = "nenner_null";
    public static final String ZAEHLER_FEHLT = "zaehler_fehlt";
    public static final String PERIODE_NICHT_ZU_ENDE = BezugsPeriode.PERIODE_NICHT_ZU_ENDE;
    public static final String VOR_BESTEHEN = "vor_bestehen";
    public static final String HAENGT_AN_KREIS = "haengt_an_kreis";
    public static final String EINGANG_ARCHIVIERT = "eingang_archiviert";
    public static final List<String> GRUENDE_OHNE_ZAHL = List.of(NENNER_FEHLT, NENNER_NULL, ZAEHLER_FEHLT,
            PERIODE_NICHT_ZU_ENDE, VOR_BESTEHEN, HAENGT_AN_KREIS, EINGANG_ARCHIVIERT);

    public static final String PERIODE_PASST_NICHT = BezugsPeriode.PERIODE_PASST_NICHT;
    public static final String EINHEIT_UNPASSEND = "einheit_unpassend";
    public static final String GROESSE_UNBEKANNT = "groesse_unbekannt";
    public static final String EINGANG_AUSSERHALB_GELTUNG = "eingang_ausserhalb_geltung";
    public static final String FORMEL_ZYKLUS = "formel_zyklus";
    public static final String FASSUNG_UEBERLAPPT = "fassung_ueberlappt";
    public static final String GELTUNG_UNBEKANNT = "geltung_unbekannt";
    public static final String EINGANG_UNBEKANNT = "eingang_unbekannt";
    public static final String RECHENFORM_UNBEKANNT = "rechenform_unbekannt";
    public static final String ANFRAGE_UNGUELTIG = "anfrage_ungueltig";
    public static final List<String> FEHLER = List.of(PERIODE_PASST_NICHT, EINHEIT_UNPASSEND, GROESSE_UNBEKANNT,
            EINGANG_AUSSERHALB_GELTUNG, FORMEL_ZYKLUS, FASSUNG_UEBERLAPPT, GELTUNG_UNBEKANNT, EINGANG_UNBEKANNT,
            RECHENFORM_UNBEKANNT, ANFRAGE_UNGUELTIG);

    public static final String MIT_WERT = "mit_wert";
    public static final String HINWEIS_OHNE_WERT = "hinweis_ohne_wert";
    public static final String NICHT_SICHTBAR = "nicht_sichtbar";
    public static final List<String> SICHTBARKEIT = List.of(MIT_WERT, HINWEIS_OHNE_WERT, NICHT_SICHTBAR);

    /** Protokoll-Arten der Definition (V1, V4, V5) — geschrieben ab AP-11 IP-5. */
    public static final List<String> PROTOKOLL =
            List.of("kennzahl_fassung_eingetragen", "kennzahl_geaendert", "kennzahl_archiviert");
    /** Die Reservierungen im Ereignis-Vokabular ({@code events-vocabulary-vectors.json} Block {@code reserviert}). */
    public static final List<String> EREIGNISSE_RESERVIERT =
            List.of("correction/bezugsgroesse", "kennzahl_neu_gebildet/kennzahl");

    public static final String STANDORT = "standort";
    public static final String UNTERNEHMEN = "unternehmen";
    /** G1: Rechte-Geltungsbereich je Fach-Geltungsbereich. */
    public static final Map<String, String> RECHTE_GELTUNG = geordnet(
            "unternehmen", UNTERNEHMEN, "standort", STANDORT, "gebaeude", STANDORT, "bereich", STANDORT,
            "prozess", UNTERNEHMEN, "kostenstelle", UNTERNEHMEN, "messstelle", STANDORT);
    /** R1: die Kennung, die Anlegen, Fassung, Ändern und Archivieren je Rechte-Geltungsbereich brauchen. */
    public static final Map<String, String> KENNUNG = geordnet(
            STANDORT, "kennzahl.standort_definieren", UNTERNEHMEN, "kennzahl.unternehmen_definieren");
    /** R2: Ansehen. */
    public static final String ANSEHEN = "messwerte.ansehen";
    public static final List<String> RECHTE =
            List.of("kennzahl.standort_definieren", "kennzahl.unternehmen_definieren", ANSEHEN);

    public static final String VORLAEUFIG = "vorläufig";
    public static final String ENDGUELTIG = "endgültig";

    // ============================================================== Perioden (E3)

    /** P2: in welche Perioden eine Periode restlos aufgeht (sie selbst eingeschlossen). */
    public static final Map<String, List<String>> AUFGEHEN = geordnet(
            "tag", List.of("tag", "woche", "monat", "jahr"), "woche", List.of("woche"),
            "monat", List.of("monat", "jahr"), "jahr", List.of("jahr"));

    public record PeriodenWoerter(String werte, String werteDativ, String wert, String je, String teile, String ende) {}

    public static final Map<String, PeriodenWoerter> PERIODEN_WOERTER = geordnet(
            "tag", new PeriodenWoerter("Tageswerte", "Tageswerten", "Tageswert", "Tag", "Tage", "Tagesende"),
            "woche", new PeriodenWoerter("Wochenwerte", "Wochenwerten", "Wochenwert", "Woche", "Wochen", "Ende der Woche"),
            "monat", new PeriodenWoerter("Monatswerte", "Monatswerten", "Monatswert", "Monat", "Monate", "Monatsende"),
            "jahr", new PeriodenWoerter("Jahreswerte", "Jahreswerten", "Jahreswert", "Jahr", "Jahre", "Jahresende"));

    public static final List<String> MONATSNAMEN = List.of("Januar", "Februar", "März", "April", "Mai", "Juni",
            "Juli", "August", "September", "Oktober", "November", "Dezember");

    // ============================================================== Zahlen und Einheiten (E11)

    /** Gerechnet wird ungerundet — auf so viele Stellen, kaufmännisch. */
    public static final int WERT_NACHKOMMASTELLEN = 10;
    /** Die Vektoren vergleichen auf so viele Stellen (wie bezugsdaten-vectors.json). */
    public static final int VERGLEICH_NACHKOMMASTELLEN = 4;
    /** U4: ein Quotient steht mit 2 Stellen da; ein Anteil ganzzahlig über die Einheit % des Ergebnis-Zustands. */
    public static final int ANZEIGE_NACHKOMMASTELLEN = 2;
    public static final BigDecimal ANTEIL_FAKTOR = new BigDecimal("100");
    public static final String JE = " je ";
    public static final String EINHEIT_TRENNER = "/";
    /** Das Paar spricht die Nenner-Einheit in der Einzahl: „kWh je Person“. */
    public static final Map<String, String> EINZAHL = geordnet("Personen", "Person", "Schichten", "Schicht");
    public static final String OHNE_ZAHL = ErgebnisZustand.OHNE_ZAHL;
    private static final String NBSP = " ";

    public static final List<String> VERBOTENE_WOERTER =
            List.of("Mittel", "Durchschnitt", "KPI", "Metrik", "Kenngröße", "Dashboard", "Widget", "Template");

    // ============================================================== Kundensätze (§5.8)

    public static final Map<String, String> SAETZE = geordnet(
            "periode_zu_grob", "{objekt} führt {q_werte}. Eine Kennzahl je {g_je} ist damit nicht bildbar — ein {q_wert} wird nie auf {g_teile} verteilt.",
            "periode_geht_nicht_auf", "{objekt} führt {q_werte}. Eine Kennzahl je {g_je} ist daraus nicht bildbar — {q_werte} gehen nicht restlos in {g_werte_dativ} auf.",
            "nur_stammdaten", "Eine Kennzahl braucht mindestens einen Eingang mit Werten je Periode — Stammdaten allein haben keine Periode.",
            "zusammenfassung_zu_klein", "Eine Zusammenfassung braucht mindestens zwei Kennzahlen.",
            "einheit_anteil", "Ein Anteil braucht zwei Werte derselben Größe — {zaehler} ({zaehler_einheit}) und {nenner} ({nenner_einheit}) ergeben einen Quotienten, keinen Anteil.",
            "einheit_paare", "Eine Zusammenfassung braucht Kennzahlen derselben Rechenform und Einheit — {erste} ({erste_einheit}) und {andere} ({andere_einheit}) passen nicht zusammen.",
            "einheit_momentanwert", "{objekt} ist ein Momentanwert ({einheit}) — eine Kennzahl rechnet nur mit Mengen.",
            "einheit_stand", "{objekt} führt Stände — eine Kennzahl rechnet nur mit Werten je Periode oder einem Stammdatum.",
            "einheit_verhaeltnis", "{objekt} ist schon ein Verhältnis ({einheit}) — daraus entsteht keine prüfbare Einheit.",
            "groesse_unbekannt", "Dieser Messwert hat keine Vertrags-Messgröße — er kann keine Menge sein.",
            "eingang_ausserhalb_geltung", "{objekt} liegt in {eingang_standort} — eine Kennzahl für {kennzahl_standort} kann sie nicht lesen.",
            "formel_zyklus", "Diese Berechnung würde im Kreis laufen: {kette}. Eine Kennzahl kann sich nicht selbst enthalten.",
            "eingang_unbekannt", "Die {art} {objekt} gibt es nicht.",
            "rechenform_unbekannt", "Diese Rechenform gibt es noch nicht.",
            "geltung_unbekannt_unternehmen", "Dieses Unternehmen gibt es nicht (mehr).",
            "geltung_unbekannt_standort", "Diesen Standort gibt es nicht (mehr).",
            "geltung_unbekannt_gebaeude", "Dieses Gebäude gibt es nicht (mehr).",
            "geltung_unbekannt_bereich", "Diesen Bereich gibt es nicht (mehr).",
            "geltung_unbekannt_prozess", "Diesen Prozess gibt es nicht (mehr).",
            "geltung_unbekannt_kostenstelle", "Diese Kostenstelle gibt es nicht (mehr).",
            "geltung_unbekannt_messstelle", "Diese Messstelle gibt es nicht (mehr).",
            "nenner_fehlt", "Für {periode} fehlt der Wert der Bezugsgröße {objekt}.",
            "nenner_fehlt_messstelle", "Für {periode} fehlt der Wert von {objekt}.",
            "zaehler_fehlt", "Für {periode} fehlt die Menge {objekt}.",
            "nenner_null", "Nenner 0 (0" + NBSP + "{einheit}) — ein Wert je {einheit_je} ist ohne {einheit} nicht bildbar.",
            "periode_nicht_zu_ende", "Der Wert der Bezugsgröße für {periode} kann erst nach {ende} eingegeben werden.",
            "anzeige_untergrenze", "mindestens {zahl}",
            "anzeige_obergrenze", "höchstens {zahl}",
            "wort_messstelle", "Messstelle",
            "wort_bezugsgroesse", "Bezugsgröße",
            "wort_kennzahl", "Kennzahl");

    // ============================================================== Kennzeichen (ergebnis-zustand 1.9)

    public static final Map<String, String> PLATZHALTER = geordnet(
            "datum", "(?:0[1-9]|[12][0-9]|3[01])\\.(?:0[1-9]|1[0-2])\\.[0-9]{4}",
            "text", ".+",
            "bezeichnung", "(?!Berechnung\\b).+",
            "objekt", "(?:MS-[0-9]{2,}|BZ-[0-9]+|KZ-[0-9]{4,})",
            "geltung", "(?:U|[A-Z]{1,2}-[0-9]+|[0-9]{4})",
            "ganzzahl", "(?:0|[1-9][0-9]*)",
            "ganzzahl_ab_2", "(?:[2-9]|[1-9][0-9]+)",
            "wort", "(?:Gebäuden|Standorten|Bereichen|Prozessen|Kostenstellen|Messstellen|Kennzahlen|Tagen|Wochen|Monaten|Jahren|Systemen)");

    /** Ein Kennzeichen-Satz eines Kennzahl-Werts: Muster, Rang, woher er kommt, wo er steht, ob ohne Zahl. */
    public record Kennzeichen(String schluessel, String muster, Map<String, String> platzhalter, int rang,
            String herkunft, String stelle, boolean ohneZahl) {}

    public static final String BERECHNET_KENNZAHL = "berechnet (Kennzahl)";
    public static final String GEWICHTET = "gewichtet (Summe ÷ Summe)";
    public static final String RICHTUNG_UNBESTIMMT = "Richtung unbestimmt — Menge und Bezugsgröße unvollständig";
    public static final String UNPLAUSIBEL_UEBER_100 = "unplausibel (über 100" + NBSP + "%)";
    public static final String UNPLAUSIBEL_NEGATIV = "unplausibel (negativ)";

    private static final Map<String, String> T = Map.of("text", "text");
    public static final List<Kennzeichen> KENNZEICHEN = List.of(
            new Kennzeichen("berechnet_kennzahl", BERECHNET_KENNZAHL, Map.of(), 10, "eigen", "wert", false),
            new Kennzeichen("enthaelt_berechnet", "enthält berechnet ({text})", T, 20, "geerbt", "wert", false),
            new Kennzeichen("enthaelt_verteilt", "enthält verteilt ({text})", T, 21, "geerbt", "wert", false),
            new Kennzeichen("gewichtet", GEWICHTET, Map.of(), 30, "eigen", "wert", false),
            new Kennzeichen("untergrenze", "Untergrenze — Menge unvollständig ({text})", T, 40, "eigen", "wert", false),
            new Kennzeichen("obergrenze", "Obergrenze — Bezugsgröße unvollständig ({text})", T, 40, "eigen", "wert", false),
            new Kennzeichen("richtung_unbestimmt", RICHTUNG_UNBESTIMMT, Map.of(), 40, "eigen", "wert", false),
            new Kennzeichen("nenner_null", "Nenner 0 ({text})", T, 41, "eigen", "wert", true),
            new Kennzeichen("ab", "ab {datum}", Map.of("datum", "datum"), 50, "geerbt", "wert", false),
            new Kennzeichen("mit_ersatzwert", "mit Ersatzwert ({text})", T, 51, "geerbt", "wert", false),
            new Kennzeichen("stammdatum_geaendert", "{bezeichnung} geändert am {datum} ({wechsel})",
                    Map.of("bezeichnung", "bezeichnung", "datum", "datum", "wechsel", "text"), 52, "geerbt", "wert", false),
            new Kennzeichen("betriebszeit_annahme", "aus Leistung über {text} kW (Annahme)", T, 53, "geerbt", "wert", false),
            new Kennzeichen("berechnung_geaendert_am", "Berechnung geändert am {datum} (Fassung {von} → {nach})",
                    Map.of("datum", "datum", "von", "ganzzahl", "nach", "ganzzahl_ab_2"), 55, "eigen", "wert", false),
            new Kennzeichen("x_von_y", "{mit} von {gesamt} {wort}",
                    Map.of("mit", "ganzzahl", "gesamt", "ganzzahl", "wort", "wort"), 60, "beides", "wert", false),
            new Kennzeichen("x_von_y_fehlt", "{mit} von {gesamt} {wort} ({fehlt})",
                    Map.of("mit", "ganzzahl", "gesamt", "ganzzahl", "wort", "wort", "fehlt", "text"), 60, "eigen", "wert", false),
            new Kennzeichen("ab_mit_geltung", "{geltung} ab {datum}", Map.of("geltung", "geltung", "datum", "datum"), 70,
                    "geerbt", "wert", false),
            new Kennzeichen("unplausibel_ueber_100", UNPLAUSIBEL_UEBER_100, Map.of(), 80, "eigen", "wert", false),
            new Kennzeichen("unplausibel_negativ", UNPLAUSIBEL_NEGATIV, Map.of(), 80, "eigen", "wert", false),
            new Kennzeichen("eingang_ausserhalb", "Eingang {objekt} seit {datum} außerhalb von {name}",
                    Map.of("objekt", "objekt", "datum", "datum", "name", "text"), 81, "eigen", "wert", false),
            new Kennzeichen("bezugsgroesse_archiviert", "Bezugsgröße archiviert ({objekt})", Map.of("objekt", "objekt"), 82,
                    "eigen", "wert", false),
            new Kennzeichen("eingang_archiviert", "Eingang archiviert ({objekt})", Map.of("objekt", "objekt"), 82, "eigen",
                    "wert", false),
            new Kennzeichen("korrigiert", "korrigiert (Version {version})", Map.of("version", "ganzzahl_ab_2"), 90, "eigen",
                    "wert", true),
            new Kennzeichen("berechnung_geaendert", "Berechnung geändert (Fassung {fassung})",
                    Map.of("fassung", "ganzzahl_ab_2"), 90, "eigen", "wert", true),
            new Kennzeichen("nenner_zurueckgenommen", "Nenner zurückgenommen ({text})", T, 91, "eigen", "wert", true),
            new Kennzeichen("stichtag", "Stichtag {datum}", Map.of("datum", "datum"), 100, "eigen", "eingang", false));

    /** Q8: welcher Satz eines Eingangs an die Kennzahl erbt, und als was ({@code {0}} = der Satz, {@code {geltung}}). */
    public record Erbregel(String muster, String als, List<String> von) {}

    public static final List<Erbregel> ERBEND = List.of(
            new Erbregel("^berechnet \\((?!Kennzahl\\)$).+\\)$", "enthält {0}", List.of(MESSSTELLE)),
            new Erbregel("^verteilt \\(.+\\)$", "enthält {0}", List.of(MESSSTELLE)),
            new Erbregel("^enthält (?:berechnet|verteilt) \\(.+\\)$", "{0}", List.of(MESSSTELLE)),
            new Erbregel("^ab \\d{2}\\.\\d{2}\\.\\d{4}$", "{0}", List.of(MESSSTELLE, BEZUGSGROESSE)),
            new Erbregel("^ab \\d{2}\\.\\d{2}\\.\\d{4}$", "{geltung} {0}", List.of(KENNZAHL)),
            new Erbregel("^mit Ersatzwert \\(.+\\)$", "{0}", List.of(MESSSTELLE)),
            new Erbregel("^(?!Berechnung\\b).+ geändert am \\d{2}\\.\\d{2}\\.\\d{4} \\(.+\\)$", "{0}", List.of(BEZUGSGROESSE)),
            new Erbregel("^\\d+ von \\d+ Systemen$", "{0}", List.of(MESSSTELLE)),
            new Erbregel("^aus Leistung über .+ kW \\(Annahme\\)$", "{0}", List.of(BEZUGSGROESSE, KENNZAHL)));

    public static final String KENNZEICHEN_UNBEKANNT = "kennzeichen_unbekannt";
    public static final String KENNZEICHEN_STELLE = "kennzeichen_stelle";
    public static final String KENNZEICHEN_DOPPELT = "kennzeichen_doppelt";
    public static final String KENNZEICHEN_REIHENFOLGE = "kennzeichen_reihenfolge";

    private static final Map<String, Pattern> MUSTER = new LinkedHashMap<>();
    private static final Map<String, Pattern> ERB_MUSTER = new LinkedHashMap<>();

    static {
        Pattern platz = Pattern.compile("\\{([a-z_]+)\\}");
        for (Kennzeichen k : KENNZEICHEN) {
            StringBuilder sb = new StringBuilder();
            Matcher m = platz.matcher(k.muster());
            int ende = 0;
            while (m.find()) {
                sb.append(Pattern.quote(k.muster().substring(ende, m.start())));
                sb.append("(?:").append(PLATZHALTER.get(k.platzhalter().get(m.group(1)))).append(')');
                ende = m.end();
            }
            sb.append(Pattern.quote(k.muster().substring(ende)));
            MUSTER.put(k.schluessel(), Pattern.compile(sb.toString()));
        }
        for (Erbregel r : ERBEND) {
            ERB_MUSTER.putIfAbsent(r.muster(), Pattern.compile(r.muster()));
        }
    }

    /** Das EINE Muster, auf das ein Satz passt — {@code null}, wenn keines oder mehrere passen. */
    public static Kennzeichen erkenne(String satz) {
        Kennzeichen gefunden = null;
        for (Kennzeichen k : KENNZEICHEN) {
            if (MUSTER.get(k.schluessel()).matcher(satz).matches()) {
                if (gefunden != null) {
                    return null;
                }
                gefunden = k;
            }
        }
        return gefunden;
    }

    /** Die Verstöße einer Kennzeichen-Liste eines Werts; leer = in Ordnung. */
    public static List<String> kennzeichenPruefen(List<String> liste) {
        boolean unbekannt = false;
        boolean stelle = false;
        boolean doppelt = false;
        boolean reihenfolge = false;
        Set<String> gesehen = new HashSet<>();
        int rang = 0;
        for (String satz : liste) {
            doppelt |= !gesehen.add(satz);
            Kennzeichen k = erkenne(satz);
            if (k == null) {
                unbekannt = true;
                continue;
            }
            stelle |= !"wert".equals(k.stelle());
            reihenfolge |= k.rang() < rang;
            rang = Math.max(rang, k.rang());
        }
        List<String> v = new ArrayList<>();
        if (unbekannt) {
            v.add(KENNZEICHEN_UNBEKANNT);
        }
        if (stelle) {
            v.add(KENNZEICHEN_STELLE);
        }
        if (doppelt) {
            v.add(KENNZEICHEN_DOPPELT);
        }
        if (reihenfolge) {
            v.add(KENNZEICHEN_REIHENFOLGE);
        }
        return v;
    }

    /** Jeder Satz einmal, nach Rang geordnet; gleicher Rang bleibt in der Folge der Entstehung. */
    static List<String> ordne(List<String> saetze) {
        List<String> einmal = new ArrayList<>(new LinkedHashSet<>(saetze));
        einmal.sort(Comparator.comparingInt(s -> {
            Kennzeichen k = erkenne(s);
            if (k == null) {
                throw new IllegalStateException("kein Kennzeichen einer Kennzahl: " + s);
            }
            return k.rang();
        }));
        return List.copyOf(einmal);
    }

    /** Die Sätze eines Eingangs, die nach Q8 an die Kennzahl erben — in ihrer Folge. */
    static List<String> erbe(String art, String geltung, List<String> kennzeichen) {
        List<String> raus = new ArrayList<>();
        for (String satz : kennzeichen) {
            for (Erbregel r : ERBEND) {
                if (r.von().contains(art) && ERB_MUSTER.get(r.muster()).matcher(satz).matches()) {
                    String als = r.als().replace("{0}", satz);
                    raus.add(als.replace("{geltung} ", geltung == null ? "" : geltung + " "));
                    break;
                }
            }
        }
        return raus;
    }

    // ============================================================== Wert (Q1–Q9, V3, E5)

    public record Periode(String art, String schluessel) {}

    /**
     * Ein Eingang mit dem Wert, den er in der Periode trägt. {@code wertart} und {@code status} gelten nur für eine
     * Bezugsgröße (Q1: der Zustand eines Periodenwerts oder Stammdatums wird ABGELEITET, nicht übergeben);
     * {@code ursache} ist der Kundentext, warum der Eingang unvollständig ist; {@code geltung} das Geltungsobjekt eines
     * Kennzahl-Eingangs.
     */
    public record Eingang(String art, String objekt, String name, String geltung, String wertart, String status,
            BigDecimal wert, String einheit, String zustand, BigDecimal abdeckungProzent, boolean endgueltig,
            String ursache, List<String> kennzeichen) {}

    /** Zeitgewichtete Kanalabdeckung mehrerer Bezugsperioden, einschließlich unterschiedlich langer DST-Tage. */
    static BigDecimal zeitAbdeckung(BigDecimal prozentSekunden, BigDecimal sekunden) {
        return sekunden.signum()==0 ? null : prozentSekunden.divide(sekunden,1,java.math.RoundingMode.HALF_UP);
    }

    /** Ein Paar einer Zusammenfassung (eine Kennzahl oder eine Teilperiode) mit Zähler und Nenner. */
    public record Teil(String objekt, String geltung, BigDecimal zaehler, BigDecimal nenner, String zustand,
            String richtung, BigDecimal abdeckungProzent, boolean endgueltig, List<String> kennzeichen) {}

    public record Bisher(int version, boolean endgueltig) {}

    /** Warum neu gebildet wird: {@code eingang} (Korrektur, Berichtigung) oder {@code definition} (Fassung). */
    public record Anlass(String art, Integer fassung) {}

    public record Antrag(String rechenform, Periode periode, String einheit, Eingang zaehler, Eingang nenner,
            boolean komplement, boolean mengenNichtNegativ, List<Teil> teile, String teileArt, String teileWort,
            String teilePeriodeArt, String teileRechenform, LocalDate bestehenAb, List<String> hinweise, Bisher bisher,
            Anlass anlass) {}

    public record Ergebnis(BigDecimal wert, BigDecimal zaehler, BigDecimal nenner, String zustand, String richtung,
            String grund, BigDecimal abdeckungProzent, String fassung, Integer version, List<String> kennzeichen,
            String anzeige, String kundensatz) {}

    /** Der Wert einer Kennzahl in einer Periode — Rechenform, Qualität, Kennzeichen, Version, Anzeige. */
    public static Ergebnis wert(Antrag a) {
        return switch (a.rechenform()) {
            case QUOTIENT, ANTEIL -> teile(a);
            case ZUSAMMENFASSUNG -> summeDurchSumme(a);
            default -> throw new IllegalArgumentException("Rechenform " + a.rechenform());
        };
    }

    /** Ein Eingang nach Q1: Zahl (normiert), Zustand, Abdeckung, ob zurückgenommen. */
    private record Seite(BigDecimal wert, String zustand, BigDecimal abdeckung, boolean endgueltig,
            boolean zurueckgenommen) {}

    private static final BigDecimal HUNDERT = new BigDecimal("100");

    private static Seite seite(Eingang e) {
        if (BEZUGSGROESSE.equals(e.art()) && (PERIODENWERT.equals(e.wertart()) || STAMMDATUM.equals(e.wertart()))) {
            boolean da = PERIODENWERT.equals(e.wertart()) ? WIRKSAM.equals(e.status()) && e.wert() != null : e.wert() != null;
            return new Seite(da ? e.wert() : null, da ? (e.kennzeichen().stream().anyMatch(k -> k.startsWith("aus Leistung über "))
                    && ErgebnisZustand.UNVOLLSTAENDIG.equals(e.zustand()) ? ErgebnisZustand.UNVOLLSTAENDIG : ErgebnisZustand.VOLLSTAENDIG) : ErgebnisZustand.KEINE_WERTE,
                    da ? (e.abdeckungProzent() == null ? HUNDERT : e.abdeckungProzent()) : BigDecimal.ZERO,
                    e.endgueltig(), ZURUECKGENOMMEN.equals(e.status()));
        }
        boolean keine = ErgebnisZustand.KEINE_WERTE.equals(e.zustand()) || e.wert() == null;
        BigDecimal wert = keine ? null : normiert(e);
        BigDecimal abdeckung = e.abdeckungProzent() != null ? e.abdeckungProzent() : keine ? BigDecimal.ZERO : HUNDERT;
        return new Seite(wert, keine ? ErgebnisZustand.KEINE_WERTE : e.zustand(), abdeckung, e.endgueltig(), false);
    }

    /** B3/U2: eine Messstelle auf ihre Anzeige-Einheit (Wh → kWh); eine Bezugsgröße wird nie umgerechnet. */
    private static BigDecimal normiert(Eingang e) {
        ErgebnisZustand.AnzeigeEinheit ae = MESSSTELLE.equals(e.art()) ? ErgebnisZustand.anzeigeEinheit(e.einheit()) : null;
        if (ae == null) {
            return e.wert();
        }
        BigDecimal mal = e.wert().multiply(ae.faktor());
        return ae.teiler().compareTo(BigDecimal.ONE) == 0 ? mal
                : mal.divide(ae.teiler(), WERT_NACHKOMMASTELLEN, RoundingMode.HALF_UP);
    }

    private static String schlechter(String a, String b) {
        return ZUSTAND_RANG.indexOf(a) >= ZUSTAND_RANG.indexOf(b) ? a : b;
    }

    private static Ergebnis teile(Antrag a) {
        Seite z = seite(a.zaehler());
        Seite n = seite(a.nenner());
        boolean anteil = ANTEIL.equals(a.rechenform());
        String grund = n.wert() == null ? NENNER_FEHLT : n.wert().signum() == 0 ? NENNER_NULL
                : z.wert() == null ? ZAEHLER_FEHLT : null;
        BigDecimal abdeckung = z.abdeckung().min(n.abdeckung());
        Integer version = version(a.bisher(), grund == null);
        String fassung = version == null ? null : z.endgueltig() && n.endgueltig() ? ENDGUELTIG : VORLAEUFIG;
        List<String> kennzeichen = new ArrayList<>();
        if (grund != null) {
            String periode = periodeText(a.periode().art(), a.periode().schluessel());
            if (NENNER_NULL.equals(grund)) {
                kennzeichen.add("Nenner 0 (" + a.nenner().objekt() + " " + periode + ": 0" + NBSP + a.nenner().einheit() + ")");
            }
            if (n.zurueckgenommen()) {
                kennzeichen.add("Nenner zurückgenommen (" + a.nenner().objekt() + " " + periode + ")");
            }
            versionSatz(a).ifPresent(kennzeichen::add);
            return new Ergebnis(null, z.wert(), n.wert(), ErgebnisZustand.KEINE_WERTE, null, grund, abdeckung, fassung,
                    version, ordne(kennzeichen), OHNE_ZAHL, kundensatzOhneZahl(a, grund, periode));
        }
        BigDecimal wert = z.wert().multiply(anteil ? ANTEIL_FAKTOR : BigDecimal.ONE)
                .divide(n.wert(), WERT_NACHKOMMASTELLEN, RoundingMode.HALF_UP);
        if (anteil && a.komplement()) {
            wert = ANTEIL_FAKTOR.subtract(wert);
        }
        String zustand = schlechter(z.zustand(), n.zustand());
        String richtung = null;
        if (ErgebnisZustand.UNVOLLSTAENDIG.equals(zustand)) {
            boolean zu = ErgebnisZustand.UNVOLLSTAENDIG.equals(z.zustand());
            boolean nu = ErgebnisZustand.UNVOLLSTAENDIG.equals(n.zustand());
            richtung = zu && nu ? UNBESTIMMT : zu ? UNTERGRENZE : OBERGRENZE;
        }
        kennzeichen.add(BERECHNET_KENNZAHL);
        kennzeichen.addAll(erbe(a.zaehler().art(), a.zaehler().geltung(), a.zaehler().kennzeichen()));
        kennzeichen.addAll(erbe(a.nenner().art(), a.nenner().geltung(), a.nenner().kennzeichen()));
        if (UNTERGRENZE.equals(richtung)) {
            kennzeichen.add("Untergrenze — Menge unvollständig (" + ursache(a.zaehler()) + ")");
        } else if (OBERGRENZE.equals(richtung)) {
            kennzeichen.add("Obergrenze — Bezugsgröße unvollständig (" + ursache(a.nenner()) + ")");
        } else if (UNBESTIMMT.equals(richtung)) {
            kennzeichen.add(RICHTUNG_UNBESTIMMT);
        }
        plausibel(wert, anteil, a.mengenNichtNegativ()).ifPresent(kennzeichen::add);
        kennzeichen.addAll(a.hinweise());
        versionSatz(a).ifPresent(kennzeichen::add);
        return new Ergebnis(wert, z.wert(), n.wert(), zustand, richtung, null, abdeckung, fassung, version,
                ordne(kennzeichen), anzeige(wert, anteil ? ErgebnisZustand.PROZENT : a.einheit(), richtung), null);
    }

    /**
     * Q5 — Summe durch Summe über die Paare (Ebene) oder die Teilperioden (Zeit), bei denen Zähler UND Nenner eine Zahl
     * tragen. Ein Paar mit 0 im Nenner zählt mit (K9). Fehlt ein Teil, ist das Ergebnis unvollständig mit unbestimmter
     * Richtung und „x von y … (… fehlt)“.
     */
    private static Ergebnis summeDurchSumme(Antrag a) {
        boolean zeit = "zeit".equals(a.teileArt());
        List<Teil> mit = a.teile().stream().filter(t -> t.zaehler() != null && t.nenner() != null).toList();
        List<Teil> ohne = a.teile().stream().filter(t -> t.zaehler() == null || t.nenner() == null).toList();
        boolean anteil = ANTEIL.equals(a.teileRechenform());
        BigDecimal summeZ = mit.stream().map(Teil::zaehler).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal summeN = mit.stream().map(Teil::nenner).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal abdeckung = mit.stream().map(t -> t.abdeckungProzent() == null ? HUNDERT : t.abdeckungProzent())
                .reduce(BigDecimal::min).orElse(BigDecimal.ZERO);
        String grund = mit.isEmpty()
                ? (ohne.stream().anyMatch(t -> t.nenner() == null) ? NENNER_FEHLT : ZAEHLER_FEHLT)
                : summeN.signum() == 0 ? NENNER_NULL : null;
        Integer version = version(a.bisher(), grund == null);
        boolean alleEndgueltig = a.teile().stream().allMatch(Teil::endgueltig);
        String fassung = version == null ? null : alleEndgueltig ? ENDGUELTIG : VORLAEUFIG;
        if (grund != null) {
            List<String> kennzeichen = new ArrayList<>();
            versionSatz(a).ifPresent(kennzeichen::add);
            return new Ergebnis(null, mit.isEmpty() ? null : summeZ, mit.isEmpty() ? null : summeN,
                    ErgebnisZustand.KEINE_WERTE, null, grund, abdeckung, fassung, version, ordne(kennzeichen), OHNE_ZAHL,
                    null);
        }
        BigDecimal wert = summeZ.multiply(anteil ? ANTEIL_FAKTOR : BigDecimal.ONE)
                .divide(summeN, WERT_NACHKOMMASTELLEN, RoundingMode.HALF_UP);
        String zustand = mit.stream().map(Teil::zustand).reduce(ErgebnisZustand.VOLLSTAENDIG, KennzahlRegeln::schlechter);
        if (!ohne.isEmpty()) {
            zustand = schlechter(zustand, ErgebnisZustand.UNVOLLSTAENDIG);
        }
        String richtung = null;
        List<String> kennzeichen = new ArrayList<>(List.of(BERECHNET_KENNZAHL, GEWICHTET));
        if (ErgebnisZustand.UNVOLLSTAENDIG.equals(zustand)) {
            Set<String> richtungen = new LinkedHashSet<>();
            List<String> unvollstaendige = new ArrayList<>();
            for (Teil t : mit) {
                if (ErgebnisZustand.UNVOLLSTAENDIG.equals(t.zustand())) {
                    richtungen.add(t.richtung() == null ? UNBESTIMMT : t.richtung());
                    unvollstaendige.add(t.objekt());
                }
            }
            richtung = !ohne.isEmpty() || richtungen.size() != 1 ? UNBESTIMMT : richtungen.iterator().next();
            String welche = String.join(", ", unvollstaendige);
            kennzeichen.add(UNTERGRENZE.equals(richtung) ? "Untergrenze — Menge unvollständig (" + welche + ")"
                    : OBERGRENZE.equals(richtung) ? "Obergrenze — Bezugsgröße unvollständig (" + welche + ")"
                    : RICHTUNG_UNBESTIMMT);
        }
        List<String> fehlend = ohne.stream()
                .map(t -> zeit ? periodeText(a.teilePeriodeArt(), t.objekt()) : t.objekt()).toList();
        String xVonY = mit.size() + " von " + a.teile().size() + " " + a.teileWort();
        if (!ohne.isEmpty()) {
            kennzeichen.add(xVonY + " (" + String.join(", ", fehlend) + (ohne.size() == 1 ? " fehlt" : " fehlen") + ")");
        } else if (!zeit) {
            kennzeichen.add(xVonY);
        }
        if (zeit) {
            kennzeichen.addAll(erbeZeit(a));
        } else {
            for (Teil t : mit) {
                kennzeichen.addAll(erbe(KENNZAHL, t.geltung(), t.kennzeichen()));
            }
        }
        plausibel(wert, anteil, a.mengenNichtNegativ()).ifPresent(kennzeichen::add);
        kennzeichen.addAll(a.hinweise());
        versionSatz(a).ifPresent(kennzeichen::add);
        return new Ergebnis(wert, summeZ, summeN, zustand, richtung, null, abdeckung, fassung, version,
                ordne(kennzeichen), anzeige(wert, anteil ? ErgebnisZustand.PROZENT : a.einheit(), richtung), null);
    }

    /** Was eine Teilperiode an die gröbere Periode vererbt (übernommen, nicht neu gerechnet). */
    private static final Set<String> ZEIT_VEREINIGT = Set.of("enthaelt_berechnet", "enthaelt_verteilt", "betriebszeit_annahme",
            "mit_ersatzwert", "stammdatum_geaendert", "berechnung_geaendert_am", "eingang_ausserhalb",
            "bezugsgroesse_archiviert", "eingang_archiviert");

    /**
     * Zeit: das eigene „ab …“ ersetzt jedes „ab …“ der Teile; „x von y …“ bleibt nur, wenn es in JEDER Teilperiode
     * gleich lautet; die übrigen Sätze über die Periode werden übernommen.
     */
    private static List<String> erbeZeit(Antrag a) {
        List<String> raus = new ArrayList<>();
        LocalDate erster = BezugsPeriode.spanneVon(a.periode().schluessel(), a.periode().art())[0];
        if (a.bestehenAb() != null && a.bestehenAb().isAfter(erster)) {
            raus.add("ab " + OrtsbaumAbleitung.datumText(a.bestehenAb()));
        }
        for (Teil t : a.teile()) {
            for (String satz : t.kennzeichen()) {
                Kennzeichen k = erkenne(satz);
                if (k == null) {
                    continue;
                }
                if (ZEIT_VEREINIGT.contains(k.schluessel())) {
                    raus.add(satz);
                } else if ("x_von_y".equals(k.schluessel())
                        && a.teile().stream().allMatch(u -> u.kennzeichen().contains(satz))) {
                    raus.add(satz);
                }
            }
        }
        return raus;
    }

    private static String ursache(Eingang e) {
        return e.ursache() != null ? e.ursache() : e.objekt();
    }

    /** Q9: unplausibel ist ein Kennzeichen, kein Zustand — und nie ein geklemmter Wert. */
    private static Optional<String> plausibel(BigDecimal wert, boolean anteil, boolean mengenNichtNegativ) {
        if (anteil && wert.compareTo(ANTEIL_FAKTOR) > 0) {
            return Optional.of(UNPLAUSIBEL_UEBER_100);
        }
        if ((anteil || mengenNichtNegativ) && wert.signum() < 0) {
            return Optional.of(UNPLAUSIBEL_NEGATIV);
        }
        return Optional.empty();
    }

    /**
     * Ob ein Satz nur die Version einer Neubildung nennt („korrigiert (Version n)“, „Berechnung geändert (Fassung n)“) —
     * die Kaskade (IP-8) vergleicht eine Neubildung ohne ihn: dieselbe Aussage mit neuer Nummer ist keine neue Version.
     */
    static boolean versionSatz(String satz) {
        return MUSTER.get("korrigiert").matcher(satz).matches()
                || MUSTER.get("berechnung_geaendert").matcher(satz).matches();
    }

    /**
     * Q7/V3: ohne früheren Wert Version 1 (ohne Zahl: noch keine); ein vorläufiger zieht ohne neue Version nach, ein
     * endgültiger wird Version n + 1.
     */
    private static Integer version(Bisher bisher, boolean mitZahl) {
        if (bisher == null) {
            return mitZahl ? 1 : null;
        }
        return bisher.endgueltig() ? bisher.version() + 1 : bisher.version();
    }

    private static Optional<String> versionSatz(Antrag a) {
        if (a.bisher() == null || !a.bisher().endgueltig()) {
            return Optional.empty();
        }
        if (a.anlass() == null) {
            throw new IllegalArgumentException("Ein endgültiger Wert wird nur mit Anlass neu gebildet");
        }
        return Optional.of("definition".equals(a.anlass().art())
                ? "Berechnung geändert (Fassung " + a.anlass().fassung() + ")"
                : "korrigiert (Version " + (a.bisher().version() + 1) + ")");
    }

    private static String kundensatzOhneZahl(Antrag a, String grund, String periode) {
        return switch (grund) {
            case NENNER_FEHLT -> fuelle(SAETZE.get(BEZUGSGROESSE.equals(a.nenner().art()) ? "nenner_fehlt"
                    : "nenner_fehlt_messstelle"), Map.of("periode", periode, "objekt", mitName(a.nenner())));
            case NENNER_NULL -> fuelle(SAETZE.get("nenner_null"),
                    Map.of("einheit", a.nenner().einheit(), "einheit_je", einzahl(a.nenner().einheit())));
            default -> fuelle(SAETZE.get("zaehler_fehlt"), Map.of("periode", periode, "objekt", mitName(a.zaehler())));
        };
    }

    private static String mitName(Eingang e) {
        return e.name() == null ? e.objekt() : e.objekt() + " " + e.name();
    }

    /** U4: „0,15 kWh je Stück“, „mindestens 30,83 kWh je Person“, „51 %“; ohne Zahl „—“. */
    public static String anzeige(BigDecimal wert, String einheit, String richtung) {
        if (wert == null) {
            return OHNE_ZAHL;
        }
        String zahl = ErgebnisZustand.PROZENT.equals(einheit)
                ? ErgebnisZustand.zahl(wert, ErgebnisZustand.PROZENT, null)
                : ErgebnisZustand.zahlMitStellen(wert, ANZEIGE_NACHKOMMASTELLEN, einheitWort(einheit));
        return UNTERGRENZE.equals(richtung) ? fuelle(SAETZE.get("anzeige_untergrenze"), Map.of("zahl", zahl))
                : OBERGRENZE.equals(richtung) ? fuelle(SAETZE.get("anzeige_obergrenze"), Map.of("zahl", zahl)) : zahl;
    }

    /** „kWh/Stück“ → „kWh je Stück“. */
    public static String einheitWort(String einheit) {
        return einheit.replace(EINHEIT_TRENNER, JE);
    }

    static String einzahl(String einheit) {
        return EINZAHL.getOrDefault(einheit, einheit);
    }

    /** „November 2026“ · „02.12.2026“ · „KW 40/2026“ · „2026“. */
    public static String periodeText(String art, String schluessel) {
        return switch (art) {
            case "monat" -> MONATSNAMEN.get(Integer.parseInt(schluessel.substring(5, 7)) - 1) + " " + schluessel.substring(0, 4);
            case "jahr" -> schluessel;
            case "woche" -> "KW " + Integer.parseInt(schluessel.substring(6)) + "/" + schluessel.substring(0, 4);
            default -> OrtsbaumAbleitung.datumText(LocalDate.parse(schluessel));
        };
    }

    // ============================================================== Einheit (U1–U3)

    public record EinheitSeite(String art, String objekt, String einheit, String groesse, String wertart) {}

    public record Paar(String objekt, String rechenform, String einheit) {}

    public record EinheitUrteil(String einheit, String anzeige, String fehler, String kundensatz) {}

    private static EinheitUrteil einheitFehler(String fehler, String satz, Map<String, String> werte) {
        return new EinheitUrteil(null, null, fehler, fuelle(SAETZE.get(satz), werte));
    }

    /** U1–U3: die Ergebnis-Einheit als ungekürztes Paar, % oder die Einheit der Paare — nie geraten. */
    public static EinheitUrteil einheit(String rechenform, EinheitSeite zaehler, EinheitSeite nenner, List<Paar> paare) {
        if (ZUSAMMENFASSUNG.equals(rechenform)) {
            if (paare == null || paare.size() < 2) {
                return einheitFehler(ANFRAGE_UNGUELTIG, "zusammenfassung_zu_klein", Map.of());
            }
            Paar erste = paare.get(0);
            for (Paar p : paare) {
                if (!p.rechenform().equals(erste.rechenform()) || !p.einheit().equals(erste.einheit())) {
                    return einheitFehler(EINHEIT_UNPASSEND, "einheit_paare", Map.of("erste", erste.objekt(),
                            "erste_einheit", erste.einheit(), "andere", p.objekt(), "andere_einheit", p.einheit()));
                }
            }
            return new EinheitUrteil(erste.einheit(), einheitWort(erste.einheit()), null, null);
        }
        for (EinheitSeite s : List.of(zaehler, nenner)) {
            EinheitUrteil f = seitenFehler(s);
            if (f != null) {
                return f;
            }
        }
        if (ANTEIL.equals(rechenform)) {
            boolean gleich = MESSSTELLE.equals(zaehler.art()) && MESSSTELLE.equals(nenner.art())
                    && Objects.equals(zaehler.groesse(), nenner.groesse())
                    && seitenEinheit(zaehler).equals(seitenEinheit(nenner));
            return gleich ? new EinheitUrteil(ErgebnisZustand.PROZENT, ErgebnisZustand.PROZENT, null, null)
                    : einheitFehler(EINHEIT_UNPASSEND, "einheit_anteil", Map.of("zaehler", zaehler.objekt(),
                            "zaehler_einheit", zaehler.einheit(), "nenner", nenner.objekt(), "nenner_einheit", nenner.einheit()));
        }
        String paar = seitenEinheit(zaehler) + EINHEIT_TRENNER + seitenEinheit(nenner);
        return new EinheitUrteil(paar, einheitWort(paar), null, null);
    }

    private static EinheitUrteil seitenFehler(EinheitSeite s) {
        Map<String, String> werte = Map.of("objekt", s.objekt(), "einheit", s.einheit());
        return switch (s.art()) {
            case MESSSTELLE -> MOMENTANWERT.equals(s.wertart())
                    ? einheitFehler(EINHEIT_UNPASSEND, "einheit_momentanwert", werte)
                    : s.groesse() == null || ErgebnisZustand.anzeigeEinheit(s.einheit()) == null
                            ? einheitFehler(GROESSE_UNBEKANNT, "groesse_unbekannt", Map.of())
                            : null;
            case BEZUGSGROESSE -> STAND.equals(s.wertart()) ? einheitFehler(EINHEIT_UNPASSEND, "einheit_stand", werte) : null;
            default -> s.einheit().contains(EINHEIT_TRENNER)
                    ? einheitFehler(EINHEIT_UNPASSEND, "einheit_verhaeltnis", werte) : null;
        };
    }

    private static String seitenEinheit(EinheitSeite s) {
        return switch (s.art()) {
            case MESSSTELLE -> ErgebnisZustand.anzeigeEinheit(s.einheit()).angezeigt();
            case BEZUGSGROESSE -> einzahl(s.einheit());
            default -> s.einheit();
        };
    }

    // ============================================================== Perioden (P1–P6)

    public record PeriodenEingang(String art, String objekt, String name, String wertart, String periodeArt) {}

    public record PeriodenUrteil(String grundperiode, List<String> perioden, String fehler, String kundensatz) {}

    /** P1–P3: Grundperiode = die gröbste Periode, in der alle Periodenwert-Eingänge aufgehen; nie verteilt. */
    public static PeriodenUrteil periode(String gewuenscht, List<PeriodenEingang> eingaenge) {
        List<PeriodenEingang> mitPeriode = eingaenge.stream()
                .filter(e -> e.periodeArt() != null && !STAMMDATUM.equals(e.wertart())).toList();
        if (mitPeriode.isEmpty()) {
            return new PeriodenUrteil(null, List.of(), ANFRAGE_UNGUELTIG, SAETZE.get("nur_stammdaten"));
        }
        String grund = PERIODEN.stream()
                .filter(p -> mitPeriode.stream().anyMatch(e -> e.periodeArt().equals(p)))
                .filter(p -> mitPeriode.stream().allMatch(e -> AUFGEHEN.get(e.periodeArt()).contains(p)))
                .findFirst().orElse(null);
        if (grund == null) {
            String grobste = mitPeriode.stream().map(PeriodenEingang::periodeArt)
                    .max(Comparator.comparingInt(PERIODEN::indexOf)).orElseThrow();
            return new PeriodenUrteil(null, List.of(), PERIODE_PASST_NICHT, periodenSatz(mitPeriode, grobste));
        }
        List<String> perioden = AUFGEHEN.get(grund);
        if (gewuenscht != null && !perioden.contains(gewuenscht)) {
            return new PeriodenUrteil(grund, perioden, PERIODE_PASST_NICHT, periodenSatz(mitPeriode, gewuenscht));
        }
        return new PeriodenUrteil(grund, perioden, null, null);
    }

    private static String periodenSatz(List<PeriodenEingang> eingaenge, String ziel) {
        PeriodenEingang q = eingaenge.stream().filter(e -> !AUFGEHEN.get(e.periodeArt()).contains(ziel)).findFirst()
                .orElseThrow();
        PeriodenWoerter qw = PERIODEN_WOERTER.get(q.periodeArt());
        PeriodenWoerter gw = PERIODEN_WOERTER.get(ziel);
        String objekt = q.name() == null ? q.objekt() : q.objekt() + " " + q.name();
        return PERIODEN.indexOf(q.periodeArt()) > PERIODEN.indexOf(ziel)
                ? fuelle(SAETZE.get("periode_zu_grob"), Map.of("objekt", objekt, "q_werte", qw.werte(), "g_je", gw.je(),
                        "q_wert", qw.wert(), "g_teile", gw.teile()))
                : fuelle(SAETZE.get("periode_geht_nicht_auf"), Map.of("objekt", objekt, "q_werte", qw.werte(),
                        "g_je", gw.je(), "g_werte_dativ", gw.werteDativ()));
    }

    public record BestehenUrteil(String grund, List<String> kennzeichen) {}

    /** P4: vor dem Bestehen eines Eingangs ist kein Fehlbestand — „ab TT.MM.JJJJ“, ganz davor keine Zeile. */
    public static BestehenUrteil bestehen(Periode p, LocalDate seit) {
        LocalDate[] spanne = BezugsPeriode.spanneVon(p.schluessel(), p.art());
        if (seit.isAfter(spanne[1])) {
            return new BestehenUrteil(VOR_BESTEHEN, List.of());
        }
        return new BestehenUrteil(null, seit.isAfter(spanne[0]) ? List.of("ab " + OrtsbaumAbleitung.datumText(seit)) : List.of());
    }

    public record LaufendUrteil(boolean laeuft, String grund, String fassung, String kundensatz) {}

    /** P6: die laufende Periode hat keinen Live-Wert; ein Periodenwert-Nenner gibt es erst nach ihrem Ende. */
    public static LaufendUrteil laufend(Periode p, OffsetDateTime jetzt, ZoneId zone, String nennerArt, String nennerWertart) {
        LocalDate[] spanne = BezugsPeriode.spanneVon(p.schluessel(), p.art());
        boolean laeuft = jetzt.toInstant().isBefore(spanne[1].plusDays(1).atStartOfDay(zone).toInstant());
        if (!laeuft) {
            return new LaufendUrteil(false, null, null, null);
        }
        if (BEZUGSGROESSE.equals(nennerArt) && PERIODENWERT.equals(nennerWertart)) {
            return new LaufendUrteil(true, PERIODE_NICHT_ZU_ENDE, null, fuelle(SAETZE.get("periode_nicht_zu_ende"),
                    Map.of("periode", periodeText(p.art(), p.schluessel()), "ende", PERIODEN_WOERTER.get(p.art()).ende())));
        }
        return new LaufendUrteil(true, null, VORLAEUFIG, null);
    }

    public record StichtagUrteil(LocalDate stichtag, BigDecimal wert) {}

    /** E17: ein Stammdatum gilt am LETZTEN Tag der Periode — gelesen von {@link BezugsdatenRegeln#wertAm}. */
    public static StichtagUrteil stichtag(Periode p, List<BezugsdatenRegeln.Intervall> intervalle) {
        LocalDate letzter = BezugsPeriode.spanneVon(p.schluessel(), p.art())[1];
        return new StichtagUrteil(letzter, BezugsdatenRegeln.wertAm(intervalle, letzter));
    }

    // ============================================================== Definition (Q10, V1, V2)

    public record KreisUrteil(boolean zyklus, List<String> kette, String fehler, String kundensatz) {}

    /** Q10: der Kreis über Kennzahl-Verweise — {@link MessstelleFormelRegeln#zyklus}, aufgerufen, nicht kopiert. */
    public static KreisUrteil zyklus(String kennzeichen, List<String> verweise, Map<String, List<String>> bestehende) {
        MessstelleFormelRegeln.ZyklusUrteil u = MessstelleFormelRegeln.zyklus(kennzeichen, verweise, bestehende);
        return u.zyklus()
                ? new KreisUrteil(true, u.kette(), FORMEL_ZYKLUS,
                        fuelle(SAETZE.get("formel_zyklus"), Map.of("kette", String.join(" → ", u.kette()))))
                : new KreisUrteil(false, List.of(), null, null);
    }

    public record FassungsUrteil(String fehler, String kundensatz, Integer nummer, Integer beenden, LocalDate beendenAm,
            boolean rueckwirkend, long tage, String abzeichen) {}

    /** V1: eine Fassung der Berechnung ab einem Tag — {@link MessstelleFormelRegeln#fassungEintrag}. */
    public static FassungsUrteil fassung(List<MessstelleFormelRegeln.Fassung> wirksam, LocalDate ab,
            OffsetDateTime eingetragenUm, ZoneId zone) {
        MessstelleFormelRegeln.FassungUrteil u = MessstelleFormelRegeln.fassungEintrag(wirksam, ab, eingetragenUm, zone);
        if (u.fehler() != null) {
            return new FassungsUrteil(FASSUNG_UEBERLAPPT, u.satz(), null, null, null, false, 0, null);
        }
        return new FassungsUrteil(null, null, u.nummer(), u.beenden() == null ? null : u.beenden().nummer(),
                u.beendenAm(), u.rueckwirkend(), u.tage(), u.rueckwirkend() ? u.abzeichen() : null);
    }

    public record FassungAmUrteil(Integer nummer, List<String> kennzeichen) {}

    /** V2: die Fassung des LETZTEN Tags; beginnt eine Fassung in der Periode, nennt sie den Übergang. */
    public static FassungAmUrteil fassungAm(List<MessstelleFormelRegeln.Fassung> wirksam, Periode p) {
        LocalDate[] spanne = BezugsPeriode.spanneVon(p.schluessel(), p.art());
        Integer nummer = MessstelleFormelRegeln.fassungAm(wirksam, spanne[1]).map(MessstelleFormelRegeln.Fassung::nummer)
                .orElse(null);
        List<String> kennzeichen = new ArrayList<>();
        for (MessstelleFormelRegeln.Fassung f : wirksam) {
            if (f.ab() != null && f.ab().isAfter(spanne[0]) && !f.ab().isAfter(spanne[1])) {
                kennzeichen.add("Berechnung geändert am " + OrtsbaumAbleitung.datumText(f.ab()) + " (Fassung "
                        + (f.nummer() - 1) + " → " + f.nummer() + ")");
            }
        }
        return new FassungAmUrteil(nummer, List.copyOf(kennzeichen));
    }

    public record RechenformUrteil(String fehler, String kundensatz) {}

    /** E2: der geschlossene Satz der Rechenformen; {@code produkt} ist vorgesehen, nicht gebaut. */
    public static RechenformUrteil rechenform(String rechenform) {
        return RECHENFORMEN.contains(rechenform) ? new RechenformUrteil(null, null)
                : new RechenformUrteil(RECHENFORM_UNBEKANNT, SAETZE.get("rechenform_unbekannt"));
    }

    // ============================================================== Geltung und Rechte (G1, G3, R3)

    public record GeltungUrteil(String rechteGeltung, String standort, String kennung, String fehler, String kundensatz) {}

    /** G1: der Rechte-Geltungsbereich und die Kennung zum Definieren; ein Standort-Objekt ohne Standort gibt es nicht. */
    public static GeltungUrteil geltung(String geltungArt, String standort) {
        String rechte = RECHTE_GELTUNG.get(geltungArt);
        if (rechte == null) {
            throw new IllegalArgumentException("Geltungsbereich " + geltungArt);
        }
        if (STANDORT.equals(rechte) && standort == null) {
            return new GeltungUrteil(rechte, null, KENNUNG.get(rechte), GELTUNG_UNBEKANNT,
                    SAETZE.get("geltung_unbekannt_" + geltungArt));
        }
        return new GeltungUrteil(rechte, UNTERNEHMEN.equals(rechte) ? null : standort, KENNUNG.get(rechte), null, null);
    }

    public record KennzahlOrt(String rechteGeltung, String standort, String standortName, String geltungName) {}

    public record EingangOrt(String objekt, String standort, String standortName, boolean imGeltungsobjekt, LocalDate seit) {}

    public record GeltungHinweis(String fehler, String kundensatz, List<String> kennzeichen) {}

    /** G3: außerhalb des STANDORTS abgelehnt, außerhalb des Geltungsobjekts ein Kennzeichen je Periode. */
    public static GeltungHinweis eingangGeltung(KennzahlOrt k, EingangOrt e) {
        if (STANDORT.equals(k.rechteGeltung()) && e.standort() != null && !e.standort().equals(k.standort())) {
            return new GeltungHinweis(EINGANG_AUSSERHALB_GELTUNG, fuelle(SAETZE.get("eingang_ausserhalb_geltung"),
                    Map.of("objekt", e.objekt(), "eingang_standort", e.standortName(), "kennzahl_standort", k.standortName())),
                    List.of());
        }
        if (e.imGeltungsobjekt()) {
            return new GeltungHinweis(null, null, List.of());
        }
        if (e.seit() == null) {
            throw new IllegalArgumentException("Ein Eingang außerhalb des Geltungsobjekts nennt, seit wann");
        }
        return new GeltungHinweis(null, null, List.of("Eingang " + e.objekt() + " seit "
                + OrtsbaumAbleitung.datumText(e.seit()) + " außerhalb von " + k.geltungName()));
    }

    /**
     * R3 = R-A1 ∧ R-A6: mit Wert nur, wenn der Rechte-Geltungsbereich UND jeder Standort jedes Eingangs im Zugriff
     * liegen — keine Teilrechnung. R-A7: umfasst die Kennzahl Standorte innerhalb UND außerhalb des Zugriffs, sieht ein
     * Benutzer des Kundenbereichs die Zeile ohne Wert. Die Wahrheitswerte liefert {@link RechteAbleitung#darf}.
     */
    public static String sichtbarkeit(boolean rechteGeltungImZugriff, List<Boolean> eingangsStandorteImZugriff,
            boolean dritter) {
        if (rechteGeltungImZugriff && eingangsStandorteImZugriff.stream().allMatch(Boolean::booleanValue)) {
            return MIT_WERT;
        }
        boolean innen = eingangsStandorteImZugriff.stream().anyMatch(Boolean::booleanValue);
        boolean aussen = eingangsStandorteImZugriff.stream().anyMatch(b -> !b);
        return !dritter && innen && aussen ? HINWEIS_OHNE_WERT : NICHT_SICHTBAR;
    }

    // ============================================================== Vorlage und Kopie (E9)

    public record Belegung(String rechenform, String name, String zweck) {}

    /** Eine Vorlage belegt vor; „{Geltungsbereich}“ wird der Name des Geltungsobjekts. */
    public static Belegung vorlage(String rechenform, String nameVorschlag, String zweckVorschlag, String geltungName) {
        return new Belegung(rechenform, nameVorschlag.replace("{Geltungsbereich}", geltungName), zweckVorschlag);
    }

    public record Quelle(String kennzeichen, String name, String zweck, String rechenform, String geltungName) {}

    public record Kopie(String rechenform, String name, String zweck, int fassungNummer, LocalDate gueltigAb,
            List<String> eingaenge, String kennzeichen) {}

    /** K20: Form, Name, Zweck übernommen; Eingänge, Geltungsbereich und Kennzeichen neu; Fassung 1 „gilt seit Beginn“. */
    public static Kopie kopie(Quelle q, String neueGeltungName) {
        String endung = " — " + q.geltungName();
        String name = q.name().endsWith(endung)
                ? q.name().substring(0, q.name().length() - endung.length()) + " — " + neueGeltungName
                : q.name();
        return new Kopie(q.rechenform(), name, q.zweck(), 1, null, List.of(), null);
    }

    // ============================================================== Herkunft (kennzahlwert-herkunft.md)

    public record HerkunftEingang(String rolle, String art, String objekt, BigDecimal wert, BigDecimal zaehler,
            BigDecimal nenner, String einheit, String zustand, BigDecimal abdeckungProzent, Integer version, Integer fassung,
            List<String> kennzeichen) {}

    public record HerkunftErgebnis(BigDecimal wert, String einheit, String zustand, String richtung, String grund,
            BigDecimal abdeckungProzent, List<String> kennzeichen) {}

    public record HerkunftAntrag(String kennzahl, String rechenform, Integer definitionFassung, Periode periode,
            String berechnetAm, Integer version, String anlass, List<HerkunftEingang> eingaenge, HerkunftErgebnis ergebnis) {}

    /** Die Hülle: der Satz in der Form des Schemas — oder {@code null} mit jeder fehlenden Angabe. */
    public record Huelle(Map<String, Object> satz, List<String> fehlt) {}

    public static Huelle herkunft(HerkunftAntrag a) {
        List<String> fehlt = new ArrayList<>();
        if (a.kennzahl() == null) {
            fehlt.add("kennzahl");
        }
        if (a.definitionFassung() == null) {
            fehlt.add("definition_fassung");
        }
        if (a.berechnetAm() == null) {
            fehlt.add("berechnet_am");
        }
        if (a.eingaenge() == null || a.eingaenge().isEmpty()) {
            fehlt.add("eingaenge");
        }
        if (a.version() != null && a.version() >= 2 && (a.anlass() == null || a.anlass().isBlank())) {
            fehlt.add("anlass");
        }
        if (!fehlt.isEmpty()) {
            return new Huelle(null, List.copyOf(fehlt));
        }
        Map<String, Object> satz = new LinkedHashMap<>();
        satz.put("art", KENNZAHL);
        satz.put("kennzahl", a.kennzahl());
        satz.put("rechenform", a.rechenform());
        satz.put("definition_fassung", a.definitionFassung());
        satz.put("periode", geordnet("art", a.periode().art(), "schluessel", a.periode().schluessel()));
        satz.put("berechnet_am", a.berechnetAm());
        satz.put("version", a.version());
        satz.put("anlass", a.anlass());
        List<Map<String, Object>> eingaenge = new ArrayList<>();
        for (HerkunftEingang e : a.eingaenge()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("rolle", e.rolle());
            m.put("art", e.art());
            m.put("objekt", e.objekt());
            m.put("wert", text(e.wert()));
            m.put("zaehler", text(e.zaehler()));
            m.put("nenner", text(e.nenner()));
            m.put("einheit", e.einheit());
            m.put("zustand", e.zustand());
            m.put("abdeckung_prozent", text(e.abdeckungProzent()));
            m.put("version", e.version());
            m.put("fassung", e.fassung());
            m.put("kennzeichen", e.kennzeichen());
            eingaenge.add(m);
        }
        satz.put("eingaenge", eingaenge);
        Map<String, Object> ergebnis = new LinkedHashMap<>();
        ergebnis.put("wert", text(a.ergebnis().wert()));
        ergebnis.put("einheit", a.ergebnis().einheit());
        ergebnis.put("zustand", a.ergebnis().zustand());
        ergebnis.put("richtung", a.ergebnis().richtung());
        ergebnis.put("grund", a.ergebnis().grund());
        ergebnis.put("abdeckung_prozent", text(a.ergebnis().abdeckungProzent()));
        ergebnis.put("kennzeichen", a.ergebnis().kennzeichen());
        satz.put("ergebnis", ergebnis);
        return new Huelle(satz, List.of());
    }

    /** Ein Betrag als Dezimaltext ohne nachgestellte Nullen und ohne Exponent; {@code null} bleibt {@code null}. */
    static String text(BigDecimal b) {
        return b == null ? null : b.stripTrailingZeros().toPlainString();
    }

    // ============================================================== Sätze

    /** Ein Kundensatz zu einem Code: {@code eingang_unbekannt} mit Art und Objekt, {@code geltung_unbekannt} je Art. */
    public static String satz(String code, Map<String, String> werte) {
        return switch (code) {
            case EINGANG_UNBEKANNT -> fuelle(SAETZE.get(code),
                    Map.of("art", SAETZE.get("wort_" + werte.get("art")), "objekt", werte.get("objekt")));
            case GELTUNG_UNBEKANNT -> SAETZE.get("geltung_unbekannt_" + werte.get("geltung_art"));
            default -> fuelle(SAETZE.get(code), werte);
        };
    }

    static String fuelle(String vorlage, Map<String, String> werte) {
        String s = vorlage;
        for (Map.Entry<String, String> w : werte.entrySet()) {
            s = s.replace("{" + w.getKey() + "}", w.getValue());
        }
        return s;
    }

    @SuppressWarnings("unchecked")
    private static <V> Map<String, V> geordnet(Object... paare) {
        Map<String, V> m = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            m.put((String) paare[i], (V) paare[i + 1]);
        }
        return java.util.Collections.unmodifiableMap(m);
    }
}
