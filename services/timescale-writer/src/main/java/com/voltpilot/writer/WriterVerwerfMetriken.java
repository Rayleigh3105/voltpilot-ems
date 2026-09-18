package com.voltpilot.writer;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Zaehlt Umschlaege und bekannte Samples, die der Writer bewusst nicht schreibt.
 *
 * <p>Die Label-Vokabulare sind absichtlich klein und geschlossen. Identitaeten gehoeren weiter
 * nur in die WARN-Zeile, niemals in eine Metrik. Alle Reihen werden beim Prozessstart mit {@code 0}
 * registriert, damit Prometheus auch ohne bisherige Verwerfung eine belastbare Null sieht.
 */
@Component
public class WriterVerwerfMetriken {

    static final String UMSCHLAEGE = "voltpilot.writer.verworfen";
    static final String SAMPLES = "voltpilot.writer.verworfene.samples";

    static final String UNLESBAR = "unlesbar";
    static final String UNGUELTIG = "ungueltig";
    static final String IDENTITAET = "identitaet";
    static final String PFLICHTFELD = "pflichtfeld";

    private static final String[] STROEME = {"measurements", "telemetry", "telemetry_v2", "events"};
    private static final String[] GRUENDE = {UNLESBAR, UNGUELTIG, IDENTITAET, PFLICHTFELD};

    private final Map<String, Map<String, Counter>> umschlaege;
    private final Map<String, Counter> samples;

    public WriterVerwerfMetriken(MeterRegistry registry) {
        var stromZaehler = new java.util.LinkedHashMap<String, Map<String, Counter>>();
        for (String strom : STROEME) {
            var grundZaehler = new java.util.LinkedHashMap<String, Counter>();
            for (String grund : GRUENDE) {
                grundZaehler.put(grund, Counter.builder(UMSCHLAEGE)
                        .description("Vom Writer nicht geschriebene Eingangsumschlaege")
                        .tag("strom", strom)
                        .tag("grund", grund)
                        .register(registry));
            }
            stromZaehler.put(strom, Map.copyOf(grundZaehler));
        }
        umschlaege = Map.copyOf(stromZaehler);

        var sampleZaehler = new java.util.LinkedHashMap<String, Counter>();
        for (String grund : GRUENDE) {
            sampleZaehler.put(grund, Counter.builder(SAMPLES)
                    .description("Bekannte Samples in vom Writer verworfenen Umschlaegen")
                    .tag("grund", grund)
                    .register(registry));
        }
        samples = Map.copyOf(sampleZaehler);
    }

    void umschlag(String strom, String grund) {
        umschlaege.get(strom).get(grund).increment();
    }

    void umschlagMitSamples(String strom, String grund, int anzahl) {
        umschlag(strom, grund);
        if (anzahl > 0) {
            samples.get(grund).increment(anzahl);
        }
    }
}
