package com.voltpilot.api.entities;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Die Entladegrenze, die am Wechselrichter selbst eingestellt ist, und ihre Regeln — ohne Datenbank, damit jede Regel
 * für sich prüfbar ist.
 *
 * <p><b>Welcher Wert.</b> Deye-Hybrid (1P und 3P): „Battery Low SOC“ (3P Register 117, 1P Register 219). Bei
 * angeschlossenem Netz entlädt der Deye nur mit aktivem Time of Use und dann bis zum SoC des Zeitfensters; dieser
 * Slot-SoC lässt sich am Gerät nicht unter „Battery Low SOC“ stellen. „Battery Low SOC“ ist damit die untere Schranke
 * jeder Entladegrenze am Gerät. Der Slot-SoC selbst wird NICHT übernommen: den ersten Slot schreibt VoltPilot im
 * ToU-Steuerweg selbst ({@code catalog/control-profiles/profiles/deye_tou.json}, Register 166) — eine Lesung davon
 * wäre ein Kreis. „Battery Low SOC“ schreibt VoltPilot nirgends.
 *
 * <p><b>Wirksam</b> ist das GRÖSSERE von Lesung und VoltPilot-Wert ({@code asset.soc_min_pct}, sonst die
 * Plattform-Vorgabe 5 %): VoltPilot plant nie unter dem, was der Wechselrichter zulässt, und ein höherer VoltPilot-Wert
 * bleibt als bewusste Reserve stehen. Ohne Lesung bleibt alles wie vorher.
 *
 * <p><b>Übernommen</b> wird nur eine plausible, aktuelle Lesung: Qualität {@code good}, 0–100 %, unter der
 * Obergrenze des Speichers, höchstens {@link #AKTUELL_HOECHSTENS} alt. Sonst gilt die letzte gültige Lesung mit
 * ihrem Zeitpunkt weiter — nie ein stiller Rückfall auf 5 %.
 */
public final class WechselrichterUntergrenze {

    /** Der Messpunkt je Deye-Familie (Katalog {@code catalog/measurement-points}). */
    public static final Map<String, String> PUNKT_JE_FAMILIE = Map.of(
            "hybrid_1p", "deye.hybrid_1p.settings.battery-low-soc",
            "hybrid_3p", "deye.hybrid_3p.settings.battery-low-soc");

    /** Älter als das ist eine Lesung nicht mehr aktuell: sie wird nicht übernommen, die Anzeige sagt es. */
    public static final Duration AKTUELL_HOECHSTENS = Duration.ofHours(1);

    /** Die Plattform-Vorgabe der Obergrenze, wenn am Speicher keine steht (wie {@code EntityRegistryService}). */
    public static final BigDecimal VORGABE_OBERGRENZE_PCT = BigDecimal.valueOf(95);

    public static final String VERWORFEN_UNPLAUSIBEL = "unplausibel";
    public static final String VERWORFEN_VERALTET = "veraltet";

    private WechselrichterUntergrenze() {
    }

    /** Eine gespeicherte Lesung der Box. {@code pct} ist null, wenn kein Zahlenwert ankam. */
    public record Lesung(Instant zeit, BigDecimal pct, String qualitaet) {}

    /** Die übernommene Grenze: der Wert, wann er zuletzt gültig gelesen wurde und seit wann er gilt. */
    public record Stand(BigDecimal socMinPct, Instant gelesenAm, Instant seit) {}

    /**
     * Das Ergebnis eines Abgleichs. {@code stand} ist null, solange nie etwas übernommen wurde. {@code juengste} ist
     * die jüngste Lesung überhaupt, {@code verworfen} ihr Grund, wenn sie nicht übernommen wurde.
     */
    public record Ergebnis(Stand stand, boolean wertGeaendert, BigDecimal vorher, Lesung juengste, String verworfen) {}

    /** Warum eine Lesung nicht übernommen wird, oder null, wenn sie gilt. */
    public static String verwerfen(Lesung lesung, BigDecimal obergrenzePct, Instant jetzt) {
        BigDecimal pct = lesung.pct();
        BigDecimal ober = obergrenzePct == null ? VORGABE_OBERGRENZE_PCT : obergrenzePct;
        if (pct == null || !"good".equals(lesung.qualitaet()) || pct.signum() < 0
                || pct.compareTo(BigDecimal.valueOf(100)) > 0 || pct.compareTo(ober) >= 0) {
            return VERWORFEN_UNPLAUSIBEL;
        }
        if (lesung.zeit() == null || jetzt.isAfter(lesung.zeit().plus(AKTUELL_HOECHSTENS))) {
            return VERWORFEN_VERALTET;
        }
        return null;
    }

    /**
     * Gleicht den bisherigen Stand mit den Lesungen ab (jüngste zuerst). Übernommen wird die jüngste plausible
     * Lesung, wenn sie aktuell ist; eine ältere plausible Lesung hinter einer veralteten gibt es nicht. Ein
     * geänderter Wert gilt sofort, in beide Richtungen.
     */
    public static Ergebnis abgleichen(Stand bisher, List<Lesung> juengsteZuerst, BigDecimal obergrenzePct,
            Instant jetzt) {
        BigDecimal vorher = bisher == null ? null : bisher.socMinPct();
        if (juengsteZuerst.isEmpty()) {
            return new Ergebnis(bisher, false, vorher, null, null);
        }
        Lesung juengste = juengsteZuerst.getFirst();
        String grundJuengste = verwerfen(juengste, obergrenzePct, jetzt);
        Lesung gilt = null;
        for (Lesung l : juengsteZuerst) {
            String grund = verwerfen(l, obergrenzePct, jetzt);
            if (grund == null) {
                gilt = l;
                break;
            }
            if (VERWORFEN_VERALTET.equals(grund)) {
                break; // jede ältere ist erst recht veraltet
            }
        }
        if (gilt == null) {
            return new Ergebnis(bisher, false, vorher, juengste, grundJuengste);
        }
        if (bisher == null || bisher.socMinPct().compareTo(gilt.pct()) != 0) {
            return new Ergebnis(new Stand(gilt.pct(), gilt.zeit(), gilt.zeit()), true, vorher, juengste,
                    grundJuengste);
        }
        Instant gelesen = bisher.gelesenAm().isAfter(gilt.zeit()) ? bisher.gelesenAm() : gilt.zeit();
        return new Ergebnis(new Stand(bisher.socMinPct(), gelesen, bisher.seit()), false, vorher, juengste,
                grundJuengste);
    }

    /** Ob die übernommene Grenze noch aktuell gelesen ist. */
    public static boolean aktuell(Stand stand, Instant jetzt) {
        return stand != null && stand.gelesenAm() != null
                && !jetzt.isAfter(stand.gelesenAm().plus(AKTUELL_HOECHSTENS));
    }

    /**
     * Die wirksame Untergrenze in %: der VoltPilot-Wert (sonst {@code vorgabePct}), angehoben auf die Lesung, wenn
     * eine übernommen ist und sie unter der Obergrenze liegt. Ohne Lesung genau der VoltPilot-Wert wie bisher.
     */
    public static double wirksamPct(BigDecimal voltpilotPct, BigDecimal gelesenPct, BigDecimal obergrenzePct,
            double vorgabePct) {
        double basis = voltpilotPct != null ? voltpilotPct.doubleValue() : vorgabePct;
        if (gelesenPct == null) {
            return basis;
        }
        BigDecimal ober = obergrenzePct == null ? VORGABE_OBERGRENZE_PCT : obergrenzePct;
        if (gelesenPct.compareTo(ober) >= 0) {
            return basis;
        }
        return Math.max(basis, gelesenPct.doubleValue());
    }

    /**
     * Ob die Lesung die wirksame Grenze bestimmt: sie gilt (unter der Obergrenze) und liegt nicht unter dem
     * VoltPilot-Wert. Bei Gleichstand nennt die Anzeige den Wechselrichter — dort ist die Grenze eingestellt.
     */
    public static boolean vomWechselrichter(BigDecimal voltpilotPct, BigDecimal gelesenPct, BigDecimal obergrenzePct,
            double vorgabePct) {
        if (gelesenPct == null) {
            return false;
        }
        BigDecimal ober = obergrenzePct == null ? VORGABE_OBERGRENZE_PCT : obergrenzePct;
        double basis = voltpilotPct != null ? voltpilotPct.doubleValue() : vorgabePct;
        return gelesenPct.compareTo(ober) < 0 && gelesenPct.doubleValue() >= basis;
    }
}
