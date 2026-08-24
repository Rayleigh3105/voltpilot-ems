package com.voltpilot.api.web;

import com.voltpilot.api.cockpit.CockpitLayoutService;
import com.voltpilot.api.web.SiteCockpitLayoutController.LayoutRequest;
import com.voltpilot.api.web.dto.CockpitLayoutDto;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die KUNDEN-WEITE Vorgabe („für alle meine Anlagen", Captain-Entscheid E1):
 * ein Betreiber mit 20 Anlagen soll nicht 20 Layouts pflegen. Sie liegt unter
 * demselben Speicher wie das Anlagen-Layout, nur mit {@code scope_kind=tenant}
 * — dieselbe Auflösung, keine zweite Tabelle.
 *
 * <p><b>Die Anlagen-Vorgabe SCHLÄGT die kunden-weite</b> (E1 wörtlich: „die
 * Anlagen-Vorgabe gewinnt"), und der Kunde schlägt beide (E2). Die Reihenfolge
 * lebt in der reinen Auflösung des Portals, nicht hier.
 *
 * <p>Die Vorgabe-Vorgabe ist heute die EINZIGE sinnvolle Schicht dieser Route:
 * eine kunden-weite {@code eigen}-Schicht auf der Fläche {@code cockpit} liest
 * niemand (das Anlagen-Cockpit löst gegen die Anlagen-Schichten auf). Sie ist
 * trotzdem erlaubt, weil dieselbe Route ab Stufe 4 die Fläche
 * {@code portfolio} trägt — dort IST {@code eigen} der Wille des Kunden. Der
 * Speicher bleibt damit scope-generisch statt zweimal gebaut.
 *
 * <p>Mandantenbezogen wie die Anlagen-Route: der Mandant kommt aus dem
 * validierten Token bzw. dem {@code X-Tenant-Id}-Umschalter, nie aus dem Pfad —
 * es gibt hier deshalb bewusst KEINE {@code {tenantId}}-Variable, die ein
 * Aufrufer setzen könnte. Ein Portal-Admin OHNE gewählten Kunden bekommt 404:
 * es gibt keine Organisation, deren Vorgabe gemeint sein könnte.
 */
@RestController
@RequestMapping("/api/v1/tenant/cockpit-layout")
public class TenantCockpitLayoutController {

    private final CockpitLayoutService layouts;

    public TenantCockpitLayoutController(CockpitLayoutService layouts) {
        this.layouts = layouts;
    }

    @GetMapping
    public CockpitLayoutDto get() {
        return layouts.forTenant(SiteCockpitLayoutController.isPlatformAdmin());
    }

    @PutMapping
    public CockpitLayoutDto put(@RequestParam(name = "layer", defaultValue = "vorgabe") String layer,
            @RequestBody(required = false) LayoutRequest request,
            @AuthenticationPrincipal Jwt caller) {
        requireVorgabeRecht(layer);
        return layouts.saveForTenant(layer, SiteCockpitLayoutController.document(request),
                SiteCockpitLayoutController.subject(caller),
                SiteCockpitLayoutController.isPlatformAdmin());
    }

    @DeleteMapping
    public CockpitLayoutDto reset(
            @RequestParam(name = "layer", defaultValue = "vorgabe") String layer) {
        requireVorgabeRecht(layer);
        return layouts.resetForTenant(layer, SiteCockpitLayoutController.isPlatformAdmin());
    }

    private void requireVorgabeRecht(String layer) {
        if ("vorgabe".equals(layer) && !SiteCockpitLayoutController.isPlatformAdmin()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "Eine kunden-weite Vorgabe kann nur VoltPilot hinterlegen.");
        }
    }

    /** Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
