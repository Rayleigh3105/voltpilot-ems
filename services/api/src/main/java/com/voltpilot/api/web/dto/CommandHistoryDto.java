package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Der KOMMANDO-VERLAUF einer Komponente (Kommando-Transparenz V1, Konzept
 * {@code vp-kommando-transparenz-k3} §6.3) - EINE Antwort für die ganze Seite:
 * der Kopf, der Live-Zustand („Gerade jetzt"), das Panel „Grenzen &amp; Wächter",
 * der Tages-Film und die Fussnote der Ehrlichkeit.
 *
 * <p><b>{@code recordingSince} ist der Grund, warum ein leerer Verlauf nicht
 * gelogen ist.</b> Ohne ihn wüsste keine Fläche, ob „keine Befehle" heisst
 * „VoltPilot hat nie etwas geschickt" oder „wir haben erst seit gestern
 * hingesehen" - und die entlastende Aussage wäre genauso erfunden wie eine
 * belastende. {@code null} heisst, dass für diese Anlage noch gar nicht
 * aufgezeichnet wurde.
 *
 * <p><b>{@code deviceRef} ist der Echo des Geräte-Filters</b> (Anlagen-Zentrale
 * Stufe 1): {@code null} = die ganze Anlage bzw. eine einzelne Komponente, sonst
 * die Adresse, auf die eingegrenzt wurde. Die Antwort trägt bewusst KEINEN
 * Geräte-NAMEN - den bildet das Portal aus seiner einen Namensableitung
 * ({@code entityLabel.deviceName}), und ein zweiter hier wäre ein Zwilling, der
 * abdriften kann. {@code deviceIsBox} unterscheidet die BOX (sie ist der
 * Schreibweg der Anlage und trägt jede Zeile) vom Gerät DAHINTER (nur die Zeilen
 * seiner Komponenten) - die Fläche darf das nicht raten, deshalb ist es ein
 * Server-Fakt; {@code null} = gar nicht gefiltert.
 *
 * <p><b>{@code writes} ist die F4-Antwort.</b> false = an diese Komponente geht
 * kein einziger Befehl, sie wird nur gelesen - genau die Frage
 * („drosselt IHR meine Anlage?"), die zwei Untersuchungsrunden gekostet hat.
 * Der SATZ dazu wohnt im Portal ({@code src/befehle.ts}); hier steht die
 * Tatsache.
 *
 * <p><b>Der Live-Zustand wird WIEDERVERWENDET, nicht nachgebaut:</b>
 * {@code control} und {@code curtailment} sind wörtlich die DTOs der beiden
 * bestehenden Momentaufnahme-Routen, damit die Befehle-Seite und das Cockpit
 * über dieselbe Sekunde nie Verschiedenes behaupten können.
 *
 * <p><b>Die Genauigkeit steht AN der Fläche, nicht im Kleingedruckten:</b> V1
 * leitet aus dem 15-Sekunden-Herzschlag ab, ist also blind für ein
 * Wechsel-und-zurück dazwischen ({@code accuracySeconds}), und kennt keine
 * Schreibzyklen-Zähler. Der Präzisions-Uplink (Stufe 2) hebt beides additiv.
 */
public record CommandHistoryDto(Instant recordingSince, int accuracySeconds, Instant from,
        Instant to, UUID entityId, String entityLabel, String deviceRef, Boolean deviceIsBox,
        boolean writes, boolean truncated,
        /*
         * Der TREFFER-ZÄHLER der Befehls-Suche (Geräteseiten Revision B §6):
         * `total` sind die Zeilen dieses Zeitraums OHNE Filter, `matched` die
         * mit ihm - „14 von 212 Zeilen".
         *
         * ⚠ Ohne beide Zahlen wäre ein scharfer Filter von einem leeren
         * Zeitraum nicht zu unterscheiden, und die Fläche behauptete „in dieser
         * Woche wurde nichts geschickt", wo in Wahrheit 212 Zeilen liegen. Der
         * FREITEXT ist darin nicht enthalten - er läuft im Portal über die
         * gezeigten Sätze und schrumpft nur, was hier schon steht.
         */
        int total, int matched,
        /*
         * Der Seiten-Cursor nach HINTEN: der Beginn der ältesten mitgelieferten
         * Zeile, oder null, wenn das Fenster vollständig gezeigt ist. Eine
         * Fläche darf „mehr laden" nie anbieten, wo es nichts mehr gibt.
         */
        Instant nextBefore,
        List<CommandEntryDto> entries, ControlStatusDto control,
        CurtailmentStatusDto curtailment) {

    /**
     * Eine Zeile des Verlaufs: eine HALTEPERIODE ({@code kind = "periode"}) oder
     * ein Punkt-Ereignis ({@code kind = "ereignis"}, dann trägt
     * {@code eventKind} seine Art).
     *
     * <p>Jedes Feld darf fehlen und ein fehlendes heisst „nicht gemessen", nie
     * 0 - insbesondere sind die vier {@code cycles*} in V1 IMMER {@code null}
     * (aus 15-Sekunden-Momentaufnahmen lässt sich die Zahl der
     * 10-Sekunden-Schreibvorgänge nicht ableiten).
     *
     * @param endedAt {@code null} = die Periode LÄUFT noch.
     * @param verdict das Rücklese-Urteil; {@code keine_antwort} ist ausdrücklich
     *                nicht {@code abweichend} (Schweigen ist eine Lücke).
     * @param register NUR auf den Zeilen des vierten Stroms {@code register}
     *                gesetzt: der gefaltete Vorgang aus dem append-only Journal
     *                {@code register_write_event}. Es gibt KEINE Doppel-Speicherung -
     *                die Befehle-Seite mischt dieselben Zeilen zur Lesezeit ein.
     *                Ein älteres Portal kennt das Strom-Wort nicht und lässt die
     *                Zeile wortlos aus (die Unbekannt-bleibt-ohne-Behauptung-Regel).
     * @param source  {@code cloud_abgeleitet} (V1) oder {@code geraet} (Stufe 2)
     *                - die Herkunft steht an der Zeile, damit die Fläche nie
     *                mehr behauptet, als ihre Quelle hergibt.
     */
    public record CommandEntryDto(long id, String stream, String kind, String eventKind,
            Instant startedAt, Instant endedAt, String mode, String path, String whyKind,
            String whyRef, Double commandedKwFirst, Double commandedKwLast, Double commandedKwMin,
            Double commandedKwMax, String verdict, Integer cycles, Integer cyclesConfirmed,
            Integer cyclesNoAnswer, Integer cyclesMismatch, Boolean controlEnabled,
            Boolean released, Boolean foreignInfluence, String entityId, String source,
            CommandDetailDto detail, RegisterWriteEventDto register) {
    }

    /**
     * Der Roh-Blick einer Zeile (§2.4, Captain-Entscheid F1: für ALLE Kunden
     * aufklappbar). V1 trägt genau das, was der Herzschlag hergibt - Rollen,
     * Einheiten-Zähler, gemeldeter Zustand. Register und Zieladressen folgen mit
     * dem Präzisions-Uplink; sie hier zu erfinden wäre das Gegenteil des Zwecks.
     */
    public record CommandDetailDto(String mismatchRoles, String certSource, Integer units,
            Integer certifiedUnits, String state, String reasonCode) {
    }
}
