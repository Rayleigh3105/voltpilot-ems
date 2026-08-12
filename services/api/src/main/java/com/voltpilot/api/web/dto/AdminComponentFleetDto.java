package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Die Komponenten-Welt der Flotte in EINER Antwort (Einheitsmodell Stufe 6).
 *
 * <p>Read-only. Sie beantwortet die drei Betriebsfragen, die bis hierher nur
 * je Anlage beantwortbar waren: <b>wo wird gepflegt</b> (portal- oder
 * box-verwaltet), <b>woher stammen die Komponenten</b> (Katalog, geprüfte
 * Vorlage, Selbstbau, Plattform-Komposition), und <b>wo steht Soll ≠ Ist</b>.
 *
 * <p><b>⚠ Jede Zahl ist gemessen, keine geraten.</b> Wo die Box nichts
 * gemeldet hat, steht {@code null} - „unbekannt", nie 0 und nie
 * „nicht angekommen".
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AdminComponentFleetDto(List<FleetSiteRow> sites) {

    /**
     * Eine Anlage.
     *
     * @param syncStatus {@code in_sync} · {@code pending} · {@code unreported} -
     *     wörtlich das Vokabular der Kunden-Fläche
     *     ({@code ComponentService.syncStatus}), damit Flotten-Sicht und
     *     Anlagen-Fläche nie Verschiedenes behaupten
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FleetSiteRow(
            UUID siteId,
            String siteName,
            UUID tenantId,
            String tenantName,
            String componentAuthority,
            Instant componentsAdoptedAt,
            String componentsAdoptedBy,
            int componentCount,
            ComponentSourceCounts sources,
            int privateTemplates,
            String syncStatus,
            String refusedRevision,
            String refusedReason,
            Instant appliedAt,
            WriteAccess write) {}

    /** Die Herkunft der Anbindungen. {@code unknown} = vor der Vorlagen-Zeit entstanden. */
    public record ComponentSourceCounts(int builtin, int certified, int custom, int composed,
            int unknown) {}

    /**
     * Wer das Schreiben freigegeben hat - die drei Freigabe-Stufen des
     * Konzepts (§3.3) in EINER Anzeige.
     *
     * @param platformActivated wie viele Geräte plattform-scharfgeschaltet sind
     *     (Stufe 1: Register + Scharfschaltung je Anlage)
     * @param templateWrites wie viele Komponenten auf einer VORLAGE stehen, die
     *     eine Schreib-Definition trägt (Stufe 2: geprüfte Vorlage)
     * @param certSource was das GERÄT über die Herkunft seiner Freigabe meldet
     *     ({@code env} · {@code device} · {@code platform}); {@code null} =
     *     unbekannt, NIE „nicht zertifiziert"
     * @param controlPoints wie viele Komponenten überhaupt einen Steuer-Anspruch
     *     tragen ({@code measurement_point.control})
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WriteAccess(int controlPoints, int platformActivated, int templateWrites,
            String certSource, String platformCertVerdict, String platformCertModel) {}
}
