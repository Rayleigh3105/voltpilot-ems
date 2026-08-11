package com.voltpilot.api.rules;

import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.FlowStatusRepository;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Die REINEN Regeln des Regel-Protokolls (Einheitsmodell Stufe 5b, Konzept
 * `vp-komponenten-einheit-h2` Teil 5b.6): aus zwei MOMENTAUFNAHMEN wird eine
 * Liste von WECHSELN. Keine Datenbank, keine Uhr aus dem Nichts - jede
 * zeitabhängige Funktion nimmt ihr {@code now} entgegen (das
 * {@code Tagesprotokoll}/{@code FleetPflege}/{@code otaapply}-Muster), damit
 * der Tageswechsel und die Zeitzone Docker-frei prüfbar sind.
 *
 * <p><b>Die vier Ehrlichkeitsregeln, die diese Datei trägt</b> - sie sind der
 * Grund, warum der Verlauf nichts behaupten kann, das niemand gemessen hat:
 *
 * <ol>
 *   <li><b>Die ERSTE Beobachtung ist kein Ereignis.</b> Ohne Vorzustand wird
 *       nichts geschrieben (das {@code ConsumerReplanTrigger}-Muster) - sonst
 *       meldete jede neu angelegte Komponente ein „gestartet", das nie
 *       stattgefunden hat. Der Vorzustand kommt aus der DATENBANK
 *       ({@code consumer_runtime_status}), ein api-Neustart verliert ihn also
 *       nicht.</li>
 *   <li><b>Verschwinden ist kein Wechsel.</b> Meldet ein Herzschlag eine
 *       Komponente nicht mehr, wird KEIN „gestoppt" geschrieben - Schweigen
 *       ist eine Lücke, kein bewiesenes Ende.</li>
 *   <li><b>Nur der ZUSTAND ist ein Wechsel.</b> Ein wechselnder GRUND bei
 *       gleichem Zustand („wartet - Mindestpause" → „wartet - günstiger
 *       Preis") ist kein Schaltvorgang; er reist als Grund am nächsten echten
 *       Ereignis mit, erzeugt aber keines.</li>
 *   <li><b>Nur gemeldete Wörter.</b> Zustand und Grund kommen unverändert aus
 *       dem Ingest, der ein unbekanntes Wort bereits VERWORFEN hat
 *       ({@code ConsumerRuntimeStatusListener}) - hier wird nie eines
 *       geraten und nie eines übersetzt.</li>
 * </ol>
 */
public final class RuleEvents {

    private RuleEvents() {
    }

    /** Die v1-Plattform-Zeitzone (die {@code HistoryRange}-Festlegung). */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    // -- Die Ereignis-Arten ---------------------------------------------------

    /** Die Komponente hat zu laufen BEGONNEN. Das ist „geschaltet". */
    public static final String GESTARTET = "gestartet";
    /** Die Komponente hat aufgehört zu laufen. */
    public static final String GESTOPPT = "gestoppt";
    /** Ein Zustandswechsel, der kein Schaltvorgang ist (z. B. wartet → begrenzt). */
    public static final String ZUSTAND = "zustand";
    /** Die Regel ist (neu) auf dem Gerät angekommen. */
    public static final String AUSGEROLLT = "ausgerollt";
    /** Das Gerät meldet ein Problem mit dieser Regel. */
    public static final String GERAET_PROBLEM = "geraet_problem";
    /** Der Tages-Deckel hat gegriffen - das Protokoll SAGT das selbst. */
    public static final String GEDECKELT = "protokoll_gedeckelt";

    /**
     * Die Zustände, die „läuft" bedeuten. Nur ein Übergang über diese Grenze
     * ist ein SCHALTVORGANG - daran hängt der Zähler „heute N× geschaltet".
     */
    static final Set<String> RUNNING = Set.of("running_forced", "running_optimized");

    /** Die Ack-Zustände, die ein PROBLEM des Geräts mit der Regel bedeuten. */
    static final Set<String> ACK_PROBLEM = Set.of("error", "unsupported");

    /**
     * Ein abgeleiteter Wechsel, noch OHNE Regel-Zuordnung und ohne Mandant -
     * die setzt der {@link RuleEventWriter} an, weil sie eine Datenbank braucht.
     *
     * @param entityId die Komponente (Verbraucher-Kanal), sonst {@code null}
     * @param flowId   die Regel selbst (Ausroll-Kanal), sonst {@code null}
     */
    public record Event(UUID entityId, UUID flowId, String kind, String state,
            String previousState, String reasonCode, Double actualKw, String detail) {
    }

    // -- Der Verbraucher-Kanal: der eigentliche Schalt-Verlauf -----------------

    /**
     * Die Wechsel zwischen zwei Herzschlägen einer Anlage. {@code previous} ist
     * der Satz, den DIESES Gerät zuletzt gemeldet hat (aus der Datenbank),
     * {@code current} der eben eingegangene.
     */
    public static List<Event> deriveConsumerEvents(
            List<ConsumerRuntimeStatusRepository.Row> previous,
            List<ConsumerRuntimeStatusRepository.Row> current) {
        Map<UUID, ConsumerRuntimeStatusRepository.Row> before = new HashMap<>();
        for (ConsumerRuntimeStatusRepository.Row r : nullSafe(previous)) {
            before.put(r.entityId(), r);
        }
        List<Event> out = new ArrayList<>();
        for (ConsumerRuntimeStatusRepository.Row now : nullSafe(current)) {
            ConsumerRuntimeStatusRepository.Row was = before.get(now.entityId());
            if (was == null) {
                continue; // Regel 1: die erste Beobachtung ist kein Ereignis.
            }
            if (was.state() == null || now.state() == null || was.state().equals(now.state())) {
                continue; // Regel 3: nur der ZUSTAND ist ein Wechsel.
            }
            out.add(new Event(now.entityId(), null, classify(was.state(), now.state()),
                    now.state(), was.state(), now.reasonCode(), now.actualKw(), null));
        }
        // Regel 2: eine verschwundene Komponente erzeugt bewusst KEIN Ereignis.
        return out;
    }

    /**
     * Ob der Übergang ein SCHALTVORGANG ist. „geschaltet" heißt: die Komponente
     * hat zu laufen begonnen - deshalb zählt der Kartenzähler ausschließlich
     * {@link #GESTARTET}.
     */
    public static String classify(String previousState, String state) {
        boolean lief = RUNNING.contains(previousState);
        boolean laeuft = RUNNING.contains(state);
        if (!lief && laeuft) {
            return GESTARTET;
        }
        if (lief && !laeuft) {
            return GESTOPPT;
        }
        return ZUSTAND;
    }

    /** Ob eine Ereignis-Art als Schaltvorgang zählt (Zähler + „zuletzt"). */
    public static boolean istSchaltvorgang(String kind) {
        return GESTARTET.equals(kind) || GESTOPPT.equals(kind);
    }

    // -- Der Ausroll-Kanal: der Verlauf der Regel SELBST -----------------------

    /**
     * Die Wechsel im Geräte-Ack einer Regel. Damit hat auch eine Wenn/Dann-Regel
     * OHNE steuerbare Komponente einen Verlauf („v3 ausgerollt", „Gerät meldet
     * ein Problem") - der Schaltzähler bleibt davon unberührt, denn ein
     * Ausrollen ist kein Schaltvorgang.
     *
     * <p>Ein neuer Ack IST ein Ereignis (anders als beim Verbraucher-Kanal):
     * er kann nur entstehen, wenn seit dem letzten Herzschlag wirklich etwas
     * auf dem Gerät angekommen ist - der Vorzustand steht in der Datenbank und
     * überlebt einen api-Neustart.
     */
    public static List<Event> deriveAckEvents(List<FlowStatusRepository.Ack> previous,
            List<FlowStatusRepository.Ack> current) {
        Map<UUID, FlowStatusRepository.Ack> before = new HashMap<>();
        for (FlowStatusRepository.Ack a : nullSafe(previous)) {
            before.put(a.flowId(), a);
        }
        List<Event> out = new ArrayList<>();
        for (FlowStatusRepository.Ack now : nullSafe(current)) {
            FlowStatusRepository.Ack was = before.get(now.flowId());
            if (was != null && was.flowVersion() == now.flowVersion()
                    && java.util.Objects.equals(was.state(), now.state())) {
                continue; // unverändert
            }
            boolean neueFassung = was == null || was.flowVersion() != now.flowVersion();
            String kind;
            if (ACK_PROBLEM.contains(now.state())) {
                kind = GERAET_PROBLEM;
            } else if (neueFassung) {
                kind = AUSGEROLLT;
            } else {
                kind = ZUSTAND;
            }
            out.add(new Event(null, now.flowId(), kind, now.state(),
                    was == null ? null : was.state(), null, null,
                    versionsDetail(now, was, neueFassung)));
        }
        return out;
    }

    /** „v3" bzw. „v2 → v3" plus den Grund, den das Gerät genannt hat. */
    private static String versionsDetail(FlowStatusRepository.Ack now,
            FlowStatusRepository.Ack was, boolean neueFassung) {
        String version = neueFassung && was != null
                ? "v" + was.flowVersion() + " → v" + now.flowVersion()
                : "v" + now.flowVersion();
        String grund = blankToNull(now.detail());
        return grund == null ? version : version + " · " + grund;
    }

    // -- Zeit ------------------------------------------------------------------

    /**
     * Der Beginn des laufenden Berliner Kalendertages. Er ist die Grenze des
     * Zählers „heute N× geschaltet" - über Sommerzeit-Wechsel hinweg korrekt,
     * weil er über die ZONE und nicht über eine 24-Stunden-Arithmetik geht.
     */
    public static Instant berlinDayStart(Instant now) {
        return now.atZone(ZONE).toLocalDate().atStartOfDay(ZONE).toInstant();
    }

    /**
     * Ob der Zähler „heute N×" überhaupt behauptet werden darf: nur, wenn der
     * Speicher schon VOR dem heutigen Tagesbeginn aufgezeichnet hat. Beginnt er
     * erst heute, ist eine 0 keine Aussage, sondern eine Lücke - die Fläche
     * sagt dann „seit HH:MM aufgezeichnet".
     */
    public static boolean tageszaehlerBelastbar(Instant recordingSince, Instant now) {
        return recordingSince != null && !recordingSince.isAfter(berlinDayStart(now));
    }

    private static <T> List<T> nullSafe(List<T> list) {
        return list == null ? List.of() : list;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
