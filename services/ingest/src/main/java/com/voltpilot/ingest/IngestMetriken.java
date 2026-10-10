package com.voltpilot.ingest;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.stereotype.Component;

/**
 * Zaehlt, was die Datenannahme aufnimmt, weiterreicht und bewusst nicht weiterreicht.
 *
 * <p>Bauart und Wortwahl sind die des Writers ({@code WriterVerwerfMetriken}, PR 972): die
 * Label-Vokabulare sind absichtlich klein und geschlossen, alle Reihen stehen ab Prozessstart mit
 * {@code 0} bereit, und <b>keine Kennung wird je zum Label</b> — Mandant, Anlage, Box und
 * Ereignis-Kennung bleiben ausschliesslich in der WARN-Zeile. Der ingest sitzt VOR dem Writer; erst
 * beide Familien zusammen zeigen, wo auf der Strecke etwas stockt.
 *
 * <p>Die drei Zaehler messen drei verschiedene Dinge und duerfen sich nicht aufheben:
 * <ul>
 *   <li>{@code angenommen} — der Umschlag ist bei der Datenannahme eingegangen (je Nachricht 1);</li>
 *   <li>{@code weitergereicht} — sein Nutzlast-Satz wurde an Redpanda uebergeben;</li>
 *   <li>{@code verworfen} — der Umschlag hat sein Nutzlast-Topic NICHT erreicht.</li>
 * </ul>
 *
 * <p><b>angenommen = weitergereicht + verworfen gilt bewusst NICHT.</b> Ein angenommener Umschlag,
 * dessen Teilwerte abgelehnt wurden, reicht nichts weiter und ist trotzdem kein stiller Verlust:
 * diese Ablehnungen meldet der ingest seit AP-07 IP-5 als Ereignis auf {@code events.raw}. Genau so
 * hat PR 972 die Teilwert-Wege beim Writer getrennt; die Luecke zwischen den beiden Zaehlern ist
 * also lesbar und keine verlorene Nachricht.
 *
 * <p>Das Alter des letzten BESTAETIGTEN Schreibzugs steht daneben — Auftrag und gemessene Wirkung
 * bleiben getrennt: {@code weitergereicht} zaehlt die Uebergabe an Redpanda, das Alter bewegt sich
 * erst, wenn Redpanda die Sendung quittiert hat. Solange ein Strom seit dem Start keinen
 * bestaetigten Schreibzug hatte, liefert es {@code NaN} statt eines erfundenen Alters 0 (Hausstil
 * von {@code voltpilot_optimizer_cycle_age_seconds}).
 */
@Component
public class IngestMetriken {

    static final String ANGENOMMEN = "voltpilot.ingest.angenommen";
    static final String WEITERGEREICHT = "voltpilot.ingest.weitergereicht";
    static final String VERWORFEN = "voltpilot.ingest.verworfen";
    static final String SCHREIBZUG_ALTER = "voltpilot.ingest.letzter.schreibzug.age";

    static final String MEASUREMENTS = "measurements";
    static final String TELEMETRY = "telemetry";
    static final String TELEMETRY_V2 = "telemetry_v2";
    static final String EVENTS = "events";

    /**
     * Nur die Gruende, die der Code WIRKLICH unterscheidet. Der Writer kennt zusaetzlich
     * {@code unlesbar} und {@code pflichtfeld}; im ingest fuehren beide Faelle durch dieselbe
     * Abweisung ({@code Grund.SCHEMA_VERLETZT} bzw. eine {@link InvalidTelemetryException} ohne
     * Grund-Kennung), und der Unterschied waere nur aus dem Hinweistext zu raten. Ein erratenes
     * Label ist schlechter als ein grobes.
     */
    static final String UNGUELTIG = "ungueltig";

    static final String IDENTITAET = "identitaet";
    static final String SERIALISIERUNG = "serialisierung";
    /** UEMS AP-20 IP-16: der Umschlag gehoert zu einem beendeten Kundenbereich ({@link BeendeteKundenbereiche}). */
    static final String KUNDENBEREICH_BEENDET = "kundenbereich_beendet";

    private static final String[] STROEME = {MEASUREMENTS, TELEMETRY, TELEMETRY_V2, EVENTS};
    private static final String[] GRUENDE = {UNGUELTIG, IDENTITAET, SERIALISIERUNG, KUNDENBEREICH_BEENDET};

    private final Map<String, Counter> angenommen;
    private final Map<String, Counter> weitergereicht;
    private final Map<String, Map<String, Counter>> verworfen;

    /**
     * Zugleich die STARKE Referenz der Alters-Gauges: {@link Gauge.Builder} haelt sein Messobjekt
     * nur schwach, ein nicht gehaltenes Objekt wuerde nach der naechsten GC stillschweigend
     * {@code NaN} liefern (dieselbe Falle wie in {@code FleetMetricsCollector}).
     */
    private final Map<String, AtomicReference<Instant>> letzterSchreibzug;

    public IngestMetriken(MeterRegistry registry, Clock clock) {
        var eingang = new java.util.LinkedHashMap<String, Counter>();
        var weiter = new java.util.LinkedHashMap<String, Counter>();
        var verwerf = new java.util.LinkedHashMap<String, Map<String, Counter>>();
        var alter = new java.util.LinkedHashMap<String, AtomicReference<Instant>>();

        for (String strom : STROEME) {
            eingang.put(strom, Counter.builder(ANGENOMMEN)
                    .description("Bei der Datenannahme eingegangene Umschlaege")
                    .tag("strom", strom)
                    .register(registry));
            weiter.put(strom, Counter.builder(WEITERGEREICHT)
                    .description("An Redpanda uebergebene Umschlaege")
                    .tag("strom", strom)
                    .register(registry));

            var jeGrund = new java.util.LinkedHashMap<String, Counter>();
            for (String grund : GRUENDE) {
                jeGrund.put(grund, Counter.builder(VERWORFEN)
                        .description("Umschlaege, die ihr Nutzlast-Topic nicht erreicht haben")
                        .tag("strom", strom)
                        .tag("grund", grund)
                        .register(registry));
            }
            verwerf.put(strom, Map.copyOf(jeGrund));

            var zeitpunkt = new AtomicReference<Instant>();
            alter.put(strom, zeitpunkt);
            Gauge.builder(SCHREIBZUG_ALTER, zeitpunkt, ref -> alterIn(ref, clock))
                    .description("Sekunden seit dem letzten von Redpanda bestaetigten Schreibzug;"
                            + " NaN bis zum ersten bestaetigten Schreibzug")
                    .baseUnit("seconds")
                    .tag("strom", strom)
                    .register(registry);
        }

        angenommen = Map.copyOf(eingang);
        weitergereicht = Map.copyOf(weiter);
        verworfen = Map.copyOf(verwerf);
        letzterSchreibzug = Map.copyOf(alter);
    }

    private static double alterIn(AtomicReference<Instant> zeitpunkt, Clock clock) {
        Instant zuletzt = zeitpunkt.get();
        if (zuletzt == null) {
            return Double.NaN;
        }
        // Beim SCRAPE gerechnet, waechst also weiter, wenn der Strom versiegt.
        return Math.max(0d, (clock.millis() - zuletzt.toEpochMilli()) / 1000d);
    }

    void angenommen(String strom) {
        angenommen.get(strom).increment();
    }

    void weitergereicht(String strom) {
        weitergereicht.get(strom).increment();
    }

    void verworfen(String strom, String grund) {
        verworfen.get(strom).get(grund).increment();
    }

    /** Redpanda hat bestaetigt — erst hier bewegt sich das Alter, nicht schon bei der Uebergabe. */
    void schreibzugBestaetigt(String strom, Instant wann) {
        letzterSchreibzug.get(strom).set(wann);
    }

    /**
     * Abbildung der Vertrags-Gruende auf das kleine Metrik-Vokabular. {@link Grund} ist das
     * geschlossene Wort des Ereignis-Vertrags (neun Werte) und bleibt unangetastet; als Label waere
     * es die falsche Achse und zu breit.
     */
    static String grundVon(UmschlagAbgewiesen abgewiesen) {
        return abgewiesen.grund() == Grund.KENNUNG_ABWEICHEND ? IDENTITAET : UNGUELTIG;
    }
}
