package com.voltpilot.api.registerwrite;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.stereotype.Component;

/**
 * Verbindet einen laufenden Register-Vorgang mit dem Request-Thread, der auf ihn
 * wartet - wörtlich das {@link com.voltpilot.api.probe.ProbeRegistry}-Muster.
 *
 * <p><b>Im Speicher, mit Absicht.</b> Die Korrelation lebt Sekunden; ein
 * api-Neustart vergisst sie, der Aufruf läuft in seinen Timeout und die
 * Oberfläche sagt ehrlich „Zustand unbekannt". Persistiert wird stattdessen das,
 * was bleiben MUSS: die Papier-Spur im Journal ({@code register_write_event}) -
 * und die schreibt der Quittungs-Zuhörer UNABHÄNGIG von diesem Warteraum, damit
 * eine Sekunden später eintreffende Quittung nicht verloren geht, nur weil
 * niemand mehr wartet.
 *
 * <p><b>Das Gerät ist Teil des Schlüssels</b>, nicht nur die Kennung: eine
 * Antwort wird nur von dem Gerät angenommen, an das die Frage ging - dieselbe
 * dritte Sicherung wie beim Probe-Kanal.
 */
@Component
public class RegisterWriteRegistry {

    /** Nichts wartet länger; ein aufgegebener Eintrag kann nicht lecken. */
    private static final Duration TTL = Duration.ofMinutes(3);

    private record Pending(UUID deviceId, Instant created,
            CompletableFuture<RegisterWriteResult> future) {
    }

    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();

    public CompletableFuture<RegisterWriteResult> register(String requestId, UUID deviceId) {
        purge();
        CompletableFuture<RegisterWriteResult> future = new CompletableFuture<>();
        pending.put(requestId, new Pending(deviceId, Instant.now(), future));
        return future;
    }

    public void forget(String requestId) {
        pending.remove(requestId);
    }

    /**
     * Eine Antwort zustellen. Ignoriert, wenn die Kennung unbekannt ist (längst
     * aufgegeben) oder von einem ANDEREN Gerät kommt - eine Antwort, die sich
     * nicht zuordnen lässt, ist keine.
     */
    public void complete(UUID deviceId, String requestId, RegisterWriteResult result) {
        Pending p = pending.get(requestId);
        if (p == null || !p.deviceId().equals(deviceId)) {
            return;
        }
        pending.remove(requestId);
        p.future().complete(result);
    }

    /** Warten, oder {@code null} bei Zeitablauf - ein ehrlicher AUSGANG, kein Fehler. */
    public RegisterWriteResult await(CompletableFuture<RegisterWriteResult> future,
            Duration timeout) {
        try {
            return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        pending.entrySet().removeIf(e -> e.getValue().created().isBefore(cutoff));
    }
}
