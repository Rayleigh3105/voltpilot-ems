package com.voltpilot.api.web;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.voltpilot.api.enrollment.InvalidCsrException;
import com.voltpilot.api.werkstatt.EinloesenVertrag;
import com.voltpilot.api.werkstatt.EinloesungService;
import com.voltpilot.api.werkstatt.EinloesungService.Eingeloest;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Box löst ihren Einmal-Code ein ({@code POST /api/v1/werkstatt/einloesen},
 * Vertrag {@code docs/contracts/werkstatt-einloesen-v1.md}). OFFEN wie die
 * Zertifikatsanfrage: Eine frisch eingerichtete Box hat kein Token, nur ihren
 * Geräteschlüssel; der Code und die Signatur sind der Nachweis
 * ({@code SecurityConfig}, exakter Pfad). Rate-Limit vor jeder Arbeit; jeder
 * Code, der nicht gilt, und jede falsche Signatur bekommen dieselbe Antwort.
 */
@RestController
@RequestMapping("/api/v1/werkstatt")
public class WerkstattEinloesenController {

    public static final String ANTWORT_SCHEMA = "vp-werkstatt-einloesung.v1";

    /** Der Tunnel der Box: ihre Adresse und der Wartungsserver. */
    public record TunnelDto(String adresse, String boxNetz, String technikerNetz, String serverEndpunkt,
            int serverPort, String serverPublicKey, String serverAdresse) {
    }

    /** Das Probe-Fenster, das die Einlösung geöffnet hat. */
    public record ProbeDto(UUID fensterId, UUID technikerId, String technikerName, Instant beginn, Instant ende) {
    }

    /** Der festgehaltene Geräteschlüssel (D2). */
    public record SchluesselDto(String sha256, Instant festgehaltenAm) {
    }

    /** Die Antwort an die Box; nichts davon ist geheim. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EinloesungAntwort(String schema, String edgeRef, String freigabe, String tunnelErgebnis,
            TunnelDto tunnel, ProbeDto probe, SchluesselDto geraeteSchluessel) {
        static EinloesungAntwort of(Eingeloest e) {
            var p = e.server();
            return new EinloesungAntwort(ANTWORT_SCHEMA, e.einloesung().edgeRef(), e.freigabe().kennung(),
                    e.tunnel().name().toLowerCase(java.util.Locale.ROOT),
                    new TunnelDto(e.einloesung().tunnelAdresse(), p.boxNetz(), p.technikerNetz(), p.serverEndpunkt(),
                            p.serverPort(), p.serverPublicKey(), e.boxServerAdresse()),
                    new ProbeDto(e.fenster().id(), e.fenster().technikerId(), e.fenster().technikerName(),
                            e.fenster().beginn(), e.fenster().ende()),
                    new SchluesselDto(e.einloesung().geraeteSchluesselSha256(), e.einloesung().eingeloestAm()));
        }
    }

    private final EinloesungService einloesung;
    private final WerkstattEinloesenRateLimiter rateLimiter;

    public WerkstattEinloesenController(EinloesungService einloesung, WerkstattEinloesenRateLimiter rateLimiter) {
        this.einloesung = einloesung;
        this.rateLimiter = rateLimiter;
    }

    /** 200 mit Adresse, Serverdaten und Probe-Fenster; 400 Form, 403 Code/Signatur, 409, 422, 429. */
    @PostMapping("/einloesen")
    public ResponseEntity<EinloesungAntwort> einloesen(@RequestBody(required = false) EinloesenVertrag.Anfrage a,
            HttpServletRequest http) {
        if (!rateLimiter.tryAcquire(rateLimiter.clientKey(http))) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Zu viele Anfragen. Bitte versuchen Sie es später erneut.");
        }
        if (a == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Anfrage ungültig: kein Inhalt.");
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(EinloesungAntwort.of(einloesung.einloesen(a)));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        String grund = e.getReason() == null ? "Anfrage abgelehnt." : e.getReason();
        if (grund.startsWith(EinloesungService.FESTGEHALTEN + ":")) {
            return ResponseEntity.status(e.getStatusCode()).body(Map.of("code", EinloesungService.FESTGEHALTEN,
                    "message", grund.substring(EinloesungService.FESTGEHALTEN.length() + 1).trim()));
        }
        return ResponseEntity.status(e.getStatusCode()).body(Map.of("message", grund));
    }

    @ExceptionHandler(InvalidCsrException.class)
    public ResponseEntity<Map<String, String>> csr(InvalidCsrException e) {
        return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
    }
}
