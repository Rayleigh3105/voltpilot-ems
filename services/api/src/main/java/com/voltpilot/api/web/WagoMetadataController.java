package com.voltpilot.api.web;

import com.voltpilot.api.components.WagoMetadataService;
import com.voltpilot.api.components.WagoMetadataService.Geraet;
import com.voltpilot.api.components.WagoMetadataService.GeraetEintrag;
import com.voltpilot.api.components.WagoMetadataService.Karte;
import com.voltpilot.api.components.WagoMetadataService.KartenEintrag;
import com.voltpilot.api.components.WagoMetadataService.Kartenwechsel;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.security.Principal;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** UEMS AP-05: Cloud-Dokumentation, keine Box-Konfiguration und keine Pilotfreigabe. */
@RestController
public class WagoMetadataController {
    private final WagoMetadataService service;
    public WagoMetadataController(WagoMetadataService service) {
        this.service = service;
    }

    /** Recht: {@code messwerte.ansehen}. */
    @GetMapping("/api/v1/sites/{siteId}/components/{entityId}/wago")
    public Karte karte(@PathVariable UUID siteId, @PathVariable UUID entityId) {
        return service.karte(siteId, entityId);
    }

    /** Recht: {@code geraet.einrichten}. */
    @PutMapping("/api/v1/sites/{siteId}/components/{entityId}/wago")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public Karte karte(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @Valid @RequestBody KartenEintrag in, Principal actor) {
        return service.eintragen(siteId, entityId, in, actor.getName());
    }

    /**
     * Recht: {@code geraet.einrichten} — dieselbe Kennung wie die Kartenangaben, an derselben
     * Anlage. Ein Kartenwechsel ist eine Gerätegrenze OHNE Gerätewechsel (AP-05 E6): er legt kein
     * Gerät an, hängt nichts um und löscht nichts.
     */
    @PostMapping("/api/v1/sites/{siteId}/components/{entityId}/wago/kartenwechsel")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public Karte kartenwechsel(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @Valid @RequestBody Kartenwechsel in, Principal actor) {
        return service.kartenwechsel(siteId, entityId, in, actor.getName());
    }

    /** Recht: {@code messwerte.ansehen}. */
    @GetMapping("/api/v1/geraete/{id}/wago")
    public Geraet geraet(@PathVariable UUID id) {
        return service.geraet(id);
    }

    /** Recht: {@code geraet.einrichten}. */
    @PutMapping("/api/v1/geraete/{id}/wago")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.GERAET)
    public Geraet geraet(@PathVariable UUID id, @Valid @RequestBody GeraetEintrag in) {
        return service.eintragen(id, in);
    }
}
