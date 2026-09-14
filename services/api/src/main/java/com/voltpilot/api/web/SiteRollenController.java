package com.voltpilot.api.web;

import com.voltpilot.api.topology.RollenZuordnungService;
import com.voltpilot.api.web.dto.RollenDto;
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
 * Die KUNDEN-Fläche der geraeteseitigen Rollen-Zuordnung („verwenden als", Konzept
 * vp-agg-konzept2-f3 §2.3, vp-agg-konzept3-r8):
 *
 * <ul>
 *   <li>{@code GET  …/komponenten/{entityId}/rollen/{role}} — der massgebliche Rollen-Wert EINES
 *       Geraets.</li>
 *   <li>{@code PUT  …/komponenten/{entityId}/rollen/{role}} — ihn setzen (nativer Kanal ODER
 *       Gesamtwert); die Antwort nennt den abgeloesten Wert (is_primary-Semantik).</li>
 *   <li>{@code GET  …/rollen/{role}} — der kanonische, ueber alle Geraete zusammengefasste
 *       Rollen-Wert der Anlage, mit Ehrlichkeits-Metadaten je Geraet.</li>
 * </ul>
 *
 * <p>Tenant-scoped wie jede {@code /api/v1/sites/**}-Route ({@link SiteController},
 * {@link SiteTopologyController}): KEIN {@code @PreAuthorize} — Authentifizierung + Postgres-RLS
 * sind der Zaun, eine fremde Anlage ist 404, nie 403. Admins erreichen jeden Mandanten ueber den
 * {@code X-Tenant-Id}-Schalter auf demselben RLS-Pfad. Das Öffnen fuer Kunden ist sicher: eine
 * Rolle ist PRAESENTATION und weitet keine Steuerung (Waechter/Arbitrierung schluesseln auf
 * Faehigkeiten, nicht auf Rollen).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteRollenController {

    private final RollenZuordnungService rollen;

    public SiteRollenController(RollenZuordnungService rollen) {
        this.rollen = rollen;
    }

    /** Der massgebliche Rollen-Wert eines Geraets ({@code zugeordnet == null} = keine Zuordnung). */
    @GetMapping("/komponenten/{entityId}/rollen/{role}")
    public RollenDto.GeraetRolle geraet(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @PathVariable String role) {
        return rollen.lies(siteId, entityId, role);
    }

    /** Den massgeblichen Rollen-Wert eines Geraets setzen; der abgeloeste Wert wird genannt. */
    @PutMapping("/komponenten/{entityId}/rollen/{role}")
    @Transactional
    public RollenDto.ZuordnungAntwort zuordnen(@PathVariable UUID siteId,
            @PathVariable UUID entityId, @PathVariable String role,
            @RequestBody(required = false) RollenDto.Eingabe body) {
        return rollen.zuordnen(siteId, entityId, role, body);
    }

    /** Der kanonische Rollen-Wert der Anlage (die benannte Summe der Geraete-Zuordnungen). */
    @GetMapping("/rollen/{role}")
    public RollenDto.KanonischerWert anlage(@PathVariable UUID siteId, @PathVariable String role) {
        return rollen.kanonisch(siteId, role);
    }

    /** Deutsche Gruende erreichen das Portal als {@code {"message": …}} (SiteFlowController-Muster). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
