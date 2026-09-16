package com.voltpilot.api.web;

import com.voltpilot.api.measurement.SummenwertQuellenService;
import com.voltpilot.api.repo.SiteRepository;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/sites/{siteId}/summenwert-quellen")
public class SummenwertQuellenController {
    private final SiteRepository scope;
    private final SummenwertQuellenService sources;
    public SummenwertQuellenController(SiteRepository scope, SummenwertQuellenService sources) {
        this.scope = scope; this.sources = sources;
    }
    /** Keine eigene Kennung: reine Leseliste, RLS und Anlagen-Geltungsbereich wie der Registerkatalog. */
    @GetMapping
    public List<SummenwertQuellenService.Quelle> sources(@PathVariable UUID siteId,
            @RequestParam(required = false) UUID boxId, @RequestParam(required = false) String geraetId) {
        if (!scope.existsForCurrentTenant(siteId)) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return sources.sources(siteId, boxId, geraetId);
    }
}
