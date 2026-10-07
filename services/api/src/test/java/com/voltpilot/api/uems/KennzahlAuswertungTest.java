package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die reine {@link KennzahlAuswertung} (Konzept Auswerten a1 §6.4, §10.8): welcher Monat das Urteil trägt, welcher Wert
 * der jüngste ist, wann es ein „Vergleich ab …“ gibt und wie der Stand des Energieziels mitkommt. Die Zahlen selbst
 * rechnen der Vergleich und die Operation {@code roh}; hier geht es um Auswahl und Ordnung - ohne Datenbank.
 */
class KennzahlAuswertungTest {

    private static final YearMonth MAERZ_2029 = YearMonth.of(2029, 3);

    @Test
    void derLetzteAbgeschlosseneMonatIstDerVormonat() {
        assertThat(KennzahlAuswertung.letzterMonat(LocalDate.of(2029, 4, 30))).isEqualTo(MAERZ_2029);
        assertThat(KennzahlAuswertung.letzterMonat(LocalDate.of(2029, 1, 1))).isEqualTo(YearMonth.of(2028, 12));
    }

    @Test
    void urteilUndAbweichungenKommenAusDemVergleichDesMonats() {
        Map<String, KennzahlDto.Wert> werte = new HashMap<>();
        werte.put("2029-03", wert("2029-03", "0.29"));
        werte.put("2029-02", wert("2029-02", "0.288"));
        BezugsbasisVergleichDto.Vergleich v = vergleich(
                monat("2029-02", "-0.4", "im_rahmen", null, "Februar 2029: …"),
                monat("2029-03", "2.2", "schlechter", null, "März 2029: … 2,2 % mehr …"));

        KennzahlDto.Auswertung a = KennzahlAuswertung.auswertung(MAERZ_2029, werte, v, LocalDate.of(2026, 11, 1), null);

        assertThat(a.monat()).isEqualTo("2029-03");
        assertThat(a.wert().periode()).isEqualTo("2029-03");
        assertThat(a.wert().wert()).isEqualTo("0.29");
        assertThat(a.vergleich().bezugsbasis()).isEqualTo("BB-0001");
        assertThat(a.vergleich().urteil()).isEqualTo("schlechter");
        assertThat(a.vergleich().deltaProzent()).isEqualTo("2.2");
        assertThat(a.vergleich().satz()).isEqualTo("März 2029: … 2,2 % mehr …");
        assertThat(a.vergleich().ersterMonat()).isNull();
        assertThat(a.monate()).hasSize(12);
        assertThat(a.monate().get(0).periode()).isEqualTo("2028-04");
        assertThat(a.monate().get(10)).isEqualTo(new KennzahlDto.AuswertungMonat("2029-02", "0.288", "-0.4", "im_rahmen", null));
        // Ein Monat ohne Wert und ohne Zeile bleibt leer - nie 0.
        assertThat(a.monate().get(0)).isEqualTo(new KennzahlDto.AuswertungMonat("2028-04", null, null, null, null));
        assertThat(a.energieziel()).isNull();
    }

    @Test
    void ohneWertImMonatBleibtDerJuengsteWertUndDasUrteilSagtWarum() {
        Map<String, KennzahlDto.Wert> werte = Map.of("2029-01", wert("2029-01", "0.30"));
        BezugsbasisVergleichDto.Vergleich v = vergleich(monat("2029-03", null, "nicht_anwendbar", "keine_werte",
                "März 2029: nicht bewertbar — kein gemessener Wert."));

        KennzahlDto.Auswertung a = KennzahlAuswertung.auswertung(MAERZ_2029, werte, v, LocalDate.of(2026, 11, 1), null);

        assertThat(a.wert().periode()).isEqualTo("2029-01");
        assertThat(a.vergleich().urteil()).isEqualTo("nicht_anwendbar");
        assertThat(a.vergleich().grund()).isEqualTo("keine_werte");
    }

    @Test
    void solangeNochKeineFassungGiltNenntDerVergleichDenErstenMonat() {
        BezugsbasisVergleichDto.Vergleich v = vergleich(monat("2026-09", null, "nicht_anwendbar", "basis_fehlt", "…"));

        // Gilt die Fassung ab dem 01.11.2026, ist der November der erste Monat, dessen letzter Tag sie trägt (P4).
        KennzahlDto.Auswertung a = KennzahlAuswertung.auswertung(YearMonth.of(2026, 9), Map.of(), v,
                LocalDate.of(2026, 11, 1), null);
        assertThat(a.vergleich().ersterMonat()).isEqualTo("2026-11");
        assertThat(a.wert()).isNull();
        assertThat(a.vorjahr()).isNull();

        // Mitten im Monat: auch dann trägt der letzte Tag dieses Monats die Fassung.
        assertThat(KennzahlAuswertung.auswertung(YearMonth.of(2026, 9), Map.of(), v, LocalDate.of(2026, 11, 15), null)
                .vergleich().ersterMonat()).isEqualTo("2026-11");
        // Ein beendeter Vergleich ist kein „ab …“.
        BezugsbasisVergleichDto.Vergleich beendet = vergleich(monat("2026-09", null, "nicht_anwendbar", "basis_beendet", "…"));
        assertThat(KennzahlAuswertung.auswertung(YearMonth.of(2026, 9), Map.of(), beendet, LocalDate.of(2025, 1, 1), null)
                .vergleich().ersterMonat()).isNull();
    }

    @Test
    void ohneVergleichKeinUrteil() {
        KennzahlDto.Auswertung a = KennzahlAuswertung.auswertung(MAERZ_2029, Map.of("2029-03", wert("2029-03", "20.64")),
                null, null, null);
        assertThat(a.vergleich()).isNull();
        assertThat(a.monate()).allMatch(m -> m.deltaProzent() == null && m.urteil() == null);
    }

    @Test
    void dieVeraenderungZumVorjahrIstRohOhneUrteil() {
        Map<String, KennzahlDto.Wert> werte = Map.of("2029-03", wert("2029-03", "20.64"), "2028-03",
                wert("2028-03", "20.64"));
        KennzahlDto.Auswertung a = KennzahlAuswertung.auswertung(MAERZ_2029, werte, null, null, null);
        assertThat(a.vorjahr()).isEqualTo(new KennzahlDto.AuswertungVorjahr("2028-03", "20.64", "0.0", "gleich"));

        // Ohne Vorjahreswert (oder mit 0 davor) keine Veränderung - kein irreführender Pfeil.
        assertThat(KennzahlAuswertung.auswertung(MAERZ_2029, Map.of("2029-03", wert("2029-03", "20.64")), null, null, null)
                .vorjahr()).isNull();
        assertThat(KennzahlAuswertung.auswertung(MAERZ_2029, Map.of("2029-03", wert("2029-03", "1"), "2028-03",
                wert("2028-03", "0")), null, null, null).vorjahr()).isNull();
    }

    @Test
    void derStandDesEnergiezielsKommtMitDerSummeDerBewertbarenMonate() {
        UUID id = UUID.randomUUID();
        EnergiezielDto.Stand stand = stand(id, 1, 10, new EnergiezielDto.Summe("88740", "86812", "2.2", "2.0", "mehr",
                "schlechter", List.of()));

        KennzahlDto.Auswertung a = KennzahlAuswertung.auswertung(MAERZ_2029, Map.of(), null, null, stand);

        assertThat(a.energieziel()).isEqualTo(new KennzahlDto.AuswertungZiel(id, "EZ-2029-0001", "-4.0",
                "2029-03/2029-12", "2.2", "mehr", "schlechter", 1, 10));

        // Ohne bewertbaren Monat steht kein Prozent - nur „0 von 10“.
        KennzahlDto.AuswertungZiel leer = KennzahlAuswertung.auswertung(MAERZ_2029, Map.of(), null, null,
                stand(id, 0, 10, new EnergiezielDto.Summe(null, null, null, null, null, "ohne_urteil", List.of())))
                .energieziel();
        assertThat(leer.deltaProzent()).isNull();
        assertThat(leer.urteil()).isNull();
        assertThat(leer.monateBewertbar()).isZero();
        assertThat(leer.monateSoll()).isEqualTo(10);
    }

    /**
     * Review r3: welches offene Energieziel an der Kennzahl steht, hängt am Monat des Urteils. Ein abgelaufenes Ziel
     * bleibt „offen“, bis eine Person es bewertet - es darf das laufende nicht verdrängen.
     */
    @Test
    void dasLaufendeZielStehtVorDemFaelligenUndDemNaechsten() {
        EnergiezielDto.Energieziel ez2028 = ziel(UUID.randomUUID(), "EZ-2028-0001", "2028-01/2028-12");
        EnergiezielDto.Energieziel ez2029 = ziel(UUID.randomUUID(), "EZ-2029-0001", "2029-03/2029-12");
        EnergiezielDto.Energieziel ez2030 = ziel(UUID.randomUUID(), "EZ-2030-0001", "2030-01/2030-12");
        List<EnergiezielDto.Energieziel> alle = List.of(ez2030, ez2028, ez2029);

        // März 2029 liegt in der Zielperiode 2029 - das fällige 2028 (frühere Zielperiode) verdrängt es nicht.
        assertThat(KennzahlAuswertungService.zielFuer(alle, MAERZ_2029)).isSameAs(ez2029);
        assertThat(KennzahlAuswertungService.zielFuer(alle, YearMonth.of(2029, 12))).isSameAs(ez2029);
        // Zwischen zwei Zielperioden: das zuletzt abgelaufene, es wartet auf seine Bewertung.
        assertThat(KennzahlAuswertungService.zielFuer(alle, YearMonth.of(2029, 2))).isSameAs(ez2028);
        // Vor jeder Zielperiode: das nächste.
        assertThat(KennzahlAuswertungService.zielFuer(alle, YearMonth.of(2027, 6))).isSameAs(ez2028);
        assertThat(KennzahlAuswertungService.zielFuer(List.of(ez2030, ez2029), YearMonth.of(2028, 6))).isSameAs(ez2029);
        // Nach allen: das zuletzt abgelaufene.
        assertThat(KennzahlAuswertungService.zielFuer(alle, YearMonth.of(2031, 1))).isSameAs(ez2030);
        assertThat(KennzahlAuswertungService.zielFuer(List.of(), MAERZ_2029)).isNull();
    }

    @Test
    void zweiLaufendeZieleWaehltDieFruehereZielperiode() {
        EnergiezielDto.Energieziel lang = ziel(UUID.randomUUID(), "EZ-2029-0002", "2029-01/2030-12");
        EnergiezielDto.Energieziel kurz = ziel(UUID.randomUUID(), "EZ-2029-0001", "2029-03/2029-12");
        assertThat(KennzahlAuswertungService.zielFuer(List.of(kurz, lang), MAERZ_2029)).isSameAs(lang);
    }

    // ------------------------------------------------------------------ Fakes (nur was die Ableitung liest)

    private static KennzahlDto.Wert wert(String periode, String wert) {
        LocalDate von = YearMonth.parse(periode).atDay(1);
        return new KennzahlDto.Wert(von, YearMonth.parse(periode).atEndOfMonth(), periode, null, wert, null, null,
                "kWh/kg", "vollständig", null, List.of(), "100", "endgueltig", null, 1, 1, null, null, Map.of(), 1);
    }

    private static BezugsbasisVergleichDto.Monat monat(String periode, String delta, String urteil, String grund,
            String satz) {
        return new BezugsbasisVergleichDto.Monat(periode, null, null, new BezugsbasisVergleichDto.Bereinigt(null, null,
                List.of(), null, delta, delta == null ? null : "2.0", delta == null ? null : "mehr", urteil, grund,
                List.of()), satz);
    }

    private static BezugsbasisVergleichDto.Vergleich vergleich(BezugsbasisVergleichDto.Monat... monate) {
        return new BezugsbasisVergleichDto.Vergleich(null, new BezugsbasisVergleichDto.Basis(UUID.randomUUID(), "BB-0001",
                null, null), null, null, "Europe/Berlin", List.of(monate), null, List.of(), null, null);
    }

    /**
     * Der Stand eines Energieziels mit nur dem, was die Ableitung liest - als Attrappe statt über den Konstruktor, damit
     * ein neues Feld am Stand (z. B. {@code kurs} aus Verbessern PR1) diesen Test nicht bricht.
     */
    private static EnergiezielDto.Stand stand(UUID id, int bewertbar, int soll, EnergiezielDto.Summe summe) {
        EnergiezielDto.Stand stand = mock(EnergiezielDto.Stand.class);
        when(stand.energieziel()).thenReturn(ziel(id, "EZ-2029-0001", "2029-03/2029-12"));
        when(stand.zielperiode()).thenReturn("2029-03/2029-12");
        when(stand.zielwertProzent()).thenReturn("-4.0");
        when(stand.monateBewertbar()).thenReturn(bewertbar);
        when(stand.monateSoll()).thenReturn(soll);
        when(stand.summe()).thenReturn(summe);
        return stand;
    }

    private static EnergiezielDto.Energieziel ziel(UUID id, String kennzeichen, String zielperiode) {
        return new EnergiezielDto.Energieziel(id, kennzeichen,
                new EnergiezielDto.Kennzahl(UUID.randomUUID(), "KZ-0004", "Stromeinsatz Spritzguss je kg"), null, "-4.0",
                zielperiode, null, null, null, null, "offen", null, null, null, null, null, null, List.of(), List.of());
    }
}
