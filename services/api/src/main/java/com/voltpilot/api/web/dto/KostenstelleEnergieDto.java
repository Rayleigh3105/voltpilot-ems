package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Antwort der Kostenstellen-Sicht (UEMS AP-10 IP-11, {@code GET /api/v1/unternehmen/kostenstellen/{id}/energie}) —
 * snake_case wie die Bilanz-Schnittstelle.
 *
 * <p><b>Jedes Feld steht immer da, auch leer ({@code null}).</b> {@code null} heißt „keine Menge“ und nie 0 — der
 * {@code grund} sagt, warum. {@code nicht_verteilt} gehört KEINER Kostenstelle und zählt in {@code summe} nie mit.
 */
public final class KostenstelleEnergieDto {
    private KostenstelleEnergieDto() {}

    /**
     * @param version die angefragte Version ({@code null} = die neueste je Tag); {@code n} = je Tag die höchste
     *     Version bis n — mit 1 die Zahlen, wie sie vor jeder Korrektur galten
     * @param berechnetAm wann diese Sicht gebildet wurde — verteilte Werte werden nie gespeichert
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Energie(
            Kostenstelle kostenstelle,
            String periode,
            LocalDate am,
            LocalDate von,
            LocalDate bis,
            String zeitzone,
            Integer version,
            String berechnetAm,
            Block gemessen,
            Block verteilt,
            Block berechnet,
            Block summe,
            Block nichtVerteilt) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Kostenstelle(UUID id, String kennzeichen, String name, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Eine Herkunft (oder die Summe der drei): {@code menge}/{@code einheit}/{@code zustand} nur bei GENAU einer Größe;
     * {@code grund} {@code keine_zuordnung} (keine Posten) oder {@code groessen_gemischt} (je Größe eine Summe).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Block(BigDecimal menge, String einheit, String zustand, String grund, List<Summe> summen,
            List<Posten> posten) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Summe(String groesse, String richtung, String einheit, BigDecimal menge, String zustand,
            Integer abdeckungProzent, int vorhanden, int gesamt, List<String> fehlend) {}

    /**
     * Eine Messstelle in einer Herkunft.
     *
     * @param herkunft der Satz nach {@code bilanzwert-herkunft.schema.json} (Art {@code verteilt}); bei
     *     {@code nicht_verteilt} {@code null} — dort gibt es keine Verteilung, die Herkunft ist die der Messstelle
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Posten(MessstelleRef messstelle, String groesse, String richtung, String einheit, BigDecimal menge,
            String zustand, Integer abdeckungProzent, int version, List<String> kennzeichen, List<Integer> fassungen,
            List<String> fehlend, List<Tag> tage, Map<String, Object> herkunft) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record MessstelleRef(UUID id, String kennzeichen, String name, String art) {}

    /** Ein Tagesanteil: der Tageswert der Quelle, der Anteil DIESES Tages und die Menge daraus. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Tag(LocalDate tag, BigDecimal anteilProzent, BigDecimal quelleMenge, BigDecimal menge,
            String zustand, Integer abdeckungProzent, int version, String grund) {}
}
