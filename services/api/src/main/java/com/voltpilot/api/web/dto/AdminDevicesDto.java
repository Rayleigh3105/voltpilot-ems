package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Das INVENTAR aller Geräte über den ganzen Lebenszyklus - der EINE additive
 * Read hinter der Plattform-Seite „Geräte" (UX-Konzept
 * {@code vp-admin-geraete-ux-k2} §4/§6, Empfehlung E1/E4).
 *
 * <p><b>Der behobene Befund: die Seite namens „Geräte-Registry" enthielt die
 * echte Flotte gar nicht.</b> Ihre Tabelle listete ausschließlich {@code VP-}
 * Aufkleber-IDs aus der Manufacturing-Registry; die realen Bestandsboxen sind
 * über selbst generierte {@code edge-}Referenzen verbunden und tauchten dort
 * mit NULL Zeilen auf. Wer „meine Geräte" suchte, fand sie nur als Nebenspalten
 * anderer Seiten - und der per-Gerät-Drawer musste an der Flotten-Matrix der
 * Update-Seite hängen, weil {@link ProvisionedDeviceDto} keine Geräte-Id trägt.
 *
 * <p>Deshalb ist eine Zeile hier die VEREINIGUNG beider Wahrheiten, verbunden
 * über die Referenz: der Registry-Eintrag (falls die ID gedruckt wurde) und das
 * verbundene Gerät (falls ein Kunde es beansprucht hat). Genau eine der beiden
 * Hälften darf fehlen - und welche, sagt die Zeile:
 * <ul>
 *   <li>{@code deviceId == null} - eine gedruckte, noch nicht verbundene
 *       Aufkleber-ID.</li>
 *   <li>{@code provisioned == false} - ein verbundenes Gerät, dessen Referenz
 *       nicht aus der Registry stammt (der Normalfall der Bestandsflotte:
 *       selbst generierte {@code edge-}Referenzen laufen per Konstruktion an
 *       der Aufkleber-Registry vorbei).</li>
 * </ul>
 *
 * <p>Die Zustands-Felder sind WORTGLEICH die der Flotten-Zeile
 * ({@link EdgeUpdatesDto.FleetRowDto}) und entstehen aus derselben Ableitung -
 * dieselbe Frage darf nicht zwei Antworten haben.
 */
public record AdminDevicesDto(List<DeviceRowDto> devices) {

    /**
     * Ein Gerät über seinen ganzen Lebenszyklus.
     *
     * <p>{@code ist} ist der gemeldete Stempel VERBATIM ({@code null} =
     * unbekannt, NIE „veraltet"); {@code soll} ist {@code null} ohne Zuweisung.
     * {@code state}/{@code reason}/{@code blocker} sind die Ableitung aus
     * {@code RolloutStates} - bei einer noch nicht verbundenen Aufkleber-ID ist
     * {@code state} {@code null}, weil es über sie schlicht nichts abzuleiten
     * gibt (sie ist noch kein Gerät).
     */
    public record DeviceRowDto(UUID deviceId, String externalRef, String label,
            UUID siteId, String siteName, UUID tenantId, String tenantName, String kind,
            String ist, String soll, Long sollSeq,
            String state, String reason, String blocker, Instant lastSeenAt, Instant reportedAt,
            boolean provisioned, String note, Instant provisionedAt,
            EdgeUpdatesDto.TrustDto trust) {
    }
}
