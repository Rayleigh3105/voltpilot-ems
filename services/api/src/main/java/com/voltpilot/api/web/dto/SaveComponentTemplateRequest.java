package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;

/**
 * Die Eingabe einer geprüften Vorlagen-Fassung (Einheitsmodell Stufe 6).
 *
 * <p><b>Es gibt bewusst KEIN {@code templateRef}-Feld.</b> Der Schlüssel wird
 * aus Marke + Modell abgeleitet ({@code ComponentTemplateDefinition.refFor});
 * er ist per Kontrakt opak, und wer ihn tippen ließe, machte aus einer
 * internen Kennung ein Formularfeld.
 *
 * <p>Bean-Validation deckt hier nur Anwesenheit und Länge ab - ALLE Semantik
 * liegt in {@code ComponentTemplateDefinition} (das Muster von
 * {@code SaveSelfBuildRequest}/{@code SelfBuildDefinition}), damit sie ohne
 * Spring und ohne DB prüfbar bleibt.
 *
 * <p><b>⚠ {@code channels}/{@code writes} absent lassen, wenn die Vorlage sie
 * nicht erklärt.</b> Ein leeres Array wird ABGELEHNT statt still zu NULL
 * gemacht - es wäre die Behauptung „liefert keine Messwerte" bzw. „kann nichts
 * schalten".
 */
public record SaveComponentTemplateRequest(
        @NotBlank @Size(max = 64) String brand,
        @NotBlank @Size(max = 120) String brandLabel,
        @NotBlank @Size(max = 64) String model,
        @NotBlank @Size(max = 120) String modelLabel,
        @Size(max = 64) String family,
        @Size(max = 120) String familyLabel,
        @NotBlank @Size(max = 64) String communication,
        @Size(max = 160) String communicationLabel,
        JsonNode transportSchema,
        JsonNode channels,
        JsonNode writes,
        BigDecimal ratedKw,
        Integer controlTier,
        @NotBlank @Size(max = 32) String certificationStatus,
        @Size(max = 500) String certificationNote,
        @Size(max = 500) String note) {}
