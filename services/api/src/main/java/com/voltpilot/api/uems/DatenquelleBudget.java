package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.measurement.MeasurementBudget;
import com.voltpilot.api.measurement.MeasurementBudget.SourceCandidate;
import com.voltpilot.api.measurement.MeasurementBudget.SourceEstimate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * Reine Entscheidung des Lesebudgets je Box (UEMS AP-06 IP-10). Sie rechnet vor dem Schreiben;
 * eine Ablehnung verändert weder die neue noch eine bestehende Datenquelle.
 */
public final class DatenquelleBudget {

    private static final List<Integer> KUNDEN_TAKTE = List.of(
            10, 60, 180, 240, 300, 600, 900, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200, 86_400);

    private DatenquelleBudget() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zahlen(int channels, double samplesPerMinute, double requestsPerMinute,
            double dutyCyclePercent) {
        static Zahlen von(SourceEstimate e) {
            return new Zahlen(e.channels(), e.samplesPerMinute(), e.requestsPerMinute(),
                    e.dutyCyclePercent());
        }
    }

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnfrageKosten(int anfragenJeTakt, int kostenMsJeAnfrage) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record QuellenRechnung(String protokoll, int channels, int taktS,
            List<AnfrageKosten> anfragen, Zahlen last) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Grenzen(double samplesPerMinute, double requestsPerMinute,
            double dutyCyclePercent) {}

    /** Der Stand einer Box VOR der neuen Quelle. */
    public record BoxStand(UUID id, String name, List<SourceCandidate> quellen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FreieBox(UUID id, String name, Zahlen belegt, Zahlen frei,
            boolean quellePasst) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Auswege(Integer taktS, String takt, List<FreieBox> boxen, String andereBox) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ablehnung(String code, String kennzeichen, String box, QuellenRechnung quelle,
            Zahlen boxNachher, Grenzen grenzen, List<FreieBox> freieKapazitaet,
            Auswege auswege, List<String> gruende) {}

    public static Ablehnung pruefe(String kennzeichen, SourceCandidate quelle, UUID ziel,
            List<BoxStand> boxen) {
        BoxStand zielBox = boxen.stream().filter(b -> b.id().equals(ziel)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Die Ziel-Box fehlt in der Budgetlage."));
        SourceEstimate quellLast = MeasurementBudget.estimateSources(List.of(quelle));
        List<SourceCandidate> nachher = new ArrayList<>(zielBox.quellen());
        nachher.add(quelle);
        SourceEstimate zielLast = MeasurementBudget.estimateSources(nachher);
        if (!zielLast.hardRejected()) return null;

        List<FreieBox> frei = boxen.stream()
                .map(b -> freieBox(b, quelle))
                .sorted(Comparator.comparing(FreieBox::name, Comparator.nullsLast(String::compareTo)))
                .toList();
        Integer takt = taktAusweg(quelle, zielBox.quellen());
        List<FreieBox> andere = frei.stream()
                .filter(b -> !b.id().equals(ziel) && b.quellePasst()).toList();
        String taktSatz = takt == null ? null : "Takt " + takt + " s wählen";
        String boxSatz = andere.isEmpty() ? null : andere.get(0).name() + " wählen ("
                + zahl(andere.get(0).frei().requestsPerMinute()) + " Anfragen/min frei)";
        List<AnfrageKosten> anfragen = quelle.requests().stream()
                .map(r -> new AnfrageKosten(r.requestsPerCadence(), r.requestCostMs())).toList();
        return new Ablehnung("budget_ueberschritten", kennzeichen, zielBox.name(),
                new QuellenRechnung(quelle.protocol(), quelle.channels(), quelle.cadenceS(),
                        anfragen, Zahlen.von(quellLast)), Zahlen.von(zielLast), grenzen(), frei,
                new Auswege(takt, taktSatz, andere, boxSatz), zielLast.reasons());
    }

    private static FreieBox freieBox(BoxStand box, SourceCandidate quelle) {
        SourceEstimate ist = MeasurementBudget.estimateSources(box.quellen());
        List<SourceCandidate> mit = new ArrayList<>(box.quellen());
        mit.add(quelle);
        SourceEstimate danach = MeasurementBudget.estimateSources(mit);
        return new FreieBox(box.id(), box.name(), Zahlen.von(ist), new Zahlen(0,
                frei(MeasurementBudget.HARD_SAMPLES_PER_MINUTE, ist.samplesPerMinute()),
                frei(MeasurementBudget.HARD_REQUESTS_PER_MINUTE, ist.requestsPerMinute()),
                frei(MeasurementBudget.HARD_DUTY_CYCLE_PERCENT, ist.dutyCyclePercent())),
                !danach.hardRejected());
    }

    private static Integer taktAusweg(SourceCandidate quelle, List<SourceCandidate> bestand) {
        SourceEstimate ist = MeasurementBudget.estimateSources(bestand);
        SourceEstimate q = MeasurementBudget.estimateSources(List.of(quelle));
        double faktor = 1;
        faktor = Math.max(faktor, faktor(q.samplesPerMinute(),
                MeasurementBudget.HARD_SAMPLES_PER_MINUTE - ist.samplesPerMinute()));
        faktor = Math.max(faktor, faktor(q.requestsPerMinute(),
                MeasurementBudget.HARD_REQUESTS_PER_MINUTE - ist.requestsPerMinute()));
        faktor = Math.max(faktor, faktor(q.dutyCyclePercent(),
                MeasurementBudget.HARD_DUTY_CYCLE_PERCENT - ist.dutyCyclePercent()));
        if (!Double.isFinite(faktor)) return null;
        int mindestens = (int) Math.ceil(quelle.cadenceS() * faktor - 1e-9);
        for (int takt : KUNDEN_TAKTE) {
            if (takt >= mindestens && takt > quelle.cadenceS()) return takt;
        }
        return mindestens <= 86_400 ? mindestens : null;
    }

    private static double faktor(double last, double frei) {
        if (last <= 1e-9) return 1;
        return frei <= 1e-9 ? Double.POSITIVE_INFINITY : last / frei;
    }

    private static Grenzen grenzen() {
        return new Grenzen(MeasurementBudget.HARD_SAMPLES_PER_MINUTE,
                MeasurementBudget.HARD_REQUESTS_PER_MINUTE,
                MeasurementBudget.HARD_DUTY_CYCLE_PERCENT);
    }

    private static double frei(double grenze, double belegt) {
        return Math.round(Math.max(0, grenze - belegt) * 1_000.0) / 1_000.0;
    }

    private static String zahl(double wert) {
        return wert == Math.rint(wert) ? Long.toString(Math.round(wert))
                : Double.toString(wert);
    }
}
