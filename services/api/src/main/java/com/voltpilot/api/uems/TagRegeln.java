package com.voltpilot.api.uems;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

/**
 * Die REINEN Regeln der ENDGÜLTIGKEIT und der TAGESKLASSE (UEMS AP-07 IP-13, Captain-Entscheid E5
 * vom 10.09.2026, Widerspruch W10).
 *
 * <p><b>Rein.</b> Kein Spring, keine Datenbank, keine Uhr — was gilt, entscheidet sich hier; wer
 * es liest und schreibt, steht in {@link EndgueltigkeitLauf}, {@link TagVerdichter} und
 * {@link SpaetankunftMelder}.
 *
 * <p><b>Die drei Sätze dieses Pakets.</b>
 *
 * <ol>
 *   <li><b>Die Frist gehört dem INTERVALL, nicht der Zeile.</b> Ein Intervall ist geschlossen,
 *       sobald {@link ViertelstundeRegeln#endgueltigAb} vorbei ist — ganz gleich, ob der
 *       Stundenlauf seine Zeile schon umgeschaltet hat und ob es überhaupt eine Zeile gibt. Sonst
 *       hinge das Verhalten daran, WANN ein Hintergrund-Lauf zuletzt lief, und ein Nachzügler für
 *       eine Lücke (die keine Zeile hat, IP-12) könnte einen Zeitraum nachträglich füllen, den ein
 *       Bericht längst als abgeschlossen ausgewiesen hat.
 *   <li><b>Speichern, melden, vorschlagen — nicht anwenden.</b> Ein Rohwert für ein geschlossenes
 *       Intervall bleibt gespeichert (die Rohtabelle wird nie geändert), wird als
 *       {@code late_arrival} gemeldet und landet in der Korrektur-Liste. Der endgültige Wert
 *       bleibt Zeichen für Zeichen stehen; die versionierte Korrektur daraus macht AP-08.
 *   <li><b>Ein Tag hat nicht 24 Stunden.</b> Die Tagesgrenze liegt in der ZEITZONE DES STANDORTS
 *       (W10), und an den Umstellungstagen hat ein Tag 23 oder 25 Stunden — also 92 oder 100
 *       Viertelstunden statt 96. Gezählt wird das NICHT hier: {@link #stunden} bestellt die Zahl
 *       bei {@link BezugsPeriode#stundenDesTages}, das sie seinerseits bei
 *       {@link VerbrauchRegeln#stunden} bestellt. Zwei Zählungen derselben Stunden wären zwei
 *       Zahlen für dieselbe Aussage.
 * </ol>
 *
 * <p><b>Was hier NICHT steht: eine Menge.</b> Die Tagesklasse trägt Fakten — Stände, Abdeckung,
 * Qualitätszähler, Anker, Zustand. Die Tages- und Monatsmengen bildet AP-08 IP-5 aus den
 * PERIODENSTÄNDEN, nicht als Summe der Viertelstunden.
 */
public final class TagRegeln {

    private TagRegeln() {}

    /** E5, für den Tag: endgültig ab 7 Tage nach TAGESENDE. Dieselbe Frist wie das Intervall. */
    public static final Duration FRIST = ViertelstundeRegeln.FRIST;

    /** Die Vorgabe-Zeitzone, wenn weder Standort noch Unternehmen eine nennen (§4.5 Nr. 1). */
    public static final String VORGABE_ZONE = "Europe/Berlin";

    /**
     * Die Zeitzonen, die {@code standort} und {@code unternehmen} zulassen (V20260911100000).
     *
     * <p><b>⚠ Sie tragen alle drei denselben Versatz und dieselbe Umstellungsregel</b> (MEZ/MESZ).
     * Darum ist der Kalendertag eines Zeitpunkts heute in allen dreien derselbe — und die Frage,
     * WELCHE der drei gilt, kann die Tagesgrenze nicht verschieben. Gespeichert wird sie trotzdem
     * (W10): erst dann reproduziert ein Bericht in zehn Jahren dieselbe Grenze, auch wenn einmal
     * eine vierte Zone dazukommt.
     */
    public static final List<String> ZONEN =
            List.of("Europe/Berlin", "Europe/Vienna", "Europe/Zurich");

    /** Woher die Zeitzone kam — eine Zeitzone ohne Herkunft wäre eine Behauptung. */
    public static final String AUS_STANDORT = "standort";
    public static final String AUS_UNTERNEHMEN = "unternehmen";
    public static final String AUS_VORGABE = "vorgabe";

    // ------------------------------------------------------------------- Zeitzone

    /**
     * Die Zone zu ihrem Namen — ein Name außerhalb von {@link #ZONEN} wird VERWORFEN, nie
     * aufgelöst: die Datenbank ließe ihn ohnehin nicht in die Zeile.
     */
    public static ZoneId zone(String name) {
        if (!ZONEN.contains(name)) {
            throw new IllegalArgumentException("keine zugelassene Zeitzone: " + name);
        }
        return ZoneId.of(name);
    }

    // ---------------------------------------------------------------- Die Tagesgrenze

    /** Der Kalendertag, in dem {@code t} in dieser Zone liegt. */
    public static LocalDate tag(Instant t, ZoneId zone) {
        return t.atZone(zone).toLocalDate();
    }

    /** Der Beginn des Tages: 00:00 Ortszeit. */
    public static Instant beginn(LocalDate tag, ZoneId zone) {
        return tag.atStartOfDay(zone).toInstant();
    }

    /** Das Ende des Tages: 00:00 Ortszeit des Folgetages — zugleich sein Beginn (halboffen). */
    public static Instant ende(LocalDate tag, ZoneId zone) {
        return tag.plusDays(1).atStartOfDay(zone).toInstant();
    }

    /**
     * Die Länge des Tages in Stunden: 23 · 24 · 25. <b>Nicht hier gezählt</b> — bestellt bei
     * {@link BezugsPeriode#stundenDesTages}, das die Zahl bei {@link VerbrauchRegeln#stunden}
     * bestellt (AP-08 IP-1, die Verbrauchsregel aus PR 693, als Modul verfügbar seit PR 697).
     */
    public static int stunden(LocalDate tag, ZoneId zone) {
        return (int) BezugsPeriode.stundenDesTages(tag, zone);
    }

    /** Vier Slots je Stunde — 92 am 28.03.2027, 96 sonst, 100 am 25.10.2026. */
    public static int slotsErwartet(int stunden) {
        return stunden * 4;
    }

    /** E5 für den Tag: 7 Tage nach dem Tagesende. */
    public static Instant endgueltigAb(Instant ende) {
        return ende.plus(FRIST);
    }

    /**
     * Die Kalendertage, die ein UTC-Tag in dieser Zone berührt — einer oder zwei, nie mehr.
     *
     * <p>Der Tageslauf findet seine Arbeit über die Viertelstunden, und die stehen im
     * UTC-Raster. Er gruppiert sie darum auf den UTC-Tag (das kann die Datenbank, ohne eine Zone
     * zu kennen) und fragt hier, welche ORTSTAGE davon betroffen sind. Für jeden Versatz kleiner
     * als 24 Stunden sind das höchstens zwei.
     */
    public static List<LocalDate> ortstageEinesUtcTages(LocalDate utcTag, ZoneId zone) {
        Instant von = utcTag.atStartOfDay(ZoneId.of("UTC")).toInstant();
        Instant bis = von.plus(Duration.ofDays(1)).minusNanos(1);
        LocalDate erster = tag(von, zone);
        LocalDate letzter = tag(bis, zone);
        return erster.equals(letzter) ? List.of(erster) : List.of(erster, letzter);
    }

    // ------------------------------------------------------------------- Zustand

    /**
     * Ist das INTERVALL geschlossen? — der eine Satz, an dem die Spätankunft hängt.
     *
     * <p>Er fragt die Uhr und die Frist, nie eine Zeile: eine Lücke hat gar keine Zeile (IP-12),
     * und der Stundenlauf schreibt nur nieder, was ohnehin schon gilt.
     */
    public static boolean geschlossen(Instant intervallBeginn, Instant jetzt) {
        return !ViertelstundeRegeln.endgueltigAb(intervallBeginn).isAfter(jetzt);
    }

    /**
     * Ist der TAG endgültig? Beides muss gelten:
     *
     * <ul>
     *   <li>jede VORHANDENE Viertelstunde ist endgültig — §4.3 „endgültig, wenn alle 96
     *       Viertelstundenwerte endgültig sind";
     *   <li>und die Frist des Tages ist abgelaufen. Das ist der Zusatz, den §4.3 braucht, weil
     *       eine fehlende Viertelstunde gar keine Zeile hat: erst wenn auch die LETZTE
     *       Viertelstunde des Tages ihre sieben Tage hinter sich hat, kann keine mehr entstehen.
     * </ul>
     */
    public static String zustand(int slotsVorhanden, int slotsEndgueltig, Instant endgueltigAb,
            Instant jetzt) {
        return slotsVorhanden > 0 && slotsEndgueltig == slotsVorhanden
                        && !endgueltigAb.isAfter(jetzt)
                ? ViertelstundeRegeln.ENDGUELTIG
                : ViertelstundeRegeln.VORLAEUFIG;
    }
}
