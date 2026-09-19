package com.voltpilot.api.uems;

import com.voltpilot.api.uems.FunktionZustandAbleitung.Zustand;
import java.util.List;

/**
 * Der Kundenhinweis zur Ruhe an der zuständigen Box (AP-14, X7/W12).
 *
 * <p>Die zuständige Box ist dieselbe führende Box, an die der Registry-Push mit der Ruhe geht. Eine
 * andere Box der Anlage darf das Urteil nicht verändern. {@code faehig == null} heißt unbekannt und
 * beweist die Fähigkeit nicht. Ohne zuständige Box gibt es dagegen keine „diese Box“, über die die
 * Fläche etwas behaupten dürfte.
 */
public final class RuheHinweisRegel {

    public static final String FAEHIGKEIT = "automation_paused_until_revoked";

    private RuheHinweisRegel() {}

    /** Eine Box der Anlage; genau eine kann das Zustellziel sein. */
    public record Box(boolean zustaendig, Boolean faehig) {}

    /** Der Hinweis im aktuellen Zustand und im Bestätigungsweg fürs Anhalten. */
    public record Ergebnis(boolean jetzt, boolean beimAnhalten) {}

    /**
     * Eine reine Entscheidung. Eingerichtet und angehalten tragen die Ruhe ohne Ende; eine erlaubte
     * Aktion „anhalten“ setzt sie gerade. Nur die Fähigkeit der zuständigen Box zählt.
     */
    public static Ergebnis ableiten(Zustand zustand, boolean anhaltenErlaubt, List<Box> boxen) {
        Box ziel = boxen.stream().filter(Box::zustaendig).findFirst().orElse(null);
        boolean schwaechereZusage = ziel != null && !Boolean.TRUE.equals(ziel.faehig());
        boolean inRuhe = zustand == Zustand.ENTWURF || zustand == Zustand.EINGERICHTET
                || zustand == Zustand.ANGEHALTEN;
        return new Ergebnis(inRuhe && schwaechereZusage, anhaltenErlaubt && schwaechereZusage);
    }
}
