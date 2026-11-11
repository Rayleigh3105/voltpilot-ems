package com.voltpilot.api.geraete;

import java.util.Set;

/**
 * Das geschlossene Anlass-Vokabular des Box-Lebenszyklus-Pickers (Vertrag Abschnitt 3.3/3.5): EINE
 * Stelle, geteilt von {@link BoxLoesenService} ("Vom Kunden lösen", DB-CHECK
 * {@code box_loesen_protokoll_anlass_chk}) und {@link BoxAusbauenAdminService} ("Box ausbauen",
 * DB-CHECK {@code box_ausbauen_protokoll_anlass_chk}, vp-admin-box-ausbauen) - derselbe Picker im
 * Portal ({@code ANLASS_OPTIONEN}, {@code BoxLoesenDialog.tsx}) bedient beide Einstiege desselben
 * Dialogs.
 */
public final class BoxLoesenAnlass {

    public static final Set<String> VOKABULAR =
            Set.of("falsche_kennung", "fremder_kunde", "doppelt_verbunden", "anderer_anlass");

    private BoxLoesenAnlass() {
    }
}
