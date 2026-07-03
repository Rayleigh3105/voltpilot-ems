package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Pure unit proof for the coalescing / non-fatal reload logic (the EMQX REST
 * call itself is a mocked {@link BrokerAuthzReloader.FileSourceUpdater} - the
 * real HTTP path is proven live against EMQX 5.8.3, see AGENTS.md).
 */
class BrokerAuthzReloaderTest {

    @TempDir
    Path dir;

    /** A synchronous scheduler so {@code requestReload()} runs the task inline. */
    private static ScheduledExecutorService inlineScheduler() {
        return new java.util.concurrent.ScheduledThreadPoolExecutor(1) {
            @Override
            public java.util.concurrent.ScheduledFuture<?> schedule(Runnable command, long delay,
                    TimeUnit unit) {
                command.run();
                return null;
            }
        };
    }

    @Test
    void reloadPushesTheCurrentAclFileContent() throws Exception {
        Path acl = Files.writeString(dir.resolve("acl.conf"), "{allow, all}.\n", StandardCharsets.UTF_8);
        AtomicReference<String> pushed = new AtomicReference<>();
        BrokerAuthzReloader reloader = new BrokerAuthzReloader(acl, pushed::set, 0, inlineScheduler());

        reloader.reloadNow();

        assertThat(pushed.get()).isEqualTo("{allow, all}.\n");
    }

    @Test
    void reloadIsNonFatalWhenTheBrokerCallFails() throws Exception {
        Path acl = Files.writeString(dir.resolve("acl.conf"), "rules", StandardCharsets.UTF_8);
        BrokerAuthzReloader reloader = new BrokerAuthzReloader(acl, r -> {
            throw new RuntimeException("EMQX unreachable");
        }, 0, inlineScheduler());

        // A reload failure must never propagate to the caller (issuance/unclaim).
        assertThatCode(reloader::reloadNow).doesNotThrowAnyException();
        assertThatCode(reloader::requestReload).doesNotThrowAnyException();
    }

    @Test
    void reloadIsNonFatalWhenTheAclFileIsMissing() {
        BrokerAuthzReloader reloader = new BrokerAuthzReloader(dir.resolve("does-not-exist.conf"),
                r -> {
                    throw new AssertionError("must not attempt a push without file content");
                }, 0, inlineScheduler());

        assertThatCode(reloader::reloadNow).doesNotThrowAnyException();
    }

    @Test
    void burstsAreCoalescedIntoASingleReload() throws Exception {
        Path acl = Files.writeString(dir.resolve("acl.conf"), "v1", StandardCharsets.UTF_8);
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<String> last = new AtomicReference<>();
        // Deferred scheduler: capture the task, run it once on demand - models the
        // debounce window collapsing many requests into one delayed run.
        AtomicReference<Runnable> pending = new AtomicReference<>();
        ScheduledExecutorService deferring = new java.util.concurrent.ScheduledThreadPoolExecutor(1) {
            @Override
            public java.util.concurrent.ScheduledFuture<?> schedule(Runnable command, long delay,
                    TimeUnit unit) {
                pending.set(command);
                return null;
            }
        };
        BrokerAuthzReloader reloader = new BrokerAuthzReloader(acl, rules -> {
            calls.incrementAndGet();
            last.set(rules);
        }, 5, deferring);

        reloader.requestReload();
        reloader.requestReload();
        reloader.requestReload();
        // Only one task was scheduled for the whole burst.
        Files.writeString(acl, "v2", StandardCharsets.UTF_8); // latest content wins
        pending.get().run();

        assertThat(calls.get()).isEqualTo(1);
        assertThat(last.get()).isEqualTo("v2");

        // After the run drains, a fresh request schedules again (no lost updates).
        reloader.requestReload();
        assertThat(pending.get()).isNotNull();
        pending.get().run();
        assertThat(calls.get()).isEqualTo(2);
    }
}
