package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonRawValue;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Die Komponenten EINER Anlage, wie der Anlagen-Modell-Assistent sie liest
 * (Einheitsmodell Stufe 1).
 *
 * @param componentAuthority WER die Geräte-Konfiguration dieser Anlage besitzt
 *     ({@code box} | {@code portal}). Die Oberfläche bietet den Assistenten nur
 *     auf einer portal-verwalteten Anlage an - eine Sackgasse („speichern geht,
 *     wirkt aber nie") wäre schlimmer als ein ehrlich abwesender Knopf.
 * @param sollRevision die zuletzt komponierte Push-Revision (das SOLL). Zusammen
 *     mit {@link ComponentRowDto#appliedRevision} beantwortet sie „läuft auf dem
 *     Gerät" vs. „Änderung unterwegs". {@code null} = nie gepusht.
 * @param appliedRevision die Revision, die die BOX zuletzt wirklich angewandt
 *     hat (aus ihrem Herzschlag). {@code null} = die Box hat sich dazu noch
 *     nicht geäußert - „unbekannt", nie „nicht angekommen".
 * @param appliedAt wann die Box das gemeldet hat
 * @param refusedRevision/refusedReason die LETZTE Ablehnung der Box, im Klartext.
 *     Sie steht NEBEN {@code appliedRevision}, nie an seiner Stelle: was läuft,
 *     ist weiterhin die zuletzt angewandte Fassung, und das Gegenteil zu
 *     behaupten wäre die Erfindung, die dieses Haus nicht macht.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SiteComponentsDto(
        String componentAuthority,
        String sollRevision,
        String appliedRevision,
        Instant appliedAt,
        String refusedRevision,
        String refusedReason,
        List<ComponentRowDto> components) {

    /**
     * EINE Komponente mit ihrer geltenden Anbindung.
     *
     * @param connection roh durchgereicht (siehe {@link ComponentDefinitionDto})
     * @param syncStatus {@code in_sync} | {@code pending} | {@code unreported} -
     *     abgeleitet aus Soll- und Ist-Revision, nie geraten
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ComponentRowDto(
            UUID id,
            String role,
            String entityType,
            String label,
            String brand,
            String model,
            String family,
            String communication,
            @JsonRawValue String connection,
            String sourceKind,
            String templateRef,
            Integer templateVersion,
            int definitionVersion,
            BigDecimal capacityKwp,
            String edgeSourceId,
            String syncStatus) {}
}
