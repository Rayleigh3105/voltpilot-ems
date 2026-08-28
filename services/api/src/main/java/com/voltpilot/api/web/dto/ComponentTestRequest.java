package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Map;
import java.util.UUID;

/**
 * „Verbindung testen" im Anlege-Assistenten (Einheitsmodell Stufe 1): das
 * NOCH NICHT gespeicherte Formular, das die Box einmal ausprobieren soll.
 *
 * <p>Es geht über den Probe-Kanal (Stufe 0b) an dieselbe Box-Maschinerie, die
 * die {@code :8484}-Taste seit je benutzt - es gibt bewusst keinen zweiten
 * Test, der etwas anderes sagen könnte als das Gerät selbst.
 *
 * @param deviceId optional - die Box, die fragen soll. Fehlt sie, muss die
 *                 Anlage genau EIN Gerät haben; bei mehreren wird nicht geraten.
 */
public record ComponentTestRequest(
        @NotBlank @Size(max = 200) String templateRef,
        @jakarta.validation.constraints.Positive Integer templateVersion,
        @Size(max = 40) String role,
        Map<String, Object> connection,
        UUID deviceId,
        /** Bestehende Komponente beim Bearbeiten; nur dann werden maskierte Secrets ergänzt. */
        UUID entityId) {

    public ComponentTestRequest(String templateRef, String role,
            Map<String, Object> connection, UUID deviceId) {
        this(templateRef, null, role, connection, deviceId, null);
    }
}
