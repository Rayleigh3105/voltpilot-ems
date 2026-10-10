package com.voltpilot.api.web;

import com.voltpilot.api.registerwrite.RegisterKnowledge;
import com.voltpilot.api.registerwrite.RegisterWriteEvents;
import com.voltpilot.api.registerwrite.RegisterWriteService;
import com.voltpilot.api.registerwrite.RegisterWriteTargets;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.web.dto.RegisterWriteEventDto;
import com.voltpilot.api.web.dto.RegisterWriteOutcomeDto;
import com.voltpilot.api.web.dto.RegisterWriteRequest;
import com.voltpilot.api.web.dto.RegisterWriteTargetDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Zwei-Schritt-Strecke „Register schreiben" EINER ANLAGE:
 * {@code POST /api/v1/sites/{siteId}/register-write/preview} (Ist lesen) und
 * {@code POST /api/v1/sites/{siteId}/register-write} (der EINE Schreibvorgang),
 * dazu {@code GET .../register-write/history} für Beleg und Verlauf.
 *
 * <p><b>Der Zaun ist der des Hauses, nicht ein neuer:</b> mandantenbezogen wie
 * jede {@code /api/v1/sites/**}-Route ({@link SiteFlowController},
 * {@link SiteForecastModelController}) - KEIN {@code @PreAuthorize},
 * Authentifizierung + Postgres-RLS sind die Grenze, eine fremde Anlage ist
 * <b>404</b>, nie 403. Ein Portal-Admin erreicht jede Anlage über den
 * {@code X-Tenant-Id}-Umschalter auf demselben RLS-Pfad.
 *
 * <p><b>Die Rollen unterscheiden nur die REICHWEITE, nicht die Register</b>
 * (Captain-Schärfung 19.08.2026): WESSEN Anlagen jemand erreicht, entscheidet
 * RLS; WELCHES Register er dort schreiben darf, ist auf jeder Stufe dieselbe
 * Frage - und sie wird auf dem GERÄT beantwortet. Die Herkunft
 * ({@code kunde} vs. {@code voltpilot}) wird ausschließlich aus den validierten
 * Realm-Rollen ABGELEITET und ins Journal gestempelt; sie steht nie im
 * Request-Körper.
 *
 * <p>In Stufe 1 rendert nur die Plattform-Geräteseite diesen Drawer. Die Route
 * ist trotzdem die KUNDEN-Route, weil Stufe 3 exakt dieselbe benutzt - eine
 * zweite, admin-gegatete Tür hätte später getrennt abgesichert werden müssen.
 *
 * <p><b>⚠ Der Cloud-Kill-Switch {@code voltpilot.register-write.enabled} ist im
 * CODE per Vorgabe AN - eine argumentierte Abweichung von der Empfehlung des
 * Konzepts (§2.6 „Vorgabe false im Code, true in BEIDEN Composes").</b> Ein
 * per Vorgabe ausgeschaltetes Flag muss im gitops-Repo nachgezogen werden, und
 * genau diese Klasse hat dieses Repo schon einmal einen stillen
 * Produktions-Ausfall gekostet (die OTA-Listener-Falle) - der Probe-Kanal
 * vermeidet sie aus demselben Grund.
 *
 * <p><b>Er WIRKT seit Stufe 3 im Dienst, nicht an der Route</b>
 * ({@link RegisterWriteService}): abgeschaltet refüsieren nur die zwei
 * SCHREIBENDEN Schritte mit <b>503</b> und deutschem Grund, während Ziel-Liste,
 * Register-Wissen und VERLAUF lesbar bleiben. Vorher nahm
 * {@code @ConditionalOnProperty} dem Controller die Bohne - die Routen
 * antworteten dann mit einem nackten 404, also zeichengleich mit der Antwort
 * des Mandanten-Zauns auf eine FREMDE Anlage, und die Papier-Spur verschwand
 * mit. Das war die falsche Abschaltung: das Journal ist genau dann
 * interessant, wenn jemand den Not-Aus gedrückt hat.
 *
 * <p>Er ist zugleich der EINZIGE plattformweite Hebel - auf der Box gibt es
 * seit der Captain-Korrektur vom 20.08.2026 (D2 KORRIGIERT) KEIN Feature-Flag
 * mehr; das frühere {@code VP_INSTALLER_WRITE_ENABLED} ist ersatzlos entfallen.
 * Die Sicherung des Pfades sind weiterhin Identität (Broker-ACL + mTLS-CN),
 * Zeitfenster, LAN-Whitelist, Selbstkonflikt-Sperre und Einmaligkeit auf dem
 * Gerät.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/register-write")
public class SiteRegisterWriteController {

    private static final String PLATFORM_ADMIN_AUTHORITY = "ROLE_platform-admin";
    private static final int DEFAULT_HISTORY = 50;

    private final Geltungsbereich geltungsbereich;
    private final RegisterWriteService service;
    private final RegisterWriteTargets targets;
    private final RegisterKnowledge knowledge;

    public SiteRegisterWriteController(Geltungsbereich geltungsbereich, RegisterWriteService service,
            RegisterWriteTargets targets, RegisterKnowledge knowledge) {
        this.geltungsbereich = geltungsbereich;
        this.service = service;
        this.targets = targets;
        this.knowledge = knowledge;
    }

    /**
     * Schritt 0: WELCHE Geräte dieser Anlage überhaupt als Ziel in Frage kommen.
     *
     * <p>Es entsteht keine neue Wahrheit - die Liste kommt aus dem, was die Box
     * über ihre Einrichtung meldet, und aus den portal-verwalteten Komponenten.
     * Ein Gerät ohne Schreibweg wird GENANNT (mit Grund), nie verschwiegen.
     */
    @GetMapping("/targets")
    public List<RegisterWriteTargetDto> targets(@PathVariable UUID siteId) {
        requireSite(siteId);
        return targets.forSite(siteId).stream()
                .map(t -> new RegisterWriteTargetDto(t.lane(), t.deviceId(), t.entityId(),
                        t.label(), t.brand(), t.model(), t.family(), t.communication(), t.host(),
                        t.port(), t.unitId(), t.writable(), t.reason(), t.primaryAlias()))
                .toList();
    }

    /**
     * Das Register-WISSEN als Ganzes - der Nachschlage-Teil des Experten-Modus.
     *
     * <p>Reine ANZEIGE: es entscheidet nichts, es sperrt nichts. Was eine Box
     * ausführt, prüft die Box.
     */
    @GetMapping("/register-knowledge")
    public List<RegisterKnowledge.FamilyView> knowledge(@PathVariable UUID siteId) {
        requireSite(siteId);
        return knowledge.catalog();
    }

    /** Schritt 1: den Ist-Wert lesen. Schreibt nichts und protokolliert nichts. */
    @PostMapping("/preview")
    @Recht(value = "register.schreiben", ziel = RechtZiel.ANLAGE)
    public RegisterWriteOutcomeDto preview(@PathVariable UUID siteId,
            @Valid @RequestBody RegisterWriteRequest body,
            @AuthenticationPrincipal Jwt caller) {
        requireSite(siteId);
        return toDto(service.preview(siteId, command(body), actor(caller)));
    }

    /** Schritt 2: der EINE Schreibvorgang - mit Beleg und Papier-Spur. */
    @PostMapping
    @Recht(value = "register.schreiben", ziel = RechtZiel.ANLAGE)
    public RegisterWriteOutcomeDto write(@PathVariable UUID siteId,
            @Valid @RequestBody RegisterWriteRequest body,
            @AuthenticationPrincipal Jwt caller) {
        requireSite(siteId);
        if (body.value() == null || body.value().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Zum Schreiben fehlt der Wert.");
        }
        return toDto(service.write(siteId, command(body), actor(caller)));
    }

    /** Der Verlauf: derselbe Journal-Inhalt, den auch die Befehle-Seite zeigt. */
    @GetMapping("/history")
    public List<RegisterWriteEventDto> history(@PathVariable UUID siteId,
            @RequestParam(required = false) UUID deviceId,
            @RequestParam(required = false) Integer limit) {
        requireSite(siteId);
        return service.history(siteId, deviceId, limit == null ? DEFAULT_HISTORY : limit)
                .stream().map(RegisterWriteEvents::toDto).toList();
    }

    private static RegisterWriteService.Command command(RegisterWriteRequest b) {
        return new RegisterWriteService.Command(b.deviceId(), b.lane(), b.entityId(), b.host(),
                b.port(), b.unitId(), b.registerKind(), b.address(), b.value(),
                b.expectedBefore(), b.writeFc(), b.note());
    }

    private static RegisterWriteOutcomeDto toDto(RegisterWriteService.Outcome o) {
        return new RegisterWriteOutcomeDto(o.requestId(), o.mode(), o.ok(), o.outcome(),
                o.beforeRaw(), o.afterRaw(), o.beforeScaled(), o.afterScaled(), o.adopted(),
                o.errorCode(), o.message(), o.targetLabel(), o.address(), o.addressHex(),
                o.registerLabel(), o.registerClass(), o.scaleNote(), o.registerNote(),
                o.scaleUnit(), o.noteRequired(), o.confirm(), o.writesToday(), o.lane(),
                o.requestedAt());
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }

    /**
     * Wer handelt - ausschließlich aus dem validierten Token.
     *
     * <p>{@code viaTenantSwitcher} folgt aus {@code platformAdmin}: ein
     * Portal-Admin trägt keinen {@code tenant_id}-Anspruch, erreicht eine
     * Kundenanlage also ausschließlich über den {@code X-Tenant-Id}-Umschalter -
     * ohne ihn wäre der Mandanten-Kontext leer und die Anlage schon oben 404.
     */
    private static RegisterWriteService.Actor actor(Jwt caller) {
        return new RegisterWriteService.Actor(subject(caller), displayName(caller),
                isPlatformAdmin());
    }

    private static boolean isPlatformAdmin() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> PLATFORM_ADMIN_AUTHORITY.equals(a.getAuthority()));
    }

    private static String subject(Jwt caller) {
        return caller == null ? "unbekannt" : caller.getSubject();
    }

    private static String displayName(Jwt caller) {
        if (caller == null) {
            return null;
        }
        Object name = caller.getClaims().get("preferred_username");
        if (name == null) {
            name = caller.getClaims().get("name");
        }
        String s = name == null ? "" : name.toString().trim();
        return s.isEmpty() ? null : s;
    }

    /** Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
