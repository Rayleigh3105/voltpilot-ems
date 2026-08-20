package com.voltpilot.api.registerwrite;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
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
 *
 * <p><b>⚠ EINE AUFGEGEBENE ANFRAGE WIRD NICHT VERGESSEN, SIE WIRD MARKIERT</b>
 * (Produktionsvorfall 20.08.2026). Vorher entfernte {@code forget()} den
 * Eintrag; eine Sekunden später eintreffende Quittung fand nichts mehr vor und
 * wurde SPURLOS verworfen - im api-Protokoll war „das Gerät hat nie geantwortet"
 * von „das Gerät hat zu spät geantwortet" nicht zu unterscheiden, und genau
 * diese Unterscheidung WAR die Diagnose. Ein aufgegebener Vorgang bleibt
 * deshalb für {@link #LATE_GRACE} als AUFGEGEBEN stehen; trifft seine Antwort
 * doch noch ein, ist das ein eigener, benennbarer Ausgang
 * ({@link Delivery#LATE}), den der Zuhörer laut protokolliert und den die
 * NÄCHSTE Anfrage desselben Geräts als Grund nennen kann („die Anlage antwortet
 * zurzeit langsamer als das Zeitfenster").
 */
@Component
public class RegisterWriteRegistry {

    /** Nichts wartet länger; ein aufgegebener Eintrag kann nicht lecken. */
    private static final Duration TTL = Duration.ofMinutes(3);

    /**
     * Wie lange eine aufgegebene Anfrage als AUFGEGEBEN erinnert wird, damit
     * eine verspätete Antwort als solche erkennbar ist statt spurlos zu
     * verschwinden.
     */
    static final Duration LATE_GRACE = Duration.ofMinutes(3);

    /** Wie lange eine verspätete Antwort noch etwas über ein Gerät aussagt. */
    static final Duration LATE_MEMORY = Duration.ofMinutes(10);

    /** Was mit einer eintreffenden Quittung geschah - der Ausgang der Korrelation. */
    public enum Delivery {
        /** Zugestellt: es wartete jemand. */
        DELIVERED,
        /** Zu spät: der Aufruf hatte schon aufgegeben. */
        LATE,
        /** Unbekannt: keine Kennung, fremdes Gerät oder längst vergessen. */
        UNKNOWN
    }

    /** Eine verspätet beantwortete Anfrage - was die nächste Anfrage daraus lernt. */
    public record LateAnswer(String requestId, Duration lateBy, Instant at) {
    }

    private record Pending(UUID deviceId, Instant created, Instant abandonedAt,
            CompletableFuture<RegisterWriteResult> future) {

        boolean abandoned() {
            return abandonedAt != null;
        }
    }

    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<UUID, LateAnswer> lateByDevice = new ConcurrentHashMap<>();

    public CompletableFuture<RegisterWriteResult> register(String requestId, UUID deviceId) {
        purge();
        CompletableFuture<RegisterWriteResult> future = new CompletableFuture<>();
        pending.put(requestId, new Pending(deviceId, Instant.now(), null, future));
        return future;
    }

    /**
     * Der Aufruf gibt auf. Der Eintrag bleibt als AUFGEGEBEN stehen (siehe
     * {@link #LATE_GRACE}), damit eine verspätete Antwort erkennbar bleibt.
     */
    public void forget(String requestId) {
        pending.computeIfPresent(requestId, (id, p) -> p.abandoned()
                ? p
                : new Pending(p.deviceId(), p.created(), Instant.now(), p.future()));
    }

    /**
     * Eine Antwort zustellen und SAGEN, was mit ihr geschah. Eine Antwort von
     * einem ANDEREN Gerät oder zu einer unbekannten Kennung ist keine
     * ({@link Delivery#UNKNOWN}); eine zu einer aufgegebenen Anfrage ist
     * {@link Delivery#LATE} und wird als solche erinnert.
     */
    public Delivery complete(UUID deviceId, String requestId, RegisterWriteResult result) {
        Pending p = pending.get(requestId);
        if (p == null || !p.deviceId().equals(deviceId)) {
            return Delivery.UNKNOWN;
        }
        pending.remove(requestId);
        if (p.abandoned()) {
            Duration lateBy = Duration.between(p.abandonedAt(), Instant.now());
            lateByDevice.put(deviceId, new LateAnswer(requestId,
                    lateBy.isNegative() ? Duration.ZERO : lateBy, Instant.now()));
            return Delivery.LATE;
        }
        p.future().complete(result);
        return Delivery.DELIVERED;
    }

    /**
     * Die jüngste VERSPÄTETE Antwort dieses Geräts, solange sie noch etwas über
     * seinen Zustand aussagt - die Grundlage für den ehrlichen Satz „die Anlage
     * antwortet zurzeit langsamer als das Zeitfenster".
     */
    public Optional<LateAnswer> lastLateAnswer(UUID deviceId) {
        LateAnswer late = lateByDevice.get(deviceId);
        if (late == null) {
            return Optional.empty();
        }
        if (late.at().isBefore(Instant.now().minus(LATE_MEMORY))) {
            lateByDevice.remove(deviceId, late);
            return Optional.empty();
        }
        return Optional.of(late);
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
        Instant now = Instant.now();
        Instant cutoff = now.minus(TTL);
        Instant graceCutoff = now.minus(LATE_GRACE);
        pending.entrySet().removeIf(e -> {
            Pending p = e.getValue();
            return p.abandoned()
                    ? p.abandonedAt().isBefore(graceCutoff)
                    : p.created().isBefore(cutoff);
        });
        Instant lateCutoff = now.minus(LATE_MEMORY);
        lateByDevice.entrySet().removeIf(e -> e.getValue().at().isBefore(lateCutoff));
    }
}
