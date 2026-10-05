package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.PortfolioKpiService.AnlageKpiRoh;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.PortfolioKpiDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die REINE Aggregation der Portfolio-Kennzahlen ({@link PortfolioKpiService#aggregiere}
 * und {@link PortfolioKpiService#netzbezugAus}) - ohne Datenbank. Prüft die Summen,
 * die Kosten (Menge × Arbeitspreis), die Lastspitzen-Auswahl und vor allem die
 * Ehrlichkeit „Fehlend ist keine Null" (fehlende Quelle → null, nie 0). Die echten
 * DB-Lesungen deckt die E2E-Abnahme gegen die Demo ab.
 */
class PortfolioKpiServiceTest {

    private static final PortfolioKpiDto.Periode SEPTEMBER = new PortfolioKpiDto.Periode(
            LocalDate.parse("2026-09-01"), LocalDate.parse("2026-09-30"), 2026, 9);

    @Test
    void aggregiertVerbrauchKostenUndLastspitzeUeberAnlagen() {
        AnlageKpiRoh halle1 = new AnlageKpiRoh("Werk Ahrenberg – Halle 1",
                bd(199_500), true, bd(207_000), bd("22.4"), bd(412), bd(550));
        AnlageKpiRoh halle2 = new AnlageKpiRoh("Werk Ahrenberg – Halle 2",
                bd(36_900), true, bd(35_000), bd("23.1"), bd(120), bd(200));

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(halle1, halle2), null);

        // Verbrauch = Σ Netzbezug (dieser Monat / Vorjahr)
        assertThat(dto.verbrauch().kwh()).isEqualByComparingTo("236400");
        assertThat(dto.verbrauch().kwhVorjahr()).isEqualByComparingTo("242000");
        assertThat(dto.verbrauch().vollstaendig()).isTrue();

        // Kosten = Σ(Netzbezug × Arbeitspreis): 199500·0,224 + 36900·0,231 = 53211,9 → 53212 €
        assertThat(dto.kosten().eur()).isEqualByComparingTo("53212");
        assertThat(dto.kosten().eurVorjahr()).isEqualByComparingTo("54453"); // 207000·0,224 + 35000·0,231
        assertThat(dto.kosten().tarifHinterlegt()).isTrue();

        // Lastspitze = die höchste gemessene Spitze samt vereinbarter Leistung IHRER Anlage
        assertThat(dto.lastspitze().kw()).isEqualByComparingTo("412.0");
        assertThat(dto.lastspitze().vereinbartKw()).isEqualByComparingTo("550");
        assertThat(dto.lastspitze().anteilProzent()).isEqualTo(75); // 412/550 = 74,9 → 75
        assertThat(dto.lastspitze().anlage()).isEqualTo("Werk Ahrenberg – Halle 1");

        assertThat(dto.periode().jahr()).isEqualTo(2026);
        assertThat(dto.periode().monat()).isEqualTo(9);
    }

    @Test
    void fehlendIstKeineNull() {
        AnlageKpiRoh leer = new AnlageKpiRoh("Werk Lindach", null, true, null, null, null, null);

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(leer), null);

        assertThat(dto.verbrauch().kwh()).isNull();
        assertThat(dto.verbrauch().kwhVorjahr()).isNull();
        assertThat(dto.kosten().eur()).isNull();
        assertThat(dto.kosten().eurVorjahr()).isNull();
        assertThat(dto.kosten().tarifHinterlegt()).isFalse();
        assertThat(dto.lastspitze().kw()).isNull();
        assertThat(dto.lastspitze().vereinbartKw()).isNull();
        assertThat(dto.lastspitze().anteilProzent()).isNull();
        assertThat(dto.lastspitze().anlage()).isNull();
        assertThat(dto.leit()).isNull();
    }

    @Test
    void verbrauchOhneTarifTraegtKeineKosten() {
        // Anlage mit Netzbezug, aber tarif_art='ohne' (kein Arbeitspreis): Verbrauch zählt, Kosten bleibt leer.
        AnlageKpiRoh ohneTarif = new AnlageKpiRoh("Werk Ahrenberg – Halle 1",
                bd(199_500), true, bd(207_000), null, null, null);

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(ohneTarif), null);

        assertThat(dto.verbrauch().kwh()).isEqualByComparingTo("199500");
        assertThat(dto.kosten().eur()).isNull();
        assertThat(dto.kosten().tarifHinterlegt()).isFalse();
    }

    @Test
    void lastspitzeNimmtDieHoechsteSpitzeUndDerenVereinbarung() {
        AnlageKpiRoh a = new AnlageKpiRoh("A", bd(100), true, null, null, bd(100), bd(500));
        AnlageKpiRoh b = new AnlageKpiRoh("B", bd(100), true, null, null, bd(300), bd(400)); // höhere Spitze

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(a, b), null);

        assertThat(dto.lastspitze().kw()).isEqualByComparingTo("300.0");
        assertThat(dto.lastspitze().vereinbartKw()).isEqualByComparingTo("400");
        assertThat(dto.lastspitze().anteilProzent()).isEqualTo(75); // 300/400
        assertThat(dto.lastspitze().anlage()).isEqualTo("B");
    }

    @Test
    void teilmonatMachtDenVerbrauchUnvollstaendig() {
        AnlageKpiRoh teil = new AnlageKpiRoh("A", bd(100), false, null, null, null, null);
        assertThat(PortfolioKpiService.aggregiere(SEPTEMBER, List.of(teil), null).verbrauch().vollstaendig())
                .isFalse();
    }

    @Test
    void reichtDieLeitkennzahlDurch() {
        PortfolioKpiDto.Leitkennzahl leit = new PortfolioKpiDto.Leitkennzahl("KZ-0004",
                "Stromeinsatz Spritzguss je kg", bd("0.2837"), "kWh/kg", 2026, 9, "vollständig",
                bd("5"), "2028-01/2028-12", "5 % unter Bezugsbasis", bd("-3.4"), "besser");

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(), leit);

        assertThat(dto.leit()).isEqualTo(leit);
    }

    @Test
    void netzbezugSummiertZuflussMengen() {
        BilanzDto.Bilanz b = bilanzMit(summe(bd(199_500), "vollständig", 100));
        PortfolioKpiService.Netzbezug nb = PortfolioKpiService.netzbezugAus(b);
        assertThat(nb.kwh()).isEqualByComparingTo("199500");
        assertThat(nb.vollstaendig()).isTrue();
    }

    @Test
    void netzbezugOhneGemesseneMengeIstNull() {
        BilanzDto.Bilanz b = bilanzMit(summe(null, "keine_werte", null));
        assertThat(PortfolioKpiService.netzbezugAus(b).kwh()).isNull();
    }

    @Test
    void netzbezugUnterAbdeckungIstUnvollstaendig() {
        BilanzDto.Bilanz b = bilanzMit(summe(bd(90_000), "unvollständig", 60));
        PortfolioKpiService.Netzbezug nb = PortfolioKpiService.netzbezugAus(b);
        assertThat(nb.kwh()).isEqualByComparingTo("90000");
        assertThat(nb.vollstaendig()).isFalse();
    }

    // ------------------------------------------------------------------ Helfer

    private static BigDecimal bd(Object o) {
        return new BigDecimal(o.toString());
    }

    private static BilanzDto.Summe summe(BigDecimal menge, String zustand, Integer abdeckung) {
        return new BilanzDto.Summe(menge, zustand, abdeckung, menge == null ? 0 : 1, 1, List.of(), List.of(), null);
    }

    private static BilanzDto.Bilanz bilanzMit(BilanzDto.Summe zufluss) {
        BilanzDto.Werte werte = new BilanzDto.Werte(LocalDate.parse("2026-09-01"), LocalDate.parse("2026-09-30"),
                zufluss, null, null, null, List.of());
        BilanzDto.Abschnitt abschnitt = new BilanzDto.Abschnitt(LocalDate.parse("2026-09-01"),
                LocalDate.parse("2026-09-30"), "monat", List.of(), List.of(), List.of(werte));
        BilanzDto.Hauptzaehler hz = new BilanzDto.Hauptzaehler(null, null, null, false, List.of(abschnitt), null);
        return new BilanzDto.Bilanz(null, "monat", LocalDate.parse("2026-09-15"),
                LocalDate.parse("2026-09-01"), LocalDate.parse("2026-09-30"), "Europe/Berlin", List.of(hz));
    }
}
