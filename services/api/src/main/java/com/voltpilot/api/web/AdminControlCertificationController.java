package com.voltpilot.api.web;

import com.voltpilot.api.control.ControlCertificationService;
import com.voltpilot.api.control.ControlCertificationService.Refused;
import com.voltpilot.api.repo.ControlCertificationRepository.Activation;
import com.voltpilot.api.repo.ControlCertificationRepository.Certification;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Das PLATTFORM-Gedächtnis der Steuerungs-Freigabe: das Modell-Register und die
 * Scharfschaltung je Anlage (Captain-Order 10.08.2026).
 *
 * <p><b>Zwei Ebenen, zwei Entscheidungen.</b> „Modell X ist am Prüfstand
 * freigegeben" ist eine Aussage über ein PRODUKT und wird EINMAL getroffen;
 * „Anlage Y darf steuern" ist eine Entscheidung über eine KUNDENANLAGE und
 * bleibt ein ausdrücklicher, sicherheitsrelevanter Akt - nur eben ein einziger
 * Klick, statt eines wiederholten Prüfstandslaufs.
 *
 * <p><b>WER klicken darf: platform-admin, und nur der.</b> Begründung, nicht
 * Bequemlichkeit: (1) das Register ist eine Produkt-Zusage der Plattform, also
 * gehört auch die Entscheidung, sie auf eine konkrete Anlage anzuwenden, zu
 * dem, der sie verantwortet; (2) es geht um SCHREIBZUGRIFF auf den
 * Wechselrichter eines Kunden - der Kunde hatte diesen Hebel nie, und
 * admin-only ist die Variante, die für jede Bestandsanlage byte-genau nichts
 * ändert; (3) eine spätere Kunden-Freigabe ist additiv nachrüstbar (eine zweite
 * Route auf dem RLS-Pfad, wie {@code SiteFlowController} sie neben
 * {@code AdminFlowController} stellt), das Umgekehrte - einen erteilten
 * Kundenhebel wieder einzusammeln - wäre es nicht.
 *
 * <p><b>Sicherheits-Disziplin, übernommen statt neu erfunden:</b> die Routen
 * liegen unter {@code /api/v1/admin/**}, die Klasse trägt klassenweit
 * {@code @PreAuthorize("hasRole('platform-admin')")} wie {@link AdminController}
 * und {@link AdminFleetController}; die RLS-Umgehung steckt ausschließlich in
 * der dedizierten BYPASSRLS-Rolle {@code voltpilot_admin} hinter dem
 * Repository. Ein Kunden-Token bekommt 403, ein anonymer Aufruf 401.
 */
@RestController
@PreAuthorize("hasRole('platform-admin')")
public class AdminControlCertificationController {

    private final ControlCertificationService service;

    public AdminControlCertificationController(ControlCertificationService service) {
        this.service = service;
    }

    // ── Register ──────────────────────────────────────────────────────────

    /** Ein Register-Eintrag, wie ihn die Plattform-Oberfläche zeigt. */
    public record CertificationDto(String brand, String model, String family, String controlPath,
            Boolean invertControlSign, Instant certifiedAt, String firmwareNote, String note,
            Instant createdAt, String createdBy) {
        static CertificationDto of(Certification c) {
            return new CertificationDto(c.brand(), c.model(), c.family(), c.controlPath(),
                    c.invertControlSign(), c.certifiedAt(), c.firmwareNote(), c.note(),
                    c.createdAt(), c.createdBy());
        }
    }

    /**
     * Der Rumpf einer Zertifizierung.
     *
     * <p>{@code invertControlSign} ist bewusst ein {@code Boolean}: fehlt es,
     * hat der Prüfstand die Vorzeichenfrage nicht als Register-Aussage
     * festgehalten, und das Gerät prüft dann nichts. {@code false} heißt
     * dagegen „geprüft, nicht invertiert" - zwei verschiedene Aussagen, die ein
     * {@code boolean} zu einer machen würde.
     */
    public record CertifyRequest(
            @NotBlank @Size(max = 64) String brand,
            @NotBlank @Size(max = 128) String model,
            @NotBlank @Size(max = 64) String family,
            @Size(max = 16) String controlPath,
            Boolean invertControlSign,
            Instant certifiedAt,
            @Size(max = 512) String firmwareNote,
            @Size(max = 512) String note) {
    }

    @GetMapping("/api/v1/admin/control-certifications")
    public List<CertificationDto> register() {
        return service.register().stream().map(CertificationDto::of).toList();
    }

    @PostMapping("/api/v1/admin/control-certifications")
    public ResponseEntity<CertificationDto> certify(@Valid @RequestBody CertifyRequest req,
            @AuthenticationPrincipal Jwt jwt) {
        Certification c = service.certify(req.brand(), req.model(), req.family(), req.controlPath(),
                req.invertControlSign(), req.certifiedAt(), req.firmwareNote(), req.note(),
                actor(jwt));
        return ResponseEntity.status(HttpStatus.CREATED).body(CertificationDto.of(c));
    }

    @DeleteMapping("/api/v1/admin/control-certifications")
    public ResponseEntity<Void> revoke(@RequestParam String brand, @RequestParam String model,
            @AuthenticationPrincipal Jwt jwt) {
        service.revoke(brand, model, actor(jwt));
        return ResponseEntity.noContent().build();
    }

    // ── Scharfschaltung ───────────────────────────────────────────────────

    /** Eine scharfgeschaltete Anlage. */
    public record ActivationDto(UUID deviceId, UUID tenantId, UUID siteId, String siteName,
            String tenantName, String externalRef, Instant activatedAt, String activatedBy,
            String note) {
        static ActivationDto of(Activation a) {
            return new ActivationDto(a.deviceId(), a.tenantId(), a.siteId(), a.siteName(),
                    a.tenantName(), a.externalRef(), a.activatedAt(), a.activatedBy(), a.note());
        }
    }

    public record ActivateRequest(@Size(max = 512) String note) {
    }

    @GetMapping("/api/v1/admin/control-activations")
    public List<ActivationDto> activations() {
        return service.activations().stream().map(ActivationDto::of).toList();
    }

    /** „Steuerung aktivieren" - der EINE bewusste Klick je Anlage. */
    @PostMapping("/api/v1/admin/devices/{deviceId}/control-activation")
    public ResponseEntity<ActivationDto> activate(@PathVariable UUID deviceId,
            @Valid @RequestBody(required = false) ActivateRequest req,
            @AuthenticationPrincipal Jwt jwt) {
        service.activate(deviceId, actor(jwt), req == null ? null : req.note());
        return service.activation(deviceId).map(ActivationDto::of).map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /** Nimmt die Scharfschaltung zurück - die Anlage fällt auf Nur-Lesen. */
    @DeleteMapping("/api/v1/admin/devices/{deviceId}/control-activation")
    public ResponseEntity<Void> deactivate(@PathVariable UUID deviceId,
            @AuthenticationPrincipal Jwt jwt) {
        service.deactivate(deviceId, actor(jwt));
        return ResponseEntity.noContent().build();
    }

    private static String actor(Jwt jwt) {
        if (jwt == null) {
            return "unbekannt";
        }
        String sub = jwt.getSubject();
        return sub == null || sub.isBlank() ? "unbekannt" : sub;
    }

    /** Jede fachliche Ablehnung kommt als deutscher {@code {message}}-Rumpf an. */
    @ExceptionHandler(Refused.class)
    public ResponseEntity<Map<String, String>> refused(Refused e) {
        HttpStatus status = e.isConflict() ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
        return ResponseEntity.status(status).body(Map.of("message", e.getMessage()));
    }
}
