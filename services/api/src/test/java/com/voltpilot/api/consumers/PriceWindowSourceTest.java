package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.consumers.ConsumerPolicyCompiler.Window;
import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.web.dto.PricePointDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/**
 * Die Preisbedingung einer Verbraucherregel als konkrete UTC-Fenster (D1, eine Preiswahrheit):
 * welcher Slot gilt, wie Slots zu Fenstern zusammenwachsen, die Viertelstunde vor der Stunde und
 * der Bezugspreis über dieselbe {@link SlotEconomics} wie Fahrplan und Diagnose. Ein leeres
 * Ergebnis ist „unbekannt" - der Compiler macht daraus das abgelaufene Fenster, nie eine Annahme.
 */
class PriceWindowSourceTest {

    private static final UUID SITE = UUID.randomUUID();
    private static final Instant T0 = Instant.parse("2026-06-15T10:00:00Z");

    private JdbcTemplate jdbc;
    private PriceRepository prices;
    private OptimizerDiagnosticsService diagnostics;
    private PriceWindowSource source;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        jdbc = mock(JdbcTemplate.class);
        prices = mock(PriceRepository.class);
        diagnostics = mock(OptimizerDiagnosticsService.class);
        when(jdbc.query(any(String.class), any(RowMapper.class), eq(SITE))).thenReturn(List.of("DE-LU"));
        source = new PriceWindowSource(jdbc, prices, diagnostics);
    }

    /** Viertelstunden ab {@code start}, je ein Preis in €/MWh. */
    private static List<PricePointDto> viertelstunden(Instant start, double... eurMwh) {
        List<PricePointDto> out = new ArrayList<>();
        for (int i = 0; i < eurMwh.length; i++) {
            Instant von = start.plus(Duration.ofMinutes(15L * i));
            out.add(new PricePointDto(von, von.plus(Duration.ofMinutes(15)), BigDecimal.valueOf(eurMwh[i])));
        }
        return out;
    }

    private static PricePointDto stunde(Instant start, double eurMwh) {
        return new PricePointDto(start, start.plus(Duration.ofHours(1)), BigDecimal.valueOf(eurMwh));
    }

    private void preise(List<PricePointDto> punkte) {
        when(prices.findForZone(eq("DE-LU"), any(), any(), anyInt())).thenReturn(punkte);
    }

    private static Instant t(int minuten) {
        return T0.plus(Duration.ofMinutes(minuten));
    }

    @Test
    void zusammenhaengendeSlotsWerdenEinFensterUndEinSlotDaneben_trennt() {
        // Spot in ct/kWh: 5, 6, 12, 4 → "unter 10" gilt in den Slots 1, 2 und 4.
        preise(viertelstunden(T0, 50, 60, 120, 40));
        List<Window> fenster = source.windows(SITE, "market.spot_ct_kwh", "lt", 10, T0, t(60));
        assertThat(fenster).containsExactly(new Window(t(0), t(30)), new Window(t(45), t(60)));
        // Der Vergleich ist genau: "lte" nimmt die Grenze mit, "lt" nicht.
        preise(viertelstunden(T0, 100));
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "lt", 10, T0, t(15))).isEmpty();
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "lte", 10, T0, t(15)))
                .containsExactly(new Window(t(0), t(15)));
    }

    @Test
    void dasFensterBeginntFruehestensBeiFromUndEndetMitDemSlot() {
        // Ein Slot, der vor from beginnt, gilt ab from; die Abfrage holt dafür eine Stunde Vorlauf.
        preise(viertelstunden(t(-15), 30, 30));
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "lt", 10, t(5), t(60)))
                .containsExactly(new Window(t(5), t(15)));
        verify(prices).findForZone(eq("DE-LU"), eq(t(5).minus(Duration.ofHours(1))), eq(t(60)), anyInt());
    }

    @Test
    void einSlotDerGenauBeiFromEndetIstVorbei() {
        // Halboffen: [t-15, t) liegt ganz vor from = t. Kein Fenster [t, t) - das hieße am Rand nicht
        // „unbekannt", sondern „gilt gerade nicht".
        preise(viertelstunden(t(-15), 30, 200));
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "lt", 10, t(0), t(60))).isEmpty();
    }

    @Test
    void dieViertelstundeSchlaegtDieStundeDieSieUeberdeckt() {
        // 10:00 hat Viertelstunden (alle billig) UND eine teure Stundenzeile; 11:00 nur die Stunde (billig).
        List<PricePointDto> punkte = new ArrayList<>(viertelstunden(T0, 20, 20, 20, 20));
        punkte.add(stunde(T0, 300));
        punkte.add(stunde(t(60), 20));
        preise(punkte);
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "lt", 10, T0, t(120)))
                .containsExactly(new Window(t(0), t(120)));
        // Gegenrichtung: "teurer als 10" findet die verdeckte teure Stundenzeile nicht.
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "gt", 10, T0, t(120))).isEmpty();
    }

    @Test
    void derBezugspreisLaeuftUeberDieSlotEconomicsDerAnlage() {
        // Dynamischer Tarif mit 18 ct Aufschlag: 5 ct Spot kostet 23 ct, 1 ct Spot kostet 19 ct.
        SlotEconomics dynamisch = new SlotEconomics(new SiteEconomics("eigenverbrauch", false, "dynamisch", 18.0,
                null, null, null, null, null, 0.92, 4.0, null), EegRates.defaults(), Map.of());
        when(diagnostics.economicsFor(SITE, T0, t(30))).thenReturn(dynamisch);
        preise(viertelstunden(T0, 50, 10));
        assertThat(source.windows(SITE, "market.import_price_ct_kwh", "lt", 20, T0, t(30)))
                .containsExactly(new Window(t(15), t(30)));
        // Derselbe Schwellwert auf den nackten Spot gälte in beiden Slots - der Bezugspreis ist nicht der Spot.
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "lt", 20, T0, t(30)))
                .containsExactly(new Window(t(0), t(30)));
    }

    @Test
    void ohneBezugspreisRegelOhnePreiseOderOhneAnlageGibtEsKeinFenster() {
        preise(viertelstunden(T0, 10, 10));
        when(diagnostics.economicsFor(any(), any(), any())).thenReturn(null);
        assertThat(source.windows(SITE, "market.import_price_ct_kwh", "lt", 100, T0, t(30))).isEmpty();

        preise(List.of());
        assertThat(source.windows(SITE, "market.spot_ct_kwh", "lt", 100, T0, t(30))).isEmpty();

        UUID fremd = UUID.randomUUID();
        assertThat(source.windows(fremd, "market.spot_ct_kwh", "lt", 100, T0, t(30))).isEmpty();
        verify(prices, never()).findForZone(eq(null), any(), any(), anyInt());
    }
}
