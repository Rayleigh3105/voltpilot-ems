package com.voltpilot.api.consumers;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Pure state machine for sustained telemetry-versus-plan load residuals. */
public final class LoadResidualReplanTrigger {
    private static final Duration MAX_MATERIAL_SAMPLE_GAP = Duration.ofSeconds(15);
    private static final class State {
        UUID observationDeviceId;
        Long lastSequence;
        Instant lastObservationAt;
        Instant materialSince;
        Instant lastMaterialAt;
        Instant pendingSince;
        Instant retryAt;
        Instant lastAttemptAt;
        boolean inFlight;
    }

    private final double absoluteKw;
    private final double relativeFraction;
    private final Duration sustained;
    private final Duration minInterval;
    private final Duration retryDelay;
    private final Map<UUID, State> sites = new HashMap<>();

    public LoadResidualReplanTrigger(double absoluteKw, double relativeFraction,
            Duration sustained, Duration minInterval, Duration retryDelay) {
        this.absoluteKw = absoluteKw;
        this.relativeFraction = relativeFraction;
        this.sustained = sustained;
        this.minInterval = minInterval;
        this.retryDelay = retryDelay;
    }

    /**
     * Observe one fresh, identified telemetry observation.
     *
     * <p>Continuity is measured on the device-owned observation timestamp, not
     * broker delivery time. The optional sequence is monotonic per device; a
     * repeated or older QoS-1 delivery is ignored without extending evidence.
     * Changing the observation device starts a new evidence stream instead of
     * splicing two meters into one sustained residual.
     */
    public synchronized boolean observe(UUID siteId, UUID deviceId, Long sequence,
            double actualKw, double plannedKw, Instant observedAt) {
        if (siteId == null || deviceId == null || observedAt == null
                || (sequence != null && sequence < 0)) return false;
        State state = sites.computeIfAbsent(siteId, ignored -> new State());
        if (state.observationDeviceId != null && !state.observationDeviceId.equals(deviceId)) {
            resetEvidence(state);
            state.lastSequence = null;
            state.lastObservationAt = null;
        } else if (state.lastObservationAt != null) {
            if (!observedAt.isAfter(state.lastObservationAt)) return false;
            if (sequence != null && state.lastSequence != null && sequence <= state.lastSequence) {
                return false;
            }
        }
        state.observationDeviceId = deviceId;
        state.lastObservationAt = observedAt;
        if (sequence != null) state.lastSequence = sequence;

        double residual = actualKw - plannedKw;
        boolean material = Double.isFinite(actualKw) && Double.isFinite(plannedKw)
                && Math.abs(residual) > absoluteKw
                && Math.abs(residual) > relativeFraction * Math.max(Math.abs(plannedKw), 1.0);
        if (!material) {
            resetEvidence(state);
            return false;
        }
        if (state.materialSince == null || (state.lastMaterialAt != null
                && observedAt.isAfter(state.lastMaterialAt.plus(MAX_MATERIAL_SAMPLE_GAP)))) {
            // A telemetry gap breaks the claim of a sustained deviation. Any
            // not-yet-dispatched pending attempt belongs to the old episode.
            resetEvidence(state);
            state.materialSince = observedAt;
        }
        state.lastMaterialAt = observedAt;
        if (state.pendingSince == null && !observedAt.isBefore(state.materialSince.plus(sustained))) {
            state.pendingSince = state.materialSince;
            return true;
        }
        return false;
    }

    /** Return due sites once, marking each in-flight until {@link #complete}. */
    public synchronized List<UUID> due(Instant now) {
        List<UUID> out = new ArrayList<>();
        for (Map.Entry<UUID, State> entry : sites.entrySet()) {
            State state = entry.getValue();
            if (state.pendingSince == null || state.inFlight
                    || (state.retryAt != null && now.isBefore(state.retryAt))
                    || (state.lastAttemptAt != null
                        && now.isBefore(state.lastAttemptAt.plus(minInterval)))) continue;
            state.inFlight = true;
            // The solve-storm bound covers every request, including 429s and
            // transport failures. A failed request remains pending, but it may
            // not consume another solve slot before the site's full interval.
            state.lastAttemptAt = now;
            out.add(entry.getKey());
        }
        return out;
    }

    /** Successful solves clear the request; failures remain pending and retry. */
    public synchronized void complete(UUID siteId, boolean success, Instant now) {
        State state = sites.get(siteId);
        if (state == null) return;
        state.inFlight = false;
        if (success) {
            state.pendingSince = null;
            state.materialSince = null;
            state.lastMaterialAt = null;
            state.retryAt = null;
        } else {
            state.retryAt = now.plus(retryDelay);
        }
    }

    private static void resetEvidence(State state) {
        state.materialSince = null;
        state.lastMaterialAt = null;
        state.pendingSince = null;
        state.retryAt = null;
    }
}
