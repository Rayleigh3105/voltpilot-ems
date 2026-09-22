package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.List;

/**
 * Die EINE Lese-Regel der Grenzen am Netzanschluss (UEMS AP-15 IP-3, Kasten W1, Konzept §6.1): je Richtung gilt
 * der ENGERE Wert aus Anlage und Netzanschluss; ohne gebundenen Netzanschluss oder ohne gültige Fassung des
 * Grenzblatts der alte Wert der Anlage — dasselbe Objekt, damit eine Anlage ohne Eintrag Byte für Byte bleibt.
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr. Der Python-Zwilling ist
 * {@code services/optimization/voltpilot_optimization/grenze_aufloesung.py}; beide fahren
 * {@code docs/contracts/v2/netzanschluss-grenze-vectors.json}. <b>Wer die Regel ändert, ändert die Vektor-Datei UND
 * beide Zwillinge.</b>
 *
 * <p>Die Werte der Anlage: Einspeisung = {@code site.max_feed_in_kw}, Bezug = {@code site_charging_config.grid_limit_kw}
 * (die Anschlussgrenze des Ladeparks). Tarif und Vergütung ziehen NICHT um (W1).
 */
public final class GrenzeAufloesung {

    public static final String QUELLE_ANLAGE = "anlage";
    public static final String QUELLE_NETZANSCHLUSS = "netzanschluss";

    public static final String FEHLER_UEBER_VEREINBART = "grenze_ueber_vereinbart";
    public static final String FEHLER_UEBER_ANSCHLUSS = "grenze_ueber_anschluss";

    private GrenzeAufloesung() {}

    /** Die zwei Grenzen einer Seite; {@code null} = keine Grenze bekannt (nie 0 kW). */
    public record Grenzen(BigDecimal einspeisungKw, BigDecimal bezugKw) {}

    /** Eine Fassung des Grenzblatts: gilt ab ihrem Tag bis zum Vortag der nächsten. */
    public record Fassung(LocalDate gueltigAb, BigDecimal einspeisegrenzeKw, BigDecimal bezugsgrenzeKw,
            boolean einspeisegrenzeKeine) {
        public Fassung(LocalDate gueltigAb, BigDecimal einspeisegrenzeKw, BigDecimal bezugsgrenzeKw) {
            this(gueltigAb, einspeisegrenzeKw, bezugsgrenzeKw, false);
        }
    }

    /** Wert oder unbekannt; nur Einspeisung darf ausdrücklich unbegrenzt sein (I1). Quelle bleibt dabei das Blatt. */
    public record Wirksam(BigDecimal einspeisungKw, String quelleEinspeisung, BigDecimal bezugKw, String quelleBezug,
            boolean einspeisungKeine) {
        public boolean grenzenGesetzt() {
            return bezugKw != null && (einspeisungKw != null || einspeisungKeine);
        }
    }

    /** Die Fassung, die am {@code tag} gilt: die mit dem spätesten ersten Tag ≤ {@code tag}; sonst {@code null}. */
    public static Fassung fassungAm(List<Fassung> fassungen, LocalDate tag) {
        if (fassungen == null || tag == null) {
            return null;
        }
        return fassungen.stream()
                .filter(f -> !f.gueltigAb().isAfter(tag))
                .max(Comparator.comparing(Fassung::gueltigAb))
                .orElse(null);
    }

    /**
     * Die wirksamen Grenzen am {@code tag}. {@code gebunden} sagt, ob die Anlage an dem Tag an einem Netzanschluss
     * hängt; {@code fassungen} sind die wirksamen Fassungen DIESES Anschlusses.
     */
    public static Wirksam aufloesen(Grenzen anlage, boolean gebunden, List<Fassung> fassungen, LocalDate tag) {
        BigDecimal einspeisung = anlage == null ? null : anlage.einspeisungKw();
        BigDecimal bezug = anlage == null ? null : anlage.bezugKw();
        Fassung f = gebunden ? fassungAm(fassungen, tag) : null;
        BigDecimal naEinspeisung = f == null ? null : f.einspeisegrenzeKw();
        BigDecimal naBezug = f == null ? null : f.bezugsgrenzeKw();
        boolean keine = einspeisung == null && f != null && f.einspeisegrenzeKeine();
        return new Wirksam(
                engerer(einspeisung, naEinspeisung), keine ? QUELLE_NETZANSCHLUSS : quelle(einspeisung, naEinspeisung),
                engerer(bezug, naBezug), quelle(bezug, naBezug), keine);
    }

    /** Der engere Wert; gleich = der Wert der Anlage (dasselbe Objekt); einer fehlt = der andere. */
    public static BigDecimal engerer(BigDecimal anlage, BigDecimal netzanschluss) {
        if (netzanschluss == null) {
            return anlage;
        }
        if (anlage == null) {
            return netzanschluss;
        }
        return netzanschluss.compareTo(anlage) < 0 ? netzanschluss : anlage;
    }

    private static String quelle(BigDecimal anlage, BigDecimal netzanschluss) {
        BigDecimal wert = engerer(anlage, netzanschluss);
        if (wert == null) {
            return null;
        }
        return wert == anlage ? QUELLE_ANLAGE : QUELLE_NETZANSCHLUSS;
    }

    /**
     * Die Plausibilität einer Fassung gegen den Anschluss (AP-01 E10, bekannte Regel des Ladepark-Rahmens): die
     * Bezugsgrenze liegt nie über der vereinbarten Leistung, keine Grenze über der Anschlussleistung (kW ≤ kVA bei
     * cos φ = 1). Fehlt der Vergleichswert, gibt es nichts zu prüfen. {@code null} = plausibel, sonst der Code.
     */
    public static String plausibel(BigDecimal einspeisegrenzeKw, BigDecimal bezugsgrenzeKw, BigDecimal vereinbartKw,
            BigDecimal anschlussKva) {
        if (bezugsgrenzeKw != null && vereinbartKw != null && bezugsgrenzeKw.compareTo(vereinbartKw) > 0) {
            return FEHLER_UEBER_VEREINBART;
        }
        if (anschlussKva != null && ((bezugsgrenzeKw != null && bezugsgrenzeKw.compareTo(anschlussKva) > 0)
                || (einspeisegrenzeKw != null && einspeisegrenzeKw.compareTo(anschlussKva) > 0))) {
            return FEHLER_UEBER_ANSCHLUSS;
        }
        return null;
    }
}
