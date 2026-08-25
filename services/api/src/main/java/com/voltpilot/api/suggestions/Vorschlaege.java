package com.voltpilot.api.suggestions;

import java.time.Duration;
import java.time.Instant;

/**
 * Die REINEN Regeln des Vorschlags-GEDÄCHTNISSES (Steuerung Stufe 6, Konzept
 * `vp-steuerung-konzept-b3` §3.3 + §4) - Docker-frei geprüft wie
 * {@code Handeingriff}/{@code Tagesprotokoll}/{@code FleetPflege}; jede
 * zeitabhängige Funktion nimmt ihr {@code now}.
 *
 * <p><b>⚠ Hier wird KEIN Vorschlag erzeugt.</b> Ein Vorschlag ist eine
 * Ableitung aus Fahrplan × steuerbaren Komponenten × dem, was schon läuft, und
 * sie lebt im Portal ({@code frontend/portal/src/vorschlaege.ts}) - dort, wo
 * die Fahrplan-Antwort ohnehin liegt und wo sie sich mit jedem neuen Plan von
 * selbst erneuert. Der Server hält die GEGENRICHTUNG: dass der Kunde einen
 * Vorschlag gerade nicht sehen will.
 *
 * <p><b>⚠ Die Frist gehört dem SERVER.</b> Eine vom Client mitgeschickte Dauer
 * wäre ein Weg, einen Vorschlag für immer verstummen zu lassen, ohne ihn je
 * abzulehnen - deshalb nimmt {@link #stummBis} nur das WORT entgegen und
 * rechnet die Frist selbst.
 */
public final class Vorschlaege {

    /** „Später" - eine Vertagung, kein Nein. */
    public static final String SPAETER = "spaeter";

    /** „Ablehnen" - 7 Tage weg (§3.3 wörtlich). */
    public static final String ABGELEHNT = "abgelehnt";

    /**
     * Wie lange „Später" verstummt. Bewusst KURZ: ein Vorschlag hängt an einem
     * Fenster von HEUTE (Überschuss am Mittag, günstige Stunden heute Nacht) -
     * morgen ist es ein anderes Fenster und damit eine andere Frage.
     */
    public static final Duration SPAETER_DAUER = Duration.ofDays(1);

    /** Wie lange „Ablehnen" verstummt (§3.3: „blendet ihn 7 Tage aus"). */
    public static final Duration ABGELEHNT_DAUER = Duration.ofDays(7);

    /**
     * Die Form eines Schlüssels - dieselbe, die der DB-CHECK hält. Er wird
     * ABGELEITET (Art + Komponenten-Id), nie getippt: ein Schlüssel aus einem
     * Kundennamen wäre nicht stabil und nicht topic-sicher.
     */
    private static final String KEY_FORM = "^[a-z0-9][a-z0-9:._-]{0,127}$";

    private Vorschlaege() {
    }

    /** Warum eine Anfrage nicht ausgeführt wird - IMMER mit deutschem Grund. */
    public static final class Abgelehnt extends RuntimeException {
        public Abgelehnt(String message) {
            super(message);
        }
    }

    /** Kennt dieses Haus die Haltung? */
    public static boolean bekannt(String state) {
        return SPAETER.equals(state) || ABGELEHNT.equals(state);
    }

    /**
     * Bis wann dieser Zustand verstummt. Der EINE Ort, an dem aus dem Wort eine
     * Frist wird.
     */
    public static Instant stummBis(String state, Instant now) {
        if (SPAETER.equals(state)) {
            return now.plus(SPAETER_DAUER);
        }
        if (ABGELEHNT.equals(state)) {
            return now.plus(ABGELEHNT_DAUER);
        }
        throw new Abgelehnt("Unbekannte Auswahl - erlaubt sind „später\" und „abgelehnt\".");
    }

    /**
     * Der geprüfte Schlüssel. Ein Schlüssel ausserhalb der Form wird ABGELEHNT
     * statt zurechtgebogen: eine still veränderte Kennung träfe beim nächsten
     * Lesen einen anderen Vorschlag als den, den der Kunde weggeklickt hat.
     */
    public static String pruefeSchluessel(String key) {
        String k = key == null ? "" : key.trim();
        if (!k.matches(KEY_FORM)) {
            throw new Abgelehnt("Ungültiger Vorschlag.");
        }
        return k;
    }

    /**
     * Gilt die gespeicherte Haltung noch? Eine abgelaufene Zeile ist KEINE
     * Aussage mehr - der Vorschlag darf wieder erscheinen, ohne dass jemand
     * aufräumen muss.
     */
    public static boolean gilt(Instant mutedUntil, Instant now) {
        return mutedUntil != null && mutedUntil.isAfter(now);
    }
}
