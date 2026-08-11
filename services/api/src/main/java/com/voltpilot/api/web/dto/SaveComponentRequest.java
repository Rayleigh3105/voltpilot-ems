package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.Map;

/**
 * Was der Anlege-Assistent speichert (Einheitsmodell Stufe 1, Konzept
 * vp-komponenten-einheit-h2 §4.1): eine Komponente = eine Vorlage + ihre
 * Verbindung + ihre Rolle.
 *
 * <p><b>Der Mandant steht NICHT im Rumpf</b> - er kommt aus dem JWT, und RLS'
 * WITH CHECK sorgt dafür, dass die Zeile in genau diesem Mandanten landet (die
 * Regel jeder {@code /sites/**}-Route).
 *
 * <p><b>{@code templateRef} ist OPAK</b> und wird nie zerlegt: Marke, Modell,
 * Familie und die Kommunikationsart holt der Server AUS der Vorlage. Ein Client
 * kann damit keine widersprüchliche Anbindung schicken - dieselbe Garantie, die
 * die Box mit ihrer eigenen Katalog-Normalisierung gibt.
 *
 * @param connection  die Felder aus dem {@code transport_schema} der Vorlage
 *                    (IP/Port/Serial/Unit-ID …), unverändert durchgereicht
 * @param capacityKwp nur für einen Erzeuger; sonst ignoriert
 * @param intervalS   optionaler Lese-Abstand; leer = die Vorgabe der Box
 */
public record SaveComponentRequest(
        @NotBlank @Size(max = 200) String templateRef,
        @Size(max = 200) String label,
        @NotBlank @Size(max = 40) String role,
        Map<String, Object> connection,
        @Positive BigDecimal capacityKwp,
        Integer intervalS,
        @Size(max = 200) String note) {}
