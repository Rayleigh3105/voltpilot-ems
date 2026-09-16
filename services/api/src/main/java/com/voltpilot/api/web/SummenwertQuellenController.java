package com.voltpilot.api.web;

import com.voltpilot.api.measurement.SummenwertQuellenService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/sites/{siteId}/summenwert-quellen")
public class SummenwertQuellenController {
    private final Geltungsbereich scope;
    private final SummenwertQuellenService sources;
    public SummenwertQuellenController(Geltungsbereich scope, SummenwertQuellenService sources) {
        this.scope = scope; this.sources = sources;
    }
    /** Keine eigene Kennung: reine Leseliste, RLS und Anlagen-Geltungsbereich wie der Registerkatalog. */
    @GetMapping
    public List<SummenwertQuellenService.Quelle> sources(@PathVariable UUID siteId) {
        scope.requireSite(siteId);
        return sources.sources(siteId);
    }
}
