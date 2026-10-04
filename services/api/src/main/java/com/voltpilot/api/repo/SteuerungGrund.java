package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * Warum ein Tag der Steuerung UNTER NULL liegt - die GESCHLOSSENE Grund-Liste
 * aus dem Konzept {@code vp-erloese-minus-winter-k1} §7.2 (Captain-Entscheid
 * 24.09.2026, E3 = A): ein Minus bleibt gemessen und sichtbar, steht aber nie
 * allein. Die Kennungen sind Vokabular; die Worte dazu wählt die Fläche.
 *
 * <p><b>Nichts wird geraten.</b> Jede Regel braucht ihre Eingaben; fehlt eine
 * (kein gemessener Ladestand, kein Fahrplan-Planwert), greift genau diese
 * Regel nicht. Greift keine, steht die Rückfall-Kennung
 * {@link #ANDERS_GELADEN} da (Korrektur A1, Captain 29.09.2026 „mach alle
 * drei“): jedes Minus trägt einen Grund, auch das kleine ohne Übertrag und
 * ohne Planabweichung (19.09.2026: −0,72 € mit leerer Liste). Sie sagt nur,
 * was ein Minus per Definition bedeutet - der gesteuerte Speicher hat anders
 * geladen und entladen als der sture, und das hat sich an diesem Tag nicht
 * ausgezahlt -, und verdrängt nie eine der spezifischen Kennungen. Einen
 * Grund gibt es NUR für einen negativen Tag.
 *
 * <p><b>Netzladen nach MiSpeL</b> (MiSpeL MP-18c, Bedienkonzept BK-W5 = A,
 * Captain 04.10.2026): an einem MiSpeL-Tag, an dem der Speicher Netzstrom
 * gespeichert UND ins Netz zurückgegeben hat (Σ (1)¼ und Σ (2)¼ je
 * mindestens {@link #NETZLADEN_MISPEL_AB_KWH}, Anlage 1 S. 33–34), steht
 * {@link #NETZLADEN_MISPEL} vorn. Die Zahl ist dann die Stromrechnung ohne
 * die Gutschrift, die Anlage 1 erst im Kalendermonat bestimmt; an solchen
 * Tagen tragen weder {@link #SO_GEPLANT} (der Planwert rechnet blanken Spot
 * ohne Gutschrift) noch der Rückfall {@link #ANDERS_GELADEN} etwas bei.
 *
 * <p><b>Die Schwellen und die Rangfolge stehen in
 * {@code docs/contracts/steuerung-tag-vectors.json}</b> (Block {@code grund});
 * {@code SteuerungGrundTest} hält diese Konstanten und die Fälle dort gegen
 * die Datei fest - wer eine Schwelle ändert, ändert Datei und Klasse
 * zusammen.
 *
 * <p>Rein und Docker-frei prüfbar wie {@link SpeicherBank}; die Eingaben
 * kommen aus {@link EarningsRepository.Tageseinordnung} und dem Fahrplan
 * ({@code steuerungPlannedEur}).
 */
public final class SteuerungGrund {

    /**
     * MiSpeL-Tag mit Netzladen ins Netz: Σ (1)¼ und Σ (2)¼ des Tages je mindestens
     * {@link #NETZLADEN_MISPEL_AB_KWH} - die Gutschrift dafür rechnet Anlage 1 im Kalendermonat.
     */
    public static final String NETZLADEN_MISPEL = "netzladen_mispel";

    /** Der Vergleichsspeicher begann den Tag deutlich voller: die Steuerung hat am Vortag verkauft. */
    public static final String GESTERN_VERKAUFT = "gestern_verkauft";

    /** Der gesteuerte Speicher hält am Ende deutlich mehr als der sture - Wert erst morgen. */
    public static final String HAELT_ENERGIE_FUER_MORGEN = "haelt_energie_fuer_morgen";

    /** Der Fahrplan hat den Tag selbst unter Null geplant. */
    public static final String SO_GEPLANT = "so_geplant";

    /** Die Sonne deckte deutlich weniger als den Verbrauch - wenig zu verschieben. */
    public static final String WENIG_SONNE = "wenig_sonne";

    /** Geplant war kein Minus, gemessen wurde eins. */
    public static final String ANDERS_ALS_GEPLANT = "anders_als_geplant";

    /**
     * Rückfall (A1): keine spezifische Regel greift - der gesteuerte Speicher
     * hat im Tagesverlauf anders geladen und entladen als der sture.
     */
    public static final String ANDERS_GELADEN = "anders_geladen";

    /** Die Rangfolge; ein Tag trägt höchstens {@link #HOECHSTENS} davon, die ersten. */
    public static final List<String> RANGFOLGE = List.of(
            NETZLADEN_MISPEL, GESTERN_VERKAUFT, HAELT_ENERGIE_FUER_MORGEN, SO_GEPLANT,
            WENIG_SONNE, ANDERS_ALS_GEPLANT, ANDERS_GELADEN);

    public static final int HOECHSTENS = 2;

    /** Σ (1)¼ {@code ≥} und Σ (2)¼ {@code ≥} dieser Wert am MiSpeL-Tag (kWh). */
    public static final BigDecimal NETZLADEN_MISPEL_AB_KWH = BigDecimal.ONE;

    /** {@code vergleichSocStartKwh − echtSocStartKwh ≥} dieser Wert. */
    public static final BigDecimal GESTERN_VERKAUFT_AB_KWH = new BigDecimal("10");

    /** {@code speicherVorsprungKwh ≥} dieser Wert. */
    public static final BigDecimal HAELT_ENERGIE_AB_KWH = new BigDecimal("5");

    /** Fahrplan-Planwert des Tages {@code <} dieser Wert. */
    public static final BigDecimal SO_GEPLANT_UNTER_EUR = new BigDecimal("-0.50");

    /** Erzeugung {@code <} dieser Anteil am Verbrauch. */
    public static final BigDecimal WENIG_SONNE_UNTER_ANTEIL = new BigDecimal("0.60");

    /** Planwert {@code ≥} dieser Wert ... */
    public static final BigDecimal ANDERS_ALS_GEPLANT_PLAN_AB_EUR = BigDecimal.ZERO;

    /** ... und gemessen {@code <} dieser Wert. */
    public static final BigDecimal ANDERS_ALS_GEPLANT_UNTER_EUR = new BigDecimal("-1");

    private SteuerungGrund() {
    }

    /**
     * Die Eingaben eines Tages; jede darf fehlen.
     *
     * @param steuerungEur die gemessene Tageszahl der Steuerung (Definition A)
     * @param vergleichSocStartKwh Vergleichsspeicher um 00:00
     * @param echtSocStartKwh gemessener Ladestand um 00:00
     * @param speicherVorsprungKwh echter minus Vergleichsspeicher am Ende
     * @param steuerungGeplantEur Fahrplan-Planwert des Tages ({@code steuerungPlannedEur},
     *     seit M2 gegen denselben Vergleichsspeicher, {@link PlanMesslatte})
     * @param pvKwh Erzeugung des Tages
     * @param loadKwh Verbrauch des Tages
     * @param netzstromverbrauchSpeicherKwh Σ (1)¼ des Tages (zeitgleicher
     *     Netzstromverbrauch im Stromspeicher, Anlage 1 S. 33) - nur an einem
     *     MiSpeL-Tag, sonst null
     * @param netzeinspeisungSpeicherKwh Σ (2)¼ des Tages (zeitgleiche
     *     Netzeinspeisung aus dem Stromspeicher, Anlage 1 S. 34) - nur an einem
     *     MiSpeL-Tag, sonst null
     */
    public record Eingaben(
            BigDecimal steuerungEur,
            BigDecimal vergleichSocStartKwh,
            BigDecimal echtSocStartKwh,
            BigDecimal speicherVorsprungKwh,
            BigDecimal steuerungGeplantEur,
            BigDecimal pvKwh,
            BigDecimal loadKwh,
            BigDecimal netzstromverbrauchSpeicherKwh,
            BigDecimal netzeinspeisungSpeicherKwh) {

        /** Ein Tag ohne MiSpeL-Mengen (kein MiSpeL-Tag). */
        public Eingaben(BigDecimal steuerungEur, BigDecimal vergleichSocStartKwh,
                BigDecimal echtSocStartKwh, BigDecimal speicherVorsprungKwh,
                BigDecimal steuerungGeplantEur, BigDecimal pvKwh, BigDecimal loadKwh) {
            this(steuerungEur, vergleichSocStartKwh, echtSocStartKwh, speicherVorsprungKwh,
                    steuerungGeplantEur, pvKwh, loadKwh, null, null);
        }

        /** Netzladen ins Netz an einem MiSpeL-Tag: beide Tagessummen bekannt und je ab der Schwelle. */
        boolean netzladenMispel() {
            return netzstromverbrauchSpeicherKwh != null && netzeinspeisungSpeicherKwh != null
                    && netzstromverbrauchSpeicherKwh.compareTo(NETZLADEN_MISPEL_AB_KWH) >= 0
                    && netzeinspeisungSpeicherKwh.compareTo(NETZLADEN_MISPEL_AB_KWH) >= 0;
        }
    }

    /**
     * Die Gründe zu einer ausgelieferten Tageszahl und ihrer Einordnung - die
     * Brücke, die beide Controller benutzen; null, wenn es keine Einordnung
     * gibt (kein Tag oder keine Dreiteilung).
     */
    public static List<String> fuer(BigDecimal steuerungEur,
            EarningsRepository.Tageseinordnung e, BigDecimal steuerungGeplantEur) {
        return fuer(steuerungEur, e, steuerungGeplantEur, null);
    }

    /**
     * Wie {@link #fuer(BigDecimal, EarningsRepository.Tageseinordnung, BigDecimal)},
     * mit den MiSpeL-Mengen des Tages (null = kein MiSpeL-Tag).
     */
    public static List<String> fuer(BigDecimal steuerungEur,
            EarningsRepository.Tageseinordnung e, BigDecimal steuerungGeplantEur,
            EarningsRepository.MispelTagesmengen mispel) {
        if (steuerungEur == null || e == null) {
            return null;
        }
        return of(new Eingaben(steuerungEur, e.vergleichSocStartKwh(), e.echtSocStartKwh(),
                e.speicherVorsprungKwh(), steuerungGeplantEur, e.pvKwh(), e.loadKwh(),
                mispel == null ? null : mispel.netzstromverbrauchSpeicherKwh(),
                mispel == null ? null : mispel.netzeinspeisungSpeicherKwh()));
    }

    /**
     * Die Gründe eines Tages in Rangfolge, höchstens {@link #HOECHSTENS}; leer
     * ohne Minus, mit Minus nie leer ({@link #ANDERS_GELADEN} als Rückfall).
     */
    public static List<String> of(Eingaben e) {
        if (e == null || e.steuerungEur() == null || e.steuerungEur().signum() >= 0) {
            return List.of();
        }
        List<String> gruende = new ArrayList<>(RANGFOLGE.size());
        boolean netzladenMispel = e.netzladenMispel();
        if (netzladenMispel) {
            gruende.add(NETZLADEN_MISPEL);
        }
        if (e.vergleichSocStartKwh() != null && e.echtSocStartKwh() != null
                && e.vergleichSocStartKwh().subtract(e.echtSocStartKwh())
                        .compareTo(GESTERN_VERKAUFT_AB_KWH) >= 0) {
            gruende.add(GESTERN_VERKAUFT);
        }
        if (e.speicherVorsprungKwh() != null
                && e.speicherVorsprungKwh().compareTo(HAELT_ENERGIE_AB_KWH) >= 0) {
            gruende.add(HAELT_ENERGIE_FUER_MORGEN);
        }
        BigDecimal plan = e.steuerungGeplantEur();
        if (!netzladenMispel && plan != null && plan.compareTo(SO_GEPLANT_UNTER_EUR) < 0) {
            gruende.add(SO_GEPLANT);
        }
        if (e.pvKwh() != null && e.loadKwh() != null && e.loadKwh().signum() > 0
                && e.pvKwh().compareTo(e.loadKwh().multiply(WENIG_SONNE_UNTER_ANTEIL)) < 0) {
            gruende.add(WENIG_SONNE);
        }
        if (plan != null && plan.compareTo(ANDERS_ALS_GEPLANT_PLAN_AB_EUR) >= 0
                && e.steuerungEur().compareTo(ANDERS_ALS_GEPLANT_UNTER_EUR) < 0) {
            gruende.add(ANDERS_ALS_GEPLANT);
        }
        if (gruende.isEmpty()) {
            gruende.add(ANDERS_GELADEN);
        }
        return List.copyOf(gruende.subList(0, Math.min(HOECHSTENS, gruende.size())));
    }
}
