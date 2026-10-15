package com.voltpilot.api.web;

import com.voltpilot.api.versand.ZustellwegRepository;
import com.voltpilot.api.versand.ZustellwegService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * „So erreichen wir Sie“ (Alerting Scheibe 0, §6.6): der eigene E-Mail-Zustellweg, erst wirksam nach
 * Bestätigung über einen Link. Recht {@code konto.eigenes} — jede Person liest/ändert nur sich selbst,
 * wie {@link MeController}; der Bestätigungs-Endpunkt hat ausdrücklich KEINE Anmeldung (die Person hat
 * zu diesem Zeitpunkt noch keinen bestätigten Weg und damit keinen Grund, sich extra anzumelden - der
 * Token selbst ist der Nachweis).
 */
@RestController
@RequestMapping("/api/v1/zustellwege")
public class ZustellwegController {

    /** Anfrage, eine E-Mail-Adresse als eigenen Zustellweg zu bestätigen. */
    public record Anfrage(String ziel) {}

    /** Der eigene Zustand, wie „So erreichen wir Sie“ ihn zeigt. */
    public record Zustand(String ziel, boolean bestaetigt, boolean aktiv) {
        static Zustand aus(ZustellwegRepository.Zustellweg z) {
            return new Zustand(z.ziel(), z.bestaetigt(), z.aktiv());
        }
    }

    private final ZustellwegService zustellwege;

    public ZustellwegController(ZustellwegService zustellwege) {
        this.zustellwege = zustellwege;
    }

    @GetMapping("/email")
    public ResponseEntity<Zustand> eigener(Authentication auth) {
        return zustellwege.eigener(sub(auth)).map(Zustand::aus).map(ResponseEntity::ok)
                .orElse(ResponseEntity.noContent().build());
    }

    @PostMapping("/email")
    public ResponseEntity<Void> anfordern(@RequestBody Anfrage anfrage, Authentication auth) {
        zustellwege.anfordern(sub(auth), anfrage.ziel());
        return ResponseEntity.accepted().build();
    }

    /** Öffentlich, ohne Anmeldung - der Link aus der Bestätigungs-Mail. */
    @GetMapping("/bestaetigen")
    public ResponseEntity<Void> bestaetigen(@RequestParam String token) {
        return zustellwege.bestaetigen(token) ? ResponseEntity.ok().build() : ResponseEntity.status(410).build();
    }

    private static String sub(Authentication auth) {
        return auth != null && auth.getPrincipal() instanceof Jwt jwt ? jwt.getSubject() : auth.getName();
    }
}
