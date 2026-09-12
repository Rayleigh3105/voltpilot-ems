package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.time.temporal.IsoFields;
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
 * <p><b>Die Menge eines Ablesezeitraums rechnet diese Klasse NICHT.</b> Das tut die schon
 * gemergte Verbrauchsregel {@link VerbrauchRegeln#mengeZaehlerstand} (AP-08 IP-1); ebenso kommt
 * die Länge einer Periode in Stunden aus {@link VerbrauchRegeln#stunden}. Zwei Zahlen für dieselbe
 * Aussage wären genau die Drift, die diese Verträge verhindern sollen.
 *
 * <p><b>Wer anruft (Stand AP-09 IP-1): niemand.</b> Dieses Paket legt die Wahrheit fest, gegen die
 * IP-3 … IP-19 gebaut werden. Kein Produktionsweg berührt diese Klasse.
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
    public static final String EINHEIT_UNBEKANNT = "einheit_unbekannt";
    public static final String EINHEIT_UMGERECHNET = "einheit_umgerechnet";
    public static final String PERIODE_PASST_NICHT = "periode_passt_nicht";
    public static final String PERIODE_NICHT_ZU_ENDE = "periode_nicht_zu_ende";
    public static final String ZEIT_MEHRDEUTIG = "zeit_mehrdeutig";
    public static final String ZEIT_NICHT_VORHANDEN = "zeit_nicht_vorhanden";
    public static final String ZAHL_UNLESBAR = "zahl_unlesbar";
    public static final String DATUM_UNLESBAR = "datum_unlesbar";
    public static final String WERT_NEGATIV = "wert_negativ";
    public static final String WERT_UNPLAUSIBEL = "wert_unplausibel";
    public static final String KEINE_DATENZEILEN = "keine_datenzeilen";

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

    private static final DateTimeFormatter OFFSET_FORM =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT);

    private static final DateTimeFormatter UHR = DateTimeFormatter.ofPattern("HH:mm", Locale.GERMANY);

    /** Die deutschen Monatsnamen, wie eine Datumsspalte sie tragen kann („Oktober 2026“). */
    private static final List<String> MONATSNAMEN = List.of(
            "januar", "februar", "märz", "april", "mai", "juni",
            "juli", "august", "september", "oktober", "november", "dezember");

    // ------------------------------------------------------------------------- Die Ergebnisse

    /** U4/U5: der gelesene Betrag oder der Befund, warum er nicht lesbar ist. */
    public record Zahl(BigDecimal betrag, String befund) {}

    /** U1–U3: der Betrag in der Einheit der Bezugsgröße; {@code null} heißt „abgelehnt“. */
    public record Einheitswert(BigDecimal betrag, String einheit, List<String> befunde) {}

    /**
     * U1: eine erlaubte Umrechnung, wie sie im Vertrag steht. Sie gilt in BEIDE Richtungen — t →
     * kg ist kg → t mit umgekehrtem Vorzeichen des Zehnerschritts. Entweder {@code zehnerpotenz}
     * (exakt) oder {@code teiler} mit {@code nachkommastellen}; nie ein geschätzter Faktor.
     */
    public record Umrechnung(String von, String nach, Integer zehnerpotenz, Integer teiler, Integer nachkommastellen) {}

    /** Z1–Z4: die gedeutete Periode mit ihren Grenzen, oder ein Befund. */
    public record Periodendeutung(String schluessel, Instant von, Instant bis, Long stunden, String befund) {}

    /** Z5: der gedeutete Zeitpunkt; bei {@code zeit_mehrdeutig} stehen BEIDE Möglichkeiten in {@code varianten}. */
    public record Zeitdeutung(Instant zeitpunkt, String befund, List<String> varianten) {}

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

    /** E17: der Wert je Periode am Stichtag — und wie weit ein Eintrag zurückwirkt. */
    public record Stammdatenstand(
            Map<String, BigDecimal> jePeriode,
            Map<String, LocalDate> stichtage,
            long rueckwirkendTage,
            List<Ereignis> ereignisse) {}

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

    /** ISO-8601 mit Offset → Zeitpunkt. Dieselbe Deutung wie in der Verbrauchsregel. */
    public static Instant zeit(String iso) {
        return VerbrauchRegeln.zeit(iso);
    }

    /** Ein Zeitpunkt als ISO-8601 mit dem Offset, den die Zeitzone an diesem Zeitpunkt trägt. */
    public static String iso(Instant t, ZoneId zone) {
        return OFFSET_FORM.format(t.atZone(zone));
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
     * <p>Keine gelieferte Einheit heißt: die Einheit der Bezugsgröße gilt (U3). Eine Einheit
     * außerhalb des Vokabulars der ZIEL-Größe ist {@code einheit_unbekannt} und die Zeile wird
     * nicht übernommen (U2) — es wird nie ein Faktor geraten und nie über Größen hinweg
     * gerechnet. Innerhalb derselben Größe gilt genau der Faktor aus {@code umrechnung}, in
     * beiden Richtungen; das Ergebnis trägt {@code einheit_umgerechnet}.
     *
     * @param einheiten das Vokabular je Größe, wie es im Vertrag steht
     * @param umrechnungen die erlaubten Umrechnungen, wie sie im Vertrag stehen
     */
    public static Einheitswert einheit(
            BigDecimal betrag,
            String geliefert,
            String ziel,
            Map<String, List<String>> einheiten,
            List<Umrechnung> umrechnungen) {
        if (geliefert == null || geliefert.equals(ziel)) {
            return new Einheitswert(betrag, ziel, List.of());
        }
        String groesse = groesseVon(ziel, einheiten);
        if (groesse == null || !einheiten.get(groesse).contains(geliefert)) {
            return new Einheitswert(null, ziel, List.of(EINHEIT_UNBEKANNT));
        }
        for (Umrechnung u : umrechnungen) {
            boolean hin = geliefert.equals(u.von()) && ziel.equals(u.nach());
            boolean zurueck = ziel.equals(u.von()) && geliefert.equals(u.nach());
            if (hin || zurueck) {
                return new Einheitswert(rechne(betrag, u, hin), ziel, List.of(EINHEIT_UMGERECHNET));
            }
        }
        // Gleiche Größe, aber kein Faktor im Vertrag: das ist keine Umrechnung, das wäre eine
        // Annahme. Sie wird abgelehnt wie ein unbekanntes Wort.
        return new Einheitswert(null, ziel, List.of(EINHEIT_UNBEKANNT));
    }

    private static BigDecimal rechne(BigDecimal betrag, Umrechnung u, boolean hin) {
        if (u.zehnerpotenz() != null) {
            return betrag.scaleByPowerOfTen(hin ? u.zehnerpotenz() : -u.zehnerpotenz()).stripTrailingZeros();
        }
        BigDecimal teiler = BigDecimal.valueOf(u.teiler());
        return hin
                ? betrag.divide(teiler, u.nachkommastellen(), RoundingMode.HALF_UP).stripTrailingZeros()
                : betrag.multiply(teiler).stripTrailingZeros();
    }

    private static String groesseVon(String einheit, Map<String, List<String>> einheiten) {
        for (Map.Entry<String, List<String>> e : einheiten.entrySet()) {
            if (e.getValue().contains(einheit)) {
                return e.getKey();
            }
        }
        return null;
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
     * <p>Die Deutung steht in der Zuordnungs-Vorlage (Z3) und wird nie geraten. Ein gelieferter
     * Zeitraum, der keine Periode dieser Bezugsgröße ist, ist {@code periode_passt_nicht} — er
     * wird nie geteilt, verteilt oder nach Mehrheit zugeordnet (Z2, §7 B11). Eine Periode, deren
     * Ende hinter {@code jetzt} liegt, ist {@code periode_nicht_zu_ende} (Z4, E16).
     *
     * <p>Die Stundenzahl der Periode kommt aus {@link VerbrauchRegeln#stunden} — am
     * Umstellungstag 23 oder 25.
     */
    public static Periodendeutung periode(
            String text,
            String vonText,
            String bisText,
            String deutung,
            String periodeArt,
            ZoneId zone,
            Instant jetzt) {
        LocalDate[] spanne;
        String schluessel;
        switch (deutung) {
            case "periode" -> {
                schluessel = periodenschluessel(text, periodeArt);
                if (schluessel == null) {
                    return befundPeriode(PERIODE_PASST_NICHT);
                }
                spanne = spanneVon(schluessel, periodeArt);
            }
            case "periodenbeginn", "periodenende" -> {
                LocalDate tag = tag(text);
                if (tag == null) {
                    return befundPeriode(DATUM_UNLESBAR);
                }
                spanne = spanneUm(tag, periodeArt);
                LocalDate soll = "periodenbeginn".equals(deutung) ? spanne[0] : spanne[1];
                if (!tag.equals(soll)) {
                    return befundPeriode(PERIODE_PASST_NICHT);
                }
                schluessel = schluesselVon(spanne[0], periodeArt);
            }
            case "von_bis" -> {
                LocalDate von = tag(vonText);
                LocalDate bis = tag(bisText);
                if (von == null || bis == null) {
                    return befundPeriode(DATUM_UNLESBAR);
                }
                spanne = spanneUm(von, periodeArt);
                if (!von.equals(spanne[0]) || !bis.equals(spanne[1])) {
                    return befundPeriode(PERIODE_PASST_NICHT);
                }
                schluessel = schluesselVon(spanne[0], periodeArt);
            }
            default -> {
                return befundPeriode(PERIODE_PASST_NICHT);
            }
        }

        Instant von = spanne[0].atStartOfDay(zone).toInstant();
        Instant bis = spanne[1].plusDays(1).atStartOfDay(zone).toInstant();
        if (jetzt != null && bis.isAfter(jetzt)) {
            return befundPeriode(PERIODE_NICHT_ZU_ENDE);
        }
        return new Periodendeutung(schluessel, von, bis, VerbrauchRegeln.stunden(von, bis), null);
    }

    private static Periodendeutung befundPeriode(String befund) {
        return new Periodendeutung(null, null, null, null, befund);
    }

    /** Z3: nennt der Text GENAU eine Periode der gefragten Art? Sonst {@code null}. */
    private static String periodenschluessel(String text, String periodeArt) {
        if (text == null) {
            return null;
        }
        String s = text.trim();
        switch (periodeArt) {
            case "monat" -> {
                if (s.matches("[0-9]{4}-[0-9]{2}")) {
                    return monatsschluessel(Integer.parseInt(s.substring(0, 4)), Integer.parseInt(s.substring(5)));
                }
                if (s.matches("[0-9]{1,2}[/.][0-9]{4}")) {
                    String[] t = s.split("[/.]");
                    return monatsschluessel(Integer.parseInt(t[1]), Integer.parseInt(t[0]));
                }
                String[] wort = s.split("\\s+");
                if (wort.length == 2 && wort[1].matches("[0-9]{4}")) {
                    int m = MONATSNAMEN.indexOf(wort[0].toLowerCase(Locale.GERMANY)) + 1;
                    return m == 0 ? null : monatsschluessel(Integer.parseInt(wort[1]), m);
                }
                return null;
            }
            case "woche" -> {
                return s.matches("[0-9]{4}-W[0-9]{2}") ? s : null;
            }
            case "jahr" -> {
                return s.matches("[0-9]{4}") ? s : null;
            }
            case "tag" -> {
                LocalDate t = tag(s);
                return t == null ? null : t.toString();
            }
            default -> {
                return null;
            }
        }
    }

    private static String monatsschluessel(int jahr, int monat) {
        return monat < 1 || monat > 12 ? null : String.format(Locale.ROOT, "%04d-%02d", jahr, monat);
    }

    /** Die Spanne (erster und LETZTER Tag) einer Periode aus ihrem Schlüssel. */
    private static LocalDate[] spanneVon(String schluessel, String periodeArt) {
        switch (periodeArt) {
            case "monat" -> {
                LocalDate ab = LocalDate.parse(schluessel + "-01");
                return new LocalDate[] {ab, ab.withDayOfMonth(ab.lengthOfMonth())};
            }
            case "woche" -> {
                int jahr = Integer.parseInt(schluessel.substring(0, 4));
                int woche = Integer.parseInt(schluessel.substring(6));
                LocalDate ab = LocalDate.of(jahr, 1, 4)
                        .with(IsoFields.WEEK_BASED_YEAR, jahr)
                        .with(IsoFields.WEEK_OF_WEEK_BASED_YEAR, woche)
                        .with(java.time.DayOfWeek.MONDAY);
                return new LocalDate[] {ab, ab.plusDays(6)};
            }
            case "jahr" -> {
                LocalDate ab = LocalDate.of(Integer.parseInt(schluessel), 1, 1);
                return new LocalDate[] {ab, ab.withDayOfYear(ab.lengthOfYear())};
            }
            default -> {
                LocalDate ab = LocalDate.parse(schluessel);
                return new LocalDate[] {ab, ab};
            }
        }
    }

    /** Die Spanne der Periode, in der ein Tag liegt. */
    private static LocalDate[] spanneUm(LocalDate tag, String periodeArt) {
        return spanneVon(schluesselVon(tag, periodeArt), periodeArt);
    }

    private static String schluesselVon(LocalDate tag, String periodeArt) {
        return switch (periodeArt) {
            case "monat" -> String.format(Locale.ROOT, "%04d-%02d", tag.getYear(), tag.getMonthValue());
            case "woche" -> String.format(
                    Locale.ROOT,
                    "%04d-W%02d",
                    tag.get(IsoFields.WEEK_BASED_YEAR),
                    tag.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR));
            case "jahr" -> String.valueOf(tag.getYear());
            default -> tag.toString();
        };
    }

    private static LocalDate tag(String text) {
        if (text == null) {
            return null;
        }
        String s = text.trim();
        try {
            if (s.matches("[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4}")) {
                String[] t = s.split("\\.");
                return LocalDate.of(Integer.parseInt(t[2]), Integer.parseInt(t[1]), Integer.parseInt(t[0]));
            }
            return LocalDate.parse(s);
        } catch (java.time.DateTimeException e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ Z5 — der Zeitstempel

    /**
     * Z5/E7 — ein Zeitstempel ohne Zone bekommt die Zeitzone des Standorts.
     *
     * <p>Ein Offset in der Datei gewinnt immer. Ohne Zone gilt: in der doppelten Stunde am
     * Sommerzeit-Ende ist die Ortszeit {@code zeit_mehrdeutig} (beide Möglichkeiten stehen in
     * {@code varianten} — die Regel wählt keine), in der fehlenden Stunde am Sommerzeit-Beginn
     * {@code zeit_nicht_vorhanden}. Beides wird abgelehnt, nie geraten (§7 B10).
     */
    public static Zeitdeutung zeitpunkt(String text, ZoneId zone, String offsetInDatei) {
        LocalDateTime ort = ortszeit(text);
        if (ort == null) {
            return new Zeitdeutung(null, DATUM_UNLESBAR, List.of());
        }
        if (offsetInDatei != null) {
            return new Zeitdeutung(ort.toInstant(ZoneOffset.of(offsetInDatei)), null, List.of());
        }
        List<ZoneOffset> moeglich = zone.getRules().getValidOffsets(ort);
        if (moeglich.isEmpty()) {
            return new Zeitdeutung(null, ZEIT_NICHT_VORHANDEN, List.of());
        }
        if (moeglich.size() > 1) {
            List<String> varianten = new ArrayList<>();
            for (ZoneOffset o : moeglich) {
                varianten.add(OFFSET_FORM.format(ort.atOffset(o)));
            }
            return new Zeitdeutung(null, ZEIT_MEHRDEUTIG, List.copyOf(varianten));
        }
        return new Zeitdeutung(ZonedDateTime.of(ort, zone).toInstant(), null, List.of());
    }

    private static LocalDateTime ortszeit(String text) {
        if (text == null) {
            return null;
        }
        String s = text.trim();
        try {
            if (s.matches("[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4} [0-9]{1,2}:[0-9]{2}")) {
                String[] teile = s.split(" ");
                LocalDate d = tag(teile[0]);
                String[] uhr = teile[1].split(":");
                return d == null
                        ? null
                        : LocalDateTime.of(d, LocalTime.of(Integer.parseInt(uhr[0]), Integer.parseInt(uhr[1])));
            }
            return LocalDateTime.parse(s);
        } catch (java.time.DateTimeException e) {
            return null;
        }
    }

    /** P3 — die Länge eines Kalendertages in Stunden. Sie kommt aus der Verbrauchsregel AP-08. */
    public static long stundenDesTages(LocalDate tag, ZoneId zone) {
        return VerbrauchRegeln.stunden(
                tag.atStartOfDay(zone).toInstant(), tag.plusDays(1).atStartOfDay(zone).toInstant());
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
     */
    public static Stammdatenstand stammdatum(List<Intervall> intervalle, List<String> perioden, String periodeArt) {
        Map<String, BigDecimal> jePeriode = new LinkedHashMap<>();
        Map<String, LocalDate> stichtage = new LinkedHashMap<>();
        for (String p : perioden) {
            LocalDate stichtag = spanneVon(p, periodeArt)[1];
            stichtage.put(p, stichtag);
            BigDecimal betrag = null;
            for (Intervall i : intervalle) {
                boolean ab = !stichtag.isBefore(i.gueltigAb());
                boolean bis = i.gueltigBis() == null || !stichtag.isAfter(i.gueltigBis());
                if (ab && bis) {
                    betrag = i.betrag();
                    break;
                }
            }
            jePeriode.put(p, betrag);
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
                List.of());
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
     */
    public static VerbrauchRegeln.Ergebnis mengeAblesezeitraum(
            List<VerbrauchRegeln.Rohwert> staende, Instant von, Instant bis, Duration kadenz) {
        return VerbrauchRegeln.mengeZaehlerstand(
                staende, von, bis, kadenz, List.of(), BigDecimal.ONE, null, null);
    }

    /** Der Kundensatz eines Befunds aus dem Vertrag — das Portal erfindet keinen zweiten. */
    public static String satz(String befund, Map<String, String> saetze) {
        return Objects.requireNonNull(saetze.get(befund), "kein Kundensatz für " + befund);
    }
}
