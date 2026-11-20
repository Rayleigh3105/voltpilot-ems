package com.voltpilot.api.web;

import com.voltpilot.api.erzeuger.KoppelbildService;
import com.voltpilot.api.web.dto.KoppelbildDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.security.Principal;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Das Koppelbild einer Anlagensteuerung (PFC200 Stufe 4, {@code docs/contracts/v2/koppelbild.md} §15): ansehen, einen
 * Stellplatz testen, freigeben, die Freigabe zurücknehmen. Rechte wie die Schreibwerte des Modbus-Geräts; eine fremde
 * oder umzäunte Steuerung ist 404, nie 403. Die Arbeit macht {@link KoppelbildService}.
 */
@RestController
public class KoppelbildController {

    private final KoppelbildService service;

    public KoppelbildController(KoppelbildService service) {
        this.service = service;
    }

    /**
     * Recht: {@code messwerte.ansehen}. Der jüngste Stand der Box und je Stellplatz Angebot, Wunsch, Quittung und
     * Freigabe; unbekannt ist null, nie 0.
     */
    @GetMapping("/api/v1/sites/{siteId}/anlagensteuerungen/{geraetId}/koppelbild")
    public KoppelbildDto.Koppelbild koppelbild(@PathVariable UUID siteId, @PathVariable UUID geraetId) {
        return service.koppelbild(siteId, geraetId);
    }

    /**
     * Recht: {@code schalttest.durchfuehren}. Schreibt über die Box für 30 s einen Testwert auf genau diesen
     * Stellplatz; ein Testwert außerhalb des Bands ist 400, nicht geklemmt. Ohne Angebot, ohne Steuerungskennung oder
     * an einer Box ohne {@code koppelbild} 409.
     */
    @PostMapping("/api/v1/geraete/{id}/koppelbild/stellplaetze/{platz}/test")
    @Recht(value = "schalttest.durchfuehren", ziel = RechtZiel.GERAET)
    public KoppelbildDto.TestErgebnis testen(@PathVariable UUID id, @PathVariable int platz,
            @RequestBody(required = false) KoppelbildDto.TestAnfrage anfrage, Principal actor) {
        return service.testen(id, platz, anfrage, actor.getName());
    }

    /**
     * Recht: {@code freigabe.erteilen}. Nur mit bestandenem Test für das jetzige Angebot und bestätigter Wirkung; je
     * Kommando höchstens ein freigegebener Stellplatz (sonst 409). Danach geht der Registry-Push an die Box.
     */
    @PostMapping("/api/v1/geraete/{id}/koppelbild/stellplaetze/{platz}/freigabe")
    @Recht(value = "freigabe.erteilen", ziel = RechtZiel.GERAET)
    public KoppelbildDto.Koppelbild freigeben(@PathVariable UUID id, @PathVariable int platz,
            @RequestBody(required = false) KoppelbildDto.FreigabeAnfrage anfrage, Principal actor) {
        return service.freigeben(id, platz, anfrage, actor.getName());
    }

    /** Recht: {@code freigabe.erteilen}. Nimmt die Freigabe zurück (idempotent); die Box liest weiter. */
    @DeleteMapping("/api/v1/geraete/{id}/koppelbild/stellplaetze/{platz}/freigabe")
    @Recht(value = "freigabe.erteilen", ziel = RechtZiel.GERAET)
    public KoppelbildDto.Koppelbild zuruecknehmen(@PathVariable UUID id, @PathVariable int platz, Principal actor) {
        return service.zuruecknehmen(id, platz, actor.getName());
    }
}
