package com.voltpilot.api.web;

import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.web.dto.MesskanalDto;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Messkanäle einer Komponente (UEMS AP-04 IP-9). Die Arbeit macht {@link MesskanalService}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS wie unter {@code /api/v1/sites/**} — eine fremde Komponente ist 404, nie 403;
 * der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/komponenten/{entityId}/messkanaele")
public class KomponenteMesskanalController {

    private final MesskanalService messkanaele;

    public KomponenteMesskanalController(MesskanalService messkanaele) {
        this.messkanaele = messkanaele;
    }

    /** Recht: {@code messwerte.ansehen}. */
    @GetMapping
    public MesskanalDto.Liste alle(@PathVariable UUID siteId, @PathVariable UUID entityId) {
        return messkanaele.messkanaele(siteId, entityId);
    }

    /** 404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
