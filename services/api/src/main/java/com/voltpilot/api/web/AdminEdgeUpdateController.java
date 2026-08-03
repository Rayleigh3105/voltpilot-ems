package com.voltpilot.api.web;

import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.web.dto.EdgeUpdatesDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.time.Instant;
import java.util.ArrayList;
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

    public AdminEdgeUpdateController(RolloutService rollouts) {
        this.rollouts = rollouts;
    }

    /** Alles, was die Seite „Edge-Updates" zeigt - in EINEM Aufruf. */
    @GetMapping("/edge-updates")
    public EdgeUpdatesDto edgeUpdates() {
        return rollouts.readModel(Instant.now());
    }

    // ── Rollouts ─────────────────────────────────────────────────────────

    /** Eine Welle: Name + die Geräte, die sie erfasst. */
    public record WaveRequest(String name, @NotEmpty List<UUID> devices) {
    }

    /**
     * Ein Rollout: WELCHES Release, in welchem Ring, in welchen Wellen.
     *
     * <p>Die Wellen kommen ausdrücklich vom Aufrufer und nicht aus einer
     * Automatik: bei einer Flotte dieser Größe ist „hand-advanced" die richtige
     * Antwort (D4), und wer die Wellen schneidet, trifft eine Entscheidung, die
     * niemand raten sollte.
     */
    public record CreateRolloutRequest(@NotNull Long releaseSeq,
            @Pattern(regexp = "canary|stable") String channel,
            @NotEmpty List<WaveRequest> waves) {
    }

    @PostMapping("/rollouts")
    public ResponseEntity<Map<String, String>> createRollout(
            @Valid @RequestBody CreateRolloutRequest req, @AuthenticationPrincipal Jwt caller) {
        List<RolloutService.WaveSpec> waves = new ArrayList<>();
        for (WaveRequest w : req.waves()) {
            waves.add(new RolloutService.WaveSpec(
                    w.name() == null || w.name().isBlank() ? "Welle" : w.name().trim(),
                    w.devices()));
        }
        UUID id = rollouts.createRollout(req.releaseSeq(),
                req.channel() == null ? "stable" : req.channel(), waves, actor(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("rolloutId", id.toString()));
    }

    /** Die nächste Welle - server-seitig verweigert, solange das Bake offen ist. */
    @PostMapping("/rollouts/{rolloutId}/promote")
    public ResponseEntity<Void> promote(@PathVariable UUID rolloutId,
            @AuthenticationPrincipal Jwt caller) {
        rollouts.promote(rolloutId, actor(caller));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/rollouts/{rolloutId}/pause")
    public ResponseEntity<Void> pause(@PathVariable UUID rolloutId,
            @AuthenticationPrincipal Jwt caller) {
        rollouts.pause(rolloutId, actor(caller));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/rollouts/{rolloutId}/resume")
    public ResponseEntity<Void> resume(@PathVariable UUID rolloutId,
            @AuthenticationPrincipal Jwt caller) {
        rollouts.resume(rolloutId, actor(caller));
        return ResponseEntity.noContent().build();
    }

    public record HaltRequest(String reason) {
    }

    /** Der Not-Aus. Bewusst endgültig - siehe {@code RolloutService.halt}. */
    @PostMapping("/rollouts/{rolloutId}/halt")
    public ResponseEntity<Void> halt(@PathVariable UUID rolloutId,
            @RequestBody(required = false) HaltRequest req,
            @AuthenticationPrincipal Jwt caller) {
        String reason = req == null || req.reason() == null || req.reason().isBlank()
                ? "Von Hand eingefroren." : req.reason().trim();
        rollouts.halt(rolloutId, reason, actor(caller));
        return ResponseEntity.noContent().build();
    }

    // ── Einzelgerät ──────────────────────────────────────────────────────

    /**
     * Die Zuweisung EINES Geräts (Kanal + Pin auf der Geräte-Registry-Seite,
     * §7.1).
     *
     * <p>{@code pinned} ist die Ansage „dieses Gerät bleibt, wo es ist": ein
     * Rollout überschreibt eine gepinnte Zuweisung nicht, sondern überspringt
     * das Gerät sichtbar.
     */
    public record UpdateTargetRequest(@NotNull Long releaseSeq,
            @Pattern(regexp = "canary|stable") String channel, Boolean pinned) {
    }

    @PostMapping("/devices/{deviceId}/update-target")
    public ResponseEntity<Void> setTarget(@PathVariable UUID deviceId,
            @Valid @RequestBody UpdateTargetRequest req, @AuthenticationPrincipal Jwt caller) {
        rollouts.assign(deviceId, req.releaseSeq(),
                req.channel() == null ? "stable" : req.channel(),
                Boolean.TRUE.equals(req.pinned()), null, actor(caller));
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
