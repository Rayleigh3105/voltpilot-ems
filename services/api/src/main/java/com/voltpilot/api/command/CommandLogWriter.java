package com.voltpilot.api.command;

import com.voltpilot.api.command.CommandLog.Detail;
import com.voltpilot.api.command.CommandLog.Event;
import com.voltpilot.api.command.CommandLog.Observation;
import com.voltpilot.api.command.CommandLog.OpenPeriod;
import com.voltpilot.api.command.CommandLog.Plan;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Der CLOUD-seitige Schreiber des Kommando-Verlaufs (Kommando-Transparenz V1,
 * Konzept {@code vp-kommando-transparenz-k3} §6.2). Er reitet auf den DREI
 * bestehenden Herzschlag-Zuhörern - Steuerung, Abregelung, Verbraucher - und
 * schreibt aus dem Vergleich ALT gegen NEU HALTEPERIODEN fort. Das ist wörtlich
 * das {@link com.voltpilot.api.rules.RuleEventWriter}-Muster: telemetrie-getrieben,
 * kein eigener Broker, kein {@code @Scheduled}, kein neues Flag.
 *
 * <p><b>Er wirft NIE.</b> Ein Verlauf ist eine Anzeige-Wahrheit; er darf den
 * Ingest, an dem Steuerung und Abregelung hängen, unter keinen Umständen
 * versenken. Der Mandanten-Kontext ist vom Zuhörer bereits gesetzt, jeder
 * Lese-/Schreibpfad hier ist also RLS-gefenced.
 *
 * <p><b>Die drei Wahrheiten bleiben getrennt</b> (§1): dieser Schreiber hält
 * ausschliesslich fest, was BEFOHLEN wurde und was das Rücklesen dazu sagte. Was
 * die Anlage daraufhin wirklich getan hat, steht in der Messreihe daneben und
 * wird hier nie behauptet.
 *
 * <p><b>Der Verbraucher-Strom trägt NUR die Bestätigungs-Dimension</b> (§6.2):
 * Start und Stopp stehen bereits im Regel-Protokoll ({@code rule_event}), und
 * dieselbe Sache zweimal zu speichern erzeugte zwei Wahrheiten über ein
 * Ereignis. Die Seite verbindet beide Ströme - die Regel-Zeile liefert das
 * WARUM, die Kommando-Zeile das Draht-Urteil.
 */
@Component
public class CommandLogWriter {

    private static final Logger log = LoggerFactory.getLogger(CommandLogWriter.class);

    /** Höchstens so viele Zeilen je Aufräum-Lauf - nie eine lange Transaktion. */
    static final int PRUNE_BATCH = 5_000;
    /** Und höchstens so oft je api-Instanz. */
    static final java.time.Duration PRUNE_EVERY = java.time.Duration.ofHours(1);

    private final CommandLogRepository store;
    private final AtomicReference<Instant> lastPrune = new AtomicReference<>(null);

    public CommandLogWriter(CommandLogRepository store) {
        this.store = store;
    }

    /**
     * Was der Steuerungs-Herzschlag über den Batterie-Schreibweg sagt. Bewusst
     * ein eigener, schmaler Datensatz statt der Momentaufnahme-Zeile: er trägt
     * mit {@code possibleConflict} eine Tatsache, die die Momentaufnahme gar
     * nicht speichert - und der Verlauf soll dafür keine Spalte in einer
     * fremden Tabelle erzwingen.
     *
     * @param commandedKw       der Wert, den das Gerät fährt (nach Korrektur).
     * @param executionPlannedKw der Sollwert VOR der Korrektur; er ist die
     *                          Plan-Referenz des Schlüssels.
     */
    public record ControlFacts(Double commandedKw, boolean allMatch, boolean controlEnabled,
            boolean certified, String mismatchRoles, String controlPath, boolean possibleConflict,
            String executionMode, Double executionPlannedKw, String certSource) {
    }

    /** Der Batterie-Schreibweg: EINE laufende Periode je Gerät. */
    public void ingestControl(UUID siteId, UUID deviceId, ControlFacts facts, Instant at) {
        run(siteId, at, () -> {
            String ref = CommandLog.planRef(facts.executionMode(), facts.commandedKw(),
                    facts.executionPlannedKw());
            String whyKind = "fallback".equals(facts.executionMode())
                    ? CommandLog.WHY_SICHERUNG
                    : ref == null ? null : CommandLog.WHY_FAHRPLAN;
            Observation obs = new Observation(CommandLog.STREAM_BATTERIE,
                    store.controlPointOf(deviceId).orElse(null), facts.executionMode(),
                    blankToNull(facts.controlPath()), whyKind, ref, facts.commandedKw(),
                    CommandLog.batteryVerdict(facts.allMatch(), facts.mismatchRoles()),
                    facts.controlEnabled(), facts.certified(), facts.possibleConflict(),
                    new Detail(blankToNull(facts.mismatchRoles()), blankToNull(facts.certSource()),
                            null, null, null, null));
            apply(siteId, deviceId, obs, false, at);
        });
    }

    /** Der Abregel-Schreibweg: EINE laufende Periode je Gerät. */
    public void ingestCurtailment(UUID siteId, UUID deviceId, CurtailmentStatusDto row,
            Instant at) {
        run(siteId, at, () -> {
            Observation obs = new Observation(CommandLog.STREAM_ABREGELUNG, null,
                    row.active() ? "abregeln" : "frei", null, null, null, row.appliedCapKw(),
                    CommandLog.curtailVerdict(row.allMatch(), row.active()), row.controlEnabled(),
                    row.certifiedUnits() > 0, row.possibleOverride(),
                    new Detail(null, null, row.units(), row.certifiedUnits(), null, null));
            apply(siteId, deviceId, obs, false, at);
        });
    }

    /**
     * Der Verbraucher-Schreibweg: je Komponente eine laufende Periode. Eine
     * Komponente, die dieser Herzschlag nicht mehr trägt, wird an ihrem letzten
     * belegten Zeitpunkt geschlossen - OHNE Ereignis, denn Verschwinden ist
     * kein Stopp.
     */
    public void ingestConsumers(UUID siteId, UUID deviceId,
            List<ConsumerRuntimeStatusRepository.Row> rows, Instant at) {
        run(siteId, at, () -> {
            Set<UUID> seen = new HashSet<>();
            for (ConsumerRuntimeStatusRepository.Row row : rows) {
                seen.add(row.entityId());
                Observation obs = new Observation(CommandLog.STREAM_VERBRAUCHER, row.entityId(),
                        null, null, null, null, null,
                        CommandLog.consumerVerdict(row.confirmed()), null, null, null,
                        new Detail(null, null, null, null, row.state(), row.reasonCode()));
                apply(siteId, deviceId, obs, true, at);
            }
            store.closeOpenExcept(deviceId, CommandLog.STREAM_VERBRAUCHER, seen);
        });
    }

    /**
     * Der Ladepunkt-Schreibweg (Lastmanagement Stufe 3): je SÄULE eine laufende
     * Periode über die Grenze, die die Box ihr hinterlegt hat.
     *
     * <p><b>⚠ Je Säule, nicht je Stecker.</b> Der Verlauf soll die Geschichte
     * der ZUTEILUNG erzählen; eine Zeile je Stecker vervielfachte sie, ohne
     * eine Frage zu beantworten, die die Ladevorgangs-Liste nicht schon
     * beantwortet - und die Perioden-Tabelle kennt als Schlüssel ohnehin nur
     * eine Komponente (die Entität der Säule).
     *
     * <p>Eine Säule OHNE Komponente wird ausgelassen: der Schlüssel dieser
     * Tabelle ist eine Entitäts-Id, und eine erfundene wäre eine zweite
     * Identität für dasselbe Gerät. Beim nächsten Herzschlag hat die
     * Komposition sie ohnehin (sie läuft im selben Zuhörer).
     *
     * <p>Eine Säule, die dieser Herzschlag nicht mehr trägt, wird an ihrem
     * letzten belegten Zeitpunkt geschlossen - OHNE Ereignis: Verschwinden ist
     * kein Stopp (die Verbraucher-Regel, wörtlich).
     */
    public void ingestChargers(UUID siteId, UUID deviceId, List<ChargerFacts> rows, Instant at) {
        run(siteId, at, () -> {
            Set<UUID> seen = new HashSet<>();
            for (ChargerFacts row : rows) {
                if (row.entityId() == null) {
                    continue;
                }
                seen.add(row.entityId());
                Observation obs = new Observation(CommandLog.STREAM_LADEPUNKT, row.entityId(),
                        row.charging() ? "laedt" : "frei", null, null, null, row.allocatedKw(),
                        CommandLog.consumerVerdict(row.confirmed()), row.controlEnabled(), null,
                        null, new Detail(null, null, null, null, null, row.reason()));
                apply(siteId, deviceId, obs, true, at);
            }
            store.closeOpenExcept(deviceId, CommandLog.STREAM_LADEPUNKT, seen);
        });
    }

    /**
     * Die Fakten EINER Ladesäule für den Verlauf. {@code confirmed} ist
     * DREIWERTIG: null = die Säule hat sich zum Rücklesen nicht geäussert, und
     * das bleibt eine Lücke, nie ein Widerspruch.
     */
    public record ChargerFacts(UUID entityId, boolean charging, Double allocatedKw, String reason,
            Boolean confirmed, Boolean controlEnabled) {}

    // -- Der gemeinsame Kern --------------------------------------------------

    private void run(UUID siteId, Instant at, Runnable body) {
        try {
            // Der Aufzeichnungs-Beginn wird bei JEDEM Herzschlag festgehalten
            // (der erste gewinnt) - sonst begänne der Verlauf erst mit dem
            // ersten Wechsel, und ein leerer Verlauf wäre bis dahin die
            // Behauptung „es wurde nie etwas geschickt".
            store.markRecording(siteId, at);
            body.run();
            pruneIfDue(at);
        } catch (Exception e) {
            log.warn("Kommando-Verlauf für Anlage {} konnte nicht fortgeschrieben werden: {}",
                    siteId, e.getMessage());
        }
    }

    private void apply(UUID siteId, UUID deviceId, Observation obs, boolean perEntity, Instant at) {
        Optional<OpenPeriod> open = store.findOpen(deviceId, obs.stream(), obs.entityId(),
                perEntity);
        Plan plan = CommandLog.decide(open.orElse(null), obs, at);
        // Erst SCHLIESSEN, dann anhängen, dann eröffnen: sonst stünden für einen
        // Augenblick zwei offene Perioden derselben Sache in der Tabelle (und
        // der Unique-Index verweigerte die zweite).
        if (plan.closeAt() != null && open.isPresent()) {
            store.closePeriod(open.get().id(), plan.closeAt());
        }
        List<Event> events = plan.events();
        boolean inserts = plan.openNew() || !events.isEmpty();
        if (inserts && !allowInsert(siteId, deviceId, at)) {
            return;
        }
        for (Event e : events) {
            store.appendEvent(siteId, deviceId, obs.entityId(), obs.stream(), e.eventKind(),
                    e.startedAt(), e.endedAt());
        }
        if (plan.openNew()) {
            store.openPeriod(siteId, deviceId, obs, at);
        } else if (plan.extend() && open.isPresent()) {
            store.extendPeriod(open.get().id(), obs, at);
        }
    }

    /**
     * Der Tages-Deckel. Er kostet eine Zählung, und die NUR, wenn wirklich eine
     * Zeile entstehen soll - das Fortschreiben einer laufenden Periode ist ein
     * UPDATE und zählt nie dagegen. Greift er, wird genau EIN Vermerk
     * geschrieben (nicht bei jedem weiteren Wechsel einer), damit die Fläche ihn
     * als das lesen kann, was er ist: „ab hier haben wir nicht weiter
     * protokolliert".
     */
    private boolean allowInsert(UUID siteId, UUID deviceId, Instant at) {
        Instant dayStart = CommandLog.berlinDayStart(at);
        if (store.countSince(siteId, dayStart) < CommandLog.MAX_ROWS_PER_SITE_DAY) {
            return true;
        }
        if (!store.cappedSince(siteId, dayStart)) {
            // Der Vermerk hängt am Gerät, dessen Herzschlag den Deckel erreicht
            // hat - die Spalte ist NOT NULL, und ein erfundenes Gerät wäre
            // schlimmer als ein wahres, das zufällig als erstes anschlug.
            store.appendEvent(siteId, deviceId, null, CommandLog.STREAM_BATTERIE,
                    CommandLog.EVENT_GEDECKELT, at, at);
            log.warn("Kommando-Verlauf der Anlage {} hat den Tages-Deckel ({}) erreicht - "
                    + "bis Mitternacht wird nicht weiter protokolliert", siteId,
                    CommandLog.MAX_ROWS_PER_SITE_DAY);
        }
        return false;
    }

    private void pruneIfDue(Instant now) {
        Instant last = lastPrune.get();
        if (last != null && last.plus(PRUNE_EVERY).isAfter(now)) {
            return;
        }
        if (!lastPrune.compareAndSet(last, now)) {
            return; // ein anderer Herzschlag räumt gerade auf
        }
        int removed = store.prune(now.minus(CommandLog.RETENTION), PRUNE_BATCH);
        if (removed > 0) {
            log.info("Kommando-Verlauf: {} Zeilen älter als {} Tage entfernt", removed,
                    CommandLog.RETENTION.toDays());
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
