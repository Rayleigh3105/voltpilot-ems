package com.voltpilot.api.web;

import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.StandorteAmStichtag;
import com.voltpilot.api.uems.StandortLesemodellService;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Standort-Lesemodell (UEMS AP-02 IP-3 ★): die Standorte des Unternehmens
 * zum Stichtag — Kurzzeichen, Name, Adresse, Zeitzone, Zustand und „es fehlt",
 * die Anlagen mit gültiger Zuordnung, Gebäude- und Bereichszahl, Fläche — und
 * die Gruppe „noch nicht zugeordnet". Nur lesend; die Schreibrouten bringen
 * IP-4 (Standort) und IP-5 (Gebäude/Bereiche).
 *
 * <p>Mandantengebunden wie {@code /api/v1/sites/**}: {@code authenticated()}
 * plus RLS, keine eigene Rechte-Annotation. Ein fremder Standort ist 404, nie
 * 403 (A14). {@code stichtag} ist ein ISO-Tag ({@code 2027-02-15}); ohne ihn
 * gilt heute in der Zeitzone des Unternehmens.
 */
@RestController
@RequestMapping("/api/v1/standorte")
public class StandortController {

    private final StandortLesemodellService lesemodell;

    public StandortController(StandortLesemodellService lesemodell) {
        this.lesemodell = lesemodell;
    }

    // Rechte (rechte-matrix.json): heute lesend — keine eigene Kennung; die Sicht
    // „Stand am" (ein Stichtag in der Vergangenheit) ist `aenderungsprotokoll.lesen`.
    // Die Teilansicht nach zugewiesenen Standorten (AP-03 E10) kommt mit AP-03 IP-10
    // als additives Feld `teilansicht`.
    @GetMapping
    public StandorteAmStichtag standorte(@RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate stichtag) {
        return lesemodell.standorte(stichtag);
    }

    // Rechte: wie oben.
    @GetMapping("/{standortId}")
    public StandortAmStichtag standort(@PathVariable UUID standortId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate stichtag) {
        return lesemodell.standort(standortId, stichtag).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort not found"));
    }
}
