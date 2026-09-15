package com.voltpilot.api.web;

import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.web.dto.PromoteForecastModelRequest;
import com.voltpilot.api.web.dto.SiteForecastModelsDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Prognose-Schalter EINER ANLAGE:
 * {@code GET/POST /api/v1/sites/{siteId}/forecast-models} (Captain-Auftrag
 * 19.08.2026 - er revidiert die plattformweite, admin-only Semantik von
 * {@link AdminForecastModelController} vom Vortag).
 *
 * <p><b>Warum er KEIN Admin-Endpunkt ist:</b> welches Prognosemodell am besten
 * passt, hängt an der einzelnen Anlage - ein Kandidat, der auf einem
 * Gewerbehof gewinnt, kann auf einem Einfamilienhaus verlieren. Und die
 * Entscheidung ist eine über die EIGENE Anlage. Also gehört sie dem Kunden.
 *
 * <p><b>Der Zaun ist der des Hauses, nicht ein neuer:</b> mandantenbezogen wie
 * jede {@code /api/v1/sites/**}-Route ({@link SiteTopologyController},
 * {@link SiteFlowController}) - KEIN {@code @PreAuthorize}, Authentifizierung +
 * Postgres-RLS sind die Grenze, eine fremde Anlage ist <b>404</b>, nie 403.
 * Ein Portal-Admin erreicht damit jede Anlage über den
 * {@code X-Tenant-Id}-Umschalter auf demselben RLS-Pfad; einen
 * BYPASSRLS-Schreibpfad gibt es hier bewusst nicht.
 *
 * <p><b>Was er NICHT tut:</b> er ändert kein Modell, trainiert nichts und
 * erreicht kein Gerät. Er stellt um, WELCHE der ohnehin täglich gerechneten
 * Prognosereihen der Optimierer für DIESE Anlage ab dem nächsten Planungslauf
 * liest - und legt darüber eine append-only Papier-Spur an. Der Rückweg ist
 * derselbe Aufruf in die Gegenrichtung.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/forecast-models")
public class SiteForecastModelController {

    private final Geltungsbereich geltungsbereich;
    private final ForecastModelService models;

    public SiteForecastModelController(Geltungsbereich geltungsbereich, ForecastModelService models) {
        this.geltungsbereich = geltungsbereich;
        this.models = models;
    }

    /** Je Prognoseart das Modell DIESER Anlage samt Herkunft + ihre Historie. */
    @GetMapping
    public SiteForecastModelsDto state(@PathVariable UUID siteId) {
        requireSite(siteId);
        return models.state(siteId);
    }

    /**
     * Übernimmt ein Modell für DIESE Anlage. Der Urheber der Papier-Spur ist das
     * JWT-Subject (die maschinenstabile Identität, wie im Rollout-Journal); der
     * {@code preferred_username} reist als ANZEIGE-Name daneben, weil eine UUID
     * kein Urheber ist, den ein Mensch liest.
     */
    @PostMapping
    @Recht(value = "prognose.befoerdern", ziel = RechtZiel.ANLAGE)
    public SiteForecastModelsDto promote(
            @PathVariable UUID siteId,
            @Valid @RequestBody PromoteForecastModelRequest req,
            @AuthenticationPrincipal Jwt caller) {
        requireSite(siteId);
        return models.promote(
                siteId, req.kind(), req.model(), subject(caller), displayName(caller));
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }

    private static String subject(Jwt caller) {
        return caller == null ? "unbekannt" : caller.getSubject();
    }

    private static String displayName(Jwt caller) {
        if (caller == null) {
            return null;
        }
        Object name = caller.getClaims().get("preferred_username");
        if (name == null) {
            name = caller.getClaims().get("name");
        }
        String s = name == null ? "" : name.toString().trim();
        return s.isEmpty() ? null : s;
    }

    /** Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
