package com.voltpilot.ingest;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.SmartLifecycle;
import org.springframework.integration.context.IntegrationContextUtils;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;
import org.springframework.stereotype.Component;
import org.springframework.util.PatternMatchUtils;

/**
 * Das Tor vor dem Box-Weg {@code …/v2/events} (UEMS AP-07 IP-5, Entscheid b07-recreate D): der
 * Adapter ({@link MqttEventsIngestConfig}, ohne Autostart) verbindet sich und konsumiert erst,
 * wenn es das Topic {@code events.raw} gibt — sonst hinge er an der ersten Sendung. Bis dahin
 * fragt ein eigener Takt alle {@link EventsTopicPruefung#ERNEUT_NACH}; nach dem Start endet er.
 * Heute sendet keine Box Ereignisse (Edge-Release IP-18/IP-19), es geht also nichts verloren; ab
 * dann hält die persistente Sitzung die Umschläge beim Broker, bis das Tor aufgeht.
 *
 * <p>Wer Integrations-Endpunkte per {@code spring.integration.endpoints.no-auto-startup}
 * abschaltet (Tests ohne Broker), schaltet auch dieses Tor ab.
 */
@Component
public class BoxEreignisTor implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(BoxEreignisTor.class);

    private final MqttPahoMessageDrivenChannelAdapter adapter;
    private final EventsTopicPruefung pruefung;
    private final boolean abgeschaltet;
    private ScheduledExecutorService takt;
    private volatile boolean laeuft;

    @Autowired
    public BoxEreignisTor(
            @Qualifier(MqttEventsIngestConfig.ADAPTER) MqttPahoMessageDrivenChannelAdapter adapter,
            EventsTopicPruefung pruefung, BeanFactory beanFactory) {
        this(adapter, pruefung, PatternMatchUtils.simpleMatch(IntegrationContextUtils
                .getIntegrationProperties(beanFactory).getNoAutoStartupEndpoints(), MqttEventsIngestConfig.ADAPTER));
    }

    BoxEreignisTor(MqttPahoMessageDrivenChannelAdapter adapter, EventsTopicPruefung pruefung,
            boolean abgeschaltet) {
        this.adapter = adapter;
        this.pruefung = pruefung;
        this.abgeschaltet = abgeschaltet;
    }

    /** Ein Versuch: gibt es das Topic, verbindet sich der Adapter. {@code true} = das Tor ist offen. */
    boolean versuche() {
        if (adapter.isRunning()) {
            return true;
        }
        if (!pruefung.vorhanden()) {
            return false;
        }
        adapter.start();
        log.info("events.raw vorhanden - der Box-Ereignis-Adapter verbindet sich");
        return true;
    }

    @Override
    public synchronized void start() {
        laeuft = true;
        if (abgeschaltet) {
            return;
        }
        takt = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "box-ereignis-tor");
            t.setDaemon(true);
            return t;
        });
        takt.scheduleWithFixedDelay(() -> {
            try {
                if (versuche()) {
                    takt.shutdown();
                }
            } catch (RuntimeException e) {
                log.warn("Box-Ereignis-Tor: Versuch fehlgeschlagen, nächster in {} s",
                        EventsTopicPruefung.ERNEUT_NACH.toSeconds(), e);
            }
        }, 0, EventsTopicPruefung.ERNEUT_NACH.toSeconds(), TimeUnit.SECONDS);
    }

    @Override
    public synchronized void stop() {
        if (takt != null) {
            takt.shutdownNow();
        }
        laeuft = false;
    }

    @Override
    public boolean isRunning() {
        return laeuft;
    }
}
