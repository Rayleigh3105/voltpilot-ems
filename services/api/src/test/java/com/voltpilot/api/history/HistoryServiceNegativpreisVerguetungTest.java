package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.repo.HistoryRepository.ValueSlot;
import com.voltpilot.api.web.dto.HistoryDto;
import com.voltpilot.api.web.dto.HistoryEventDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * N5 (vp-fahrplan-eigenverbrauch-konzept report.md §9): {@code negativePriceSlots}
 * is zone-wide, so the "Negative Preise" event used to fire for every site even
 * where a negative Börsenpreis never costs it anything - a feste EEG-Vergütung
 * stays positive regardless of spot ({@link SlotEconomics#exportValueCtKwh}),
 * so the plan never curtails for price there (solver.py PV curtailment). This
 * pins {@link HistoryService} to only surface the event when THIS site's
 * export value for the slot was actually negative.
 */
class HistoryServiceNegativpreisVerguetungTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000e2509");
    private static final LocalDate TAG = LocalDate.parse("2026-10-21");
    private static final Instant NEGATIVER_SLOT = Instant.parse("2026-10-21T11:00:00Z");

    private HistoryRepository repo;
    private OptimizerDiagnosticsService diagnostics;

    private HistoryService dienst(SiteEconomics site) {
        repo = mock(HistoryRepository.class);
        when(repo.tariffContext(SITE)).thenReturn(new HistoryRepository.TariffContext("fest", true));
        when(repo.negativePriceSlots(eq("DE-LU"), any(), any())).thenReturn(
                List.of(new ValueSlot(NEGATIVER_SLOT, new BigDecimal("-5"))));
        diagnostics = mock(OptimizerDiagnosticsService.class);
        when(diagnostics.economicsFor(eq(SITE), any(), any()))
                .thenReturn(new SlotEconomics(site, EegRates.defaults(), Map.of()));
        return new HistoryService(repo, diagnostics, mock(EarningsRepository.class), true);
    }

    private static SiteEconomics siteEconomics(String plantKind, boolean netzladen,
            LocalDate commissioned, Double anzulegenderWertCtKwh) {
        return new SiteEconomics(plantKind, netzladen, "ohne", null, anzulegenderWertCtKwh,
                commissioned, 9.0, null, null, 0.92, 4.0, null);
    }

    @Test
    void festeVerguetungVorDemCutoffBleibtOhneNegativpreisEreignis() {
        // Commissioned 2020: feste Vergütung, weit vor dem Solarspitzengesetz-
        // Stichtag - die Rate bleibt konstant positiv, egal was die Börse macht.
        SiteEconomics feste = siteEconomics("eigenverbrauch", false,
                LocalDate.of(2020, 1, 1), null);
        HistoryService service = dienst(feste);

        HistoryDto h = service.history(SITE, "DE-LU", HistoryRange.DAY, TAG);

        assertThat(h.events()).extracting(HistoryEventDto::type).doesNotContain("negativpreis");
    }

    @Test
    void direktvermarktungBekommtDasNegativpreisEreignisWeiterhin() {
        // Direktvermarktung ohne Monatsmarktwert faellt bei negativem Spot auf
        // den bloßen Spotpreis zurueck - die Einspeisung kostet hier wirklich.
        SiteEconomics dv = siteEconomics("direktvermarktung", false, null, 8.0);
        HistoryService service = dienst(dv);

        HistoryDto h = service.history(SITE, "DE-LU", HistoryRange.DAY, TAG);

        assertThat(h.events()).extracting(HistoryEventDto::type).contains("negativpreis");
    }

    @Test
    void mitSolarspitzengesetzWirdKeineVerguetungStattNegativpreisGemeldet() {
        // Scheibe S4 (vp-fahrplan-eigenverbrauch-konzept §4.7/§9): commissioned
        // ab dem Solarspitzengesetz-Stichtag - §51a klemmt die sonst feste
        // Vergütung in dieser negativen Viertelstunde auf 0,0, kein echter
        // negativer Satz. Dasselbe zonenweite Fenster wie oben, aber ein
        // anderes Ereignis - end-to-end durch die echte SlotEconomics, nicht
        // nur die reine Ereignisse.build()-Fallstudie in EreignisseTest.
        SiteEconomics s51a = siteEconomics("eigenverbrauch", false,
                LocalDate.of(2025, 3, 1), null);
        HistoryService service = dienst(s51a);

        HistoryDto h = service.history(SITE, "DE-LU", HistoryRange.DAY, TAG);

        assertThat(h.events()).extracting(HistoryEventDto::type)
                .contains("keine-verguetung")
                .doesNotContain("negativpreis");
    }

    @Test
    void ohneAnlagenOekonomieBleibtDerZonenweiteFundStehen() {
        repo = mock(HistoryRepository.class);
        when(repo.tariffContext(SITE)).thenReturn(new HistoryRepository.TariffContext("fest", true));
        when(repo.negativePriceSlots(eq("DE-LU"), any(), any())).thenReturn(
                List.of(new ValueSlot(NEGATIVER_SLOT, new BigDecimal("-5"))));
        diagnostics = mock(OptimizerDiagnosticsService.class); // economicsFor() -> null (RLS)
        HistoryService service = new HistoryService(repo, diagnostics, mock(EarningsRepository.class), true);

        HistoryDto h = service.history(SITE, "DE-LU", HistoryRange.DAY, TAG);

        assertThat(h.events()).extracting(HistoryEventDto::type).contains("negativpreis");
    }
}
