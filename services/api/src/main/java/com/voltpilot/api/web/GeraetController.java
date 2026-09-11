package com.voltpilot.api.web;

import com.voltpilot.api.uems.GeraetService;
import com.voltpilot.api.web.dto.GeraetDto;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Geräte hinter der VoltPilot-Box (UEMS AP-04 IP-10) — nur lesend; den Ein- und Ausbau
 * schreiben erst der Zähler- und der Controllerwechsel (IP-17/IP-19). Die Arbeit macht
 * {@link GeraetService}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS wie unter {@code /api/v1/sites/**} — eine fremde Anlage und ein fremdes Gerät
 * sind 404, nie 403; der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Jede
 * Route nennt im Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}, damit
 * AP-03 sie findet; eine eigene Rechte-Annotation gibt es hier bewusst nicht. Die schreibenden
 * Routen der Wechsel tragen {@code geraet.einrichten}.
 */
@RestController
public class GeraetController {

    private final GeraetService geraete;

    public GeraetController(GeraetService geraete) {
        this.geraete = geraete;
    }

    /** Recht: {@code messwerte.ansehen} — die Geräte gehören zur Sicht auf die Messwerte. */
    @GetMapping("/api/v1/sites/{siteId}/geraete")
    public GeraetDto.Liste derAnlage(@PathVariable UUID siteId) {
        return geraete.derAnlage(siteId);
    }

    /** Recht: {@code messwerte.ansehen}. */
    @GetMapping("/api/v1/geraete/{id}")
    public GeraetDto.Geraet eines(@PathVariable UUID id) {
        return geraete.eines(id);
    }
}
