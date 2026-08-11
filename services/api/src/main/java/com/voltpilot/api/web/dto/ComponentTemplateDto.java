package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonRawValue;
import java.math.BigDecimal;
import java.time.Instant;

/**
 * EINE Komponenten-Vorlage, wie die Lese-Route sie ausliefert (Einheitsmodell
 * Stufe 0a). In dieser Stufe konsumiert sie NICHTS - sie ist der Unterbau des
 * späteren Anlege-Assistenten.
 *
 * <p>{@code transportSchema}, {@code channels} und {@code writes} reisen als
 * ROHES JSON ({@link JsonRawValue}) - sie werden nirgends interpretiert, nur
 * durchgereicht, und ein erneutes Parsen/Serialisieren würde die Feldreihenfolge
 * und Zahlenformate der Vorlage still umschreiben.
 *
 * <p><b>Die zwei Ehrlichkeitsfelder:</b> {@code channels} und {@code writes}
 * sind {@code null}, wenn die Vorlage sie NICHT erklärt - nicht {@code []}.
 * Eine eingebaute Vorlage trägt dort immer {@code null}: ihre Kanäle entstehen
 * im Decode-Profil auf der Box, ihr Schreibweg im Steuer-Adapter. {@code []}
 * hieße „liefert keine Messwerte" bzw. „kann nichts schreiben" und wäre für
 * einen Deye-Hybriden schlicht falsch. Ebenso {@code ratedKw}: {@code null} =
 * im Katalog unbekannt, nie 0.
 *
 * @param templateRef         der stabile, OPAQUE Schlüssel - nie zerlegen
 * @param kind                Herkunft: builtin | certified (custom liefert die
 *                            Kunden-Route bis Stufe 3 nicht aus)
 * @param version             Definitions-Fassung; eingebaute bleiben auf 1
 * @param family              die Decode-Profil-Referenz (der Code, der sie ausführt)
 * @param transportSchema     das Formular je Anbindung (Feld-Vokabular), roh
 * @param controlTier         das deklarierte Steuer-PRIMITIV - autorisiert NICHTS
 * @param certificationStatus wofür die Plattform einsteht (≠ {@code kind})
 */
public record ComponentTemplateDto(
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
        Instant updatedAt) {}
