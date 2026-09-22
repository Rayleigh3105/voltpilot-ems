package com.voltpilot.api.metrics;

import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * AP-15 IP-11: Box-Uhr gegen die Cloud-Empfangszeit des Status-Herzschlags.
 *
 * <p>Der Versatz ist positiv, wenn die Box vorgeht. Daneben zählt {@link #UHRSPRUNG} die in
 * {@code messreihe_ereignis} dauerhaft abgelegten Ereignisse {@code clock_ahead} und
 * {@code clock_jump}. Der Sammler reicht diesen Datenbankstand ein; der Herzschlag erfindet kein
 * Ereignis aus einem Schwellenwert.
 *
 * <p>Beide Werte leben absichtlich im Prozess: der nicht-retained Status-Herzschlag liefert nach
 * einem Neustart den neuen Stand. Der Ereigniszähler kommt dagegen aus der append-only Tabelle und
 * bleibt über Neustarts erhalten.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.uems.enabled", havingValue = "true",
        matchIfMissing = true)
public class GemeinsameSteuerungUhrMetrik {

    /** Box-Uhr minus Cloud-Empfangszeit in Sekunden. */
    public static final String VERSATZ = "voltpilot_uems_box_uhr_versatz_seconds";

    /** Prometheus {@code voltpilot_uems_box_uhrsprung_total}. */
    public static final String UHRSPRUNG = "voltpilot_uems_box_uhrsprung";

    private final MeterRegistry registry;
    private final Map<UUID, AtomicReference<Double>> versaetze = new HashMap<>();
    private final Map<UUID, AtomicLong> uhrsprungStaende = new HashMap<>();
    private final Map<UUID, FunctionCounter> uhrsprungZaehler = new HashMap<>();

    public GemeinsameSteuerungUhrMetrik(MeterRegistry registry) {
        this.registry = registry;
    }

    /** Übernimmt einen gültigen Herzschlag; fehlende oder unlesbare Box-Zeit erzeugt keine Reihe. */
    public synchronized void herzschlag(UUID deviceId, Instant boxZeit, Instant empfangenUm) {
        if (deviceId == null || boxZeit == null || empfangenUm == null) {
            return;
        }
        double versatz = Duration.between(empfangenUm, boxZeit).toMillis() / 1000d;
        if (!Double.isFinite(versatz)) {
            return;
        }

        AtomicReference<Double> wert = versaetze.get(deviceId);
        if (wert == null) {
            wert = new AtomicReference<>(versatz);
            versaetze.put(deviceId, wert);
            Gauge.builder(VERSATZ, wert, AtomicReference::get)
                    .description("Box-Uhr minus Cloud-Empfangszeit des Status-Herzschlags in Sekunden")
                    .tag("device", deviceId.toString())
                    .register(registry);
        } else {
            wert.set(versatz);
        }
    }

    /** Übernimmt den dauerhaften Ereignisstand der aktuell sichtbaren Boxen. */
    public synchronized void uhrereignisse(Map<UUID, Long> staende) {
        Set<UUID> gesehen = new HashSet<>();
        for (Map.Entry<UUID, Long> eintrag : staende.entrySet()) {
            UUID deviceId = eintrag.getKey();
            long anzahl = Math.max(0L, eintrag.getValue());
            gesehen.add(deviceId);
            AtomicLong stand = uhrsprungStaende.computeIfAbsent(deviceId, id -> new AtomicLong());
            stand.set(Math.max(stand.get(), anzahl));
            uhrsprungZaehler.computeIfAbsent(deviceId, id -> FunctionCounter.builder(
                            UHRSPRUNG, stand, AtomicLong::doubleValue)
                    .description("Dauerhaft gespeicherte clock_jump- und clock_ahead-Ereignisse je Box")
                    .tag("device", id.toString())
                    .register(registry));
        }
        for (UUID alt : Set.copyOf(uhrsprungZaehler.keySet())) {
            if (!gesehen.contains(alt)) {
                registry.remove(uhrsprungZaehler.remove(alt));
                uhrsprungStaende.remove(alt);
            }
        }
    }
}
