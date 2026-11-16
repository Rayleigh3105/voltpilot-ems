package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * Das Update der eigenen Box (Erstverbindung S2, {@code ota.BoxUpdateSicht}).
 *
 * @param phase        {@code keins}, {@code prueft}, {@code laedt}, {@code startet_neu},
 *                     {@code prueft_box}, {@code fertig} oder {@code spaeter}
 * @param release      die neue Fassung (bei „fertig" die eingespielte)
 * @param seit         Beginn der Phase: erste Meldung oder Zuweisung (Serverzeit)
 * @param fertigAm     wann die Box die neue Fassung bestätigt hat
 * @param updateLaeuft irgendein Update startet die Box gleich neu (die Gerätesuche wartet)
 */
public record BoxSoftwareUpdateDto(String phase, String release, Instant seit, Instant fertigAm,
        boolean updateLaeuft) {
}
