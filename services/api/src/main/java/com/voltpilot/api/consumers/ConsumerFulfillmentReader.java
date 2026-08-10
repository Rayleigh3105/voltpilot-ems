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

    private static Task toTask(Row row, Instant now) {
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
