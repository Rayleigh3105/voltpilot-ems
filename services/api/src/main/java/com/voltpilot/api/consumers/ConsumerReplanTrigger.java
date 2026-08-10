package com.voltpilot.api.consumers;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * The PURE half of the event replanning trigger (D8, docs/verbrauchssteuerung.md
 * §13.4) - Docker-free testable, the Tagesprotokoll/FleetPflege pattern. It
 * turns the stream of edge-reported consumer states into bounded replan
 * requests:
 *
 * <ul>
 *   <li><b>Transition detection</b> - only the §13.4 events trigger:
 *       Pflichtregel aktiv/inaktiv (into/out of {@code running_forced}),
 *       Verbraucher nicht verfügbar (into {@code offline}/{@code disconnected}),
 *       Aufgabe vorzeitig erfüllt (into {@code fulfilled}), and a PERSISTENTLY
 *       deviating readback ({@code confirmed=false} for N consecutive
 *       heartbeats, fired once until a confirming readback resets it). The
 *       FIRST observation of an entity never triggers - without a previous
 *       state there is no transition, and an api restart must not replan the
 *       whole fleet.</li>
 *   <li><b>Debounce per site</b> - a burst of events (vehicle plugged, rule
 *       flips, readback settles) coalesces into ONE request fired
 *       {@code debounce} after the first event.</li>
 *   <li><b>Rate limit per site</b> - at most one replan per
 *       {@code minInterval}; a trigger arriving inside the window stays
 *       pending and fires when the window opens. The 15-minute tick remains
 *       the Grundschlag either way.</li>
 * </ul>
 */
public class ConsumerReplanTrigger {

    private record EntityState(String state, int mismatchRun, boolean mismatchFired) {}

    private static final class SiteState {
        Instant pendingSince;
        Instant lastFiredAt;
    }

    private final Duration debounce;
    private final Duration minInterval;
    private final int mismatchThreshold;
    private final Map<UUID, EntityState> entities = new HashMap<>();
    private final Map<UUID, SiteState> sites = new HashMap<>();

    public ConsumerReplanTrigger(Duration debounce, Duration minInterval, int mismatchThreshold) {
        this.debounce = debounce;
        this.minInterval = minInterval;
        this.mismatchThreshold = Math.max(1, mismatchThreshold);
    }

    /**
     * Feed one reported consumer state. Returns whether this observation
     * recorded a trigger (visible for tests; firing happens via {@link #due}).
     */
    public synchronized boolean observe(UUID siteId, UUID entityId, String state,
            Boolean confirmed, Instant now) {
        EntityState previous = entities.get(entityId);
        boolean trigger = false;

        if (previous != null && previous.state() != null && state != null
                && !Objects.equals(previous.state(), state)) {
            boolean forcedFlip = "running_forced".equals(state)
                    || "running_forced".equals(previous.state());
            boolean unavailable = "offline".equals(state) || "disconnected".equals(state);
            boolean fulfilled = "fulfilled".equals(state);
            trigger = forcedFlip || unavailable || fulfilled;
        }

        int mismatchRun = Boolean.FALSE.equals(confirmed)
                ? (previous == null ? 1 : previous.mismatchRun() + 1) : 0;
        boolean mismatchFired = previous != null && previous.mismatchFired();
        if (mismatchRun == 0) {
            mismatchFired = false; // a confirming readback re-arms the rule
        } else if (mismatchRun >= mismatchThreshold && !mismatchFired) {
            trigger = true;
            mismatchFired = true;
        }

        entities.put(entityId, new EntityState(state, mismatchRun, mismatchFired));
        if (trigger) {
            SiteState site = sites.computeIfAbsent(siteId, k -> new SiteState());
            if (site.pendingSince == null) {
                site.pendingSince = now; // coalesce: the FIRST event anchors the debounce
            }
        }
        return trigger;
    }

    /** Sites whose debounce elapsed and whose rate-limit window is open. */
    public synchronized List<UUID> due(Instant now) {
        List<UUID> out = new ArrayList<>();
        for (Map.Entry<UUID, SiteState> entry : sites.entrySet()) {
            SiteState site = entry.getValue();
            if (site.pendingSince == null
                    || now.isBefore(site.pendingSince.plus(debounce))) {
                continue;
            }
            if (site.lastFiredAt != null && now.isBefore(site.lastFiredAt.plus(minInterval))) {
                continue; // rate-limited: stays pending, fires when the window opens
            }
            site.pendingSince = null;
            site.lastFiredAt = now;
            out.add(entry.getKey());
        }
        return out;
    }
}
