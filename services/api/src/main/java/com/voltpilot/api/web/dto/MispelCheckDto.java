package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.mispel.MispelCheckRepository.Zeile;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Die Antwort von {@code GET /api/v1/sites/{siteId}/mispel-check} (MiSpeL MP-48), snake_case wie der Vertrag
 * {@code docs/contracts/v2/mispel-check.md} § 5. Ohne Zeile: Stand {@code wird_gerechnet}, nie ein Betrag.
 */
public final class MispelCheckDto {

    private MispelCheckDto() {}

    private static final ObjectMapper LESER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);

    /** Unterschied im Jahr = mit Abgrenzungsoption − heute, €/Jahr je Annahmen-Fall (Vertrag § 2). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Differenz(BigDecimal niedrigEur, BigDecimal mittelEur, BigDecimal hochEur) {}

    /** Ein Posten mit Vorzeichen je Fall (Vertrag § 3). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Posten(String art, BigDecimal niedrigEur, BigDecimal mittelEur, BigDecimal hochEur,
            String herkunft) {}

    /** Eine Angabe, aus der gerechnet wurde: gemessen · stammdaten · angenommen (Vertrag § 4). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Angabe(String angabe, JsonNode wert, String einheit, String herkunft, String quelle) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ansicht(UUID siteId, String stand, Instant standSeit, String formelsatz, LocalDate fensterVon,
            LocalDate fensterBis, Differenz differenz, List<Posten> posten, List<Angabe> datenbasis,
            String hinweis) {}

    /** Ohne Zeile: noch nie gerechnet — „wird gerechnet“, nicht 404 (die Anlage gibt es). */
    public static Ansicht wirdGerechnet(UUID siteId) {
        return new Ansicht(siteId, "wird_gerechnet", null, null, null, null, null, List.of(), List.of(), null);
    }

    public static Ansicht aus(Zeile z) {
        boolean fertig = "fertig".equals(z.stand());
        Differenz d = fertig ? new Differenz(z.differenzNiedrigEur(), z.differenzMittelEur(), z.differenzHochEur())
                : null;
        return new Ansicht(z.siteId(), z.stand(), z.standSeit(), z.formelsatz(), z.fensterVon(), z.fensterBis(), d,
                liste(z.posten(), new TypeReference<List<Posten>>() {}),
                liste(z.datenbasis(), new TypeReference<List<Angabe>>() {}), z.hinweis());
    }

    private static <T> List<T> liste(String json, TypeReference<List<T>> typ) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            List<T> l = LESER.readValue(json, typ);
            return l == null ? List.of() : List.copyOf(l);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("site_mispel_check: Liste nicht lesbar", e);
        }
    }
}
