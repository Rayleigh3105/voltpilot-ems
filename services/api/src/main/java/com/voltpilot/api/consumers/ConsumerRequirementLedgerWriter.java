package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.EnergyConfirmation;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.Evidence;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.Requirement;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.Row;
import com.voltpilot.api.repo.ConsumerRequirementStateRepository;
import com.voltpilot.api.repo.ConsumerRequirementStateRepository.ProfileRow;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The CLOUD-side writer of the fulfilment ledger (Inkrement 5 / §9.4). It rides
 * the consumers heartbeat listener ({@link ConsumerRuntimeStatusListener}) - the
 * same telemetry that feeds consumer_runtime_status - so the ledger is derived
 * from CONFIRMED telemetry, never from a sent setpoint. The tenant context is
 * already set by the listener; every read/write here is RLS-scoped.
 *
 * <p>The pure rules live in {@link ConsumerRequirementLedger}; this class only
 * gathers evidence (the active policy's recurring requirements, the confirmation
 * level from the confirmation channel, the measured/integrated energy from
 * telemetry_v2) and upserts. It NEVER throws - a ledger failure must never sink
 * the heartbeat ingest (the listener wraps it, but this is belt and braces).
 */
@Component
public class ConsumerRequirementLedgerWriter {

    private static final Logger log = LoggerFactory.getLogger(ConsumerRequirementLedgerWriter.class);
    /** v1 platform zone (Europe/Berlin, the HistoryRange pinning); §14.6 note. */
    static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private final ConsumerRequirementStateRepository store;
    private final ObjectMapper mapper;

    public ConsumerRequirementLedgerWriter(ConsumerRequirementStateRepository store,
            ObjectMapper mapper) {
        this.store = store;
        this.mapper = mapper;
    }

    /**
     * Recompute + upsert the fulfilment ledger from a heartbeat's reported
     * consumer states. Called by the listener under the heartbeat's tenant
     * context, with {@code now} = the heartbeat's report time.
     */
    public void ingest(UUID siteId, List<ConsumerRuntimeStatusRepository.Row> reported, Instant now) {
        if (reported == null || reported.isEmpty()) {
            return;
        }
        try {
            Map<UUID, ProfileRow> profiles = new HashMap<>();
            for (ProfileRow p : store.enabledProfiles(siteId)) {
                profiles.put(p.entityId(), p);
            }
            for (ConsumerRuntimeStatusRepository.Row r : reported) {
                ProfileRow profile = profiles.get(r.entityId());
                if (profile == null) {
                    continue; // disabled or no profile - nothing to measure against
                }
                ingestOne(siteId, r, profile, now);
            }
        } catch (Exception e) {
            log.warn("consumer fulfilment ledger ingest for site {} failed: {}", siteId,
                    e.getMessage());
        }
    }

    private void ingestOne(UUID siteId, ConsumerRuntimeStatusRepository.Row r, ProfileRow profile,
            Instant now) {
        String docJson = store.activePolicyDocument(siteId, r.entityId());
        if (docJson == null) {
            return; // no active policy - no recurring obligation to track
        }
        JsonNode doc;
        try {
            doc = mapper.readTree(docJson);
        } catch (Exception e) {
            return;
        }
        List<Requirement> reqs =
                ConsumerRequirementLedger.requirementsOf(doc, profile.ratedPowerKw());
        if (reqs.isEmpty()) {
            return;
        }
        EnergyConfirmation level = levelFor(profile.confirmationChannel());
        int runtime = r.runtimeSecondsToday() == null ? 0 : r.runtimeSecondsToday();
        // Only reach into telemetry_v2 when a requirement actually has an energy
        // goal - the common runtime-only case never touches it (hot-path light).
        boolean anyEnergyGoal = reqs.stream().anyMatch(q -> q.requiredEnergyKwh() != null);
        BigDecimal measuredEnergy = null;
        EnergyConfirmation effectiveLevel = level;
        if (anyEnergyGoal && (level == EnergyConfirmation.MEASURED
                || level == EnergyConfirmation.INTEGRATED)) {
            // The instance window is the same for the goal; use the widest
            // current period among the requirements to bound the read.
            Instant[] window = widestPeriod(reqs, now);
            if (window != null) {
                measuredEnergy = store.energyOverPeriod(r.entityId(), profile.confirmationChannel(),
                        window[0], window[1], level == EnergyConfirmation.INTEGRATED);
            }
            if (measuredEnergy == null) {
                // Honest downgrade: no telemetry covered the period, so the energy
                // is Nennleistung × Zeit, i.e. ASSUMED - never a claimed "gemessen".
                effectiveLevel = EnergyConfirmation.ASSUMED;
            }
        }
        Evidence ev = new Evidence(runtime, r.state(), r.reasonCode(), r.confirmed(), effectiveLevel,
                measuredEnergy, profile.ratedPowerKw());
        List<Row> rows = ConsumerRequirementLedger.evaluate(r.entityId(), reqs, ev, now, ZONE);
        for (Row row : rows) {
            store.upsert(siteId, r.entityId(), row);
        }
    }

    /** The widest current recurrence window across the requirements, for the read bound. */
    private static Instant[] widestPeriod(List<Requirement> reqs, Instant now) {
        Instant start = null;
        Instant end = null;
        for (Requirement q : reqs) {
            for (Row row : ConsumerRequirementLedger.evaluate(null, List.of(q),
                    new Evidence(0, null, null, null, EnergyConfirmation.NONE, null, null), now,
                    ZONE)) {
                if (start == null || row.periodStart().isBefore(start)) {
                    start = row.periodStart();
                }
                if (end == null || row.deadline().isAfter(end)) {
                    end = row.deadline();
                }
            }
        }
        return start == null ? null : new Instant[] {start, end};
    }

    /**
     * The D3 confirmation level implied by the consumer's confirmation channel:
     * an energy channel measures, a power channel integrates, a relay/state
     * channel only confirms runtime (energy "angenommen"), der SG-Ready-Kanal
     * `freigabe` bestätigt NUR die Freigabe (nie eine Energie), no channel
     * confirms nothing (never "erfüllt"). Package-visible for the test.
     */
    static EnergyConfirmation levelFor(String channel) {
        if (channel == null || channel.isBlank()) {
            return EnergyConfirmation.NONE;
        }
        String c = channel.toLowerCase();
        // ⚠ Der SG-Ready-Kanal ZUERST: er enthält weder "power" noch "energy"
        // und fiele sonst auf ASSUMED durch - also auf "Nennleistung × Zeit"
        // über ein Gerät, dessen Verbrauch wir gar nicht kennen (§3.4).
        if (SgReady.CONFIRMATION_CHANNEL.equals(c)) {
            return EnergyConfirmation.FREIGABE;
        }
        if (c.contains("energy") || c.endsWith("kwh") || c.endsWith("_wh")) {
            return EnergyConfirmation.MEASURED;
        }
        if (c.contains("power") || c.endsWith("kw") || c.endsWith("_w")) {
            return EnergyConfirmation.INTEGRATED;
        }
        return EnergyConfirmation.ASSUMED;
    }
}
