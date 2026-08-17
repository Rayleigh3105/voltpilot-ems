package com.voltpilot.api.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.ControlStatusRepository;
import com.voltpilot.api.repo.CurtailmentStatusRepository;
import com.voltpilot.api.web.dto.CommandHistoryDto;
import com.voltpilot.api.web.dto.CommandHistoryDto.CommandDetailDto;
import com.voltpilot.api.web.dto.CommandHistoryDto.CommandEntryDto;
import java.time.Instant;
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

    private final CommandLogRepository store;
    private final EntityRegistryRepository entities;
    private final ControlStatusRepository controlStatus;
    private final CurtailmentStatusRepository curtailmentStatus;
    private final ObjectMapper mapper = new ObjectMapper();

    public CommandLogReader(CommandLogRepository store, EntityRegistryRepository entities,
            ControlStatusRepository controlStatus, CurtailmentStatusRepository curtailmentStatus) {
        this.store = store;
        this.entities = entities;
        this.controlStatus = controlStatus;
        this.curtailmentStatus = curtailmentStatus;
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
        EntityRow entity = entityId == null ? null : entities.entityForSite(siteId, entityId);
        UUID deviceId = entity == null ? null : entity.deviceId();
        List<CommandLogRepository.Row> rows =
                store.entries(siteId, entityId, deviceId, from, to, MAX_ENTRIES + 1);
        boolean truncated = rows.size() > MAX_ENTRIES;
        if (truncated) {
            // Gekappt wird am ÄLTESTEN Ende: die Liste kommt aufsteigend an, die
            // jüngsten Zeilen sind die, die niemand verlieren will.
            rows = rows.subList(rows.size() - MAX_ENTRIES, rows.size());
        }
        return new CommandHistoryDto(store.recordingSince(siteId).orElse(null),
                CommandLog.ACCURACY_SECONDS, from, to, entityId,
                entity == null ? null : entity.label(), writes(entity), truncated,
                rows.stream().map(CommandLogReader::toDto).toList(),
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
        if (entity == null) {
            return false;
        }
        if (entity.control()) {
            return true;
        }
        return hasActuate(entity.capabilitiesJson());
    }

    private boolean hasActuate(String capabilitiesJson) {
        if (capabilitiesJson == null || capabilitiesJson.isBlank()) {
            return false;
        }
        try {
            JsonNode actuate = mapper.readTree(capabilitiesJson).get("actuate");
            return actuate != null && actuate.isArray() && !actuate.isEmpty();
        } catch (Exception e) {
            // Unlesbare Fähigkeiten sind kein Beleg für einen Schreibweg - und
            // „nur gelesen" ist die vorsichtigere der beiden Aussagen.
            return false;
        }
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
                        d.units(), d.certifiedUnits(), d.state(), d.reasonCode()));
    }
}
