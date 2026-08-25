package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.SiteSuggestionStateRepository;
import com.voltpilot.api.suggestions.Vorschlaege;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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
 * Das GEDÄCHTNIS der Vorschläge (Steuerung Stufe 6, Konzept
 * `vp-steuerung-konzept-b3` §3.3 + §4): „Später" und „Ablehnen".
 *
 * <p><b>⚠ Es gibt hier KEINE Route, die Vorschläge LIEFERT</b> - und das ist
 * Absicht. Ein Vorschlag ist eine Ableitung aus dem Fahrplan, den steuerbaren
 * Komponenten und dem, was schon läuft; alle drei liegen im Portal ohnehin
 * vor, und sie ändern sich alle 15 Minuten. Eine Server-Route müsste dieselbe
 * Ableitung ein zweites Mal führen - genau die zweite Wahrheit, die dieses
 * Haus vermeidet. Der Server hält nur die GEGENRICHTUNG: welchen Vorschlag der
 * Kunde gerade nicht sehen will.
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route: KEIN
 * {@code @PreAuthorize}, Authentifizierung + RLS sind der Zaun, eine fremde
 * Anlage ist <b>404, nie 403</b>; ein Plattform-Admin erreicht sie über den
 * {@code X-Tenant-Id}-Umschalter.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteSuggestionController {

    /** Was der Kunde geklickt hat. Die FRIST rechnet der Server. */
    public record SuggestionStateRequest(String state) {}

    /** Eine geltende Haltung. */
    public record SuggestionStateDto(String key, String state, Instant mutedUntil,
            Instant updatedAt) {}

    /** Alles, was gerade stumm ist. */
    public record SuggestionStatesDto(List<SuggestionStateDto> states) {}

    private final SiteRepository sites;
    private final SiteSuggestionStateRepository store;

    public SiteSuggestionController(SiteRepository sites, SiteSuggestionStateRepository store) {
        this.sites = sites;
        this.store = store;
    }

    /**
     * Die geltenden Haltungen. Eine ABGELAUFENE Zeile taucht nicht auf - der
     * Vorschlag darf dann wieder erscheinen, ohne dass jemand aufräumt.
     */
    @GetMapping("/suggestion-states")
    public SuggestionStatesDto list(@PathVariable UUID siteId) {
        requireSite(siteId);
        return new SuggestionStatesDto(store.findLive(siteId, Instant.now()).stream()
                .map(r -> new SuggestionStateDto(r.key(), r.state(), r.mutedUntil(),
                        r.updatedAt()))
                .toList());
    }

    /**
     * „Später" (1 Tag) oder „Ablehnen" (7 Tage). Der Schlüssel ist der
     * ABGELEITETE Vorschlags-Schlüssel des Portals; seine Form wird geprüft,
     * nie zurechtgebogen.
     */
    @PutMapping("/suggestion-states/{key}")
    public SuggestionStateDto put(@PathVariable UUID siteId, @PathVariable String key,
            @RequestBody(required = false) SuggestionStateRequest request,
            @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        String state = request == null ? null : request.state();
        if (!Vorschlaege.bekannt(state)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannte Auswahl - erlaubt sind „später\" und „abgelehnt\".");
        }
        String schluessel;
        try {
            schluessel = Vorschlaege.pruefeSchluessel(key);
        } catch (Vorschlaege.Abgelehnt e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        Instant now = Instant.now();
        Instant bis = Vorschlaege.stummBis(state, now);
        store.upsert(siteId, schluessel, state, bis, jwt == null ? null : jwt.getSubject());
        // Opportunistisch aufräumen: die abgelaufenen Zeilen DIESER Anlage.
        store.pruneExpired(siteId, now);
        return new SuggestionStateDto(schluessel, state, bis, now);
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    /** Deutsche Gründe erreichen das Portal als {"message": …}. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
