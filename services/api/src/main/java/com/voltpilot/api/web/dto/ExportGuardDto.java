package com.voltpilot.api.web.dto;

/**
 * The live FEED-IN WATCHDOG ("dynamische Einspeisebegrenzung") as the device
 * reports it in every heartbeat - „Grenzen &amp; Wächter" Stufe 0.
 *
 * <p><b>Why it exists:</b> the box has been sending this block since it was
 * built and the cloud read NOTHING of it (0 consumers, verified twice). The
 * question "which feed-in limit does the box hold, and does it reach any
 * device at all?" was therefore only answerable through a maintenance tunnel -
 * it cost two full investigation rounds at Anlage Herzogau (scout
 * {@code vp-herzogau-runde2-m6} §2/§7, Runde-1 §9-B). Nothing on the device
 * changed for this; it is purely a read path.
 *
 * <p><b>{@code effective} is the field the whole block exists for.</b> A
 * watchdog that computes a perfect cap and writes it NOWHERE must say so
 * loudly instead of letting a plant believe in a protection it does not have.
 * Herzogau reported exactly that: {@code limitKw = 70}, {@code effective =
 * false}, {@code reach = "Kein Wechselrichter ist für die Abregelung
 * freigegeben (0 von 2) …"}.
 *
 * <ul>
 *   <li>{@code limitKw} - the feed-in limit at the grid connection point AS THE
 *       BOX KNOWS IT (from the plan's {@code grid_export_limit_kw}).
 *   <li>{@code state} - the machine-readable word NEXT TO the German sentence
 *       ({@code ueberwacht|regelt|haelt|zieht_zusammen|sicherheitskappe}); a
 *       word outside that vocabulary is dropped at ingest, so no surface ever
 *       has to parse a sentence and none can render a verdict it cannot
 *       classify.
 *   <li>{@code reason} - the device's own German sentence for exactly that
 *       state. Written ONCE on the device (guards.ExportLimiter), so the
 *       {@code :8484} card and the portal can never word the same verdict
 *       differently - the portal passes it through rather than re-phrasing it.
 *   <li>{@code capKw} - the plant-level PV cap the watchdog currently commands;
 *       null = none (never a fabricated 0).
 *   <li>{@code limiting} - the cap is actually holding the producers back now.
 *   <li>{@code blind} - the verdict was NOT formed from a fresh
 *       connection-point measurement (hold / contract / safe cap).
 *   <li>{@code effective} - false when the cap can reach NO device.
 *   <li>{@code reach} - names the gap in German; null/blank when the cap
 *       reaches every unit (the device only fills it when something is off).
 * </ul>
 */
public record ExportGuardDto(double limitKw, String state, String reason, Double capKw,
        boolean limiting, boolean blind, boolean effective, String reach) {
}
