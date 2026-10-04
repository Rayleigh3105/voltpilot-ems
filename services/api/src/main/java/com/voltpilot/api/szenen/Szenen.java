package com.voltpilot.api.szenen;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Die REINEN Regeln der Szenen (Konzept `docs/konzepte/steuerung`, E6: „ein
 * Tipp, mehrere Geräte") - Docker-frei geprüft wie {@code Vorschlaege}.
 *
 * <p>Eine Szene pausiert die Geräte, die der Kunde beim Einschalten wählt,
 * bis er sie beendet. Welche Geräte eine Szene vorschlägt, leitet das Portal
 * aus den Gerätetypen ab ({@code steuerung/szenen.ts}); der Server prüft nur
 * das Wort und die Form der Auswahl, die Geräte selbst prüft der Dienst gegen
 * die Anlage.
 */
public final class Szenen {

    /** Das geschlossene Vokabular - gleich im DB-CHECK und im Portal. */
    public static final List<String> SCHLUESSEL = List.of("urlaub", "unterwegs", "sparen");

    /** Mehr Geräte hat keine Anlage, die eine Szene sinnvoll schaltet. */
    public static final int HOECHSTENS = 50;

    private Szenen() {
    }

    /** Warum eine Anfrage nicht ausgeführt wird - IMMER mit deutschem Grund. */
    public static final class Abgelehnt extends RuntimeException {
        public Abgelehnt(String message) {
            super(message);
        }
    }

    /** Das geprüfte Wort einer Szene; nie zurechtgebogen. */
    public static String pruefeSchluessel(String key) {
        if (key == null || !SCHLUESSEL.contains(key)) {
            throw new Abgelehnt("Unbekannte Szene - erlaubt sind „Urlaub\", „Unterwegs\" und „Sparen\".");
        }
        return key;
    }

    /**
     * Die geprüfte Geräteauswahl: mindestens eines, keine Lücke, Doppeltes nur
     * einmal (Reihenfolge bleibt). Eine Szene ohne Gerät täte nichts und sähe
     * doch „an" aus.
     */
    public static List<UUID> pruefeGeraete(List<UUID> geraete) {
        if (geraete == null || geraete.isEmpty()) {
            throw new Abgelehnt("Bitte mindestens ein Gerät für die Szene wählen.");
        }
        Set<UUID> eindeutig = new LinkedHashSet<>();
        for (UUID id : geraete) {
            if (id == null) {
                throw new Abgelehnt("Ungültige Geräteauswahl.");
            }
            eindeutig.add(id);
        }
        if (eindeutig.size() > HOECHSTENS) {
            throw new Abgelehnt("Zu viele Geräte für eine Szene.");
        }
        return List.copyOf(eindeutig);
    }
}
