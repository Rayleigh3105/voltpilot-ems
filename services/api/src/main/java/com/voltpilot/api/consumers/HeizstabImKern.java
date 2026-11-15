package com.voltpilot.api.consumers;

import java.util.Set;
import java.util.UUID;

/**
 * Der Heizstab-Regler als Logik des Kerns (Steuerlogik Stufe 6, Zusammenführen, dritter Teil; Vertrag
 * {@code docs/contracts/v2/steuerlogik.md}). Der Registry-Push fragt vor jedem Senden, welche Heizstäbe die Übersetzung
 * scharf führt: deren Parameterblock bleibt draußen (die Komponente bleibt {@code owner_claimed}), sonst hätte der Stab
 * zwei Herren. Die Box gibt einem Stab mit Block keinen Wunsch einer Logik; solange beides ankommt, führt der Regler.
 */
public interface HeizstabImKern {

    /**
     * Vor dem Senden: bringt die Übersetzungen der Geräte-Gruppe auf den Stand ihrer Quellen (neu übersetzen, eine
     * ohne Quelle stilllegen) und liefert den Satz neu aus, wenn sich etwas änderte - vor der Registry, damit ein Stab
     * nie ohne Herrn ist.
     */
    void angleichen(UUID siteId);

    /** Die Heizstäbe dieser Box, deren Übersetzung scharf und aktuell ist: ihr Block bleibt aus dem Push. */
    Set<UUID> imKern(UUID siteId, UUID box);
}
