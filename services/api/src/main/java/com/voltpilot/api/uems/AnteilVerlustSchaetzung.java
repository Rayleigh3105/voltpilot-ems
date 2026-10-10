package com.voltpilot.api.uems;

import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.forecast.ForecastModels;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die SCHÄTZUNG des Anteils-Verlusts je Box und Tag in der Cloud (UEMS AP-15 Folgepaket zu IP-22, E1 = A, R2). Die Box
 * meldet {@code verlust_kwh} als UNTERGRENZE — sie kennt die verfügbare Erzeugung einer abgeregelten PV nur aus
 * gemessenen Werten und meldet im Referenzfall R2 ≈ 0 kWh bei 9 h gebundener Zeit. Die Cloud kennt die PV-Prognose der
 * Anlage; daraus entsteht {@code schaetzung_kwh}, GETRENNT von der Untergrenze in derselben Zeile.
 *
 * <p><b>Die Regel</b> ({@link #schaetzen}): verfügbar je Viertelstunde = PV-Prognose der Anlage × kWp-Teil der Box
 * (dieselbe Teilung wie der Planlauf, IP-14, {@code verbund.py#fuer_lauf}); Verlust je Viertelstunde = verfügbar minus
 * gemessene PV der Box, nie unter 0. Die Box meldet nur die SUMME {@code gebunden_s}, keine Zeitfenster — darum
 * <b>Näherung:</b> die gebundene Zeit liegt in den Viertelstunden mit der HÖCHSTEN verfügbaren Erzeugung (ein fester
 * Einspeise-Anteil bindet genau dann, wenn die verfügbare Erzeugung über ihm liegt, also in den Sonnenstunden); es
 * zählen so viele davon, wie {@code gebunden_s} ergibt, die letzte anteilig. Eine Viertelstunde ohne Messung der Box
 * zählt nichts (unbekannt ist keine Null) — die Schätzung bleibt dort eher zu klein.
 *
 * <p><b>Grundlage:</b> {@code prognose} = je Viertelstunde der jüngste VOR ihr ausgegebene Wert des aktiven PV-Modells
 * der Anlage. {@code nowcast} ist im Vokabular vorbehalten, wird aber NICHT erzeugt: der Nowcast-Anker des Planlaufs
 * ({@code schedule.pv_anchor_ratio}) skaliert die Prognose nach der GEMESSENEN PV der Anlage — an einem Tag, an dem der
 * Anteil abregelt, lernte er genau die Abregelung als Prognosefehler und rechnete den Verlust klein. Ohne Prognose für
 * den Tag oder ohne kWp-Teil der Box: {@code keine}, kein Wert.
 *
 * <p>Gerechnet im Takt der Verbund-Bilanz ({@link VerbundBilanzLaeufer}), NUR für Zeilen, die eine Box gemeldet hat —
 * eine Anlage ohne Gemeinsame Steuerung und eine Box ohne Anteils-Dokument bekommen nie eine (I6). Idempotent: derselbe
 * Datenstand ergibt dieselbe Zahl, jeder Takt rechnet die letzten Tage mit dem heutigen Stand neu.
 */
@Service
public class AnteilVerlustSchaetzung {

    public static final String PROGNOSE = "prognose";
    public static final String NOWCAST = "nowcast";
    public static final String KEINE = "keine";

    static final int VIERTELSTUNDE_S = 900;

    /** Eine Viertelstunde: verfügbare Erzeugung der Box (kW) und ihre gemessene PV (kW, {@code null} = keine Messung). */
    public record Viertelstunde(Instant beginn, double verfuegbarKw, Double gemessenKw) {}

    private final AnteilVerlustRepository repo;
    private final ForecastModelService modelle;

    public AnteilVerlustSchaetzung(AnteilVerlustRepository repo, ForecastModelService modelle) {
        this.repo = repo;
        this.modelle = modelle;
    }

    /**
     * Die reine Regel: die {@code gebundenS} Sekunden auf die Viertelstunden mit der höchsten verfügbaren Erzeugung
     * gelegt (bei Gleichstand die frühere), je Viertelstunde {@code max(verfügbar − gemessen, 0)} × Stundenanteil.
     * {@code viertelstunden} leer = keine Prognose: leer.
     */
    static Optional<BigDecimal> schaetzen(List<Viertelstunde> viertelstunden, int gebundenS) {
        if (viertelstunden.isEmpty()) {
            return Optional.empty();
        }
        List<Viertelstunde> reihe = new ArrayList<>(viertelstunden);
        reihe.sort(Comparator.comparingDouble(Viertelstunde::verfuegbarKw).reversed()
                .thenComparing(Viertelstunde::beginn));
        double kwh = 0.0;
        int rest = Math.max(gebundenS, 0);
        for (Viertelstunde v : reihe) {
            if (rest <= 0) {
                break;
            }
            int s = Math.min(rest, VIERTELSTUNDE_S);
            rest -= s;
            if (v.gemessenKw() != null) {
                kwh += Math.max(v.verfuegbarKw() - v.gemessenKw(), 0.0) * s / 3600.0;
            }
        }
        return Optional.of(BigDecimal.valueOf(kwh).setScale(3, RoundingMode.HALF_UP));
    }

    /**
     * Rechnet die Schätzung jeder gemeldeten Zeile der Anlage in {@code [von, bis]} (Tage der Anlage) mit dem heutigen
     * Datenstand; unter dem {@code TenantContext} des Kundenbereichs. Gibt die Zahl der geschriebenen Zeilen zurück.
     */
    public int rechnen(UUID siteId, LocalDate von, LocalDate bis) {
        List<AnteilVerlustRepository.Tag> tage = repo.tage(siteId, von, bis);
        if (tage.isEmpty()) {
            return 0;
        }
        String modell = modelle.activeModels(siteId).get(ForecastModels.KIND_PV);
        Map<UUID, Double> kwp = repo.pvKwpJeBox(siteId);
        double gesamt = kwp.values().stream().mapToDouble(Double::doubleValue).sum();
        int n = 0;
        for (AnteilVerlustRepository.Tag t : tage) {
            Instant anfang = t.tag().atStartOfDay(AnteilVerlustAusHerzschlag.ZONE).toInstant();
            Instant ende = t.tag().plusDays(1).atStartOfDay(AnteilVerlustAusHerzschlag.ZONE).toInstant();
            double boxKwp = kwp.getOrDefault(t.deviceId(), 0.0);
            Map<Instant, Double> prognose = modell == null || gesamt <= 0 || boxKwp <= 0 ? Map.of()
                    : repo.pvPrognose(siteId, modell, anfang, ende);
            Optional<BigDecimal> kwh = Optional.empty();
            if (!prognose.isEmpty()) {
                double teil = Math.min(boxKwp / gesamt, 1.0);
                Map<Instant, Double> gemessen = repo.gemesseneViertelstunden(siteId, t.deviceId(), anfang, ende);
                List<Viertelstunde> vs = new ArrayList<>();
                prognose.forEach((beginn, kw) -> vs.add(new Viertelstunde(beginn, kw * teil, gemessen.get(beginn))));
                kwh = schaetzen(vs, t.gebundenS());
            }
            repo.schaetzungSetzen(t.deviceId(), t.tag(), kwh.orElse(null), kwh.isPresent() ? PROGNOSE : KEINE);
            n++;
        }
        return n;
    }
}
