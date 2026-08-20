package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/**
 * Der Warteraum - und vor allem sein NEUER dritter Ausgang.
 *
 * <p>Bis zum 20.08.2026 kannte er nur „zugestellt" und „weg": eine Quittung, die
 * Sekunden nach dem Timeout eintraf, fand nichts mehr vor und verschwand
 * SPURLOS. Aus dem api-Protokoll war „das Gerät hat nie geantwortet" damit nicht
 * von „das Gerät hat zu spät geantwortet" zu unterscheiden - und genau diese
 * Unterscheidung war die Diagnose des Vorfalls.
 */
class RegisterWriteRegistryTest {

    private final RegisterWriteRegistry registry = new RegisterWriteRegistry();
    private final UUID device = UUID.randomUUID();

    private static RegisterWriteResult result(String requestId) {
        return RegisterWriteResult.silent(requestId, RegisterWriteResult.MODE_READ, "egal");
    }

    @Test
    void aWaitingCallGetsItsAnswer() {
        CompletableFuture<RegisterWriteResult> future = registry.register("aaaa1111bbbb2222", device);
        assertThat(registry.complete(device, "aaaa1111bbbb2222", result("aaaa1111bbbb2222")))
                .isEqualTo(RegisterWriteRegistry.Delivery.DELIVERED);
        assertThat(registry.await(future, Duration.ofMillis(200))).isNotNull();
        assertThat(registry.lastLateAnswer(device)).isEmpty();
    }

    /** Der Fall des Vorfalls: der Aufruf gab auf, die Antwort kam trotzdem. */
    @Test
    void anAnswerAfterTheCallGaveUpIsLateAndIsRemembered() {
        registry.register("aaaa1111bbbb3333", device);
        registry.forget("aaaa1111bbbb3333");
        assertThat(registry.complete(device, "aaaa1111bbbb3333", result("aaaa1111bbbb3333")))
                .isEqualTo(RegisterWriteRegistry.Delivery.LATE);
        assertThat(registry.lastLateAnswer(device)).isPresent();
        assertThat(registry.lastLateAnswer(device).orElseThrow().requestId())
                .isEqualTo("aaaa1111bbbb3333");
        // Und sie wird nur EINMAL zugestellt - ein zweiter Anlauf findet nichts.
        assertThat(registry.complete(device, "aaaa1111bbbb3333", result("aaaa1111bbbb3333")))
                .isEqualTo(RegisterWriteRegistry.Delivery.UNKNOWN);
    }

    /**
     * ⚠ Das GERÄT bleibt Teil des Schlüssels: eine Antwort von einem anderen
     * Gerät ist keine - und sie darf auch nicht als „zu spät" gelten, sonst
     * lernte die nächste Anfrage etwas Falsches über ihre eigene Anlage.
     */
    @Test
    void anAnswerFromAnotherDeviceIsNeitherDeliveredNorRememberedAsLate() {
        registry.register("aaaa1111bbbb4444", device);
        registry.forget("aaaa1111bbbb4444");
        UUID other = UUID.randomUUID();
        assertThat(registry.complete(other, "aaaa1111bbbb4444", result("aaaa1111bbbb4444")))
                .isEqualTo(RegisterWriteRegistry.Delivery.UNKNOWN);
        assertThat(registry.lastLateAnswer(other)).isEmpty();
        assertThat(registry.lastLateAnswer(device)).isEmpty();
    }

    @Test
    void anAnswerToSomethingNobodyEverAskedIsUnknown() {
        assertThat(registry.complete(device, "aaaa1111bbbb5555", result("aaaa1111bbbb5555")))
                .isEqualTo(RegisterWriteRegistry.Delivery.UNKNOWN);
    }

    /** Aufgeben darf den Zeitpunkt des Aufgebens nicht überschreiben. */
    @Test
    void givingUpTwiceKeepsTheFirstMoment() throws Exception {
        registry.register("aaaa1111bbbb6666", device);
        registry.forget("aaaa1111bbbb6666");
        Thread.sleep(30);
        registry.forget("aaaa1111bbbb6666");
        registry.complete(device, "aaaa1111bbbb6666", result("aaaa1111bbbb6666"));
        assertThat(registry.lastLateAnswer(device).orElseThrow().lateBy())
                .isGreaterThanOrEqualTo(Duration.ofMillis(25));
    }
}
