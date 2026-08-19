package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * EIN Vorgang aus dem append-only Journal ({@code register_write_event}), zu
 * einer Zeile gefaltet: Anforderung UND (falls vorhanden) ihr Ergebnis.
 *
 * <p><b>Die Herkunft steht an der Zeile</b>, weil genau das die Frage ist, die
 * dieses Journal beantworten muss: {@code kunde} und {@code voltpilot} sind über
 * ein validiertes Token beweisbare Identitäten, {@code geraet} ist der
 * Wartungszugang an der Box - für den es cloud-seitig KEINE Identität gibt, und
 * genau das sagt das Wort. {@code actorName} ist der Anzeige-Name, nie die
 * Autorität.
 *
 * <p>{@code addressInput}/{@code valueInput}/{@code note} sind die vom Menschen
 * getippten Begriffe, VERBATIM.
 */
public record RegisterWriteEventDto(long id, String requestId, String source, String deviceId,
        String deviceRef, String lane, String targetLabel, String registerKind, Integer address,
        String addressHex, String addressInput, String valueInput, String note, Integer valueRaw,
        Integer expectedBefore, String registerLabel, String registerClass, String scaleNote,
        String origin, String actorName, String actorRole, boolean viaTenantSwitcher,
        Instant requestedAt, Integer beforeRaw, Integer afterRaw, Boolean adopted, String outcome,
        String reason, Instant answeredAt) {
}
