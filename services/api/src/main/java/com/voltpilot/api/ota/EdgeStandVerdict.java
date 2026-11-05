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
 * <p><b>Gemessen wird an der EIGENEN Linie</b> (Geräte &amp; Updates S0): Docker-Box
 * und Edge Light haben getrennte Releases ({@code edge-JJJJ.MM.N} und
 * {@code edge-light-JJJJ.MM.N}, {@link BoxArt}). Bis S0 war der Soll das
 * neueste Release über beide Linien - seit dem ersten signierten
 * Edge-Light-Release las eine Docker-Box „Ein neuerer Stand ist verfügbar:
 * edge-light-…", den sie nie bekommen kann. Die Linie eines Geräts ist seine
 * Box-Art; ist sie unbekannt, die Linie des Releases, das es meldet. Bleibt sie
 * unbekannt, gibt es keinen Maßstab.
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
     * @param newestRelease der Soll-Stand: das neueste Release der Linie des
     *                      Geräts; {@code null} = kein Maßstab (leeres Register,
     *                      Linie unbekannt oder die Linie hat noch kein Release).
     * @param upToDate      {@code true} = das Gerät fährt den Soll-Stand (oder
     *                      einen neueren), {@code false} = veraltet,
     *                      {@code null} = nicht bewertbar.
     * @param linie         die Linie, an der gemessen wurde ({@link BoxArt#DOCKER}
     *                      oder {@link BoxArt#LIGHT}); {@code null} = unbekannt.
     */
    public record Verdict(String newestRelease, Boolean upToDate, String linie) {
    }

    /** Das leere Urteil - ohne Register (oder ohne Linie) gibt es keinen Maßstab. */
    public static final Verdict UNKNOWN = new Verdict(null, null, null);

    /**
     * Ordnet einen gemeldeten Stand in das Register seiner Linie ein.
     *
     * @param reported das, was das Gerät gemeldet hat (roher Stempel);
     *                 {@code null}/leer = nichts gemeldet.
     * @param boxArt   die Box-Art des Geräts ({@link BoxArt#ofDevice});
     *                 {@code null} = unbekannt.
     * @param register das Register, NEUESTE zuerst, jeder Eintrag mit seiner Linie.
     */
    public static Verdict of(String reported, String boxArt, List<RegisterEntry> register) {
        if (register == null || register.isEmpty()) {
            return UNKNOWN;
        }
        String stamp = reported == null ? "" : reported.trim();
        String linie = linie(boxArt, stamp, register);
        if (linie == null) {
            return UNKNOWN;
        }
        RegisterEntry soll = register.stream()
                .filter(r -> linie.equals(r.boxArt()))
                .findFirst().orElse(null);
        if (soll == null) {
            // Die Linie hat noch kein Release: kein Maßstab - und schon gar
            // nicht das neueste der ANDEREN Linie.
            return new Verdict(null, null, linie);
        }
        if (stamp.isEmpty()) {
            // Kein Stand gemeldet: der Soll steht trotzdem, das Urteil nicht.
            return new Verdict(soll.version(), null, linie);
        }
        // ⚠ Die Zuordnung ist die PRÄFIX-Regel des Hauses, nie `equals`: ein
        // Tag-Lauf stempelt `<tag>-<kurzsha>`, im Register steht der nackte Tag
        // (RolloutStates.releaseIsRunning ist der geteilte Träger dieser Regel).
        RegisterEntry entry = register.stream()
                .filter(r -> linie.equals(r.boxArt()))
                .filter(r -> RolloutStates.releaseIsRunning(r.version(), stamp))
                .findFirst().orElse(null);
        if (entry == null) {
            // Nicht registriert: eine Lücke im Register, KEINE Alters-Aussage.
            return new Verdict(soll.version(), null, linie);
        }
        return new Verdict(soll.version(), entry.releaseSeq() >= soll.releaseSeq(), linie);
    }

    /**
     * Die Linie, an der ein Gerät gemessen wird: seine Box-Art, sonst die Linie
     * des Releases, das sein Stempel trägt, sonst {@code null}.
     */
    static String linie(String boxArt, String stamp, List<RegisterEntry> register) {
        if (boxArt != null) {
            return boxArt;
        }
        if (stamp.isEmpty()) {
            return null;
        }
        return register.stream()
                .filter(r -> RolloutStates.releaseIsRunning(r.version(), stamp))
                .map(RegisterEntry::boxArt)
                .findFirst().orElse(null);
    }
}
