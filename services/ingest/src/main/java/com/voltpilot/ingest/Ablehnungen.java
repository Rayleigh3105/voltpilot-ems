package com.voltpilot.ingest;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Ablehnungen EINES Umschlags, gebündelt je Art und Grund: ein Ereignis mit Zählung statt
 * eines je Wert. So hinterlässt eine Box mit falscher Uhr je Umschlag genau ein
 * {@code clock_ahead} (E13 „je Box gezählt“), und ein Umschlag mit drei kaputten Werten ein
 * {@code rejected} mit {@code anzahl = 3}. {@code anzahl} zählt die nicht weitergereichten Werte
 * (Samples, Kern-Kanäle bzw. Box-Ereignisse); die Sekunden eines Zeitfehlers sind die GRÖSSTE
 * Abweichung der betroffenen Werte.
 */
final class Ablehnungen {

    /** Ein gebündeltes Ereignis: Art, Grund (nur {@code rejected}), Zahl der Werte, Sekunden (nur Zeitfehler). */
    record Ablehnung(Ereignisart art, Grund grund, long anzahl, Long sekunden) {}

    private record Schluessel(Ereignisart art, Grund grund) {}

    private final Map<Schluessel, long[]> je = new LinkedHashMap<>();

    /** {@code anzahl} Werte verletzen den Vertrag mit diesem Grund. */
    void abgewiesen(Grund grund, long anzahl) {
        long[] z = je.computeIfAbsent(new Schluessel(Ereignisart.REJECTED, grund), k -> new long[2]);
        z[0] += anzahl;
    }

    /** {@code anzahl} Werte tragen eine unplausible Messzeit (kann 0 sein: nur die Uhr des Umschlags). */
    void zeit(Messzeitregel.Abweichung abweichung, long anzahl) {
        long[] z = je.computeIfAbsent(new Schluessel(abweichung.art(), null),
                k -> new long[] {0, abweichung.sekunden()});
        z[0] += anzahl;
        z[1] = Math.max(z[1], abweichung.sekunden());
    }

    List<Ablehnung> liste() {
        List<Ablehnung> out = new ArrayList<>();
        je.forEach((k, z) -> out.add(new Ablehnung(k.art(), k.grund(), z[0],
                k.art() == Ereignisart.REJECTED ? null : z[1])));
        return List.copyOf(out);
    }
}
