package com.voltpilot.api.web;

import com.voltpilot.api.fleet.AdminFlottenSpeicher;
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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Schreib- und Lese-Fläche der Verteilung (OTA Stufe 2 „Verteilen", seit
 * dem 26.08.2026 in EINEM Schritt): ein Release auf gewählte Geräte, ein
 * Einzelgerät zuweisen oder zurücknehmen - und das alles ANSEHEN.
 *
 * <p>Beide Schreibwege prüfen dieselben zwei Release-Eigenschaften: signiert
 * und passende Box-Art ({@code ota.BoxArt}); sonst 409 mit deutschem Grund.
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
 * etwas wird, entscheidet das Gerät (Prüfung gegen die eingebackene Wurzel).
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminEdgeUpdateController {

    private final RolloutService rollouts;
    private final AdminProvisionedDeviceRepository registry;
    private final AdminFlottenSpeicher speicher;

    public AdminEdgeUpdateController(RolloutService rollouts,
            AdminProvisionedDeviceRepository registry, AdminFlottenSpeicher speicher) {
        this.rollouts = rollouts;
        this.registry = registry;
        this.speicher = speicher;
    }

    /**
     * Alles, was die Seite „Edge-Updates" zeigt - in EINEM Aufruf. Kurz festgehalten
     * ({@link AdminFlottenSpeicher}); jede Admin-Schreibhandlung verwirft den Stand.
     */
    @GetMapping("/edge-updates")
    public EdgeUpdatesDto edgeUpdates() {
        return speicher.edgeUpdates(() -> rollouts.readModel(Instant.now()));
    }

    /**
     * Die Eignung jeder Box für EIN signiertes Release - bereit, wartet,
     * aktuell oder kann nicht, mit Grund (Geräte &amp; Updates G1, der
     * Verteil-Dialog). Rein lesend; 404 für ein unbekanntes, 409 für ein nicht
     * signiertes Release.
     */
    @GetMapping("/edge-updates/eignung")
    public EdgeUpdatesDto.EignungDto eignung(@RequestParam long releaseSeq) {
        return rollouts.eignung(releaseSeq, Instant.now());
    }

    /**
     * Die Release-Seite: Inhalt aus dem signierten Manifest, „Was ist neu",
     * Programme im Portal (Edge Light), wo es läuft und wann es verteilt wurde
     * (Geräte &amp; Updates G4). Rein lesend; 404 für ein unbekanntes Release.
     */
    @GetMapping("/edge-updates/releases/{releaseSeq}")
    public EdgeUpdatesDto.ReleaseSeiteDto releaseSeite(@PathVariable long releaseSeq) {
        return rollouts.releaseSeite(releaseSeq, Instant.now());
    }

    /**
     * Der Verlauf EINER Box, neueste zuerst: was das Portal angefragt hat und
     * was die Box gemeldet hat (Geräte &amp; Updates G3). Rein lesend; 404, wenn
     * es das Gerät nicht gibt. {@code limit} 1..500, Vorgabe 100.
     */
    @GetMapping("/devices/{deviceId}/verlauf")
    public EdgeUpdatesDto.VerlaufDto verlauf(@PathVariable UUID deviceId,
            @RequestParam(defaultValue = "100") int limit) {
        return rollouts.verlauf(deviceId, limit);
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
        return speicher.geraete(() -> rollouts.devices(registry.findAll(), Instant.now()));
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
    public ResponseEntity<Map<String, Object>> createRollout(
            @Valid @RequestBody UpdateRequest req, @AuthenticationPrincipal Jwt caller) {
        RolloutService.Rollout r = rollouts.createRollout(req.releaseSeq(), req.devices(), actor(caller));
        // additiv: die ausgelassenen Boxen beendeter Kundenbereiche (AP-20, E10 = A), sonst leer
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("rolloutId", r.id().toString(),
                "ausgelassen", r.ausgelassen().stream().map(a -> Map.of("deviceId", a.deviceId().toString(),
                        "label", a.label(), "kundenbereich", a.kundenbereich(),
                        "grund", "kundenbereich_beendet")).toList()));
    }

    // ── Automatik beim ersten Verbinden ──────────────────────────────────

    /** Ein Eintrag des Schalters: wer ihn wann zuletzt umgelegt hat. */
    public record SchalterEintrag(String bereich, boolean an, String geaendertVon, Instant geaendertAm) {
    }

    /** Der Schalter der Automatik ({@code ota.Erstverbindung}): ab Werk an. */
    public record ErstverbindungSchalter(boolean alle, boolean docker, boolean light,
            List<SchalterEintrag> eintraege) {
    }

    @GetMapping("/edge-updates/erstverbindung")
    public ErstverbindungSchalter erstverbindung() {
        var s = rollouts.erstverbindungSchalter();
        return new ErstverbindungSchalter(s.alle(), s.docker(), s.light(),
                rollouts.erstverbindungSchalterEintraege().stream()
                        .map(e -> new SchalterEintrag(e.bereich(), e.an(), e.geaendertVon(), e.geaendertAm()))
                        .toList());
    }

    public record SchalterRequest(@NotNull Boolean an) {
    }

    /**
     * Die Automatik je Linie ({@code docker}, {@code light}) oder für {@code alle}
     * an- oder abschalten - ohne Deploy; jede Änderung steht im Journal.
     */
    @PostMapping("/edge-updates/erstverbindung/{bereich}")
    public ErstverbindungSchalter setzeErstverbindung(@PathVariable String bereich,
            @Valid @RequestBody SchalterRequest req, @AuthenticationPrincipal Jwt caller) {
        rollouts.setzeErstverbindungSchalter(bereich, req.an(), actor(caller));
        return erstverbindung();
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
