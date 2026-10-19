package com.voltpilot.api.web;

import com.voltpilot.api.mispel.MispelWegRegeln;
import com.voltpilot.api.mispel.MispelWegRegeln.Eingang;
import com.voltpilot.api.mispel.MispelWegService;
import com.voltpilot.api.web.dto.MispelWegDto;
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
 * „Der Weg zu MiSpeL“ je Anlage (MP-55, Bedienkonzept BK-52 A, Vertrag {@code docs/contracts/v2/mispel-weg.md}): die
 * Stationen der Strecke mit Zustand, Stand und Tür, zusammengelesen aus den vorhandenen MiSpeL-Quellen. Nur lesend; die
 * Fläche im Portal ist MP-56.
 *
 * <p><b>Rechte</b> wie {@code GET …/mispel-check} und {@code GET …/foerderweg}: der Leseweg der Anlage, außerhalb des
 * Zugriffs 404.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/mispel-weg")
public class SiteMispelWegController {

    private final MispelWegService weg;
    private final RechtPruefung rechte;

    public SiteMispelWegController(MispelWegService weg, RechtPruefung rechte) {
        this.weg = weg;
        this.rechte = rechte;
    }

    /** Recht: {@code messwerte.ansehen} (Leseweg der Anlage). */
    @GetMapping
    public MispelWegDto.Ansicht ansehen(@PathVariable UUID siteId) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
        if (!weg.anlageSichtbar(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        Eingang e = weg.eingang(siteId);
        return MispelWegDto.aus(siteId, e.heute(), MispelWegRegeln.strecken(e));
    }
}
