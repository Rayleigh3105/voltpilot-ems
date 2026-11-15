package com.voltpilot.api.fleet;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * Hält EINE berechnete Antwort für kurze Zeit fest und rechnet sie höchstens einmal gleichzeitig
 * (Lasttest vp-lasttest, Befund B6, Rang 5): mehrere offene Admin-Tabs fragen dieselbe Flotten-Antwort alle
 * 30 s ab, und jede Abfrage rechnete bisher die ganze Flotte neu (bei 2 000 Boxen 1,4-4,4 MB, 0,7-3,6 s).
 *
 * <p><b>Gültig</b> ist der festgehaltene Wert, solange er jünger als {@code gueltig} ist UND seit dem Beginn
 * seiner Berechnung keine Schreibhandlung den gemeinsamen {@link #stand Stand} weitergezählt hat. Wer während
 * einer laufenden Berechnung fragt, wartet auf sie, statt eine zweite zu starten (eine Berechnung je Moment,
 * egal wie viele Tabs). Eine Berechnung, die vor einer Schreibhandlung begann, gilt danach nicht mehr: der
 * nächste Abruf rechnet neu, auch wenn die Zeit noch nicht um ist.
 *
 * <p>{@code gueltig} von null schaltet das Festhalten ab (jeder Abruf rechnet).
 */
public final class KurzSpeicher<T> {

    private record Eintrag<T>(T wert, Instant gerechnet, long stand) {}

    private final Duration gueltig;
    private final Clock clock;
    private final AtomicLong stand;
    private final ReentrantLock rechnet = new ReentrantLock();
    private volatile Eintrag<T> eintrag;

    /**
     * @param stand der gemeinsame Schreibstand; wer schreibt, zählt ihn weiter ({@link AdminFlottenSpeicher#veraltet()})
     */
    public KurzSpeicher(Duration gueltig, Clock clock, AtomicLong stand) {
        this.gueltig = gueltig;
        this.clock = clock;
        this.stand = stand;
    }

    /** Der festgehaltene Wert, oder - wenn keiner gilt - der eben gerechnete. */
    public T hole(Supplier<T> rechne) {
        if (gueltig.isZero() || gueltig.isNegative()) {
            return rechne.get();
        }
        Eintrag<T> e = eintrag;
        if (gilt(e)) {
            return e.wert();
        }
        rechnet.lock();
        try {
            e = eintrag;
            if (gilt(e)) {
                return e.wert(); // ein anderer Abruf hat eben gerechnet
            }
            long standVorher = stand.get();
            T wert = rechne.get();
            eintrag = new Eintrag<>(wert, clock.instant(), standVorher);
            return wert;
        } finally {
            rechnet.unlock();
        }
    }

    private boolean gilt(Eintrag<T> e) {
        return e != null && e.stand() == stand.get() && clock.instant().isBefore(e.gerechnet().plus(gueltig));
    }
}
