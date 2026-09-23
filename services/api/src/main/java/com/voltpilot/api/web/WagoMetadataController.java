package com.voltpilot.api.web;

import com.voltpilot.api.components.WagoMetadataService;
import com.voltpilot.api.components.WagoMetadataService.Geraet;
import com.voltpilot.api.components.WagoMetadataService.GeraetEintrag;
import com.voltpilot.api.components.WagoMetadataService.Karte;
import com.voltpilot.api.components.WagoMetadataService.KartenEintrag;
import com.voltpilot.api.components.WagoMetadataService.Kartenwechsel;
import com.voltpilot.api.components.WagoKartenAnlage;
import com.voltpilot.api.components.WagoSollLesung;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.security.Principal;
import org.springframework.security.core.Authentication;
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
    private final WagoSollLesung soll;
    private final WagoKartenAnlage karten;
    public WagoMetadataController(WagoMetadataService service, WagoSollLesung soll,
            WagoKartenAnlage karten) {
        this.service = service;
        this.soll = soll;
        this.karten = karten;
    }

    /**
     * Recht: {@code geraet.einrichten}. Der Assistent legt die Karten-Komponenten EINER Steuerung und
     * ihren Controller in einer Transaktion an: je Karte ein {@code geraet_teil} mit Steckplatz und
     * gelesenem Kartentyp. Ohne diese Karten gäbe es weder Registerbild noch Soll-Lesung.
     */
    @PostMapping("/api/v1/sites/{siteId}/wago/karten")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public WagoKartenAnlage.Ergebnis kartenAnlegen(@PathVariable UUID siteId,
            @Valid @RequestBody WagoKartenAnlage.Anlegen in, Principal actor) {
        return karten.anlegen(siteId, in, actor.getName());
    }

    /**
     * Recht: {@code geraet.einrichten}. Bestand: WAGO-Komponenten ohne Karte bekommen EINEN Controller
     * mit ihren Karten, ab der nächsten vollen Minute; die abgeleitete Speisung endet dort. Eine
     * Komponente mit Karte bleibt unberührt (409).
     */
    @PostMapping("/api/v1/sites/{siteId}/wago/karten/nachtragen")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public WagoKartenAnlage.Ergebnis kartenNachtragen(@PathVariable UUID siteId,
            @Valid @RequestBody WagoKartenAnlage.Nachtragen in, Principal actor) {
        return karten.nachtragen(siteId, in, actor.getName());
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

    /**
     * Recht: {@code geraet.einrichten}. Das Soll des Registerbilds (Controller-Kennung, je Karte
     * Variante und Kartentyp) AUS DER STEUERUNG lesen und in leere Stellen speichern — nie aus einer
     * Eingabe; der Körper nennt nur die Box, die liest. Eine abweichende Lesung überschreibt nichts,
     * sie steht in der Antwort und im Journal am Einbau. Die Antwort ist ein ehrlicher Ausgang (200),
     * auch wenn die Box schweigt.
     */
    @PostMapping("/api/v1/geraete/{id}/wago/soll-lesen")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.GERAET)
    public WagoSollLesung.Ergebnis sollLesen(@PathVariable UUID id,
            @RequestBody WagoSollLesung.Eingabe in, Authentication auth) {
        return soll.lesen(id, in, OrtAnfrage.akteur(auth));
    }
}
