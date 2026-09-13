package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * Die Antwort des Lese-Modells „Werte je Messstelle“ (UEMS AP-08 IP-9,
 * {@code GET /api/v1/messstellen/{kennzeichen}/werte}) — snake_case wie die Messstellen-Schnittstelle.
 *
 * <p><b>Jedes Feld steht immer da, auch leer ({@code null}).</b> Eine Menge verlässt die Route nie
 * ohne ihren Zustand, ihre Abdeckung und ihre Kennzeichen; ein Feld, das „meistens leer“ ist, fehlt
 * darum trotzdem nicht. {@code null} heißt „nicht bekannt“ oder „nicht gebildet“ — nie 0.
 */
public final class MessstelleWerteDto {
    private MessstelleWerteDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Werte(
            Messstelle messstelle,
            String raster,
            String von,
            String bis,
            String zeitzone,
            String zeitzoneHerkunft,
            Integer version,
            List<Quelle> quellen,
            List<Wert> werte) {}

    /** Die Messstelle und ihre Hauptgröße — jede Zahl der Antwort steht in {@code einheit}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Messstelle(UUID id, String kennzeichen, String name, String art, String groesse,
            String richtung, String einheit, String wertart) {}

    /** Eine FÜHRENDE Bindung der Hauptgröße, die den Zeitraum berührt — nur sie liefert Werte. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Quelle(UUID id, UUID komponente, String kanal, String herleitung, String anteil,
            String gueltigAb, String gueltigBis) {}

    /**
     * Ein Schritt des Rasters.
     *
     * @param zustand das Wort des Ergebnis-Zustands-Vertrags (vollständig · unvollständig · keine
     *     Werte · mit Ersatzwert) — gespeichert als {@code menge_zustand}; {@code null} NUR zusammen mit
     *     {@code grund}
     * @param fassung {@code vorlaeufig} | {@code endgueltig} — gespeichert als {@code zustand}; eine
     *     andere Aussage als {@code zustand}
     * @param grund warum der Schritt keine Zahl trägt, obwohl die Anfrage gültig ist
     *     ({@code MessstelleWerteRegeln.OhneZahl}); {@code null}, wenn er aus der Speicherklasse kommt
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Wert(
            String von,
            String bis,
            String beschriftung,
            Long stunden,
            String tagesdauer,
            BigDecimal menge,
            BigDecimal mittel,
            BigDecimal min,
            BigDecimal max,
            String zustand,
            List<String> kennzeichen,
            Integer erhalten,
            Integer erwartet,
            Integer abdeckungProzent,
            String fassung,
            String endgueltigAb,
            Integer version,
            String gebildetAus,
            UUID quelle,
            String grund,
            List<Ereignis> ereignisse) {}

    /** Ein Verweis auf eine Meldung des Ereignis-Vertrags — Kennung, Art, Zeit; der Inhalt bleibt dort. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Ereignis(UUID id, String art, String von, String bis) {}
}
