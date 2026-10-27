package com.voltpilot.api.ocpp;

import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.repo.ChargingEconomicsRepository;
import com.voltpilot.api.repo.ChargingEconomicsRepository.SlotMix;
import com.voltpilot.api.repo.ChargingEconomicsRepository.SpotSlot;
import com.voltpilot.api.web.dto.OcppDto;
import java.time.Duration;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * „Ladungen" mit Herkunft und Geld (Konzept „Ein Ort fürs Laden" e1, Scheibe 2,
 * Abschnitt 4.4): je beendeter Ladung eines Ladepunkts die Menge, einen
 * anteiligen Sonnenanteil und den Euro-Betrag auf DERSELBEN Preisgrundlage wie
 * die Erlöse - Netzstrom zum Bezugspreis, Sonne/Speicher zum wirksamen Satz
 * der Einspeisevergütung ({@link SlotEconomics}, PR „Einspeisevergütung unter
 * Strom & Geld"), nie eine zweite Preiswelt.
 *
 * <p>Der Sonnenanteil ist ein ANTEILIGER SCHLUSS aus der Hausbilanz der ganzen
 * Anlage je Viertelstunde - die Wallbox misst ihre eigene Herkunft nicht,
 * genau wie {@code quellenAnteil} im Portal es für jedes andere Gerät schon
 * nicht tut. Fehlt eine Zutat (Zählerstand, Preis, Hausbilanz), bleibt das
 * Ergebnis {@code null} statt einer geratenen Zahl.
 */
@Service
public class OcppTransactionEconomicsService {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Duration SLOT = Duration.ofMinutes(15);
    /** Unter dieser Hauslast ist ein Anteil nicht aussagekräftig (Rauschen). */
    private static final double LOAD_DEADBAND_KWH = 0.02;

    private final OcppRepository ocpp;
    private final ChargingEconomicsRepository economics;
    private final OptimizerDiagnosticsService diagnostics;

    public OcppTransactionEconomicsService(OcppRepository ocpp, ChargingEconomicsRepository economics,
            OptimizerDiagnosticsService diagnostics) {
        this.ocpp = ocpp;
        this.economics = economics;
        this.diagnostics = diagnostics;
    }

    /**
     * Die beendeten Ladungen EINER ANLAGE (alle Ladepunkte) in einem
     * Kalendermonat (Europe/Berlin), neueste zuerst - der Aufrufer filtert
     * nach Ladepunkt über {@code chargePointId} auf dem Ergebnis, genauso wie
     * die rohe {@code /transactions}-Liste schon site-weit kommt.
     */
    public List<OcppDto.TransactionEconomics> forMonth(UUID siteId, YearMonth month) {
        Instant from = month.atDay(1).atStartOfDay(BERLIN).toInstant();
        Instant to = month.plusMonths(1).atDay(1).atStartOfDay(BERLIN).toInstant();

        List<OcppDto.Transaction> sessions = ocpp.transactionsForMonth(siteId, from, to);
        if (sessions.isEmpty()) {
            return List.of();
        }

        // ⚠ EINE Preisregel: dieselbe Rekomposition, die auch der Fahrplan liest
        // (SchedulePricingService) - nie eine eigene SQL-Preisformel daneben.
        SlotEconomics slotEconomics = diagnostics.economicsFor(siteId, from, to);
        String zone = economics.biddingZone(siteId);
        Map<Instant, Double> spotBySlot = new HashMap<>();
        if (zone != null) {
            for (SpotSlot s : economics.spotPrices(zone, from, to)) {
                spotBySlot.put(s.slot(), s.priceEurMwh());
            }
        }
        Map<Instant, SlotMix> mixBySlot = new HashMap<>();
        for (SlotMix m : economics.slotMix(siteId, from, to)) {
            mixBySlot.put(m.bucket(), m);
        }

        List<OcppDto.TransactionEconomics> out = new ArrayList<>(sessions.size());
        for (OcppDto.Transaction t : sessions) {
            out.add(economicsFor(t, slotEconomics, spotBySlot, mixBySlot));
        }
        return out;
    }

    private static OcppDto.TransactionEconomics economicsFor(OcppDto.Transaction t, SlotEconomics econ,
            Map<Instant, Double> spotBySlot, Map<Instant, SlotMix> mixBySlot) {
        Double kwh = kwh(t.meterStart(), t.meterStop());
        List<Instant> buckets = bucketsCovering(t.startedAt(), t.stoppedAt());

        double pvShareSum = 0;
        int pvShareN = 0;
        double importCtSum = 0;
        int importCtN = 0;
        double exportCtSum = 0;
        int exportCtN = 0;
        for (Instant bucket : buckets) {
            SlotMix mix = mixBySlot.get(bucket);
            if (mix != null && mix.loadKwh() != null && mix.loadKwh() > LOAD_DEADBAND_KWH && mix.pvKwh() != null) {
                double discharge = mix.batteryDischargeKwh() != null ? Math.max(0, mix.batteryDischargeKwh()) : 0;
                double share = Math.min(1.0, Math.max(0.0, (mix.pvKwh() + discharge) / mix.loadKwh()));
                pvShareSum += share;
                pvShareN++;
            }
            if (econ != null) {
                Double spot = spotBySlot.get(bucket);
                Double importCt = econ.importPriceCtKwh(spot);
                Double exportCt = econ.exportValueCtKwh(spot, bucket);
                if (importCt != null) {
                    importCtSum += importCt;
                    importCtN++;
                }
                if (exportCt != null) {
                    exportCtSum += exportCt;
                    exportCtN++;
                }
            }
        }

        Double sonnenanteil = pvShareN > 0 ? pvShareSum / pvShareN : null;
        Double importCt = importCtN > 0 ? importCtSum / importCtN : null;
        Double exportCt = exportCtN > 0 ? exportCtSum / exportCtN : null;
        Double avgCt = (sonnenanteil != null && importCt != null && exportCt != null)
                ? sonnenanteil * exportCt + (1 - sonnenanteil) * importCt
                : null;
        Double euro = (kwh != null && avgCt != null) ? kwh * avgCt / 100.0 : null;

        return new OcppDto.TransactionEconomics(t.chargePointId(), t.transactionId(), t.startedAt(),
                t.stoppedAt(), kwh, sonnenanteil == null ? null : sonnenanteil * 100.0, euro, avgCt,
                t.startIdTagRef());
    }

    /** Dieselbe Regel wie {@code transaktionsKwh} im Portal ({@code steuerung/ladungen.ts}): nie aus einer laufenden Sitzung. */
    private static Double kwh(long meterStart, Long meterStop) {
        if (meterStop == null) {
            return null;
        }
        long delta = meterStop - meterStart;
        return delta >= 0 ? delta / 1000.0 : null;
    }

    private static List<Instant> bucketsCovering(Instant start, Instant stop) {
        Instant end = stop != null ? stop : start;
        Instant from = floor15(start);
        Instant to = floor15(end);
        List<Instant> out = new ArrayList<>();
        for (Instant b = from; !b.isAfter(to); b = b.plus(SLOT)) {
            out.add(b);
        }
        return out;
    }

    private static Instant floor15(Instant at) {
        long epoch = at.getEpochSecond();
        long slotSeconds = SLOT.getSeconds();
        return Instant.ofEpochSecond(epoch - Math.floorMod(epoch, slotSeconds));
    }
}
