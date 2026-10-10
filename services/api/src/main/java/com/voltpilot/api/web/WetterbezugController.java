package com.voltpilot.api.web;

import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.WetterbezugService;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS AP-17 IP-12c (E9 = C): eine Gradtagzahl an das Wetter-Archiv binden und lösen, dazu die Zeile „Wetter“ am
 * Standort. Vertrag {@code docs/contracts/v2/bezugsdaten.md} §„Wetter-Archiv“; Recht wie die Kanalbindung.
 */
@RestController
@RequestMapping("/api/v1")
public class WetterbezugController {
    private final WetterbezugService service;
    public WetterbezugController(WetterbezugService service) { this.service = service; }

    public record Anfrage(LocalDate von, BigDecimal raumtemperatur, BigDecimal heizgrenze) {}

    /** Recht: {@code messwerte.ansehen} — wie die Kanalbindungen; außerhalb des Zugriffs 404. */
    @GetMapping("/bezugsgroessen/{id}/wetterbezug")
    public WetterbezugService.Wetterbezug lesen(@PathVariable UUID id) { return service.lesen(id); }

    /** Recht: {@code bezugsgroesse.verwalten} — wie die Kanalbindung. Kein Abruf beim Binden; der Läufer holt täglich. */
    @PutMapping("/bezugsgroessen/{id}/wetterbezug")
    @Recht(value = "bezugsgroesse.verwalten", ziel = RechtZiel.BEZUGSGROESSE)
    public WetterbezugService.Wetterbezug binden(@PathVariable UUID id, @RequestBody Anfrage a, Authentication auth) {
        if (a == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Anfrage fehlt.");
        return service.binden(id, a.von(), a.raumtemperatur(), a.heizgrenze(), akteur(auth));
    }

    /** Recht: {@code bezugsgroesse.verwalten} — löst die Bindung, die bezogenen Werte bleiben. */
    @DeleteMapping("/bezugsgroessen/{id}/wetterbezug")
    @Recht(value = "bezugsgroesse.verwalten", ziel = RechtZiel.BEZUGSGROESSE)
    public ResponseEntity<Void> loesen(@PathVariable UUID id, Authentication auth) {
        service.loesen(id, akteur(auth));
        return ResponseEntity.noContent().build();
    }

    /** Recht: {@code messwerte.ansehen} — die Zeile „Wetter“; ein Standort außerhalb des Zugriffs ist 404. */
    @GetMapping("/standorte/{standortId}/wetter")
    public WetterbezugService.StandortWetter standort(@PathVariable UUID standortId) {
        return service.standort(standortId);
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Anmeldung fehlt."));
    }
}
