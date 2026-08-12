package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonRawValue;
import java.math.BigDecimal;
import java.time.Instant;

/**
 * Eine Vorlagen-FASSUNG in der Betreiber-Sicht (Einheitsmodell Stufe 6).
 *
 * <p>Reicher als {@link ComponentTemplateDto}, weil die Verwaltung andere
 * Fragen stellt als die Auswahl: sie zeigt JEDE Fassung (auch
 * zurückgezogene), wer sie eingetragen hat, und wie viele Komponenten der
 * Flotte auf diesem Schlüssel stehen.
 *
 * <p><b>⚠ {@code withdrawnAt == null} heisst „steht zur Auswahl".</b> Eine
 * zurückgezogene Fassung ist NICHT gelöscht - die Komponenten, die sie
 * benutzen, laufen unverändert weiter (der Schnappschuss an
 * {@code measurement_point} trägt keinen Fremdschlüssel).
 *
 * <p>{@code transportSchema}/{@code channels}/{@code writes} reisen als ROHES
 * JSON ({@code @JsonRawValue}), damit die Bytes unverändert ankommen; ein
 * {@code null} bleibt ein {@code null} und wird nie zu {@code []} (die
 * Ehrlichkeitsregel der zwei Spalten).
 *
 * <p><b>Bewusst OHNE {@code @JsonInclude(NON_NULL)}</b> - wie
 * {@link ComponentTemplateDto}: dieselbe Vorlage soll in Verwaltung und
 * Auswahl dieselbe Form haben, und ein {@code null} ist hier eine AUSSAGE
 * („erklärt es nicht"), kein fehlendes Feld.
 */
public record AdminComponentTemplateDto(
        String templateRef,
        String kind,
        int version,
        String brand,
        String brandLabel,
        String model,
        String modelLabel,
        String family,
        String familyLabel,
        String communication,
        String communicationLabel,
        @JsonRawValue String transportSchema,
        @JsonRawValue String channels,
        @JsonRawValue String writes,
        BigDecimal ratedKw,
        int controlTier,
        String certificationStatus,
        Instant certifiedAt,
        String certificationNote,
        String note,
        Instant createdAt,
        String createdBy,
        Instant updatedAt,
        Instant withdrawnAt,
        String withdrawnBy,
        /** Wie viele Komponenten der Flotte diesen SCHLÜSSEL benutzen (je Fassung gleich). */
        int usedByComponents) {

    /** Dieselbe Zeile mit gesetzter Nutzungszahl - die Zahl kommt aus einer eigenen Abfrage. */
    public AdminComponentTemplateDto withUsage(int used) {
        return new AdminComponentTemplateDto(templateRef, kind, version, brand, brandLabel, model,
                modelLabel, family, familyLabel, communication, communicationLabel,
                transportSchema, channels, writes, ratedKw, controlTier, certificationStatus,
                certifiedAt, certificationNote, note, createdAt, createdBy, updatedAt,
                withdrawnAt, withdrawnBy, used);
    }
}
