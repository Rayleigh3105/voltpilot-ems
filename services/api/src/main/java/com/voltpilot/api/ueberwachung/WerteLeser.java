package com.voltpilot.api.ueberwachung;

import java.time.Instant;
import java.util.UUID;

/**
 * Liest einen Wert der Überwachung GENAU SO, wie seine Fläche ihn zeigt (Konzept §6.1 Nr. 3,
 * §6.3) - nie mit einer kopierten Abfrage. Eine Implementierung je Leserart ({@link WerteKatalog#LESERARTEN}).
 */
public interface WerteLeser {

    /**
     * Worauf sich eine Überwachung bezieht. Scheibe 1 kannte nur {@code anlage}; Scheibe 2 (§6.3
     * "Wertverweis = Wertart + Bezug (+ Parameter der Familie)") fügt {@code komponente} mit einem
     * Parameter hinzu (der Messkanal einer Familie, {@code geraet.messwert@komponente:<id>;kanal=<messkanal>}).
     * {@code standort} und die Auswahl ("alle Anlagen") bleiben Scheibe 4.
     */
    record Bezug(String art, UUID id, String parameter) {
        public static Bezug anlage(UUID id) {
            return new Bezug("anlage", id, null);
        }

        /** Eine Komponente (Messpunkt/Gerät) mit ihrem Messkanal - Familie {@code geraet.messwert} (§6.3 Nr. 1). */
        public static Bezug komponente(UUID id, String kanal) {
            return new Bezug("komponente", id, kanal);
        }

        /** Die Einheiten-Kennung für {@code ueberwachung_instanz.bezug_kennung} (§6.7 Skizze, §6.3 Wertverweis-Syntax). */
        public String kennung() {
            return parameter == null ? art + ":" + id : art + ":" + id + ";kanal=" + parameter;
        }
    }

    /**
     * Das Ergebnis eines Lesevorgangs. {@code bekannt = false} heißt: der Wert ist (noch) nicht
     * vorhanden - UNBEKANNT IST KEINE NULL (Konzept §6.1 Nr. 4) - keine Schwellen-Bedingung wertet
     * das als erfüllt. Ein Leser füllt ENTWEDER {@code zustandswort} (Scheibe 1: zustand, ereignis)
     * ODER {@code zahlenwert} (Scheibe 2: anlagenfluss, messreihe) - nie beide.
     */
    record Lesung(boolean bekannt, String zustandswort, Double zahlenwert, String einheit, Instant messzeit) {
        public static Lesung unbekannt() {
            return new Lesung(false, null, null, null, null);
        }

        public static Lesung zustand(String wort, Instant messzeit) {
            return new Lesung(true, wort, null, null, messzeit);
        }

        public static Lesung zahl(double wert, String einheit, Instant messzeit) {
            return new Lesung(true, null, wert, einheit, messzeit);
        }
    }

    /** Liest den aktuellen Zustand eines Bezugs für diesen Katalog-Eintrag. */
    Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt);
}
