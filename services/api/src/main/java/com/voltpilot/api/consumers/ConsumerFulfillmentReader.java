package com.voltpilot.api.consumers;

import com.voltpilot.api.consumers.ConsumerRequirementLedger.Row;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.State;
import com.voltpilot.api.repo.ConsumerRequirementStateRepository;
import com.voltpilot.api.web.dto.ConsumerFulfillmentDto;
import com.voltpilot.api.web.dto.ConsumerFulfillmentDto.Task;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Reads the fulfilment ledger for the portal (Inkrement 5 / §9.4, §14.13). The
 * stored rows carry the last-written state; this reader applies the PURE
 * derivation ({@link ConsumerRequirementLedger#effectiveState}/{@code atRisk})
 * at read time so a period past its deadline reads {@code missed} and a period
 * running out of time reads "Frist gefährdet" - one truth, no background job.
 */
@Service
public class ConsumerFulfillmentReader {

    private final ConsumerRequirementStateRepository store;

    public ConsumerFulfillmentReader(ConsumerRequirementStateRepository store) {
        this.store = store;
    }

    public ConsumerFulfillmentDto forEntity(UUID siteId, UUID entityId) {
        Instant now = Instant.now();
        List<Task> tasks = new ArrayList<>();
        for (Row row : store.listForEntity(siteId, entityId)) {
            tasks.add(toTask(row, now));
        }
        return new ConsumerFulfillmentDto(tasks);
    }

    /**
     * Die AKTUELLE Instanz einer Liste (neueste Frist zuerst): die naechste noch
     * offene Frist, sonst die zuletzt abgelaufene.
     *
     * <p>Die Verbraucher-Zone zeigt je Komponente GENAU EINE Aufgabe. Sie hier
     * zu waehlen haelt die Regel bei EINER Stelle - die Flaeche darf nicht
     * selbst entscheiden, welche Frist „die" ist.
     */
    public static Task aktuelle(List<Row> rows, Instant now) {
        if (rows == null || rows.isEmpty()) {
            return null;
        }
        Row beste = null;
        for (Row row : rows) {
            if (!row.deadline().isBefore(now) && (beste == null || row.deadline().isBefore(beste.deadline()))) {
                beste = row;
            }
        }
        return toTask(beste != null ? beste : rows.get(0), now);
    }

    static Task toTask(Row row, Instant now) {
        State effective = ConsumerRequirementLedger.effectiveState(row.state(), row.deadline(), now);
        boolean atRisk = ConsumerRequirementLedger.atRisk(effective, row.deadline(),
                row.requiredRuntimeSeconds(), row.actualRuntimeSeconds(), now);
        return new Task(row.requirementId(), row.periodStart(), row.deadline(),
                row.requiredRuntimeSeconds(), row.actualRuntimeSeconds(), row.requiredEnergyKwh(),
                row.actualEnergyKwh(), row.energyConfirmation() == null ? null
                        : row.energyConfirmation().label(),
                effective.label(), atRisk, row.reasonCode());
    }
}
