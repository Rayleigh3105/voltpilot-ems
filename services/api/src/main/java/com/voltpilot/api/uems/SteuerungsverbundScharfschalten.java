package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundRegeln.Befund;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die Bedingungen des Scharfschaltens einer Gemeinsamen Steuerung (UEMS AP-15 IP-5, Konzept §4.9 I1, §3.9; Vertrag
 * {@code steuerungsverbund.md} §6): die Befunde des Verbund-Objekts ({@link SteuerungsverbundRegeln#pruefen} — T1, T2,
 * G2/G3, B1, B3) plus die Bedingungen, die nicht am Objekt hängen: beide Grenzen gesetzt, Fähigkeit
 * {@code steuerungsverbund_anteil} und Sprungprobe je steuernder Box, Auslegung {@code passt} (unbekannt ist nicht
 * „passt“) und die Vorgabe des Netzbetreibers an jeder Box mit steuerbaren Verbrauchern nach § 14a (G6, R18).
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr. Die Tatsachen lädt der Aufrufer über {@link SteuerungsverbundNachweise};
 * drei davon haben heute noch keine Quelle und antworten „fehlt“ — eine Anlage kommt in IP-5 höchstens bis S1 und
 * wird nie scharf (der sichere Zustand).
 */
public final class SteuerungsverbundScharfschalten {

    private SteuerungsverbundScharfschalten() {}

    /**
     * Die Wörter, die schon der Schritt S0 → S1 verlangt: die erklärte Struktur. Alles Übrige prüft erst das
     * Scharfschalten (S1 beobachtet: Fähigkeit, Auslegung, Vorgabe; S2 geprüft: Sprungprobe).
     */
    public static final Set<Ablehnung> STRUKTUR = Set.of(Ablehnung.BOX_NICHT_IN_ANLAGE, Ablehnung.KEIN_NETZANSCHLUSS,
            Ablehnung.GRENZE_FEHLT, Ablehnung.FUEHRENDE_BOX_MISST_NICHT, Ablehnung.MITSTEUERNDE_BOX_MISST_NICHT);

    /**
     * Was eine steuernde Box für das Scharfschalten mitbringt. {@code null} heißt unbekannt und zählt nie als
     * vorhanden (unbekannt ist keine Null): {@code verbraucher14a} unbekannt = hat welche, {@code vorgabeSignal}
     * unbekannt = liegt nicht an.
     *
     * @param angemeldet     angemeldet und nicht ausgebaut (sonst ist sie nicht mehr in der Anlage — T1)
     * @param faehigkeit     Fähigkeit {@code steuerungsverbund_anteil}, gemeldet oder laut Versions-Tabelle (I1, I2)
     * @param sprungprobe    Sprungprobe bestanden, Protokoll gespeichert (T5, S2)
     * @param verbraucher14a hinter der Box hängen steuerbare Verbraucher nach § 14a (G6)
     * @param vorgabeSignal  das Signal des Netzbetreibers liegt an dieser Box an (G6)
     */
    public record Box(String box, boolean angemeldet, boolean faehigkeit, boolean sprungprobe, Boolean verbraucher14a,
            Boolean vorgabeSignal) {}

    /**
     * Alle Befunde in der Reihenfolge des Vokabulars, je Wort in der Reihenfolge der Mitglieder.
     *
     * @param objekt         das Urteil des Verbund-Objekts ({@link SteuerungsverbundRegeln#pruefen}); wurde es mit
     *                       einer Auslegung gerechnet, stehen ihre Befunde schon darin
     * @param mitglieder     die Mitglieder in ihrer Reihenfolge (Rolle nur zur Einordnung)
     * @param grenzenGesetzt Einspeise- UND Bezugsgrenze wirksam am Tag (I1)
     * @param auslegungBekannt ob die Auslegung gerechnet werden konnte; nein = {@code auslegung_passt_nicht}
     * @param boxen          je Mitglied, was die Box mitbringt
     */
    public static SteuerungsverbundRegeln.Urteil pruefen(SteuerungsverbundRegeln.Urteil objekt,
            List<SteuerungsverbundRegeln.Mitglied> mitglieder, boolean grenzenGesetzt, boolean auslegungBekannt,
            Map<String, Box> boxen) {
        List<Befund> befunde = new ArrayList<>(objekt.befunde());
        for (SteuerungsverbundRegeln.Mitglied m : mitglieder) {
            Box b = box(boxen, m.box());
            if (!b.angemeldet() && befunde.stream().noneMatch(x -> x.ablehnung() == Ablehnung.BOX_NICHT_IN_ANLAGE
                    && m.box().equals(x.box()))) {
                befunde.add(new Befund(Ablehnung.BOX_NICHT_IN_ANLAGE, m.box(), null));
            }
        }
        if (!grenzenGesetzt) {
            befunde.add(new Befund(Ablehnung.GRENZE_FEHLT, null, null));
        }
        for (SteuerungsverbundRegeln.Mitglied m : mitglieder) {
            if (!box(boxen, m.box()).faehigkeit()) {
                befunde.add(new Befund(Ablehnung.FAEHIGKEIT_FEHLT, m.box(), null));
            }
        }
        for (SteuerungsverbundRegeln.Mitglied m : mitglieder) {
            if (!box(boxen, m.box()).sprungprobe()) {
                befunde.add(new Befund(Ablehnung.NACHWEIS_FEHLT, m.box(), null));
            }
        }
        if (!auslegungBekannt) {
            befunde.add(new Befund(Ablehnung.AUSLEGUNG_PASST_NICHT, null, null));
        }
        for (SteuerungsverbundRegeln.Mitglied m : mitglieder) {
            if (!vorgabeSignalPasst(box(boxen, m.box()))) {
                befunde.add(new Befund(Ablehnung.VORGABE_SIGNAL_NICHT_AN_JEDER_BOX, m.box(), null));
            }
        }
        befunde.sort(Comparator.comparingInt(b -> b.ablehnung().ordinal())); // stabil: je Wort Mitglieder-Reihenfolge
        return new SteuerungsverbundRegeln.Urteil(List.copyOf(befunde));
    }

    /**
     * G6: an einer Box mit steuerbaren Verbrauchern nach § 14a muss das Signal anliegen. „Alle solchen Verbraucher
     * hängen an der Box mit dem Signal“ ist dieselbe Bedingung: jede andere Box hat dann keine.
     */
    public static boolean vorgabeSignalPasst(Box b) {
        return Boolean.FALSE.equals(b.verbraucher14a()) || Boolean.TRUE.equals(b.vorgabeSignal());
    }

    /** Nur die Befunde, die schon der Schritt S0 → S1 verlangt ({@link #STRUKTUR}). */
    public static List<Befund> struktur(SteuerungsverbundRegeln.Urteil urteil) {
        return urteil.befunde().stream().filter(b -> STRUKTUR.contains(b.ablehnung())).toList();
    }

    /**
     * Die Stufe nach einer Änderung der Struktur (Einrichten, Ändern, Auflösen; I3): zurück auf S1, wenn die Struktur
     * vollständig ist, sonst auf S0. Eine bestandene Sprungprobe hebt sie nicht über S1 — S2 setzt IP-21.
     */
    public static Stufe stufeNachAenderung(SteuerungsverbundRegeln.Urteil urteil) {
        return struktur(urteil).isEmpty() ? Stufe.BEOBACHTET : Stufe.ERKLAERT;
    }

    private static Box box(Map<String, Box> boxen, String kennung) {
        Box b = boxen.get(kennung);
        if (b == null) {
            throw new IllegalArgumentException("keine Angaben zur Box " + kennung);
        }
        return b;
    }

    /** Die Richtung eines Befunds als Wort, oder {@code null}. */
    public static String richtung(Befund b) {
        Grenzart r = b.richtung();
        return r == null ? null : r.code();
    }
}
