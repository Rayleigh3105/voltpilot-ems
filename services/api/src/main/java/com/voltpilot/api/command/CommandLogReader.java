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
        return forSite(siteId, entityId, scope, from, to, CommandFilter.Filter.NONE, to,
                MAX_ENTRIES);
    }

    /**
     * Derselbe Verlauf mit den drei STRUKTUR-Filtern, dem Seiten-Cursor und dem
     * Treffer-Zähler (Geräteseiten Revision B §6, Captain-Punkt 4).
     *
     * <p><b>Der Zähler ist die Ehrlichkeit dieser Stufe:</b> {@code total} sind
     * die Zeilen des Zeitraums OHNE Filter, {@code matched} die mit ihm. Ein
     * Zähler, der nur die gezeigten nennt, verwechselte einen scharfen Filter
     * mit einem leeren Zeitraum - und ein Kunde läse „in dieser Woche wurde
     * nichts geschickt", wo in Wahrheit 212 Zeilen liegen.
     *
     * @param before der Seiten-Cursor („bis zu diesem Zeitpunkt", {@code <=})
     * @param limit  wie viele Zeilen je Speicher höchstens mitkommen
     */
    public CommandHistoryDto forSite(UUID siteId, UUID entityId, DeviceScopes.Scope scope,
            Instant from, Instant to, CommandFilter.Filter filter, Instant before, int limit) {
        EntityRow entity = entityId == null ? null : entities.entityForSite(siteId, entityId);
        UUID deviceId = entity == null ? null : entity.deviceId();
        boolean byDevice = scope != null;
        List<UUID> scopeEntities = byDevice ? scope.entityIds() : null;
        UUID scopeDevice = byDevice ? scope.deviceId() : null;

        List<CommandLogRepository.Row> rows = List.of();
        if (filter.includesLog()) {
            rows = byDevice
                    ? store.entriesForDevice(siteId, scopeDevice, scopeEntities, from, to,
                            limit + 1, filter, before)
                    : store.entries(siteId, entityId, deviceId, from, to, limit + 1, filter,
                            before);
        }
        boolean truncated = rows.size() > limit;
        if (truncated) {
            // Gekappt wird am ÄLTESTEN Ende: die Liste kommt aufsteigend an, die
            // jüngsten Zeilen sind die, die niemand verlieren will.
            rows = rows.subList(rows.size() - limit, rows.size());
        }
        // Der vierte Strom hat seinen EIGENEN Deckel, damit eine gespraechige
        // Halteperioden-Liste die wenigen Register-Zeilen nie verdraengt - und
        // greift er, sagt dieselbe `truncated`-Fahne es.
        int registerLimit = Math.min(limit, MAX_REGISTER_ENTRIES);
        List<RegisterWriteEventRepository.Entry> writes = List.of();
        if (filter.includesRegister()) {
            // Die BOX trägt ihre ANLAGENWEITEN Vorgänge (primäre Lane, freie
            // Adresse); ein Vorgang MIT Komponente steht auf der Seite ihres
            // Geräts (Ziel-Attribution).
            writes = registerWrites.filtered(siteId,
                    byDevice ? (scope.box() ? scopeDevice : null) : deviceId,
                    byDevice && !scope.box() ? scopeEntities : null, from, to,
                    registerLimit + 1, byDevice && scope.box(), filter, before);
        }
        if (writes.size() > registerLimit) {
            // Gekappt wird am AELTESTEN Ende (die Liste kommt neueste-zuerst).
            writes = writes.subList(0, registerLimit);
            truncated = true;
        }
        List<CommandEntryDto> entries = new ArrayList<>(
                rows.stream().map(CommandLogReader::toDto).toList());
        entries.addAll(registerEntries(writes));
        // Chronologisch, damit der Film EINE Zeitachse hat; ein fehlender Beginn
        // (den es hier nicht geben kann) sortiert ans Ende statt zu werfen.
        entries.sort(Comparator.comparing(CommandEntryDto::startedAt,
                Comparator.nullsLast(Comparator.naturalOrder())));
        int total = count(siteId, entityId, deviceId, scope, from, to, CommandFilter.Filter.NONE);
        int matched = filter.isEmpty() ? total
                : count(siteId, entityId, deviceId, scope, from, to, filter);
        // Der Cursor nach HINTEN: der Beginn der ältesten gezeigten Zeile. Er
        // ist null, sobald das Fenster vollständig gezeigt ist - eine Fläche
        // darf „mehr laden" nie anbieten, wo es nichts mehr gibt.
        Instant next = truncated && !entries.isEmpty() ? entries.get(0).startedAt() : null;
        return new CommandHistoryDto(store.recordingSince(siteId).orElse(null),
                CommandLog.ACCURACY_SECONDS, from, to, entityId,
                entity == null ? null : entity.label(), scope == null ? null : scope.ref(),
                scope == null ? null : scope.box(),
                scope != null ? scope.writes() : writes(entity), truncated,
                total, matched, next,
                entries,
                controlStatus.latestForSite(siteId).orElse(null),
                curtailmentStatus.latestForSite(siteId).orElse(null));
    }

    /** Die Zeilen des Fensters über BEIDE Speicher - mit oder ohne Filter. */
    private int count(UUID siteId, UUID entityId, UUID deviceId, DeviceScopes.Scope scope,
            Instant from, Instant to, CommandFilter.Filter filter) {
        boolean byDevice = scope != null;
        int n = 0;
        if (filter.includesLog()) {
            n += store.count(siteId, entityId, byDevice ? scope.deviceId() : deviceId,
                    byDevice ? scope.entityIds() : null, byDevice, from, to, filter);
        }
        if (filter.includesRegister()) {
            n += registerWrites.count(siteId,
                    byDevice ? (scope.box() ? scope.deviceId() : null) : deviceId,
                    byDevice && !scope.box() ? scope.entityIds() : null, from, to,
                    byDevice && scope.box(), filter);
        }
        return n;
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
