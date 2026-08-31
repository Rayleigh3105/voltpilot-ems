package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Die im Portal gepflegte Lastmanagement-Konfiguration einer Anlage
 * (Lastmanagement Stufe 3).
 *
 * <p>{@code gridLimitKw == null} heißt „noch nicht gepflegt" - und dann ist das
 * Budget der Box 0 und es lädt nichts. Das ist der ehrliche Zustand einer
 * Anlage, die niemand eingerichtet hat, nie eine erfundene Grenze.
 */
public record ChargingConfigDto(Double gridLimitKw, List<String> priorityChargePointIds,
        /*
         * Die QUELLEN-Wahl des Kunden (Stufe 4): woher der Ladestrom kommen
         * soll. Sie ändert KEINE Grenze - die zwei Bahnen komponieren
         * most-restrictive-wins, und keine kann die andere aufweichen.
         *
         * ⚠ null = der Kunde hat nichts gewählt und die Box behält ihre eigene
         * Einstellung. Es heißt NIE „schnell": das wäre eine eigene Aussage.
         */
        String surplusPolicy, String storagePriority,
        /*
         * Die ALLOWLIST: die Kennungen, unter denen die Box eine Säule
         * überhaupt annimmt.
         *
         * ⚠ Sie FÜGT NUR HINZU. Ein Eintrag hier lässt eine Säule herein; eine
         * Kennung hier WEGZULASSEN ist kein Löschen - das sagt
         * {@code removedChargePointIds} ausdrücklich. Eine leere Liste ist hier
         * - anders als beim Vorrang - keine Aussage „keine Säule", sondern nur
         * „das Portal hat noch keine eingetragen".
         */
        List<AllowedChargePointDto> chargePoints,
        /*
         * Die ZURÜCKGENOMMENEN Kennungen - die GRABSTEIN-Liste (Captain-Order
         * 24.08.2026).
         *
         * ⚠ Sie reist in JEDEM folgenden Dokument mit, nicht einmal: das
         * retained Dokument wird als Ganzes ersetzt, also hätte eine nur einmal
         * genannte Löschung eine gerade offline gewesene Box nie erreicht. Eine
         * Kennung steht deshalb nie zugleich in {@code chargePoints} - ein
         * erneutes Eintragen belebt sie wieder und nimmt sie hier heraus.
         */
        List<String> removedChargePointIds,
        /*
         * Der Ladepark-RAHMEN (P5/E10): Hausreserve, Sicherheitsabstand,
         * Mindestleistung, Rotation, hoechste bekannte Gebaeudelast und
         * statisch/gemessen.
         *
         * ⚠ Bis P5 konnte ihn NUR `:8484` pflegen - ein Kunde konnte im Portal
         * nicht einmal LESEN, wonach seine Anlage rechnet. Er wird deshalb hier
         * gefuehrt und mitgeliefert; SCHREIBEN darf ihn nur ein
         * Plattform-Admin. null = das Portal aeussert sich nicht und die Box
         * behaelt ihre eigene Zahl (die PATCH-Regel dieses Pfads).
         */
        LadeparkRahmenDto frame,
        /*
         * Die Position des SPEICHERS in der Rangliste des Kunden (P6).
         *
         * ⚠ null = der Kunde hat nie eine Reihenfolge gezogen. Dann entscheidet
         * allein das anlagenweite {@code storagePriority}, wer in den ganzen
         * Ueberschuss greifen darf - genau das Verhalten vor P6. Es ist NIE 0.
         */
        Integer storageRank,
        /*
         * Die WALLBOXEN dieser Anlage (P6) - Ladepunkte, die NICHT über OCPP
         * hängen, sondern als v2-Verbraucher gesteuert werden (go-e & Co.).
         *
         * ⚠ Sie treten dem Ladepark-Rahmen als virtuelle Sitzung bei: die Box
         * zählt ihre GEMESSENE Leistung ins Budget zurück und deckelt sie über
         * den bestehenden Verbraucher-Sollwert, nie über OCPP. Eine LEERE Liste
         * ist hier - anders als bei der Allowlist - die Aussage „keine Wallbox
         * nimmt teil": nur so kann eine entfernte wieder herausfallen.
         */
        List<WallboxDto> wallboxes,
        Instant updatedAt, String updatedBy) {

    /**
     * Eine im Portal eingetragene Ladesäule. Alles außer der Kennung ist das,
     * was der Betreiber zufällig schon weiß - {@code null} heißt „unbekannt",
     * nie 0: die Box entscheidet dann aus dem, was die Säule selbst meldet.
     */
    public record AllowedChargePointDto(String chargePointId, String label, Double ratedKw,
            Integer connectors,
            /*
             * source = die QUELLE dieser Saeule (P5, Steuerart je Ladepunkt):
             * "nur_sonne" | "sonne_zuerst" | "schnell". null = der Kunde hat
             * fuer SIE nichts gewaehlt und es gilt der ANLAGEN-STANDARD
             * (ChargingConfigDto.surplusPolicy) - nie "schnell", das waere eine
             * Netzstrom-Freigabe, die niemand erteilt hat.
             *
             * minKw = ab welcher Leistung sie ueberhaupt anfaengt. null =
             * unbekannt, nie 0.
             */
            String source, Double minKw,
            /*
             * connection = WO diese Saeule haengt (Cockpit Phase 1 / C1):
             * "haus" (hinter dem Hausanschluss) oder "eigen" (eigener
             * Netzanschluss/Zaehler). null = der Kunde hat nichts gesagt, und
             * die Box behaelt, was sie hat - NIE "eigen", denn das naehme eine
             * reale Ladeleistung aus ihrer eigenen Bilanz.
             */
            String connection,
            /*
             * rank = die Position dieser Saeule in der Rangliste des Kunden
             * (P6). null = sie steht in keiner - dann entscheidet allein die
             * Vorrang-MENGE, also exakt wie vor P6.
             *
             * ⚠ GLEICHE ZAHLEN SIND GLEICHRANGIG: alle Saeulen EINER Seite des
             * Speichers tragen dieselbe, weil die Flaeche sie als EINE Zeile
             * zeigt und der Kunde zwischen ihnen gar keine Reihenfolge gewaehlt
             * hat. Die Box wechselt zwischen ihnen weiter im Takt ab.
             */
            Integer rank,
            Instant addedAt, String addedBy) {}

    /**
     * Eine Wallbox, die dem Ladepark-Rahmen beitritt (P6).
     *
     * <p><b>⚠ Ohne LEISTUNGSMESSUNG nimmt sie nicht teil</b> - das entscheidet
     * die BOX, nicht diese Zeile: nur sie weiß, ob gerade ein frischer Messwert
     * anliegt und ob der Arbiter ihr wirklich einen Sollwert gibt. Eine Zeile
     * hier ist die ERLAUBNIS teilzunehmen, nie die Behauptung, dass sie es tut.
     *
     * <p>{@code null} heißt überall „unbekannt", nie 0: ohne Nennleistung gilt
     * das Budget, ohne Mindestleistung die anlagenweite, ohne Rang ist sie
     * ungerankt (dann verteilt die Box wie vor P6).
     */
    public record WallboxDto(java.util.UUID entityId, String label, Double ratedKw, Double minKw,
            Integer rank) {}

    /**
     * Der Ladepark-RAHMEN einer Anlage (P5/E10). Jedes Feld ist einzeln
     * optional: null heisst „das Portal aeussert sich nicht" und die Box
     * behaelt ihre eigene Zahl.
     *
     * <p>⚠ {@code staticBudget} ist NEGATIV formuliert wie auf der Box („rechne
     * STATISCH"), damit sein Nullwert die gewollte Vorgabe ist: nimm die
     * Messung, wenn es eine gibt.
     */
    public record LadeparkRahmenDto(Double houseReserveKw, Double marginPct, Double minPowerKw,
            Integer rotationMinutes, Double maxHouseLoadKw, Boolean staticBudget) {

        /** true, wenn das Portal zu KEINEM Feld etwas sagt. */
        public boolean leer() {
            return houseReserveKw == null && marginPct == null && minPowerKw == null
                    && rotationMinutes == null && maxHouseLoadKw == null && staticBudget == null;
        }
    }
}
