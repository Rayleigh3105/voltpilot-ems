package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.IsoFields;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Die PERIODEN und ZEITPUNKTE der Bezugsdaten als eigenes, reines Modul (UEMS AP-09 §4.4 Z1–Z5,
 * IP-3).
 *
 * <p>Der Vertrag steht in {@code docs/contracts/v2/bezugsdaten-vectors.json} (Familien
 * {@code periode}, {@code zeit}, {@code stunden}); der TS-Zwilling ist
 * {@code frontend/portal/src/bezugsPeriode.ts}. Wer eine Regel ändert, ändert die Vektor-Datei
 * UND beide Zwillinge.
 *
 * <p><b>Warum ein eigenes Modul:</b> Import, Eingabe, Kennzahlen und Berichte deuten dieselbe
 * Datumsspalte. Sie wird deshalb EINMAL hier gedeutet; {@link BezugsdatenRegeln} ruft das auf.
 *
 * <p><b>Die Zeitzone ist die des Standorts (E7, Z1/Z5).</b> Ein Zeitstempel ohne Zone wird in der
 * Zeitzone des Standorts gelesen — eine Vorlage darf davon abweichen, ein Offset in der Datei
 * gewinnt immer. Deshalb wird die Zone hier IMMER übergeben und nie aus der Maschine gelesen.
 *
 * <p><b>Die drei Fallen, an denen dieses Modul richtig oder falsch wird:</b>
 *
 * <ol>
 *   <li><b>Ein Tag hat nicht 24 Stunden.</b> An den Umstellungstagen 23 oder 25 (25.10.2026: 25 h,
 *       28.03.2027: 23 h). Die Stundenzahl wird deshalb nicht gerechnet, sondern bei der
 *       Verbrauchsregel AP-08 ({@link VerbrauchRegeln#stunden}) BESTELLT — eine zweite Zählung
 *       wäre genau die Drift, die diese Verträge verhindern sollen.
 *   <li><b>Ein mehrdeutiger oder nicht existierender Zeitpunkt ist ein BEFUND.</b> Am
 *       Rückstellungstag gibt es „02:30“ zweimal ({@link #ZEIT_MEHRDEUTIG}, BEIDE Möglichkeiten
 *       reisen mit), am Vorstellungstag gar nicht ({@link #ZEIT_NICHT_VORHANDEN}). Nie wird eine
 *       der beiden still gewählt und nie auf 03:30 verschoben.
 *   <li><b>„Passt nicht“ ist etwas anderes als „noch nicht zu Ende“.</b> Eine Kalenderwoche über
 *       eine Monatsgrenze ist {@link #PERIODE_PASST_NICHT} — sie wird NIE geteilt, verteilt oder
 *       nach Mehrheit zugeordnet (Z2, §7 B11). Der laufende Monat ist
 *       {@link #PERIODE_NICHT_ZU_ENDE} (Z4/E16): nichts ist falsch an ihm, er ist nur noch nicht
 *       fertig. Zwei Befunde, zwei Kundensätze, zwei verschiedene nächste Schritte.
 * </ol>
 *
 * <p><b>Rein:</b> ohne Spring, ohne Datenbank, ohne Netz und <b>ohne Uhr</b> — „jetzt“ wird
 * übergeben.
 */
public final class BezugsPeriode {

    private BezugsPeriode() {}

    /** Z2: der gelieferte Zeitraum ist keine Periode dieser Bezugsgröße — er wird nie geteilt. */
    public static final String PERIODE_PASST_NICHT = "periode_passt_nicht";

    /** Z4/E16: die Periode läuft noch; Werte nehmen nur ABGESCHLOSSENE Perioden an. */
    public static final String PERIODE_NICHT_ZU_ENDE = "periode_nicht_zu_ende";

    /** Z5: die zonenlose Ortszeit liegt in der doppelten Stunde am Sommerzeit-Ende. */
    public static final String ZEIT_MEHRDEUTIG = "zeit_mehrdeutig";

    /** Z5: die zonenlose Ortszeit liegt in der fehlenden Stunde am Sommerzeit-Beginn. */
    public static final String ZEIT_NICHT_VORHANDEN = "zeit_nicht_vorhanden";

    /** Z3: der Text ist kein Datum — nie wird eines geraten. */
    public static final String DATUM_UNLESBAR = "datum_unlesbar";

    /**
     * Die Kundensätze der Befunde dieses Moduls — hier, nicht in der Fläche: EINE Formulierung,
     * nicht zwei. {@code BezugsPeriodeTest} prüft sie Wort für Wort gegen {@code befund_saetze}
     * der Vektor-Datei.
     */
    public static final Map<String, String> SAETZE = Map.of(
            PERIODE_PASST_NICHT, "Der gelieferte Zeitraum ist keine Periode dieser Bezugsgröße.",
            PERIODE_NICHT_ZU_ENDE, "Diese Periode ist noch nicht zu Ende.",
            ZEIT_MEHRDEUTIG,
                    "Diesen Zeitpunkt gibt es an diesem Tag zweimal (Zeitumstellung). Geben Sie die Zone an.",
            ZEIT_NICHT_VORHANDEN, "Diesen Zeitpunkt gibt es an diesem Tag nicht (Zeitumstellung).",
            DATUM_UNLESBAR, "Dieses Datum ist nicht lesbar.");

    private static final DateTimeFormatter OFFSET_FORM =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT);

    private static final List<String> MONATSNAMEN = List.of(
            "januar", "februar", "märz", "april", "mai", "juni",
            "juli", "august", "september", "oktober", "november", "dezember");

    /** Z1–Z4: die gedeutete Periode mit ihren Grenzen, oder ein Befund. */
    public record Periodendeutung(String schluessel, Instant von, Instant bis, Long stunden, String befund) {}

    /** Z5: der gedeutete Zeitpunkt; bei {@link #ZEIT_MEHRDEUTIG} stehen BEIDE Möglichkeiten in {@code varianten}. */
    public record Zeitdeutung(Instant zeitpunkt, String befund, List<String> varianten) {}

    // -------------------------------------------------------------------- Z1–Z4 — die Periode

    /**
     * Z1–Z4 — eine Datumsspalte wird die Periode, für die der Wert gilt.
     *
     * <p>Die Deutung steht in der Zuordnungs-Vorlage (Z3) und wird nie geraten. Ein gelieferter
     * Zeitraum, der keine Periode dieser Bezugsgröße ist, ist {@link #PERIODE_PASST_NICHT} — er
     * wird nie geteilt, verteilt oder nach Mehrheit zugeordnet (Z2, §7 B11). Eine Periode, deren
     * Ende hinter {@code jetzt} liegt, ist {@link #PERIODE_NICHT_ZU_ENDE} (Z4, E16).
     *
     * <p>Die Stundenzahl der Periode kommt aus {@link VerbrauchRegeln#stunden} — am
     * Umstellungstag 23 oder 25, und ein Oktober mit Rückstellung hat 745 statt 744 Stunden.
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
                    return befund(PERIODE_PASST_NICHT);
                }
                spanne = spanneVon(schluessel, periodeArt);
            }
            case "periodenbeginn", "periodenende" -> {
                LocalDate tag = tag(text);
                if (tag == null) {
                    return befund(DATUM_UNLESBAR);
                }
                spanne = spanneUm(tag, periodeArt);
                LocalDate soll = "periodenbeginn".equals(deutung) ? spanne[0] : spanne[1];
                if (!tag.equals(soll)) {
                    return befund(PERIODE_PASST_NICHT);
                }
                schluessel = schluesselVon(spanne[0], periodeArt);
            }
            case "von_bis" -> {
                LocalDate von = tag(vonText);
                LocalDate bis = tag(bisText);
                if (von == null || bis == null) {
                    return befund(DATUM_UNLESBAR);
                }
                spanne = spanneUm(von, periodeArt);
                if (!von.equals(spanne[0]) || !bis.equals(spanne[1])) {
                    return befund(PERIODE_PASST_NICHT);
                }
                schluessel = schluesselVon(spanne[0], periodeArt);
            }
            default -> {
                return befund(PERIODE_PASST_NICHT);
            }
        }

        Instant von = spanne[0].atStartOfDay(zone).toInstant();
        Instant bis = spanne[1].plusDays(1).atStartOfDay(zone).toInstant();
        if (jetzt != null && bis.isAfter(jetzt)) {
            return befund(PERIODE_NICHT_ZU_ENDE);
        }
        return new Periodendeutung(schluessel, von, bis, VerbrauchRegeln.stunden(von, bis), null);
    }

    private static Periodendeutung befund(String befund) {
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
    public static LocalDate[] spanneVon(String schluessel, String periodeArt) {
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
    public static LocalDate[] spanneUm(LocalDate tag, String periodeArt) {
        return spanneVon(schluesselVon(tag, periodeArt), periodeArt);
    }

    /** Der Schlüssel der Periode, in der ein Kalendertag liegt. */
    public static String schluesselVon(LocalDate tag, String periodeArt) {
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

    /** Ein Tagesdatum, deutsch (`31.10.2026`) oder ISO (`2026-10-31`) — sonst {@code null}. */
    public static LocalDate tag(String text) {
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
     * Sommerzeit-Ende ist die Ortszeit {@link #ZEIT_MEHRDEUTIG} (beide Möglichkeiten stehen in
     * {@code varianten} — die Regel wählt keine), in der fehlenden Stunde am Sommerzeit-Beginn
     * {@link #ZEIT_NICHT_VORHANDEN}. Beides wird abgelehnt, nie geraten (§7 B10).
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

    /** ISO-8601 mit Offset → Zeitpunkt. Dieselbe Deutung wie in der Verbrauchsregel. */
    public static Instant zeit(String iso) {
        return VerbrauchRegeln.zeit(iso);
    }

    /** Ein Zeitpunkt als ISO-8601 mit dem Offset, den die Zeitzone an diesem Zeitpunkt trägt. */
    public static String iso(Instant t, ZoneId zone) {
        return OFFSET_FORM.format(t.atZone(zone));
    }

    /**
     * P3 — die Länge eines Kalendertages in Stunden: am Umstellungstag 23 oder 25.
     *
     * <p>Sie wird NICHT hier gezählt: sie kommt aus {@link VerbrauchRegeln#stunden} (AP-08 IP-1).
     * Zwei Zählungen derselben Stunden wären zwei Zahlen für dieselbe Aussage.
     */
    public static long stundenDesTages(LocalDate tag, ZoneId zone) {
        return VerbrauchRegeln.stunden(
                tag.atStartOfDay(zone).toInstant(), tag.plusDays(1).atStartOfDay(zone).toInstant());
    }

    /** Der Kundensatz eines Befunds dieses Moduls — die Fläche erfindet keinen zweiten. */
    public static String satz(String befund) {
        return Objects.requireNonNull(SAETZE.get(befund), "kein Kundensatz für " + befund);
    }
}
