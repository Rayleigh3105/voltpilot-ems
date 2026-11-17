package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * A device that enrolled (uploaded a CSR) but has no currently-claimed
 * {@code device} row - the operator view onto "did its part, waiting for the
 * portal". This surfaces the otherwise-invisible half of a mistyped-reference
 * dead-end: the device polls forever while the customer typed a different ref,
 * so nothing links the two. Deliberately admin-only; the device-facing
 * enrollment poll stays opaque (pending == unknown, no enumeration).
 *
 * <p>{@code everIssued} is true when a certificate was once issued and the
 * device was later unclaimed (a stale enrollment) versus never claimed at all.
 *
 * <p>{@code werkstattAbnahmeAm} is the Werkstatt acceptance date for this
 * reference, {@code null} when it enrolled without one (it registered
 * itself). This is the one honest fact the platform has about where a box
 * came from - no inference, no third guess.
 *
 * <p>{@code zuletztAbgefragtAm} (vp-entkoppelte-box-meldet-verbunden, D3 = A) is the last
 * certificate poll of this reference ({@code null} = never polled since the column exists).
 * A box that once held a certificate never uploads a CSR again, so for it this is the only
 * sign of life the platform hears; the portal judges a waiting box's reachability from the
 * later of the two.
 */
public record PendingEnrollmentDto(
        String externalRef,
        String deviceInfo,
        Instant csrUpdatedAt,
        boolean everIssued,
        Instant issuedAt,
        Instant werkstattAbnahmeAm,
        Instant zuletztAbgefragtAm) {
}
