package com.voltpilot.api.web;

import com.voltpilot.api.chargers.ChargingBoostService;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * „Jetzt voll laden" - die EINE Kunden-Aktion der Ladepunkt-Fläche, die eine
 * Zuteilung bewegt (OCPP-Lastmanagement Stufe 4).
 *
 * <p><b>Sie ist ausdrücklich KEINE Ladegrenze</b>, und deshalb steht sie in einer
 * eigenen Klasse neben dem read-only {@link SiteChargerController}: sie nimmt
 * EINEN laufenden Ladevorgang von der QUELLEN-Politik des Kunden aus, damit er
 * auch Netzstrom ziehen darf. Grenzen entstehen weiterhin allein im
 * Lastmanagement auf der Box - der Waechter einer physischen Grenze darf nicht
 * am WAN haengen (Konzept E1), und diese Flaeche wird nie ein zweiter,
 * unarbitrierter Schreiber auf eine Kundenanlage.
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route: KEIN
 * {@code @PreAuthorize}, Authentifizierung + RLS sind der Zaun, eine fremde
 * Anlage ist 404, Admins über den {@code X-Tenant-Id}-Umschalter.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteChargingBoostController {

    /**
     * Der Rumpf. {@code minutes} ist optional (abwesend = der 4-Stunden-Deckel);
     * ein größerer Wunsch wird geklemmt, nie abgelehnt. {@code action} wählt die
     * Richtung ({@code voll} | {@code pause}) - ABWESEND = {@code voll}, also ist
     * ein älterer Client zeichengleich wie vorher.
     */
    public record BoostRequest(@Size(max = 64) String chargePointId,
            @Min(1) @Max(64) int connectorId, @Min(1) @Max(240) Integer minutes, boolean cancel,
            @Size(max = 16) String action) {}

    private final ChargingBoostService service;

    public SiteChargingBoostController(ChargingBoostService service) {
        this.service = service;
    }

    @PostMapping("/charging-boost")
    @Recht(value = "handeingriff.setzen", ziel = RechtZiel.ANLAGE)
    public ChargingBoostService.BoostResult boost(@PathVariable UUID siteId,
            @Valid @RequestBody BoostRequest req, @AuthenticationPrincipal Jwt caller) {
        return service.boost(siteId, req.chargePointId(), req.connectorId(), req.minutes(),
                req.cancel(), ChargingBoostService.Action.of(req.action()),
                caller == null ? "unbekannt" : caller.getSubject());
    }

    /** Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper. */
    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Object> handle(ResponseStatusException e) {
        HttpStatus status = HttpStatus.valueOf(e.getStatusCode().value());
        String message = e.getReason() == null ? status.getReasonPhrase() : e.getReason();
        return ResponseEntity.status(status).body(Map.of("message", message));
    }
}
