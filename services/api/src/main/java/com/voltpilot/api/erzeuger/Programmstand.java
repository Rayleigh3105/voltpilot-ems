package com.voltpilot.api.erzeuger;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * UEMS EZ-16 „Programmstand im Portal“ (Konzept vp-erzeuger-wago-konzept §3.7, §4.10, EW-13 B): welcher Stand des
 * VoltPilot-SPS-Programms auf einer Anlagensteuerung läuft und ob er der erwartete ist.
 *
 * <p>Ist ist das Kopf-Register 7 {@code programmstand} des Bilds (U16, JJMM: 2610 = Oktober 2026), als Messpunkt
 * {@value #PUNKT}. Soll ist das Feld {@code registerbild_fassung.programmstand_soll} der laufenden Fassung; leer
 * heißt „folgt der Bibliothek“ und gilt {@link #BIBLIOTHEK}. Verglichen wird nur, was beide Seiten sicher sagen:
 * kein Wert, ein Wert außerhalb von JJMM oder die Ungültig-Marke {@code 0xFFFF} sind {@code unbekannt}, nie
 * „aktuell“ und nie 0.
 */
public final class Programmstand {

    /** Der Messpunkt des Ist-Stands (Katalogfamilie {@value ErzeugerRegisterbild#FAMILIE}). */
    public static final String PUNKT = "erzeuger.kopf.programmstand";

    /**
     * Der Stand der VoltPilot-SPS-Bibliothek „Erzeuger“, den eine Anlage heute fahren soll (JJMM). Bis die
     * Bibliothek ein eigenes Repository mit Releases hat (EZ-3, EW-13 B), wird er HIER gepflegt: mit jeder
     * freigegebenen Fassung der Bibliothek anheben, im selben Pull Request wie ihr Vermerk. 2610 = der Stand des
     * Gore-Umbaus (Konzept §3.8, {@code PRG_VP_Bild.st}).
     */
    public static final int BIBLIOTHEK = 2610;

    /** Die Ungültig-Marke des Kopf-Registers (Katalog {@code ungueltig}). */
    static final int UNGUELTIG = 0xFFFF;

    public static final String AKTUELL = "aktuell";
    public static final String AELTER = "aelter";
    public static final String UNBEKANNT = "unbekannt";

    private Programmstand() {}

    /**
     * Das Ergebnis des Vergleichs. {@code ist}/{@code soll} roh (JJMM), {@code istText}/{@code sollText} als
     * „26.10“; {@code sollAusFassung} false = der Soll ist der Stand der Bibliothek. {@code gemessenAm} ist das
     * Datenalter des Ist-Werts (null = kein Wert).
     */
    public record Vergleich(String zustand, Integer ist, String istText, int soll, String sollText,
            boolean sollAusFassung, Instant gemessenAm) {

        /** Kandidat für die Überwachung (EZ-11): die Anlage fährt einen älteren als den erwarteten Stand. */
        public boolean warnen() {
            return AELTER.equals(zustand);
        }
    }

    /** Vergleicht den gelesenen Stand mit dem Soll der Fassung (null = Bibliothek). */
    public static Vergleich vergleiche(BigDecimal gelesen, Instant gemessenAm, Integer sollDerFassung) {
        int soll = sollDerFassung == null ? BIBLIOTHEK : sollDerFassung;
        Integer ist = stand(gelesen);
        String zustand = ist == null ? UNBEKANNT : ist < soll ? AELTER : AKTUELL;
        return new Vergleich(zustand, ist, ist == null ? null : text(ist), soll, text(soll),
                sollDerFassung != null, ist == null ? null : gemessenAm);
    }

    /** Ein gültiger Stand JJMM (Monat 1 … 12) — sonst null. */
    static Integer stand(BigDecimal gelesen) {
        if (gelesen == null || gelesen.signum() < 0 || gelesen.stripTrailingZeros().scale() > 0) {
            return null;
        }
        int roh;
        try {
            roh = gelesen.intValueExact();
        } catch (ArithmeticException e) {
            return null;
        }
        return gueltig(roh) ? roh : null;
    }

    /** JJMM mit Monat 1 … 12; die Ungültig-Marke ist kein Stand. */
    public static boolean gueltig(int roh) {
        int monat = roh % 100;
        return roh != UNGUELTIG && roh >= 0 && roh <= 9912 && monat >= 1 && monat <= 12;
    }

    /** „26.10“ aus 2610, „27.01“ aus 2701. */
    static String text(int roh) {
        return String.format("%02d.%02d", roh / 100, roh % 100);
    }
}
