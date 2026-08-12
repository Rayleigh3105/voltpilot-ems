package com.voltpilot.api.web;

import com.voltpilot.api.templates.ComponentTemplateAdminService;
import com.voltpilot.api.templates.ComponentTemplateDefinition;
import com.voltpilot.api.web.dto.AdminComponentTemplateDto;
import com.voltpilot.api.web.dto.SaveComponentTemplateRequest;
import jakarta.validation.Valid;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Vorlagen-Verwaltung des Betreibers (Einheitsmodell Stufe 6).
 *
 * <p>Klassenweit {@code platform-admin} - dieselbe Disziplin wie
 * {@code AdminFleetController}/{@code AdminControlCertificationController}: die
 * Umgehung der Mandanten-Trennung steckt ausschließlich in
 * {@code ComponentTemplateAdminRepository} an der dedizierten BYPASSRLS-Rolle,
 * und der {@code @Primary} mandantenbezogene Pfad bleibt unberührt.
 *
 * <p><b>⚠ Klassenweite Annotation, nicht je Methode.</b> Ein neu hinzugefügter
 * Endpunkt fiele sonst auf die Filter-Regel für {@code /api/v1/admin/**}
 * zurück, die auch die schmale {@code edge-release-publisher}-Rolle zulässt -
 * ein Konto, das ausschließlich Releases registrieren darf, hätte damit
 * plötzlich Zugriff auf die Vorlagen der Plattform.
 *
 * <p><b>Es gibt bewusst kein LÖSCHEN.</b> Eine Vorlage wird zurückgezogen, nie
 * entfernt: laufende Komponenten tragen ihre Fassung als Schnappschuss (kein
 * Fremdschlüssel), und ein Löschen wäre die einzige Handlung hier, die eine
 * Kundenanlage unerklärbar machen könnte.
 */
@RestController
@RequestMapping("/api/v1/admin/component-templates")
@PreAuthorize("hasRole('platform-admin')")
public class AdminComponentTemplateController {

    private final ComponentTemplateAdminService templates;

    public AdminComponentTemplateController(ComponentTemplateAdminService templates) {
        this.templates = templates;
    }

    /** Alle Fassungen aller Herkunftsarten - inklusive der zurückgezogenen. */
    @GetMapping
    public List<AdminComponentTemplateDto> list() {
        return templates.list();
    }

    /** Legt eine neue geprüfte Vorlage an (Fassung 1). */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public AdminComponentTemplateDto create(@Valid @RequestBody SaveComponentTemplateRequest req,
            @AuthenticationPrincipal Jwt jwt) {
        return templates.create(input(req), subject(jwt));
    }

    /** Legt eine neue FASSUNG einer bestehenden geprüften Vorlage an. */
    @PostMapping("/{templateRef}/versions")
    @ResponseStatus(HttpStatus.CREATED)
    public AdminComponentTemplateDto addVersion(@PathVariable String templateRef,
            @Valid @RequestBody SaveComponentTemplateRequest req,
            @AuthenticationPrincipal Jwt jwt) {
        return templates.addVersion(templateRef, input(req), subject(jwt));
    }

    /** Nimmt eine Fassung aus der Auswahl des Assistenten. */
    @PostMapping("/{templateRef}/versions/{version}/withdraw")
    public AdminComponentTemplateDto withdraw(@PathVariable String templateRef,
            @PathVariable int version, @AuthenticationPrincipal Jwt jwt) {
        return templates.setWithdrawn(templateRef, version, true, subject(jwt), Instant.now());
    }

    /** Gibt eine zurückgezogene Fassung wieder frei (die Rücknahme ist umkehrbar). */
    @PostMapping("/{templateRef}/versions/{version}/restore")
    public AdminComponentTemplateDto restore(@PathVariable String templateRef,
            @PathVariable int version, @AuthenticationPrincipal Jwt jwt) {
        return templates.setWithdrawn(templateRef, version, false, subject(jwt), Instant.now());
    }

    private static ComponentTemplateDefinition.Input input(SaveComponentTemplateRequest r) {
        return new ComponentTemplateDefinition.Input(r.brand(), r.brandLabel(), r.model(),
                r.modelLabel(), r.family(), r.familyLabel(), r.communication(),
                r.communicationLabel(), r.transportSchema(), r.channels(), r.writes(),
                r.ratedKw(), r.controlTier(), r.certificationStatus(), r.certificationNote(),
                r.note());
    }

    private static String subject(Jwt jwt) {
        return jwt == null ? "unbekannt" : jwt.getSubject();
    }

    /** Jede Ablehnung erreicht die Oberfläche mit ihrem deutschen Grund. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
