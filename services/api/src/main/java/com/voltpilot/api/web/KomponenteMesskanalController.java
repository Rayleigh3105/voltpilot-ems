package com.voltpilot.api.web;

import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.uems.MessstelleQuelleService;
import com.voltpilot.api.web.dto.MesskanalDto;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
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

    /**
     * Recht: {@code messwerte.ansehen}. {@code stichtag} (optional, IP-13): der Zeitpunkt, zu dem
     * {@code speist} die laufenden Quellenbindungen nennt — ein Zeitpunkt mit Versatz oder ein Tag
     * (dann dessen Beginn in Europe/Berlin); fehlend = jetzt.
     */
    @GetMapping
    public MesskanalDto.Liste alle(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @RequestParam(required = false) String stichtag) {
        Instant am;
        try {
            am = MessstelleQuelleService.stichtag(stichtag, Instant.now());
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der Stichtag ist ein Zeitpunkt (2026-11-18T10:40:00+01:00) oder ein Tag (2026-11-18).");
        }
        return messkanaele.messkanaele(siteId, entityId, am);
    }

    /** 404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
