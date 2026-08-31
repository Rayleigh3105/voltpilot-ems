package com.voltpilot.api.web;

import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.LadeparkRahmenDto;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Ladepark-RAHMEN (Verbrauchsmanagement v1 / P5, Entscheid E10) - der
 * SCHREIBWEG, und er ist admin-only.
 *
 * <p><b>Warum getrennt vom Kunden-Pfad:</b> Sicherheitsabstand,
 * Mindestleistung, Hausreserve, Wechsel-Takt und die höchste bekannte
 * Gebäudelast sind Auslegungs-Zahlen des Anschlusses, die VoltPilot beim
 * Einrichten misst - die Mockups nennen sie wörtlich „Von VoltPilot
 * eingerichtet". Der Kunde LIEST sie seit P5 (über
 * {@code GET /api/v1/sites/{siteId}/charging-config}, bis dahin konnte er das
 * nicht einmal); die EINE Zahl, die ihm gehört, bleibt die Anschlussgrenze auf
 * {@link SiteChargingConfigController}.
 *
 * <p>Wie {@link AdminTopologyController} über den {@code X-Tenant-Id}-Umschalter
 * auf dem RLS-Pfad - KEIN BYPASSRLS, eine fremde Anlage ist 404.
 *
 * <p><b>Es entsteht kein zweiter Verteiler:</b> gespeichert wird ein WUNSCH, der
 * als retained Dokument zur Box reist; gerechnet und durchgesetzt wird dort
 * (Konzept E1), und die Plausibilität gegen die eigenen Säulen prüft am Ende
 * {@code lastmgmt.Settings.Apply}.
 */
@RestController
@RequestMapping("/api/v1/admin/sites/{siteId}/charging-frame")
@PreAuthorize("hasRole('platform-admin')")
public class AdminChargingFrameController {

    private final ChargingConfigService service;

    public AdminChargingFrameController(ChargingConfigService service) {
        this.service = service;
    }

    /**
     * Setzt den Rahmen. PATCH-Semantik wie überall auf diesem Pfad: ein
     * abwesendes Feld behält den gespeicherten Wert, und ein Rumpf ohne einen
     * einzigen Wert ist eine benannte Ablehnung statt eines stillen No-ops.
     */
    @PutMapping
    public ChargingConfigDto save(@PathVariable UUID siteId,
            @Valid @RequestBody LadeparkRahmenDto frame,
            @AuthenticationPrincipal Jwt caller) {
        return service.saveFrame(siteId, frame,
                caller == null ? "unbekannt" : caller.getSubject());
    }

    /** Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper. */
    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Object> handle(ResponseStatusException e) {
        HttpStatus status = HttpStatus.valueOf(e.getStatusCode().value());
        String message = e.getReason() == null ? status.getReasonPhrase() : e.getReason();
        return ResponseEntity.status(status).body(java.util.Map.of("message", message));
    }
}
