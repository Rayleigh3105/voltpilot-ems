package com.voltpilot.api.rules;

import com.voltpilot.api.flows.FlowService;
import com.voltpilot.api.flows.FlowService.EntityStrategyDto;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.FlowStatusRepository;
import com.voltpilot.api.repo.RuleEventRepository;
import com.voltpilot.api.repo.RuleEventRepository.NewEvent;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * Der CLOUD-seitige Schreiber des Regel-Protokolls (Einheitsmodell Stufe 5b,
 * Teil 5b.6). Er reitet auf den BESTEHENDEN Herzschlag-Zuhörern - dem
 * Verbraucher-Zuhörer (der Schalt-Verlauf) und dem Flow-Zuhörer (der Verlauf
 * der Regel selbst) - und hält nur die WECHSEL fest. Das ist wörtlich das
 * {@link com.voltpilot.api.consumers.ConsumerRequirementLedgerWriter}-Muster:
 * telemetrie-getrieben, kein eigener Broker, kein {@code @Scheduled}.
 *
 * <p><b>Er wirft NIE.</b> Ein Verlauf ist eine Anzeige-Wahrheit; er darf den
 * Ingest, an dem Steuerung und Erfüllung hängen, unter keinen Umständen
 * versenken. Der Mandanten-Kontext ist vom Zuhörer bereits gesetzt, jeder
 * Lese-/Schreibpfad hier ist also RLS-gefenced.
 *
 * <p><b>Die Zuordnung Ereignis → Regel ist die V-5-Invariante, nie eine
 * Heuristik</b> (Konzept D-i): höchstens EINE aktive Regel je Komponente. Also
 * gilt der Reihe nach - eine aktive Verbraucher-Regel auf der Komponente
 * ({@code rezept}), sonst der D-13-Anspruch eines aktiven Flows ({@code flow}),
 * sonst GAR KEINE Zuordnung. Das Ergebnis wird als SCHNAPPSCHUSS gespeichert
 * (das {@code rollout_device.device_ref}-Muster): wer die Regel morgen tauscht,
 * schreibt damit die Vergangenheit nicht um.
 */
@Component
public class RuleEventWriter {

    private static final Logger log = LoggerFactory.getLogger(RuleEventWriter.class);

    /** Die Zuordnungs-Arten - sie bilden den Kartenschlüssel der Fläche. */
    public static final String RULE_REZEPT = "rezept";
    public static final String RULE_FLOW = "flow";

    /**
     * Die Genauigkeit, die die Fläche NENNEN muss: abgeleitet wird aus Wechseln
     * im 15-Sekunden-Herzschlag, ein Wechsel-und-zurück dazwischen ist
     * unsichtbar.
     */
    public static final int ACCURACY_SECONDS = 15;

    /** Aufbewahrung (siehe die Begründung in der Migration). */
    static final Duration RETENTION = Duration.ofDays(90);
    /** Höchstens so viele Zeilen je Aufräum-Lauf - nie eine lange Transaktion. */
    static final int PRUNE_BATCH = 5_000;
    /** Und höchstens so oft je api-Instanz. */
    static final Duration PRUNE_EVERY = Duration.ofHours(1);

    /**
     * Der Tages-Deckel je Anlage. Er schützt die TABELLE vor einem flatternden
     * Gerät, ist aber bewusst so hoch, dass er im Betrieb nie greift: 1000
     * Zustandswechsel an EINEM Tag auf EINER Anlage sind längst kein Verlauf
     * mehr, sondern ein Defekt. Greift er, schreibt er sich SELBST ins
     * Protokoll, statt still zu kappen.
     */
    static final int MAX_EVENTS_PER_SITE_DAY = 1_000;

    private final RuleEventRepository store;
    private final ObjectProvider<FlowService> flows;
    private final AtomicReference<Instant> lastPrune = new AtomicReference<>(null);

    public RuleEventWriter(RuleEventRepository store, ObjectProvider<FlowService> flows) {
        this.store = store;
        this.flows = flows;
    }

    /**
     * Der Schalt-Verlauf: was hat sich seit dem letzten Herzschlag DIESES
     * Geräts an seinen Verbraucher-Komponenten geändert.
     */
    public void ingestConsumers(UUID siteId, List<ConsumerRuntimeStatusRepository.Row> previous,
            List<ConsumerRuntimeStatusRepository.Row> current, Instant at) {
        ingest(siteId, () -> RuleEvents.deriveConsumerEvents(previous, current), at);
    }

    /** Der Verlauf der Regel selbst: Ausrollen und Geräte-Probleme. */
    public void ingestAcks(UUID siteId, List<FlowStatusRepository.Ack> previous,
            List<FlowStatusRepository.Ack> current, Instant at) {
        ingest(siteId, () -> RuleEvents.deriveAckEvents(previous, current), at);
    }

    private void ingest(UUID siteId, java.util.function.Supplier<List<RuleEvents.Event>> derive,
            Instant at) {
        try {
            // Der Aufzeichnungs-Beginn wird bei JEDEM Herzschlag festgehalten
            // (der erste gewinnt) - sonst begänne der Verlauf einer stillen
            // Anlage erst mit ihrem ersten Wechsel, und eine 0 wäre bis dahin
            // eine Behauptung über eine Zeit, in der niemand hingesehen hat.
            store.markRecording(siteId, at);
            List<RuleEvents.Event> events = derive.get();
            if (!events.isEmpty()) {
                append(siteId, events, at);
            }
            pruneIfDue(at);
        } catch (Exception e) {
            log.warn("Regel-Protokoll für Anlage {} konnte nicht fortgeschrieben werden: {}",
                    siteId, e.getMessage());
        }
    }

    private void append(UUID siteId, List<RuleEvents.Event> events, Instant at) {
        Instant dayStart = RuleEvents.berlinDayStart(at);
        if (deckelGreift(siteId, dayStart, at)) {
            return;
        }
        Attribution attribution = new Attribution(siteId);
        List<NewEvent> rows = new ArrayList<>(events.size());
        for (RuleEvents.Event e : events) {
            String kind;
            String ref;
            if (e.flowId() != null) {
                // Ein Ausroll-Ereignis IST das Ereignis dieser Regel - hier
                // gibt es nichts aufzulösen.
                kind = RULE_FLOW;
                ref = e.flowId().toString();
            } else {
                ref = attribution.refFor(e.entityId());
                kind = ref == null ? null : attribution.lastKind;
            }
            rows.add(new NewEvent(e.entityId(), kind, ref, e.kind(), e.state(), e.previousState(),
                    e.reasonCode(), e.actualKw(), e.detail(), at));
        }
        store.append(siteId, rows);
    }

    /**
     * Der Tages-Deckel. Er kostet EINE Zählung, und die nur, wenn es überhaupt
     * etwas zu schreiben gibt. Greift er, wird genau EIN Vermerk geschrieben
     * (nicht bei jedem weiteren Wechsel einer) - die Fläche liest ihn als das,
     * was er ist: „ab hier haben wir nicht weiter protokolliert".
     */
    private boolean deckelGreift(UUID siteId, Instant dayStart, Instant at) {
        if (store.countSince(siteId, dayStart) < MAX_EVENTS_PER_SITE_DAY) {
            return false;
        }
        if (!RuleEvents.GEDECKELT.equals(store.newestKind(siteId).orElse(null))) {
            store.append(siteId, List.of(new NewEvent(null, null, null, RuleEvents.GEDECKELT,
                    null, null, null, null, null, at)));
            log.warn("Regel-Protokoll der Anlage {} hat den Tages-Deckel ({}) erreicht - "
                    + "bis Mitternacht wird nicht weiter protokolliert", siteId,
                    MAX_EVENTS_PER_SITE_DAY);
        }
        return true;
    }

    private void pruneIfDue(Instant now) {
        Instant last = lastPrune.get();
        if (last != null && last.plus(PRUNE_EVERY).isAfter(now)) {
            return;
        }
        if (!lastPrune.compareAndSet(last, now)) {
            return; // ein anderer Herzschlag räumt gerade auf
        }
        int removed = store.prune(now.minus(RETENTION), PRUNE_BATCH);
        if (removed > 0) {
            log.info("Regel-Protokoll: {} Ereignisse älter als {} Tage entfernt", removed,
                    RETENTION.toDays());
        }
    }

    /**
     * Die V-5-Auflösung, LAZY und je Ingest genau einmal - sie liest die
     * aktiven Verbraucher-Regeln und (nur wenn nötig) die D-13-Ansprüche der
     * aktiven Flows. Beides passiert ausschließlich, wenn wirklich ein Wechsel
     * anliegt; im Normalfall (nichts geändert) kostet das Protokoll keine
     * einzige zusätzliche Abfrage.
     */
    private final class Attribution {
        private final UUID siteId;
        private Set<UUID> mitRegel;
        private Map<String, List<EntityStrategyDto>> ansprueche;
        private String lastKind;

        private Attribution(UUID siteId) {
            this.siteId = siteId;
        }

        private String refFor(UUID entityId) {
            lastKind = null;
            if (entityId == null) {
                return null;
            }
            if (mitRegel == null) {
                mitRegel = store.entitiesWithActivePolicy(siteId);
            }
            if (mitRegel.contains(entityId)) {
                lastKind = RULE_REZEPT;
                return entityId.toString();
            }
            if (ansprueche == null) {
                ansprueche = flowAnsprueche();
            }
            List<EntityStrategyDto> claims = ansprueche.get(entityId.toString());
            if (claims == null || claims.isEmpty()) {
                return null; // ehrlich keiner Regel zuzuordnen - nie eine geratene
            }
            lastKind = RULE_FLOW;
            return claims.get(0).flowId().toString();
        }

        private Map<String, List<EntityStrategyDto>> flowAnsprueche() {
            FlowService service = flows.getIfAvailable();
            if (service == null) {
                return Map.of();
            }
            try {
                return service.entityStrategies(siteId);
            } catch (Exception e) {
                log.debug("Flow-Ansprüche der Anlage {} nicht lesbar: {}", siteId, e.getMessage());
                return Map.of();
            }
        }
    }
}
