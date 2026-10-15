package com.voltpilot.api.ueberwachung;

import java.time.Instant;
import java.util.UUID;

/**
 * Liest einen Wert der Überwachung GENAU SO, wie seine Fläche ihn zeigt (Konzept §6.1 Nr. 3,
 * §6.3) - nie mit einer kopierten Abfrage. Eine Implementierung je Leserart ({@link WerteKatalog#LESERARTEN}).
 */
public interface WerteLeser {

    /**
     * Worauf sich eine Überwachung bezieht. Scheibe 1 kennt nur {@code anlage} (§6.7 "Scheibe 1
     * nur Bezug {@code anlage}"); {@code standort} und die Auswahl ("alle Anlagen") kommen mit
     * Scheibe 4.
     */
    record Bezug(String art, UUID id) {
        public static Bezug anlage(UUID id) {
            return new Bezug("anlage", id);
        }

        /** Die Einheiten-Kennung für {@code ueberwachung_instanz.bezug_kennung} (§6.7 Skizze). */
        public String kennung() {
            return art + ":" + id;
        }
    }

    /**
     * Das Ergebnis eines Lesevorgangs. {@code bekannt = false} heißt: der Wert ist (noch) nicht
     * vorhanden - UNBEKANNT IST KEINE NULL (Konzept §6.1 Nr. 4) - keine Schwellen-Bedingung wertet
     * das als erfüllt.
     */
    record Lesung(boolean bekannt, String zustandswort, Instant messzeit) {
        public static Lesung unbekannt() {
            return new Lesung(false, null, null);
        }
    }

    /** Liest den aktuellen Zustand eines Bezugs für diesen Katalog-Eintrag. */
    Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt);
}
