package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.EdgeReleaseRepository;
import com.voltpilot.api.repo.RolloutRepository;
import com.voltpilot.api.web.dto.AdminDevicesDto;
import com.voltpilot.api.web.dto.EdgeReleaseDto;
import com.voltpilot.api.web.dto.EdgeUpdatesDto;
import com.voltpilot.api.web.dto.ProvisionedDeviceDto;
import java.security.SecureRandom;
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

    // ── Zuweisen ─────────────────────────────────────────────────────────

    /**
     * Einem Gerät ein Release zuweisen.
     *
     * <p>Nur ein SIGNIERTES Release ist zuweisbar: ohne Manifest-Bytes gäbe es
     * nichts, was das Gerät gegen seine eingebackene Wurzel prüfen könnte, und
     * der Downlink wäre eine Anweisung ohne Beleg. Das ist die EINE Prüfung,
     * die diese Klasse noch macht - alles Weitere entscheidet das Gerät.
     */
    public void assign(UUID deviceId, long releaseSeq, UUID rolloutId, String actor) {
        RolloutRepository.FleetDeviceRow device = rollouts.fleetDevice(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Gerät nicht gefunden."));
        EdgeReleaseDto release = signedRelease(releaseSeq);
        rollouts.upsertTarget(deviceId, releaseSeq, release.version(), rolloutId, actor);
        rollouts.appendEvent(actor, "target_assigned", rolloutId, deviceId, release.version());
        publishTarget(device, release.version(), release.releaseSeq(), rolloutId,
                release.manifest(), release.signature(), Instant.now());
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

    // ── Die EINE Handlung: Release wählen, Geräte wählen, fertig ─────────

    /**
     * Eine Aktualisierung starten: EIN Release, die gewählten Geräte, sofort.
     *
     * <p><b>Das ist der ganze Fluss</b> (Captain-Order 26.08.2026). Es gibt
     * keine Wellen, keinen Ring, kein Bake-Kriterium und keinen zweiten Knopf:
     * jedes gewählte Gerät bekommt seine Zuweisung im selben Aufruf, prüft das
     * signierte Manifest selbst gegen seine eingebackene Wurzel und wendet es
     * an. Diese Klasse erfährt davon nur noch durch den gemeldeten Ist.
     *
     * <p>Mehrere Aktualisierungen dürfen NEBENEINANDER laufen - der frühere
     * „höchstens einer bewegt die Flotte"-Riegel war ein Tor, das einen legitimen
     * zweiten Auftrag blockierte. Eindeutig ist, was zählt: je GERÄT gibt es
     * genau eine Zuweisung (der Primärschlüssel von {@code device_update_target}).
     */
    public UUID createRollout(long releaseSeq, List<UUID> deviceIds, String actor) {
        EdgeReleaseDto release = signedRelease(releaseSeq);
        if (deviceIds == null || deviceIds.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Wählen Sie mindestens ein Gerät aus.");
        }
        Map<UUID, RolloutRepository.FleetDeviceRow> fleet = fleetById();
        LinkedHashSet<UUID> unique = new LinkedHashSet<>();
        for (UUID d : deviceIds) {
            if (!fleet.containsKey(d)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Unbekanntes Gerät: " + d);
            }
            unique.add(d);
        }

        // Vollständig prüfen, BEVOR das Erste geschrieben wird - die Regel, die
        // hier die fehlende Transaktion trägt (siehe Klassen-Javadoc).
        UUID id = UUID.randomUUID();
        rollouts.insertRollout(id, releaseSeq, release.version(), actor);
        rollouts.appendEvent(actor, "rollout_created", id, null,
                release.version() + " → " + unique.size() + " Gerät"
                        + (unique.size() == 1 ? "" : "e"));
        for (UUID deviceId : unique) {
            RolloutRepository.FleetDeviceRow d = fleet.get(deviceId);
            // Der NAMENS-Schnappschuss entsteht hier, nicht beim Lesen: die
            // Zuweisung ist ein historisches Ereignis, also muss auch ihre
            // Beschriftung einen späteren Unclaim überleben (sonst fällt die
            // Zeile auf eine nackte UUID zurück).
            rollouts.insertRolloutDevice(id, deviceId, RolloutStates.AUSSTEHEND, null,
                    label(d), d.siteName());
            rollouts.upsertTarget(deviceId, releaseSeq, release.version(), id, actor);
            rollouts.appendEvent(actor, "target_assigned", id, deviceId, release.version());
            publishTarget(d, release.version(), release.releaseSeq(), id,
                    release.manifest(), release.signature(), Instant.now());
        }
        return id;
    }

    // ── Der Wächter: Zustände fortschreiben, Drift nachliefern ──────────

    /**
     * Ein Durchlauf des Wächters: den abgeleiteten Zustand jedes Geräts der
     * laufenden Aktualisierungen fortschreiben und Zuweisungen
     * nach-veröffentlichen, deren retained Nachricht offenbar nicht (mehr)
     * wirkt.
     *
     * <p><b>Ein Fehlschlag hält NICHTS mehr an</b> (der frühere Auto-Halt, D4).
     * Er ist Information: die Zeile des betroffenen Geräts wird rot und trägt
     * ihren Grund, die übrigen Geräte laufen weiter. Ein Gerät, das ein Release
     * zurückgenommen hat, versucht es von selbst nicht erneut - dafür genügt
     * seine eigene Runaway-Bremse ({@code otaapply.FailedRelease}), und ein
     * erneutes „Aktualisieren" im Portal löst sie.
     *
     * <p>Idempotent und ohne Nebenwirkung, wenn nichts zu tun ist.
     */
    public void reconcile(Instant now) {
        Map<UUID, RolloutRepository.FleetDeviceRow> fleet = fleetById();

        for (RolloutRepository.RolloutRow r : rollouts.activeRollouts()) {
            boolean allDone = true;
            for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
                RolloutStates.Verdict v = deviceVerdict(fleet.get(rd.deviceId()),
                        r.releaseVersion(), now);
                if (!v.state().equals(rd.state())) {
                    rollouts.updateRolloutDeviceState(r.id(), rd.deviceId(), v.state(),
                            v.reason());
                    rollouts.appendEvent(SYSTEM_ACTOR, "device_state", r.id(), rd.deviceId(),
                            v.state() + (v.reason() == null ? "" : " - " + v.reason()));
                }
                // „Fertig" heißt: kein Gerät ist mehr unterwegs. Ein Gerät, das
                // fehlgeschlagen ist, hält die Aktualisierung nicht offen - es
                // wird gemeldet, nicht gewartet.
                if (!RolloutStates.isConfirmed(v.state()) && !isTerminalFailure(v.state())) {
                    allDone = false;
                }
            }
            if (allDone) {
                rollouts.setRolloutState(r.id(), "done", null);
                rollouts.appendEvent(SYSTEM_ACTOR, "rollout_done", r.id(), null, null);
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
            if (publishTarget(d, t.releaseVersion(), t.releaseSeq(), t.rolloutId(),
                    t.manifest(), t.signature(), t.assignedAt())) {
                rollouts.appendEvent(SYSTEM_ACTOR, "target_republished", t.rolloutId(),
                        t.deviceId(), t.releaseVersion());
            }
        }
    }

    /** Ein Endzustand, aus dem sich von selbst nichts mehr bewegt. */
    private static boolean isTerminalFailure(String state) {
        return RolloutStates.FEHLGESCHLAGEN.equals(state)
                || RolloutStates.ZURUECKGEROLLT.equals(state)
                || RolloutStates.ZURUECKGESTELLT.equals(state);
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
        // Angezeigt wird die JÜNGSTE Aktualisierung, auch eine abgeschlossene:
        // sie darf nicht in dem Augenblick von der Seite verschwinden, in dem
        // sie fertig wird.
        List<RolloutRepository.RolloutRow> recent = rollouts.recentRollouts(5);

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

        // Welche Geräte gerade in IRGENDEINER der jüngsten Verteilungen stehen.
        // Die jüngste Zuweisung gewinnt (die Liste kommt neueste-zuerst), damit
        // ein Gerät, das eine zweite Aktualisierung bekommen hat, unter ihr
        // gezählt wird.
        Map<UUID, RolloutRepository.RolloutDeviceRow> inRollout = new HashMap<>();
        for (RolloutRepository.RolloutRow r : recent) {
            for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
                inRollout.putIfAbsent(rd.deviceId(), rd);
            }
        }
        List<EdgeUpdatesDto.FleetRowDto> rows = new ArrayList<>();
        int known = 0;
        int upToDate = 0;
        int unknown = 0;
        int failed = 0;
        String newest = releaseDtos.isEmpty() ? null : releaseDtos.get(0).version();
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            RolloutRepository.TargetRow t = targets.get(d.deviceId());
            String assigned = t == null ? null : t.releaseVersion();
            RolloutStates.Verdict v = deviceVerdict(d, assigned, now);
            RolloutRepository.RolloutDeviceRow rd = inRollout.get(d.deviceId());
            rows.add(new EdgeUpdatesDto.FleetRowDto(d.deviceId(), label(d), d.externalRef(),
                    d.siteId(), d.siteName(), d.tenantId(), d.tenantName(), reportedRunning(d),
                    assigned, t == null ? null : t.releaseSeq(),
                    v.state(), v.reason(), d.reportedBlocker(),
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
            if (isTerminalFailure(v.state())
                    || RolloutStates.IM_UPDATE_VERSTUMMT.equals(v.state())) {
                failed++;
            }
        }

        List<EdgeUpdatesDto.RolloutDto> rolloutDtos = new ArrayList<>();
        for (RolloutRepository.RolloutRow r : recent) {
            rolloutDtos.add(rolloutDto(r, fleet, now));
        }
        List<EdgeUpdatesDto.EventDto> journal = new ArrayList<>();
        for (RolloutRepository.EventRow e : rollouts.recentEvents(200)) {
            journal.add(new EdgeUpdatesDto.EventDto(e.id(), e.at(), e.actor(), e.event(),
                    e.rolloutId(), e.deviceId(), e.detail()));
        }
        return new EdgeUpdatesDto(releaseDtos, rolloutDtos, rows, journal,
                new EdgeUpdatesDto.KpiDto(known, upToDate, unknown, inRollout.size(), failed,
                        newest));
    }

    /**
     * Das INVENTAR aller Geräte über den ganzen Lebenszyklus (UX-Konzept §4,
     * E1/E4) - die Vereinigung von Aufkleber-Registry und echter Flotte,
     * verbunden über die Referenz.
     *
     * <p>Es entsteht KEINE neue Wahrheit: die Zustände kommen aus derselben
     * {@link #deviceVerdict} wie die Flotten-Zeile, die Registry-Felder aus
     * derselben Abfrage wie die Registry-Seite.
     */
    public AdminDevicesDto devices(List<ProvisionedDeviceDto> registry, Instant now) {
        Map<UUID, RolloutRepository.TargetRow> targets = new HashMap<>();
        for (RolloutRepository.TargetRow t : rollouts.allTargets()) {
            targets.put(t.deviceId(), t);
        }
        Map<String, ProvisionedDeviceDto> byRef = new HashMap<>();
        for (ProvisionedDeviceDto p : registry) {
            byRef.put(p.externalRef(), p);
        }

        List<AdminDevicesDto.DeviceRowDto> rows = new ArrayList<>();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        for (RolloutRepository.FleetDeviceRow d : rollouts.fleetDevices()) {
            RolloutRepository.TargetRow t = targets.get(d.deviceId());
            RolloutStates.Verdict v = deviceVerdict(d, t == null ? null : t.releaseVersion(), now);
            ProvisionedDeviceDto p = byRef.get(d.externalRef());
            seen.add(d.externalRef());
            rows.add(new AdminDevicesDto.DeviceRowDto(d.deviceId(), d.externalRef(), label(d),
                    d.siteId(), d.siteName(), d.tenantId(), d.tenantName(),
                    p == null ? null : p.kind(), reportedRunning(d),
                    t == null ? null : t.releaseVersion(), t == null ? null : t.releaseSeq(),
                    v.state(), v.reason(), d.reportedBlocker(), d.lastSeenAt(), d.reportedAt(),
                    p != null, p == null ? null : p.note(),
                    p == null ? null : p.provisionedAt(), trustDto(d)));
        }
        // Danach die gedruckten IDs, die noch KEIN Gerät sind. Sie tragen
        // bewusst keinen Zustand: über eine ID, die sich nie gemeldet hat, ist
        // nichts abzuleiten - „unbekannt" wäre schon eine Behauptung über ein
        // Gerät, das es noch gar nicht gibt.
        for (ProvisionedDeviceDto p : registry) {
            if (seen.contains(p.externalRef())) {
                continue;
            }
            rows.add(new AdminDevicesDto.DeviceRowDto(null, p.externalRef(), null, null, null,
                    null, null, p.kind(), null, null, null,
                    null, null, null, null, null, true, p.note(), p.provisionedAt(), null));
        }
        return new AdminDevicesDto(rows);
    }

    private EdgeUpdatesDto.RolloutDto rolloutDto(RolloutRepository.RolloutRow r,
            List<RolloutRepository.FleetDeviceRow> fleet, Instant now) {
        Map<UUID, RolloutRepository.FleetDeviceRow> byId = new HashMap<>();
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            byId.put(d.deviceId(), d);
        }
        List<EdgeUpdatesDto.RolloutDeviceDto> devices = new ArrayList<>();
        int confirmed = 0;
        int failed = 0;
        for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
            RolloutRepository.FleetDeviceRow d = byId.get(rd.deviceId());
            RolloutStates.Verdict v = deviceVerdict(d, r.releaseVersion(), now);
            if (RolloutStates.isConfirmed(v.state())) {
                confirmed++;
            }
            if (isTerminalFailure(v.state())
                    || RolloutStates.IM_UPDATE_VERSTUMMT.equals(v.state())) {
                failed++;
            }
            devices.add(new EdgeUpdatesDto.RolloutDeviceDto(rd.deviceId(),
                    d == null ? rd.deviceRef() : label(d),
                    d == null ? rd.siteName() : d.siteName(),
                    d == null ? null : d.tenantName(),
                    v.state(), v.reason(), rd.since(), d == null));
        }
        return new EdgeUpdatesDto.RolloutDto(r.id(), r.releaseVersion(), r.releaseSeq(),
                r.state(), r.createdBy(), r.createdAt(), devices.size(), confirmed, failed,
                devices);
    }

    private static EdgeUpdatesDto.TrustDto trustDto(RolloutRepository.FleetDeviceRow d) {
        if (d.rootKeyIds() == null && d.trustSetKeyIds() == null
                && d.trustSetGeneratedAt() == null && d.trustSetError() == null) {
            return null;
        }
        return new EdgeUpdatesDto.TrustDto(splitKeyIds(d.rootKeyIds()),
                splitKeyIds(d.trustSetKeyIds()), d.trustSetGeneratedAt(), d.trustSetError());
    }

    private static List<String> splitKeyIds(String raw) {
        if (raw == null) {
            return null;
        }
        return raw.isEmpty() ? List.of() : List.of(raw.split(","));
    }

    private boolean publishTarget(RolloutRepository.FleetDeviceRow d, String version, long seq,
            UUID rolloutId, String manifest, String signature, Instant assignedAt) {
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
                rolloutId, manifest, signature, assignedAt);
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

    private static String reportedRunning(RolloutRepository.FleetDeviceRow d) {
        return d.reportedCurrent() != null ? d.reportedCurrent() : d.reportedVersion();
    }

    private static String label(RolloutRepository.FleetDeviceRow d) {
        return d.deviceName() != null && !d.deviceName().isBlank()
                ? d.deviceName() : d.externalRef();
    }

    /**
     * Nur ein SIGNIERTES Release ist verteilbar.
     *
     * <p>Ohne Manifest-Bytes hat ein Gerät nichts, was es gegen seine
     * eingebackene Wurzel prüfen könnte - der Downlink wäre eine Anweisung ohne
     * Beleg. Das ist die einzige verbliebene Vorbedingung dieser Klasse, und
     * sie ist eine Eigenschaft des RELEASE, nicht des Geräts.
     */
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
}
