package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.voltpilot.api.erzeuger.VorgabenRepository;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
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
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Der History-Dienst mit den Vorgaben einer Erzeugeranlage (UEMS EZ-9) - ohne Spring und ohne DB. Eine Anlage mit
 * Anlagensteuerung bekommt die neuen Ereignisarten in die Spur und die Zählung „Nach Art“; jede andere Anlage fragt
 * keine Vorgabe ab und ihre Antwort trägt keines der neuen Felder (bytegleich, {@link UemsVerbrauchBestandsschutzTest}).
 */
class HistoryVorgabenTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000e2009");
    private static final LocalDate TAG = LocalDate.parse("2026-10-21");

    private final ObjectMapper json = new ObjectMapper().registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private HistoryRepository repo;
    private VorgabenRepository vorgaben;
    private HistoryService service;

    @BeforeEach
    void dienst() {
        repo = mock(HistoryRepository.class);
        vorgaben = mock(VorgabenRepository.class);
        when(repo.tariffContext(SITE)).thenReturn(new HistoryRepository.TariffContext("fest", true));
        // Ein negativer Börsenpreis um 13:00 Uhr: die bisherigen Arten bleiben neben den Vorgaben stehen.
        when(repo.negativePriceSlots(eq("DE-LU"), any(), any())).thenReturn(
                List.of(new ValueSlot(Instant.parse("2026-10-21T11:00:00Z"), new BigDecimal("-5"))));
        service = new HistoryService(repo, mock(OptimizerDiagnosticsService.class), mock(EarningsRepository.class),
                vorgaben, true);
    }

    @Test
    void eineAnlageMitSteuerungBekommtVorgabenAlsEreignisseUndDieZaehlung() throws Exception {
        VorgabenRepository.Zeile nb = new VorgabenRepository.Zeile(UUID.randomUUID(), UUID.randomUUID(), null,
                "netzbetreiber", "p_begrenzung", Instant.parse("2026-10-21T08:00:00Z"), true,
                Instant.parse("2026-10-21T09:30:00Z"), true, Instant.parse("2026-10-21T09:30:00Z"),
                new BigDecimal("60"), null, null, null, new BigDecimal("51"), "pv_prognose",
                Map.of("2026-10-21", new BigDecimal("51")), new BigDecimal("6.12"), "fernwirktechnik", "bindend",
                false, false, 1, 2, List.of(), Map.of(), Map.of(), null);
        when(vorgaben.hatSteuerung(SITE)).thenReturn(true);
        when(vorgaben.vorgaben(eq(SITE), any(), any(), isNull(), isNull())).thenReturn(List.of(nb));
        when(vorgaben.luecken(eq(SITE), any(), any(), isNull())).thenReturn(List.of());
        when(vorgaben.verarbeitetBis(SITE)).thenReturn(Optional.of(Instant.parse("2026-10-21T13:45:00Z")));

        HistoryDto h = service.history(SITE, "DE-LU", HistoryRange.DAY, TAG);

        assertThat(h.events()).extracting(HistoryEventDto::type).containsExactly("netzbetreiber", "negativpreis");
        assertThat(h.events().get(0).vorgabe().id()).isEqualTo(nb.id());
        assertThat(h.vorgaben()).isNotNull();
        assertThat(h.vorgaben().zaehlung()).singleElement()
                .satisfies(z -> assertThat(z.anzahl()).isEqualTo(1));
        String text = json.writeValueAsString(h);
        assertThat(text).contains("\"vorgaben\":{\"verarbeitetBis\":\"2026-10-21T13:45:00Z\"");
        // Nur die Vorgabe trägt das Feld; der negative Preis bleibt wie er war.
        assertThat(text.split("\"vorgabe\":", -1)).hasSize(2);
    }

    @Test
    void eineAnlageOhneSteuerungFragtKeineVorgabeAbUndBleibtWieVorher() throws Exception {
        when(vorgaben.hatSteuerung(SITE)).thenReturn(false);

        HistoryDto h = service.history(SITE, "DE-LU", HistoryRange.MONTH, TAG);

        assertThat(h.vorgaben()).isNull();
        assertThat(h.events()).extracting(HistoryEventDto::type).containsExactly("negativpreis");
        verify(vorgaben, never()).vorgaben(any(), any(), any(), any(), any());
        String text = json.writeValueAsString(h);
        assertThat(text).doesNotContain("\"vorgaben\"").doesNotContain("\"vorgabe\"");
    }
}
