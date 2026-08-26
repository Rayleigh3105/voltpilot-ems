package com.voltpilot.api.web;

import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.repo.AdminProvisionedDeviceRepository;
import com.voltpilot.api.web.dto.AdminDevicesDto;
import com.voltpilot.api.web.dto.EdgeUpdatesDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Schreib- und Lese-Fläche der Verteilung (OTA Stufe 2 „Verteilen",
 * Scout vp-ota-rollout-h4 §7): Releases ausrollen, Wellen freigeben,
 * pausieren, einfrieren, ein Einzelgerät zuweisen - und das alles ANSEHEN.
 *
 * <p><b>Die Sicherheits-Disziplin ist wörtlich die von {@code /admin/fleet}:</b>
 * jede Route liegt unter {@code /api/v1/admin/**}, die Klasse trägt klassenweit
 * {@code @PreAuthorize("hasRole('platform-admin')")} (Kunden-Token = 403,
 * anonym = 401), und die RLS-Umgehung steckt ausschließlich in der
 * BYPASSRLS-gebundenen Repository-Schicht. <b>Kunden-Flächen: bewusst KEINE</b>
 * (§7.1) - Updates sind Plattform-Verantwortung.
 *
 * <p><b>Was hier NICHT passiert: irgendetwas anwenden.</b> Der stärkste Effekt
 * ist eine retained MQTT-Nachricht mit einem signierten Manifest; ob daraus
 * etwas wird, entscheidet das Gerät (Prüfung gegen die eingebackene Wurzel) und
 * danach ein Mensch am Gerät.
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminEdgeUpdateController {

    private final RolloutService rollouts;
    private final AdminProvisionedDeviceRepository registry;

    public AdminEdgeUpdateController(RolloutService rollouts,
            AdminProvisionedDeviceRepository registry) {
        this.rollouts = rollouts;
        this.registry = registry;
    }

    /** Alles, was die Seite „Edge-Updates" zeigt - in EINEM Aufruf. */
    @GetMapping("/edge-updates")
    public EdgeUpdatesDto edgeUpdates() {
        return rollouts.readModel(Instant.now());
    }

    /**
     * Das INVENTAR aller Geräte - der EINE additive Read hinter der Seite
     * „Geräte" (UX-Konzept {@code vp-admin-geraete-ux-k2} §4/§6).
     *
     * <p>Er vereinigt die Aufkleber-Registry mit der echten Flotte. Bis hierher
     * gab es beide nur getrennt, und die Seite namens „Geräte-Registry" enthielt
     * die realen Bestandsboxen (selbst generierte {@code edge-}Referenzen) gar
     * nicht - wer „meine Geräte" suchte, fand sie nur als Nebenspalten anderer
     * Seiten.
     *
     * <p>Er erzeugt KEINE neue Wahrheit: Zustände kommen aus derselben
     * Ableitung wie die Flotten-Zeile, die Registry-Felder aus derselben
     * Abfrage wie bisher.
     */
    @GetMapping("/devices")
    public AdminDevicesDto devices() {
        return rollouts.devices(registry.findAll(), Instant.now());
    }

    /**
     * Das Audit-Journal als Markdown - der optionale gitops-Spiegel (D2).
     *
     * <p><b>Ein EXPORT, kein Deploy.</b> Die api schreibt nirgendwo hin; das
     * Committen ins gitops-Repo macht ein Mensch oder ein Cron außerhalb
     * ({@code tools/deploy/mirror-rollout-journal.sh}). Ein gitops-Schreib-Token
     * in der api wäre eine neue Zugangsdaten-Fläche für etwas, das laut
     * Entscheid D2 ausdrücklich NICHT im Wirkpfad liegen darf.
     *
     * <p>Die Ausgabe ist deterministisch: derselbe Zustand ergibt dieselben
     * Bytes, ein wiederholter Lauf also keinen Commit.
     */
    @GetMapping(value = "/rollout-journal.md", produces = "text/markdown; charset=UTF-8")
    public String rolloutJournal(
            @RequestParam(name = "limit", defaultValue = "1000") int limit) {
        // Gedeckelt, weil das Journal append-only wächst und ein unbegrenzter
        // Export irgendwann die ganze Historie in eine Antwort legen würde.
        return rollouts.journalMarkdown(Math.max(1, Math.min(limit, 5000)));
    }

    // ── Die EINE Handlung ────────────────────────────────────────────────

    /**
     * Eine Aktualisierung: WELCHES Release auf WELCHE Geräte.
     *
     * <p>Das ist der ganze Fluss (Captain-Order 26.08.2026) - kein Ring, keine
     * Wellen, kein zweiter Knopf. Was danach passiert, passiert von selbst.
     */
    public record UpdateRequest(@NotNull Long releaseSeq, @NotEmpty List<UUID> devices) {
    }

    @PostMapping("/rollouts")
    public ResponseEntity<Map<String, String>> createRollout(
            @Valid @RequestBody UpdateRequest req, @AuthenticationPrincipal Jwt caller) {
        UUID id = rollouts.createRollout(req.releaseSeq(), req.devices(), actor(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("rolloutId", id.toString()));
    }

    // ── Einzelgerät ──────────────────────────────────────────────────────

    /** Die Zuweisung EINES Geräts (der Weg über die Geräte-Seite). */
    public record UpdateTargetRequest(@NotNull Long releaseSeq) {
    }

    @PostMapping("/devices/{deviceId}/update-target")
    public ResponseEntity<Void> setTarget(@PathVariable UUID deviceId,
            @Valid @RequestBody UpdateTargetRequest req, @AuthenticationPrincipal Jwt caller) {
        rollouts.assign(deviceId, req.releaseSeq(), null, actor(caller));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/devices/{deviceId}/update-target/revert")
    public ResponseEntity<Void> revertTarget(@PathVariable UUID deviceId,
            @AuthenticationPrincipal Jwt caller) {
        rollouts.revert(deviceId, actor(caller));
        return ResponseEntity.noContent().build();
    }

    /**
     * Der Akteur des Journals ist das JWT-Subject. Ein Eintrag ohne
     * nachvollziehbaren Urheber wäre keine Papier-Spur - und {@code system}
     * bleibt dem Wächter vorbehalten.
     */
    private static String actor(Jwt caller) {
        return caller == null ? "unbekannt" : caller.getSubject();
    }

    /**
     * Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}
     * -Körper statt als nackter Status (das Muster von
     * {@link AdminOptimizerController}).
     */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
