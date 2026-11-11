package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.ocpp.OcppRepository;
import com.voltpilot.api.verbraucher.SteuerartProjektion;
import com.voltpilot.api.verbraucher.Steuerart;
import com.voltpilot.api.verbraucher.VerbraucherService;
import com.voltpilot.api.web.dto.OcppDto;
import com.voltpilot.api.web.dto.VerbraucherDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der {@code ladepunkt}-Leser rein (Konzept „Ein Ort fürs Laden" Scheibe 4, §4/§9, E6 = A) - keine
 * Datenbank: {@link OcppRepository} und {@link VerbraucherService} sind Mocks, der Test prüft nur die
 * Abbildung Feld→Lesung und UNBEKANNT IST KEINE NULL (§6.1 Nr. 4).
 */
class LadepunktWerteLeserTest {

    private static final UUID ANLAGE = UUID.randomUUID();
    private static final Instant JETZT = Instant.parse("2026-07-15T18:00:00Z"); // 20:00 Europe/Berlin (Sommerzeit, unzweideutig)

    private final OcppRepository ocpp = mock(OcppRepository.class);
    private final VerbraucherService verbraucher = mock(VerbraucherService.class);
    private final LadepunktWerteLeser leser = new LadepunktWerteLeser(ocpp, verbraucher);
    private final WerteKatalog katalog = new WerteKatalog();

    private static OcppDto.Station station(String chargePointId, Instant lastSeen, OcppDto.ConnectorState... connectors) {
        return new OcppDto.Station(UUID.randomUUID(), chargePointId, true, null, null, lastSeen, null,
                null, null, null, null, null, null, null, null, null, null, null, null, null,
                List.of(connectors), List.of());
    }

    private static OcppDto.ConnectorState connector(String status) {
        return new OcppDto.ConnectorState(1, status, null, null, null, null, null, null);
    }

    private static VerbraucherDto.Eintrag eintragMitZiel(String chargePointId, String bisHHMM) {
        Steuerart.Fenster zielFenster = bisHHMM == null ? null : new Steuerart.Fenster(null, null, bisHHMM);
        Steuerart steuerart = new Steuerart("eigene_regel", "policy", null, null, null, null, null,
                bisHHMM == null ? null : SteuerartProjektion.ZIEL_BIS_UHRZEIT, zielFenster,
                java.math.BigDecimal.TEN, null, null);
        return new VerbraucherDto.Eintrag(UUID.randomUUID(), "Carport", "ev-charger", "Ladepunkt", true,
                chargePointId, steuerart, 0, null, true, null);
    }

    private void gibVerbraucher(VerbraucherDto.Eintrag... eintraege) {
        when(verbraucher.forSite(ANLAGE)).thenReturn(new VerbraucherDto(List.of(eintraege), null, List.of()));
    }

    // --- Bezug und leere Anlage ----------------------------------------------------------------

    @Test
    void unbekanntOhneLadepunkt() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of());
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.auto_angesteckt"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.bekannt()).isFalse();
    }

    @Test
    void unbekanntOhneAnlagenBezug() {
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.auto_angesteckt"),
                WerteLeser.Bezug.komponente(UUID.randomUUID(), "power_kw"), JETZT);
        assertThat(l.bekannt()).isFalse();
    }

    // --- wallbox_meldet_sich_nicht -------------------------------------------------------------

    @Test
    void wallboxErreichbarMitFrischerMeldung() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT.minusSeconds(60))));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.wallbox_meldet_sich_nicht"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.bekannt()).isTrue();
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.ERREICHBAR);
    }

    @Test
    void wallboxNichtErreichbarOhneFrischeMeldungDesSchlechtesten() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(
                station("CP-1", JETZT.minusSeconds(60)),
                station("CP-2", JETZT.minus(java.time.Duration.ofDays(1)))));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.wallbox_meldet_sich_nicht"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.NICHT_ERREICHBAR);
    }

    @Test
    void wallboxUnbekanntOhneErsteMeldung() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", null)));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.wallbox_meldet_sich_nicht"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.bekannt()).isFalse();
    }

    // --- auto_angesteckt -------------------------------------------------------------------------

    @Test
    void autoAngestecktBeiPreparing() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT, connector("Preparing"))));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.auto_angesteckt"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.ANGESTECKT);
    }

    @Test
    void autoNichtAngestecktBeiAvailable() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT, connector("Available"))));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.auto_angesteckt"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.NICHT_ANGESTECKT);
    }

    // --- ladung_fertig ---------------------------------------------------------------------------

    @Test
    void ladungFertigBeiFinishingSchlaegtCharging() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(
                station("CP-1", JETZT, connector("Charging")),
                station("CP-2", JETZT, connector("Finishing"))));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.ladung_fertig"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.FERTIG);
    }

    @Test
    void ladungLaedtOhneFinishing() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT, connector("Charging"))));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.ladung_fertig"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.LAEDT);
    }

    // --- ziel_wird_knapp -------------------------------------------------------------------------

    @Test
    void zielKnappWennSteckerNichtLaedtUndFristNah() {
        // JETZT = 20:00 Berlin, Frist 21:30 Berlin - 1,5 h entfernt, innerhalb des Zwei-Stunden-Fensters.
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT, connector("Preparing"))));
        gibVerbraucher(eintragMitZiel("CP-1", "21:30"));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.ziel_wird_knapp"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.KNAPP);
    }

    @Test
    void zielReichtSolangeEsLaedt() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT, connector("Charging"))));
        gibVerbraucher(eintragMitZiel("CP-1", "21:30"));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.ziel_wird_knapp"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.REICHT);
    }

    @Test
    void zielReichtWennFristNochWeitWeg() {
        // Frist morgen früh 07:00 - weit außerhalb des Zwei-Stunden-Fensters.
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT, connector("Preparing"))));
        gibVerbraucher(eintragMitZiel("CP-1", "07:00"));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.ziel_wird_knapp"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.zustandswort()).isEqualTo(LadepunktWerteLeser.REICHT);
    }

    @Test
    void zielUnbekanntOhneLadezielUndOhneAngestecktesAuto() {
        when(ocpp.stations(ANLAGE)).thenReturn(List.of(station("CP-1", JETZT, connector("Available"))));
        gibVerbraucher(eintragMitZiel("CP-1", null));
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("ladepunkt.ziel_wird_knapp"), WerteLeser.Bezug.anlage(ANLAGE), JETZT);
        assertThat(l.bekannt()).isFalse();
    }
}
