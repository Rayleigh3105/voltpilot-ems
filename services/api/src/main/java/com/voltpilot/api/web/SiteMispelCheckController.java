package com.voltpilot.api.web;

import com.voltpilot.api.mispel.MispelCheckRepository;
import com.voltpilot.api.web.dto.MispelCheckDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der MiSpeL-Check je Anlage (MP-48, Vertrag {@code docs/contracts/v2/mispel-check.md}): dieselbe Anlage heute gegen
 * die Abgrenzungsoption (Anlage 1 der Festlegung vom 01.10.2026), wie ihn MP-13 rechnet und MP-13b ablegt. Nur
 * lesend; das Portal zeigt ihn in Schritt 1 des Dialogs „Förderweg ändern“ (BK-48 Variante A).
 *
 * <p><b>Rechte</b> wie {@code GET …/foerderweg} an {@link SiteFoerderwegController}: der Leseweg der Anlage,
 * außerhalb des Zugriffs 404.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/mispel-check")
public class SiteMispelCheckController {

    private final MispelCheckRepository checks;
    private final RechtPruefung rechte;

    public SiteMispelCheckController(MispelCheckRepository checks, RechtPruefung rechte) {
        this.checks = checks;
        this.rechte = rechte;
    }

    /**
     * Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Der letzte Stand des Checks; ohne Zeile
     * {@code wird_gerechnet} — nie ein Betrag von 0 €.
     */
    @GetMapping
    public MispelCheckDto.Ansicht ansehen(@PathVariable UUID siteId) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
        if (!checks.anlageSichtbar(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return checks.derAnlage(siteId).map(MispelCheckDto::aus).orElseGet(() -> MispelCheckDto.wirdGerechnet(siteId));
    }
}
