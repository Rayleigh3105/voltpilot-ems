package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

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

    private static EnergiezielDto.Stand stand(UUID id, int bewertbar, int soll, EnergiezielDto.Summe summe) {
        EnergiezielDto.Energieziel z = new EnergiezielDto.Energieziel(id, "EZ-2029-0001",
                new EnergiezielDto.Kennzahl(UUID.randomUUID(), "KZ-0004", "Stromeinsatz Spritzguss je kg"), null, "-4.0",
                "2029-03/2029-12", null, null, null, null, "offen", null, null, null, null, null, null, List.of(), List.of());
        return new EnergiezielDto.Stand(z, null, "2029-03/2029-12", "-4.0", List.of(), bewertbar, bewertbar, soll,
                bewertbar + " von " + soll, false, List.of(), summe, null, null, null);
    }
}
