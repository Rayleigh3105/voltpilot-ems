package com.voltpilot.api.web;

import com.voltpilot.api.cockpit.EigeneAuswertungService;
import com.voltpilot.api.web.dto.EigeneAuswertungDto;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Werte der eigenen Auswertungen EINER Anlage (Anwendungs-Programm
 * Stufe 5).
 *
 * <p>Mandantenbezogen wie jede {@code /sites/**}-Route: <b>kein
 * {@code @PreAuthorize}</b> — authentifiziert zu sein plus RLS ist der Zaun,
 * eine fremde Anlage ist <b>404, nie 403</b> (das
 * {@code SiteCockpitLayoutController}-Muster). Ein Portal-Admin erreicht jede
 * Anlage über den {@code X-Tenant-Id}-Umschalter, auf demselben Datenpfad.
 *
 * <p>Read-only, ohne einen einzigen Schreibpfad: die Definitionen entstehen im
 * Layout-Dokument, hier werden nur ihre Zahlen geholt.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/eigene-auswertung")
public class SiteEigeneAuswertungController {

    private final EigeneAuswertungService service;

    public SiteEigeneAuswertungController(EigeneAuswertungService service) {
        this.service = service;
    }

    @GetMapping
    public EigeneAuswertungDto werte(@PathVariable UUID siteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate at) {
        return service.forSite(siteId, at);
    }
}
