package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.EdgeReleaseRepository;
import com.voltpilot.api.repo.RolloutRepository;
import com.voltpilot.api.web.dto.EdgeReleaseDto;
import com.voltpilot.api.web.dto.EdgeUpdatesDto;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Orchestrierung der Verteilung (OTA Stufe 2 „Verteilen", Scout
 * vp-ota-rollout-h4 §7/§9, Captain-Entscheid D4): Zuweisen, in Wellen
 * freigeben, pausieren, anhalten - und beobachten, was daraus wird.
 *
 * <p><b>Was hier NICHT passiert: irgendetwas anwenden.</b> Der stärkste Effekt
 * dieser Klasse auf ein Gerät ist eine retained MQTT-Nachricht mit einem
 * signierten Manifest. Ob daraus etwas wird, entscheidet das Gerät (Prüfung
 * gegen die eingebackene Wurzel) und danach ein Mensch am Gerät
 * ({@code update.sh --from-target}).
 *
 * <p><b>Die Sicherheits-Disziplin ist übernommen:</b> alle Aufrufer liegen
 * unter {@code /api/v1/admin/**} hinter
 * {@code @PreAuthorize("hasRole('platform-admin')")}, und die RLS-Umgehung
 * steckt ausschließlich in {@link RolloutRepository} an der dedizierten
 * BYPASSRLS-Rolle - dasselbe Muster wie {@code /admin/fleet}.
 *
 * <p><b>⚠ Hier steht bewusst KEIN {@code @Transactional}</b> - und das ist
 * keine Nachlässigkeit, sondern die Vermeidung einer Lüge. Springs
 * Transaktionsmanager hängt am {@code @Primary}, also am MANDANTEN-Datenpfad;
 * alle Schreibvorgänge hier laufen aber über {@code adminJdbcTemplate} an der
 * BYPASSRLS-Rolle. Die Annotation würde eine Transaktion auf der FALSCHEN
 * Verbindung öffnen und Atomarität BEHAUPTEN, die es nicht gibt (dieselbe
 * Falle, wegen der {@code TenantRepository.offboard} seine Transaktion von
 * Hand auf der Admin-Verbindung führt).
 *
 * <p>Getragen wird das stattdessen von der Reihenfolge: jeder mehrschrittige
 * Vorgang PRÜFT vollständig, bevor er das Erste schreibt (ein Rollout
 * validiert jedes Gerät, bevor eine Zeile entsteht), und jeder einzelne
 * Schritt ist für sich idempotent - ein abgebrochener Anlauf hinterlässt
 * höchstens einen sichtbaren Rollout ohne Zuweisungen, den man einfrieren
 * kann, nie eine halb verteilte Flotte. Wer hier echte Atomarität braucht,
 * baut sie über einen eigenen Transaktionsmanager auf der Admin-DataSource,
 * nicht über die Annotation.
 */
@Service
public class RolloutService {

    private static final Logger log = LoggerFactory.getLogger(RolloutService.class);

    /** Der Akteur, unter dem der Wächter selbst handelt (nie ein Mensch). */
    public static final String SYSTEM_ACTOR = "system";

    private final RolloutRepository rollouts;
    private final EdgeReleaseRepository releases;
    private final ObjectProvider<OtaTargetPublisher> publisher;
    private final ObjectMapper json;
    private final Duration republishAfter;

    public RolloutService(RolloutRepository rollouts, EdgeReleaseRepository releases,
            ObjectProvider<OtaTargetPublisher> publisher, ObjectMapper json,
            @Value("${voltpilot.ota.republish-after:PT30M}") Duration republishAfter) {
        this.rollouts = rollouts;
        this.releases = releases;
        this.publisher = publisher;
        this.json = json;
        this.republishAfter = republishAfter;
    }

    // ── Einzelgerät-Zuweisung ────────────────────────────────────────────

    /**
     * Einem Gerät ein Release zuweisen („Jetzt aktualisieren" / Kanal + Pin auf
     * der Geräte-Registry-Seite).
     *
     * <p>Nur ein SIGNIERTES Release ist zuweisbar: ohne Manifest-Bytes gäbe es
     * nichts, was das Gerät gegen seine Wurzel prüfen könnte, und der Downlink
     * wäre eine Anweisung ohne Beleg.
     */
    public void assign(UUID deviceId, long releaseSeq, String channel, boolean pinned,
            UUID rolloutId, String actor) {
        RolloutRepository.FleetDeviceRow device = rollouts.fleetDevice(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Gerät nicht gefunden."));
        EdgeReleaseDto release = signedRelease(releaseSeq);
        rollouts.upsertTarget(deviceId, releaseSeq, release.version(), channel, pinned, rolloutId,
                actor);
        rollouts.appendEvent(actor, "target_assigned", rolloutId, deviceId,
                release.version() + " (" + channel + (pinned ? ", gepinnt" : "") + ")");
        publish(device, release, channel, rolloutId);
    }

    /**
     * Eine Zuweisung zurücknehmen: die Zeile geht, und die retained Nachricht
     * wird gelöscht - sonst wartete auf dem Broker eine Anweisung, die niemand
     * mehr verantwortet.
     */
    public void revert(UUID deviceId, String actor) {
        RolloutRepository.FleetDeviceRow device = rollouts.fleetDevice(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Gerät nicht gefunden."));
        if (!rollouts.deleteTarget(deviceId)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diesem Gerät ist kein Release zugewiesen.");
        }
        rollouts.appendEvent(actor, "target_reverted", null, deviceId, null);
        publisher.ifAvailable(p -> p.clearTarget(device.tenantId(), device.siteId(), deviceId));
    }

    /**
     * Aufräumen beim Unclaim: Zuweisung löschen und den retained Slot leeren.
     * Best-effort und niemals werfend - ein Unclaim darf an einem
     * Broker-Ausfall nicht scheitern (die {@code ProvisioningPublisher}
     * -Präzedenz).
     */
    public void onDeviceUnclaimed(UUID tenantId, UUID siteId, UUID deviceId) {
        try {
            if (rollouts.deleteTarget(deviceId)) {
                rollouts.appendEvent(SYSTEM_ACTOR, "target_cleared_on_unclaim", null, deviceId,
                        null);
            }
        } catch (Exception e) {
            log.warn("could not drop the OTA target of unclaimed device {}: {}", deviceId,
                    e.getMessage());
        }
        publisher.ifAvailable(p -> p.clearTarget(tenantId, siteId, deviceId));
    }

    // ── Rollouts ─────────────────────────────────────────────────────────

    /** Eine Wellen-Definition, wie sie der Aufrufer schickt. */
    public record WaveSpec(String name, List<UUID> devices) {
    }

    /**
     * Einen Rollout anlegen. Die ERSTE Welle wird sofort zugewiesen (ein
     * Rollout, der nichts tut, bis jemand „weiter" drückt, wäre kein Start),
     * alle weiteren sind hand-advanced (D4).
     */
    public UUID createRollout(long releaseSeq, String channel, List<WaveSpec> waves,
            boolean autoAdvance, String actor) {
        EdgeReleaseDto release = signedRelease(releaseSeq);
        if (waves == null || waves.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Ein Rollout braucht mindestens eine Welle.");
        }
        if (rollouts.liveRollout().isPresent()) {
            // Zwei gleichzeitig laufende Verteilungen könnten demselben Gerät
            // verschiedene Ziele zuweisen - und ein Auto-Halt wäre nicht mehr
            // zuzuordnen.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Es läuft bereits ein Rollout. Erst beenden oder einfrieren.");
        }
        Map<UUID, RolloutRepository.FleetDeviceRow> fleet = fleetById();
        LinkedHashSet<UUID> seen = new LinkedHashSet<>();
        for (WaveSpec w : waves) {
            if (w.devices() == null || w.devices().isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Die Welle '" + w.name() + "' enthält kein Gerät.");
            }
            for (UUID d : w.devices()) {
                if (!seen.add(d)) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                            "Ein Gerät kann nur in EINER Welle stehen (" + d + ").");
                }
                if (!fleet.containsKey(d)) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                            "Unbekanntes Gerät: " + d);
                }
            }
        }

        UUID id = UUID.randomUUID();
        rollouts.insertRollout(id, releaseSeq, release.version(), channel, wavesJson(waves),
                autoAdvance, actor);
        for (int i = 0; i < waves.size(); i++) {
            for (UUID d : waves.get(i).devices()) {
                // Der NAMENS-Schnappschuss entsteht hier, nicht beim Lesen: die
                // Wellen-Definition ist eingefroren, also muss auch ihre
                // Beschriftung einen späteren Unclaim überleben (sonst fällt die
                // Zeile auf eine nackte UUID zurück - Reibung R2).
                RolloutRepository.FleetDeviceRow d0 = fleet.get(d);
                rollouts.insertRolloutDevice(id, d, i + 1, RolloutStates.AUSSTEHEND, null,
                        d0 == null ? null : label(d0), d0 == null ? null : d0.siteName());
            }
        }
        rollouts.appendEvent(actor, "rollout_created", id, null,
                release.version() + " → " + channel + ", " + waves.size() + " Welle"
                        + (waves.size() == 1 ? "" : "n") + ", " + seen.size() + " Geräte, "
                        + (autoAdvance ? "automatischer" : "hand-geführter") + " Wellen-Vorschub");
        releaseWave(id, 1, waves.get(0).devices(), release, channel, actor);
        return id;
    }

    /** Die nächste Welle freigeben - nur wenn das Bake-Kriterium erfüllt ist. */
    public void promote(UUID rolloutId, String actor) {
        RolloutRepository.RolloutRow r = requireRollout(rolloutId);
        if (!"active".equals(r.state())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Rollout ist " + stateLabel(r.state()) + " - es wird nichts freigegeben.");
        }
        List<WaveSpec> waves = parseWaves(r.wavesJson());
        if (r.currentWave() >= waves.size()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Alle Wellen sind bereits freigegeben.");
        }
        BakeGate.WaveBake bake = bakeOfWave(r, r.currentWave());
        if (!bake.passed()) {
            // SERVER-seitig, nicht nur ein ausgegrauter Knopf: die Regel muss
            // auch dann halten, wenn jemand direkt auf den Endpunkt geht.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die laufende Welle ist noch nicht bestätigt: " + bake.reason());
        }
        int next = r.currentWave() + 1;
        EdgeReleaseDto release = signedRelease(r.releaseSeq());
        releaseWave(rolloutId, next, waves.get(next - 1).devices(), release, r.channel(), actor);
        if (next >= waves.size()) {
            rollouts.appendEvent(actor, "rollout_last_wave", rolloutId, null,
                    "Letzte Welle freigegeben.");
        }
    }

    /**
     * Den Wellen-Vorschub umschalten (OTA Stufe 4 „Politur").
     *
     * <p><b>Hand-Vorschub bleibt die Vorgabe</b> (D4: „Wellen hand-advanced -
     * bei ≤10 Geräten richtig"); dies ist eine bewusst gewählte OPTION. Sie
     * erleichtert genau EINEN Schritt - das Drücken von „Nächste Welle", wenn
     * das Bake-Kriterium ohnehin erfüllt ist - und lockert keine einzige Regel:
     * dasselbe {@link BakeGate}, derselbe Auto-Halt, derselbe endgültige
     * Not-Aus. Sie ist nachträglich schaltbar, damit ein Betreiber die erste
     * Welle von Hand begleiten und danach umstellen kann, ohne den Rollout
     * abzubrechen.
     */
    public void setAutoAdvance(UUID rolloutId, boolean enabled, String actor) {
        RolloutRepository.RolloutRow r = requireRollout(rolloutId);
        if ("halted".equals(r.state()) || "done".equals(r.state())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Rollout ist " + stateLabel(r.state())
                            + " - der Wellen-Vorschub ändert daran nichts.");
        }
        if (r.autoAdvance() == enabled) {
            return; // idempotent
        }
        rollouts.setAutoAdvance(rolloutId, enabled);
        rollouts.appendEvent(actor, enabled ? "auto_advance_on" : "auto_advance_off", rolloutId,
                null, enabled
                        ? "Wellen werden automatisch freigegeben, sobald das Bake-Kriterium "
                                + "erfüllt ist."
                        : "Wellen werden wieder von Hand freigegeben.");
    }

    /** Pause: reversibel, es wird nichts weiter zugewiesen. */
    public void pause(UUID rolloutId, String actor) {
        RolloutRepository.RolloutRow r = requireRollout(rolloutId);
        if (!"active".equals(r.state())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Nur ein laufender Rollout kann pausiert werden.");
        }
        rollouts.setRolloutState(rolloutId, "paused", null);
        rollouts.appendEvent(actor, "rollout_paused", rolloutId, null, null);
    }

    public void resume(UUID rolloutId, String actor) {
        RolloutRepository.RolloutRow r = requireRollout(rolloutId);
        if (!"paused".equals(r.state())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Nur ein pausierter Rollout kann fortgesetzt werden.");
        }
        rollouts.setRolloutState(rolloutId, "active", null);
        rollouts.appendEvent(actor, "rollout_resumed", rolloutId, null, null);
    }

    /**
     * Der Not-Aus. Er ist bewusst ENDGÜLTIG: nach einem Einfrieren ist
     * „weitermachen" eine neue, bewusste Entscheidung (ein neuer Rollout), kein
     * Klick, der die Ursache überspringt.
     *
     * <p>Bereits erteilte Zuweisungen bleiben BESTEHEN - sie zurückzunehmen
     * würde eine halb aktualisierte Flotte auf einen dritten Stand schicken.
     * Was aufhört, ist das WEITERE Verteilen.
     */
    public void halt(UUID rolloutId, String reason, String actor) {
        RolloutRepository.RolloutRow r = requireRollout(rolloutId);
        if ("halted".equals(r.state()) || "done".equals(r.state())) {
            return;
        }
        rollouts.setRolloutState(rolloutId, "halted", reason);
        rollouts.appendEvent(actor, "rollout_halted", rolloutId, null, reason);
        log.warn("OTA rollout {} halted: {}", rolloutId, reason);
    }

    // ── Der Wächter: Zustände fortschreiben, Auto-Halt, Drift ────────────

    /**
     * Ein Durchlauf des Wächters: den abgeleiteten Zustand jedes Geräts des
     * laufenden Rollouts fortschreiben, bei einem harten Fehlerzustand
     * AUTOMATISCH anhalten, und Zuweisungen nach-veröffentlichen, deren
     * retained Nachricht offenbar nicht (mehr) wirkt.
     *
     * <p>Idempotent und ohne Nebenwirkung, wenn nichts zu tun ist.
     */
    public void reconcile(Instant now) {
        Map<UUID, RolloutRepository.FleetDeviceRow> fleet = fleetById();
        Optional<RolloutRepository.RolloutRow> live = rollouts.liveRollout();

        if (live.isPresent()) {
            RolloutRepository.RolloutRow r = live.get();
            String haltReason = null;
            UUID haltDevice = null;
            boolean allConfirmed = true;
            List<WaveSpec> waves = parseWaves(r.wavesJson());
            for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
                RolloutStates.Verdict v = deviceVerdict(fleet.get(rd.deviceId()),
                        r.releaseVersion(), now);
                if (!v.state().equals(rd.state())) {
                    rollouts.updateRolloutDeviceState(r.id(), rd.deviceId(), v.state(),
                            v.reason());
                    rollouts.appendEvent(SYSTEM_ACTOR, "device_state", r.id(), rd.deviceId(),
                            v.state() + (v.reason() == null ? "" : " - " + v.reason()));
                }
                if (rd.wave() <= r.currentWave() && !RolloutStates.isConfirmed(v.state())) {
                    allConfirmed = false;
                }
                if (haltReason == null && rd.wave() <= r.currentWave()
                        && RolloutStates.haltsRollout(v.state())) {
                    haltReason = v.state() + (v.reason() == null ? "" : ": " + v.reason());
                    haltDevice = rd.deviceId();
                }
            }
            if (haltReason != null && "active".equals(r.state())) {
                // D4: JEDER failed / rolled_back / verstummt hält die
                // Verteilung an. Bestehende Zuweisungen bleiben; was aufhört,
                // ist das Weiterrollen.
                rollouts.setRolloutState(r.id(), "halted",
                        "Automatisch angehalten - ein Gerät meldet: " + haltReason);
                rollouts.appendEvent(SYSTEM_ACTOR, "rollout_auto_halted", r.id(), haltDevice,
                        haltReason);
                log.error("OTA rollout {} AUTO-HALTED by device {}: {}", r.id(), haltDevice,
                        haltReason);
            } else if (allConfirmed && r.currentWave() >= waves.size()
                    && "active".equals(r.state())) {
                rollouts.setRolloutState(r.id(), "done", null);
                rollouts.appendEvent(SYSTEM_ACTOR, "rollout_done", r.id(), null,
                        "Alle Wellen bestätigt.");
            } else if (r.autoAdvance() && "active".equals(r.state())
                    && r.currentWave() >= 1 && r.currentWave() < waves.size()) {
                // Die WELLEN-AUTOMATIK (Stufe 4). Sie steht bewusst im ELSE-Zweig
                // des Auto-Halts: ein Rollout, der gerade angehalten hat, kann
                // hier nie weiterlaufen - und zwar nicht, weil jemand daran
                // gedacht hat, sondern weil der Halt vorher zurückschreibt und
                // dieser Zweig dann nicht erreicht wird. „paused" fällt aus
                // demselben Grund heraus (state != active).
                BakeGate.WaveBake bake = bakeOfWave(r, r.currentWave());
                if (bake.passed()) {
                    int next = r.currentWave() + 1;
                    EdgeReleaseDto release = signedRelease(r.releaseSeq());
                    rollouts.appendEvent(SYSTEM_ACTOR, "wave_auto_released", r.id(), null,
                            "Welle " + r.currentWave() + " hat das Bake-Kriterium erfüllt - "
                                    + "Welle " + next + " wird automatisch freigegeben.");
                    releaseWave(r.id(), next, waves.get(next - 1).devices(), release, r.channel(),
                            SYSTEM_ACTOR);
                    if (next >= waves.size()) {
                        rollouts.appendEvent(SYSTEM_ACTOR, "rollout_last_wave", r.id(), null,
                                "Letzte Welle freigegeben.");
                    }
                }
            }
        }

        // Drift-Wächter: eine Zuweisung, die das Gerät nicht (mehr) trägt,
        // wird nach-veröffentlicht. Offline-Geräte holen retained ohnehin nach -
        // dieser Pfad deckt die Fälle, in denen die retained Nachricht selbst
        // fehlt (Broker-Ausfall beim Zuweisen, gelöschter Broker-Zustand).
        for (RolloutRepository.TargetRow t : rollouts.allTargets()) {
            RolloutRepository.FleetDeviceRow d = fleet.get(t.deviceId());
            if (d == null) {
                continue;
            }
            boolean deviceKnowsIt = t.releaseVersion().equals(d.reportedTarget())
                    || RolloutStates.releaseIsRunning(t.releaseVersion(), reportedRunning(d));
            if (deviceKnowsIt) {
                continue;
            }
            if (t.publishedAt() != null && t.publishedAt().isAfter(now.minus(republishAfter))) {
                continue; // erst kürzlich veröffentlicht - nicht hämmern
            }
            if (publishTarget(d, t.releaseVersion(), t.releaseSeq(), t.channel(), t.rolloutId(),
                    t.manifest(), t.signature(), t.assignedAt())) {
                rollouts.appendEvent(SYSTEM_ACTOR, "target_republished", t.rolloutId(),
                        t.deviceId(), t.releaseVersion());
            }
        }
    }

    /**
     * Das Audit-Journal als Markdown (der optionale gitops-Spiegel, D2).
     *
     * <p>Rein dokumentarisch: es fließt nichts zurück, und die api hält KEIN
     * Schreib-Token für ein zweites Repo - siehe {@link RolloutJournal}.
     */
    public String journalMarkdown(int limit) {
        Map<UUID, String> labels = new HashMap<>();
        for (RolloutRepository.FleetDeviceRow d : rollouts.fleetDevices()) {
            labels.put(d.deviceId(), label(d) + " (" + d.siteName() + ")");
        }
        return RolloutJournal.render(rollouts.recentEvents(limit), labels);
    }

    // ── Lesemodell ───────────────────────────────────────────────────────

    /** Alles, was die Seite „Edge-Updates" zeigt - in EINER Abfrage-Runde. */
    public EdgeUpdatesDto readModel(Instant now) {
        List<RolloutRepository.FleetDeviceRow> fleet = rollouts.fleetDevices();
        Map<UUID, RolloutRepository.TargetRow> targets = new HashMap<>();
        for (RolloutRepository.TargetRow t : rollouts.allTargets()) {
            targets.put(t.deviceId(), t);
        }
        // Angezeigt wird der JÜNGSTE Rollout, nicht nur ein laufender: ein
        // gerade automatisch angehaltener darf nicht in dem Augenblick von der
        // Seite verschwinden, in dem etwas schiefgegangen ist.
        Optional<RolloutRepository.RolloutRow> live = rollouts.latestRollout();

        // Releases + „läuft auf N Geräten".
        Map<String, Integer> runningPerRelease = new HashMap<>();
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            String running = reportedRunning(d);
            if (running == null) {
                continue;
            }
            for (EdgeReleaseDto rel : releases.findAll()) {
                if (RolloutStates.releaseIsRunning(rel.version(), running)) {
                    runningPerRelease.merge(rel.version(), 1, Integer::sum);
                }
            }
        }
        List<EdgeUpdatesDto.ReleaseDto> releaseDtos = new ArrayList<>();
        for (EdgeReleaseDto rel : releases.findAll()) {
            releaseDtos.add(new EdgeUpdatesDto.ReleaseDto(rel.releaseSeq(), rel.version(),
                    rel.targetCommit(), rel.notes(), rel.manifest() != null, rel.signingKeyId(),
                    rel.createdAt(), runningPerRelease.getOrDefault(rel.version(), 0)));
        }

        // Die Flotten-Matrix.
        List<EdgeUpdatesDto.FleetRowDto> rows = new ArrayList<>();
        Map<UUID, RolloutRepository.RolloutDeviceRow> inRollout = new HashMap<>();
        if (live.isPresent()) {
            for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(live.get().id())) {
                inRollout.put(rd.deviceId(), rd);
            }
        }
        int known = 0;
        int upToDate = 0;
        int unknown = 0;
        int failed = 0;
        int waiting = 0;
        String newest = releaseDtos.isEmpty() ? null : releaseDtos.get(0).version();
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            RolloutRepository.TargetRow t = targets.get(d.deviceId());
            String assigned = t == null ? null : t.releaseVersion();
            RolloutStates.Verdict v = deviceVerdict(d, assigned, now);
            RolloutRepository.RolloutDeviceRow rd = inRollout.get(d.deviceId());
            rows.add(new EdgeUpdatesDto.FleetRowDto(d.deviceId(), label(d), d.siteId(),
                    d.siteName(), d.tenantId(), d.tenantName(), reportedRunning(d), assigned,
                    t == null ? null : t.releaseSeq(), t == null ? null : t.channel(),
                    t != null && t.pinned(), v.state(), v.reason(), d.reportedBlocker(),
                    rd == null ? null : rd.since(), d.reportedAt(),
                    rd == null ? null : rd.rolloutId(), trustDto(d)));

            if (RolloutStates.UNBEKANNT.equals(v.state())) {
                unknown++;
            } else {
                // Prozentzahlen NUR über die erreichbare Menge (§7).
                known++;
                if (newest != null && RolloutStates.releaseIsRunning(newest, reportedRunning(d))) {
                    upToDate++;
                }
            }
            if (RolloutStates.FEHLGESCHLAGEN.equals(v.state())
                    || RolloutStates.ZURUECKGEROLLT.equals(v.state())
                    || RolloutStates.IM_UPDATE_VERSTUMMT.equals(v.state())) {
                failed++;
            }
            if (RolloutStates.WARTET_AUF_ANWENDUNG.equals(v.state())) {
                waiting++;
            }
        }

        EdgeUpdatesDto.RolloutDto rolloutDto = live.map(r -> rolloutDto(r, fleet, now))
                .orElse(null);
        List<EdgeUpdatesDto.EventDto> journal = new ArrayList<>();
        for (RolloutRepository.EventRow e : rollouts.recentEvents(200)) {
            journal.add(new EdgeUpdatesDto.EventDto(e.id(), e.at(), e.actor(), e.event(),
                    e.rolloutId(), e.deviceId(), e.detail()));
        }
        // Eine freigebbare Welle ist ebenfalls „Sie sind dran" - der zweite der
        // zwei Schritte, die ohne den Betreiber nie passieren.
        if (rolloutDto != null && rolloutDto.canPromote()) {
            waiting++;
        }
        return new EdgeUpdatesDto(releaseDtos, rolloutDto, rows, journal,
                new EdgeUpdatesDto.KpiDto(known, upToDate, unknown, inRollout.size(), failed,
                        waiting, newest));
    }

    private EdgeUpdatesDto.RolloutDto rolloutDto(RolloutRepository.RolloutRow r,
            List<RolloutRepository.FleetDeviceRow> fleet, Instant now) {
        Map<UUID, RolloutRepository.FleetDeviceRow> byId = new HashMap<>();
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            byId.put(d.deviceId(), d);
        }
        List<WaveSpec> specs = parseWaves(r.wavesJson());
        Map<UUID, RolloutRepository.RolloutDeviceRow> rowByDevice = new HashMap<>();
        for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
            rowByDevice.put(rd.deviceId(), rd);
        }

        List<EdgeUpdatesDto.WaveDto> waveDtos = new ArrayList<>();
        for (int i = 0; i < specs.size(); i++) {
            int index = i + 1;
            boolean released = index <= r.currentWave();
            List<EdgeUpdatesDto.WaveDeviceDto> devices = new ArrayList<>();
            boolean confirmed = true;
            for (UUID id : specs.get(i).devices()) {
                RolloutRepository.FleetDeviceRow d = byId.get(id);
                RolloutRepository.RolloutDeviceRow rd = rowByDevice.get(id);
                String state = rd == null ? RolloutStates.AUSSTEHEND : rd.state();
                BakeGate.DeviceBake bake = BakeGate.device(id, state,
                        rd == null ? null : rd.since(),
                        d == null ? null : d.controlCertified(),
                        d == null ? null : d.controlConfirmed(),
                        d == null ? null : d.controlCheckedAt(), now);
                if (!RolloutStates.isConfirmed(state)) {
                    confirmed = false;
                }
                // NAMEN, in dieser Reihenfolge: das Gerät, wie es HEUTE heißt -
                // sonst der Schnappschuss vom Zuweisungs-Zeitpunkt - sonst gar
                // nichts. Eine UUID wird NIE ausgeliefert: sie beantwortet die
                // Frage der Zeile („welche Anlage?") nicht, und die Oberfläche
                // müsste sie trotzdem rendern.
                String label = d != null ? label(d) : rd == null ? null : rd.deviceRef();
                String site = d != null ? d.siteName() : rd == null ? null : rd.siteName();
                devices.add(new EdgeUpdatesDto.WaveDeviceDto(id, label, site,
                        d == null ? null : d.tenantName(),
                        state, rd == null ? null : rd.reason(), rd == null ? null : rd.since(),
                        released ? bake.remaining().toMinutes() : null,
                        released ? bake.cycle().name().toLowerCase() : null,
                        released ? bake.reason() : null, d == null));
            }
            waveDtos.add(new EdgeUpdatesDto.WaveDto(index, specs.get(i).name(), released,
                    released && confirmed, devices));
        }

        BakeGate.WaveBake bake = bakeOfWave(r, r.currentWave());
        boolean more = r.currentWave() < specs.size();
        boolean canPromote = "active".equals(r.state()) && more && bake.passed();
        String blocked = null;
        if (!canPromote) {
            if (!"active".equals(r.state())) {
                blocked = "Der Rollout ist " + stateLabel(r.state()) + ".";
            } else if (!more) {
                blocked = "Alle Wellen sind freigegeben.";
            } else {
                blocked = bake.reason();
            }
        }
        return new EdgeUpdatesDto.RolloutDto(r.id(), r.releaseVersion(), r.releaseSeq(),
                r.channel(), r.state(), r.currentWave(), specs.size(), r.haltedReason(),
                r.createdBy(), r.createdAt(), canPromote, blocked, r.autoAdvance(),
                advanceNote(r, specs.size(), bake, more), waveDtos);
    }

    /**
     * Der eine Satz, der sagt, WARUM die nächste Welle gerade (nicht) kommt.
     *
     * <p>Er ist die Antwort auf „in welchem Modus läuft dieser Rollout, und was
     * passiert als Nächstes" - ohne ihn wäre die Automatik ein unsichtbarer
     * Zustand, und ein Betreiber müsste raten, ob gerade auf ihn oder auf das
     * Bake-Fenster gewartet wird.
     */
    private static String advanceNote(RolloutRepository.RolloutRow r, int waveCount,
            BakeGate.WaveBake bake, boolean more) {
        if ("halted".equals(r.state())) {
            return "Eingefroren - es wird nichts weiter freigegeben. Weitermachen ist ein neuer, "
                    + "bewusst gestarteter Rollout.";
        }
        if ("done".equals(r.state())) {
            return "Abgeschlossen.";
        }
        if (!more) {
            return "Alle " + waveCount + " Wellen sind freigegeben.";
        }
        if ("paused".equals(r.state())) {
            return r.autoAdvance()
                    ? "Pausiert - der automatische Vorschub ruht, bis der Rollout fortgesetzt wird."
                    : "Pausiert - es wird nichts freigegeben.";
        }
        if (r.autoAdvance()) {
            return bake.passed()
                    ? "Automatischer Vorschub: die nächste Welle wird beim nächsten Durchlauf "
                            + "freigegeben."
                    : "Automatischer Vorschub: die nächste Welle wird freigegeben, sobald das "
                            + "Bake-Kriterium erfüllt ist. Offen: " + bake.reason();
        }
        return bake.passed()
                ? "Hand-Vorschub: die nächste Welle ist frei und wartet auf Ihre Freigabe."
                : "Hand-Vorschub: " + bake.reason();
    }

    /**
     * Die gemeldete Vertrauens-Identität, so wie sie in der Zeile steht.
     *
     * <p><b>Die Abwesenheits-Regel ist hier zu Hause:</b> {@code null} bleibt
     * {@code null} (ein älterer Edge-Stand meldet nichts → „unbekannt"), ein
     * LEERER String wird zur LEEREN Liste (ein Image ohne eingebackene Wurzel →
     * der Crossover steht aus). Beides sind verschiedene Aussagen, und keine
     * davon ist ein Fehler.
     */
    private static EdgeUpdatesDto.TrustDto trustDto(RolloutRepository.FleetDeviceRow d) {
        if (d.rootKeyIds() == null) {
            return null;
        }
        return new EdgeUpdatesDto.TrustDto(splitKeyIds(d.rootKeyIds()),
                splitKeyIds(d.trustSetKeyIds()), d.trustSetGeneratedAt(), d.trustSetError());
    }

    private static List<String> splitKeyIds(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        return List.of(raw.split(","));
    }

    // ── Interna ──────────────────────────────────────────────────────────

    private BakeGate.WaveBake bakeOfWave(RolloutRepository.RolloutRow r, int wave) {
        if (wave < 1) {
            return new BakeGate.WaveBake(true, null, List.of());
        }
        Map<UUID, RolloutRepository.FleetDeviceRow> fleet = fleetById();
        Instant now = Instant.now();
        List<BakeGate.DeviceBake> bakes = new ArrayList<>();
        for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
            if (rd.wave() != wave) {
                continue;
            }
            RolloutRepository.FleetDeviceRow d = fleet.get(rd.deviceId());
            bakes.add(BakeGate.device(rd.deviceId(), rd.state(), rd.since(),
                    d == null ? null : d.controlCertified(),
                    d == null ? null : d.controlConfirmed(),
                    d == null ? null : d.controlCheckedAt(), now));
        }
        return BakeGate.wave(bakes);
    }

    private void releaseWave(UUID rolloutId, int wave, List<UUID> devices, EdgeReleaseDto release,
            String channel, String actor) {
        Map<UUID, RolloutRepository.FleetDeviceRow> fleet = fleetById();
        int skipped = 0;
        for (UUID deviceId : devices) {
            RolloutRepository.FleetDeviceRow d = fleet.get(deviceId);
            if (d == null) {
                continue;
            }
            Optional<RolloutRepository.TargetRow> existing = rollouts.targetOf(deviceId);
            if (existing.isPresent() && existing.get().pinned()) {
                // Ein Pin ist genau die Ansage „dieses Gerät bleibt, wo es
                // ist". Ihn stillschweigend zu überfahren machte ihn wertlos.
                skipped++;
                rollouts.updateRolloutDeviceState(rolloutId, deviceId, RolloutStates.ZURUECKGESTELLT,
                        "Dieses Gerät ist auf " + existing.get().releaseVersion()
                                + " festgenagelt - der Rollout überschreibt einen Pin nicht.");
                rollouts.appendEvent(actor, "device_pinned_skipped", rolloutId, deviceId,
                        existing.get().releaseVersion());
                continue;
            }
            rollouts.upsertTarget(deviceId, release.releaseSeq(), release.version(), channel,
                    false, rolloutId, actor);
            publish(d, release, channel, rolloutId);
        }
        rollouts.setCurrentWave(rolloutId, wave);
        rollouts.appendEvent(actor, "wave_released", rolloutId, null,
                "Welle " + wave + ": " + (devices.size() - skipped) + " Gerät"
                        + (devices.size() - skipped == 1 ? "" : "e")
                        + (skipped > 0 ? ", " + skipped + " gepinnt übersprungen" : ""));
    }

    private void publish(RolloutRepository.FleetDeviceRow d, EdgeReleaseDto release,
            String channel, UUID rolloutId) {
        publishTarget(d, release.version(), release.releaseSeq(), channel, rolloutId,
                release.manifest(), release.signature(), Instant.now());
    }

    private boolean publishTarget(RolloutRepository.FleetDeviceRow d, String version, long seq,
            String channel, UUID rolloutId, String manifest, String signature, Instant assignedAt) {
        if (manifest == null || signature == null) {
            return false;
        }
        OtaTargetPublisher p = publisher.getIfAvailable();
        if (p == null) {
            // Kein Broker konfiguriert (Tests, broker-lose Deployments): die
            // Zuweisung STEHT, sie ist nur noch nicht hinausgegangen.
            return false;
        }
        boolean sent = p.publishTarget(d.tenantId(), d.siteId(), d.deviceId(), version, seq,
                channel, rolloutId, manifest, signature, assignedAt);
        if (sent) {
            rollouts.markPublished(d.deviceId());
        }
        return sent;
    }

    private Map<UUID, RolloutRepository.FleetDeviceRow> fleetById() {
        Map<UUID, RolloutRepository.FleetDeviceRow> map = new HashMap<>();
        for (RolloutRepository.FleetDeviceRow d : rollouts.fleetDevices()) {
            map.put(d.deviceId(), d);
        }
        return map;
    }

    private static RolloutStates.Verdict deviceVerdict(RolloutRepository.FleetDeviceRow d,
            String assigned, Instant now) {
        if (d == null) {
            return new RolloutStates.Verdict(RolloutStates.UNBEKANNT,
                    "Dieses Gerät existiert nicht mehr.");
        }
        return RolloutStates.derive(assigned, new RolloutStates.Reported(d.reportedVersion(),
                d.reportedCurrent(), d.reportedTarget(), d.reportedState(), d.reportedVerdict(),
                d.reportedReason(), d.reportedBlocker(), d.reportedAt(), d.lastSeenAt()), now);
    }

    /** Der gemeldete laufende Stand - {@code current} vor {@code version}. */
    private static String reportedRunning(RolloutRepository.FleetDeviceRow d) {
        return d.reportedCurrent() != null ? d.reportedCurrent() : d.reportedVersion();
    }

    private static String label(RolloutRepository.FleetDeviceRow d) {
        return d.deviceName() != null && !d.deviceName().isBlank() ? d.deviceName()
                : d.externalRef();
    }

    private EdgeReleaseDto signedRelease(long releaseSeq) {
        EdgeReleaseDto release = releases.findAll().stream()
                .filter(r -> r.releaseSeq() == releaseSeq).findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Release mit der Sequenz " + releaseSeq + " ist nicht registriert."));
        if (release.manifest() == null || release.signature() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + release.version() + "' ist nicht signiert. Ohne signiertes "
                            + "Manifest hat ein Gerät nichts, was es gegen seinen "
                            + "Vertrauensanker prüfen könnte - es wird nicht verteilt.");
        }
        return release;
    }

    private RolloutRepository.RolloutRow requireRollout(UUID id) {
        return rollouts.rollout(id).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Rollout nicht gefunden."));
    }

    private String wavesJson(List<WaveSpec> waves) {
        try {
            return json.writeValueAsString(waves);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Wellen-Definition ist nicht lesbar.");
        }
    }

    private List<WaveSpec> parseWaves(String raw) {
        try {
            List<WaveSpec> out = new ArrayList<>();
            for (JsonNode n : json.readTree(raw)) {
                List<UUID> devices = new ArrayList<>();
                for (JsonNode d : n.path("devices")) {
                    devices.add(UUID.fromString(d.asText()));
                }
                out.add(new WaveSpec(n.path("name").asText(), devices));
            }
            return out;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "Die gespeicherte Wellen-Definition ist nicht lesbar.");
        }
    }

    private static String stateLabel(String state) {
        return switch (state) {
            case "paused" -> "pausiert";
            case "halted" -> "eingefroren";
            case "done" -> "abgeschlossen";
            default -> state;
        };
    }
}
