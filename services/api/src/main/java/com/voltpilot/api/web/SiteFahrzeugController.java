package com.voltpilot.api.web;

import com.voltpilot.api.fahrzeuge.FahrzeugService;
import com.voltpilot.api.fahrzeuge.FahrzeugSteuerart;
import com.voltpilot.api.web.dto.FahrzeugDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die FAHRZEUGE einer Anlage (Verbrauchsmanagement v1 / P7).
 *
 * <p>Mandantenbezogen wie jede {@code /sites/**}-Route: KEIN
 * {@code @PreAuthorize} - Authentifizierung und Postgres-RLS sind der Zaun,
 * eine fremde Anlage ist <b>404, nie 403</b>. Ein Plattform-Admin erreicht sie
 * über den {@code X-Tenant-Id}-Umschalter, wie überall.
 *
 * <p>⚠ Es ist eine KUNDEN-Route, obwohl sie mit Pseudonymen arbeitet: eine
 * Ladekarte gehört dem Kunden, und der Bezug ist per Konstruktion kein
 * Klartext. Der ops-seitige OCPP-Journal-Pfad bleibt davon unberührt - er
 * führt seine EIGENEN, anders gepfefferten Bezüge und wird mit diesen hier
 * bewusst nicht verbunden.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/fahrzeuge")
public class SiteFahrzeugController {

    private final FahrzeugService service;

    public SiteFahrzeugController(FahrzeugService service) {
        this.service = service;
    }

    /**
     * Der Wunsch des Dialogs. Jedes Feld ist EINZELN optional:
     * {@code name == null} heißt „am Namen nichts ändern",
     * {@code quelle == null} heißt „an der Steuerart nichts ändern".
     * Ein leerer Name LÖSCHT ihn - dieselbe Semantik wie überall im Haus.
     */
    public record FahrzeugRequest(@Size(max = 200) String name, @Size(max = 40) String quelle,
            @Size(max = 40) String ueberschussModus, BigDecimal mindestleistungKw) {}

    @GetMapping
    public FahrzeugDto list(@PathVariable UUID siteId) {
        return service.read(siteId);
    }

    @PutMapping("/{tagRef}")
    @Recht(value = "ladepunkt.betrieb", ziel = RechtZiel.ANLAGE)
    public FahrzeugDto save(@PathVariable UUID siteId, @PathVariable String tagRef,
            @RequestBody FahrzeugRequest body, @AuthenticationPrincipal Jwt jwt) {
        FahrzeugRequest b = body == null ? new FahrzeugRequest(null, null, null, null) : body;
        return service.speichere(siteId, tagRef,
                new FahrzeugSteuerart.Wunsch(b.name(), b.quelle(), b.ueberschussModus(),
                        b.mindestleistungKw()),
                actor(jwt));
    }

    @DeleteMapping("/{tagRef}")
    @Recht(value = "ladepunkt.betrieb", ziel = RechtZiel.ANLAGE)
    public FahrzeugDto delete(@PathVariable UUID siteId, @PathVariable String tagRef,
            @AuthenticationPrincipal Jwt jwt) {
        return service.entferne(siteId, tagRef, actor(jwt));
    }

    private static String actor(Jwt jwt) {
        if (jwt == null) {
            return null;
        }
        String name = jwt.getClaimAsString("preferred_username");
        return name != null && !name.isBlank() ? name : jwt.getSubject();
    }

    /** Jede Ablehnung kommt als deutscher Satz an - die Haus-Regel der Fläche. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Object> refusal(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(java.util.Map.of("message",
                        e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
