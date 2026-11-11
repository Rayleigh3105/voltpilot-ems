package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.repo.EdgeReleaseRepository;
import com.voltpilot.api.repo.EdgeVersionRepository;
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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Orchestrierung der Verteilung (OTA Stufe 2 „Verteilen", seit dem
 * 26.08.2026 in EINEM Schritt): Release und Geräte wählen, zuweisen - und
 * beobachten, was daraus wird.
 *
 * <p><b>Was hier NICHT passiert: irgendetwas anwenden.</b> Der stärkste Effekt
 * dieser Klasse auf ein Gerät ist eine retained MQTT-Nachricht mit einem
 * signierten Manifest. Ob daraus etwas wird, entscheidet das Gerät selbst
 * (Prüfung gegen die eingebackene Wurzel, danach wendet es an).
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

    /**
     * Die Programme der Edge-Light-Releases (K2). Ohne Spring {@code null}: dann
     * prüft niemand, ob die Programme im Portal liegen.
     */
    private com.voltpilot.api.repo.EdgeLightProgrammRepository lightProgramme;

    @Autowired(required = false)
    void setLightProgramme(com.voltpilot.api.repo.EdgeLightProgrammRepository lightProgramme) {
        this.lightProgramme = lightProgramme;
    }

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private com.voltpilot.api.repo.BoxVerlaufRepository verlauf;

    /** Ohne Repository (Testaufbau) bleibt der Verlauf leer. */
    @Autowired(required = false)
    void setVerlauf(com.voltpilot.api.repo.BoxVerlaufRepository verlauf) {
        this.verlauf = verlauf;
    }

    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

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
     * der Downlink wäre eine Anweisung ohne Beleg. Dazu muss die Box-Art
     * passen ({@link BoxArt}): eine Edge-Light-Box bekommt kein Docker-Release
     * und umgekehrt. Beides sind Eigenschaften des Releases bzw. der Bauart,
     * keine Zustands-Tore - alles Weitere entscheidet das Gerät.
     */
    public void assign(UUID deviceId, long releaseSeq, UUID rolloutId, String actor) {
        RolloutRepository.FleetDeviceRow device = rollouts.fleetDevice(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Gerät nicht gefunden."));
        if (beendete.beendet(device.tenantId())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "kundenbereich_beendet");
        }
        EdgeReleaseDto release = signedRelease(releaseSeq);
        String grund = BoxArt.sperrgrund(boxArt(device), releaseBoxArt(release),
                vertrauenGekreuzt(device), device.loader());
        if (grund != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + release.version() + "' ist diesem Gerät nicht zuweisbar: "
                            + grund);
        }
        requireLightProgramme(release);
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
     *
     * <p>Passt die Box-Art eines gewählten Geräts nicht zum Release
     * ({@link BoxArt}), wird NICHTS zugewiesen (409 mit den betroffenen
     * Geräten und dem Grund) - auch nicht den passenden: ein halb verteilter
     * Auftrag wäre eine Überraschung, ein abgelehnter eine klare Aussage.
     */
    /** Ein angelegter Flotten-Auftrag und die Boxen, die er ausgelassen hat. */
    public record Rollout(UUID id, List<Ausgelassen> ausgelassen) {}

    /** Eine ausgelassene Box: ihr Kundenbereich ist beendet (AP-20, E10 = A) — sie bekommt keine Zuweisung. */
    public record Ausgelassen(UUID deviceId, String label, String kundenbereich) {}

    public Rollout createRollout(long releaseSeq, List<UUID> deviceIds, String actor) {
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
        // Boxen beendeter Kundenbereiche bekommen nichts (AP-20, E10 = A „alles gesperrt"): keine Zeile, keine
        // retained Anweisung. Der Auftrag nennt sie; enthält er nur solche, entsteht keiner.
        List<Ausgelassen> ausgelassen = new ArrayList<>();
        unique.removeIf(d -> {
            RolloutRepository.FleetDeviceRow row = fleet.get(d);
            if (!beendete.beendet(row.tenantId())) {
                return false;
            }
            ausgelassen.add(new Ausgelassen(d, label(row), row.tenantName()));
            return true;
        });
        if (unique.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "kundenbereich_beendet: "
                    + "Alle gewählten Geräte gehören zu beendeten Kundenbereichen - es entsteht keine Aktualisierung.");
        }
        // Box-Art (main, Edge Light): passt sie bei einer der verbliebenen Boxen nicht, wird NICHTS zugewiesen.
        // Ausgelassene Boxen beendeter Kundenbereiche bekommen ohnehin nichts und zählen hier nicht.
        String releaseArt = releaseBoxArt(release);
        Map<String, List<String>> gesperrt = new LinkedHashMap<>();
        for (UUID d : unique) {
            RolloutRepository.FleetDeviceRow row = fleet.get(d);
            String grund = BoxArt.sperrgrund(boxArt(row), releaseArt, vertrauenGekreuzt(row),
                    row.loader());
            if (grund != null) {
                gesperrt.computeIfAbsent(grund, g -> new ArrayList<>())
                        .add(label(row) + " (" + row.siteName() + ")");
            }
        }
        if (!gesperrt.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    boxArtConflict(release.version(), gesperrt));
        }
        requireLightProgramme(release);

        // Vollständig prüfen, BEVOR das Erste geschrieben wird - die Regel, die
        // hier die fehlende Transaktion trägt (siehe Klassen-Javadoc).
        UUID id = UUID.randomUUID();
        rollouts.insertRollout(id, releaseSeq, release.version(), actor);
        rollouts.appendEvent(actor, "rollout_created", id, null,
                release.version() + " → " + unique.size() + " Gerät"
                        + (unique.size() == 1 ? "" : "e")
                        + (ausgelassen.isEmpty() ? "" : ", " + ausgelassen.size() + " ausgelassen (Kundenbereich beendet)"));
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
        return new Rollout(id, List.copyOf(ausgelassen));
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

        Map<UUID, RolloutRepository.TargetRow> targets = targetsById();
        for (RolloutRepository.RolloutRow r : rollouts.activeRollouts()) {
            boolean allDone = true;
            for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
                RolloutStates.Verdict v = rolloutDeviceVerdict(r, fleet.get(rd.deviceId()),
                        targets.get(rd.deviceId()), now);
                if (!v.state().equals(rd.state())) {
                    rollouts.updateRolloutDeviceState(r.id(), rd.deviceId(), v.state(),
                            v.reason());
                    rollouts.appendEvent(SYSTEM_ACTOR, "device_state", r.id(), rd.deviceId(),
                            v.state() + (v.reason() == null ? "" : " - " + v.reason()));
                }
                // „Fertig" heißt: kein Gerät ist mehr unterwegs. Ein Gerät, das
                // fehlgeschlagen ist, hält die Aktualisierung nicht offen - es
                // wird gemeldet, nicht gewartet.
                if (!RolloutStates.isConfirmed(v.state()) && !isTerminalFailure(v.state())
                        && !RolloutStates.ZURUECKGEZOGEN.equals(v.state())) {
                    allDone = false;
                }
            }
            if (allDone) {
                rollouts.setRolloutState(r.id(), "done");
                rollouts.appendEvent(SYSTEM_ACTOR, "rollout_done", r.id(), null, null);
            }
        }

        // Drift-Wächter: eine Zuweisung, die das Gerät nicht (mehr) trägt,
        // wird nach-veröffentlicht. Offline-Geräte holen retained ohnehin nach -
        // dieser Pfad deckt die Fälle, in denen die retained Nachricht selbst
        // fehlt (Broker-Ausfall beim Zuweisen, gelöschter Broker-Zustand).
        for (RolloutRepository.TargetRow t : targets.values()) {
            RolloutRepository.FleetDeviceRow d = fleet.get(t.deviceId());
            if (d == null || beendete.beendet(t.tenantId())) {
                continue; // unbekannt, oder Kundenbereich beendet: nichts nachveröffentlichen
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
                    rel.createdAt(), runningPerRelease.getOrDefault(rel.version(), 0),
                    releaseBoxArt(rel)));
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
        // ⚠ Über BEIDE Linien - nur noch für die KPI älterer Portale (EdgeUpdatesDto.KpiDto).
        String newest = releaseDtos.isEmpty() ? null : releaseDtos.get(0).version();
        // Je Linie (Geräte & Updates S0): gemessen am neuesten Release der EIGENEN
        // Linie, mit derselben Regel wie die Kunden-Box-Seite (EdgeStandVerdict).
        List<EdgeVersionRepository.RegisterEntry> register = releaseDtos.stream()
                .map(r -> new EdgeVersionRepository.RegisterEntry(r.version(), r.releaseSeq(),
                        r.boxArt()))
                .toList();
        Map<String, Linie> perLine = new HashMap<>();
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            RolloutRepository.TargetRow t = targets.get(d.deviceId());
            String assigned = t == null ? null : t.releaseVersion();
            RolloutStates.Verdict v = deviceVerdict(d, assigned, now);
            BoxSicht b = boxSicht(d, v, register, now);
            if (b.linie() != null) {
                perLine.computeIfAbsent(b.linie(), k -> new Linie()).add(d, v, b);
            }
            RolloutRepository.RolloutDeviceRow rd = inRollout.get(d.deviceId());
            rows.add(new EdgeUpdatesDto.FleetRowDto(d.deviceId(), label(d), d.externalRef(),
                    d.siteId(), d.siteName(), d.tenantId(), d.tenantName(), reportedRunning(d),
                    assigned, t == null ? null : t.releaseSeq(),
                    v.state(), v.reason(), d.reportedBlocker(),
                    rd == null ? null : rd.since(), d.reportedAt(),
                    rd == null ? null : rd.rolloutId(), trustDto(d), boxArt(d),
                    b.lebenszeichen(), b.linie(), b.stand(), b.stufe1(),
                    b.ist() == null ? null : b.ist().version(), b.dahinter(), d.currentSince(),
                    fakten(t, d, now), d.geraetModell(), d.geraetArch(), d.loader(), d.loaderStand()));

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
            rolloutDtos.add(rolloutDto(r, fleet, targets, now));
        }
        List<EdgeUpdatesDto.EventDto> journal = new ArrayList<>();
        for (RolloutRepository.EventRow e : rollouts.recentEvents(200)) {
            journal.add(new EdgeUpdatesDto.EventDto(e.id(), e.at(), e.actor(), e.event(),
                    e.rolloutId(), e.deviceId(), e.detail()));
        }
        long nochOffen = inRollout.values().stream()
                .filter(rd -> istNochOffen(rd.state())).count();
        return new EdgeUpdatesDto(releaseDtos, rolloutDtos, rows, journal,
                new EdgeUpdatesDto.KpiDto(known, upToDate, unknown, (int) nochOffen, failed,
                        newest), lines(releaseDtos, perLine));
    }

    /**
     * „Im Rollout" heißt: eine Zuweisung ist begonnen und weder bestätigt noch
     * fehlgeschlagen noch abgelöst (Geräte &amp; Updates G1-Folgefund). Reine
     * Anwesenheit im Fenster der letzten Rollouts (die {@code inRollout}-Karte)
     * zählt NICHT mehr mit - sonst bliebe ein längst bestätigtes Gerät für
     * immer „im Rollout".
     *
     * <p>„Im Update verstummt" zählt hier bewusst NICHT mehr mit - es steht
     * schon in {@code failed} (wie beim Zeilen-Zähler weiter oben); sonst
     * würde dieselbe Box zugleich als „läuft" und als „fehlgeschlagen"
     * auftauchen.
     */
    private static boolean istNochOffen(String state) {
        return !RolloutStates.isConfirmed(state) && !isTerminalFailure(state)
                && !RolloutStates.IM_UPDATE_VERSTUMMT.equals(state)
                && !RolloutStates.ZURUECKGEZOGEN.equals(state);
    }

    /**
     * Die Linien in fester Reihenfolge (Docker-Box, Edge Light); eine Linie ohne
     * Release und ohne Box fehlt. {@code releases} kommt neueste-zuerst.
     */
    private static List<EdgeUpdatesDto.LineDto> lines(List<EdgeUpdatesDto.ReleaseDto> releases,
            Map<String, Linie> perLine) {
        List<EdgeUpdatesDto.LineDto> lines = new ArrayList<>();
        for (String art : List.of(BoxArt.DOCKER, BoxArt.LIGHT)) {
            List<EdgeUpdatesDto.ReleaseDto> derLinie = releases.stream()
                    .filter(r -> art.equals(r.boxArt())).toList();
            EdgeUpdatesDto.ReleaseDto neuestes = derLinie.isEmpty() ? null : derLinie.get(0);
            Linie l = perLine.getOrDefault(art, new Linie());
            if (neuestes == null && l.devices == 0) {
                continue;
            }
            lines.add(new EdgeUpdatesDto.LineDto(art, neuestes == null ? null : neuestes.version(),
                    neuestes == null ? null : neuestes.releaseSeq(), l.devices, l.known, l.upToDate,
                    derLinie.size(), l.stand(), l.versions()));
        }
        return lines;
    }

    /**
     * Was die Seite je Box über ihre Linie sagt (Geräte &amp; Updates G1): die
     * Linie, das letzte Lebenszeichen (die EINE Uhr), Stufe 1, das Register-Release,
     * das sie fährt, wie viele Releases der Linie neuer sind, und ihr Linien-Stand.
     */
    private record BoxSicht(String linie, Instant lebenszeichen, boolean stufe1,
            EdgeVersionRepository.RegisterEntry ist, Integer dahinter, Boolean upToDate,
            String stand) {
    }

    private static BoxSicht boxSicht(RolloutRepository.FleetDeviceRow d, RolloutStates.Verdict v,
            List<EdgeVersionRepository.RegisterEntry> register, Instant now) {
        String running = reportedRunning(d);
        EdgeStandVerdict.Verdict urteil = EdgeStandVerdict.of(running, boxArt(d), register);
        String linie = urteil.linie();
        Instant lebenszeichen = lebenszeichen(d);
        boolean stufe1 = BoxArt.stufe1(linie, vertrauenGekreuzt(d), d.loader());
        EdgeVersionRepository.RegisterEntry ist = linie == null || running == null ? null
                : register.stream().filter(r -> linie.equals(r.boxArt()))
                        .filter(r -> RolloutStates.releaseIsRunning(r.version(), running))
                        .findFirst().orElse(null);
        Integer dahinter = ist == null ? null : (int) register.stream()
                .filter(r -> linie.equals(r.boxArt()) && r.releaseSeq() > ist.releaseSeq())
                .count();
        String stand = LinienStand.of(linie, stufe1, v.state(),
                RolloutStates.offline(lebenszeichen, now), urteil.upToDate());
        return new BoxSicht(linie, lebenszeichen, stufe1, ist, dahinter, urteil.upToDate(), stand);
    }

    /** Die Sammlung einer Linie über die Flotte: Zählung, Stand-Gruppen, Versionsleiter. */
    private static final class Linie {
        int devices;
        int known;
        int upToDate;
        final Map<String, Integer> stand = new LinkedHashMap<>();
        final Map<String, Long> seqJeVersion = new LinkedHashMap<>();
        final Map<String, List<UUID>> boxenJeVersion = new LinkedHashMap<>();

        Linie() {
            for (String s : LinienStand.REIHENFOLGE) {
                stand.put(s, 0);
            }
        }

        void add(RolloutRepository.FleetDeviceRow d, RolloutStates.Verdict v, BoxSicht b) {
            devices++;
            if (!RolloutStates.UNBEKANNT.equals(v.state())) {
                known++;
            }
            if (Boolean.TRUE.equals(b.upToDate())) {
                upToDate++;
            }
            stand.merge(b.stand(), 1, Integer::sum);
            String running = reportedRunning(d);
            String version = b.ist() != null ? b.ist().version() : running;
            if (version != null) {
                seqJeVersion.putIfAbsent(version, b.ist() == null ? null : b.ist().releaseSeq());
                boxenJeVersion.computeIfAbsent(version, k -> new ArrayList<>()).add(d.deviceId());
            }
        }

        Map<String, Integer> stand() {
            return java.util.Collections.unmodifiableMap(stand);
        }

        /** Registrierte Releases neueste zuerst, danach nicht registrierte Stände nach Namen. */
        List<EdgeUpdatesDto.LineVersionDto> versions() {
            return boxenJeVersion.keySet().stream()
                    .sorted(java.util.Comparator
                            .comparing((String v) -> seqJeVersion.get(v) == null)
                            .thenComparing((String v) -> seqJeVersion.get(v) == null ? 0L
                                    : -seqJeVersion.get(v))
                            .thenComparing(v -> v))
                    .map(v -> new EdgeUpdatesDto.LineVersionDto(v, seqJeVersion.get(v),
                            List.copyOf(boxenJeVersion.get(v))))
                    .toList();
        }
    }

    /**
     * Die drei Fakten der aktuellen Anfrage einer Box ({@link UpdateFakten});
     * {@code null} ohne Anfrage.
     */
    private static EdgeUpdatesDto.FaktenDto fakten(RolloutRepository.TargetRow t,
            RolloutRepository.FleetDeviceRow d, Instant now) {
        if (t == null) {
            return null;
        }
        UpdateFakten.Fakten f = UpdateFakten.of(
                new UpdateFakten.Anfrage(t.releaseVersion(), t.releaseSeq(), t.assignedAt(),
                        t.assignedBy()),
                d == null ? null : new UpdateFakten.Meldung(d.reportedTarget(), d.reportedVerdict(),
                        d.targetVerdictAt(), reportedRunning(d), d.currentSince(),
                        d.reportedState(), d.reportedReason(), lebenszeichen(d)),
                now);
        if (f == null) {
            return null;
        }
        return new EdgeUpdatesDto.FaktenDto(
                new EdgeUpdatesDto.AngefragtDto(f.angefragt().release(), f.angefragt().releaseSeq(),
                        f.angefragt().am(), f.angefragt().von()),
                new EdgeUpdatesDto.AngenommenDto(f.angenommen().stand(), f.angenommen().am(),
                        f.angenommen().grund()),
                new EdgeUpdatesDto.BestaetigtDto(f.bestaetigt().stand(), f.bestaetigt().am(),
                        f.bestaetigt().schritt(), f.bestaetigt().grund()));
    }

    /** Das letzte Lebenszeichen einer Box - die EINE Uhr ({@link RolloutStates#lebenszeichen}). */
    private static Instant lebenszeichen(RolloutRepository.FleetDeviceRow d) {
        if (d == null) {
            return null;
        }
        return d.lastSeenAt() != null ? d.lastSeenAt() : d.reportedAt();
    }

    /**
     * Die Eignung jeder Box für EIN signiertes Release (Geräte &amp; Updates G1,
     * der Verteil-Dialog): bereit, wartet (offline), aktuell oder kann nicht -
     * mit Grund ({@link UpdateEignung}).
     *
     * <p>Es stehen die Boxen der Linie des Releases darin und die Boxen
     * unbekannter Art (ein Docker-Release dürfen sie bekommen, ein
     * Edge-Light-Release nicht - beides mit Grund). Boxen der ANDEREN Linie zählt
     * {@code andereLinie}; sie kämen für dieses Release nie in Frage.
     *
     * <p>Rein lesend. Die Sperren sind dieselben, mit denen {@link #assign} und
     * {@link #createRollout} antworten; das Portal fragt an, die Box entscheidet.
     *
     * @throws ResponseStatusException 404 (unbekannt) oder 409 (nicht signiert),
     *         wie beim Zuweisen
     */
    public EdgeUpdatesDto.EignungDto eignung(long releaseSeq, Instant now) {
        EdgeReleaseDto release = signedRelease(releaseSeq);
        String art = releaseBoxArt(release);
        UpdateEignung.Release rel = new UpdateEignung.Release(release.version(),
                release.releaseSeq(), art, UpdateEignung.erlaubtRueckschritt(release.manifest()));
        List<EdgeVersionRepository.RegisterEntry> derLinie = releases.findAll().stream()
                .filter(r -> art.equals(releaseBoxArt(r)))
                .map(r -> new EdgeVersionRepository.RegisterEntry(r.version(), r.releaseSeq(), art))
                .toList();
        List<EdgeUpdatesDto.EignungBoxDto> boxen = new ArrayList<>();
        int andereLinie = 0;
        for (RolloutRepository.FleetDeviceRow d : rollouts.fleetDevices()) {
            String geraetArt = boxArt(d);
            if (geraetArt != null && !geraetArt.equals(art)) {
                andereLinie++;
                continue;
            }
            String running = reportedRunning(d);
            EdgeVersionRepository.RegisterEntry ist = running == null ? null : derLinie.stream()
                    .filter(r -> RolloutStates.releaseIsRunning(r.version(), running))
                    .findFirst().orElse(null);
            Instant lebenszeichen = lebenszeichen(d);
            UpdateEignung.Urteil u = UpdateEignung.of(rel, new UpdateEignung.Box(geraetArt,
                    vertrauenGekreuzt(d), running, ist == null ? null : ist.version(),
                    ist == null ? null : ist.releaseSeq(),
                    lebenszeichen == null || RolloutStates.offline(lebenszeichen, now),
                    beendete.beendet(d.tenantId()), d.loader()));
            boxen.add(new EdgeUpdatesDto.EignungBoxDto(d.deviceId(), label(d), d.externalRef(),
                    d.siteName(), d.tenantName(), running, u.gruppe(), u.grund(), lebenszeichen));
        }
        return new EdgeUpdatesDto.EignungDto(release.releaseSeq(), release.version(), art,
                List.copyOf(boxen), andereLinie);
    }

    /**
     * Die Release-Seite (Geräte &amp; Updates G4): Inhalt aus dem signierten
     * Manifest, „Was ist neu" aus dem Register, die Programme im Portal (Edge
     * Light), wo es läuft und wann es verteilt wurde. Rein lesend.
     *
     * @throws ResponseStatusException 404 für ein unbekanntes Release
     */
    public EdgeUpdatesDto.ReleaseSeiteDto releaseSeite(long releaseSeq, Instant now) {
        List<EdgeReleaseDto> alle = releases.findAll();
        EdgeReleaseDto release = alle.stream().filter(r -> r.releaseSeq() == releaseSeq)
                .findFirst().orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Release mit der Sequenz " + releaseSeq + " ist nicht registriert."));
        String art = releaseBoxArt(release);
        boolean signiert = release.manifest() != null && release.signature() != null;

        List<EdgeUpdatesDto.ReleaseTeilDto> inhalt = new ArrayList<>();
        List<EdgeUpdatesDto.ReleaseProgrammDto> programme = new ArrayList<>();
        if (signiert) {
            try {
                ReleaseManifest m = ReleaseManifest.read(release.manifest());
                for (ReleaseManifest.Artifact a : m.artifacts()) {
                    ReleaseManifest.Program p = a.arch() == null ? null : m.program(a.arch()).orElse(null);
                    inhalt.add(new EdgeUpdatesDto.ReleaseTeilDto(a.type(), a.name(), a.arch(),
                            p == null ? null : p.size(), p == null ? null : p.gzSize()));
                }
                if (BoxArt.LIGHT.equals(art) && lightProgramme != null) {
                    Map<String, com.voltpilot.api.repo.EdgeLightProgrammRepository.Stand> da = new HashMap<>();
                    lightProgramme.alle(release.releaseSeq()).forEach(st -> da.put(st.arch(), st));
                    for (ReleaseManifest.Program p : m.programs()) {
                        var st = da.get(p.arch());
                        programme.add(new EdgeUpdatesDto.ReleaseProgrammDto(p.arch(), p.gzSize(),
                                st == null ? 0L : st.laenge(), st != null && st.fertig()));
                    }
                }
            } catch (IllegalArgumentException e) {
                // Ein Manifest, das der Leser nicht kennt, nennt keinen Inhalt -
                // die Box prüft es ohnehin selbst.
                log.debug("Release {}: Manifest-Inhalt nicht lesbar: {}", release.version(), e.getMessage());
            }
        }

        List<RolloutRepository.FleetDeviceRow> fleet = rollouts.fleetDevices();
        List<EdgeVersionRepository.RegisterEntry> register = alle.stream()
                .map(r -> new EdgeVersionRepository.RegisterEntry(r.version(), r.releaseSeq(),
                        releaseBoxArt(r)))
                .toList();
        List<UUID> laeuftAuf = new ArrayList<>();
        int boxenDerLinie = 0;
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            String running = reportedRunning(d);
            if (art.equals(EdgeStandVerdict.of(running, boxArt(d), register).linie())) {
                boxenDerLinie++;
            }
            if (RolloutStates.releaseIsRunning(release.version(), running)) {
                laeuftAuf.add(d.deviceId());
            }
        }

        Map<UUID, RolloutRepository.TargetRow> targets = targetsById();
        List<EdgeUpdatesDto.VerteiltDto> verteilt = new ArrayList<>();
        for (RolloutRepository.RolloutRow r : rollouts.allRollouts()) {
            if (r.releaseSeq() != releaseSeq) {
                continue;
            }
            EdgeUpdatesDto.RolloutDto dto = rolloutDto(r, fleet, targets, now);
            verteilt.add(new EdgeUpdatesDto.VerteiltDto(r.id(), r.state(), r.createdBy(),
                    r.createdAt(), dto.total(), dto.confirmed(), dto.failed()));
        }

        return new EdgeUpdatesDto.ReleaseSeiteDto(release.releaseSeq(), release.version(), art,
                signiert, release.signingKeyId(), release.createdAt(), release.targetCommit(),
                release.notes(), release.aenderungen(),
                UpdateEignung.erlaubtRueckschritt(release.manifest()), minFromSeq(release.manifest()),
                List.copyOf(inhalt), List.copyOf(programme), List.copyOf(laeuftAuf), boxenDerLinie,
                List.copyOf(verteilt));
    }

    /** {@code min_from_seq} des signierten Manifests, sonst {@code null}. */
    private Long minFromSeq(String manifest) {
        if (manifest == null || manifest.isBlank()) {
            return null;
        }
        try {
            JsonNode n = json.readTree(manifest).path("min_from_seq");
            return n.canConvertToLong() ? n.asLong() : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Der Verlauf EINER Box (Geräte &amp; Updates G3): Portal-Handlungen und
     * Box-Meldungen, neueste zuerst ({@link BoxVerlauf}).
     *
     * @throws ResponseStatusException 404, wenn es das Gerät nicht gibt
     */
    public EdgeUpdatesDto.VerlaufDto verlauf(UUID deviceId, int limit) {
        rollouts.fleetDevice(deviceId).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Gerät nicht gefunden."));
        List<EdgeUpdatesDto.VerlaufEintragDto> eintraege = new ArrayList<>();
        if (verlauf != null) {
            for (com.voltpilot.api.repo.BoxVerlaufRepository.Zeile z
                    : verlauf.verlauf(deviceId, Math.max(1, Math.min(limit, 500)))) {
                BoxVerlauf.Eintrag e = BoxVerlauf.of(z);
                if (e != null) {
                    eintraege.add(new EdgeUpdatesDto.VerlaufEintragDto(e.am(), e.quelle(), e.art(),
                            e.release(), e.vorher(), e.grund(), e.von(), e.rolloutId()));
                }
            }
        }
        return new EdgeUpdatesDto.VerlaufDto(deviceId, List.copyOf(eintraege));
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
                    p == null ? null : p.provisionedAt(), trustDto(d), boxArt(d),
                    d.geraetModell(), d.geraetArch(), d.loader(), d.loaderStand()));
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
                    null, null, null, null, null, true, p.note(), p.provisionedAt(), null,
                    null, null, null, null, null));
        }
        return new AdminDevicesDto(rows);
    }

    private EdgeUpdatesDto.RolloutDto rolloutDto(RolloutRepository.RolloutRow r,
            List<RolloutRepository.FleetDeviceRow> fleet,
            Map<UUID, RolloutRepository.TargetRow> targets, Instant now) {
        Map<UUID, RolloutRepository.FleetDeviceRow> byId = new HashMap<>();
        for (RolloutRepository.FleetDeviceRow d : fleet) {
            byId.put(d.deviceId(), d);
        }
        List<EdgeUpdatesDto.RolloutDeviceDto> devices = new ArrayList<>();
        int confirmed = 0;
        int failed = 0;
        for (RolloutRepository.RolloutDeviceRow rd : rollouts.devicesOf(r.id())) {
            RolloutRepository.FleetDeviceRow d = byId.get(rd.deviceId());
            RolloutStates.Verdict v = rolloutDeviceVerdict(r, d, targets.get(rd.deviceId()), now);
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

    private Map<UUID, RolloutRepository.TargetRow> targetsById() {
        Map<UUID, RolloutRepository.TargetRow> map = new HashMap<>();
        for (RolloutRepository.TargetRow t : rollouts.allTargets()) {
            map.put(t.deviceId(), t);
        }
        return map;
    }

    /**
     * Der Zustand eines Geräts IN EINER Verteilung: gemessen an deren Release -
     * außer die Anfrage dieser Verteilung gilt nicht mehr (Geräte &amp; Updates G2,
     * Nebenbefund 4 des Konzepts). Wurde sie zurückgezogen oder durch eine
     * andere Anfrage abgelöst, und fährt die Box das Release der Verteilung
     * nicht, heißt sie {@link RolloutStates#ZURUECKGEZOGEN} und hält die
     * Verteilung nicht mehr offen; sonst blieb ein Lauf dauerhaft „aktiv".
     */
    static RolloutStates.Verdict rolloutDeviceVerdict(RolloutRepository.RolloutRow r,
            RolloutRepository.FleetDeviceRow d, RolloutRepository.TargetRow aktuell, Instant now) {
        RolloutStates.Verdict v = deviceVerdict(d, r.releaseVersion(), now);
        boolean giltNoch = aktuell != null && r.id().equals(aktuell.rolloutId());
        if (giltNoch || d == null || RolloutStates.isConfirmed(v.state())) {
            return v;
        }
        return new RolloutStates.Verdict(RolloutStates.ZURUECKGEZOGEN, aktuell == null
                ? "Die Anfrage wurde zurückgezogen."
                : "Abgelöst durch eine neuere Anfrage (" + aktuell.releaseVersion() + ").");
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

    /** Die Box-Art aus der letzten Meldung - die Regel steht in {@link BoxArt}. */
    private static String boxArt(RolloutRepository.FleetDeviceRow d) {
        return BoxArt.ofDevice(d.reportedBackend(), d.reportedVersion(), d.reportedCurrent());
    }

    /** Wurzel und geprüftes Vertrauens-Set gemeldet? Die Regel steht in {@link BoxArt}. */
    private static boolean vertrauenGekreuzt(RolloutRepository.FleetDeviceRow d) {
        return BoxArt.vertrauenGekreuzt(d.rootKeyIds(), d.trustSetKeyIds());
    }

    private static String releaseBoxArt(EdgeReleaseDto release) {
        return BoxArt.ofRelease(release.version(), release.manifest());
    }

    /**
     * Der 409-Satz eines Auftrags mit unpassenden Geräten: je Grund die
     * betroffenen Geräte (höchstens drei beim Namen), damit der Betreiber weiß,
     * WELCHE er abwählen muss.
     */
    static String boxArtConflict(String version, Map<String, List<String>> gesperrt) {
        int n = gesperrt.values().stream().mapToInt(List::size).sum();
        StringBuilder msg = new StringBuilder("Release '").append(version)
                .append("' passt nicht zu ").append(n == 1 ? "einem" : String.valueOf(n))
                .append(" der gewählten Geräte - es wurde nichts zugewiesen.");
        for (Map.Entry<String, List<String>> e : gesperrt.entrySet()) {
            List<String> names = e.getValue();
            String shown = String.join(", ", names.subList(0, Math.min(3, names.size())));
            if (names.size() > 3) {
                shown += " und " + (names.size() - 3) + " weitere";
            }
            msg.append(' ').append(shown).append(": ").append(e.getKey());
        }
        return msg.toString();
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
     * Beleg. Sie ist eine Eigenschaft des RELEASE, nicht des Geräts; die
     * zweite Vorbedingung, die passende Box-Art, steht in {@link BoxArt}.
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

    /**
     * Ein Edge-Light-Release ist erst zuweisbar, wenn JEDES Programm seines
     * Manifests fertig und geprüft im Portal liegt (K2): die Box lädt es von
     * dort, und eine Zuweisung, deren Download ins Leere geht, endete nur in
     * „fehlgeschlagen". Der Release-Lauf lädt die Programme gleich nach dem
     * Eintrag ins Register hoch.
     */
    private void requireLightProgramme(EdgeReleaseDto release) {
        if (lightProgramme == null || !BoxArt.LIGHT.equals(releaseBoxArt(release))) {
            return;
        }
        List<String> fehlen;
        try {
            java.util.Set<String> fertig = lightProgramme.fertigeArchs(release.releaseSeq());
            fehlen = ReleaseManifest.read(release.manifest()).programs().stream()
                    .map(ReleaseManifest.Program::arch).filter(a -> !fertig.contains(a)).toList();
        } catch (ReleaseManifest.InvalidManifestException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + release.version() + "' hat kein lesbares Manifest: " + e.getMessage());
        }
        if (!fehlen.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + release.version() + "' ist noch nicht verteilbar: die Programme fuer "
                            + String.join(", ", fehlen) + " liegen noch nicht vollstaendig im Portal.");
        }
    }
}
