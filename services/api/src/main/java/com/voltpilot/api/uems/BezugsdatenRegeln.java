package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Die REINEN Regeln der Bezugsdaten (UEMS AP-09 §4): aus einer gelieferten Zeile wird ein Wert
 * einer Bezugsgröße — oder ein Befund.
 *
 * <p>Der Vertrag und die Wahrheit stehen in {@code docs/contracts/v2/bezugsdaten-vectors.json}
 * (Prosa {@code bezugsdaten.md}, Schema {@code bezugsdaten.schema.json}); der TS-Zwilling ist
 * {@code frontend/portal/src/bezugsdaten.ts}. Wer eine Regel ändert, ändert die Vektor-Datei UND
 * beide Zwillinge.
 *
 * <p><b>Rein:</b> ohne Spring, ohne Datenbank, ohne Netz und <b>ohne Uhr</b> — „jetzt“ wird
 * übergeben (Z4). Jede Zahl reist als Dezimaltext und wird als {@link BigDecimal} gerechnet, damit
 * keine Rechnung einen Binärbruch-Fehler erbt.
 *
 * <p><b>Einheiten und Perioden rechnet diese Klasse NICHT.</b> Seit AP-09 IP-3 wohnen sie als
 * eigene, wiederverwendbare Module daneben: {@link BezugsEinheit} (Vokabular je Größe, feste
 * Faktoren, Synonyme) und {@link BezugsPeriode} (Deutung der Datumsspalte, Zeitzone des
 * Standorts, 23-/25-Stunden-Tage, die beiden getrennten Perioden-Befunde). Die Methoden hier
 * sind nur noch der ANRUF — es gibt keine zweite Fassung.
 *
 * <p><b>Die Menge eines Ablesezeitraums rechnet diese Klasse NICHT.</b> Das tut die schon
 * gemergte Verbrauchsregel {@link VerbrauchRegeln#mengeZaehlerstand} (AP-08 IP-1); ebenso kommt
 * die Länge einer Periode in Stunden aus {@link VerbrauchRegeln#stunden}. Zwei Zahlen für dieselbe
 * Aussage wären genau die Drift, die diese Verträge verhindern sollen.
 *
 * <p><b>Wer anruft (Stand AP-09 IP-3): niemand.</b> Dieses Paket legt die Wahrheit fest, gegen die
 * IP-4 … IP-19 gebaut werden. Kein Produktionsweg berührt diese Klasse.
 */
public final class BezugsdatenRegeln {

    private BezugsdatenRegeln() {}

    // ------------------------------------------------------------------ Schwellen (Vertrag)

    /** E7: die Zeitzone des Standorts der Referenzfälle; sie wird je Bezugsgröße übergeben. */
    public static final ZoneId ANZEIGE_ZEITZONE = ZoneId.of("Europe/Berlin");

    /** F2: eine Berichtigung ohne ausreichende Begründung wird nicht wirksam. */
    public static final int BEGRUENDUNG_MIN_ZEICHEN = 10;

    public static final int BEGRUENDUNG_MAX_ZEICHEN = 500;

    /** Z6/E5: bis zu so vielen berührten Kalendermonaten gibt es eine Vorgabe. */
    public static final int ZUORDNUNG_HOECHSTENS_MONATE = 2;

    public static final int ANTEIL_NACHKOMMASTELLEN = 1;

    /** K: die Abdeckung eines Kanal-Werts ist ZEITBASIERT — nicht die wertbasierte aus AP-08 Z9. */
    public static final int ABDECKUNG_NACHKOMMASTELLEN = 1;

    public static final int VERGLEICH_NACHKOMMASTELLEN = 4;

    /** F3/E6: das Vier-Augen-Prinzip folgt AP-08 E8 und ist per Vorgabe AUS. */
    public static final boolean VIER_AUGEN_VORGABE = false;

    public static final String ZAHLFORMAT_VORGABE = "de";

    // --------------------------------------------------------------------------- Vokabulare

    public static final String DATEI_BEKANNT = "datei_bekannt";
    public static final String KONFLIKT_ANDERER_WERT = "konflikt_anderer_wert";
    public static final String EINHEIT_UNBEKANNT = BezugsEinheit.EINHEIT_UNBEKANNT;
    public static final String EINHEIT_UMGERECHNET = BezugsEinheit.EINHEIT_UMGERECHNET;
    public static final String PERIODE_PASST_NICHT = BezugsPeriode.PERIODE_PASST_NICHT;
    public static final String PERIODE_NICHT_ZU_ENDE = BezugsPeriode.PERIODE_NICHT_ZU_ENDE;
    public static final String ZEIT_MEHRDEUTIG = BezugsPeriode.ZEIT_MEHRDEUTIG;
    public static final String ZEIT_NICHT_VORHANDEN = BezugsPeriode.ZEIT_NICHT_VORHANDEN;
    public static final String ZAHL_UNLESBAR = "zahl_unlesbar";
    public static final String DATUM_UNLESBAR = BezugsPeriode.DATUM_UNLESBAR;
    public static final String WERT_NEGATIV = "wert_negativ";
    public static final String WERT_UNPLAUSIBEL = "wert_unplausibel";
    public static final String KEINE_DATENZEILEN = CsvLeser.KEINE_DATENZEILEN;

    /** C8: die Befunde, die eine Zeile NICHT verhindern. Alle anderen tun es. */
    public static final List<String> HINWEIS_BEFUNDE = List.of(DATEI_BEKANNT, EINHEIT_UMGERECHNET, WERT_UNPLAUSIBEL);

    public static final String NEU = "neu";
    public static final String WIEDERHOLUNG = "wiederholung";
    public static final String KONFLIKT = "konflikt";
    public static final String BERICHTIGUNG = "berichtigung";
    public static final String UEBERSPRUNGEN = "uebersprungen";
    public static final String ABGELEHNT = "abgelehnt";

    public static final String UEBERNOMMEN = "uebernommen";
    public static final String TEILWEISE_UEBERNOMMEN = "teilweise_uebernommen";
    public static final String WIEDERHOLT = "wiederholt";
    public static final String ZURUECKGENOMMEN = "zurueckgenommen";
    public static final String VERWORFEN = "verworfen";

    public static final String WIRKSAM = "wirksam";
    public static final String VORSCHLAG = "vorschlag";

    /** AP-08 §4.5, von der Verbrauchsregel geerbt (K4). „keine Werte“ ist nie 0. */
    public static final String VOLLSTAENDIG = VerbrauchRegeln.VOLLSTAENDIG;

    public static final String UNVOLLSTAENDIG = VerbrauchRegeln.UNVOLLSTAENDIG;

    public static final String KEINE_WERTE = VerbrauchRegeln.KEINE_WERTE;

    public static final String ERSTELLER_GLEICH_FREIGEBER = "ersteller_gleich_freigeber";
    public static final String BEGRUENDUNG_ZU_KURZ = "begruendung_zu_kurz";

    private static final DateTimeFormatter UHR = DateTimeFormatter.ofPattern("HH:mm", Locale.GERMANY);

    // ------------------------------------------------------------------------- Die Ergebnisse

    /** U4/U5: der gelesene Betrag oder der Befund, warum er nicht lesbar ist. */
    public record Zahl(BigDecimal betrag, String befund) {}

    // Die Ergebnisse der beiden herausgelösten Module wohnen DORT, nicht hier:
    // BezugsEinheit.Einheitswert + BezugsEinheit.Umrechnung (U1–U3) und
    // BezugsPeriode.Periodendeutung + BezugsPeriode.Zeitdeutung (Z1–Z5).

    /** Z6: der Anteil EINES Kalendermonats am Ablesezeitraum. */
    public record Anteil(String monat, long minuten, BigDecimal prozent) {}

    /** Z6/E5: der Ablesezeitraum, seine Monatsanteile und die vorbelegte Zuordnung. */
    public record Zuordnung(
            long dauerMinuten, String dauerText, int monateBeruehrt, List<Anteil> anteile, String vorgabe) {}

    /** C5: das Urteil einer Zeile mit den Befunden in der Reihenfolge ihrer Feststellung. */
    public record Urteil(String urteil, List<String> befunde) {}

    /** C4: die Zähler der Vorschau. */
    public record Zaehler(
            int zeilen,
            int neu,
            int wiederholung,
            int konflikt,
            int berichtigung,
            int uebersprungen,
            int abgelehnt,
            int mitHinweis) {}

    /** C4/C6: was die Vorschau sagt und was die Übernahme täte. */
    public record Importergebnis(
            String status,
            Zaehler zaehler,
            boolean uebernahmeMoeglich,
            boolean importDatensatz,
            String bestaetigung,
            int aenderungen,
            List<String> befunde) {}

    /** Der Stand, gegen den eine Zeile geurteilt wird; {@code null} heißt „Schlüssel unbelegt“. */
    public record Bestand(BigDecimal betrag, int fassung, String importKennung) {}

    /** Eine schon beurteilte Zeile, wie die Import-Regel sie zählt. */
    public record Zeilenurteil(String urteil, List<String> befunde) {}

    /** F1–F4/C7: ein Vorgang an einem Wert. Er ändert nie eine Fassung, er legt die nächste an. */
    public record Vorgang(
            String art,
            BigDecimal betrag,
            String begruendung,
            String urheber,
            String freigeber,
            Instant zeitpunkt,
            String herkunftArt,
            String importKennung) {

        public static final String ERSTWERT = "erstwert";
        public static final String BERICHTIGUNG = "berichtigung";
        public static final String RUECKNAHME = "ruecknahme";
    }

    /** Eine Fassung eines Werts. Sie wird nie geändert und nie gelöscht (Invariante 1). */
    public record Fassung(
            int fassung,
            BigDecimal betrag,
            String status,
            String begruendung,
            Integer ersetztFassung,
            String herkunftArt,
            String importKennung) {

        Fassung mitStatus(String neu) {
            return new Fassung(fassung, betrag, neu, begruendung, ersetztFassung, herkunftArt, importKennung);
        }
    }

    /** F4: jede wirksame Fassung ≥ 2 erzeugt ein {@code correction}-Ereignis. Fassung 1 keines. */
    public record Ereignis(String art, int fassungAlt, int fassungNeu, String importKennung) {

        public static final String CORRECTION = "correction";
    }

    /** F1–F4/C7: alle Fassungen, die Ereignisse und der wirksame Betrag. */
    public record Fassungsverlauf(
            List<Fassung> fassungen, List<Ereignis> ereignisse, BigDecimal wirksamerBetrag, String abgelehnt) {}

    /** Ein zeitgültiges Stammdatum (AP-02). {@code gueltigBis} ist der LETZTE Tag. */
    public record Intervall(BigDecimal betrag, LocalDate gueltigAb, LocalDate gueltigBis, LocalDate eingetragenAm) {}

    /**
     * S3: an {@code tag} (00:00) gilt ein anderer Wert als am Vortag. {@code alt} {@code null}: vorher
     * war keiner erhoben; {@code neu} {@code null}: ab dem Tag ist keiner erhoben.
     */
    public record Wechsel(LocalDate tag, BigDecimal alt, BigDecimal neu) {}

    /**
     * E17: der Wert je Periode am Stichtag — und wie weit ein Eintrag zurückwirkt. {@code wechsel} je
     * Periode: die Übergänge NACH ihrem ersten Tag bis einschließlich zum Stichtag (S3); die Sätze dazu
     * stehen in {@code kennzeichen}, in derselben Reihenfolge.
     */
    public record Stammdatenstand(
            Map<String, BigDecimal> jePeriode,
            Map<String, LocalDate> stichtage,
            long rueckwirkendTage,
            List<Ereignis> ereignisse,
            Map<String, List<Wechsel>> wechsel,
            Map<String, List<String>> kennzeichen) {}

    /**
     * E15/S4: was ein neuer Wert ab {@code gueltigAb} an den wirksamen Intervallen ändert — dieselbe
     * Mechanik wie die Bezugsfläche der Ortsstruktur ({@link OrtsbaumAbleitung#flaecheEintrag}).
     * {@code unveraendert}: an dem Tag gilt schon genau dieser Wert, nichts wird geschrieben.
     * {@code beendet}: das laufende Intervall mit seinem NEUEN letzten Tag (dem Vortag).
     * {@code aufgehoben}: das Intervall, das am selben Tag begann (Korrektur) — es bleibt lesbar.
     * {@code neu}: das neue Intervall; es erbt das Ende des laufenden bzw. endet vor dem nächsten.
     */
    public record StammdatumEintrag(
            boolean unveraendert, Intervall beendet, Intervall aufgehoben, Intervall neu) {

        public boolean korrektur() {
            return aufgehoben != null;
        }
    }

    /** Ein Statuswechsel eines Zustands-Kanals. */
    public record Zustandswechsel(Instant zeit, String zustand) {}

    /** Eine Strecke ohne Werte. Sie zählt weder als der Zustand noch als sein Gegenteil (K4). */
    public record Luecke(Instant von, Instant bis, String quelle) {}

    /** K1–K7: die Dauer im gewählten Zustand, ihr Zustand, ihre Abdeckung und ihre Kennzeichen. */
    public record Kanalwert(
            BigDecimal betrag,
            String einheit,
            long minutenImZustand,
            String zustand,
            BigDecimal abdeckungProzent,
            BigDecimal gemesseneStunden,
            List<String> kennzeichen) {}

    // ------------------------------------------------------------------------------- Hilfen

    /** ISO-8601 mit Offset → Zeitpunkt. Gedeutet von {@link BezugsPeriode#zeit}. */
    public static Instant zeit(String iso) {
        return BezugsPeriode.zeit(iso);
    }

    /** Ein Zeitpunkt als ISO-8601 mit dem Offset der Zone — aus {@link BezugsPeriode#iso}. */
    public static String iso(Instant t, ZoneId zone) {
        return BezugsPeriode.iso(t, zone);
    }

    private static BigDecimal dezimal(String s) {
        return s == null ? null : new BigDecimal(s);
    }

    private static boolean gleich(BigDecimal a, BigDecimal b) {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        return a.setScale(VERGLEICH_NACHKOMMASTELLEN, RoundingMode.HALF_UP)
                        .compareTo(b.setScale(VERGLEICH_NACHKOMMASTELLEN, RoundingMode.HALF_UP))
                == 0;
    }

    private static boolean istHinweis(String befund) {
        return HINWEIS_BEFUNDE.contains(befund);
    }

    // ----------------------------------------------------------------------- U4/U5 — die Zahl

    /**
     * U4/U5 — der Zahlentext einer Wertspalte wird ein Betrag.
     *
     * <p>{@code format} ist {@code de} (Punkt = Tausender, Komma = Dezimal), {@code en} (umgekehrt)
     * oder {@code auto} (das letzte Trennzeichen ist das Dezimaltrennzeichen). Leerzeichen — auch
     * geschützte und schmale — sind immer Tausendertrenner. Eine Tausendergruppe hat GENAU drei
     * Stellen; alles andere ist {@code zahl_unlesbar}, nie eine geratene Deutung.
     *
     * <p>{@code ganzzahlig} gilt für Stück, Personen und Schichten (U5): ein Dezimaltrennzeichen
     * macht die Zahl unlesbar — „Stück sind ganze Zahlen“.
     */
    public static Zahl zahl(String text, String format, boolean ganzzahlig) {
        if (text == null || text.isBlank()) {
            return new Zahl(null, ZAHL_UNLESBAR);
        }
        String s = text.replace(" ", "").replace(" ", "").replace(" ", "").trim();
        boolean negativ = s.startsWith("-");
        if (negativ || s.startsWith("+")) {
            s = s.substring(1);
        }
        if (!s.matches("[0-9.,]+")) {
            return new Zahl(null, ZAHL_UNLESBAR);
        }

        char dezimal = dezimalzeichen(s, format);
        char tausender = dezimal == ',' ? '.' : ',';

        int trenner = s.lastIndexOf(dezimal);
        String ganz = trenner < 0 ? s : s.substring(0, trenner);
        String bruch = trenner < 0 ? "" : s.substring(trenner + 1);
        if (bruch.indexOf(dezimal) >= 0 || bruch.indexOf(tausender) >= 0 || (trenner >= 0 && bruch.isEmpty())) {
            return new Zahl(null, ZAHL_UNLESBAR);
        }
        if (trenner >= 0 && ganzzahlig) {
            return new Zahl(null, ZAHL_UNLESBAR);
        }

        String[] gruppen = ganz.split(java.util.regex.Pattern.quote(String.valueOf(tausender)), -1);
        if (gruppen.length == 0 || gruppen[0].isEmpty() || gruppen[0].length() > 3) {
            return new Zahl(null, ZAHL_UNLESBAR);
        }
        for (int i = 1; i < gruppen.length; i++) {
            if (gruppen[i].length() != 3) {
                return new Zahl(null, ZAHL_UNLESBAR);
            }
        }
        String zahl = String.join("", gruppen) + (bruch.isEmpty() ? "" : "." + bruch);
        if (!zahl.matches("[0-9]+([.][0-9]+)?")) {
            return new Zahl(null, ZAHL_UNLESBAR);
        }
        return new Zahl(new BigDecimal((negativ ? "-" : "") + zahl), null);
    }

    private static char dezimalzeichen(String s, String format) {
        if ("de".equals(format)) {
            return ',';
        }
        if ("en".equals(format)) {
            return '.';
        }
        int komma = s.lastIndexOf(',');
        int punkt = s.lastIndexOf('.');
        if (komma < 0 && punkt < 0) {
            return ',';
        }
        return komma > punkt ? ',' : '.';
    }

    // ------------------------------------------------------------------- U1–U3 — die Einheit

    /**
     * U1–U3 — der gelieferte Betrag wird auf die Einheit der Bezugsgröße gebracht.
     *
     * <p>Gerechnet wird in {@link BezugsEinheit}: das geschlossene Vokabular je Größe, die festen
     * Faktoren und die Synonyme wohnen seit AP-09 IP-3 dort, damit Import, Eingabe, Kennzahlen
     * und Berichte dieselbe Umrechnung benutzen. Hier steht nur der Anruf.
     */
    public static BezugsEinheit.Einheitswert einheit(
            BigDecimal betrag,
            String geliefert,
            String ziel,
            Map<String, List<String>> einheiten,
            List<BezugsEinheit.Umrechnung> umrechnungen) {
        return BezugsEinheit.einheit(betrag, geliefert, ziel, einheiten, umrechnungen);
    }

    // --------------------------------------------------------------------- U6 — Plausibilität

    /**
     * U6 — ein Betrag unter null wird abgelehnt; eine Betriebszeit über der Stundenzahl der
     * Periode ist ein HINWEIS, kein Fehler.
     *
     * <p>Die Obergrenze ist die Stundenzahl der Periode × Anzahl der gebundenen Einheiten — am
     * Umstellungstag also 23 oder 25 Stunden, nie 24 (Z5, §7 B10). Bei einer Messstelle als
     * Bezug ist die Anzahl 1.
     */
    public static String plausibilitaet(
            BigDecimal betrag, String einheit, Integer stundenDesTages, int einheitenGebunden) {
        if (betrag == null) {
            return null;
        }
        if (betrag.signum() < 0) {
            return WERT_NEGATIV;
        }
        if (stundenDesTages == null) {
            return null;
        }
        BigDecimal grenze = BigDecimal.valueOf((long) stundenDesTages * einheitenGebunden);
        if ("min".equals(einheit)) {
            grenze = grenze.multiply(BigDecimal.valueOf(60));
        } else if (!"h".equals(einheit)) {
            return null;
        }
        return betrag.compareTo(grenze) > 0 ? WERT_UNPLAUSIBEL : null;
    }

    // -------------------------------------------------------------------- Z1–Z4 — die Periode

    /**
     * Z1–Z4 — eine Datumsspalte wird die Periode, für die der Wert gilt.
     *
     * <p>Gedeutet wird in {@link BezugsPeriode}: die Deutungen der Vorlage (Z3), die Zeitzone des
     * Standorts (Z1/E7), die 23-/25-Stunden-Tage und die beiden getrennten Befunde
     * {@code periode_passt_nicht} (passt nie, wird nie geteilt) und {@code periode_nicht_zu_ende}
     * (läuft noch) wohnen seit AP-09 IP-3 dort. Hier steht nur der Anruf.
     */
    public static BezugsPeriode.Periodendeutung periode(
            String text,
            String vonText,
            String bisText,
            String deutung,
            String periodeArt,
            ZoneId zone,
            Instant jetzt) {
        return BezugsPeriode.periode(text, vonText, bisText, deutung, periodeArt, zone, jetzt);
    }

    // ------------------------------------------------------------------ Z5 — der Zeitstempel

    /**
     * Z5/E7 — ein Zeitstempel ohne Zone bekommt die Zeitzone des Standorts.
     *
     * <p>Gedeutet wird in {@link BezugsPeriode}: die doppelte Stunde ist {@code zeit_mehrdeutig}
     * mit BEIDEN Möglichkeiten, die fehlende {@code zeit_nicht_vorhanden} — nie geraten. Hier
     * steht nur der Anruf.
     */
    public static BezugsPeriode.Zeitdeutung zeitpunkt(String text, ZoneId zone, String offsetInDatei) {
        return BezugsPeriode.zeitpunkt(text, zone, offsetInDatei);
    }

    /** P3 — die Länge eines Kalendertages in Stunden; sie kommt über {@link BezugsPeriode} aus AP-08. */
    public static long stundenDesTages(LocalDate tag, ZoneId zone) {
        return BezugsPeriode.stundenDesTages(tag, zone);
    }

    // ------------------------------------------------------------------- Z6 — die Zuordnung

    /**
     * Z6/E5 — ein Ablesezeitraum und die Kalendermonate, die er berührt.
     *
     * <p>Vorgabe ist der Monat mit dem größten zeitlichen Anteil, solange der Zeitraum höchstens
     * {@link #ZUORDNUNG_HOECHSTENS_MONATE} Monate berührt; sonst gibt es keine Vorgabe und nur der
     * Kunde entscheidet. Die Vorgabe entscheidet über die MINUTEN, nicht über den gerundeten
     * Prozentsatz. Nichts wird geteilt oder verteilt — die Zuordnung ist ein Kennzeichen, keine
     * Rechnung (Invariante 3).
     */
    public static Zuordnung zuordnung(Instant von, Instant bis, ZoneId zone) {
        long gesamt = ChronoUnit.MINUTES.between(von, bis);
        List<Anteil> anteile = new ArrayList<>();
        ZonedDateTime lauf = von.atZone(zone);
        ZonedDateTime ende = bis.atZone(zone);
        while (lauf.isBefore(ende)) {
            ZonedDateTime monatsende = lauf.toLocalDate()
                    .withDayOfMonth(1)
                    .plusMonths(1)
                    .atStartOfDay(zone);
            ZonedDateTime schnitt = monatsende.isBefore(ende) ? monatsende : ende;
            long minuten = ChronoUnit.MINUTES.between(lauf, schnitt);
            anteile.add(new Anteil(
                    String.format(Locale.ROOT, "%04d-%02d", lauf.getYear(), lauf.getMonthValue()),
                    minuten,
                    prozent(minuten, gesamt, ANTEIL_NACHKOMMASTELLEN)));
            lauf = schnitt;
        }
        String vorgabe = null;
        if (anteile.size() <= ZUORDNUNG_HOECHSTENS_MONATE) {
            Anteil groesster = anteile.get(0);
            for (Anteil a : anteile) {
                if (a.minuten() > groesster.minuten()) {
                    groesster = a;
                }
            }
            vorgabe = groesster.monat();
        }
        return new Zuordnung(gesamt, dauerText(gesamt), anteile.size(), List.copyOf(anteile), vorgabe);
    }

    private static BigDecimal prozent(long teil, long ganz, int stellen) {
        if (ganz == 0) {
            return BigDecimal.ZERO.setScale(stellen);
        }
        return BigDecimal.valueOf(teil)
                .multiply(BigDecimal.valueOf(100))
                .divide(BigDecimal.valueOf(ganz), stellen, RoundingMode.HALF_UP);
    }

    /** „32 Tage 1 h 25 min“ — die Länge eines Ablesezeitraums als Kundensatz. */
    public static String dauerText(long minutenGesamt) {
        long tage = minutenGesamt / 1440;
        long rest = minutenGesamt % 1440;
        List<String> teile = new ArrayList<>();
        if (tage > 0) {
            teile.add(tage + " Tage");
        }
        if (rest / 60 > 0) {
            teile.add(rest / 60 + " h");
        }
        if (rest % 60 > 0) {
            teile.add(rest % 60 + " min");
        }
        return String.join(" ", teile);
    }

    // ---------------------------------------------------------------------- C5 — das Urteil

    /**
     * C5 und §4.7 — das Urteil einer Zeile.
     *
     * <p>Zuerst gewinnt ein Befund, der die Zeile verhindert: {@code abgelehnt}. Dann kommt der
     * Datei-Befund dazu ({@code datei_bekannt} ist ein HINWEIS und verhindert nichts). Ein
     * unbelegter Schlüssel — auch nach einer Rücknahme, denn dann hat der wirksame Stand keinen
     * Betrag — ist {@code neu}. Derselbe Betrag ist eine {@code wiederholung} und schreibt
     * nichts; ein anderer Betrag ist ein {@code konflikt}, der eine Entscheidung braucht, und
     * wird NIE still ersetzt (E9, Invariante 2).
     */
    public static Urteil urteil(
            String schluessel,
            BigDecimal betrag,
            Bestand bestand,
            boolean dateiFingerabdruckBekannt,
            String fruehererImportStatus,
            String entscheidung,
            List<String> befundeVorher) {
        List<String> befunde = new ArrayList<>();
        if (dateiFingerabdruckBekannt && fruehererImportStatus != null) {
            befunde.add(DATEI_BEKANNT);
        }
        befunde.addAll(befundeVorher);
        for (String b : befunde) {
            if (!istHinweis(b)) {
                return new Urteil(ABGELEHNT, List.copyOf(befunde));
            }
        }
        if (bestand == null || bestand.betrag() == null) {
            return new Urteil(NEU, List.copyOf(befunde));
        }
        if (gleich(bestand.betrag(), betrag)) {
            return new Urteil(WIEDERHOLUNG, List.copyOf(befunde));
        }
        befunde.add(KONFLIKT_ANDERER_WERT);
        String urteil = switch (entscheidung == null ? "" : entscheidung) {
            case "ersetzen" -> BERICHTIGUNG;
            case "behalten" -> UEBERSPRUNGEN;
            default -> KONFLIKT;
        };
        return new Urteil(urteil, List.copyOf(befunde));
    }

    // ------------------------------------------------------------------- C4/C6 — der Import

    /**
     * C4/C6 — was die Vorschau sagt und was die Übernahme täte.
     *
     * <p>Eine Datei ohne Datenzeilen hat keine Übernahme und schreibt nichts, auch keinen
     * Import-Datensatz (§7 B12). Geschrieben werden nur Zeilen mit dem Urteil {@code neu} oder
     * {@code berichtigung} — deshalb ist eine doppelt importierte Datei 0 Änderungen
     * (Plan-Abnahme 1, §7 B2). Werden nicht alle Zeilen übernommen, verlangt E10 eine
     * ausdrückliche Bestätigung mit der Zahl.
     */
    public static Importergebnis importErgebnis(
            int datenzeilen, boolean fingerabdruckBekannt, String fruehererImportStatus, List<Zeilenurteil> zeilen) {
        if (datenzeilen == 0) {
            return new Importergebnis(
                    null,
                    new Zaehler(0, 0, 0, 0, 0, 0, 0, 0),
                    false,
                    false,
                    null,
                    0,
                    List.of(KEINE_DATENZEILEN));
        }
        int neu = 0;
        int wiederholung = 0;
        int konflikt = 0;
        int berichtigung = 0;
        int uebersprungen = 0;
        int abgelehnt = 0;
        int mitHinweis = 0;
        for (Zeilenurteil z : zeilen) {
            switch (z.urteil()) {
                case NEU -> neu++;
                case WIEDERHOLUNG -> wiederholung++;
                case KONFLIKT -> konflikt++;
                case BERICHTIGUNG -> berichtigung++;
                case UEBERSPRUNGEN -> uebersprungen++;
                default -> abgelehnt++;
            }
            if (z.befunde().contains(KONFLIKT_ANDERER_WERT) && !KONFLIKT.equals(z.urteil())) {
                konflikt++;
            }
            for (String b : z.befunde()) {
                if (istHinweis(b)) {
                    mitHinweis++;
                    break;
                }
            }
        }
        int aenderungen = neu + berichtigung;
        Zaehler zaehler = new Zaehler(
                zeilen.size(), neu, wiederholung, konflikt, berichtigung, uebersprungen, abgelehnt, mitHinweis);

        String status;
        if (abgelehnt == zeilen.size()) {
            status = VERWORFEN;
        } else if (abgelehnt > 0) {
            status = TEILWEISE_UEBERNOMMEN;
        } else if (aenderungen == 0) {
            status = WIEDERHOLT;
        } else {
            status = UEBERNOMMEN;
        }
        String bestaetigung =
                aenderungen > 0 && aenderungen < zeilen.size() ? aenderungen + " von " + zeilen.size() + " Zeilen übernehmen" : null;
        List<String> befunde =
                fingerabdruckBekannt && fruehererImportStatus != null ? List.of(DATEI_BEKANNT) : List.of();
        return new Importergebnis(status, zaehler, aenderungen > 0, true, bestaetigung, aenderungen, befunde);
    }

    // ------------------------------------------------------------ F1–F4/C7 — die Fassungen

    /**
     * F1–F4 und C7 — die Fassungen eines Werts aus den Vorgängen an ihm.
     *
     * <p>Ein Erstwert braucht keine Begründung und keine Freigabe (F1). Jede Änderung ist eine
     * Berichtigung = Fassung n + 1 mit Begründung; Fassung n bleibt lesbar (F2, Invariante 1).
     * Mit eingeschaltetem Vier-Augen-Prinzip ist die neue Fassung ein {@code vorschlag}, bis eine
     * ZWEITE Person freigibt — der Urheber kann sich nie selbst freigeben (F3). Jede wirksame
     * Fassung ≥ 2 erzeugt ein {@code correction}-Ereignis (F4). Eine Rücknahme löscht nichts: sie
     * ist die nächste Fassung — ohne Betrag, wenn sie einen Erstwert trifft, und mit dem Betrag
     * der Vorfassung, wenn sie eine Berichtigung trifft (C7, §7 B14).
     */
    public static Fassungsverlauf fassungen(boolean vierAugen, List<Vorgang> vorgaenge) {
        List<Fassung> fassungen = new ArrayList<>();
        List<Ereignis> ereignisse = new ArrayList<>();
        String abgelehnt = null;

        for (Vorgang v : vorgaenge) {
            Fassung letzte = fassungen.isEmpty() ? null : fassungen.get(fassungen.size() - 1);

            // F1: der erste Vorgang kann nur ein Erstwert sein. Ein Erstwert ist auch der Weg
            // zurück, nachdem eine Rücknahme den Wert ohne Betrag hinterlassen hat (§7 B14).
            boolean erstwert = Vorgang.ERSTWERT.equals(v.art());
            if (letzte == null && !erstwert) {
                continue;
            }

            // F2: ab Fassung 2 ist eine Begründung Pflicht — ein Erstwert ist keine Korrektur.
            if (!erstwert && (v.begruendung() == null || v.begruendung().length() < BEGRUENDUNG_MIN_ZEICHEN)) {
                abgelehnt = BEGRUENDUNG_ZU_KURZ;
                continue;
            }

            BigDecimal betrag = v.betrag();
            String status = WIRKSAM;
            if (Vorgang.RUECKNAHME.equals(v.art())) {
                // C7: eine zurückgenommene BERICHTIGUNG fällt auf die Vorfassung zurück; ein
                // zurückgenommener Erstwert hinterlässt keinen Betrag — nie eine 0.
                Integer vor = letzte.ersetztFassung();
                betrag = vor == null ? null : fassungen.get(vor - 1).betrag();
                status = betrag == null ? ZURUECKGENOMMEN : WIRKSAM;
            }

            // F3: mit Vier-Augen ist jede Fassung ≥ 2 ein Vorschlag, bis eine ZWEITE Person
            // freigibt. Der Urheber kann sich nie selbst freigeben.
            if (vierAugen && letzte != null) {
                boolean freigegeben = v.freigeber() != null && !v.freigeber().equals(v.urheber());
                if (!freigegeben) {
                    if (v.freigeber() != null) {
                        abgelehnt = ERSTELLER_GLEICH_FREIGEBER;
                    }
                    status = VORSCHLAG;
                }
            }

            int nummer = fassungen.size() + 1;
            if (letzte != null && !VORSCHLAG.equals(status)) {
                fassungen.set(nummer - 2, letzte.mitStatus("wirksam bis Fassung " + nummer));
                // F4: nur eine WIRKSAME Fassung ≥ 2 erzeugt das Ereignis; Fassung 1 keines.
                ereignisse.add(new Ereignis(Ereignis.CORRECTION, nummer - 1, nummer, v.importKennung()));
            }
            fassungen.add(new Fassung(
                    nummer,
                    betrag,
                    status,
                    v.begruendung(),
                    letzte == null ? null : nummer - 1,
                    v.herkunftArt(),
                    v.importKennung()));
        }

        BigDecimal wirksam = null;
        for (int i = fassungen.size() - 1; i >= 0; i--) {
            Fassung f = fassungen.get(i);
            if (!VORSCHLAG.equals(f.status()) && !f.status().startsWith("wirksam bis")) {
                wirksam = f.betrag();
                break;
            }
        }
        return new Fassungsverlauf(List.copyOf(fassungen), List.copyOf(ereignisse), wirksam, abgelehnt);
    }

    // ---------------------------------------------------------------- E17 — das Stammdatum

    /**
     * E17 — ein zeitgültiges Stammdatum (die Bezugsfläche) wird zum STICHTAG der Periode gelesen:
     * ihrem letzten Tag.
     *
     * <p>Ein neuer Wert ab Tag X ändert deshalb keine Periode vor X — und erzeugt kein Ereignis
     * für sie (Plan-Abnahme 2, §7 B6). Eine Periode ohne gültiges Intervall hat „keine Werte“,
     * nie 0.
     *
     * <p>S3: ändert sich der Wert NACH dem ersten Tag der Periode (bis einschließlich zum Stichtag),
     * nennt die Periode jeden Übergang als Kennzeichen — „Fläche geändert am 01.01.2027 (3.100 →
     * 3.400 m²)“. Gelesen wird trotzdem nur der Stichtag: ein zeitgewichtetes Mittel ist eine
     * AP-11-Formel, nie diese Regel. Ein Übergang genau am ersten Tag der Periode liegt nicht IN ihr.
     *
     * @param bezeichnung wie das Stammdatum im Satz heißt („Fläche“, „Mitarbeitende“)
     * @param einheit die Einheit der Bezugsgröße, wie sie im Satz steht
     */
    public static Stammdatenstand stammdatum(
            List<Intervall> intervalle, List<String> perioden, String periodeArt, String bezeichnung, String einheit) {
        Map<String, BigDecimal> jePeriode = new LinkedHashMap<>();
        Map<String, LocalDate> stichtage = new LinkedHashMap<>();
        Map<String, List<Wechsel>> wechsel = new LinkedHashMap<>();
        Map<String, List<String>> kennzeichen = new LinkedHashMap<>();
        for (String p : perioden) {
            LocalDate[] spanne = BezugsPeriode.spanneVon(p, periodeArt);
            LocalDate stichtag = spanne[1];
            stichtage.put(p, stichtag);
            jePeriode.put(p, wertAm(intervalle, stichtag));
            List<Wechsel> inPeriode = wechselIn(intervalle, spanne[0], stichtag);
            wechsel.put(p, inPeriode);
            kennzeichen.put(p, inPeriode.stream().map(w -> stammdatumSatz(bezeichnung, w, einheit)).toList());
        }
        long rueckwirkend = 0;
        for (Intervall i : intervalle) {
            if (i.eingetragenAm() != null && i.eingetragenAm().isAfter(i.gueltigAb())) {
                rueckwirkend = Math.max(rueckwirkend, ChronoUnit.DAYS.between(i.gueltigAb(), i.eingetragenAm()));
            }
        }
        // Map.copyOf verträgt keine null-Werte — und „keine Werte“ IST hier ein null, nie eine 0.
        return new Stammdatenstand(
                Collections.unmodifiableMap(jePeriode),
                Collections.unmodifiableMap(stichtage),
                rueckwirkend,
                List.of(),
                Collections.unmodifiableMap(wechsel),
                Collections.unmodifiableMap(kennzeichen));
    }

    /** Der Wert, der am {@code tag} gilt — {@code null}, wenn keiner erhoben ist (nie 0). */
    public static BigDecimal wertAm(List<Intervall> intervalle, LocalDate tag) {
        for (Intervall i : intervalle) {
            if (!tag.isBefore(i.gueltigAb()) && (i.gueltigBis() == null || !tag.isAfter(i.gueltigBis()))) {
                return i.betrag();
            }
        }
        return null;
    }

    /**
     * S3: die Tage in {@code (erster, letzter]}, an denen ein anderer Wert gilt als am Vortag — nach Tag
     * sortiert. Zahlen werden numerisch verglichen („3100“ = „3100.0“): zwei aneinanderstoßende
     * Intervalle mit demselben Wert sind kein Übergang.
     */
    static List<Wechsel> wechselIn(List<Intervall> intervalle, LocalDate erster, LocalDate letzter) {
        java.util.TreeSet<LocalDate> kandidaten = new java.util.TreeSet<>();
        for (Intervall i : intervalle) {
            kandidaten.add(i.gueltigAb());
            if (i.gueltigBis() != null) {
                kandidaten.add(i.gueltigBis().plusDays(1));
            }
        }
        List<Wechsel> aus = new ArrayList<>();
        for (LocalDate tag : kandidaten) {
            if (!tag.isAfter(erster) || tag.isAfter(letzter)) {
                continue;
            }
            BigDecimal alt = wertAm(intervalle, tag.minusDays(1));
            BigDecimal neu = wertAm(intervalle, tag);
            boolean gleich = alt == null ? neu == null : neu != null && alt.compareTo(neu) == 0;
            if (!gleich) {
                aus.add(new Wechsel(tag, alt, neu));
            }
        }
        return List.copyOf(aus);
    }

    /** S3: der Satz „geändert am“ — ein Wert vorher und nachher. */
    public static final String STAMMDATUM_GEAENDERT = "{bezeichnung} geändert am {tag} ({alt} → {neu} {einheit})";

    /** S3: vor dem Übergang war kein Wert erhoben. */
    public static final String STAMMDATUM_BEGINNT = "{bezeichnung} erst ab {tag} erhoben ({neu} {einheit})";

    /** S3: ab dem Übergang ist kein Wert erhoben; {@code tag} ist der LETZTE Tag mit Wert. */
    public static final String STAMMDATUM_ENDET = "{bezeichnung} nur bis {tag} erhoben ({alt} {einheit})";

    /**
     * S3: der Kundensatz zu einem Übergang, aus den Vorlagen des Vertrags ({@code stammdatum_saetze}).
     * Die Zahl steht wie jede angezeigte Zahl (E11): Tausenderpunkt, Komma, ungerundet — ein
     * Stammdatum ist ein erhobener Wert, kein gerechneter.
     */
    public static String stammdatumSatz(String bezeichnung, Wechsel w, String einheit) {
        String vorlage = w.alt() == null ? STAMMDATUM_BEGINNT : w.neu() == null ? STAMMDATUM_ENDET : STAMMDATUM_GEAENDERT;
        LocalDate tag = w.neu() == null ? w.tag().minusDays(1) : w.tag();
        return vorlage
                .replace("{bezeichnung}", bezeichnung)
                .replace("{tag}", OrtsbaumAbleitung.datumText(tag))
                .replace("{alt}", w.alt() == null ? "" : stammdatumZahl(w.alt()))
                .replace("{neu}", w.neu() == null ? "" : stammdatumZahl(w.neu()))
                .replace("{einheit}", einheit);
    }

    /** E11 ohne Rundung: „3.100“, „172,5“ — die Zeichen aus {@link ErgebnisZustand}. */
    static String stammdatumZahl(BigDecimal wert) {
        String klartext = wert.stripTrailingZeros().toPlainString();
        int punkt = klartext.indexOf('.');
        String ganz = punkt < 0 ? klartext : klartext.substring(0, punkt);
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < ganz.length(); i++) {
            if (i > 0 && (ganz.length() - i) % 3 == 0) {
                s.append(ErgebnisZustand.TAUSENDER);
            }
            s.append(ganz.charAt(i));
        }
        if (punkt >= 0) {
            s.append(ErgebnisZustand.DEZIMAL).append(klartext.substring(punkt + 1));
        }
        return s.toString();
    }

    /**
     * E15/S4: ein neuer Wert eines Stammdatums ab einem Tag — byte-genau die Mechanik der Bezugsfläche
     * ({@link OrtsbaumAbleitung#flaecheEintrag}, AP-02 §4.3): das laufende Intervall endet am VORTAG,
     * das neue erbt dessen Ende (auch das vor einem geplanten); in einer Lücke endet es am Vortag des
     * nächsten. Beginnt am Tag schon eines, ist es eine Korrektur: es wird aufgehoben, nie
     * umgeschrieben. Gilt am Tag schon genau dieser Wert, ändert sich nichts.
     *
     * @param wirksame die nicht aufgehobenen Intervalle ({@code eingetragenAm} spielt keine Rolle)
     */
    public static StammdatumEintrag stammdatumEintrag(List<Intervall> wirksame, LocalDate gueltigAb, BigDecimal wert) {
        List<Intervall> liste = wirksame.stream()
                .sorted(java.util.Comparator.comparing(Intervall::gueltigAb))
                .toList();
        Intervall laufend = liste.stream()
                .filter(i -> !gueltigAb.isBefore(i.gueltigAb())
                        && (i.gueltigBis() == null || !gueltigAb.isAfter(i.gueltigBis())))
                .findFirst()
                .orElse(null);
        if (laufend != null && laufend.betrag().compareTo(wert) == 0) {
            return new StammdatumEintrag(true, null, null, null);
        }
        boolean korrektur = laufend != null && laufend.gueltigAb().equals(gueltigAb);
        LocalDate bis = laufend != null
                ? laufend.gueltigBis()
                : liste.stream()
                        .map(Intervall::gueltigAb)
                        .filter(t -> t.isAfter(gueltigAb))
                        .findFirst()
                        .map(t -> t.minusDays(1))
                        .orElse(null);
        Intervall beendet = laufend != null && !korrektur
                ? new Intervall(laufend.betrag(), laufend.gueltigAb(), gueltigAb.minusDays(1), laufend.eingetragenAm())
                : null;
        return new StammdatumEintrag(false, beendet, korrektur ? laufend : null, new Intervall(wert, gueltigAb, bis, null));
    }

    // ------------------------------------------------------------------- K1–K7 — der Kanal

    /**
     * K1–K7 — die Dauer im gewählten Zustand einer Periode.
     *
     * <p>Gezählt wird nur GEMESSENE Zeit: eine Lücke zählt weder als der Zustand noch als sein
     * Gegenteil, sie macht die Periode unvollständig (§7 B7). Der Zustand am Periodenanfang ist
     * der letzte Wechsel davor; gibt es keinen, ist die Zeit bis zum ersten Wechsel nicht
     * gemessen. Eine Periode ganz ohne Werte hat „keine Werte“ — nie 0 h (K4).
     *
     * <p>⚠ Die Abdeckung hier ist ZEITBASIERT (gemessene Zeit ÷ Periodenlänge). Die Abdeckung der
     * Verbrauchsregel ist wertbasiert und abgeschnitten (AP-08 Z9) — zwei verschiedene Zahlen mit
     * demselben Namen.
     */
    public static Kanalwert kanal(
            Instant von,
            Instant bis,
            String zustandGewaehlt,
            String zustandAmAnfang,
            List<Zustandswechsel> wechsel,
            List<Luecke> luecken,
            ZoneId zone) {
        List<Zustandswechsel> folge = new ArrayList<>();
        if (zustandAmAnfang != null) {
            folge.add(new Zustandswechsel(von, zustandAmAnfang));
        }
        for (Zustandswechsel w : wechsel) {
            if (!w.zeit().isBefore(von) && w.zeit().isBefore(bis)) {
                folge.add(w);
            }
        }
        folge.sort(java.util.Comparator.comparing(Zustandswechsel::zeit));

        // Nicht gemessen ist: jede gemeldete Lücke UND — solange kein Zustand am Periodenanfang
        // bekannt ist — die Zeit bis zum ersten Wechsel. Beides wird zusammengefasst, damit sich
        // überlappende Strecken nicht doppelt abziehen.
        List<Instant[]> ungemessen = new ArrayList<>();
        for (Luecke l : luecken) {
            ungemessen.add(new Instant[] {l.von(), l.bis()});
        }
        if (zustandAmAnfang == null) {
            ungemessen.add(new Instant[] {von, folge.isEmpty() ? bis : folge.get(0).zeit()});
        }
        List<Instant[]> loecher = zusammengefasst(ungemessen);

        long imZustand = 0;
        for (int i = 0; i < folge.size(); i++) {
            if (!zustandGewaehlt.equals(folge.get(i).zustand())) {
                continue;
            }
            Instant a = folge.get(i).zeit();
            Instant b = i + 1 < folge.size() ? folge.get(i + 1).zeit() : bis;
            imZustand += gemesseneMinuten(a, b, loecher);
        }

        long laenge = ChronoUnit.MINUTES.between(von, bis);
        long gemessen = gemesseneMinuten(von, bis, loecher);

        List<String> kennzeichen = new ArrayList<>();
        for (Luecke l : luecken) {
            long minuten = ChronoUnit.MINUTES.between(l.von(), l.bis());
            kennzeichen.add(zahlText(BigDecimal.valueOf(minuten).divide(BigDecimal.valueOf(60), 2, RoundingMode.HALF_UP))
                    + " h ohne Werte (" + l.quelle() + ", "
                    + UHR.format(l.von().atZone(zone)) + "–" + UHR.format(l.bis().atZone(zone)) + ")");
        }

        String zustand = gemessen == 0 ? KEINE_WERTE : (gemessen < laenge ? UNVOLLSTAENDIG : VOLLSTAENDIG);
        BigDecimal betrag = gemessen == 0 ? null : stunden(imZustand);
        return new Kanalwert(
                betrag,
                "h",
                imZustand,
                zustand,
                prozent(gemessen, laenge, ABDECKUNG_NACHKOMMASTELLEN),
                stunden(gemessen),
                List.copyOf(kennzeichen));
    }

    private static BigDecimal stunden(long minuten) {
        return BigDecimal.valueOf(minuten)
                .divide(BigDecimal.valueOf(60), 4, RoundingMode.HALF_UP)
                .stripTrailingZeros();
    }

    /** Überlappende und aneinandergrenzende Strecken zu einer Liste ohne Überschneidung. */
    private static List<Instant[]> zusammengefasst(List<Instant[]> strecken) {
        List<Instant[]> sortiert = new ArrayList<>(strecken);
        sortiert.removeIf(s -> !s[0].isBefore(s[1]));
        sortiert.sort(java.util.Comparator.comparing(s -> s[0]));
        List<Instant[]> aus = new ArrayList<>();
        for (Instant[] s : sortiert) {
            if (!aus.isEmpty() && !s[0].isAfter(aus.get(aus.size() - 1)[1])) {
                Instant[] letzte = aus.get(aus.size() - 1);
                if (s[1].isAfter(letzte[1])) {
                    letzte[1] = s[1];
                }
                continue;
            }
            aus.add(new Instant[] {s[0], s[1]});
        }
        return aus;
    }

    private static long gemesseneMinuten(Instant von, Instant bis, List<Instant[]> loecher) {
        long minuten = Math.max(0, ChronoUnit.MINUTES.between(von, bis));
        for (Instant[] l : loecher) {
            Instant a = l[0].isAfter(von) ? l[0] : von;
            Instant b = l[1].isBefore(bis) ? l[1] : bis;
            if (a.isBefore(b)) {
                minuten -= ChronoUnit.MINUTES.between(a, b);
            }
        }
        return Math.max(0, minuten);
    }

    /** Eine Dezimalzahl als Kundenzahl: ohne Nullen am Ende, mit deutschem Komma. */
    public static String zahlText(BigDecimal x) {
        return x.stripTrailingZeros().toPlainString().replace('.', ',');
    }

    // ------------------------------------------------------------- AP-08 — die Verbrauchsregel

    /**
     * Die Menge eines Ablesezeitraums — gerechnet von der Verbrauchsregel AP-08, nicht hier.
     *
     * <p>Diese Methode reicht die Ablesungen als Rohwerte an
     * {@link VerbrauchRegeln#mengeZaehlerstand} weiter. Sie ist ausdrücklich keine zweite
     * Rechnung: ein kleinerer Stand ist dort eine Rücksetzung (Z5) und macht die Periode
     * unvollständig statt eine negative Menge zu erzeugen.
     *
     * @param reihe Einheit der Ablesungen und Zeitzone des Standorts, in denen die Kennzeichen sprechen
     */
    public static VerbrauchRegeln.Ergebnis mengeAblesezeitraum(ReihenKontext reihe,
            List<VerbrauchRegeln.Rohwert> staende, Instant von, Instant bis, Duration kadenz) {
        return VerbrauchRegeln.mengeZaehlerstand(
                reihe, staende, von, bis, kadenz, List.of(), BigDecimal.ONE, null, null);
    }

    /** Der Kundensatz eines Befunds aus dem Vertrag — das Portal erfindet keinen zweiten. */
    public static String satz(String befund, Map<String, String> saetze) {
        return Objects.requireNonNull(saetze.get(befund), "kein Kundensatz für " + befund);
    }
}
