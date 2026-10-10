package com.voltpilot.api.metrics;

import com.voltpilot.api.repo.VerbundBilanzMetrikRepository;
import com.voltpilot.api.uems.VerbundBilanzRegel;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * AP-15 IP-12: der Zustand der Verbund-Bilanz je Anlage für die Regel {@code GemeinsameSteuerungBilanzUnplausibel}
 * (gitops, Teil B von IP-11; Übergabe in docs/rollout/gemeinsame-steuerung-metriken.md). Muster wie
 * {@link GemeinsameSteuerungMetrikSammler}: gesammelt im eigenen Takt, ein Scrape führt nie SQL aus; Labels sind die
 * internen Kennungen {@code tenant}, {@code site} — nie ein Name.
 *
 * <p><b>Bestandsschutz.</b> Reihen gibt es nur für Anlagen mit Gemeinsamer Steuerung, jetzt wirksamen Mitgliedern und
 * mindestens einem gerechneten Tag; ohne sie ist der Export byte-gleich wie vorher. Am Schalter
 * {@code voltpilot.metrics.uems.enabled} hängt die Metrik wie die übrigen UEMS-Metriken.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.uems.enabled", havingValue = "true", matchIfMissing = true)
public class VerbundBilanzMetrik {

    private static final Logger log = LoggerFactory.getLogger(VerbundBilanzMetrik.class);

    /** 1 für den Zustand des jüngsten gerechneten Tages ({@code plausibel} | {@code unplausibel} | {@code unbekannt}). */
    public static final String ZUSTAND = "voltpilot_uems_verbund_bilanz_zustand";

    private final VerbundBilanzMetrikRepository repo;
    private final MultiGauge zustand;
    private boolean failing;

    public VerbundBilanzMetrik(VerbundBilanzMetrikRepository repo, MeterRegistry registry) {
        this.repo = repo;
        this.zustand = MultiGauge.builder(ZUSTAND)
                .description("1 fuer den Zustand der Verbund-Bilanz des juengsten gerechneten Tages je Anlage"
                        + " mit Gemeinsamer Steuerung: plausibel | unplausibel | unbekannt")
                .register(registry);
    }

    @Scheduled(fixedDelayString = "${voltpilot.metrics.uems.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.uems.initial-delay-ms:20000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("verbund-bilanz metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("verbund-bilanz metrics collection failed: {}", e.getMessage());
            }
        }
    }

    /** Sammelt einen Stand — der Takt und die DB-Tests (die Metrik ist im Testlauf aus). */
    public void collect() {
        List<MultiGauge.Row<?>> reihen = new ArrayList<>();
        for (VerbundBilanzMetrikRepository.Stand s : repo.staende()) {
            Tags tags = Tags.of("tenant", s.tenantId().toString(), "site", s.siteId().toString());
            for (String z : VerbundBilanzRegel.ZUSTAENDE) {
                reihen.add(MultiGauge.Row.of(tags.and("zustand", z), z.equals(s.zustand()) ? 1d : 0d));
            }
        }
        zustand.register(reihen, true);
    }
}
