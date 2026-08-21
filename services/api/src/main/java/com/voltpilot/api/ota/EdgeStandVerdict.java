package com.voltpilot.api.ota;

import com.voltpilot.api.repo.EdgeVersionRepository.RegisterEntry;
import java.util.List;

/**
 * Das KUNDEN-Urteil über den Software-Stand einer Box: „aktuell", „veraltet"
 * oder ehrlich „lässt sich nicht sagen" (Geräteseiten Stufe 1, Scout
 * {@code vp-geraeteseite-rev-b8} §4.1 R2a).
 *
 * <p><b>Der Maßstab erreichte den Kunden bis hierher nicht.</b> Das
 * Release-Register liegt hinter {@code /admin/fleet}, also konnte die
 * Kunden-Geräteseite ihren gemeldeten Stand zwar ZEIGEN, aber nicht EINORDNEN -
 * „edge-2026.08.10" beantwortet die Frage „ist meine Box aktuell?" nicht.
 *
 * <p><b>Es reist das URTEIL, nie das Register</b> ({@code newestRelease} +
 * {@code upToDate}): welche Releases es gibt, wer sie eingetragen hat und
 * welche Manifeste daran hängen, ist Betreiber-Sache. Der Name des Soll-Stands
 * ist dagegen genau das, was auf der Box laufen soll.
 *
 * <p><b>{@code upToDate} ist DREIWERTIG, und das ist der ganze Punkt:</b>
 * {@code null} heißt „nicht bewertbar" - entweder hat das Gerät nie einen Stand
 * gemeldet, oder sein Stand steht nicht im Register (eine Lücke im REGISTER,
 * keine Alters-Aussage über das Gerät). Ein {@code false} an dieser Stelle wäre
 * die Behauptung „veraltet", die genau hier schon einmal falsch war.
 *
 * <p>Rein und Docker-frei prüfbar (das {@code Tagesprotokoll}/{@code RolloutStates}-Muster).
 */
public final class EdgeStandVerdict {

    private EdgeStandVerdict() {
    }

    /**
     * Das Urteil.
     *
     * @param newestRelease der Soll-Stand aus dem Register; {@code null} =
     *                      leeres Register, also KEIN Maßstab.
     * @param upToDate      {@code true} = das Gerät fährt den Soll-Stand (oder
     *                      einen neueren), {@code false} = veraltet,
     *                      {@code null} = nicht bewertbar.
     */
    public record Verdict(String newestRelease, Boolean upToDate) {
    }

    /** Das leere Urteil - ohne Register gibt es keinen Maßstab. */
    public static final Verdict UNKNOWN = new Verdict(null, null);

    /**
     * Ordnet einen gemeldeten Stand in das Register ein.
     *
     * @param reported das, was das Gerät gemeldet hat (roher Stempel);
     *                 {@code null}/leer = nichts gemeldet.
     * @param register das Register, NEUESTE zuerst.
     */
    public static Verdict of(String reported, List<RegisterEntry> register) {
        if (register == null || register.isEmpty()) {
            return UNKNOWN;
        }
        RegisterEntry soll = register.get(0);
        String stamp = reported == null ? "" : reported.trim();
        if (stamp.isEmpty()) {
            // Kein Stand gemeldet: der Soll steht trotzdem, das Urteil nicht.
            return new Verdict(soll.version(), null);
        }
        // ⚠ Die Zuordnung ist die PRÄFIX-Regel des Hauses, nie `equals`: ein
        // Tag-Lauf stempelt `<tag>-<kurzsha>`, im Register steht der nackte Tag
        // (RolloutStates.releaseIsRunning ist der geteilte Träger dieser Regel).
        RegisterEntry entry = register.stream()
                .filter(r -> RolloutStates.releaseIsRunning(r.version(), stamp))
                .findFirst().orElse(null);
        if (entry == null) {
            // Nicht registriert: eine Lücke im Register, KEINE Alters-Aussage.
            return new Verdict(soll.version(), null);
        }
        return new Verdict(soll.version(), entry.releaseSeq() >= soll.releaseSeq());
    }
}
