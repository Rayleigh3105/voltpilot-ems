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
 */
public record RegisterWriteTargetDto(String lane, UUID deviceId, UUID entityId, String label,
        String brand, String model, String family, String communication, String host,
        Integer port, Integer unitId, boolean writable, String reason) {
}
