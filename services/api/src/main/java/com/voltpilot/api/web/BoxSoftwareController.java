package com.voltpilot.api.web;

import com.voltpilot.api.ota.BoxUpdateSicht;
import com.voltpilot.api.repo.BoxUpdateSichtRepository;
import com.voltpilot.api.web.dto.BoxSoftwareUpdateDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Update der eigenen Box für Kunde und Installateur (Erstverbindung S2):
 * die Station „Software" im Verbinden-Weg, die Box-Zeile im Aufbau und die
 * Box-Seite lesen hier, ob die Box gerade neue Software holt
 * ({@link BoxUpdateSicht}). Rein lesend; eine fremde oder unsichtbare Box ist
 * 404, nie 403.
 */
@RestController
@RequestMapping("/api/v1/devices")
public class BoxSoftwareController {

    private final BoxUpdateSichtRepository sicht;
    private final Geltungsbereich geltungsbereich;

    public BoxSoftwareController(BoxUpdateSichtRepository sicht, Geltungsbereich geltungsbereich) {
        this.sicht = sicht;
        this.geltungsbereich = geltungsbereich;
    }

    @GetMapping("/{deviceId}/software-update")
    public BoxSoftwareUpdateDto softwareUpdate(@PathVariable UUID deviceId) {
        BoxUpdateSichtRepository.Zeile z = sicht.zeile(deviceId)
                .filter(r -> geltungsbereich.siteVisible(r.siteId()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden"));
        BoxUpdateSicht.Sicht s = z.sicht(Instant.now());
        return new BoxSoftwareUpdateDto(s.phase(), s.release(), s.seit(), s.fertigAm(), s.updateLaeuft());
    }
}
