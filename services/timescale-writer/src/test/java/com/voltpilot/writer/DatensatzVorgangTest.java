package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

/**
 * {@code request_id} und {@code tenant_id} je Datensatz ({@link DatensatzVorgang}). Reine Einheit;
 * dass Spring Boot den Interceptor an die Verbraucher hängt und eine echte Zeile die Kennungen
 * trägt, zeigt {@code WriterPipeTest} am laufenden Broker.
 */
class DatensatzVorgangTest {

    private static final String MANDANT = "7f3c1e6a-2b4d-4c8e-9a10-5d6e7f8091a2";
    private static final String ANLAGE = "11111111-1111-4111-8111-111111111111";

    private final DatensatzVorgang vorgang = new DatensatzVorgang();

    @AfterEach
    void aufraeumen() {
        MDC.clear();
    }

    private static ConsumerRecord<Object, Object> datensatz(String topic, int partition, long offset, Object schluessel) {
        return new ConsumerRecord<>(topic, partition, offset, schluessel, "{}");
    }

    private Map<String, String> waehrend(ConsumerRecord<Object, Object> datensatz) {
        assertThat(vorgang.intercept(datensatz, null)).as("der Datensatz geht unverändert weiter").isSameAs(datensatz);
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        vorgang.afterRecord(datensatz, null);
        return mdc;
    }

    @Test
    void derVerbraucherSiehtDieStelleImBrokerUndDenMandantenAusDemSchluessel() {
        Map<String, String> mdc = waehrend(datensatz("telemetry.raw", 2, 4711, MANDANT + ":" + ANLAGE));

        assertThat(mdc).containsOnly(
                Map.entry("request_id", "telemetry.raw-2@4711"), Map.entry("tenant_id", MANDANT));
        assertThat(MDC.getCopyOfContextMap()).as("nach dem Datensatz trägt der Faden nichts mehr").isNullOrEmpty();
    }

    @Test
    void auchDerDreiteiligeSchluesselDerMesswerteNenntDenMandanten() {
        assertThat(waehrend(datensatz("measurements.raw", 0, 1, MANDANT + ":" + ANLAGE + ":" + ANLAGE)))
                .containsEntry("tenant_id", MANDANT);
    }

    /** Dieselbe Stelle, dieselbe Kennung - eine erneute Zustellung ist derselbe Vorgang. */
    @Test
    void eineErneuteZustellungTraegtDieselbeKennung() {
        assertThat(waehrend(datensatz("events.raw", 1, 9, null)).get("request_id"))
                .isEqualTo(waehrend(datensatz("events.raw", 1, 9, null)).get("request_id"))
                .isEqualTo("events.raw-1@9");
    }

    @Test
    void ohneLesbarenSchluesselFehltDerMandantStattFalschZuSein() {
        assertThat(waehrend(datensatz("events.raw", 0, 1, null))).containsOnlyKeys("request_id");
        assertThat(waehrend(datensatz("events.raw", 0, 2, "ohne-trenner"))).containsOnlyKeys("request_id");
        assertThat(waehrend(datensatz("events.raw", 0, 3, "kein-uuid:" + ANLAGE))).containsOnlyKeys("request_id");
        assertThat(waehrend(datensatz("events.raw", 0, 4, new byte[] {1}))).containsOnlyKeys("request_id");
    }

    /** Der Mandant des vorigen Datensatzes darf nie am nächsten hängen bleiben - auch ohne afterRecord dazwischen. */
    @Test
    void derNaechsteDatensatzErbtKeinenMandanten() {
        vorgang.intercept(datensatz("telemetry.raw", 0, 1, MANDANT + ":" + ANLAGE), null);

        vorgang.intercept(datensatz("telemetry.raw", 0, 2, "ohne-trenner"), null);

        assertThat(MDC.getCopyOfContextMap()).containsOnly(Map.entry("request_id", "telemetry.raw-0@2"));
    }
}
