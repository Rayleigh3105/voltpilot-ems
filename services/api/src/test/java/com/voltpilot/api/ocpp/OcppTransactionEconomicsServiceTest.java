package com.voltpilot.api.ocpp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics;
import com.voltpilot.api.repo.ChargingEconomicsRepository;
import com.voltpilot.api.repo.ChargingEconomicsRepository.SlotMix;
import com.voltpilot.api.repo.ChargingEconomicsRepository.SpotSlot;
import com.voltpilot.api.web.dto.OcppDto;
import java.time.Instant;
import java.time.YearMonth;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * „Ladungen" mit Herkunft und Geld (Konzept „Ein Ort fürs Laden" e1, Scheibe 2,
 * Abschnitt 4.4): pure unit tests over {@link OcppTransactionEconomicsService},
 * mocking its three collaborators the way {@code SchedulePricingServiceTest}
 * mocks {@code OptimizerDiagnosticsService} - the price RULES themselves are
 * pinned by {@code SlotEconomicsTest} and must not be re-implemented here.
 */
class OcppTransactionEconomicsServiceTest {

    private static final UUID SITE = UUID.randomUUID();
    private static final String CP = "CP-1";
    private static final YearMonth MONTH = YearMonth.of(2026, 10);

    /** Die Anlage aus dem Konzept-Beispiel (§4.4): Bezugspreis 31 ct fest, Einspeisewert 7,9 ct, kein §51a. */
    private static SlotEconomics artefaktAnlage() {
        SiteEconomics site = new SiteEconomics("eigenverbrauch", false, "fest", 31.0,
                null, null, null, 7.9, false, null, null, null);
        return new SlotEconomics(site, EegRates.fromJson(null), Map.of(), false);
    }

    private static OcppDto.Transaction session(int transactionId, Instant started, Instant stopped,
            long meterStartWh, Long meterStopWh, String cardRef) {
        return new OcppDto.Transaction(UUID.randomUUID(), CP, transactionId, 1, started, stopped,
                meterStartWh, meterStopWh, null, cardRef, cardRef, null, null, null, null, null, null,
                null, null);
    }

    private static OcppTransactionEconomicsService service(
            List<OcppDto.Transaction> sessions, List<SpotSlot> spots, List<SlotMix> mix, SlotEconomics economics) {
        OcppRepository ocpp = mock(OcppRepository.class);
        when(ocpp.transactionsForMonth(eq(SITE), any(), any())).thenReturn(sessions);
        ChargingEconomicsRepository repo = mock(ChargingEconomicsRepository.class);
        when(repo.biddingZone(SITE)).thenReturn("DE-LU");
        when(repo.spotPrices(eq("DE-LU"), any(), any())).thenReturn(spots);
        when(repo.slotMix(eq(SITE), any(), any())).thenReturn(mix);
        OptimizerDiagnosticsService diagnostics = mock(OptimizerDiagnosticsService.class);
        when(diagnostics.economicsFor(eq(SITE), any(), any())).thenReturn(economics);
        return new OcppTransactionEconomicsService(ocpp, repo, diagnostics);
    }

    @Test
    void theArtefaktExample_18komma2Kwh62ProzentSonne_kostet3komma04Euro() {
        // Eine Ladung von 08:00 bis 08:10 Uhr, ganz in der Viertelstunde 08:00 -
        // ihre Hausbilanz: 10 kWh Last, 6,2 kWh Sonne (62 %).
        Instant start = Instant.parse("2026-10-05T08:00:00Z");
        Instant stop = Instant.parse("2026-10-05T08:10:00Z");
        Instant bucket = Instant.parse("2026-10-05T08:00:00Z");
        OcppDto.Transaction t = session(1, start, stop, 0, 18_200L, "tagref_abcd1234");

        var economics = service(List.of(t), List.of(), List.of(
                new SlotMix(bucket, 6.2, 10.0, 3.8, 0.0, 0.0)), artefaktAnlage());

        List<OcppDto.TransactionEconomics> result = economics.forMonth(SITE, MONTH);

        assertThat(result).hasSize(1);
        OcppDto.TransactionEconomics e = result.get(0);
        assertThat(e.kwh()).isCloseTo(18.2, within(1e-9));
        assertThat(e.sonnenanteilPct()).isCloseTo(62.0, within(1e-9));
        assertThat(e.durchschnittCtKwh()).isCloseTo(16.678, within(1e-9));
        assertThat(e.euro()).isCloseTo(3.0353, within(0.001));
        // Zuordnung über das Karten-Pseudonym der Box, nie den OCPP-Bezug.
        assertThat(e.kartenRef()).isEqualTo("tagref_abcd1234");
        assertThat(e.chargePointId()).isEqualTo(CP);
    }

    @Test
    void ohneHausbilanzBleibtDerSonnenanteilUndDasGeldUnbekannt() {
        Instant start = Instant.parse("2026-10-05T08:00:00Z");
        Instant stop = Instant.parse("2026-10-05T08:10:00Z");
        OcppDto.Transaction t = session(1, start, stop, 0, 7_400L, "tagref_x");

        // Keine Hausbilanz für diese Viertelstunde (Datenlücke) - kein erfundener Anteil, kein erfundenes Geld.
        var economics = service(List.of(t), List.of(), List.of(), artefaktAnlage());

        OcppDto.TransactionEconomics e = economics.forMonth(SITE, MONTH).get(0);
        assertThat(e.kwh()).isCloseTo(7.4, within(1e-9));
        assertThat(e.sonnenanteilPct()).isNull();
        assertThat(e.euro()).isNull();
        assertThat(e.durchschnittCtKwh()).isNull();
    }

    @Test
    void eineLaufendeSitzungHatKeineMenge() {
        // `transactionsForMonth` liefert ohnehin nur beendete Ladungen - diese
        // Probe belegt nur, dass ein fehlender Endzählerstand nie 0 kWh wird.
        Instant start = Instant.parse("2026-10-05T08:00:00Z");
        OcppDto.Transaction t = session(1, start, null, 0, null, "tagref_x");

        var economics = service(List.of(t), List.of(), List.of(
                new SlotMix(Instant.parse("2026-10-05T08:00:00Z"), 6.2, 10.0, 3.8, 0.0, 0.0)), artefaktAnlage());

        OcppDto.TransactionEconomics e = economics.forMonth(SITE, MONTH).get(0);
        assertThat(e.kwh()).isNull();
        assertThat(e.euro()).isNull();
    }

    @Test
    void ohneGepreisteAnlage_RLS_verdeckt_bleibtDasGeldUnbekanntAberDieMengeStehtWeiterhin() {
        Instant start = Instant.parse("2026-10-05T08:00:00Z");
        Instant stop = Instant.parse("2026-10-05T08:10:00Z");
        OcppDto.Transaction t = session(1, start, stop, 0, 7_400L, "tagref_x");

        var economics = service(List.of(t), List.of(), List.of(
                new SlotMix(Instant.parse("2026-10-05T08:00:00Z"), 6.2, 10.0, 3.8, 0.0, 0.0)), null);

        OcppDto.TransactionEconomics e = economics.forMonth(SITE, MONTH).get(0);
        assertThat(e.kwh()).isCloseTo(7.4, within(1e-9));
        assertThat(e.sonnenanteilPct()).isCloseTo(62.0, within(1e-9));
        assertThat(e.euro()).isNull();
        assertThat(e.durchschnittCtKwh()).isNull();
    }

    @Test
    void ohneLadungenWirdNichtsAbgefragt() {
        var economics = service(List.of(), List.of(), List.of(), artefaktAnlage());
        assertThat(economics.forMonth(SITE, MONTH)).isEmpty();
    }
}
