package com.voltpilot.api.ota;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Das Bake-Kriterium der Wellen-Freigabe (Captain-Entscheid D4): <b>24 h gesund
 * UND mindestens ein echter Steuerzyklus</b> auf jedem Gerät der laufenden
 * Welle - die Pilsting-Regel.
 *
 * <p>Rein und Docker-frei wie {@link RolloutStates}: die Frage „darf die
 * nächste Welle?" ist eine Behauptung über eine Kundenanlage und gehört an EINE
 * nagelbare Stelle.
 *
 * <h2>Die zweite Hälfte ist DREIWERTIG - und das ist keine Bequemlichkeit</h2>
 *
 * „≥ 1 echter Steuerzyklus" wird aus {@code device_control_status} gelesen: ein
 * bestätigter Register-Rückleseabgleich ({@code all_match}) NACH dem Zeitpunkt,
 * zu dem das Gerät den neuen Stand bestätigt hat. Das ist sauber ableitbar -
 * aber nur auf einer Anlage, die überhaupt STEUERT. Die heutigen Bestandsboxen
 * sind read-only (keine zertifizierte Familie), sie können diesen Beleg
 * strukturell nicht erzeugen.
 *
 * <p>Ein zweiwertiges Kriterium hätte hier genau zwei Auswege gehabt, beide
 * falsch: die Welle nie freigeben (das Feature wäre tot) oder so tun, als sei
 * der Zyklus erfüllt (eine erfundene Aussage über eine Kundenanlage). Deshalb
 * gibt es {@link Cycle#NICHT_PRUEFBAR}: die Welle darf weiter, und die
 * Oberfläche sagt SICHTBAR, dass dieser Teil nicht geprüft werden konnte. Ein
 * Gerät MIT Steuerpfad muss den Beleg dagegen wirklich liefern.
 */
public final class BakeGate {

    /** Wie lange ein Gerät den neuen Stand gesund fahren muss (D4). */
    public static final Duration HEALTHY_FOR = Duration.ofHours(24);

    /** Das Urteil über den Steuerzyklus eines Geräts. */
    public enum Cycle {
        /** Ein bestätigter Steuerzyklus nach der Bestätigung liegt vor. */
        ERFUELLT,
        /** Das Gerät steuert, hat aber seit dem Update noch nichts bestätigt. */
        OFFEN,
        /**
         * Auf diesem Gerät gibt es keinen Steuerpfad (nicht freigegeben / keine
         * Steuer-Rückmeldung) - der Beleg ist hier strukturell nicht zu haben.
         */
        NICHT_PRUEFBAR
    }

    /** Der Bake-Zustand EINES Geräts. */
    public record DeviceBake(java.util.UUID deviceId, boolean confirmed, Duration healthyFor,
            Duration remaining, Cycle cycle, String reason) {
    }

    /** Das Gesamturteil einer Welle. */
    public record WaveBake(boolean passed, String reason, List<DeviceBake> devices) {
    }

    private BakeGate() {
    }

    /**
     * Das Bake-Urteil EINES Geräts.
     *
     * @param state            der abgeleitete Zustand ({@link RolloutStates})
     * @param since            seit wann es in diesem Zustand ist
     * @param controlCertified ob auf diesem Gerät überhaupt gesteuert wird
     * @param controlConfirmed ob der letzte Steuerzyklus bestätigt wurde
     * @param controlCheckedAt wann dieser Steuerzyklus geprüft wurde
     */
    public static DeviceBake device(java.util.UUID deviceId, String state, Instant since,
            Boolean controlCertified, Boolean controlConfirmed, Instant controlCheckedAt,
            Instant now) {
        if (!RolloutStates.isConfirmed(state)) {
            return new DeviceBake(deviceId, false, Duration.ZERO, HEALTHY_FOR, Cycle.OFFEN,
                    "Dieses Gerät hat den neuen Stand noch nicht bestätigt.");
        }
        Instant from = since == null ? now : since;
        Duration healthy = Duration.between(from, now);
        if (healthy.isNegative()) {
            healthy = Duration.ZERO;
        }
        Duration remaining = HEALTHY_FOR.minus(healthy);
        if (remaining.isNegative()) {
            remaining = Duration.ZERO;
        }

        Cycle cycle;
        String reason = null;
        if (!Boolean.TRUE.equals(controlCertified)) {
            // Kein Steuerpfad auf dieser Box - der Beleg ist hier nicht zu
            // haben, und das wird GESAGT statt unterstellt.
            cycle = Cycle.NICHT_PRUEFBAR;
            reason = "Auf dieser Anlage steuert VoltPilot (noch) nicht - ein echter "
                    + "Steuerzyklus ist hier nicht prüfbar.";
        } else if (Boolean.TRUE.equals(controlConfirmed) && controlCheckedAt != null
                && !controlCheckedAt.isBefore(from)) {
            cycle = Cycle.ERFUELLT;
        } else {
            cycle = Cycle.OFFEN;
            reason = "Seit der Bestätigung des neuen Stands wurde noch kein Steuerzyklus "
                    + "bestätigt.";
        }
        boolean ok = !remaining.isPositive() && cycle != Cycle.OFFEN;
        if (ok) {
            reason = null;
        } else if (remaining.isPositive() && cycle != Cycle.OFFEN) {
            reason = "Noch " + hours(remaining) + " gesunder Betrieb bis zur Freigabe.";
        }
        return new DeviceBake(deviceId, true, healthy, remaining, cycle, reason);
    }

    /**
     * Das Urteil einer ganzen Welle. Sie ist frei, wenn JEDES ihrer Geräte frei
     * ist - ein einziges offenes Gerät hält die Welle, und der Grund benennt
     * es. Eine LEERE Welle ist frei (es gibt nichts zu beweisen).
     */
    public static WaveBake wave(List<DeviceBake> devices) {
        List<DeviceBake> list = devices == null ? List.of() : devices;
        List<String> blockers = new ArrayList<>();
        for (DeviceBake d : list) {
            if (!d.confirmed() || d.remaining().isPositive() || d.cycle() == Cycle.OFFEN) {
                blockers.add(d.reason() == null ? "offen" : d.reason());
            }
        }
        if (blockers.isEmpty()) {
            return new WaveBake(true, null, list);
        }
        String first = blockers.get(0);
        String reason = blockers.size() == 1 ? first
                : first + " (und " + (blockers.size() - 1) + " weitere Gerät"
                        + (blockers.size() == 2 ? "" : "e") + ")";
        return new WaveBake(false, reason, list);
    }

    private static String hours(Duration d) {
        long minutes = Math.max(1, d.toMinutes());
        if (minutes < 60) {
            return minutes + " Min.";
        }
        long h = minutes / 60;
        long m = minutes % 60;
        return m == 0 ? h + " Std." : h + " Std. " + m + " Min.";
    }
}
