package com.voltpilot.api.werkstatt;

import com.voltpilot.api.fernwartung.Akteur;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Die Regel „nachts von selbst" (Konzept vp-update-vor-zuordnung, Entscheid des Captains 18.11.2026: E3 = B, §11.2;
 * Ausbaustufe S4) - rein, ohne DB, ohne Uhr aus der Umgebung (das Muster von {@code ota.Erstverbindung}).
 *
 * <p><b>Die Regel:</b> Jede Nacht bekommt jede Edge-Light-Box ohne Kundenkonto, die im Wartungstunnel verbunden ist,
 * nach Schlüsseln fragt und älter läuft als die neueste zuweisbare Fassung, denselben Fernlauf wie mit dem Knopf
 * ({@link FernlaufService#aufspielen}, unverändert), mit dem Akteur {@link #AKTEUR}. Was „möglich" heißt, sagt die
 * Vorprüfung des Knopfs ({@link FernlaufRegel#vorpruefen}); diese Regel legt nur fest, wann und wem.
 *
 * <ul>
 *   <li><b>Nachtfenster:</b> ein Auftrag beginnt nur zwischen {@link #BEGINN} und {@link #ENDE} Berliner Zeit
 *       (Sommer- wie Winterzeit); ein Lauf, der vor {@link #ENDE} beginnt, läuft zu Ende.</li>
 *   <li><b>Einer nach dem anderen:</b> je Takt höchstens ein Auftrag, und keiner, solange irgendein Fernlauf offen
 *       ist (auch einer von Hand) - der Werkstatt-Dienst fährt ohnehin einen zur Zeit.</li>
 *   <li><b>Kein Drängeln:</b> wurde der letzte Lauf einer Box mit der neuesten Fassung zurückgenommen oder blieb er
 *       offen, versucht die Automatik diese Fassung an dieser Box nicht noch einmal; eine neuere Fassung oder
 *       „Noch einmal" von Hand gibt sie wieder frei. Jede Box höchstens einmal je Nacht.</li>
 *   <li><b>Halt nach einem Fehlschlag:</b> wurde in dieser Nacht ein Lauf (nachts oder von Hand) mit einer Fassung
 *       zurückgenommen oder blieb er offen, legt die Automatik für diese Fassung in dieser Nacht keinen weiteren
 *       Auftrag an - eine fehlerhafte Fassung trifft so höchstens eine wartende Box je Nacht.</li>
 *   <li><b>Obergrenze:</b> höchstens {@link #GRENZE} Nachtläufe je Nacht.</li>
 *   <li><b>Frische Rückmeldung:</b> ohne Meldung des Tunnel-Dienstes, die höchstens {@link #RUECKMELDUNG} alt ist,
 *       kein Auftrag (unbekannt ist kein „verbunden").</li>
 *   <li><b>Schalter:</b> ein Schalter des Betriebs, ab Werk an; aus bleibt nur der Knopf.</li>
 * </ul>
 */
public final class Nachtlauf {

    private Nachtlauf() {
    }

    /** Der Akteur am Fenster, am Auftrag und im Ergebnis (Journal-Name wie {@code Erstverbindung.URHEBER}). */
    public static final String URHEBER = "nachtlauf";
    /** So nennt ihn das Portal, das Fernwartungs-Protokoll und der Verlauf. */
    public static final String NAME = "Automatik · nachts";
    public static final Akteur AKTEUR = new Akteur(URHEBER, NAME);

    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    public static final LocalTime BEGINN = LocalTime.of(2, 0);
    public static final LocalTime ENDE = LocalTime.of(5, 0);
    /** Höchstens so viele Nachtläufe je Nacht (Muster Tagesgrenze der Werkstatt). */
    public static final int GRENZE = 20;
    /** So alt darf die Meldung des Tunnel-Dienstes zu der Box höchstens sein (wie beim Knopf). */
    public static final Duration RUECKMELDUNG = FernlaufRegel.RUECKMELDUNG;

    /** Ein Fernlauf, wie die Regel ihn sieht: Zustand zur Zeit des Takts ({@link FernlaufRegel#ZUSTAENDE}). */
    public record Lauf(String edgeRef, String fassungZiel, boolean nachts, String zustand, Instant erteiltAm) {
    }

    /**
     * Eine Box ohne Kundenkonto mit Tunnel-Zugang.
     *
     * @param vorpruefung    das Urteil der Vorprüfung des Knopfs zur Zeit des Takts
     * @param neueste        die neueste zuweisbare Fassung, {@code null} = keine
     * @param rueckmeldungAm wann die API die letzte Meldung des Tunnel-Dienstes zu ihr annahm, {@code null} = nie
     * @param verlauf        ihre letzten Fernläufe, neueste zuerst
     */
    public record Box(String edgeRef, FernlaufRegel.Urteil vorpruefung, String neueste, Instant rueckmeldungAm,
            List<Lauf> verlauf) {
    }

    /** Die Nacht, in der {@code jetzt} liegt, sonst die nächste: {@code [beginn, ende)}. */
    public record Nacht(Instant beginn, Instant ende) {

        public boolean enthaelt(Instant t) {
            return !t.isBefore(beginn) && t.isBefore(ende);
        }
    }

    /** Was ein Takt tut. */
    public enum Art {
        /** Der Schalter steht auf aus. */
        AUS,
        /** Außerhalb des Nachtfensters. */
        TAG,
        /** Ein Fernlauf ist offen: sein Ende abwarten. */
        WARTEN,
        /** Die Obergrenze dieser Nacht ist erreicht. */
        GRENZE,
        /** Keine Box ist dran. */
        NICHTS,
        /** Einen Auftrag anlegen: {@link Urteil#edgeRef()} auf {@link Urteil#fassung()}. */
        ANLEGEN
    }

    public record Urteil(Art art, String edgeRef, String fassung, String grund) {

        static Urteil nur(Art art, String grund) {
            return new Urteil(art, null, null, grund);
        }
    }

    /** Ob eine Box in der Nacht {@link #nacht(Instant)} dran ist, sonst warum nicht (ein Satz für den Admin). */
    public record Dran(boolean dran, String grund) {

        static Dran nein(String grund) {
            return new Dran(false, grund);
        }
    }

    public static final String GRUND_AUS = "Nachts von selbst ist angehalten; es bleibt der Knopf.";
    public static final String GRUND_GRENZE = "In dieser Nacht sind schon " + GRENZE + " Läufe angelegt "
            + "(Obergrenze); die übrigen Boxen kommen in der nächsten Nacht dran.";
    public static final String GRUND_RUECKMELDUNG = "Der Tunnel-Dienst hat zu dieser Box seit mehr als 3 Minuten "
            + "nichts gemeldet; ohne frische Rückmeldung kein Lauf.";
    public static final String GRUND_SCHON = "In dieser Nacht lief für diese Box schon ein Nachtlauf.";

    /** Liegt {@code t} im Nachtfenster? */
    public static boolean imFenster(Instant t) {
        return nacht(t).enthaelt(t);
    }

    /**
     * Die Nacht um {@code jetzt}: das Fenster dieses Berliner Tages, wenn {@code jetzt} vor seinem Ende liegt, sonst
     * das des nächsten Tages. Beide Grenzen über die Zeitzone, so gilt das Fenster in Sommer- und Winterzeit
     * (beide Umstellungen liegen bei 02:00/03:00 im Fenster; es ist dann eine Stunde kürzer oder länger).
     */
    public static Nacht nacht(Instant jetzt) {
        LocalDate tag = jetzt.atZone(ZONE).toLocalDate();
        Nacht heute = nachtAm(tag);
        return jetzt.isBefore(heute.ende()) ? heute : nachtAm(tag.plusDays(1));
    }

    private static Nacht nachtAm(LocalDate tag) {
        return new Nacht(ZonedDateTime.of(tag, BEGINN, ZONE).toInstant(), ZonedDateTime.of(tag, ENDE, ZONE).toInstant());
    }

    /**
     * Ein Takt: höchstens ein Auftrag. {@code juengste} sind alle Fernläufe (jeder Box, jedes Akteurs), die seit
     * Beginn dieser Nacht oder in der letzten Stunde erteilt wurden, mit ihrem Zustand zur Zeit des Takts.
     */
    public static Urteil takt(boolean an, Instant jetzt, List<Box> boxen, List<Lauf> juengste) {
        return takt(an, jetzt, nacht(jetzt), boxen, juengste);
    }

    /** Wie {@link #takt(boolean, Instant, List, List)}, mit der Nacht als Eingabe (der Takt rechnet sie aus). */
    public static Urteil takt(boolean an, Instant jetzt, Nacht nacht, List<Box> boxen, List<Lauf> juengste) {
        if (!an) {
            return Urteil.nur(Art.AUS, GRUND_AUS);
        }
        if (!nacht.enthaelt(jetzt)) {
            return Urteil.nur(Art.TAG, "Außerhalb des Nachtfensters (02:00 bis 05:00).");
        }
        Optional<Lauf> offen = juengste.stream().filter(l -> FernlaufRegel.offen(l.zustand())).findFirst();
        if (offen.isPresent()) {
            return Urteil.nur(Art.WARTEN, "Für " + offen.get().edgeRef() + " läuft ein Fernlauf; die Automatik "
                    + "wartet sein Ende ab.");
        }
        if (anzahl(nacht, juengste) >= GRENZE) {
            return Urteil.nur(Art.GRENZE, GRUND_GRENZE);
        }
        Map<String, Dran> plan = plan(true, jetzt, nacht, boxen, juengste);
        return boxen.stream().sorted(Comparator.comparing(Box::edgeRef))
                .filter(b -> plan.get(b.edgeRef()).dran())
                .findFirst()
                .map(b -> new Urteil(Art.ANLEGEN, b.edgeRef(), b.neueste(), null))
                .orElse(Urteil.nur(Art.NICHTS, "Keine Box ist dran."));
    }

    /**
     * Wer in der Nacht {@link #nacht(Instant)} dran ist, je Box (für die Karte „Ohne Kundenkonto" und die Akte):
     * dieselben Regeln wie {@link #takt}, dazu die Obergrenze als Reihenfolge nach Kennung - die ersten freien
     * Plätze dieser Nacht, in derselben Reihenfolge, in der der Takt sie nimmt. Ob der Lauf dann wirklich beginnt,
     * entscheidet der Takt in der Nacht, mit dem Stand von dann (ist die Box um 02:00 nicht im Tunnel, ist sie
     * nicht dran).
     */
    public static Map<String, Dran> plan(boolean an, Instant jetzt, List<Box> boxen, List<Lauf> juengste) {
        return plan(an, jetzt, nacht(jetzt), boxen, juengste);
    }

    /** Wie {@link #plan(boolean, Instant, List, List)}, mit der Nacht als Eingabe. */
    public static Map<String, Dran> plan(boolean an, Instant jetzt, Nacht nacht, List<Box> boxen,
            List<Lauf> juengste) {
        List<Lauf> dieseNacht = juengste.stream().filter(l -> nacht.enthaelt(l.erteiltAm())).toList();
        int frei = GRENZE - anzahl(nacht, juengste);
        Map<String, Dran> out = new LinkedHashMap<>();
        for (Box b : boxen.stream().sorted(Comparator.comparing(Box::edgeRef)).toList()) {
            Dran d = an ? einzeln(b, jetzt, dieseNacht) : Dran.nein(GRUND_AUS);
            if (d.dran()) {
                if (frei <= 0) {
                    d = Dran.nein(GRUND_GRENZE);
                }
                frei--;
            }
            out.put(b.edgeRef(), d);
        }
        return out;
    }

    private static Dran einzeln(Box b, Instant jetzt, List<Lauf> dieseNacht) {
        if (b.neueste() == null) {
            return Dran.nein(b.vorpruefung().gruende().isEmpty() ? "Es gibt keine neueste Fassung."
                    : b.vorpruefung().gruende().get(0).text());
        }
        if (b.rueckmeldungAm() == null || b.rueckmeldungAm().isBefore(jetzt.minus(RUECKMELDUNG))) {
            return Dran.nein(GRUND_RUECKMELDUNG);
        }
        if (!b.vorpruefung().moeglich()) {
            return Dran.nein(b.vorpruefung().gruende().get(0).text());
        }
        String kurz = b.neueste().replaceFirst("^" + FernlaufRegel.EDGE_LIGHT_PRAEFIX, "");
        Optional<Lauf> letzter = b.verlauf().stream().filter(l -> b.neueste().equals(l.fassungZiel())).findFirst();
        if (letzter.isPresent() && fehlschlag(letzter.get().zustand())) {
            return Dran.nein("Der letzte Lauf auf " + kurz + " wurde " + wort(letzter.get().zustand()) + "; die "
                    + "Automatik versucht diese Fassung hier nicht noch einmal („Noch einmal“ von Hand gibt "
                    + "sie frei).");
        }
        if (dieseNacht.stream().anyMatch(l -> b.neueste().equals(l.fassungZiel()) && fehlschlag(l.zustand()))) {
            return Dran.nein("Ein Lauf auf " + kurz + " wurde in dieser Nacht zurückgenommen oder blieb offen; die "
                    + "Automatik hat für diese Fassung bis zur nächsten Nacht angehalten.");
        }
        if (dieseNacht.stream().anyMatch(l -> l.nachts() && l.edgeRef().equals(b.edgeRef()))) {
            return Dran.nein(GRUND_SCHON);
        }
        return new Dran(true, null);
    }

    /** Zurückgenommen oder offen geblieben: so endet ein Lauf, nach dem die Automatik nicht drängelt. */
    public static boolean fehlschlag(String zustand) {
        return "zurueck".equals(zustand) || "offen".equals(zustand);
    }

    private static String wort(String zustand) {
        return "zurueck".equals(zustand) ? "zurückgenommen" : "nicht zu Ende gemeldet (offen)";
    }

    /** Die Nachtläufe, die in dieser Nacht angelegt wurden. */
    public static int anzahl(Nacht nacht, List<Lauf> juengste) {
        return (int) juengste.stream().filter(l -> l.nachts() && nacht.enthaelt(l.erteiltAm())).count();
    }
}
