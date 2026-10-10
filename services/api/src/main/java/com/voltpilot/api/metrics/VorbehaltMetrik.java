package com.voltpilot.api.metrics;

import com.voltpilot.api.repo.VorbehaltMetrikRepository;
import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * AP-15 IP-13: der Zähler der selbsttätigen Erhöhungen des Vorbehalts je Anlage für die Regel
 * {@code GemeinsameSteuerungVorbehaltZuKlein} (gitops, Teil B von IP-11; Übergabe in
 * docs/rollout/gemeinsame-steuerung-metriken.md). Prometheus: {@code voltpilot_uems_vorbehalt_erhoeht_total} — Micrometer
 * hängt das {@code _total} an. Der Stand kommt aus der Datenbank (Zeilen {@code erhoeht} sind nur angehängt): er
 * übersteht einen Neustart, ist in jeder api-Instanz gleich und beginnt je Anlage bei 0, damit {@code increase()} schon
 * die erste Erhöhung sieht. Muster wie {@link VerbundBilanzMetrik}: gesammelt im eigenen Takt, ein Scrape führt nie SQL
 * aus; Labels {@code tenant}, {@code site} — nie ein Name.
 *
 * <p><b>Bestandsschutz.</b> Reihen gibt es nur für Anlagen mit Gemeinsamer Steuerung und jetzt wirksamen Mitgliedern;
 * ohne sie ist der Export byte-gleich wie vorher. Am Schalter {@code voltpilot.metrics.uems.enabled}.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.uems.enabled", havingValue = "true", matchIfMissing = true)
public class VorbehaltMetrik {

    private static final Logger log = LoggerFactory.getLogger(VorbehaltMetrik.class);

    /** Prometheus {@code voltpilot_uems_vorbehalt_erhoeht_total}. */
    public static final String ERHOEHT = "voltpilot_uems_vorbehalt_erhoeht";

    private final VorbehaltMetrikRepository repo;
    private final MeterRegistry registry;
    private final Map<List<String>, AtomicLong> staende = new ConcurrentHashMap<>();
    private final Map<List<String>, FunctionCounter> zaehler = new ConcurrentHashMap<>();
    private boolean failing;

    public VorbehaltMetrik(VorbehaltMetrikRepository repo, MeterRegistry registry) {
        this.repo = repo;
        this.registry = registry;
    }

    @Scheduled(fixedDelayString = "${voltpilot.metrics.uems.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.uems.initial-delay-ms:20000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("vorbehalt metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("vorbehalt metrics collection failed: {}", e.getMessage());
            }
        }
    }

    /** Sammelt einen Stand — der Takt und die DB-Tests (die Metrik ist im Testlauf aus). */
    public synchronized void collect() {
        Set<List<String>> gesehen = new HashSet<>();
        for (VorbehaltMetrikRepository.Stand s : repo.staende()) {
            List<String> schluessel = List.of(s.tenantId().toString(), s.siteId().toString());
            gesehen.add(schluessel);
            AtomicLong wert = staende.computeIfAbsent(schluessel, k -> new AtomicLong());
            wert.set(Math.max(wert.get(), s.erhoeht()));
            zaehler.computeIfAbsent(schluessel, k -> FunctionCounter.builder(ERHOEHT, wert, AtomicLong::doubleValue)
                    .description("Selbsttaetige Erhoehungen des Vorbehalts der Bezugsseite je Anlage mit Gemeinsamer"
                            + " Steuerung (AP-15 IP-13, verengt die Anteile)")
                    .tags(Tags.of("tenant", k.get(0), "site", k.get(1))).register(registry));
        }
        for (List<String> alt : Set.copyOf(zaehler.keySet())) {
            if (!gesehen.contains(alt)) {
                registry.remove(zaehler.remove(alt));
                staende.remove(alt);
            }
        }
    }
}
