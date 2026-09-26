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
 * Regel nicht. Greift keine, bleibt die Liste leer und die Fläche sagt nur
 * „unter Null“. Einen Grund gibt es NUR für einen negativen Tag.
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

    /** Die Rangfolge; ein Tag trägt höchstens {@link #HOECHSTENS} davon, die ersten. */
    public static final List<String> RANGFOLGE = List.of(
            GESTERN_VERKAUFT, HAELT_ENERGIE_FUER_MORGEN, SO_GEPLANT, WENIG_SONNE,
            ANDERS_ALS_GEPLANT);

    public static final int HOECHSTENS = 2;

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
     * @param steuerungGeplantEur Fahrplan-Planwert des Tages ({@code steuerungPlannedEur})
     * @param pvKwh Erzeugung des Tages
     * @param loadKwh Verbrauch des Tages
     */
    public record Eingaben(
            BigDecimal steuerungEur,
            BigDecimal vergleichSocStartKwh,
            BigDecimal echtSocStartKwh,
            BigDecimal speicherVorsprungKwh,
            BigDecimal steuerungGeplantEur,
            BigDecimal pvKwh,
            BigDecimal loadKwh) {
    }

    /**
     * Die Gründe zu einer ausgelieferten Tageszahl und ihrer Einordnung - die
     * Brücke, die beide Controller benutzen; null, wenn es keine Einordnung
     * gibt (kein Tag oder keine Dreiteilung).
     */
    public static List<String> fuer(BigDecimal steuerungEur,
            EarningsRepository.Tageseinordnung e, BigDecimal steuerungGeplantEur) {
        if (steuerungEur == null || e == null) {
            return null;
        }
        return of(new Eingaben(steuerungEur, e.vergleichSocStartKwh(), e.echtSocStartKwh(),
                e.speicherVorsprungKwh(), steuerungGeplantEur, e.pvKwh(), e.loadKwh()));
    }

    /** Die Gründe eines Tages in Rangfolge, höchstens {@link #HOECHSTENS}; leer ohne Minus. */
    public static List<String> of(Eingaben e) {
        if (e == null || e.steuerungEur() == null || e.steuerungEur().signum() >= 0) {
            return List.of();
        }
        List<String> gruende = new ArrayList<>(RANGFOLGE.size());
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
        if (plan != null && plan.compareTo(SO_GEPLANT_UNTER_EUR) < 0) {
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
        return List.copyOf(gruende.subList(0, Math.min(HOECHSTENS, gruende.size())));
    }
}
