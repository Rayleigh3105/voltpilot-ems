package com.voltpilot.api.preis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.entities.LeadDeviceService.FuehrendeBox;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.repo.UpdateStatusRepository;
import com.voltpilot.api.web.dto.PricePointDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Die EINE Wahrheit der Preis-Zuleitung ({@code docs/contracts/v2/
 * mqtt-price-current.md}): gesperrt für den erklärten Festtarif (die AUSSAGE
 * des Kunden, nicht der Bewertungs-Rückfall), Fähigkeit der Box (führende
 * Box, keine Edge Light), und der Slot, der „jetzt" enthält - Viertelstunde
 * schlägt Stunde, der Preis ist der nackte Börsenpreis in ct/kWh.
 */
class PreisZuleitungTest {

    private static final UUID SITE = UUID.randomUUID();
    private static final UUID BOX = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-14T11:07:00Z");

    private LeadDeviceService leadDevices;
    private UpdateStatusRepository updateStatus;
    private PriceRepository prices;
    private PreisZuleitung dienst;

    @BeforeEach
    void setUp() {
        leadDevices = mock(LeadDeviceService.class);
        updateStatus = mock(UpdateStatusRepository.class);
        prices = mock(PriceRepository.class);
        dienst = new PreisZuleitung(leadDevices, updateStatus, prices);
    }

    private void boxDa(String boxArt) {
        when(leadDevices.fuehrendeBox(SITE)).thenReturn(new FuehrendeBox(BOX, null));
        when(updateStatus.boxArt(BOX)).thenReturn(boxArt);
    }

    @Test
    void dynamischerTarifMitDockerBoxWirdGespeist() {
        boxDa("docker");
        PreisZuleitung.Stand stand = dienst.stand(SITE, "DE-LU", "dynamisch");
        assertThat(stand.aktiv()).isTrue();
        assertThat(stand.grund()).isNull();
        assertThat(stand.box()).isEqualTo(BOX);
    }

    /** Der erklärte Festtarif sperrt - auch mit Box: der Preis des Kunden folgt der Börse nicht. */
    @Test
    void festtarifBleibtGesperrt() {
        boxDa("docker");
        PreisZuleitung.Stand stand = dienst.stand(SITE, "DE-LU", "fest");
        assertThat(stand.aktiv()).isFalse();
        assertThat(stand.grund()).isEqualTo(PreisZuleitung.GRUND_KEIN_DYNAMISCHER_TARIF);
        assertThat(stand.box()).isNull();
    }

    /**
     * {@code ohne} (keine Tarif-Aussage) wird gespeist: genau diese Anlagen
     * bewertet die Erlösanzeige je Slot zum Börsenpreis - dieselbe
     * Tarifgrundlage, und die Bausteine sprechen ausdrücklich vom Börsenpreis.
     */
    @Test
    void ohneTarifAussageWirdGespeist() {
        boxDa("docker");
        assertThat(dienst.stand(SITE, "DE-LU", "ohne").aktiv()).isTrue();
        assertThat(dienst.stand(SITE, "DE-LU", null).aktiv()).isTrue();
    }

    @Test
    void ohneZoneOhneBoxUndEdgeLightBleibenGesperrt() {
        assertThat(dienst.stand(SITE, null, "dynamisch").grund())
                .isEqualTo(PreisZuleitung.GRUND_KEINE_ZONE);
        assertThat(dienst.stand(SITE, " ", "dynamisch").grund())
                .isEqualTo(PreisZuleitung.GRUND_KEINE_ZONE);

        when(leadDevices.fuehrendeBox(SITE)).thenReturn(new FuehrendeBox(null, null));
        assertThat(dienst.stand(SITE, "DE-LU", "dynamisch").grund())
                .isEqualTo(PreisZuleitung.GRUND_KEINE_BOX);

        boxDa("light");
        assertThat(dienst.stand(SITE, "DE-LU", "dynamisch").grund())
                .isEqualTo(PreisZuleitung.GRUND_EDGE_LIGHT);
    }

    /** Eine Box, die ihre Art nie gemeldet hat (null), ist keine belegte Edge Light. */
    @Test
    void unbekannteBoxArtSperrtNicht() {
        boxDa(null);
        assertThat(dienst.stand(SITE, "DE-LU", "dynamisch").aktiv()).isTrue();
    }

    private static PricePointDto punkt(Instant von, Duration dauer, double eurMwh) {
        return new PricePointDto(von, von.plus(dauer), BigDecimal.valueOf(eurMwh));
    }

    @Test
    void aktuellerSlotIstDerDenJetztEnthaeltUndNacktInCt() {
        Instant slot = Instant.parse("2026-11-14T11:00:00Z");
        when(prices.findForZone(eq("DE-LU"), any(), any(), anyInt())).thenReturn(List.of(
                punkt(slot.minus(Duration.ofMinutes(15)), Duration.ofMinutes(15), 100),
                punkt(slot, Duration.ofMinutes(15), -42),
                punkt(slot.plus(Duration.ofMinutes(15)), Duration.ofMinutes(15), 80)));
        PreisZuleitung.PricePoint p = dienst.aktuellerSlot("DE-LU", NOW);
        assertThat(p.slotStart()).isEqualTo(slot);
        assertThat(p.slotEnd()).isEqualTo(slot.plus(Duration.ofMinutes(15)));
        // Der NACKTE Börsenpreis (€/MWh / 10), negativ ist ein Preis.
        assertThat(p.priceCtKwh()).isEqualTo(-4.2);
    }

    @Test
    void viertelstundeSchlaegtStundeUndOhneDeckungGibtEsNichts() {
        Instant stunde = Instant.parse("2026-11-14T11:00:00Z");
        when(prices.findForZone(eq("DE-LU"), any(), any(), anyInt())).thenReturn(List.of(
                punkt(stunde, Duration.ofHours(1), 100),
                punkt(stunde, Duration.ofMinutes(15), 50)));
        assertThat(dienst.aktuellerSlot("DE-LU", NOW).priceCtKwh()).isEqualTo(5.0);

        // „jetzt" nach dem Ende aller Slots: null, nie der letzte alte Preis.
        when(prices.findForZone(eq("DE-LU"), any(), any(), anyInt())).thenReturn(List.of(
                punkt(stunde.minus(Duration.ofHours(2)), Duration.ofMinutes(15), 50)));
        assertThat(dienst.aktuellerSlot("DE-LU", NOW)).isNull();
    }
}
