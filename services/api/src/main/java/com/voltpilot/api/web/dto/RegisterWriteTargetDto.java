package com.voltpilot.api.web.dto;

import java.util.UUID;

/**
 * Ein Ziel des Geräte-Pickers im Register-Drawer (Konzept
 * {@code vp-reg-schreib-konzept-p8} §2.3).
 *
 * <p><b>Ein Gerät, das nicht beschrieben werden kann, steht trotzdem hier</b> -
 * mit {@code writable: false} und dem {@code reason}. Es wegzulassen erzeugte
 * die Frage „warum fehlt mein Gerät?" und beantwortete sie nirgends.
 *
 * @param family   die Register-Familie, aus der das Register-Wissen spricht.
 *                 {@code null} = die Box hat sie (noch) nicht gemeldet, und dann
 *                 bleibt jedes Register dort ehrlich „unbekannt".
 * @param writable eine ANZEIGE-Hilfe, keine Zusage: WAS wirklich geht,
 *                 entscheidet das Gerät.
 * @param primaryAlias ⚠ dieses Ziel NENNT eine Komponente, wird aber über die
 *                 primäre Lane erreicht (Geräteseiten Stufe 2, E4). Die Fläche
 *                 zeigt es als Komponente - eine Lane ist eine Transport-
 *                 Tatsache unserer Box, kein Begriff, den ein Kunde braucht.
 */
public record RegisterWriteTargetDto(String lane, UUID deviceId, UUID entityId, String label,
        String brand, String model, String family, String communication, String host,
        Integer port, Integer unitId, boolean writable, String reason, boolean primaryAlias) {
}
