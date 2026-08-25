package com.voltpilot.api.web;

import com.voltpilot.api.cockpit.CockpitLayoutService;
import com.voltpilot.api.cockpit.EigeneAuswertung.CustomBaustein;
import com.voltpilot.api.profile.AnwendungKatalog.LayoutDoc;
import com.voltpilot.api.web.dto.CockpitLayoutDto;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das COCKPIT-LAYOUT einer Anlage (Anwendungs-Programm Stufe 3): lesen,
 * schreiben, zurücksetzen. Mandantenbezogen wie jede {@code /api/v1/sites/**}-
 * Route ({@link SiteProfileController}/{@link SiteFlowController}-Muster):
 * <b>kein klassenweites {@code @PreAuthorize}</b> — Authentifizierung + RLS
 * sind der Zaun, eine fremde Anlage ist <b>404, nie 403</b>. Ein Portal-Admin
 * erreicht jede Anlage über den {@code X-Tenant-Id}-Umschalter, auf demselben
 * RLS-gefencten Datenpfad.
 *
 * <p><b>Die Rechte-Ordnung (Captain-Entscheid E2) sitzt an EINER Stelle:</b>
 * {@link #requireVorgabeRecht}. Der Kunde schreibt seine eigene Schicht
 * ({@code layer=eigen}) — sie GEWINNT; die Schicht {@code vorgabe} darf nur
 * ein {@code platform-admin} schreiben. Das ist bewusst eine METHODEN-Prüfung
 * und kein zweiter Datenpfad: eine Vorgabe ist derselbe Datensatz unter einer
 * anderen Schicht, und ein eigener BYPASSRLS-Weg dafür wäre eine zweite
 * Wahrheit über denselben Vorgang. Kommt eine Betreiber-Rolle, hängt sie sich
 * genau hier ein — eine Zeile, ein Ort.
 *
 * <p><b>Ein Admin schreibt standardmäßig die VORGABE</b> (§3.3): er handelt als
 * Betreiber. Der Support-Fall „als Kunde anpassen" ist derselbe Aufruf mit
 * {@code layer=eigen} — sichtbar in der Fläche, nie stillschweigend.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/cockpit-layout")
public class SiteCockpitLayoutController {

    private static final String PLATFORM_ADMIN_AUTHORITY = "ROLE_platform-admin";

    /** Der Rumpf eines Schreibvorgangs — NUR Absicht, nie die gerenderte Fläche. */
    public record LayoutRequest(List<String> order, List<String> hidden, List<String> shown,
            String lead, List<CustomRequest> custom) {}

    /**
     * Eine EIGENE Auswertung im Rumpf (Anwendungs-Programm Stufe 5). Bewusst
     * ein eigener Typ statt {@code CustomBaustein} direkt: der Rumpf darf
     * lückenhaft ankommen, und {@code EigeneAuswertung.pruefeForm} soll den
     * deutschen Grund nennen — nicht Jackson einen englischen Parser-Fehler.
     */
    public record CustomRequest(String id, String titel, String darstellung, String entityId,
            String channel, String aggregat) {}

    private final CockpitLayoutService layouts;

    public SiteCockpitLayoutController(CockpitLayoutService layouts) {
        this.layouts = layouts;
    }

    @GetMapping
    public CockpitLayoutDto get(@PathVariable UUID siteId) {
        CockpitLayoutDto dto = layouts.forSite(siteId, isPlatformAdmin());
        if (dto == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return dto;
    }

    @PutMapping
    public CockpitLayoutDto put(@PathVariable UUID siteId,
            @RequestParam(name = "layer", defaultValue = "eigen") String layer,
            @RequestBody(required = false) LayoutRequest request,
            @AuthenticationPrincipal Jwt caller) {
        requireVorgabeRecht(layer);
        return layouts.saveForSite(siteId, layer, document(request), subject(caller),
                isPlatformAdmin());
    }

    @DeleteMapping
    public CockpitLayoutDto reset(@PathVariable UUID siteId,
            @RequestParam(name = "layer", defaultValue = "eigen") String layer) {
        requireVorgabeRecht(layer);
        return layouts.resetForSite(siteId, layer, isPlatformAdmin());
    }

    /**
     * Die EINE Rechte-Prüfung der Stufe: die Schicht {@code vorgabe} gehört dem
     * Betreiber, {@code eigen} dem Kunden. Ein unbekanntes Wort fällt durch —
     * der Dienst lehnt es danach mit deutschem Grund ab, statt hier still auf
     * eine der beiden Schichten zurückzufallen.
     */
    private void requireVorgabeRecht(String layer) {
        if ("vorgabe".equals(layer) && !isPlatformAdmin()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "Eine Vorgabe kann nur VoltPilot hinterlegen. Ihre eigene Anordnung "
                            + "speichern Sie mit „Fertig“.");
        }
    }

    static boolean isPlatformAdmin() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> PLATFORM_ADMIN_AUTHORITY.equals(a.getAuthority()));
    }

    static LayoutDoc document(LayoutRequest request) {
        if (request == null) {
            return LayoutDoc.leer();
        }
        return new LayoutDoc(list(request.order()), list(request.hidden()), list(request.shown()),
                blankToNull(request.lead()), custom(request.custom()));
    }

    /** Die eigenen Auswertungen des Rumpfs — Trimmen, sonst unverändert. */
    private static List<CustomBaustein> custom(List<CustomRequest> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        List<CustomBaustein> out = new ArrayList<>();
        for (CustomRequest c : raw) {
            if (c == null) {
                continue;
            }
            out.add(new CustomBaustein(trim(c.id()), trim(c.titel()), trim(c.darstellung()),
                    trim(c.entityId()), trim(c.channel()), trim(c.aggregat())));
        }
        return List.copyOf(out);
    }

    private static String trim(String raw) {
        return raw == null ? null : raw.trim();
    }

    private static List<String> list(List<String> raw) {
        return raw == null ? List.of() : List.copyOf(raw);
    }

    private static String blankToNull(String raw) {
        String s = raw == null ? "" : raw.trim();
        return s.isEmpty() ? null : s;
    }

    static String subject(Jwt caller) {
        return caller == null ? null : caller.getSubject();
    }

    /** Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
