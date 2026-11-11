package com.voltpilot.api.web;

import com.voltpilot.api.erzeuger.ErzeugerJetztService;
import com.voltpilot.api.web.dto.ErzeugerJetztDto;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * Das Erzeuger-Cockpit (UEMS EZ-23 zu EZ-8): was das Portal von einer Anlage mit Anlagensteuerung liest. Die Arbeit
 * macht {@link ErzeugerJetztService}. Eine fremde oder umzäunte Anlage ist 404, nie 403.
 */
@RestController
public class ErzeugerJetztController {

    private final ErzeugerJetztService service;

    public ErzeugerJetztController(ErzeugerJetztService service) {
        this.service = service;
    }

    /**
     * Recht: {@code messwerte.ansehen} (wie die Werte der Steuerung). 204 = die Anlage hat keine Anlagensteuerung;
     * mit Steuerung immer 200, auch ohne Werte (dann null, nie 0).
     */
    @GetMapping("/api/v1/sites/{siteId}/erzeuger/jetzt")
    public ResponseEntity<ErzeugerJetztDto.Jetzt> jetzt(@PathVariable UUID siteId) {
        return service.jetzt(siteId).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }
}
