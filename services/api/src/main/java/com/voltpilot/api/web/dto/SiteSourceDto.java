package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * One measurement point of a site as the edge reports it: the primary inverter
 * ({@code kind="primary"}) or an additional source ({@code kind="source"}),
 * with its OWN latest reading and freshness.
 *
 * <p>This is what makes a multi-inverter site's composite PV explainable - the
 * portal renders "39,0 kW = Deye 8,3 + Fronius 21,3 + Fronius WR 2 9,3" instead
 * of one opaque number. Absent measurements stay {@code null} (never a
 * fabricated 0), and a point that is stale or has never delivered says so via
 * {@code health} (ok | stale | never) rather than vanishing.
 *
 * <p>Display-only: nothing downstream consumes it; the composite telemetry the
 * site publishes is untouched.
 *
 * @param bms was dieses Gerät über eine per CAN GEKOPPELTE Batterie meldet
 *        (P4): der Ladestand des BMS selbst, seine gemessene Spannung/Strom,
 *        die Grenzen, die es gerade erlaubt, seine Alarm-/Fehler-Bitfelder und
 *        welches BMS-Protokoll antwortet - unter den {@code bms_*}-Kanalnamen,
 *        die die Box dekodiert. {@code null} auf jeder Anlage OHNE eine solche
 *        Kopplung, und das ist heute jede: ein Block voller Nullen ist die
 *        belegte Signatur „nicht gekoppelt", und die Box veröffentlicht dafür
 *        gar keinen Kanal - nie eine erfundene 0 %. Wie der Rest dieses
 *        Datensatzes reine ANZEIGE; die Grenzen, die einen Sollwert wirklich
 *        kappen, sind die v2-Kanäle des Schutzbausteins (P5c), nicht diese.
 */
public record SiteSourceDto(UUID deviceId, String sourceId, String kind, String role,
        String label, String brand, String model, Double pvKw, Double powerKw, Double loadKw,
        String health, Instant readAt, Instant reportedAt, Map<String, Double> bms) {
}
