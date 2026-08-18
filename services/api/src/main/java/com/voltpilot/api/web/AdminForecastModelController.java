package com.voltpilot.api.web;

import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.web.dto.ForecastModelChoiceDto;
import com.voltpilot.api.web.dto.PromoteForecastModelRequest;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Prognose-Schalter: {@code GET/POST /api/v1/admin/forecast-models}
 * (Captain-Auftrag 18.08.2026 - „einen Schalter im Portal dafür machen").
 *
 * <p><b>Warum er existiert:</b> der Schattenbetrieb misst seit Langem, welcher
 * Kandidat näher an der Wirklichkeit lag - die daraus folgende HANDLUNG war
 * aber eine Umgebungsvariable an drei Containern plus Redeploy. Seit Migration
 * V20260825000000 ist die Wahl ein Datensatz, und dieser Endpunkt ist der
 * einzige Schreibpfad dorthin.
 *
 * <p><b>Sicherheits-Disziplin, übernommen statt neu erfunden:</b> klassenweites
 * {@code @PreAuthorize("hasRole('platform-admin')")} wie {@link AdminController}
 * und {@link AdminFleetController} - klassenweit UND NICHT je Methode, weil eine
 * neu hinzugefügte Methode sonst auf die Filterregel für
 * {@code /api/v1/admin/**} zurückfiele, die auch die schmale Rolle
 * {@code edge-release-publisher} zulässt (die Lehre aus
 * {@code AdminComponentTemplateController}). Ein Kunden-Token bekommt 403, ein
 * anonymer Aufruf 401. Die RLS-Umgehung steckt ausschließlich in
 * {@code AdminForecastModelChoiceRepository} an der Rolle
 * {@code voltpilot_admin}.
 *
 * <p><b>Was er NICHT tut:</b> er ändert kein Modell, trainiert nichts und
 * erreicht kein Gerät. Er stellt um, WELCHE der ohnehin täglich gerechneten
 * Prognosereihen der Optimierer ab dem nächsten Planungslauf liest - und legt
 * darüber eine append-only Papier-Spur an. Der Rückweg ist derselbe Aufruf in
 * die Gegenrichtung.
 */
@RestController
@RequestMapping("/api/v1/admin/forecast-models")
@PreAuthorize("hasRole('platform-admin')")
public class AdminForecastModelController {

    private final ForecastModelService models;

    public AdminForecastModelController(ForecastModelService models) {
        this.models = models;
    }

    /** Der Panel-Zustand: je Prognoseart das aktive Modell + die Historie. */
    @GetMapping
    public ForecastModelChoiceDto state() {
        return models.state();
    }

    /**
     * Übernimmt ein Modell als aktives Modell seiner Art. Der Urheber der
     * Papier-Spur ist das JWT-Subject (die maschinenstabile Identität, wie im
     * Rollout-Journal); der {@code preferred_username} reist als ANZEIGE-Name
     * daneben, weil eine UUID kein Urheber ist, den ein Mensch liest.
     */
    @PostMapping
    public ForecastModelChoiceDto promote(
            @Valid @RequestBody PromoteForecastModelRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return models.promote(req.kind(), req.model(), subject(caller), displayName(caller));
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

    /**
     * Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}
     * -Körper statt als nackter Status (das Muster von
     * {@link AdminOptimizerController}).
     */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
