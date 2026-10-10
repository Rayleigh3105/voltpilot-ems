package com.voltpilot.api.web;

import com.voltpilot.api.topology.RollenZuordnungService;
import com.voltpilot.api.topology.RollenKonflikt;
import com.voltpilot.api.uems.MessstelleFormelService;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import java.util.List;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import com.voltpilot.api.web.dto.RollenDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS Live-Rollen: Gerät/Anlage setzen, lesen und entziehen. Die Zuordnung wirkt ab jetzt
 * auf die Cloud-Anzeige. Lesende Wege bleiben RLS-/Geltungsbereich-geschützt, Schreibwege
 * verlangen das Einrichtungsrecht. Fremde Anlagen/Komponenten bleiben 404.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteRollenController {

    private final RollenZuordnungService rollen;
    private final MessstelleFormelService formeln;
    private final RechtPruefung rechte;

    public SiteRollenController(RollenZuordnungService rollen, MessstelleFormelService formeln, RechtPruefung rechte) {
        this.rollen = rollen;
        this.formeln = formeln;
        this.rechte = rechte;
    }

    /**
     * Die Summenwerte, die das Gerät lesen. Zaun wie an der Messstelle (AP-03 R-A1/R-A3/R-A6): eine Messstelle außerhalb
     * des Zugriffs fehlt ohne Hinweis und ohne Anzahl; liegt ein Eingang eines sichtbaren Summenwerts außerhalb, fehlt
     * seine Zahl ganz ({@code wert.ausserhalb_zugriff}, dieselbe Form wie {@code GET /messstellen/{id}/wert}).
     */
    // Recht: keine eigene Kennung — lesend über RLS und Geltungsbereich.
    @GetMapping("/komponenten/{entityId}/summenwerte")
    public List<MessstelleFormelDto.GeraetSummenwert> summenwerte(
            @PathVariable UUID siteId, @PathVariable UUID entityId) {
        return formeln.summenwerte(siteId, entityId).stream()
                .filter(s -> rechte.lesbar(RechtZiel.MESSSTELLE, s.messstelle().id()))
                .map(s -> formeln.imZugriff(formeln.eingaenge(s.messstelle().id(), null),
                        ms -> rechte.alleLesbar(RechtZiel.MESSSTELLE, ms)) ? s
                        : new MessstelleFormelDto.GeraetSummenwert(s.messstelle(), s.rolle(),
                                new MessstelleFormelDto.Wert(null, s.wert().einheit(), true, List.of(), null,
                                        RechtPruefung.AUSSERHALB_ZUGRIFF)))
                .toList();
    }

    /** Der massgebliche Rollen-Wert eines Geraets ({@code zugeordnet == null} = keine Zuordnung). */
    // Recht: keine eigene Kennung — lesend über RLS und Geltungsbereich.
    @GetMapping("/komponenten/{entityId}/rollen/{role}")
    public RollenDto.GeraetRolle geraet(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @PathVariable String role) {
        return rollen.lies(siteId, entityId, role);
    }

    /** Den massgeblichen Rollen-Wert eines Geraets setzen; der abgeloeste Wert wird genannt. */
    // Recht: {@code geraet.einrichten}
    @PutMapping("/komponenten/{entityId}/rollen/{role}")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    @Transactional
    public RollenDto.ZuordnungAntwort zuordnen(@PathVariable UUID siteId,
            @PathVariable UUID entityId, @PathVariable String role,
            @RequestBody(required = false) RollenDto.Eingabe body, Authentication auth) {
        return rollen.zuordnen(siteId, entityId, role, body, OrtAnfrage.akteur(auth));
    }

    /** Der kanonische Rollen-Wert der Anlage (die benannte Summe der Geraete-Zuordnungen). */
    // Recht: keine eigene Kennung — lesend über RLS und Geltungsbereich.
    @GetMapping("/rollen/{role}")
    public RollenDto.KanonischerWert anlage(@PathVariable UUID siteId, @PathVariable String role) {
        return rollen.kanonisch(siteId, role);
    }

    // Recht: {@code geraet.einrichten}
    @PutMapping("/rollen/{role}")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    @Transactional
    public RollenDto.AnlageAntwort anlageZuordnen(@PathVariable UUID siteId, @PathVariable String role,
            @RequestBody(required = false) RollenDto.AnlageEingabe body, Authentication auth) {
        return rollen.zuordnenAnlage(siteId, role, body, OrtAnfrage.akteur(auth));
    }

    // Recht: {@code geraet.einrichten}
    @DeleteMapping("/komponenten/{entityId}/rollen/{role}")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    @Transactional
    public RollenDto.ZuordnungAntwort entziehen(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @PathVariable String role, Authentication auth) {
        return rollen.entziehen(siteId, entityId, role, OrtAnfrage.akteur(auth));
    }

    /** Deutsche Gruende erreichen das Portal als {@code {"message": …}} (SiteFlowController-Muster). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        if (e instanceof RollenKonflikt k) {
            return ResponseEntity.status(k.getStatusCode()).body(Map.of(
                    "code", k.code(), "message", k.getReason(), "halter", k.halter()));
        }
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
