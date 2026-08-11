package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.rules.RuleEventReader;
import com.voltpilot.api.web.dto.RuleEventsDto;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das REGEL-PROTOKOLL einer Anlage (Einheitsmodell Stufe 5b, Teil 5b.6) -
 * mandantenbezogen wie jede {@code /api/v1/sites/**}-Route
 * ({@link SiteConsumerController}, {@link SiteFlowController}): KEIN
 * {@code @PreAuthorize}, Authentifizierung + Postgres-RLS sind der Zaun, eine
 * fremde Anlage ist 404 (nie 403), und ein Admin erreicht sie über den
 * {@code X-Tenant-Id}-Umschalter auf demselben RLS-Pfad.
 *
 * <p>Der Verlauf ist KUNDENDATEN, deshalb wohnt er hier und nicht unter
 * {@code /admin/**} - und deshalb ist seine Tabelle mandantengebunden statt
 * global wie {@code rollout_event}.
 *
 * <p>Eine Anlage ohne einen einzigen aufgezeichneten Wechsel bekommt eine
 * wohlgeformte LEERE Antwort (Listen leer, {@code recordingSince} ggf. null) -
 * das ist der Normalzustand am Tag der Auslieferung und kein Fehler.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteRuleEventController {

    private final SiteRepository sites;
    private final RuleEventReader reader;

    public SiteRuleEventController(SiteRepository sites, RuleEventReader reader) {
        this.sites = sites;
        this.reader = reader;
    }

    @GetMapping("/rule-events")
    public RuleEventsDto ruleEvents(@PathVariable UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return reader.forSite(siteId, Instant.now());
    }
}
