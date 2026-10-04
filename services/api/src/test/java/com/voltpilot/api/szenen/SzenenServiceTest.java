package com.voltpilot.api.szenen;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.consumers.ConsumerPolicyActivationService;
import com.voltpilot.api.consumers.ConsumerPolicyActivationService.ActivationOutcome;
import com.voltpilot.api.consumers.ConsumerRepository;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.consumers.ConsumerRepository.PolicyRow;
import com.voltpilot.api.repo.SiteSceneRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Szenen ohne Docker: der Dienst ruft nur den bestehenden Pausen- und
 * Fortsetzungsweg und merkt sich, was ER pausiert hat.
 */
class SzenenServiceTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID POOL = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    private static final UUID KLIMA = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    private static final UUID FREMD = UUID.fromString("00000000-0000-0000-0000-00000000000c");

    private ConsumerRepository consumers;
    private ConsumerPolicyActivationService activation;
    private SiteSceneRepository store;
    private SzenenService dienst;

    @BeforeEach
    void setUp() {
        consumers = mock(ConsumerRepository.class);
        activation = mock(ConsumerPolicyActivationService.class);
        store = mock(SiteSceneRepository.class);
        dienst = new SzenenService(consumers, activation, store);
        when(activation.resumeAvailable()).thenReturn(true);
        geraet(POOL, "Poolpumpe", true, true);
        geraet(KLIMA, "Klimagerät", true, true);
    }

    private void geraet(UUID id, String name, boolean enabled, boolean auftrag) {
        when(consumers.findForSite(SITE, id)).thenReturn(new ConsumerRow(id, "pump", name, null,
                "src", "on_off", BigDecimal.ONE, null, null, null, null, "neutral", null, false, null,
                null, null, null, null, null, "off", enabled, 1L));
        when(consumers.activePolicy(SITE, id)).thenReturn(auftrag
                ? new PolicyRow(UUID.randomUUID(), id, 1, "active", "{}", "h", "t", Instant.now())
                : null);
    }

    @Test
    @DisplayName("Einschalten pausiert die gewählten Geräte und merkt sich genau diese")
    void einschalten() {
        geraet(KLIMA, "Klimagerät", false, true); // schon vorher pausiert
        SzenenService.Ergebnis e = dienst.starten(SITE, "urlaub", List.of(POOL, KLIMA, POOL), "kunde");
        verify(activation).pause(SITE, POOL, "kunde");
        verify(activation, never()).pause(SITE, KLIMA, "kunde");
        verify(store).upsert(SITE, "urlaub", List.of(POOL), "kunde");
        assertThat(e.offen()).isEmpty();
    }

    @Test
    @DisplayName("Ein unbekanntes Gerät oder eines ohne Auftrag schaltet gar nichts")
    void pruefenVorDemSchalten() {
        assertThatThrownBy(() -> dienst.starten(SITE, "urlaub", List.of(POOL, FREMD), "k"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(x -> assertThat(((ResponseStatusException) x).getStatusCode())
                        .isEqualTo(HttpStatus.NOT_FOUND));
        geraet(FREMD, "Trockner", true, false);
        assertThatThrownBy(() -> dienst.starten(SITE, "urlaub", List.of(POOL, FREMD), "k"))
                .hasMessageContaining("noch keinen Auftrag");
        assertThatThrownBy(() -> dienst.starten(SITE, "party", List.of(POOL), "k"))
                .hasMessageContaining("Unbekannte Szene");
        assertThatThrownBy(() -> dienst.starten(SITE, "urlaub", List.of(), "k"))
                .hasMessageContaining("mindestens ein Gerät");
        verify(activation, never()).pause(any(), any(), any());
        verify(store, never()).upsert(any(), any(), anyList(), any());
    }

    @Test
    @DisplayName("Ohne freigegebene Steuerung pausiert keine Szene, die sie nicht fortsetzen könnte")
    void ohneFreigabe() {
        when(activation.resumeAvailable()).thenReturn(false);
        assertThatThrownBy(() -> dienst.starten(SITE, "urlaub", List.of(POOL), "k"))
                .hasMessageContaining("nicht aktiviert");
        verify(activation, never()).pause(any(), any(), any());
    }

    @Test
    @DisplayName("Ein Fehler mitten im Lauf lässt das schon Pausierte in der Szene")
    void fehlerImLauf() {
        doThrow(new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "weg"))
                .when(activation).pause(SITE, KLIMA, "k");
        assertThatThrownBy(() -> dienst.starten(SITE, "unterwegs", List.of(POOL, KLIMA), "k"))
                .isInstanceOf(ResponseStatusException.class);
        verify(store).upsert(SITE, "unterwegs", List.of(POOL), "k");
    }

    @Test
    @DisplayName("Beenden setzt nur fort, was die Szene pausiert hat und noch pausiert ist")
    void beenden() {
        geraet(POOL, "Poolpumpe", false, true);
        geraet(KLIMA, "Klimagerät", true, true); // zwischendurch selbst fortgesetzt
        when(store.find(SITE)).thenReturn(
                new SiteSceneRepository.Row("urlaub", List.of(POOL, KLIMA), Instant.now(), "k"));
        when(activation.resume(SITE, POOL, "k"))
                .thenReturn(new ActivationOutcome(true, null, "ok", true, 1));
        SzenenService.Ergebnis e = dienst.beenden(SITE, "k");
        verify(activation).resume(SITE, POOL, "k");
        verify(activation, never()).resume(SITE, KLIMA, "k");
        verify(store).delete(SITE);
        assertThat(e.szene()).isNull();
        assertThat(e.message()).contains("Alles wieder wie vorher");
    }

    @Test
    @DisplayName("Was nicht fortgesetzt werden kann, bleibt in der Szene und wird benannt")
    void beendenMitRest() {
        geraet(POOL, "Poolpumpe", false, true);
        when(store.find(SITE)).thenReturn(
                new SiteSceneRepository.Row("urlaub", List.of(POOL), Instant.now(), "k"));
        when(activation.resume(SITE, POOL, "k")).thenThrow(
                new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Box nicht erreichbar"));
        SzenenService.Ergebnis e = dienst.beenden(SITE, "k");
        verify(store).setzePausiert(eq(SITE), eq(List.of(POOL)));
        verify(store, never()).delete(SITE);
        assertThat(e.offen()).containsExactly("Poolpumpe: Box nicht erreichbar");
    }

    @Test
    @DisplayName("Beenden ohne Szene ist kein Fehler")
    void beendenOhneSzene() {
        assertThat(dienst.beenden(SITE, "k").szene()).isNull();
        verify(store, never()).delete(SITE);
    }
}
