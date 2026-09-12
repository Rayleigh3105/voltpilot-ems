package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der erwarteten Kadenz einer Quellenbindung (UEMS AP-07 IP-10,
 * {@code /api/v1/messstellen/{id}/quellen/{qid}/kadenz}) — in snake_case wie die
 * Messstellen-Schnittstelle.
 */
public final class KadenzDto {
    private KadenzDto() {}

    /**
     * {@code POST …/kadenz}. {@code erwartet_s} 1 … 86 400 s (die Schranken des Drahtvertrags),
     * {@code gueltig_ab} auf die Minute mit Versatz, fehlend = jetzt; die Vergangenheit ist erlaubt
     * und wird „rückwirkend“ markiert, die Zukunft „angekündigt“. Sie wirkt NIE rückwärts über den
     * eingetragenen Zeitpunkt hinaus.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eintragen(Integer erwartetS, OffsetDateTime gueltigAb, String grund) {}

    /**
     * Eine Fassung. {@code herkunft}: {@code bestand} = beim Umstieg aus der Mess-Selektion
     * übernommen, {@code eintrag} = von Hand eingetragen. {@code status} gegen „jetzt“ (geplant ·
     * gilt · beendet).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(
            UUID id,
            int erwartetS,
            String herkunft,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis,
            String status,
            boolean rueckwirkend,
            String begruendung,
            OffsetDateTime eingetragenAm,
            String eingetragenVon) {}

    /**
     * {@code GET …/kadenz?stichtag=}: was zum Stichtag erwartet wird, woher die Zahl kommt
     * ({@code fassung} · {@code auswahl} · {@code katalog} · {@code vorgabe}), was ohne Fassung
     * gälte ({@code vorgabe_s}) — und die ganze Historie.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kadenz(
            UUID messstelleId,
            UUID quelleId,
            UUID komponente,
            String kanal,
            OffsetDateTime stichtag,
            int erwartetS,
            String herkunft,
            int vorgabeS,
            String vorgabeHerkunft,
            Fassung gueltig,
            List<Fassung> fassungen) {}

    /** Die Antwort auf das Eintragen: die neue Fassung und die, die sie genau dort beendet hat. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorgang(Fassung fassung, Fassung beendet, MessstelleQuelleDto.Rueckwirkung rueckwirkung) {}
}
