package com.voltpilot.api.web;

import com.voltpilot.api.fernwartung.FernwartungRueckmeldung;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungService;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Rückmeldung des Tunnel-Dienstes:
 * {@code PUT /api/v1/fernwartung/rueckmeldung} (Vertrag:
 * {@code docs/contracts/fernwartung-rueckmeldung-v1.md}).
 *
 * <p><b>Das eine Schreibrecht des Dienstkontos.</b> Die Rolle
 * {@code tunnel-dienst} liest den Soll-Stand ({@link FernwartungSollController})
 * und darf seit dem Entscheid K3 a des Kapitäns (08.10.2026) GENAU diese
 * Meldung abgeben: welche Box verbunden ist, wann sie zuletzt nach Schlüsseln
 * gefragt hat, welches Fenster seinen Schlüssel abgeholt hat. Kein Zugang, kein
 * Fenster und kein Protokolleintrag entsteht oder ändert sich dadurch, und der
 * Soll-Stand liest die Meldung nicht.
 *
 * <p>Eigene Route im Baum {@code /api/v1/fernwartung/**}, den die Filterkette
 * nur dieser Rolle öffnet; Kunden-, Publisher- und Admin-Token bekommen 403.
 *
 * <p>Der Rumpf wird hier selbst und begrenzt gelesen, nicht über den
 * ObjectMapper der Anwendung: höchstens
 * {@link FernwartungRueckmeldung#MAX_BYTES}, danach streng geprüft.
 */
@RestController
public class FernwartungRueckmeldungController {

    private final FernwartungRueckmeldungService service;

    public FernwartungRueckmeldungController(FernwartungRueckmeldungService service) {
        this.service = service;
    }

    @PutMapping("/api/v1/fernwartung/rueckmeldung")
    @PreAuthorize("hasRole('tunnel-dienst')")
    public ResponseEntity<Void> melden(HttpServletRequest anfrage, @AuthenticationPrincipal Jwt caller)
            throws IOException {
        service.annehmen(dienst(caller), begrenzt(anfrage));
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    /** Liest höchstens {@code MAX_BYTES}; ein längerer Rumpf wird nicht zu Ende gelesen (413). */
    private static byte[] begrenzt(HttpServletRequest anfrage) throws IOException {
        if (anfrage.getContentLengthLong() > FernwartungRueckmeldung.MAX_BYTES) {
            throw zuGross();
        }
        try (InputStream in = anfrage.getInputStream()) {
            byte[] rumpf = in.readNBytes(FernwartungRueckmeldung.MAX_BYTES + 1);
            if (rumpf.length > FernwartungRueckmeldung.MAX_BYTES) {
                throw zuGross();
            }
            return rumpf;
        }
    }

    private static ResponseStatusException zuGross() {
        return new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                "Die Rückmeldung ist größer als " + FernwartungRueckmeldung.MAX_BYTES / (1024 * 1024) + " MiB.");
    }

    /** Die Client-ID des Dienstkontos ({@code azp}), sonst das Subject. */
    private static String dienst(Jwt caller) {
        if (caller == null) {
            return null;
        }
        String azp = caller.getClaimAsString("azp");
        return azp != null && !azp.isBlank() ? azp : caller.getSubject();
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Rückmeldung abgelehnt." : e.getReason()));
    }
}
