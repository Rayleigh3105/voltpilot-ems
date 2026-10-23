package com.voltpilot.api.orte;

import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/v1/orte/suche?q=…} - die Adressvorschläge beim Anlegen (Anlage-Flow a1, D4 = A):
 * Straße und Hausnummer genügen, Treffer nur in Deutschland, Österreich und der Schweiz
 * ({@link OrteSuche}). Jedes angemeldete Konto darf suchen; es liest keine Daten eines
 * Kundenbereichs. Fehlt die Datenquelle, antwortet die Route 503 mit einem Satz, der den Weg nennt
 * (den Punkt auf der Karte selbst setzen).
 */
// Recht: keines - eine Suche in öffentlichen Adressdaten, kein Lesen und Schreiben im Kundenbereich.
@RestController
@RequestMapping("/api/v1/orte")
public class OrteSucheController {

    private final OrteSuche suche;

    public OrteSucheController(OrteSuche suche) {
        this.suche = suche;
    }

    @GetMapping("/suche")
    public ResponseEntity<OrteSuche.Antwort> suche(@RequestParam(name = "q", required = false) String q) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(suche.suchen(q));
    }

    @ExceptionHandler(OrteSuche.NichtErreichbar.class)
    public ResponseEntity<Map<String, String>> nichtErreichbar(OrteSuche.NichtErreichbar e) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                "code", "adresssuche_nicht_erreichbar",
                "message", "Die Adresssuche ist gerade nicht erreichbar. Sie können den Punkt auf der Karte selbst setzen."));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> ungueltig(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("code", "anfrage_ungueltig", "message", e.getMessage()));
    }
}
