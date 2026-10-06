package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.PortfolioKpiRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.PortfolioKpiDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * Die ORCHESTRIERUNG der Portfolio-Kennzahlen mit Fakes (Review R2): die Fensterwahl der
 * Lastspitze in {@link PortfolioKpiService#kpis} (welches Abrechnungsfenster je Anlage gelesen
 * wird) und die {@link PortfolioKpiService#leitkennzahl} (kleinstes Kennzeichen, Trend, Urteil,
 * ehrliche Leerfälle). Die reine Fenster-/Trend-Mathematik und die Aggregation prüft
 * {@link PortfolioKpiServiceTest} ohne Mocks; hier geht es um die Verdrahtung der DB-Lesungen.
 */
@ExtendWith(MockitoExtension.class)
class PortfolioKpiServiceKpisTest {

    @Mock private SiteRepository sites;
    @Mock private BilanzService bilanz;
    @Mock private EnergiezielService energieziele;
    @Mock private KennzahlWerteService kennzahlWerte;
    @Mock private NetzanschlussRepository netzanschluss;
    @Mock private PortfolioKpiRepository spitzen;
    @Mock private MessstelleRegisterService messstellen;
    @Mock private KennzahlAuswertungService auswertung;

    @InjectMocks private PortfolioKpiService service;

    private static final Instant JETZT = Instant.parse("2026-10-05T12:00:00Z"); // Berlin 14:00, heute = 05.10.2026
    // Die von fenster() erwarteten Grenzen (vgl. PortfolioKpiServiceTest): 01.01. bzw. 01.10. 00:00 Berlin.
    private static final Instant JAHR_VON = Instant.parse("2025-12-31T23:00:00Z");
    private static final Instant MONAT_VON = Instant.parse("2026-09-30T22:00:00Z");

    @Test
    void kpisLiestDieLastspitzeJeAnlageAusIHREMAbrechnungsfenster() {
        UUID jahrId = UUID.randomUUID();
        UUID monatId = UUID.randomUUID();
        when(sites.findAll()).thenReturn(List.of(
                site(jahrId, "Werk Jahr", "jahr"),
                site(monatId, "Werk Monat", "monat")));
        when(bilanz.bilanz(any(), eq("monat"), any())).thenReturn(leereBilanz());
        when(netzanschluss.bindungenDerAnlage(any())).thenReturn(List.of());
        when(messstellen.liste(any(), any())).thenReturn(listeMitDatenlage(8, 10));
        when(energieziele.liste(any(), any(), any())).thenReturn(new EnergiezielDto.Liste(List.of()));
        // Die Spitze der Jahres-Anlage steht NUR im Jahresfenster, die der Monats-Anlage NUR im Monatsfenster.
        when(spitzen.importSpitzen(eq(JAHR_VON), eq(JETZT)))
                .thenReturn(Map.of(jahrId, new PortfolioKpiRepository.Spitze(new BigDecimal("500"), Instant.parse("2026-06-01T10:00:00Z"))));
        when(spitzen.importSpitzen(eq(MONAT_VON), eq(JETZT)))
                .thenReturn(Map.of(monatId, new PortfolioKpiRepository.Spitze(new BigDecimal("200"), Instant.parse("2026-10-03T19:00:00Z"))));

        PortfolioKpiDto dto = service.kpis(JETZT);

        // Fensterwahl verdrahtet: beide Fenster werden mit genau den Grenzen bis jetzt gelesen.
        verify(spitzen).importSpitzen(JAHR_VON, JETZT);
        verify(spitzen).importSpitzen(MONAT_VON, JETZT);
        // Die höchste Spitze (500, Jahres-Anlage) führt - ihr Zeitraum-Label ist das Jahr, nicht der Monat.
        // Das beweist, dass die Jahres-Anlage aus dem JAHRESfenster gelesen wurde (ihre id steht nur dort).
        assertThat(dto.lastspitze().kw()).isEqualByComparingTo("500.0");
        assertThat(dto.lastspitze().anlage()).isEqualTo("Werk Jahr");
        assertThat(dto.lastspitze().zeitraum()).isEqualTo("2026");
        assertThat(dto.lastspitze().zeitpunkt()).isEqualTo("2026-06-01T10:00:00Z");
        // Periode = letzter abgeschlossener Berliner Monat, Datenlage/Leitkennzahl durchgereicht.
        assertThat(dto.periode().jahr()).isEqualTo(2026);
        assertThat(dto.periode().monat()).isEqualTo(9);
        assertThat(dto.datenlage()).isEqualTo(new PortfolioKpiDto.Datenlage(8, 10));
        assertThat(dto.leit()).isNull();
    }

    @Test
    void leitkennzahlNimmtDasKleinsteKennzeichenUndRechnetTrendUndUrteil() {
        UUID kz7 = UUID.randomUUID();
        UUID kz4 = UUID.randomUUID();
        UUID zielId4 = UUID.randomUUID();
        // Reihenfolge absichtlich KZ-0007 zuerst - das kleinste Kennzeichen (KZ-0004) muss trotzdem gewinnen.
        when(energieziele.liste(any(), any(), any())).thenReturn(new EnergiezielDto.Liste(List.of(
                ziel(UUID.randomUUID(), "KZ-0007", kz7, "Wärme je kg", "3", "2028-01/2028-12", "3 % unter Basis"),
                ziel(zielId4, "KZ-0004", kz4, "Stromeinsatz Spritzguss je kg", "5", "2028-01/2028-12", "5 % unter Bezugsbasis"))));
        when(kennzahlWerte.werte(eq(kz4), any(), any(), any(), any(), any())).thenReturn(werte(kz4, "KZ-0004",
                "Stromeinsatz Spritzguss je kg", "kWh/kg", List.of(
                        wert(LocalDate.parse("2026-08-01"), "0.30", "kWh/kg", "vollständig"),
                        wert(LocalDate.parse("2026-09-01"), "0.2837", "kWh/kg", "vollständig"))));
        // §10.8 (Konzept Auswerten a1): das Urteil der Kachel ist das des Monats - dieselbe Ableitung wie die Karte der
        // Kennzahl -, nicht die Summe über die Zielperiode; der Stand des Ziels steht getrennt daneben.
        KennzahlDto.AuswertungZiel zielStand = new KennzahlDto.AuswertungZiel(zielId4, "EZ-2028-0001", "-5",
                "2028-01/2028-12", "-2.7", "weniger", "besser", 11, 12);
        when(auswertung.auswertung(eq(kz4), eq(YearMonth.of(2026, 9)), any())).thenReturn(new KennzahlDto.Auswertung(
                "2026-09", null, null, null, List.of(), new KennzahlDto.AuswertungVergleich("BB-0001", "schlechter", "2.2",
                        "2.0", "mehr", null, null, null), null, zielStand));

        PortfolioKpiDto.Leitkennzahl leit = service.leitkennzahl(YearMonth.of(2026, 9));

        assertThat(leit).isNotNull();
        assertThat(leit.kennzeichen()).isEqualTo("KZ-0004");
        assertThat(leit.name()).isEqualTo("Stromeinsatz Spritzguss je kg");
        assertThat(leit.wert()).isEqualByComparingTo("0.2837");
        assertThat(leit.einheit()).isEqualTo("kWh/kg");
        assertThat(leit.jahr()).isEqualTo(2026);
        assertThat(leit.monat()).isEqualTo(9);
        assertThat(leit.zustand()).isEqualTo("vollständig");
        assertThat(leit.zielProzent()).isEqualByComparingTo("5");
        assertThat(leit.zielperiode()).isEqualTo("2028-01/2028-12");
        assertThat(leit.zielWortlaut()).isEqualTo("5 % unter Bezugsbasis");
        // Trend des jüngsten Monats (0,2837) gegen den Vormonat (0,30): −5,4 %.
        assertThat(leit.trendProzent()).isEqualByComparingTo("-5.4");
        assertThat(leit.urteil()).isEqualTo("schlechter");
        assertThat(leit.zielStand()).isEqualTo(zielStand);
        verify(auswertung).auswertung(eq(kz4), eq(YearMonth.of(2026, 9)), argThat(z -> z.id().equals(zielId4)));
    }

    @Test
    void leitkennzahlOhneFreigegebeneBezugsbasisHatKeinUrteil() {
        UUID kz = UUID.randomUUID();
        when(energieziele.liste(any(), any(), any())).thenReturn(new EnergiezielDto.Liste(List.of(
                ziel(UUID.randomUUID(), "KZ-0004", kz, "Stromeinsatz je kg", "5", "2028-01/2028-12", "5 % unter Basis"))));
        when(kennzahlWerte.werte(eq(kz), any(), any(), any(), any(), any())).thenReturn(werte(kz, "KZ-0004",
                "Stromeinsatz je kg", "kWh/kg", List.of(wert(LocalDate.parse("2026-09-01"), "0.29", "kWh/kg", "vollständig"))));
        when(auswertung.auswertung(eq(kz), any(), any())).thenReturn(new KennzahlDto.Auswertung("2026-09", null, null,
                null, List.of(), null, null, null));

        PortfolioKpiDto.Leitkennzahl leit = service.leitkennzahl(YearMonth.of(2026, 9));

        assertThat(leit.urteil()).isNull();
        assertThat(leit.zielStand()).isNull();
    }

    @Test
    void leitkennzahlOhneOffenesZielIstNull() {
        when(energieziele.liste(any(), any(), any())).thenReturn(new EnergiezielDto.Liste(List.of()));
        assertThat(service.leitkennzahl(YearMonth.of(2026, 9))).isNull();
    }

    @Test
    void leitkennzahlOhneWerteIstNull() {
        UUID kz = UUID.randomUUID();
        when(energieziele.liste(any(), any(), any())).thenReturn(new EnergiezielDto.Liste(List.of(
                ziel(UUID.randomUUID(), "KZ-0004", kz, "Stromeinsatz je kg", "5", "2028-01/2028-12", "5 % unter Basis"))));
        when(kennzahlWerte.werte(eq(kz), any(), any(), any(), any(), any()))
                .thenReturn(werte(kz, "KZ-0004", "Stromeinsatz je kg", "kWh/kg", List.of()));
        assertThat(service.leitkennzahl(YearMonth.of(2026, 9))).isNull();
    }

    // ------------------------------------------------------------------ DTO-Fakes (minimal, nur was der Code liest)

    private static SiteDto site(UUID id, String name, String abrechnung) {
        return new SiteDto(id, name, null, null, null, null, null, null, "ohne", null,
                false, null, null, abrechnung, null, null, null);
    }

    private static BilanzDto.Bilanz leereBilanz() {
        return new BilanzDto.Bilanz(null, "monat", LocalDate.parse("2026-09-15"),
                LocalDate.parse("2026-09-01"), LocalDate.parse("2026-09-30"), "Europe/Berlin", List.of());
    }

    private static MessstelleDto.Liste listeMitDatenlage(int erfuellt, int gesamt) {
        return new MessstelleDto.Liste(List.of(), List.of(), null, null, false,
                new MessstelleDto.RegisterAggregat(
                        new MessstelleDto.RegisterAbdeckung(erfuellt, gesamt, erfuellt + "/" + gesamt), List.of()));
    }

    private static EnergiezielDto.Energieziel ziel(UUID zielId, String kennzeichen, UUID kennzahlId, String name,
            String zielProzent, String zielperiode, String wortlaut) {
        return new EnergiezielDto.Energieziel(zielId, kennzeichen,
                new EnergiezielDto.Kennzahl(kennzahlId, kennzeichen, name), null,
                zielProzent, zielperiode, wortlaut, null, null, null, "offen",
                null, null, null, null, null, null, List.of(), List.of());
    }

    private static KennzahlDto.Wert wert(LocalDate von, String wertStr, String einheit, String zustand) {
        return new KennzahlDto.Wert(von, von, null, null, wertStr, null, null, einheit, zustand,
                null, List.of(), null, null, null, null, null, null, null, Map.of(), null);
    }

    private static KennzahlDto.Werte werte(UUID kennzahlId, String kennzeichen, String name, String einheit,
            List<KennzahlDto.Wert> werte) {
        return new KennzahlDto.Werte(
                new KennzahlDto.WerteKennzahl(kennzahlId, kennzeichen, name, null, einheit, null),
                "monat", null, null, null, null, werte, List.of());
    }
}
