package com.voltpilot.api.web;

import com.voltpilot.api.profile.SiteProfileService;
import com.voltpilot.api.web.dto.SiteProfilesDto;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Modus-Profile shelf of one Anlage (Portal v3 M3): read the shelf, toggle
 * a profile. Tenant-scoped like every {@code /api/v1/sites/**} route
 * ({@link SiteFlowController} / {@link SiteTopologyController} pattern): NO
 * {@code @PreAuthorize} - authentication + Postgres RLS are the fence, so a
 * foreign site is 404, never 403. A Portal-Admin reaches any tenant's site
 * through the {@code X-Tenant-Id} switcher, the same RLS-scoped path.
 *
 * <p>Every profile is a direct customer toggle; the two states are {@code an}
 * and {@code aus} (there is no "angefragt"). The transition's server-side
 * effects live in {@link SiteProfileService}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/profiles")
public class SiteProfileController {

    /** Body of a toggle: which profile, and the state it should have. */
    public record ProfileStateRequest(String profile, String state) {}

    private final SiteProfileService profiles;

    public SiteProfileController(SiteProfileService profiles) {
        this.profiles = profiles;
    }

    @GetMapping
    public SiteProfilesDto get(@PathVariable UUID siteId) {
        SiteProfilesDto dto = profiles.profiles(siteId);
        if (dto == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return dto;
    }

    @PutMapping
    public SiteProfilesDto set(@PathVariable UUID siteId,
            @RequestBody ProfileStateRequest request) {
        if (request == null || request.profile() == null || request.profile().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "profile fehlt.");
        }
        return profiles.setState(siteId, request.profile().trim(), request.state());
    }

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
