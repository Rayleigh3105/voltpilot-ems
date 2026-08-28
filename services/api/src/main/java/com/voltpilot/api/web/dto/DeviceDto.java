package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A device as returned by the portal API (see docs/contracts/openapi.yaml).
 * {@code name} is the optional customer-facing label (Bezeichnung; the
 * immutable {@code externalRef} stays the identity). {@code lastSeenAt} is the
 * newest telemetry timestamp for the device (null until the first sample
 * arrives) - the portal derives the onboarding status "wartet auf erste Daten"
 * vs. "online" from it. {@code createdAt} is when the device was claimed; the
 * portal escalates the "wartet auf erste Daten" copy once the wait exceeds a
 * threshold (a permanently-waiting device usually means a mistyped ID or an
 * offline device).
 *
 * <p><b>{@code lanHost}/{@code lanSeenAt}/{@code lanSource}</b> (Anlagen-Zentrale
 * Stufe 2, Captain-Entscheid D5) are the box's OWN reachability in the customer
 * network - display only, and the only fact here the box reports about ITSELF
 * rather than about a measurement. {@code lanSource} says how strong the
 * evidence is: {@code erreicht} = a browser demonstrably opened the local
 * surface on that address (which may also be a service VPN),
 * {@code schnittstelle} = the box host's configured/detected customer-LAN
 * endpoint (or the own interface address on a non-containerized install).
 * <b>All three null = the box does not report it (yet) - NEVER "not
 * reachable".</b>
 */
public record DeviceDto(UUID id, UUID siteId, String externalRef, String kind, String name,
        String status, Instant lastSeenAt, Instant createdAt,
        String lanHost, Instant lanSeenAt, String lanSource) {

    /**
     * The pre-D5 shape - a device whose reachability is simply not reported.
     * It exists so a caller that does not care about that fact (every test
     * double, every synthesized row) stays unchanged, and because {@code null}
     * is exactly the honest value there.
     */
    public DeviceDto(UUID id, UUID siteId, String externalRef, String kind, String name,
            String status, Instant lastSeenAt, Instant createdAt) {
        this(id, siteId, externalRef, kind, name, status, lastSeenAt, createdAt, null, null, null);
    }
}
