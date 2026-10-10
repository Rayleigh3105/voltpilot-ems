package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

/**
 * Die Abhängigkeits-Regel zweier Variablen (UEMS AP-17 G4, V5): Pearson-r über die Monatspaare der Referenzperiode;
 * ab |r| ≥ 0,9 (Startwert, G6) hängen sie aneinander — {@code variablen_abhaengig}. Rein, ohne Datenbank.
 *
 * <p>Die Entscheidung an der Schwelle trifft NICHT diese Klasse, sondern {@link BezugsbasisRegeln#abhaengigkeit} (IP-2,
 * exakt als {@code Sxy² ≥ 0,81·Sxx·Syy}) — eine Wahrheit für Vorschlag und Übernahme. Hier stehen nur die Paare, die
 * Gründe ohne Zahl und r für den Hinweis.
 *
 * <p>Der Vertrag steht in {@code docs/contracts/v2/variablen-vorschlag-vectors.json}; der TS-Zwilling
 * {@code frontend/portal/src/variablenAbhaengigkeit.ts} fährt dieselbe Datei. Der Variablen-Vorschlag (IP-11a) zeigt
 * das Ergebnis als Hinweis; abgelehnt wird erst beim Übernehmen in eine Fassung (IP-11b mit IP-8/IP-9).
 */
public final class VariablenAbhaengigkeit {

    public static final BigDecimal SCHWELLE = new BigDecimal(BezugsbasisRegeln.STARTWERTE.abhaengig_r());
    /** Unter drei Monatspaaren ist r keine Aussage (zwei Punkte liegen immer auf einer Geraden). */
    public static final int MINDEST_PAARE = 3;

    public static final String UNABHAENGIG = "unabhaengig";
    public static final String ABHAENGIG = "variablen_abhaengig";
    public static final String NICHT_PRUEFBAR = "nicht_pruefbar";
    public static final List<String> ERGEBNISSE = List.of(UNABHAENGIG, ABHAENGIG, NICHT_PRUEFBAR);

    public static final String ZU_WENIG_PAARE = "zu_wenig_paare";
    public static final String KEINE_STREUUNG = "keine_streuung";
    public static final String KEINE_VARIABLE_1 = "keine_variable_1";
    public static final List<String> GRUENDE = List.of(ZU_WENIG_PAARE, KEINE_STREUUNG, KEINE_VARIABLE_1);

    /** Ein Monat, in dem beide Variablen einen Wert haben. */
    public record Paar(BigDecimal x, BigDecimal y) {}

    /** {@code r} fehlt, wenn nicht prüfbar; {@code grund} nur dann. */
    public record Ergebnis(String ergebnis, Double r, int paare, String grund) {}

    private VariablenAbhaengigkeit() {
    }

    public static Ergebnis pruefe(List<Paar> paare) {
        int n = paare.size();
        if (n < MINDEST_PAARE) {
            return new Ergebnis(NICHT_PRUEFBAR, null, n, ZU_WENIG_PAARE);
        }
        Double r = pearson(paare);
        if (r == null) {
            return new Ergebnis(NICHT_PRUEFBAR, null, n, KEINE_STREUUNG);
        }
        boolean abhaengig = Boolean.TRUE.equals(BezugsbasisRegeln.abhaengigkeit(
                paare.stream().map(p -> p.x().toPlainString()).toList(),
                paare.stream().map(p -> p.y().toPlainString()).toList()).get("abhaengig"));
        return new Ergebnis(abhaengig ? ABHAENGIG : UNABHAENGIG, r, n, null);
    }

    public static Ergebnis ohneVariable1() {
        return new Ergebnis(NICHT_PRUEFBAR, null, 0, KEINE_VARIABLE_1);
    }

    /** Pearson-r für die Anzeige (ungerundet); {@code null}, wenn eine der beiden Reihen konstant ist. */
    static Double pearson(List<Paar> paare) {
        int n = paare.size();
        double mx = 0;
        double my = 0;
        for (Paar p : paare) {
            mx += p.x().doubleValue();
            my += p.y().doubleValue();
        }
        mx /= n;
        my /= n;
        double sxy = 0;
        double sxx = 0;
        double syy = 0;
        for (Paar p : paare) {
            double dx = p.x().doubleValue() - mx;
            double dy = p.y().doubleValue() - my;
            sxy += dx * dy;
            sxx += dx * dx;
            syy += dy * dy;
        }
        if (sxx == 0 || syy == 0) {
            return null;
        }
        return sxy / Math.sqrt(sxx * syy);
    }

    /** r im Kundensatz: drei Stellen, Komma, echtes Minus („0,997“, „−0,950“). */
    public static String rText(double r) {
        String betrag = BigDecimal.valueOf(Math.abs(r)).setScale(3, RoundingMode.HALF_UP).toPlainString()
                .replace('.', ',');
        return (r < 0 && !"0,000".equals(betrag) ? "−" : "") + betrag;
    }

    /** Der Hinweis an einem abhängigen Kandidaten (Vorschlag, noch keine Ablehnung). */
    public static String abhaengigSatz(String kandidat, String variable1, double r) {
        return kandidat + " hängt an " + variable1 + " (r = " + rText(r) + "). Ein Modell mit zwei Einflussgrößen "
                + "braucht unabhängige Größen.";
    }
}
