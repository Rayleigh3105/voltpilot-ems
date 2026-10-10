package com.voltpilot.api.web;

import com.voltpilot.api.uems.MessbedarfService;
import com.voltpilot.api.web.dto.MessbedarfDto.Liste;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** AP-16 P1: die Messbedarfe aller Energieeinsätze, wahlweise nur die an einem Standort (Befund aus IP-20). */
@RestController
@RequestMapping("/api/v1/unternehmen/messbedarf")
public class MessbedarfUebersichtController {
    private final MessbedarfService dienst;
    public MessbedarfUebersichtController(MessbedarfService dienst) { this.dienst=dienst; }
    /**
     * Recht: {@code energieeinsatz.ansehen}; je Bedarf der Zaun seines Energieeinsatzes. Mit {@code standort} nur Bedarfe,
     * deren strukturierter Ort heute dort hängt; ein unbekannter oder fremder Standort ist 404.
     */
    @GetMapping public Liste liste(@RequestParam(name="standort",required=false) UUID standort) {
        return dienst.alle(standort);
    }
}
