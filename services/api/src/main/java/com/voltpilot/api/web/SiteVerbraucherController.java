package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.verbraucher.VerbraucherService;
import com.voltpilot.api.web.dto.VerbraucherDto;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Zone „Verbraucher" einer Anlage (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §6, Paket P1).
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route
 * ({@link SiteConsumerController}, {@link SiteChargerController}): KEIN
 * {@code @PreAuthorize}, Authentifizierung + Postgres-RLS sind der Zaun, eine
 * fremde Anlage ist 404 (nie 403), und ein Admin erreicht sie ueber den
 * {@code X-Tenant-Id}-Umschalter auf demselben RLS-Pfad.
 *
 * <p><b>READ-ONLY, und das ist eine Konstruktions-Aussage.</b> Es gibt hier
 * bewusst KEINE Route, die eine Steuerart setzt - dieses Paket zeigt nur, was
 * schon gilt; geschrieben wird weiterhin ueber die bestehenden Wege (Policy
 * bzw. {@code charging-config}), und der EINE Schreibweg der Steuerart entsteht
 * in Paket P2/P4. Dieselbe Disziplin wie beim Ladepunkt-Lesepfad.
 *
 * <p>Eine Anlage ohne steuerbares Geraet bekommt eine wohlgeformte LEERE
 * Antwort - der Normalzustand vieler Anlagen, kein Fehler.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteVerbraucherController {

    private final SiteRepository sites;
    private final VerbraucherService verbraucher;

    public SiteVerbraucherController(SiteRepository sites, VerbraucherService verbraucher) {
        this.sites = sites;
        this.verbraucher = verbraucher;
    }

    @GetMapping("/verbraucher")
    public VerbraucherDto verbraucher(@PathVariable UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return verbraucher.forSite(siteId);
    }
}
