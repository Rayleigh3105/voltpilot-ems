package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die REINEN Regeln des Periodenwerts einer berechneten Messstelle (UEMS AP-10 IP-10, Captain-Entscheid
 * E6 = A): was der Verdichtungsjob für EINE Periode speichert, und in welcher Reihenfolge er die berechneten
 * Messstellen eines Kundenbereichs rechnet.
 *
 * <p><b>Rein.</b> Kein Spring, keine Datenbank, keine Uhr. Wer liest und schreibt, steht in
 * {@link BerechnetePeriodenLauf}.
 *
 * <p><b>Hier wird nichts neu gerechnet.</b> Menge, Zustand, Abdeckung und Kennzeichen kommen aus
 * {@link MessstelleFormelRegeln#periodenwert} (§4.5, je Formel-Typ in {@link BilanzAbleitung}); vorläufig
 * oder endgültig aus {@link TagRegeln#zustand} — derselben Regel, mit der ein Tag über seine Viertelstunden
 * und ein Monat über seine Tage endgültig wird. Die Teile einer berechneten Periode sind ihre EINGÄNGE:
 * ein vorläufiger Eingang macht das Ergebnis vorläufig, und endgültig wird es erst, wenn jeder vorhandene
 * Eingang endgültig ist und die Frist der Periode abgelaufen ist.
 */
public final class BerechnetePeriode {

    /** Das Wort des Lese-Modells für eine Periode, deren Rohwerte da sind, deren Zeile aber noch fehlt. */
    public static final String NOCH_NICHT_GEBILDET = MessstelleWerteRegeln.OhneZahl.NOCH_NICHT_GEBILDET.wort();

    /** Kein Eingang hat für diese Periode etwas — wie eine Lücke hat sie gar keine Zeile. */
    public static final String KEINE_EINGAENGE = "keine_eingaenge";

    private BerechnetePeriode() {
    }

    /**
     * Ein Eingang einer Periode, wie das Lese-Modell ihn sagt. Eine gewichtete Summe liest {@code vorzeichen}
     * und {@code faktor}, ein {@code rest} die Bilanz-{@code rolle} und den {@code anteil}.
     *
     * @param zustand das Wort des Ergebnis-Zustands ({@code menge_zustand}), {@code null} ohne Zahl
     * @param version die Version der gespeicherten Zeile — {@code null}: es GIBT keine Zeile
     * @param fassung vorläufig/endgültig der gespeicherten Zeile ({@code null} ohne Zeile)
     * @param grund warum der Eingang keine Zahl hat (das Wort des Lese-Modells), sonst {@code null}
     */
    public record Eingang(
            String messstelle,
            String rolle,
            String anteil,
            String vorzeichen,
            BigDecimal faktor,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            Integer version,
            List<String> kennzeichen,
            String fassung,
            String grund) {

        /** Trägt der Eingang eine gespeicherte Zeile — oder liegen darunter schon Rohwerte? */
        boolean vorhanden() {
            return version != null || NOCH_NICHT_GEBILDET.equals(grund);
        }

        boolean endgueltig() {
            return version != null && ViertelstundeRegeln.ENDGUELTIG.equals(fassung);
        }
    }

    /**
     * Die Zeile, die gespeichert wird. {@code zustand} ist vorläufig/endgültig (Spalte {@code zustand}),
     * {@code mengeZustand} das Wort des Ergebnis-Zustands (Spalte {@code menge_zustand}).
     */
    public record Ergebnis(
            BigDecimal menge,
            String mengeZustand,
            Integer abdeckungProzent,
            List<String> kennzeichen,
            String zustand,
            Instant endgueltigAb,
            int eingaengeVorhanden,
            int eingaengeEndgueltig) {}

    /** Das Urteil über eine Periode: eine Zeile, oder der Grund, warum es keine gibt. */
    public record Urteil(Ergebnis ergebnis, String grund) {}

    /**
     * Der Periodenwert einer berechneten Messstelle für EINE Periode.
     *
     * @param typ der Formel-Typ der Fassung der Periode
     * @param einheit die Einheit der Hauptgröße (kWh …)
     * @param ebene {@code viertelstunde} · {@code tag} · {@code monat} · {@code jahr} — die Stellen der Zahl im
     *     Kundensatz (E11); gerechnet wird ungerundet
     * @param eingaenge die Eingänge in der Reihenfolge der Terme
     * @param periodenende das Ende der Periode (ausschließlich) — die Frist ist sieben Tage danach (E5)
     * @param vermerke was an der Periode zusätzlich zu sagen ist (etwa „Stellung geändert (…)“) — hereingereicht,
     *     nie erraten; der Lauf reicht keine herein (die Vermerke kommen mit der Herkunft, AP-10 IP-12)
     */
    public static Urteil rechne(String typ, String einheit, String ebene, List<Eingang> eingaenge,
            Instant periodenende, Instant jetzt, List<String> vermerke) {
        int vorhanden = 0;
        int endgueltig = 0;
        List<MessstelleFormelRegeln.Periodeneingang> formel = new ArrayList<>();
        for (Eingang e : eingaenge) {
            vorhanden += e.vorhanden() ? 1 : 0;
            endgueltig += e.endgueltig() ? 1 : 0;
            String zustand = e.menge() == null || e.zustand() == null ? BilanzAbleitung.KEINE_WERTE : e.zustand();
            formel.add(new MessstelleFormelRegeln.Periodeneingang(e.messstelle(), e.rolle(), e.anteil(),
                    e.vorzeichen(), e.faktor(), e.menge(), zustand, e.abdeckungProzent(),
                    e.version() == null ? 1 : e.version(), e.kennzeichen() == null ? List.of() : e.kennzeichen()));
        }
        if (vorhanden == 0) {
            return new Urteil(null, KEINE_EINGAENGE);
        }
        MessstelleFormelRegeln.Periodenwert w = MessstelleFormelRegeln.periodenwert(typ, MessstelleRegeln.BERECHNET,
                einheit, ebene, 1, vermerke, formel);
        if (w.fehler() != null) {
            return new Urteil(null, w.fehler());
        }
        Instant frist = TagRegeln.endgueltigAb(periodenende);
        // „keine Werte“ trägt nie eine Zahl (bilanz.md Nr. 7, CHECK …_keine_werte_chk): eine gewichtete Summe ohne einen
        // einzigen Eingang mit Wert rechnet 0 — gespeichert wird „keine Werte“ ohne Menge (Befund AP-08 IP-17: vorher
        // scheiterte daran die ganze Scheibe, sobald ein Eingang in einer Viertelstunde „nur einen Stand“ hatte).
        BigDecimal menge = BilanzAbleitung.KEINE_WERTE.equals(w.zustand()) ? null : w.menge();
        return new Urteil(new Ergebnis(menge, w.zustand(), w.abdeckungProzent(), w.kennzeichen(),
                TagRegeln.zustand(vorhanden, endgueltig, frist, jetzt), frist, vorhanden, endgueltig), null);
    }

    // ---------------------------------------------------------------------------- Reihenfolge

    /** Eine berechnete Messstelle, die der Lauf NICHT rechnet — mit dem Grund und der Kette, die ihn trägt. */
    public record Abgelehnt(String messstelle, String grund, List<String> kette) {}

    /** Die Messstelle liegt selbst in einem Kreis ihrer Formeln. */
    public static final String FORMEL_KREIS = "formel_kreis";

    /** Die Messstelle liegt in keinem Kreis, liest aber (über Umwege) eine Messstelle, die in einem liegt. */
    public static final String HAENGT_AN_KREIS = "haengt_an_kreis";

    public record Reihenfolge(List<String> ordnung, List<Abgelehnt> abgelehnt) {}

    /**
     * Die Abhängigkeitsordnung: jede berechnete Messstelle NACH den berechneten Messstellen, die sie liest —
     * eine Messstelle, die vor ihrem Eingang rechnet, schreibt eine Zahl, die schon beim Schreiben falsch ist.
     * Die Kanten kommen aus den Fassungen (und beim {@code rest} aus der Stellung), nie aus einer gepflegten
     * Liste. Unter Gleichrangigen entscheidet die Reihenfolge von {@code lesen} (stabil).
     *
     * <p><b>Ein Kreis ist ein Fehler, keine Schleife.</b> Was nach dem Abbau aller rechenbaren Messstellen
     * übrig bleibt, liegt in einem Kreis ({@link #FORMEL_KREIS}, die Kette aus
     * {@link MessstelleFormelRegeln#zyklus}) oder hängt an einem ({@link #HAENGT_AN_KREIS}) — benannt
     * abgelehnt, nie gerechnet.
     *
     * @param lesen je berechneter Messstelle die berechneten Messstellen, die sie liest (Kennzeichen); Kanten
     *     zu Messstellen, die hier nicht als Schlüssel stehen, zählen nicht (gemessene Eingänge)
     */
    public static Reihenfolge reihenfolge(Map<String, List<String>> lesen) {
        Map<String, Set<String>> offen = new LinkedHashMap<>();
        lesen.forEach((kz, eingaenge) -> {
            Set<String> berechnet = new LinkedHashSet<>();
            for (String e : eingaenge) {
                if (lesen.containsKey(e)) {
                    berechnet.add(e);
                }
            }
            offen.put(kz, berechnet);
        });
        List<String> ordnung = new ArrayList<>();
        boolean weiter = true;
        while (weiter) {
            weiter = false;
            for (Map.Entry<String, Set<String>> e : offen.entrySet()) {
                if (!ordnung.contains(e.getKey()) && ordnung.containsAll(e.getValue())) {
                    ordnung.add(e.getKey());
                    weiter = true;
                }
            }
        }
        List<Abgelehnt> abgelehnt = new ArrayList<>();
        Map<String, List<String>> graph = new LinkedHashMap<>();
        offen.forEach((kz, e) -> graph.put(kz, List.copyOf(e)));
        for (String kz : offen.keySet()) {
            if (ordnung.contains(kz)) {
                continue;
            }
            MessstelleFormelRegeln.ZyklusUrteil eigen = MessstelleFormelRegeln.zyklus(kz, graph.get(kz), graph);
            if (eigen.zyklus()) {
                abgelehnt.add(new Abgelehnt(kz, FORMEL_KREIS, eigen.kette()));
                continue;
            }
            abgelehnt.add(new Abgelehnt(kz, HAENGT_AN_KREIS, kreisUnter(kz, graph, ordnung)));
        }
        return new Reihenfolge(List.copyOf(ordnung), List.copyOf(abgelehnt));
    }

    /** Der erste Kreis, den {@code kz} über seine nicht rechenbaren Eingänge erreicht — als seine Kette. */
    private static List<String> kreisUnter(String kz, Map<String, List<String>> graph, List<String> ordnung) {
        List<String> weg = new ArrayList<>(List.of(kz));
        Set<String> gesehen = new LinkedHashSet<>(weg);
        String aktuell = kz;
        while (true) {
            String naechste = null;
            for (String e : graph.getOrDefault(aktuell, List.of())) {
                if (!ordnung.contains(e)) {
                    naechste = e;
                    break;
                }
            }
            if (naechste == null) {
                return List.copyOf(weg);
            }
            MessstelleFormelRegeln.ZyklusUrteil z = MessstelleFormelRegeln.zyklus(naechste, graph.get(naechste), graph);
            if (z.zyklus()) {
                weg.addAll(z.kette());
                return List.copyOf(weg);
            }
            if (!gesehen.add(naechste)) {
                return List.copyOf(weg);
            }
            weg.add(naechste);
            aktuell = naechste;
        }
    }
}
