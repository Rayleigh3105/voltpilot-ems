package com.voltpilot.api.web;

import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefungService;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefungService.AnlagePruefung;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefungService.FlottenPruefung;
import java.time.Instant;
import java.time.Year;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * MiSpeL MP-2 (W1 = D): der Ausschließlichkeits-Prüfer als Auswertung für den Betreiber — nur lesend, nur
 * platform-admin, keine Portalfläche. Je Anlage und Kalendermonat: wie viel Netzstrom nach Speichervorrang im Speicher
 * landete und wie viel der Speicher einspeiste (Anlage 1 S. 11, S. 14–16, S. 33–35). Rechnung und Lesart:
 * {@link AusschliesslichkeitsPruefer}; Wegweiser {@code docs/agents/root/mispel-ausschliesslichkeits-pruefer.md}.
 */
@RestController
@RequestMapping("/api/v1/admin/mispel/ausschliesslichkeit")
@PreAuthorize("hasRole('platform-admin')")
public class AdminMispelController {

    private final AusschliesslichkeitsPruefungService pruefung;

    public AdminMispelController(AusschliesslichkeitsPruefungService pruefung) {
        this.pruefung = pruefung;
    }

    /**
     * Recht: {@code plattform.betrieb} — lesend. Jahreswerte jeder Anlage mit erfasstem Speicher, über
     * alle Mandanten; {@code jahr} fehlend = laufendes Kalenderjahr (gesetzliche Zeit).
     */
    @GetMapping
    public FlottenPruefung flotte(@RequestParam(required = false) Integer jahr) {
        return pruefung.flotte(jahr(jahr), Instant.now());
    }

    /**
     * Recht: {@code plattform.betrieb} — lesend. Eine Anlage: Kalenderjahr und Monate bis jetzt; 404, wenn
     * es die Anlage nicht gibt.
     */
    @GetMapping("/{siteId}")
    public AnlagePruefung anlage(@PathVariable UUID siteId, @RequestParam(required = false) Integer jahr) {
        return pruefung.anlage(siteId, jahr(jahr), Instant.now())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
    }

    private static int jahr(Integer jahr) {
        int laufend = Year.now(AusschliesslichkeitsPruefer.GESETZLICHE_ZEIT).getValue();
        if (jahr == null) {
            return laufend;
        }
        // Ein künftiges Jahr hat keine Viertelstunde; die untere Grenze hält nur unsinnige Eingaben ab.
        if (jahr < 2020 || jahr > laufend) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Jahr muss zwischen 2020 und " + laufend + " liegen.");
        }
        return jahr;
    }

    /** German reason into the body (the MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
