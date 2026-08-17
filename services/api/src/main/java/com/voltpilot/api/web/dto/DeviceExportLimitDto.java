package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * The FEED-IN LIMIT THE INVERTER ITSELF HOLDS - a foreign truth inside the
 * customer's device, read (never written) by the box and reported in the
 * heartbeat („Grenzen &amp; Wächter" Stufe 0, Vierer #4).
 *
 * <p><b>Why it exists:</b> at Anlage Herzogau the Deye held an installer cap of
 * 33,0 kW in register {@code 0x00E7} while 70 kW were configured in the portal.
 * That discrepancy was invisible for two investigation rounds - not because the
 * data was hard to get, but because nobody read the register (scout
 * {@code vp-herzogau-runde2-m6} §3 K1 / §7 point 4).
 *
 * <ul>
 *   <li>{@code limitKw} - the limit the device currently holds.
 *   <li>{@code register} - WHERE it came from ("0x00e7"). A number without its
 *       origin is not evidence; the later raw view (Transparenz V1) renders it.
 *   <li>{@code readAt} - its OWN freshness anchor. The register is read at most
 *       once a day (one socket, no extra poll cadence), so it must never borrow
 *       {@code checkedAt} from the curtailment readbacks - that would claim a
 *       freshness it does not have.
 * </ul>
 *
 * <p>Null (absent) = the box did not report it: an older edge, a family whose
 * register map has no trustworthy feed-in-cap register, or simply not read yet.
 * Never a fabricated 0, and never "the device has no limit".
 */
public record DeviceExportLimitDto(double limitKw, String register, Instant readAt) {
}
