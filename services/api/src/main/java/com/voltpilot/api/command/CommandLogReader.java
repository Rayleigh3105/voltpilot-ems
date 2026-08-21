package com.voltpilot.api.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.registerwrite.RegisterWriteEvents;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.ControlStatusRepository;
import com.voltpilot.api.repo.CurtailmentStatusRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.web.dto.CommandHistoryDto;
import com.voltpilot.api.web.dto.CommandHistoryDto.CommandDetailDto;
import com.voltpilot.api.web.dto.CommandHistoryDto.CommandEntryDto;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die LESESICHT des Kommando-Verlaufs: aus dem Speicher plus den beiden
 * bestehenden Momentaufnahmen wird die eine Antwort, aus der die Befehle-Seite
 * ihren Kopf, ihr „Gerade jetzt", ihr „Grenzen &amp; Wächter"-Panel und ihren
 * Tages-Film baut.
 *
 * <p>Sie ENTSCHEIDET nichts über den Zustand: die Zustandswörter kommen aus dem
 * Speicher, die Live-Blöcke aus den DTOs, die die Cockpit-Flächen ohnehin lesen.
 * Die deutschen Sätze bildet die reine Portal-Schicht - das
 * {@code RolloutStates}-Konsumenten-Muster.
 */
@Service
public class CommandLogReader {

    /**
     * Der Deckel je Abfrage. Er greift am NEUESTEN Ende (das Repository sortiert
     * absteigend und dreht danach um), damit ein voller Tag nie seine letzten
     * Stunden verliert; die Fläche SAGT, dass gekappt wurde.
     */
    static final int MAX_ENTRIES = 500;

    /**
     * Der Deckel des VIERTEN Stroms. Er ist klein, weil ein Einmal-Schreibvorgang
     * ein seltenes Ereignis ist - und er ist ein EIGENER Deckel, damit eine
     * gesprächige Halteperioden-Liste die wenigen Register-Zeilen nie verdrängt.
     */
    static final int MAX_REGISTER_ENTRIES = 50;

    /** Das Strom-Wort des vierten Stroms (Konzept vp-reg-schreib-konzept-p8 §2.5). */
    static final String STREAM_REGISTER = "register";
    /** Die Ereignis-Art seiner Zeilen - ein Punkt-Ereignis, keine Halteperiode. */
    static final String EVENT_REGISTER_WRITE = "register_geschrieben";

    private final CommandLogRepository store;
    private final EntityRegistryRepository entities;
    private final ControlStatusRepository controlStatus;
    private final CurtailmentStatusRepository curtailmentStatus;
    private final RegisterWriteEventRepository registerWrites;
    private static final ObjectMapper SHARED = new ObjectMapper();

    public CommandLogReader(CommandLogRepository store, EntityRegistryRepository entities,
            ControlStatusRepository controlStatus, CurtailmentStatusRepository curtailmentStatus,
            RegisterWriteEventRepository registerWrites) {
        this.store = store;
        this.entities = entities;
        this.controlStatus = controlStatus;
        this.curtailmentStatus = curtailmentStatus;
        this.registerWrites = registerWrites;
    }

    /**
     * Der Verlauf einer Anlage im Fenster {@code [from, to)} - auf Wunsch auf
     * EINE Komponente eingegrenzt.
     *
     * @param entityId die Komponente, oder {@code null} für die ganze Anlage.
     *                 Eine Komponente, die es in dieser Anlage nicht gibt, ist
     *                 {@code null} in der Antwort - der Aufrufer entscheidet, ob
     *                 das ein 404 wird.
     */
    public CommandHistoryDto forSite(UUID siteId, UUID entityId, Instant from, Instant to) {
        return forSite(siteId, entityId, null, from, to);
    }

    /**
     * Derselbe Verlauf, auf Wunsch auf EIN GERÄT eingegrenzt (Anlagen-Zentrale
     * Stufe 1, §7.4).
     *
     * <p>Komponente und Gerät schließen sich aus - der Aufrufer lässt gar nicht
     * beides zu; hier gewinnt die Komponente, weil sie die engere Frage ist.
     *
     * @param scope das aufgelöste Gerät, oder {@code null} für die ganze Anlage.
     */
    public CommandHistoryDto forSite(UUID siteId, UUID entityId, DeviceScopes.Scope scope,
            Instant from, Instant to) {
        EntityRow entity = entityId == null ? null : entities.entityForSite(siteId, entityId);
        UUID deviceId = entity == null ? null : entity.deviceId();
        List<CommandLogRepository.Row> rows = scope == null
                ? store.entries(siteId, entityId, deviceId, from, to, MAX_ENTRIES + 1)
                : store.entriesForDevice(siteId, scope.deviceId(), scope.entityIds(), from, to,
                        MAX_ENTRIES + 1);
        boolean truncated = rows.size() > MAX_ENTRIES;
        if (truncated) {
            // Gekappt wird am ÄLTESTEN Ende: die Liste kommt aufsteigend an, die
            // jüngsten Zeilen sind die, die niemand verlieren will.
            rows = rows.subList(rows.size() - MAX_ENTRIES, rows.size());
        }
        // Der vierte Strom hat seinen EIGENEN Deckel, damit eine gespraechige
        // Halteperioden-Liste die wenigen Register-Zeilen nie verdraengt - und
        // greift er, sagt dieselbe `truncated`-Fahne es.
        List<RegisterWriteEventRepository.Entry> writes = scope == null
                ? registerWrites.between(siteId, deviceId, from, to, MAX_REGISTER_ENTRIES + 1)
                : scope.box()
                        // Die BOX trägt ihre ANLAGENWEITEN Vorgänge (primäre
                        // Lane, freie Adresse); ein Vorgang MIT Komponente steht
                        // auf der Seite ihres Geräts (Ziel-Attribution).
                        ? registerWrites.betweenForBox(siteId, scope.deviceId(), from, to,
                                MAX_REGISTER_ENTRIES + 1)
                        : registerWrites.betweenForEntities(siteId, scope.entityIds(), from, to,
                                MAX_REGISTER_ENTRIES + 1);
        if (writes.size() > MAX_REGISTER_ENTRIES) {
            // Gekappt wird am AELTESTEN Ende (die Liste kommt neueste-zuerst).
            writes = writes.subList(0, MAX_REGISTER_ENTRIES);
            truncated = true;
        }
        List<CommandEntryDto> entries = new ArrayList<>(
                rows.stream().map(CommandLogReader::toDto).toList());
        entries.addAll(registerEntries(writes));
        // Chronologisch, damit der Film EINE Zeitachse hat; ein fehlender Beginn
        // (den es hier nicht geben kann) sortiert ans Ende statt zu werfen.
        entries.sort(Comparator.comparing(CommandEntryDto::startedAt,
                Comparator.nullsLast(Comparator.naturalOrder())));
        return new CommandHistoryDto(store.recordingSince(siteId).orElse(null),
                CommandLog.ACCURACY_SECONDS, from, to, entityId,
                entity == null ? null : entity.label(), scope == null ? null : scope.ref(),
                scope == null ? null : scope.box(),
                scope != null ? scope.writes() : writes(entity), truncated,
                entries,
                controlStatus.latestForSite(siteId).orElse(null),
                curtailmentStatus.latestForSite(siteId).orElse(null));
    }

    /** Ob es die Komponente in dieser Anlage überhaupt gibt (sonst 404). */
    public boolean entityExists(UUID siteId, UUID entityId) {
        return entities.entityForSite(siteId, entityId) != null;
    }

    /**
     * Ob VoltPilot an diese Komponente überhaupt schreibt - die F4-Tatsache.
     *
     * <p>Zwei Belege, weil beide vorkommen: das {@code control}-Flag (die
     * Batterie-Hybrid-Zeile, die der Wechselrichter-Schreibweg bedient) und eine
     * nicht-leere {@code actuate}-Fähigkeit (ein freigegebener Schalter). Ohne
     * beides ist die Komponente NUR-LESEND, und genau das darf die Seite dann
     * auch sagen. Eine Anfrage OHNE Komponente beschreibt die ganze Anlage und
     * behauptet nichts.
     */
    private boolean writes(EntityRow entity) {
        return entity != null && writesTo(entity.control(), entity.capabilitiesJson());
    }

    /**
     * Die EINE Regel, ob an eine Komponente überhaupt geschrieben wird - geteilt
     * mit {@link DeviceScopes}, damit eine Komponente und ihr Gerät darüber nie
     * Verschiedenes behaupten.
     */
    static boolean writesTo(boolean control, String capabilitiesJson) {
        if (control) {
            return true;
        }
        if (capabilitiesJson == null || capabilitiesJson.isBlank()) {
            return false;
        }
        try {
            JsonNode actuate = SHARED.readTree(capabilitiesJson).get("actuate");
            return actuate != null && actuate.isArray() && !actuate.isEmpty();
        } catch (Exception e) {
            // Unlesbare Fähigkeiten sind kein Beleg für einen Schreibweg - und
            // „nur gelesen" ist die vorsichtigere der beiden Aussagen.
            return false;
        }
    }

    /**
     * Der VIERTE Strom {@code register}: die Einmal-Schreibvorgänge auf
     * Geräte-Register, zur LESEZEIT eingemischt (Konzept
     * {@code vp-reg-schreib-konzept-p8} §2.5).
     *
     * <p><b>Es gibt bewusst KEINE Doppel-Speicherung.</b> Die Wahrheit steht
     * genau einmal, im append-only Journal {@code register_write_event}; die
     * Befehle-Seite liest sie mit, statt sie in {@code device_command_log} zu
     * kopieren - zwei Bücher über dasselbe Ereignis wären zwei Wahrheiten.
     *
     * <p>Sie sind PUNKT-Ereignisse, keine Halteperioden: ein Register-Schreiben
     * hat einen Zeitpunkt und ein Ergebnis, keine Dauer, in der es „gehalten"
     * würde. {@code endedAt} trägt deshalb den Zeitpunkt der Quittung und ist
     * {@code null}, solange keine da ist - nicht „läuft noch", sondern „es ist
     * noch nichts zurückgekommen".
     *
     * <p>Bei einer Anfrage auf EINE Komponente werden die Vorgänge ihres Geräts
     * gezeigt: sie betreffen den Schreibweg, über den diese Komponente gesteuert
     * wird - dieselbe Regel, nach der auch die gerätebezogenen Kommando-Zeilen
     * mitkommen.
     *
     * <p>⚠ Die {@code id} ist NEGATIV: die beiden Ströme kommen aus zwei
     * Sequenzen, und die Fläche schlüsselt ihre Zeilen darauf. Ohne die
     * Spiegelung könnten sich eine Halteperiode und ein Register-Vorgang
     * dieselbe Kennung teilen und im Portal einander überschreiben.
     */
    private static List<CommandEntryDto> registerEntries(
            List<RegisterWriteEventRepository.Entry> writes) {
        return writes.stream()
                .map(e -> new CommandEntryDto(-e.id(), STREAM_REGISTER, "ereignis",
                        EVENT_REGISTER_WRITE, e.requestedAt(), e.answeredAt(), null, null, null,
                        null, null, null, null, null, null, null, null, null, null, null, null,
                        null, null, e.source(), null,
                        RegisterWriteEvents.toDto(e)))
                .toList();
    }

    private static CommandEntryDto toDto(CommandLogRepository.Row r) {
        CommandLog.Detail d = r.detail();
        return new CommandEntryDto(r.id(), r.stream(), r.kind(), r.eventKind(), r.startedAt(),
                r.endedAt(), r.mode(), r.path(), r.whyKind(), r.whyRef(), r.commandedKwFirst(),
                r.commandedKwLast(), r.commandedKwMin(), r.commandedKwMax(), r.verdict(),
                r.cycles(), r.cyclesConfirmed(), r.cyclesNoAnswer(), r.cyclesMismatch(),
                r.controlEnabled(), r.released(), r.foreignInfluence(),
                r.entityId() == null ? null : r.entityId().toString(), r.source(),
                d == null ? null : new CommandDetailDto(d.mismatchRoles(), d.certSource(),
                        d.units(), d.certifiedUnits(), d.state(), d.reasonCode()),
                null);
    }
}
