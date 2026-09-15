package com.voltpilot.api.web.dto;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Ein Gebäude oder einen Bereich verschieben (UEMS AP-02 IP-12, Mockups V1–V4, A1/A2/A13).
 * {@code GET /api/v1/orte/{id}/verschieben/vorschau} und {@code POST /api/v1/orte/{id}/verschieben}
 * antworten mit DERSELBEN Form {@link Verschiebung}: die Vorschau mit dem, was der Eintrag bewirken
 * würde (Protokoll leer), der Eintrag mit dem, was er bewirkt hat — die Zuordnungen frisch aus der
 * Datenbank gelesen — und seinem Protokolleintrag.
 */
public final class OrtVerschiebungDto {

    private OrtVerschiebungDto() {}

    /** Der Rumpf von {@code POST}; {@code gueltigAb} fehlend = heute in der Zeitzone des Standorts. */
    public record Anfrage(UUID zielId, LocalDate gueltigAb, String begruendung) {}

    /** Ein Knoten der Ortsstruktur; {@code art}: standort · gebaeude · bereich. */
    public record Knoten(UUID id, String art, String kurzzeichen, String name) {}

    /** Eine Zuordnung des Orts; {@code zustand}: gueltig · geplant · beendet · aufgehoben. */
    public record Zuordnung(Knoten eltern, LocalDate gueltigAb, LocalDate gueltigBis, String zustand) {}

    /** Eine Messstelle mit dem Ort, an dem sie am „gültig ab" hängt — das Verschieben ändert ihn nie. */
    public record Messstelle(UUID id, String kennzeichen, String name, Knoten ort) {}

    /** Eine Anlage mit dem Standort, dem sie am „gültig ab" zugeordnet ist — das Verschieben ändert ihn nie. */
    public record Anlage(UUID id, String name, Knoten standort) {}

    /** Ein Netzanschluss, an dem eine bleibende Anlage am „gültig ab" hängt. */
    public record Netzanschluss(UUID id, String kennzeichen) {}

    /**
     * Die Folgen-Karte (E11, A13) — genau das Urteil von {@code OrtsbaumAbleitung.verschiebenFolgen},
     * in seiner Reihenfolge, mit IDs und Namen: was MITZIEHT (Kinder und die Messstellen, deren Standort
     * sich abgeleitet ändert) und was BLEIBT (Anlagen, ihre Netzanschlüsse, ihre übrigen Messstellen).
     */
    public record Folgen(
            List<Knoten> ziehenMit,
            List<Messstelle> messstellenWechselnStandort,
            List<Anlage> bleibenAnlagen,
            List<Netzanschluss> bleibenNetzanschluesse,
            List<Messstelle> bleibenMessstellen) {}

    /** Tage, {@code bis} einschließlich. */
    public record Zeitraum(LocalDate von, LocalDate bis) {}

    /** Der geschriebene Eintrag in {@code ort_aenderung}: Zeit · was · gilt ab · wer (V4). */
    public record Eintrag(long id, String objektArt, UUID objektId, String text, LocalDate giltAb,
            boolean rueckwirkend, String wer, OffsetDateTime eingetragenAm) {}

    /**
     * @param bisher der Elternknoten am „gültig ab" OHNE das Verschieben
     * @param bisherStandort der Standort am „gültig ab" ohne das Verschieben
     * @param neu das Ziel
     * @param neuStandort der Standort des Ziels am „gültig ab" (beim Standort er selbst)
     * @param gueltigBis das Ende der neuen Zuordnung (von der laufenden geerbt); {@code null} = offen
     * @param danach der Elternknoten der schon geplanten Zuordnung ab {@code gueltigBis + 1}; sonst {@code null}
     * @param rueckwirkendBetroffen nur rückwirkend: die Tage, die NACHTRÄGLICH anders zählen
     * @param zuordnungen alle Zuordnungen des Orts NACH dem Eintrag, nach Beginn
     * @param befehle wie viele Befehle das Verschieben sendet — immer 0
     * @param protokoll in der Vorschau leer; nach dem Eintrag genau einer, am Ort
     */
    public record Verschiebung(
            UUID ortId,
            String art,
            String kurzzeichen,
            String name,
            Knoten bisher,
            Knoten bisherStandort,
            Knoten neu,
            Knoten neuStandort,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            Knoten danach,
            OrtDto.Rueckwirkung rueckwirkung,
            Zeitraum rueckwirkendBetroffen,
            List<Zuordnung> zuordnungen,
            Folgen folgen,
            int befehle,
            String begruendung,
            List<Eintrag> protokoll) {}
}
