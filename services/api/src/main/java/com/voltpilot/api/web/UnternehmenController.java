package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.StandortLesemodell.UnternehmenSicht;
import com.voltpilot.api.uems.StandortLesemodellService;
import com.voltpilot.api.uems.UnternehmenService;
import com.voltpilot.api.web.dto.UnternehmenDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * {@code /api/v1/unternehmen} — das Unternehmen des Kundenbereichs. {@code GET} mit den
 * Zahlen, auf die die Startansicht-Weiche (AP-01 E1/IP-5) wartet: Standorte, Anlagen und
 * „noch nicht zugeordnet", heute (UEMS AP-02 IP-3 ★). {@code PUT} bearbeitet die
 * Stammdaten (IP-4, {@link UnternehmenService}); kein Anlegen, kein Löschen — das
 * Unternehmen gibt es immer genau einmal je Kundenbereich.
 *
 * <p>Mandantengebunden wie {@code /api/v1/sites/**}: {@code authenticated()}
 * plus RLS, keine eigene Rechte-Annotation (die Durchsetzung bringt AP-03).
 * Ein Admin ohne gewählten Mandanten bekommt 404 wie {@code /tenant-context};
 * ein Kundenbereich ohne Unternehmen-Zeile bekommt beim Lesen den benannten
 * Zustand {@code nicht_angelegt} — nie einen 500.
 */
@RestController
@RequestMapping("/api/v1/unternehmen")
public class UnternehmenController {

    private final StandortLesemodellService lesemodell;
    private final UnternehmenService unternehmen;
    private final OrtAnfrage anfrage;

    public UnternehmenController(StandortLesemodellService lesemodell, UnternehmenService unternehmen,
            OrtAnfrage anfrage) {
        this.lesemodell = lesemodell;
        this.unternehmen = unternehmen;
        this.anfrage = anfrage;
    }

    // Rechte (rechte-matrix.json): lesend — keine eigene Kennung.
    @GetMapping
    public UnternehmenSicht unternehmen() {
        return lesemodell.unternehmen().orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "No tenant context"));
    }

    // Rechte: `unternehmen.bearbeiten`.
    @PutMapping
    @Recht(value = "unternehmen.bearbeiten", ziel = RechtZiel.UNTERNEHMEN)
    public UnternehmenSicht bearbeiten(@RequestBody(required = false) JsonNode body, Authentication auth) {
        return unternehmen.bearbeiten(anfrage.lies(body, UnternehmenDto.Bearbeiten.class, false),
                OrtAnfrage.akteur(auth));
    }
}
