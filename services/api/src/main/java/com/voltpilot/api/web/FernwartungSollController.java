package com.voltpilot.api.web;

import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.fernwartung.FernwartungService.Soll;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Leseroute des Tunnel-Dienstes: {@code GET /api/v1/fernwartung/soll}.
 *
 * <p><b>Eigene Dienst-Identität, nur Leserecht</b> - im Muster des
 * Dienstkontos {@code edge-release-publisher}: der Keycloak-Client
 * {@code voltpilot-tunnel-dienst} (nur client_credentials) trägt die
 * Realm-Rolle {@code tunnel-dienst} und nichts sonst. Diese Rolle öffnet
 * GENAU diese eine Route; der Admin-Baum bleibt ihr verschlossen (die
 * Filterkette lässt dort nur {@code platform-admin} und
 * {@code edge-release-publisher} durch), und umgekehrt kommt hier kein
 * Admin- oder Kunden-Token herein.
 *
 * <p>Bewusst NICHT unter {@code /api/v1/admin/**}: sonst müsste die
 * Rückfallregel des Admin-Baums auch diese Rolle durchlassen, und jede
 * künftig vergessene Annotation dort stünde dem Dienstkonto offen.
 *
 * <p>Der Dienst holt pull-basiert ab (keine eingehende Verbindung zur VM) und
 * meldet nichts zurück. Die API merkt sich nur den Zeitpunkt des Abrufs, damit
 * das Portal zeigen kann, ob überhaupt abgeholt wird.
 */
@RestController
public class FernwartungSollController {

    private final FernwartungService service;

    public FernwartungSollController(FernwartungService service) {
        this.service = service;
    }

    @GetMapping("/api/v1/fernwartung/soll")
    @PreAuthorize("hasRole('tunnel-dienst')")
    public ResponseEntity<Soll> soll(@AuthenticationPrincipal Jwt caller) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.soll(dienst(caller)));
    }

    /** Die Client-ID des Dienstkontos ({@code azp}), sonst das Subject. */
    private static String dienst(Jwt caller) {
        if (caller == null) {
            return null;
        }
        String azp = caller.getClaimAsString("azp");
        return azp != null && !azp.isBlank() ? azp : caller.getSubject();
    }
}
