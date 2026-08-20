package com.voltpilot.api.web;

import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Lastmanagement-Konfiguration einer Anlage: die Anschlussgrenze, die der
 * Aktivieren-Dialog der Steuerungs-Karte abfragt, und die Vorrang-Wahl je Säule
 * (Lastmanagement Stufe 3, PR 12).
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route: KEIN
 * {@code @PreAuthorize}, Authentifizierung + RLS sind der Zaun, eine fremde
 * Anlage ist 404, Admins über den {@code X-Tenant-Id}-Umschalter.
 *
 * <p><b>Es ist eine WUNSCH-Route, kein Steuerpfad.</b> Was hier gespeichert
 * wird, reist als retained Dokument zur Box; GERECHNET und DURCHGESETZT wird
 * dort (Konzept E1). Der Kunde besitzt genau die zwei Größen, die ihm gehören:
 * seinen Anschluss und die Frage, welches Fahrzeug zuerst laden soll -
 * Sicherheitsabstand, Mindestleistung und die höchste Gebäudelast bleiben „von
 * VoltPilot eingerichtet" auf der Box.
 *
 * <p><b>PATCH-Semantik:</b> ein abwesendes Feld behält den gespeicherten Wert.
 * Ein Dialog, der nur den Vorrang stellt, darf die Anschlussgrenze nicht
 * löschen.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteChargingConfigController {

    /** Der Rumpf: beide Felder OPTIONAL (PATCH-Semantik). */
    public record SaveChargingConfigRequest(Double gridLimitKw,
            @Size(max = 64) List<@Size(max = 64) String> priorityChargePointIds,
            /*
             * Stufe 4: die QUELLEN-Wahl. Beide optional wie alles hier - ein
             * abwesendes Feld behält den gespeicherten Wert, und ein Dialog,
             * der nur die Priorität stellt, darf die Grenze nicht löschen.
             */
            @Size(max = 32) String surplusPolicy, @Size(max = 32) String storagePriority) {}

    private final ChargingConfigService service;

    public SiteChargingConfigController(ChargingConfigService service) {
        this.service = service;
    }

    @GetMapping("/charging-config")
    public ChargingConfigDto read(@PathVariable UUID siteId) {
        return service.read(siteId);
    }

    @PutMapping("/charging-config")
    public ChargingConfigDto save(@PathVariable UUID siteId,
            @Valid @RequestBody SaveChargingConfigRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return service.save(siteId, req.gridLimitKw(), req.priorityChargePointIds(),
                req.surplusPolicy(), req.storagePriority(),
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
