package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.writer.EreignisVokabular.Urheber;
import com.voltpilot.writer.EreignisVokabular.Urteil;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die Writer-Hälfte von {@code docs/contracts/v2/datenannahme-events-vectors.json} (UEMS AP-07
 * IP-5 × IP-8) — rein, kein Docker: JEDE {@code events.raw}-Nachricht, die die Datenannahme
 * erzeugt (die Ingest-Hälfte {@code services/ingest .../DatenannahmeVektorenTest} beweist, dass
 * ihr Code genau diese erzeugt), wird von {@link EventsRawConsumer} ANGENOMMEN: der Rahmen besteht,
 * und {@link EreignisVokabular#pruefe} nimmt das Ereignis für seinen Urheber an — clock_ahead,
 * too_old, rejected je Grund und die Box-Einträge. Dazu urteilt der Writer-Zwilling über jeden
 * Box-Umschlag genau wie die Datenannahme.
 */
class DatenannahmeNachrichtenTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path DATEI = Path.of("../../docs/contracts/v2/datenannahme-events-vectors.json");

    @Test
    void jedeNachrichtDerDatenannahmeWirdAngenommen() throws Exception {
        List<String> abgelehnt = new ArrayList<>();
        int nachrichten = 0;
        for (JsonNode c : MAPPER.readTree(Files.readString(DATEI)).path("cases")) {
            for (JsonNode r : c.path("expected").path("events_raw")) {
                nachrichten++;
                String wo = c.path("name").asText() + " / " + r.path("ereignis").path("art").asText();
                Urteil u = EreignisVokabular.pruefe(r.path("ereignis"), Urheber.vonCode(r.path("urheber").asText()));
                if (!u.angenommen()) {
                    abgelehnt.add(wo + ": " + u.grund() + " " + u.hinweis());
                }
                // Der Rahmen des Verbrauchers: nur was ihn besteht, erreicht anhaengen().
                MessreiheEreignisRepository repository = mock(MessreiheEreignisRepository.class);
                when(repository.anhaengen(any(), any(), any(), any(), any()))
                        .thenReturn(MessreiheEreignisRepository.Ergebnis.ANGEHAENGT);
                SimpleMeterRegistry meters = new SimpleMeterRegistry();
                ObjectNode record = r.deepCopy();
                record.put("event_id", UUID.randomUUID().toString());
                new EventsRawConsumer(MAPPER, repository, meters,
                        new WriterVerwerfMetriken(meters)).onMessage(record.toString());
                verify(repository, times(1)).anhaengen(eq(UUID.fromString(r.path("tenant_id").asText())),
                        eq(UUID.fromString(r.path("site_id").asText())),
                        eq(Urheber.vonCode(r.path("urheber").asText())), eq(r.path("ereignis")),
                        eq(Instant.parse(r.path("ingested_at").asText())));
                assertThat(meters.find(EventsRawConsumer.METRIK).tag("ergebnis", "verworfen").counter())
                        .as(wo).isNull();
            }
        }
        assertThat(nachrichten).as("Nachrichten der Vektor-Datei").isGreaterThanOrEqualTo(19);
        assertThat(abgelehnt).isEmpty();
    }

    /**
     * Dieselbe Zustellung zweimal (QoS 1): die Datenannahme vergibt dieselbe {@code ereignis_id},
     * aber {@code zeitpunkt} ist die Eingangszeit der jeweiligen Zustellung. Der Speicher erkennt
     * eine Wiederholung nur an der GLEICHEN Meldung, also ist die zweite eine unzulässige
     * Fortschreibung — verworfen, gespeichert bleibt die erste (events-vocabulary.md §7). Ändert
     * sich das, ändern sich Doku und dieser Test zusammen.
     */
    @Test
    void eineErneuteZustellungBleibtBeiDerErstenMeldung() throws Exception {
        JsonNode erste = null;
        for (JsonNode c : MAPPER.readTree(Files.readString(DATEI)).path("cases")) {
            if ("a13-lindach-uhr-14-minuten-vor".equals(c.path("name").asText())) {
                erste = c.path("expected").path("events_raw").get(0).path("ereignis");
            }
        }
        ObjectNode zweite = erste.deepCopy();
        zweite.put("zeitpunkt", "2026-10-20T08:15:40Z");
        Urteil u = EreignisVokabular.pruefeFortschreibung(erste, zweite, Urheber.DATENANNAHME);
        assertThat(u.angenommen()).isFalse();
        assertThat(u.grund().code()).isEqualTo("fortschreibung_unzulaessig");
        assertThat(EreignisVokabular.gleich(erste, erste.deepCopy())).as("dieselbe Meldung = Wiederholung").isTrue();
    }

    /** Der Writer-Zwilling urteilt über jeden Box-Umschlag wie die Datenannahme (Grund inklusive). */
    @Test
    void derWriterZwillingUrteiltUeberJedenBoxUmschlagGleich() throws Exception {
        List<String> abweichungen = new ArrayList<>();
        int umschlaege = 0;
        for (JsonNode c : MAPPER.readTree(Files.readString(DATEI)).path("cases")) {
            String topic = c.path("input").path("topic").asText();
            if (!topic.endsWith("/v2/events")) {
                continue;
            }
            umschlaege++;
            String grund = null;
            for (JsonNode r : c.path("expected").path("events_raw")) {
                if ("rejected".equals(r.path("ereignis").path("art").asText())) {
                    grund = r.path("ereignis").path("grund").asText();
                }
            }
            Urteil u = EreignisVokabular.pruefeUmschlag(topic, c.path("input").path("payload"));
            boolean gleich = grund == null ? u.angenommen() : !u.angenommen() && grund.equals(u.grund().code());
            if (!gleich) {
                abweichungen.add(c.path("name").asText() + ": Datenannahme " + grund + ", Writer " + u);
            }
        }
        assertThat(umschlaege).isGreaterThanOrEqualTo(8);
        assertThat(abweichungen).isEmpty();
    }
}
