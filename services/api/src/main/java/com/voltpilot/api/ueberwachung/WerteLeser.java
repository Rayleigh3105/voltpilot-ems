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

        /** Eine Messstelle (Alerting Scheibe 5, §6.3 "Bezug": Unternehmen, Standort, Anlage, Box, Komponente,
         * Messstelle, Kennzahl, Energieziel, Netzanschluss, Ladepunkt). */
        public static Bezug messstelle(UUID id) {
            return new Bezug("messstelle", id, null);
        }

        /** Eine Kennzahl (Alerting Scheibe 5, §6.3): Wert gegen ihre Bezugsbasis. */
        public static Bezug kennzahl(UUID id) {
            return new Bezug("kennzahl", id, null);
        }

        /** Ein Energieziel (Alerting Scheibe 5, §6.3): Kurs zum Ziel. */
        public static Bezug energieziel(UUID id) {
            return new Bezug("energieziel", id, null);
        }

        /**
         * Eine Erzeugungseinheit (UEMS EZ-11): die Anlagensteuerung (Gerät) mit der TE-Nr. der Einheit. Nie in einer
         * gespeicherten Regel - eine Vorlage je Einheit hängt an der Anlage, der Takt fächert sie jedes Mal frisch in
         * ihre Einheiten auf (wie eine Auswahl, §6.4 Nr. 6), damit jede Einheit ihre eigene Meldung bekommt.
         */
        public static Bezug einheit(UUID steuerung, int teNr) {
            return new Bezug("einheit", steuerung, Integer.toString(teNr));
        }

        /** Die Einheiten-Kennung für {@code ueberwachung_instanz.bezug_kennung} (§6.7 Skizze, §6.3 Wertverweis-Syntax). */
        public String kennung() {
            if (parameter == null) {
                return art + ":" + id;
            }
            return art + ":" + id + ("einheit".equals(art) ? ";te=" : ";kanal=") + parameter;
        }
    }

    /**
     * Das Ergebnis eines Lesevorgangs. {@code bekannt = false} heißt: der Wert ist (noch) nicht
     * vorhanden - UNBEKANNT IST KEINE NULL (Konzept §6.1 Nr. 4) - keine Schwellen-Bedingung wertet
     * das als erfüllt. Ein Leser füllt ENTWEDER {@code zustandswort} (Scheibe 1: zustand, ereignis)
     * ODER {@code zahlenwert} (Scheibe 2: anlagenfluss, messreihe) - nie beide. {@code text} (UEMS EZ-11) ist ein
     * fertiger Satz in Kundensprache, den eine Meldung statt „… meldet: ‹Wert›“ trägt; nur der Erzeuger-Leser setzt ihn.
     */
    record Lesung(boolean bekannt, String zustandswort, Double zahlenwert, String einheit, Instant messzeit,
            String text) {
        public static Lesung unbekannt() {
            return new Lesung(false, null, null, null, null, null);
        }

        public static Lesung zustand(String wort, Instant messzeit) {
            return new Lesung(true, wort, null, null, messzeit, null);
        }

        /** Ein Zustand mit seinem Satz in Kundensprache (UEMS EZ-11). */
        public static Lesung zustand(String wort, Instant messzeit, String text) {
            return new Lesung(true, wort, null, null, messzeit, text);
        }

        public static Lesung zahl(double wert, String einheit, Instant messzeit) {
            return new Lesung(true, null, wert, einheit, messzeit, null);
        }
    }

    /** Liest den aktuellen Zustand eines Bezugs für diesen Katalog-Eintrag. */
    Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt);

    /**
     * Periode-bewusstes Lesen (Alerting Scheibe 4, Konzept §6.3/§6.4: Bedingungsart {@code periode}) -
     * NUR von den periodischen Lesern ({@code menge}, {@code geld}) überschrieben; alle anderen
     * ignorieren {@code periode}/{@code nurEndgueltig} und liefern denselben Momentanwert wie
     * {@link #lese}. {@code periode} ist eine aus {@code viertelstunde|tag|woche|monat|abrechnungszeitraum};
     * {@code nurEndgueltig = true} liefert {@link Lesung#unbekannt()}, solange die Periode noch läuft
     * (§6.3 "vorläufig oder erst endgültig") - kein Code braucht die Bedingung im {@code lese}-Signatur
     * zu kennen (Scheibe 1-3 bleiben unverändert).
     */
    default Lesung lesePeriode(WerteKatalog.Eintrag eintrag, Bezug bezug, String periode, boolean nurEndgueltig,
            Instant jetzt) {
        return lese(eintrag, bezug, jetzt);
    }

    /**
     * Der Wert der VORPERIODE (§6.4 Bedingungsart {@code aenderung}, "Änderung gegenüber Vorperiode
     * um X %") - NUR von den periodischen Lesern überschrieben; andere liefern UNBEKANNT (keine
     * Vorperiode definiert).
     */
    default Lesung leseVorperiode(WerteKatalog.Eintrag eintrag, Bezug bezug, String periode, Instant jetzt) {
        return Lesung.unbekannt();
    }
}
