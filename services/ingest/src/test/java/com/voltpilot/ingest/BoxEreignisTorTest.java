package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.after;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;

/**
 * Der Box-Weg {@code …/v2/events} verbindet sich erst, wenn es {@code events.raw} gibt (Entscheid
 * b07-recreate D) — rein, Adapter und Topic-Prüfung sind Attrappen.
 */
class BoxEreignisTorTest {

    private final MqttPahoMessageDrivenChannelAdapter adapter = mock(MqttPahoMessageDrivenChannelAdapter.class);
    private final EventsTopicPruefung eventsTopic = mock(EventsTopicPruefung.class);

    @Test
    void derAdapterWartetBisDasTopicDaIst() {
        BoxEreignisTor tor = new BoxEreignisTor(adapter, eventsTopic, false);
        when(eventsTopic.vorhanden()).thenReturn(false);
        assertThat(tor.versuche()).isFalse();
        verify(adapter, never()).start();

        when(eventsTopic.vorhanden()).thenReturn(true);
        assertThat(tor.versuche()).isTrue();
        verify(adapter).start();
    }

    @Test
    void derTaktOeffnetDasTorSobaldDasTopicErscheint() {
        when(eventsTopic.vorhanden()).thenReturn(true);
        BoxEreignisTor tor = new BoxEreignisTor(adapter, eventsTopic, false);
        tor.start();
        try {
            verify(adapter, timeout(2_000)).start();
            assertThat(tor.isRunning()).isTrue();
        } finally {
            tor.stop();
        }
    }

    /** Wer Integrations-Endpunkte abschaltet (Tests ohne Broker), schaltet auch das Tor ab. */
    @Test
    void einAbgeschaltetesTorStartetNie() {
        when(eventsTopic.vorhanden()).thenReturn(true);
        BoxEreignisTor tor = new BoxEreignisTor(adapter, eventsTopic, true);
        tor.start();
        try {
            verify(adapter, after(300).never()).start();
        } finally {
            tor.stop();
        }
    }
}
