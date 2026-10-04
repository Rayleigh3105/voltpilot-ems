package com.voltpilot.api.web;

import com.voltpilot.api.szenen.SzenenService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Szene einer Anlage (Konzept `docs/konzepte/steuerung`, E6): lesen,
 * einschalten, beenden. Siehe {@link SzenenService}.
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route: KEIN
 * {@code @PreAuthorize}, Authentifizierung + RLS sind der Zaun, eine fremde
 * Anlage ist <b>404, nie 403</b>. Der Mandant kommt aus dem Token, nie aus dem
 * Rumpf; die Geräte im Rumpf prüft der Dienst gegen die Anlage.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteSceneController {

    /** Was der Kunde einschaltet: das Wort und seine Geräteauswahl. */
    public record SceneRequest(String key, List<UUID> entityIds) {}

    /** Die laufende Szene (oder {@code null}) samt ehrlicher Meldung. */
    public record SceneDto(SzenenService.SzeneDto scene, List<String> offen, String message) {}

    private final Geltungsbereich geltungsbereich;
    private final SzenenService szenen;

    public SiteSceneController(Geltungsbereich geltungsbereich, SzenenService szenen) {
        this.geltungsbereich = geltungsbereich;
        this.szenen = szenen;
    }

    @GetMapping("/scene")
    public SceneDto get(@PathVariable UUID siteId) {
        requireSite(siteId);
        return new SceneDto(szenen.aktuell(siteId), List.of(), null);
    }

    // Eine Szene nutzt den Pausenweg der Verbraucher (POST /consumers/{id}/pause trägt dasselbe Recht).
    @PutMapping("/scene")
    @Recht(value = "betriebsweise.aendern", ziel = RechtZiel.ANLAGE)
    public SceneDto put(@PathVariable UUID siteId,
            @RequestBody(required = false) SceneRequest request, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        SzenenService.Ergebnis e = szenen.starten(siteId, request == null ? null : request.key(),
                request == null ? null : request.entityIds(), jwt == null ? null : jwt.getSubject());
        return new SceneDto(e.szene(), e.offen(), e.message());
    }

    @DeleteMapping("/scene")
    @Recht(value = "betriebsweise.aendern", ziel = RechtZiel.ANLAGE)
    public SceneDto delete(@PathVariable UUID siteId, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        SzenenService.Ergebnis e = szenen.beenden(siteId, jwt == null ? null : jwt.getSubject());
        return new SceneDto(e.szene(), e.offen(), e.message());
    }

    /** Standort-Zaun (UEMS AP-03 IP-5): eine Anlage außerhalb des Zugriffs ist 404, nie 403. */
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
