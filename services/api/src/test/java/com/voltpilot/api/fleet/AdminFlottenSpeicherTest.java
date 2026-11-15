package com.voltpilot.api.fleet;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.EdgeUpdatesDto;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * Das kurze Festhalten der Admin-Flottenantworten (Lasttest vp-lasttest, Befund B6, Rang 5): innerhalb der
 * Gültigkeit wird nicht neu gerechnet, gleichzeitige Abrufe teilen EINE Berechnung, und jede schreibende
 * Admin-Anfrage verwirft den Stand - auch eine Berechnung, die während der Schreibhandlung lief.
 */
class AdminFlottenSpeicherTest {

    private static final Instant T0 = Instant.parse("2026-11-15T12:00:00Z");

    private static final class Uhr extends Clock {
        private Instant jetzt = T0;

        void weiter(Duration d) {
            jetzt = jetzt.plus(d);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return jetzt;
        }
    }

    private static EdgeUpdatesDto antwort() {
        return new EdgeUpdatesDto(List.of(), List.of(), List.of(), List.of(),
                new EdgeUpdatesDto.KpiDto(0, 0, 0, 0, 0, null), List.of());
    }

    @Test
    void innerhalbDerGueltigkeitWirdNichtNeuGerechnetDanachSchon() {
        Uhr uhr = new Uhr();
        AdminFlottenSpeicher s = new AdminFlottenSpeicher(Duration.ofSeconds(15), uhr);
        AtomicInteger gerechnet = new AtomicInteger();

        EdgeUpdatesDto erste = s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });
        uhr.weiter(Duration.ofSeconds(14));
        EdgeUpdatesDto zweite = s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });
        assertThat(gerechnet).hasValue(1);
        assertThat(zweite).isSameAs(erste);

        uhr.weiter(Duration.ofSeconds(1));
        s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });
        assertThat(gerechnet).hasValue(2);
    }

    @Test
    void eineSchreibendeAdminAnfrageVerwirftDenStandSofort() throws Exception {
        Uhr uhr = new Uhr();
        AdminFlottenSpeicher s = new AdminFlottenSpeicher(Duration.ofSeconds(15), uhr);
        AtomicInteger gerechnet = new AtomicInteger();
        s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });

        MockHttpServletRequest post = new MockHttpServletRequest("POST", "/api/v1/admin/edge-updates/rollouts");
        new AdminFlottenSpeicher.Schreibstand(s).doFilter(post, new MockHttpServletResponse(), new MockFilterChain());

        s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });
        assertThat(gerechnet).as("nach dem Verteilen sofort neu, nicht erst nach 15 s").hasValue(2);
    }

    @Test
    void leseAnfragenUndKundenroutenVerwerfenNichts() throws Exception {
        Uhr uhr = new Uhr();
        AdminFlottenSpeicher s = new AdminFlottenSpeicher(Duration.ofSeconds(15), uhr);
        AtomicInteger gerechnet = new AtomicInteger();
        s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });
        AdminFlottenSpeicher.Schreibstand filter = new AdminFlottenSpeicher.Schreibstand(s);
        filter.doFilter(new MockHttpServletRequest("GET", "/api/v1/admin/fleet"), new MockHttpServletResponse(),
                new MockFilterChain());
        filter.doFilter(new MockHttpServletRequest("POST", "/api/v1/sites/x/settings"),
                new MockHttpServletResponse(), new MockFilterChain());
        s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });
        assertThat(gerechnet).hasValue(1);
    }

    /**
     * Eine Berechnung, die begann, bevor eine Schreibhandlung fertig war, gilt danach nicht: der Schreibstand zählt
     * auch NACH der Verarbeitung weiter.
     */
    @Test
    void eineWaehrendDesSchreibensBegonneneBerechnungGiltDanachNicht() throws Exception {
        Uhr uhr = new Uhr();
        AdminFlottenSpeicher s = new AdminFlottenSpeicher(Duration.ofSeconds(15), uhr);
        AtomicInteger gerechnet = new AtomicInteger();
        MockHttpServletRequest post = new MockHttpServletRequest("POST", "/api/v1/admin/edge-updates/rollouts");
        // Die "Schreibhandlung" rechnet mittendrin einmal (wie ein gleichzeitiger Abruf, der den alten Stand liest).
        MockFilterChain kette = new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest request, jakarta.servlet.ServletResponse response) {
                s.edgeUpdates(() -> {
                    gerechnet.incrementAndGet();
                    return antwort();
                });
            }
        };
        new AdminFlottenSpeicher.Schreibstand(s).doFilter(post, new MockHttpServletResponse(), kette);
        s.edgeUpdates(() -> {
            gerechnet.incrementAndGet();
            return antwort();
        });
        assertThat(gerechnet).hasValue(2);
    }

    @Test
    void gleichzeitigeAbrufeTeilenEineBerechnung() throws Exception {
        AdminFlottenSpeicher s = new AdminFlottenSpeicher(Duration.ofSeconds(15), Clock.systemUTC());
        AtomicInteger gerechnet = new AtomicInteger();
        CountDownLatch rechnetGerade = new CountDownLatch(1);
        CountDownLatch weiter = new CountDownLatch(1);
        ExecutorService tabs = Executors.newFixedThreadPool(6);
        try {
            List<Future<EdgeUpdatesDto>> abrufe = new ArrayList<>();
            abrufe.add(tabs.submit(() -> s.edgeUpdates(() -> {
                gerechnet.incrementAndGet();
                rechnetGerade.countDown();
                try {
                    weiter.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return antwort();
            })));
            assertThat(rechnetGerade.await(5, TimeUnit.SECONDS)).isTrue();
            for (int i = 0; i < 5; i++) {
                abrufe.add(tabs.submit(() -> s.edgeUpdates(() -> {
                    gerechnet.incrementAndGet();
                    return antwort();
                })));
            }
            Thread.sleep(100);
            weiter.countDown();
            EdgeUpdatesDto erste = abrufe.get(0).get(5, TimeUnit.SECONDS);
            for (Future<EdgeUpdatesDto> f : abrufe) {
                assertThat(f.get(5, TimeUnit.SECONDS)).isSameAs(erste);
            }
            assertThat(gerechnet).as("sechs Tabs, eine Berechnung").hasValue(1);
        } finally {
            tabs.shutdownNow();
        }
    }

    @Test
    void ohneGueltigkeitRechnetJederAbruf() {
        AdminFlottenSpeicher s = AdminFlottenSpeicher.aus();
        AtomicInteger gerechnet = new AtomicInteger();
        for (int i = 0; i < 3; i++) {
            s.edgeUpdates(() -> {
                gerechnet.incrementAndGet();
                return antwort();
            });
        }
        assertThat(gerechnet).hasValue(3);
    }
}
