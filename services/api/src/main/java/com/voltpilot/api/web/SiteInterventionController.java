package com.voltpilot.api.web;

import com.voltpilot.api.web.dto.ProtokollDto;
import com.voltpilot.api.interventions.DeviceOverrideService;
import com.voltpilot.api.interventions.DeviceOverrideService.Outcome;
import com.voltpilot.api.interventions.Handeingriff;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die HANDEINGRIFFE einer Anlage (Steuerung Stufe 4, Konzept
 * `vp-steuerung-konzept-b3` §3.2 + §3.7 B2/B5): „Speicher jetzt laden",
 * „Ladestand halten" und „Automatik pausieren" - plus der EINE Lesepfad, aus
 * dem die Jetzt-Zone ihre Zeilen und ihr Banner baut.
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route: KEIN
 * {@code @PreAuthorize}, Authentifizierung + RLS sind der Zaun, eine fremde
 * Anlage ist <b>404, nie 403</b>; ein Plattform-Admin erreicht sie über den
 * {@code X-Tenant-Id}-Umschalter.
 *
 * <p><b>Der Verbraucher-Eingriff wohnt weiter auf {@link SiteConsumerController}</b>
 * ({@code /consumers/{id}/override}) - er hat sein eigenes Vokabular
 * (start/stop) und seinen eigenen Lesepfad. Diese Routen sind der Nachbar für
 * das, was es dort nicht gibt: den Speicher und die ganze Anlage.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteInterventionController {

    /** Was der Kunde gewählt hat. {@code kind} entscheidet, was passiert. */
    public record InterventionRequest(String kind, Integer durationMinutes, Instant endsAt,
            BigDecimal setpointKw) {}

    /** Eine laufende Handlung, wie die Jetzt-Zone sie rendert. */
    /** {@code urheber} im Akteur-Vokabular (AP-03 IP-7); {@code null} für einen Eingriff von vor V20260916010000. */
    public record InterventionDto(String kind, UUID entityId, BigDecimal targetValueKw,
            Instant endsAt, String createdBy, Instant createdAt, ProtokollDto.Urheber urheber) {}

    /** Alles, was gerade von Hand gesetzt ist. */
    public record InterventionsDto(boolean automationPaused, Instant pausedUntil,
            List<InterventionDto> interventions) {}

    private final Geltungsbereich geltungsbereich;
    private final DeviceOverrideService service;

    public SiteInterventionController(Geltungsbereich geltungsbereich, DeviceOverrideService service) {
        this.geltungsbereich = geltungsbereich;
        this.service = service;
    }

    /** Der EINE Lesepfad der Jetzt-Zone: laufende Eingriffe + die Pause. */
    @GetMapping("/interventions")
    public InterventionsDto list(@PathVariable UUID siteId) {
        requireSite(siteId);
        List<InterventionDto> rows = new ArrayList<>();
        Instant pausedUntil = null;
        for (DeviceOverrideRepository.Row row : service.active(siteId)) {
            if (row.ausFunktion()) {
                // Die Ruhe bis zum Start (R0) ist kein Handeingriff: sie hat kein Ende und
                // gehört der Funktion, nicht der Jetzt-Zone - dieser Lesepfad bleibt
                // byte-gleich, bis die Steuerungsseite sie selbst zeigt (AP-01 IP-11).
                continue;
            }
            if (row.isPause()) {
                pausedUntil = row.endsAt();
                continue;
            }
            rows.add(new InterventionDto(row.kind(), row.entityId(), row.targetValue(),
                    row.endsAt(), row.createdBy(), row.createdAt(), row.actorArt() == null ? null
                            : new ProtokollDto.Urheber(row.actorName(), row.actorRolle(), row.actorArt())));
        }
        return new InterventionsDto(pausedUntil != null, pausedUntil, rows);
    }

    /**
     * „Speicher jetzt laden" / „Ladestand halten" (Captain-Entscheid S1 = A).
     * Dauer ist PFLICHT; ob dabei aus dem Netz geladen werden darf, entscheidet
     * die Box gegen ihre Registry-Guards - nicht diese Route.
     */
    @PostMapping("/battery-override")
    @Recht(value = "handeingriff.setzen", ziel = RechtZiel.ANLAGE)
    public Outcome startBattery(@PathVariable UUID siteId,
            @RequestBody InterventionRequest request, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return service.startBattery(siteId, anfrage(request), actor(jwt));
    }

    /** „Automatik fortsetzen" für den Speicher. */
    @DeleteMapping("/battery-override")
    @Recht(value = "handeingriff.setzen", ziel = RechtZiel.ANLAGE)
    public Outcome clearBattery(@PathVariable UUID siteId, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return service.clearBattery(siteId, actor(jwt));
    }

    /**
     * „Automatik pausieren": Fahrplan UND Regeln ruhen für die Dauer. Messen,
     * Guards, § 14a, die Abregelung und die Einspeise-Wache laufen weiter -
     * sie liegen unterhalb der Arbitrierung.
     */
    @PostMapping("/automation-pause")
    @Recht(value = "handeingriff.setzen", ziel = RechtZiel.ANLAGE)
    public Outcome pause(@PathVariable UUID siteId, @RequestBody InterventionRequest request,
            @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return service.pause(siteId, anfrage(request), actor(jwt));
    }

    /** „Automatik fortsetzen" für die Anlage. */
    @DeleteMapping("/automation-pause")
    @Recht(value = "handeingriff.setzen", ziel = RechtZiel.ANLAGE)
    public Outcome resume(@PathVariable UUID siteId, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return service.resume(siteId, actor(jwt));
    }

    private static Handeingriff.Anfrage anfrage(InterventionRequest r) {
        return r == null ? new Handeingriff.Anfrage(null, null, null, null)
                : new Handeingriff.Anfrage(r.kind(), r.durationMinutes(), r.endsAt(),
                        r.setpointKw());
    }

    private static String actor(Jwt jwt) {
        return jwt == null ? null : jwt.getSubject();
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }

    /** Deutsche Gründe erreichen das Portal als {"message": …}. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
