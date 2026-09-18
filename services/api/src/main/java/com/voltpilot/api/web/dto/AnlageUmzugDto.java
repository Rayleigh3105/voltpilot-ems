package com.voltpilot.api.web.dto;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Eine Anlage einem Standort zuordnen oder umziehen (UEMS AP-02 IP-11, Mockup T6, A11).
 * {@code GET /api/v1/sites/{id}/standort/vorschau} und {@code PUT /api/v1/sites/{id}/standort}
 * antworten mit DERSELBEN Form {@link Umzug}: die Vorschau mit dem, was der Eintrag bewirken
 * würde (Protokoll leer), der Eintrag mit dem, was er bewirkt hat — die Zuordnungen frisch aus
 * der Datenbank gelesen — und seinen Protokolleinträgen.
 */
public final class AnlageUmzugDto {

    private AnlageUmzugDto() {}

    /** Der Rumpf von {@code PUT}; {@code gueltigAb} fehlend = heute in der Zeitzone des Ziels. */
    public record Anfrage(UUID standortId, LocalDate gueltigAb, String begruendung) {}

    public record StandortRef(UUID id, String kurzzeichen, String name) {}

    /** Eine Zuordnung der Anlage; {@code zustand}: gueltig · geplant · beendet · aufgehoben. */
    public record Zuordnung(StandortRef standort, LocalDate gueltigAb, LocalDate gueltigBis, String zustand) {}

    /** Der Netzanschluss, an dem die Anlage am „gültig ab" hängt — die Zuordnung ändert ihn nicht. */
    public record Netzanschluss(UUID id, String kennzeichen) {}

    /**
     * Die Teilnahme der Anlage an „Steuern &amp; Optimieren" und der Standort IHRER Funktion — die
     * erste Zuordnung einer Bestandsanlage kann sie anlegen; ein späterer Umzug ändert sie nicht.
     */
    public record Teilnahme(String funktion, String zustand, StandortRef standort) {}

    /** Ein geschriebener Eintrag in {@code ort_aenderung}. */
    public record Eintrag(long id, String objektArt, UUID objektId) {}

    /**
     * @param bisher der Standort am „gültig ab" OHNE die Zuordnung; {@code null} = noch keiner
     * @param gueltigBis das Ende der neuen Zuordnung (von der laufenden geerbt); {@code null} = offen
     * @param danach die schon geplante Zuordnung ab {@code gueltigBis + 1}; {@code null} = keine
     * @param zuordnungen alle Zuordnungen der Anlage NACH dem Eintrag, nach Beginn
     * @param bleibt was die Zuordnung nie berührt (Codes, feste Reihenfolge) — {@code box} nur mit
     *     Box, {@code ladepark_rahmen} nur mit Ladepark-Rahmen
     * @param befehle wie viele Befehle die Zuordnung an die Anlage sendet — immer 0 (A11)
     * @param protokoll in der Vorschau leer; nach dem Eintrag Anlage, neuer und bisheriger Standort
     */
    public record Umzug(
            UUID anlageId,
            String anlageName,
            StandortRef bisher,
            StandortRef neu,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            StandortRef danach,
            OrtDto.Rueckwirkung rueckwirkung,
            List<Zuordnung> zuordnungen,
            List<String> bleibt,
            int boxen,
            Netzanschluss netzanschluss,
            Teilnahme steuern,
            int befehle,
            String begruendung,
            List<Eintrag> protokoll) {}
}
