package com.voltpilot.api.web;

import com.voltpilot.api.repo.EdgeReleaseRepository;
import com.voltpilot.api.web.dto.CreateEdgeReleaseRequest;
import com.voltpilot.api.web.dto.EdgeReleaseDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Release-Register der Edge-Flotte: {@code GET/POST
 * /api/v1/admin/edge-releases} (OTA Stufe 0, Captain-Entscheid D5).
 *
 * <p><b>Warum es überhaupt existiert:</b> vor diesem Register hatte die Cloud
 * keinen Soll-Stand. Der Flotten-Puls verglich den gemeldeten Stand gegen das
 * FLOTTEN-MAXIMUM, also las sich „alle gleich alt" als „alle aktuell", und die
 * Ordnung selbst verglich 12-stellige Hex-SHAs als Zahlenblöcke - auf SHAs ist
 * das eine Zufallsordnung. Mit dem Register ist „veraltet" wohldefiniert:
 * {@code release_seq} ist eine monotone Ganzzahl und der EINZIGE Vergleich.
 *
 * <p><b>Sicherheits-Disziplin, übernommen statt neu erfunden:</b> die Route
 * liegt unter {@code /api/v1/admin/**} und die Klasse trägt
 * {@code @PreAuthorize("hasRole('platform-admin')")} wie
 * {@link AdminController} und {@link AdminFleetController} - ein Kunden-Token
 * bekommt 403, ein anonymer Aufruf 401. Die RLS-Umgehung steckt ausschließlich
 * in {@link EdgeReleaseRepository} an der dedizierten BYPASSRLS-Rolle
 * {@code voltpilot_admin}; das Register ist mandantenfrei, die Rolle liefert
 * hier die Schreibberechtigung, die die App-Rolle bewusst nicht hat.
 *
 * <p>In dieser Stufe wird das Register HAND-gepflegt und es gibt weiterhin
 * KEINEN Schreibpfad zu irgendeinem Gerät - Stufe 0 heißt „Sehen".
 */
@RestController
@RequestMapping("/api/v1/admin/edge-releases")
@PreAuthorize("hasRole('platform-admin')")
public class AdminEdgeReleaseController {

    /**
     * Das Versionsschema aus D5: {@code edge-JJJJ.MM.N}. Bewusst eng - der
     * Sinn des Registers ist eine wohldefinierte Ordnung, und ein hier
     * eingetragener nackter Commit-SHA wäre genau der unvergleichbare Wert,
     * den es ablöst. (Ein GERÄT darf durchaus eine SHA melden; die Oberfläche
     * zeigt sie dann ehrlich als „nicht registriert".)
     */
    private static final Pattern VERSION = Pattern.compile("^edge-\\d{4}\\.\\d{2}\\.\\d+$");

    private final EdgeReleaseRepository releases;

    public AdminEdgeReleaseController(EdgeReleaseRepository releases) {
        this.releases = releases;
    }

    /** Das Register, NEUESTE zuerst - der erste Eintrag ist der Soll-Stand. */
    @GetMapping
    public List<EdgeReleaseDto> list() {
        return releases.findAll();
    }

    @PostMapping
    public ResponseEntity<EdgeReleaseDto> create(@Valid @RequestBody CreateEdgeReleaseRequest req,
            @AuthenticationPrincipal Jwt caller) {
        String version = req.version().trim();
        if (!VERSION.matcher(version).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Version muss dem Schema edge-JJJJ.MM.N folgen (z. B. edge-2026.08.0).");
        }
        if (releases.findByVersion(version).isPresent()) {
            // Bewusst 409 statt einer idempotenten 200: ein Release entsteht
            // EINMAL und von Hand. Ein stilles „ist schon da" würde einen
            // abweichenden Commit im Body verschlucken - und das Register ist
            // die Papier-Spur, die genau das beantworten soll.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + version + "' ist bereits registriert.");
        }
        Long max = releases.maxSeq();
        long seq;
        if (req.releaseSeq() == null) {
            seq = max == null ? 1L : max + 1L;
        } else {
            seq = req.releaseSeq();
            if (max != null && seq <= max) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "release_seq muss groesser als die hoechste vergebene Nummer (" + max
                                + ") sein - die Reihenfolge ist monoton.");
            }
        }
        EdgeReleaseDto created = releases.insert(seq, version, blankToNull(req.targetCommit()),
                blankToNull(req.notes()), caller == null ? null : caller.getSubject());
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    /**
     * Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}
     * -Körper statt als nackter Status (das Muster von
     * {@link AdminOptimizerController}).
     */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
