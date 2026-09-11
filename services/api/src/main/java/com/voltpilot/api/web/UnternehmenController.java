package com.voltpilot.api.web;

import com.voltpilot.api.uems.StandortLesemodell.UnternehmenSicht;
import com.voltpilot.api.uems.StandortLesemodellService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * {@code GET /api/v1/unternehmen} — das Unternehmen des Kundenbereichs mit den
 * Zahlen, auf die die Startansicht-Weiche (AP-01 E1/IP-5) wartet: Standorte,
 * Anlagen und „noch nicht zugeordnet", heute (UEMS AP-02 IP-3 ★).
 *
 * <p>Mandantengebunden wie {@code /api/v1/sites/**}: {@code authenticated()}
 * plus RLS, keine eigene Rechte-Annotation (die Durchsetzung bringt AP-03).
 * Ein Admin ohne gewählten Mandanten bekommt 404 wie {@code /tenant-context};
 * ein Kundenbereich ohne Unternehmen-Zeile bekommt den benannten Zustand
 * {@code nicht_angelegt} — nie einen 500.
 */
@RestController
@RequestMapping("/api/v1/unternehmen")
public class UnternehmenController {

    private final StandortLesemodellService lesemodell;

    public UnternehmenController(StandortLesemodellService lesemodell) {
        this.lesemodell = lesemodell;
    }

    // Rechte (rechte-matrix.json): lesend — keine eigene Kennung; das Bearbeiten
    // ist `unternehmen.bearbeiten` (IP-4).
    @GetMapping
    public UnternehmenSicht unternehmen() {
        return lesemodell.unternehmen().orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "No tenant context"));
    }
}
