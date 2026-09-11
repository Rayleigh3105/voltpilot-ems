package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Einstellungs-Schnittstelle (UEMS AP-04 IP-11,
 * {@code /api/v1/geraete/{id}/einstellungen}) — in snake_case wie die übrigen UEMS-Schnittstellen,
 * Zeitpunkte auf die Minute mit dem Versatz von Europe/Berlin.
 *
 * <p>Fakten UND die Sätze des Vertrags: {@code anwendung}/{@code zustellung}/{@code status} sind die
 * Wörter aus {@code quelle-einstellung-vectors.json}, {@code wert_text}/{@code anwendung_text} und
 * {@code folgen} sind dieselben Kundensätze, die {@code src/uemsEinstellung.ts} der Geräteseite
 * (IP-12) daraus bildet.
 */
public final class EinstellungDto {
    private EinstellungDto() {}

    /**
     * Die Einstellungen eines Einbaus: {@code gueltig} — je Quelle und Art die zum Stichtag gültige
     * Fassung; {@code historie} — alle Fassungen, nach Quelle, Art und Beginn.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einstellungen(
            UUID geraetId,
            String geraet,
            String einbau,
            OffsetDateTime stichtag,
            List<Fassung> gueltig,
            List<Fassung> historie) {}

    /**
     * Eine Fassung. Die Quelle ist der Einbau selbst ({@code entity_id == null}), eine Komponente,
     * die er speist, oder ein Kanal dieser Komponente. {@code zustellung}: {@code verbindung} (die Box
     * wendet sie mit der Verbindung an), {@code ausstehend} (angewendet eingetragen, Zustellung AP-06)
     * oder {@code null} (im Gerät eingestellt, nur dokumentiert). {@code gueltig_bis == null}: bis
     * auf Weiteres.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(
            UUID id,
            UUID entityId,
            String kanal,
            String art,
            String artKundenwort,
            JsonNode wert,
            String wertText,
            String anwendung,
            String anwendungText,
            String zustellung,
            String herkunft,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis,
            String status,
            OffsetDateTime tatsaechlichAb,
            boolean rueckwirkend,
            String begruendung,
            Eintrag eingetragen) {}

    /** Wer die Fassung wann eingetragen hat (das Protokoll an der Quelle); VoltPilot selbst beim Bestand. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eintrag(
            OffsetDateTime am,
            String von,
            String rolle,
            String art) {}

    /**
     * Eine neue Fassung. {@code entity_id}/{@code kanal} leer: sie gilt für den Einbau. Pflicht sind
     * {@code art}, {@code wert}, {@code anwendung} und {@code gueltig_ab} (auf der Minute);
     * {@code tatsaechlich_ab}: wann die Änderung wirklich geschah, wenn früher.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Neu(
            UUID entityId,
            String kanal,
            String art,
            JsonNode wert,
            String anwendung,
            OffsetDateTime gueltigAb,
            OffsetDateTime tatsaechlichAb,
            String begruendung) {}

    /**
     * Die eingetragene Fassung, die Fassung, die sie beendet hat (oder {@code null}), die Folgen-Sätze
     * (§5.7) und die Messstellen, an denen sie protokolliert ist — jede, deren Quellenbindung zum Beginn
     * der Fassung aus der Quelle liest.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eingetragen(
            Fassung fassung,
            Fassung beendet,
            List<String> folgen,
            List<String> messstellen) {}
}
