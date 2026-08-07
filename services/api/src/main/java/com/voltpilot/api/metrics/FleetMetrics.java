package com.voltpilot.api.metrics;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Die REINEN Regeln hinter den Betriebs-Metriken - Altersrechnung, die
 * Ehrlichkeits-Zustände und die Preis-Abdeckung. Ohne Spring, ohne Datenbank,
 * ohne Docker prüfbar (das {@code Tagesprotokoll}/{@code FleetPflege}/{@code
 * SlotEconomics}-Muster); {@link FleetMetricsCollector} tut nichts weiter, als
 * sie an Micrometer zu hängen.
 *
 * <p><b>Der Anlass (Produktionsstörung 06./07.08.2026).</b> Eine DNS-Fehlleitung
 * liess den Preis-Sammler ins Leere laufen, der Optimierer übersprang daraufhin
 * jede Runde („only 0 priced slots for zone DE-LU (need 16)"), und eine
 * Live-Anlage fuhr 17 Stunden auf ihrer Eigenverbrauchs-Sicherung - bis es
 * jemand zufällig im Portal sah. Protokolliert war alles; beobachtbar war
 * nichts. Diese Klasse macht genau die drei Grössen beobachtbar, an denen der
 * Vorfall hing: <b>wie alt ist der jüngste Fahrplan</b>, <b>wie alt ist die
 * jüngste Messung</b>, <b>wie viele bepreiste Viertelstunden liegen voraus</b>.
 *
 * <p><b>Die tragende Regel: was nicht gemessen ist, wird nicht als Zahl
 * exponiert.</b> Ein Alarm auf einer erfundenen Zahl ist schlimmer als kein
 * Alarm - eine Anlage, die noch nie einen Fahrplan hatte, würde mit „Alter 0"
 * eine Gesundheit behaupten, die niemand geprüft hat, und mit einem Sentinel
 * ({@code -1}) rechnete früher oder später jemand versehentlich weiter
 * ({@code avg}, {@code >}). Deshalb: die Alters-Zeitreihe existiert NUR, wenn
 * das Alter wirklich bekannt ist, und ihr Wert ist dann immer ein echtes Alter.
 * Was stattdessen für JEDE Anlage existiert, ist ein ausdrückliches Enum
 * ({@link PlanState}/{@link DataState}, das Prometheus-Standardmuster: 1 für den
 * aktiven Zustand, 0 für die übrigen), damit eine Alarm-Regel „nie" von
 * „veraltet" unterscheiden kann, statt aus einer fehlenden Zeitreihe raten zu
 * müssen.
 */
public final class FleetMetrics {

    /**
     * Das Nachschaufenster für „wann hat der Optimierer zuletzt gerechnet".
     *
     * <p>Die Untergrenze ist eine ABSICHT, keine Nachlässigkeit: ohne sie wäre
     * die Abfrage ein Scan über die ganze Plan-Historie des Hypertables
     * (dieselbe Begründung wie bei {@code OverviewRepository.lastPlanPerSite},
     * dessen Form diese Sammlung übernimmt). Ein Lauf jenseits davon ist
     * deshalb <b>„älter als das Fenster"</b> und NICHT „unbekannt" - der
     * Unterschied ist der ganze Punkt von {@link PlanState}.
     */
    public static final Duration PLAN_LOOKBACK = Duration.ofDays(7);

    /** Slot-Länge der Plattform (15 Minuten, epoch-ausgerichtet). */
    public static final Duration SLOT = Duration.ofMinutes(15);

    /**
     * Obergrenze der Vorschau in Slots (96 = 24 h) - derselbe Horizont, den der
     * Optimierer je Lauf anfragt ({@code domain.SLOTS_24H}). Die Metrik
     * sättigt also bei 96; alles darüber beantwortet keine Frage mehr, kostet
     * aber Zeilen.
     */
    public static final int HORIZON_SLOTS = 96;

    /**
     * Ab wie vielen zusammenhängenden bepreisten Slots der Optimierer eine
     * Anlage überhaupt plant ({@code inputs.MIN_HORIZON_SLOTS} = 4 h). Hier nur
     * dokumentiert, nicht angewandt: die Metrik meldet die gemessene Abdeckung,
     * die Schwelle gehört in die Alarm-Regel. <b>Ändert sich der Optimierer,
     * ändert sich die Regel - nicht diese Zahl.</b>
     */
    public static final int OPTIMIZER_MIN_SLOTS = 16;

    private FleetMetrics() {
    }

    /**
     * Wie es um den jüngsten Fahrplan einer Anlage steht. Drei Zustände, weil es
     * drei GIBT und sie zu verschiedenen Handlungen führen.
     */
    public enum PlanState {
        /** Ein Lauf liegt im Fenster - das Alter ist bekannt und exakt. */
        KNOWN("known"),
        /**
         * Die Anlage hatte schon Fahrpläne, aber keinen im Fenster. Ein echter
         * Alarm: das Alter ist nur nicht mehr genau bezifferbar (siehe
         * {@link #PLAN_LOOKBACK}), keineswegs unbekannt.
         */
        OLDER_THAN_WINDOW("older_than_window"),
        /**
         * Noch nie ein Fahrplan. KEIN Alarm - eine frisch angelegte Anlage ohne
         * Speicher oder ohne Gerät ist genau das, kein Störfall.
         */
        NEVER("never");

        private final String label;

        PlanState(String label) {
            this.label = label;
        }

        /** Der Wert des {@code state}-Labels - der Vertrag mit der Alarm-Regel. */
        public String label() {
            return label;
        }
    }

    /**
     * Wie es um die jüngste Messung steht. Nur ZWEI Zustände: die
     * Telemetrie-Abfrage hat kein Fenster, ein {@code older_than_window} kann
     * hier also gar nicht entstehen.
     */
    public enum DataState {
        /** Es gibt eine Messung - das Alter ist bekannt. */
        KNOWN("known"),
        /**
         * Noch nie eine Messung (auch der Fall „Anlage ohne beanspruchtes
         * Gerät"). KEIN Alarm - eine Anlage, die verstummt IST, hat Historie und
         * steht deshalb auf {@link #KNOWN} mit wachsendem Alter.
         */
        NEVER("never");

        private final String label;

        DataState(String label) {
            this.label = label;
        }

        /** Der Wert des {@code state}-Labels - der Vertrag mit der Alarm-Regel. */
        public String label() {
            return label;
        }
    }

    /**
     * Der ausgewertete Zustand EINER Anlage. {@code lastPlanAt} ist genau dann
     * gesetzt, wenn {@code planState == KNOWN}, {@code lastTelemetryAt} genau
     * dann, wenn {@code telemetryState == KNOWN} - so kann kein Aufrufer aus
     * Versehen ein Alter für etwas Unbekanntes bilden.
     */
    public record SiteSnapshot(
            UUID siteId,
            UUID tenantId,
            Instant lastPlanAt,
            PlanState planState,
            Instant lastTelemetryAt,
            DataState telemetryState) {
    }

    /** Die bepreiste Vorschau EINER Gebotszone. */
    public record ZoneCoverage(String biddingZone, int slotsAhead) {
    }

    /**
     * Wertet eine Anlage aus.
     *
     * @param lastPlanInWindow jüngster Optimierer-Lauf INNERHALB
     *        {@link #PLAN_LOOKBACK}, {@code null} wenn keiner
     * @param everPlanned ob die Anlage überhaupt je einen Lauf hatte (die
     *        Unterscheidung, die das Fenster allein nicht treffen kann)
     * @param lastTelemetry jüngste ANKUNFT einer Messung, {@code null} wenn nie
     */
    public static SiteSnapshot evaluate(UUID siteId, UUID tenantId,
            Instant lastPlanInWindow, boolean everPlanned, Instant lastTelemetry) {
        PlanState planState;
        if (lastPlanInWindow != null) {
            planState = PlanState.KNOWN;
        } else if (everPlanned) {
            planState = PlanState.OLDER_THAN_WINDOW;
        } else {
            planState = PlanState.NEVER;
        }
        return new SiteSnapshot(
                siteId,
                tenantId,
                planState == PlanState.KNOWN ? lastPlanInWindow : null,
                planState,
                lastTelemetry,
                lastTelemetry == null ? DataState.NEVER : DataState.KNOWN);
    }

    /**
     * Alter in Sekunden zum Zeitpunkt {@code now}.
     *
     * <p>Bei 0 abgeschnitten: ein Zeitstempel in der Zukunft ist ein
     * Uhren-Versatz zwischen zwei Hosts, kein negatives Alter. „Gerade eben"
     * ist die ehrliche Lesart, und eine Regel {@code > Schwelle} käme zu
     * derselben Aussage - ein negativer Wert wäre nur eine Zahl, die keine
     * Regel erwartet.
     */
    public static double ageSeconds(Instant at, Instant now) {
        long seconds = Duration.between(at, now).getSeconds();
        return Math.max(0L, seconds);
    }

    /**
     * Wie viele Viertelstunden ab {@code now} LÜCKENLOS bepreist sind, gedeckelt
     * bei {@link #HORIZON_SLOTS}.
     *
     * <p><b>Zusammenhängend, nicht gezählt</b> - das ist die Größe, an der der
     * Optimierer wirklich hängt: er nimmt den Slot, der bei {@code now} LÄUFT,
     * und bricht bei der ersten Lücke ab ({@code inputs.gather_inputs}). Ein
     * blosses {@code count(*)} über zukünftige Preiszeilen könnte 40 melden,
     * während der Optimierer bei 3 abbricht, weil Slot 4 fehlt - die Metrik
     * hätte den Vorfall dann nicht gesehen.
     *
     * <p>Der erste betrachtete Slot ist der LAUFENDE (auf die Viertelstunde
     * abgerundet), nicht der nächste - genau wie {@code
     * domain.horizon_slot_starts}, denn der Plan muss einen Slot enthalten, der
     * {@code now} abdeckt.
     */
    public static int contiguousPricedSlots(Instant now, Collection<Instant> pricedSlotStarts) {
        Set<Instant> priced = new HashSet<>(pricedSlotStarts);
        Instant slot = floorToSlot(now);
        int covered = 0;
        while (covered < HORIZON_SLOTS && priced.contains(slot)) {
            covered++;
            slot = slot.plus(SLOT);
        }
        return covered;
    }

    /**
     * Rundet auf den Beginn der laufenden Viertelstunde ab. Epoch-ausgerichtet -
     * dieselbe Ausrichtung wie {@code time_bucket('15 minutes', ...)} und wie
     * {@code domain.floor_to_slot} des Optimierers, damit die drei nie um einen
     * Slot auseinanderlaufen.
     */
    public static Instant floorToSlot(Instant now) {
        long slotSeconds = SLOT.getSeconds();
        return Instant.ofEpochSecond(Math.floorDiv(now.getEpochSecond(), slotSeconds) * slotSeconds);
    }
}
