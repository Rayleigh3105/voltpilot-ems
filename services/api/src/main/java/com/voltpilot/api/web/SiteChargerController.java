package com.voltpilot.api.web;

import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.web.dto.SiteChargingDto;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die LADEPUNKTE einer Anlage (Lastmanagement Stufe 3): das Standort-Budget und
 * je Säule ihre Stecker, so wie die Box sie gemeldet hat.
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route
 * ({@link SiteCommandHistoryController}, {@link SiteConsumerController}): KEIN
 * {@code @PreAuthorize}, Authentifizierung + Postgres-RLS sind der Zaun, eine
 * fremde Anlage ist 404 (nie 403), und ein Admin erreicht sie über den
 * {@code X-Tenant-Id}-Umschalter auf demselben RLS-Pfad.
 *
 * <p><b>READ-ONLY, und das ist eine Konstruktions-Aussage.</b> Es gibt hier
 * bewusst KEINE Route, die eine Ladegrenze setzt: Grenzen entstehen allein im
 * Lastmanagement auf der Box (die Anschlussgrenze ist eine physische Grenze,
 * ihr Wächter darf nicht am WAN hängen - Konzept E1), damit diese Fläche nie
 * ein zweiter, unarbitrierter Schreiber auf eine Kundenanlage wird. Dieselbe
 * Regel gilt seit Stufe 0 für die {@code :8484}-Karte.
 *
 * <p>Eine Anlage ohne Ladesäulen bekommt eine wohlgeformte LEERE Antwort
 * ({@code budget} null, {@code chargers} leer) - der Normalzustand jeder
 * bestehenden Anlage, kein Fehler und nie ein Budget von 0.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteChargerController {

    private final Geltungsbereich geltungsbereich;
    private final DeviceChargerStatusRepository chargers;

    public SiteChargerController(Geltungsbereich geltungsbereich, DeviceChargerStatusRepository chargers) {
        this.geltungsbereich = geltungsbereich;
        this.chargers = chargers;
    }

    @GetMapping("/chargers")
    public SiteChargingDto chargers(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        return chargers.forSite(siteId);
    }
}
