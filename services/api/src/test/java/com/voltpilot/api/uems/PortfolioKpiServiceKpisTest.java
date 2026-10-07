package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
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
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * Die ORCHESTRIERUNG der Portfolio-Kennzahlen mit Fakes (Review R2): die Fensterwahl der
 * Lastspitze in {@link PortfolioKpiService#kpis} (welches Abrechnungsfenster je Anlage gelesen
 * wird) und die {@link PortfolioKpiService#leitkennzahl} (Wert, Monat, Trend und Urteil aus der
 * Auswertung der führenden Kennzahl, ehrliche Leerfälle; welche Kennzahl führt, prüfen
 * {@code KennzahlAuswertungTest} und {@code BezugsbasisVergleichApiTest}). Die reine Fenster-/Trend-Mathematik und die Aggregation prüft
 * {@link PortfolioKpiServiceTest} ohne Mocks; hier geht es um die Verdrahtung der DB-Lesungen.
 */
@ExtendWith(MockitoExtension.class)
class PortfolioKpiServiceKpisTest {

    @Mock private SiteRepository sites;
    @Mock private BilanzService bilanz;
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
        when(auswertung.leit()).thenReturn(Optional.empty());
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
    void leitkachelIstDieAuswertungDerFuehrendenKennzahl() {
        UUID kz4 = UUID.randomUUID();
        UUID zielId4 = UUID.randomUUID();
        // §10.8 (Konzept Auswerten a1): Wert, Monat und Urteil der Kachel sind die der Karte - der jüngste Wert der zwölf
        // Monate (März 2029 auf der Uhr der Kennzahlen) und das Urteil des Monats; der Stand des Ziels steht daneben.
        KennzahlDto.AuswertungZiel zielStand = new KennzahlDto.AuswertungZiel(zielId4, "EZ-2029-0001", "-4.0",
                "2029-03/2029-12", "2.2", "mehr", "schlechter", 1, 10);
        KennzahlDto.Auswertung a = new KennzahlDto.Auswertung("2029-03",
                new KennzahlDto.AuswertungWert("2029-03", "0.2837", "kWh/kg", "vollständig", null), null,
                List.of(monat("2029-01", "0.31"), monat("2029-02", "0.30"), monat("2029-03", "0.2837")),
                new KennzahlDto.AuswertungVergleich("BB-0001", "schlechter", "2.2", "2.0", "mehr", null, null, null),
                zielStand);
        when(auswertung.leit()).thenReturn(Optional.of(new KennzahlAuswertungService.Leit(
                kennzahl(kz4, "KZ-0004", "Stromeinsatz Spritzguss je kg", a),
                ziel(zielId4, "KZ-0004", kz4, "Stromeinsatz Spritzguss je kg", "-4.0", "2029-03/2029-12",
                        "4 % weniger Strom, als die Bezugsbasis erwarten lässt"))));

        PortfolioKpiDto.Leitkennzahl leit = service.leitkennzahl();

        assertThat(leit).isNotNull();
        assertThat(leit.kennzeichen()).isEqualTo("KZ-0004");
        assertThat(leit.name()).isEqualTo("Stromeinsatz Spritzguss je kg");
        assertThat(leit.wert()).isEqualByComparingTo("0.2837");
        assertThat(leit.einheit()).isEqualTo("kWh/kg");
        assertThat(leit.jahr()).isEqualTo(2029);
        assertThat(leit.monat()).isEqualTo(3);
        assertThat(leit.zustand()).isEqualTo("vollständig");
        assertThat(leit.zielProzent()).isEqualByComparingTo("-4.0");
        assertThat(leit.zielperiode()).isEqualTo("2029-03/2029-12");
        assertThat(leit.zielWortlaut()).isEqualTo("4 % weniger Strom, als die Bezugsbasis erwarten lässt");
        // Trend des jüngsten Monats (0,2837) gegen den Monat davor (0,30): −5,4 %.
        assertThat(leit.trendProzent()).isEqualByComparingTo("-5.4");
        assertThat(leit.urteil()).isEqualTo("schlechter");
        assertThat(leit.zielStand()).isEqualTo(zielStand);
    }

    @Test
    void leitkachelOhneFreigegebeneBezugsbasisHatKeinUrteilUndOhneVormonatKeinenTrend() {
        UUID kz = UUID.randomUUID();
        KennzahlDto.Auswertung a = new KennzahlDto.Auswertung("2029-03",
                new KennzahlDto.AuswertungWert("2029-01", "0.29", null, "vollständig", null), null,
                List.of(monat("2029-01", "0.29"), monat("2029-02", null), monat("2029-03", null)), null, null);
        when(auswertung.leit()).thenReturn(Optional.of(new KennzahlAuswertungService.Leit(
                kennzahl(kz, "KZ-0004", "Stromeinsatz je kg", a),
                ziel(UUID.randomUUID(), "KZ-0004", kz, "Stromeinsatz je kg", "-5.0", "2029-01/2029-12", "5 % weniger"))));

        PortfolioKpiDto.Leitkennzahl leit = service.leitkennzahl();

        // Der jüngste Wert ist der Januar - die Kachel nennt seinen Monat, wie die Karte.
        assertThat(leit.monat()).isEqualTo(1);
        // Ohne Wert der Fassung die Einheit der Kennzahl.
        assertThat(leit.einheit()).isEqualTo("kWh/kg");
        assertThat(leit.trendProzent()).isNull();
        assertThat(leit.urteil()).isNull();
        assertThat(leit.zielStand()).isNull();
    }

    @Test
    void ohneFuehrendeKennzahlKeineLeitkachel() {
        when(auswertung.leit()).thenReturn(Optional.empty());
        assertThat(service.leitkennzahl()).isNull();
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

    private static KennzahlDto.AuswertungMonat monat(String periode, String wert) {
        return new KennzahlDto.AuswertungMonat(periode, wert, null, null, null);
    }

    private static KennzahlDto.Kennzahl kennzahl(UUID id, String kennzeichen, String name, KennzahlDto.Auswertung a) {
        return new KennzahlDto.Kennzahl(id, kennzeichen, name, "quotient", "unternehmen", null, null, null, null, null,
                null, null, 1, "kWh/kg", "kWh je kg", "monat", List.of("monat"), true, null, null, null, a);
    }
}
