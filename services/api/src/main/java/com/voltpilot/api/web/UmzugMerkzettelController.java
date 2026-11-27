package com.voltpilot.api.web;

import java.time.Instant;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import com.voltpilot.api.repo.PreisfassungRepository;
import com.voltpilot.api.repo.UmzugMerkzettelRepository;
import com.voltpilot.api.repo.UmzugMerkzettelRepository.Merkzettel;
import com.voltpilot.api.repo.UmzugMerkzettelRepository.MerkzettelTeil;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;

/**
 * Der Merkzettel „Neues Haus? Bitte prüfen" nach einem Umzug (vp-standort-konzept §7, E1 = B,
 * Bericht 6.6 Punkt 7) — angelegt von {@code AnlageOrtService#umziehen}, hier nur gelesen und
 * mit einem Tipp je Teil erledigt. „Geprüft" und „weggeklickt" sind dieselbe Handlung; „geändert"
 * für Stromtarif/Einspeisevergütung kommt live aus {@link PreisfassungRepository} dazu, ohne
 * eigene Spalte. Kein freigeschaltetes Recht nötig zum LESEN (wie {@code SitePreisfassungController}
 * — RLS genügt); zum Erledigen dasselbe Recht wie am allgemeinen Anlage-Schreibweg
 * ({@code SiteController#updateSite}).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/umzug-merkzettel")
public class UmzugMerkzettelController {

    public record UmzugMerkzettelDto(Instant seit, boolean solaranlageErledigt, boolean stromtarifErledigt,
            boolean einspeiseverguetungErledigt) {
    }

    public record ErledigenAnfrage(MerkzettelTeil teil) {
    }

    private final UmzugMerkzettelRepository merkzettel;
    private final PreisfassungRepository preisfassungen;
    private final Geltungsbereich geltungsbereich;

    public UmzugMerkzettelController(UmzugMerkzettelRepository merkzettel, PreisfassungRepository preisfassungen,
            Geltungsbereich geltungsbereich) {
        this.merkzettel = merkzettel;
        this.preisfassungen = preisfassungen;
        this.geltungsbereich = geltungsbereich;
    }

    /** {@code 204} ohne offenen Merkzettel (keiner, oder alle drei schon erledigt). */
    @GetMapping
    public ResponseEntity<UmzugMerkzettelDto> lesen(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        return merkzettel.lesen(siteId)
                .map(m -> effektiv(siteId, m))
                .filter(d -> !(d.solaranlageErledigt() && d.stromtarifErledigt() && d.einspeiseverguetungErledigt()))
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.noContent().build());
    }

    @PostMapping("/erledigen")
    @Recht(value = "anlage.verwalten", ziel = RechtZiel.ANLAGE)
    public ResponseEntity<Void> erledigen(@PathVariable UUID siteId, @RequestBody ErledigenAnfrage a) {
        geltungsbereich.requireSite(siteId);
        if (!merkzettel.erledigenSetzen(siteId, a.teil())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Kein Merkzettel für diese Anlage.");
        }
        return ResponseEntity.noContent().build();
    }

    private UmzugMerkzettelDto effektiv(UUID siteId, Merkzettel m) {
        // Stromtarif/Einspeisevergütung gelten GEMEINSAM als geändert, sobald seit dem Umzug
        // irgendein Teil der Preisfassung neu geschrieben wurde (eine Fassung trägt alle drei
        // Teile zusammen) - eine feinere Unterscheidung bräuchte einen Vergleich gegen die
        // vorherige Fassung, den dieser einfache Merkzettel bewusst nicht führt.
        boolean preiseGeaendert = preisfassungen.geaendertSeit(siteId, m.seit());
        return new UmzugMerkzettelDto(
                m.seit(),
                m.solaranlageErledigt(),
                m.stromtarifErledigt() || preiseGeaendert,
                m.einspeiseverguetungErledigt() || preiseGeaendert);
    }
}
