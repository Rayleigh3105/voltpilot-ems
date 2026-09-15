package com.voltpilot.api.web;

import com.voltpilot.api.profile.SiteProfileService;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.SiteProfilesDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
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
 *
 * <p>Seit dem Anwendungs-Programm Stufe 2 hängt daneben das PRESET der Anlage
 * ({@code PUT .../anwendungs-preset}). Es ist bewusst eine EIGENE, schmale
 * Route und nicht ein Feld des Stammdaten-Formulars: der Assistent schreibt
 * das Profil aus einem Schritt heraus, der die Tarif-/Vergütungsfelder nie
 * geladen hat — ein voll-repräsentatives {@code PUT /sites/{id}} von dort wäre
 * ein Überschreib-Risiko. Der Name ist ausdrücklich nicht {@code /profil}: das
 * läge EIN Zeichen neben dem bestehenden {@code /profile} (dem AE7-Nutzungs-
 * profil) und wäre eine Falle für jeden späteren Leser.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteProfileController {

    /** Body of a toggle: which profile, and the state it should have. */
    public record ProfileStateRequest(String profile, String state) {}

    /** Body of a preset choice: {@code privat} | {@code gewerbe} | null. */
    public record AnwendungsPresetRequest(String profil) {}

    private final SiteProfileService profiles;

    public SiteProfileController(SiteProfileService profiles) {
        this.profiles = profiles;
    }

    @GetMapping("/profiles")
    public SiteProfilesDto get(@PathVariable UUID siteId) {
        SiteProfilesDto dto = profiles.profiles(siteId);
        if (dto == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return dto;
    }

    @PutMapping("/profiles")
    @Recht(value = "betriebsweise.aendern", ziel = RechtZiel.ANLAGE)
    public SiteProfilesDto set(@PathVariable UUID siteId,
            @RequestBody ProfileStateRequest request) {
        if (request == null || request.profile() == null || request.profile().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "profile fehlt.");
        }
        return profiles.setState(siteId, request.profile().trim(), request.state());
    }

    /**
     * Set the site's application PRESET. An absent/blank {@code profil} clears
     * it (back to „noch keins gewählt"), an unknown word is a 400 with a German
     * reason — never a silent fallback to one of the two, which would claim a
     * choice the customer never made. It changes NO switch (see
     * {@link SiteProfileService#setProfil}).
     */
    @PutMapping("/anwendungs-preset")
    @Recht(value = "betriebsweise.aendern", ziel = RechtZiel.ANLAGE)
    public SiteDto setAnwendungsPreset(@PathVariable UUID siteId,
            @RequestBody(required = false) AnwendungsPresetRequest request) {
        String profil = request == null || request.profil() == null ? null
                : request.profil().trim();
        return profiles.setProfil(siteId, profil == null || profil.isEmpty() ? null : profil);
    }

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
