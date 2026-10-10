package com.voltpilot.api.web;

import com.voltpilot.api.probe.ProbeRequest;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Probe-Kanal's customer route (Einheitsmodell Stufe 0b): "read these
 * registers on my plant once and show me what comes back".
 *
 * <p>Tenant-scoped like every {@code /api/v1/sites/**} route
 * ({@link SiteConsumerController}, {@link SiteFlowController}): NO
 * {@code @PreAuthorize} - authentication plus Postgres RLS are the fence. A
 * customer's tenant comes from the JWT claim, a Portal-Admin reaches any site
 * through the {@code X-Tenant-Id} switcher on the same RLS-scoped path, and a
 * foreign site is 404 rather than 403.
 *
 * <p>It is a READ. There is no write op on this channel: the contract's
 * reserved {@code switch_test} belongs to the later release wizard and is
 * refused by the box itself with an honest {@code not_supported}, so no request
 * shaped here can ever reach a register in write direction.
 *
 * <p>Nothing is persisted - see {@link ProbeService}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteProbeController {

    private final Geltungsbereich geltungsbereich;
    private final ProbeService probes;

    public SiteProbeController(Geltungsbereich geltungsbereich, ProbeService probes) {
        this.geltungsbereich = geltungsbereich;
        this.probes = probes;
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }

    /**
     * Ask the plant's box to read the given registers ONCE. Answers
     * synchronously within a few seconds; a box that does not answer in time
     * yields the honest {@code timeout} outcome, not an error.
     */
    @PostMapping("/modbus-probe")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public ProbeResult probe(@PathVariable UUID siteId,
            @Valid @RequestBody ProbeRequest request, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return probes.probe(siteId, request, jwt == null ? null : jwt.getSubject());
    }

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
