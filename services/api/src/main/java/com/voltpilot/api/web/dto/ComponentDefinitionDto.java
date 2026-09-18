package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonRawValue;
import java.time.Instant;
import java.util.UUID;

/**
 * EINE gespeicherte Fassung der Anbindung einer Komponente (Einheitsmodell
 * Stufe 1) - was die Fassungs-Liste und der Rollback-Dialog zeigen.
 *
 * <p>{@code connection} reist als ROHES JSON: es wird nirgends interpretiert,
 * nur durchgereicht, und ein erneutes Parsen/Serialisieren würde die
 * Feldreihenfolge still umschreiben.
 *
 * <p>{@code null} heißt überall „diese Fassung sagt dazu nichts" - nie ein
 * Ersatzwert.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ComponentDefinitionDto(
        UUID entityId,
        int version,
        String role,
        String label,
        String brand,
        String model,
        String family,
        String communication,
        @JsonRawValue String connection,
        String sourceKind,
        String templateRef,
        Integer templateVersion,
        Instant createdAt,
        String createdBy,
        String note,
        Integer slot,
        Boolean wagoAnwenderskalierung,
        Integer wagoRegister35) {
    public ComponentDefinitionDto(UUID entityId, int version, String role, String label,
            String brand, String model, String family, String communication, String connection,
            String sourceKind, String templateRef, Integer templateVersion, Instant createdAt,
            String createdBy, String note) {
        this(entityId, version, role, label, brand, model, family, communication, connection,
                sourceKind, templateRef, templateVersion, createdAt, createdBy, note, null, null, null);
    }
}
