package com.voltpilot.api.web;

import com.voltpilot.api.kundenbereich.KundenbereichEnde;
import com.voltpilot.api.kundenbereich.KundenbereichEndeRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.TenantDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Vertragsende I (UEMS AP-20 IP-16, E10 = A, BT4, §5.6): der Betreiber setzt einen Kundenbereich auf „beendet" und
 * nimmt ihn innerhalb der Frist wieder auf. Nur {@code platform-admin}.
 *
 * <ul>
 *   <li>{@code POST …/beenden} — Auftrag, Begründung, Name eintippen (wie der Löschweg), Frist in Tagen (Startwert
 *       90, die geltende steht im Vertrag). Danach ist jeder Schreibweg des Kundenbereichs
 *       {@code 409 kundenbereich_beendet}, nur der Kundenadministrator liest ({@code KundenbereichEndeFilter}).</li>
 *   <li>{@code POST …/wiederaufnehmen} — Auftrag, Begründung; derselbe Kundenbereich, kein neuer.</li>
 * </ul>
 * Jeder Übergang ist einmalig: ein zweiter Aufruf bewegt nichts und antwortet 409 ({@code kundenbereich_schon_beendet}
 * bzw. {@code kundenbereich_nicht_beendet}). Beide schreiben das Plattform-Protokoll {@code kundenbereich_uebergang}.
 * Der Löschweg {@code POST …/delete} bleibt unverändert (IP-18).
 */
@RestController
@RequestMapping("/api/v1/admin/tenants/{tenantId}")
@PreAuthorize("hasRole('platform-admin')")
public class AdminKundenbereichEndeController {

    private final TenantRepository tenants;
    private final KundenbereichEndeRepository ende;

    public AdminKundenbereichEndeController(TenantRepository tenants, KundenbereichEndeRepository ende) {
        this.tenants = tenants;
        this.ende = ende;
    }

    public record BeendenRequest(@NotBlank String auftrag, @NotBlank String begruendung, @NotBlank String confirmName,
            @Positive @Max(3650) Integer fristTage) {}

    public record WiederaufnehmenRequest(@NotBlank String auftrag, @NotBlank String begruendung) {}

    /** Recht: {@code plattform.betrieb} — aktiv → beendet (§5.6: Auftrag, Begründung, Name eintippen). */
    @PostMapping("/beenden")
    public Map<String, Object> beenden(@PathVariable UUID tenantId, @Valid @RequestBody BeendenRequest request,
            Authentication auth) {
        TenantDto tenant = tenant(tenantId);
        if (!tenant.name().equals(request.confirmName().trim())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "confirmName does not match the tenant name");
        }
        int frist = request.fristTage() == null ? KundenbereichEnde.FRIST_STARTWERT : request.fristTage();
        KundenbereichEnde beendet = ende.beenden(tenantId, request.auftrag().trim(), request.begruendung().trim(), frist,
                akteur(auth)).orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                        "kundenbereich_schon_beendet"));
        return Map.of("zustand", "beendet", "beendet_am", beendet.beendetAm().toString(), "frist_tage",
                beendet.fristTage(), "loeschung_fruehestens", beendet.loeschungFruehestens().toString());
    }

    /** Recht: {@code plattform.betrieb} — beendet → aktiv innerhalb der Frist (§5.6: Auftrag, Begründung). */
    @PostMapping("/wiederaufnehmen")
    public Map<String, Object> wiederaufnehmen(@PathVariable UUID tenantId,
            @Valid @RequestBody WiederaufnehmenRequest request, Authentication auth) {
        tenant(tenantId);
        if (!ende.wiederaufnehmen(tenantId, request.auftrag().trim(), request.begruendung().trim(), akteur(auth))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "kundenbereich_nicht_beendet");
        }
        return Map.of("zustand", "aktiv");
    }

    private TenantDto tenant(UUID tenantId) {
        TenantDto tenant = tenants.findById(tenantId);
        if (tenant == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
        return tenant;
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
    }
}
