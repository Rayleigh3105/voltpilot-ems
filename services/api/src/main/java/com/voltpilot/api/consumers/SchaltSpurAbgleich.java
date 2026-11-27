package com.voltpilot.api.consumers;

import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import java.math.BigDecimal;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Was EIN Herzschlag der Box über einen offenen Handeingriff sagt (Schaltspur, vp-schalten-3s) - rein, ohne
 * Datenbank, damit dieselbe Regel für jede Box gilt: auch eine Box vor dem Release mit Schaltspur, die keine eigenen
 * Zeitpunkte meldet, wird so an ihren Herzschlägen gemessen.
 *
 * <p>"Bestätigt" heißt nur, was die Box als zurückgelesen meldet - nie, was gemessen wurde (Plan, angenommener
 * Auftrag, Rücklesung und Messung bleiben getrennt):
 * <ul>
 *   <li>Heizstab über eine Ausgangsmenge ({@code stage}): genau die gewünschten Ausgänge sind als an zurückgelesen
 *       (bei „Aus“ keiner), und der Stab läuft auf Wunsch von Hand ({@code running_manual}), sobald etwas an sein
 *       soll.</li>
 *   <li>Jeder andere Verbraucher: {@code confirmed == true} und der Zustand passt - läuft von Hand bei „Start“,
 *       läuft nicht bei „Stopp“.</li>
 *   <li>„Automatik fortsetzen“: die Box meldet keinen Handeingriff mehr ({@code running_manual} ist vorbei) und
 *       ihre Rücklesung widerspricht nicht.</li>
 * </ul>
 * Hält eine Schutzregel der Box den Wunsch (Mindestlauf, Mindestpause, Startgrenze, Phasenumschaltpause, …), ist
 * das {@link Urteil#GEHALTEN} mit dem Grund der Box; widerspricht die Rücklesung, {@link Urteil#ABWEICHUNG}.
 */
public final class SchaltSpurAbgleich {

    private SchaltSpurAbgleich() {
    }

    /** Das Urteil eines Herzschlags über einen offenen Wunsch. */
    public enum Urteil { OFFEN, BESTAETIGT, GEHALTEN, ABWEICHUNG }

    /**
     * Die Gründe der Box, mit denen eine Schutzregel einen Wunsch hält oder kürzt (das §15-Vokabular des Zuhörers,
     * {@link ConsumerRuntimeStatusListener#REASONS}).
     */
    static final Set<String> HALTEGRUENDE = Set.of("guard_min_on", "guard_min_off", "guard_max_starts",
            "guard_ramp", "guard_phase_switch", "guard_rated_power", "guard_grid_limit");

    /** Der Wunsch einer Spur, so wie die API ihn an die Box gab. */
    public record Wunsch(String art, String kommando, BigDecimal wert, List<Integer> ausgaenge) {

        boolean an() {
            if ("stop".equals(art)) {
                return false;
            }
            if ("on_off".equals(kommando)) {
                return true; // ein Start mit on_off ist immer "an"
            }
            return wert == null || wert.signum() > 0;
        }
    }

    public static Urteil urteil(Wunsch w, ConsumerRuntimeStatusRepository.Row row) {
        if (w == null || row == null) {
            return Urteil.OFFEN;
        }
        if (erfuellt(w, row)) {
            return Urteil.BESTAETIGT;
        }
        if (row.reasonCode() != null && HALTEGRUENDE.contains(row.reasonCode())) {
            return Urteil.GEHALTEN;
        }
        if (Boolean.FALSE.equals(row.confirmed()) || "readback_mismatch".equals(row.reasonCode())
                || (row.stufe() != null && row.stufe().abweichungSeit() != null)) {
            return Urteil.ABWEICHUNG;
        }
        return Urteil.OFFEN;
    }

    private static boolean erfuellt(Wunsch w, ConsumerRuntimeStatusRepository.Row row) {
        boolean manuell = "running_manual".equals(row.state());
        if ("zurueck".equals(w.art())) {
            return !manuell && !Boolean.FALSE.equals(row.confirmed())
                    && (row.stufe() == null || row.stufe().abweichungSeit() == null);
        }
        HeizstabStufe.Stufe s = row.stufe();
        if (s != null) {
            if (s.bestaetigt() == null) {
                return false; // ein Ausgang ist ungelesen - unbekannt ist nie "aus"
            }
            Set<Integer> an = new HashSet<>(s.ausgaengeAn());
            if (!w.an()) {
                return an.isEmpty();
            }
            if (!manuell || an.isEmpty()) {
                return false;
            }
            if (w.ausgaenge() != null && !w.ausgaenge().isEmpty()) {
                return an.equals(new HashSet<>(w.ausgaenge()));
            }
            // Eine Stufe ohne Phasen-Wahl: die Box wählt die Ausgänge selbst; bestätigt ist die befohlene Stufe.
            return s.bestaetigt() == s.befohlen() && s.befohlen() > 0;
        }
        if (!Boolean.TRUE.equals(row.confirmed())) {
            return false;
        }
        boolean laeuft = row.state() != null && row.state().startsWith("running_");
        return w.an() ? manuell : !laeuft;
    }
}
