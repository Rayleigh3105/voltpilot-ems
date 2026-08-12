package com.voltpilot.api.web;

import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.components.ComponentService;
import com.voltpilot.api.components.SelfBuildComponentService;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.templates.BuiltinComponentTemplates;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.web.dto.ComponentDefinitionDto;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import com.voltpilot.api.web.dto.ComponentTestRequest;
import com.voltpilot.api.web.dto.SaveComponentRequest;
import com.voltpilot.api.web.dto.SaveSelfBuildRequest;
import com.voltpilot.api.web.dto.SelfBuildReadRequest;
import com.voltpilot.api.web.dto.SelfBuildReadResult;
import com.voltpilot.api.web.dto.SiteComponentTemplateDto;
import com.voltpilot.api.web.dto.SiteComponentTemplateRequest;
import com.voltpilot.api.web.dto.SiteComponentsDto;
import jakarta.validation.Valid;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der EINE Anlege-Weg als Kunden-Route (Einheitsmodell Stufe 1, Konzept
 * vp-komponenten-einheit-h2 Teil 4).
 *
 * <p>Mandanten-gefenced wie jede {@code /api/v1/sites/**}-Route
 * ({@link SiteConsumerController}, {@link SiteFlowController},
 * {@link SiteProbeController}): KEIN {@code @PreAuthorize} - Authentifizierung
 * plus Postgres-RLS sind der Zaun. Der Mandant eines Kunden kommt aus dem
 * JWT-Anspruch, ein Portal-Admin erreicht jede Anlage über den
 * {@code X-Tenant-Id}-Umschalter auf demselben RLS-Pfad, und eine fremde Anlage
 * ist 404 statt 403.
 *
 * <p><b>Der Verbindungstest ist Teil DIESER Fläche</b>, nicht ein Nachbar:
 * er hinterlegt den Beleg, ohne den {@code POST}/{@code PUT} nicht speichern
 * (die Verbindungstest-Pflicht, {@link ComponentConnectionReceipts}). Die
 * Prüfung selbst führt die BOX aus - über den Probe-Kanal, mit genau der
 * Maschinerie, die die {@code :8484}-Taste seit je benutzt.
 *
 * <p>Das Löschen läuft weiterhin über
 * {@link SiteEntityAdoptController#deleteEntity} - die Folgenliste, der
 * kWp-Rückbau und die Schutz-Regeln (eine plattform-komponierte Basis-Zeile ist
 * nicht löschbar) wohnen dort und werden hier nicht ein zweites Mal formuliert.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteComponentController {

    private final SiteRepository sites;
    private final ComponentService components;
    private final ComponentTemplateRepository templates;
    private final ComponentConnectionReceipts receipts;
    private final ProbeService probes;
    private final SelfBuildComponentService selfBuild;

    public SiteComponentController(SiteRepository sites, ComponentService components,
            ComponentTemplateRepository templates, ComponentConnectionReceipts receipts,
            ProbeService probes, SelfBuildComponentService selfBuild) {
        this.selfBuild = selfBuild;
        this.sites = sites;
        this.components = components;
        this.templates = templates;
        this.receipts = receipts;
        this.probes = probes;
    }

    /** Die Komponenten dieser Anlage samt Autoritäts- und Soll/Ist-Stand. */
    @GetMapping("/components")
    public SiteComponentsDto list(@PathVariable UUID siteId) {
        return components.list(siteId);
    }

    /** Anlegen. Ohne bestandenen Verbindungstest: 422 mit dem Grund. */
    @PostMapping("/components")
    public SiteComponentsDto create(@PathVariable UUID siteId,
            @Valid @RequestBody SaveComponentRequest request, @AuthenticationPrincipal Jwt jwt) {
        return components.create(siteId, request, subject(jwt));
    }

    /** Verbindung ändern - eine NEUE Fassung, die alte bleibt abrufbar. */
    @PutMapping("/components/{entityId}")
    public SiteComponentsDto update(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @Valid @RequestBody SaveComponentRequest request, @AuthenticationPrincipal Jwt jwt) {
        return components.update(siteId, entityId, request, subject(jwt));
    }

    /** Die Fassungen einer Komponente, neueste zuerst. */
    @GetMapping("/components/{entityId}/versions")
    public List<ComponentDefinitionDto> versions(@PathVariable UUID siteId,
            @PathVariable UUID entityId) {
        return components.versions(siteId, entityId);
    }

    /** Zurück auf eine frühere Fassung - ein Klick, kein Support-Fall. */
    @PostMapping("/components/{entityId}/versions/{version}/rollback")
    public SiteComponentsDto rollback(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @PathVariable int version, @AuthenticationPrincipal Jwt jwt) {
        return components.rollback(siteId, entityId, version, subject(jwt));
    }

    // ---- Die SELBSTBAU-TÜR (Einheitsmodell Stufe 3) -----------------------

    /**
     * „Jetzt lesen": EIN Kanal, einmal, am echten Gerät - mit Roh- UND
     * skaliertem Wert nebeneinander (Konzept vp-modbus-baukasten-k6 §2.3).
     *
     * <p>Es ist zugleich der Verbindungstest von Schritt 1: ein Erfolg
     * hinterlegt den Beleg, der das Speichern freigibt. Ein Timeout ist wie
     * überall auf dieser Fläche ein ehrlicher AUSGANG (HTTP 200 mit
     * {@code errorCode}), kein Fehler.
     */
    @PostMapping("/components/custom/read")
    public SelfBuildReadResult readCustom(@PathVariable UUID siteId,
            @Valid @RequestBody SelfBuildReadRequest request, @AuthenticationPrincipal Jwt jwt) {
        return selfBuild.read(siteId, request.deviceId(), request.connection(), request.channel(),
                subject(jwt));
    }

    /** Ein selbst definiertes Modbus-Gerät anlegen. */
    @PostMapping("/components/custom")
    public SiteComponentsDto createCustom(@PathVariable UUID siteId,
            @Valid @RequestBody SaveSelfBuildRequest request, @AuthenticationPrincipal Jwt jwt) {
        return selfBuild.create(siteId, request, subject(jwt));
    }

    /** Ein selbst definiertes Gerät ändern - eine NEUE Fassung. */
    @PutMapping("/components/custom/{entityId}")
    public SiteComponentsDto updateCustom(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @Valid @RequestBody SaveSelfBuildRequest request, @AuthenticationPrincipal Jwt jwt) {
        return selfBuild.update(siteId, entityId, request, subject(jwt));
    }

    /**
     * Ein selbst definiertes Gerät entfernen - samt seinem Lese-Flow.
     *
     * <p>Es ist bewusst eine EIGENE Route und nicht der Entitäts-Löschweg: nur
     * hier wird auch der generierte Leseplan zurückgezogen, und eine Komponente
     * ohne Gerät, deren Flow weiterläuft, wäre genau die halbe Wahrheit, die
     * dieses Modell vermeidet.
     */
    @DeleteMapping("/components/custom/{entityId}")
    public SiteComponentsDto deleteCustom(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @AuthenticationPrincipal Jwt jwt) {
        return selfBuild.delete(siteId, entityId, subject(jwt));
    }

    /** Die PRIVATEN Vorlagen dieser Anlage (kein Katalog, kein Teilen). */
    @GetMapping("/component-templates")
    public List<SiteComponentTemplateDto> siteTemplates(@PathVariable UUID siteId) {
        return selfBuild.templates(siteId);
    }

    /** „Duplizieren": aus einem Gerät wird eine private Vorlage dieser Anlage. */
    @PostMapping("/components/custom/{entityId}/duplicate")
    public List<SiteComponentTemplateDto> duplicate(@PathVariable UUID siteId,
            @PathVariable UUID entityId,
            @Valid @RequestBody(required = false) SiteComponentTemplateRequest body,
            @AuthenticationPrincipal Jwt jwt) {
        return selfBuild.duplicate(siteId, entityId, body == null ? null : body.label(),
                subject(jwt));
    }

    /** Eine private Vorlage umbenennen (Einheitsmodell Stufe 6). */
    @PatchMapping("/component-templates/{templateRef}")
    public List<SiteComponentTemplateDto> renameTemplate(@PathVariable UUID siteId,
            @PathVariable String templateRef,
            @Valid @RequestBody SiteComponentTemplateRequest body) {
        return selfBuild.renameTemplate(siteId, templateRef, body.label(), body.note());
    }

    /** Eine private Vorlage entfernen. Geräte, die daraus entstanden, bleiben. */
    @DeleteMapping("/component-templates/{templateRef}")
    public List<SiteComponentTemplateDto> deleteTemplate(@PathVariable UUID siteId,
            @PathVariable String templateRef) {
        return selfBuild.deleteTemplate(siteId, templateRef);
    }

    /**
     * „Verbindung testen": die Box liest das NOCH NICHT gespeicherte Gerät
     * einmal und antwortet mit den dekodierten Messwerten oder einer benannten
     * deutschen Fehlerklasse.
     *
     * <p>Ein ERFOLG hinterlegt den Beleg, der das Speichern freigibt - und zwar
     * für genau diese Anlage, Vorlage und Verbindung. Ein Fehlschlag hinterlegt
     * nichts: das ist die Verbindungstest-Pflicht, und sie ist genau dann etwas
     * wert, wenn sie nur ein echtes Ja durchlässt.
     *
     * <p>Ein Timeout ist ein ehrlicher AUSGANG (HTTP 200 mit
     * {@code errorCode: timeout}), kein Fehler - dieselbe Regel wie beim
     * Register-Probe.
     */
    @PostMapping("/component-test")
    public ProbeResult test(@PathVariable UUID siteId,
            @Valid @RequestBody ComponentTestRequest request, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        ComponentTemplateDto template = templates
                .findNewestByRef(BuiltinComponentTemplates.PUBLIC_KINDS, request.templateRef())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Dieses Gerät kennen wir nicht."));
        Map<String, Object> connection =
                request.connection() == null ? Map.of() : new LinkedHashMap<>(request.connection());

        ProbeResult result = probes.testConnection(siteId, request.deviceId(), "verbindung",
                template.brand(), template.model(), template.family(), request.role(), connection,
                subject(jwt));
        if (passed(result)) {
            receipts.record(siteId, template.templateRef(), connection);
        }
        return result;
    }

    /**
     * Ob dieser Lauf das Speichern freigibt. Bewusst streng: die GANZE Anfrage
     * muss ohne Ablehnung durchgelaufen sein UND die eine Zeile {@code ok}
     * melden. Ein Timeout, eine Ratenbegrenzung oder eine leere Antwort sind
     * kein Ja.
     */
    private static boolean passed(ProbeResult result) {
        if (result == null || result.errorCode() != null || result.results() == null
                || result.results().isEmpty()) {
            return false;
        }
        return result.results().stream().allMatch(ProbeResult.OpResult::ok);
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    private static String subject(Jwt jwt) {
        return jwt == null ? null : jwt.getSubject();
    }

    /** Deutsche Gründe erreichen das Portal als {"message": ...} (MastrController-Muster). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }

}
