package com.voltpilot.api.web;

import com.voltpilot.api.consumers.SchaltSpur;
import com.voltpilot.api.consumers.SchaltSpurRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Schaltspur eines Verbrauchers (vp-schalten-3s, {@link SchaltSpur}): wo die Zeit zwischen Klick und bestätigtem
 * Zustand hingeht.
 *
 * <ul>
 *   <li>{@code GET /api/v1/admin/sites/{siteId}/consumers/{id}/schaltspuren} - die jüngsten Spuren für „Technik &amp;
 *       Diagnose“ der Geräteseite, nur für die Plattform-Administration (wie {@code AdminChargingFrameController}
 *       über den {@code X-Tenant-Id}-Umschalter auf dem RLS-Pfad, kein BYPASSRLS).</li>
 *   <li>{@code POST /api/v1/sites/{siteId}/consumers/{id}/schaltspuren/{spur}/portal} - das Portal meldet, was nur
 *       es messen kann: Klick bis Antwort der API und Klick bis bestätigt sichtbar, in der monotonen Uhr des
 *       Browsers. Dasselbe Recht wie der Handeingriff selbst; nur der erste Bericht zählt.</li>
 * </ul>
 */
@RestController
public class SchaltSpurController {

    private final Geltungsbereich geltungsbereich;
    private final SchaltSpur spur;

    public SchaltSpurController(Geltungsbereich geltungsbereich, SchaltSpur spur) {
        this.geltungsbereich = geltungsbereich;
        this.spur = spur;
    }

    /** Was das Portal misst; beide Werte in Millisekunden ab dem Klick, fehlend = nicht gemessen. */
    public record PortalZeiten(Integer antwortMs, Integer sichtbarMs) {
    }

    /** Eine Spur für die Technik-Ansicht. Zeitpunkte {@code box*} in der Uhr der Box, alle übrigen in der der API. */
    public record SchaltSpurDto(UUID id, UUID deviceId, String requestId, String art, String kommando,
            BigDecimal wert, List<Integer> ausgaenge, Instant apiEingang, Instant gesendet, String zustellung,
            Instant ersteMeldung, Instant boxEmpfangen, Instant boxEntschieden, Instant boxGeschrieben,
            Instant boxZurueckgelesen, Instant boxGemeldet, String boxUrteil, Instant gehalten, String grund,
            Instant bestaetigt, String ergebnis, Integer portalAntwortMs, Integer portalSichtbarMs) {

        static SchaltSpurDto von(SchaltSpurRepository.Zeile z) {
            return new SchaltSpurDto(z.id(), z.deviceId(), z.requestId(), z.art(), z.kommando(), z.wert(),
                    z.ausgaenge(), z.apiEingang(), z.gesendet(), z.zustellung(), z.ersteMeldung(), z.boxEmpfangen(),
                    z.boxEntschieden(), z.boxGeschrieben(), z.boxZurueckgelesen(), z.boxGemeldet(), z.boxUrteil(),
                    z.gehalten(), z.grund(), z.bestaetigt(), z.ergebnis(), z.portalAntwortMs(), z.portalSichtbarMs());
        }
    }

    @GetMapping("/api/v1/admin/sites/{siteId}/consumers/{id}/schaltspuren")
    @PreAuthorize("hasRole('platform-admin')")
    public List<SchaltSpurDto> liste(@PathVariable UUID siteId, @PathVariable UUID id) {
        geltungsbereich.requireSite(siteId);
        return spur.liste(siteId, id).stream().map(SchaltSpurDto::von).toList();
    }

    @PostMapping("/api/v1/sites/{siteId}/consumers/{id}/schaltspuren/{spurId}/portal")
    @Recht(value = "handeingriff.setzen", ziel = RechtZiel.ANLAGE)
    public ResponseEntity<Void> portal(@PathVariable UUID siteId, @PathVariable UUID id, @PathVariable UUID spurId,
            @RequestBody PortalZeiten zeiten) {
        geltungsbereich.requireSite(siteId);
        if (zeiten == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Keine Zeiten gemeldet.");
        }
        return spur.portal(siteId, id, spurId, zeiten.antwortMs(), zeiten.sichtbarMs())
                ? ResponseEntity.noContent().build()
                : ResponseEntity.notFound().build();
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
