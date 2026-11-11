package com.voltpilot.api.optimizer;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.EinspeiseverguetungRepository.Grundlage;
import com.voltpilot.api.web.dto.EinspeiseverguetungDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Die Karte "Einspeisevergütung": der Zustand je Fall der GETEILTEN Vektoren
 * ({@code quelle} kommt dort aus dem SQL der Erlöse und wird hier eingesetzt,
 * wie das Repository es liefert) und die Zahlen, die die Karte daneben zeigt -
 * nie ein Satz, mit dem die Erlöse nicht rechnen.
 */
class EinspeiseverguetungStandTest {

    private static Grundlage grundlage(String plantKind, boolean netzladen, String angegeben,
            LocalDate inbetrieb, String kwp, String quelle) {
        return new Grundlage(plantKind, netzladen, angegeben == null ? null : new BigDecimal(angegeben),
                null, inbetrieb, kwp == null ? null : new BigDecimal(kwp), null, quelle);
    }

    @Test
    void derZustandFolgtDenGeteiltenVektorenUndDecktDasVokabularAb() {
        Set<String> gesehen = new LinkedHashSet<>();
        for (EinspeiseverguetungVektoren.Fall f : EinspeiseverguetungVektoren.faelle()) {
            Grundlage g = new Grundlage(f.veraeusserungsform(), f.netzladen(),
                    f.angegebenCtKwh() == null ? null : BigDecimal.valueOf(f.angegebenCtKwh()),
                    f.inbetriebnahmeAbSolarspitzengesetz(),
                    f.inbetriebnahme(),
                    f.leistungKwp() == null ? null : BigDecimal.valueOf(f.leistungKwp()),
                    f.anzulegenderWertCtKwh() == null ? null
                            : BigDecimal.valueOf(f.anzulegenderWertCtKwh()),
                    f.quelle());
            assertThat(EinspeiseverguetungStand.zustand(g)).as(f.fall()).isEqualTo(f.zustand());
            gesehen.add(f.zustand());
        }
        assertThat(gesehen).as("jeder Zustand des Vokabulars hat einen Fall")
                .containsExactlyInAnyOrderElementsOf(EinspeiseverguetungVektoren.zustaende());
    }

    @Test
    void hergeleitetZeigtDenSatzDesSatzplansMitEndeUndParagraph51a() {
        EinspeiseverguetungDto d = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, null, LocalDate.of(2025, 6, 1), "9.8", "eeg"),
                EegRates.defaults());
        assertThat(d.zustand()).isEqualTo("eeg");
        assertThat(d.wirksamCtKwh()).isEqualByComparingTo("7.94");
        assertThat(d.hergeleitetCtKwh()).isEqualByComparingTo("7.94");
        assertThat(d.angegebenCtKwh()).isNull();
        assertThat(d.hergeleitetGenaehert()).isFalse();
        assertThat(d.eegEndeAm()).isEqualTo(LocalDate.of(2045, 12, 31));
        assertThat(d.ohneVerguetungBeiNegativpreis()).isTrue();
        assertThat(d.inbetriebnahme()).isEqualTo(LocalDate.of(2025, 6, 1));
        assertThat(d.leistungKwp()).isEqualByComparingTo("9.8");
    }

    @Test
    void dieAngabeWirktUndDieHerleitungBleibtDanebenSichtbar() {
        // 25 kWp EEG-2023: der Satzplan mischt die Tranchen (10*8,2 + 15*7,1)/25.
        EinspeiseverguetungDto d = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, "12.500", LocalDate.of(2023, 6, 15), "25", "angegeben"),
                EegRates.defaults());
        assertThat(d.zustand()).isEqualTo("angegeben");
        assertThat(d.wirksamCtKwh()).isEqualByComparingTo("12.5");
        assertThat(d.hergeleitetCtKwh()).isEqualByComparingTo("7.540");
        assertThat(d.ohneVerguetungBeiNegativpreis()).isFalse();
    }

    @Test
    void altanlagenRechnenMitJahresstufenUndHeissenNaeherung() {
        EinspeiseverguetungDto alt = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, null, LocalDate.of(2010, 4, 1), "6", "eeg"),
                EegRates.defaults());
        // Vor dem ersten Band nimmt der Satzplan das erste Band (24,4 ct).
        assertThat(alt.hergeleitetCtKwh()).isEqualByComparingTo("24.4");
        assertThat(alt.hergeleitetGenaehert()).isTrue();
        assertThat(alt.eegEndeAm()).isEqualTo(LocalDate.of(2030, 12, 31));
        EinspeiseverguetungDto grenze = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, null, LocalDate.of(2022, 7, 30), "6", "eeg"),
                EegRates.defaults());
        assertThat(grenze.hergeleitetGenaehert()).as("ab dem EEG 2023 exakt").isFalse();
        assertThat(EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, null, LocalDate.of(2022, 7, 29), "6", "eeg"),
                EegRates.defaults()).hergeleitetGenaehert()).isTrue();
    }

    @Test
    void ohneGrundlageGibtEsKeineZahlNurDenGrund() {
        EinspeiseverguetungDto ohne = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, null, null, null, null), EegRates.defaults());
        assertThat(ohne.zustand()).isEqualTo("ohne_angabe");
        assertThat(ohne.wirksamCtKwh()).isNull();
        assertThat(ohne.hergeleitetCtKwh()).isNull();
        assertThat(ohne.eegEndeAm()).isNull();
        assertThat(ohne.ohneVerguetungBeiNegativpreis()).isFalse();
        assertThat(ohne.hergeleitetGenaehert()).isFalse();

        EinspeiseverguetungDto abgelaufen = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, null, LocalDate.of(2004, 5, 1), null, null),
                EegRates.defaults());
        assertThat(abgelaufen.zustand()).isEqualTo("eeg_abgelaufen");
        assertThat(abgelaufen.wirksamCtKwh()).isNull();
        assertThat(abgelaufen.eegEndeAm()).isEqualTo(LocalDate.of(2024, 12, 31));
    }

    @Test
    void ruhendeAngabeBleibtGespeichertWirktAberNicht() {
        EinspeiseverguetungDto netz = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", true, "12.5", LocalDate.of(2023, 6, 15), "8", null),
                EegRates.defaults());
        assertThat(netz.zustand()).isEqualTo("netzladen");
        assertThat(netz.wirksamCtKwh()).isNull();
        assertThat(netz.angegebenCtKwh()).isEqualByComparingTo("12.5");

        Grundlage dv = new Grundlage("direktvermarktung", true, new BigDecimal("12.5"), null,
                LocalDate.of(2023, 6, 15), new BigDecimal("8"), new BigDecimal("8.11"), null);
        EinspeiseverguetungDto d = EinspeiseverguetungStand.von(dv, EegRates.defaults());
        // Auch mit Netzladen bleibt die Veräußerungsform die erste Antwort.
        assertThat(d.zustand()).isEqualTo("direktvermarktung");
        assertThat(d.wirksamCtKwh()).isNull();
        assertThat(d.anzulegenderWertCtKwh()).isEqualByComparingTo("8.11");
    }

    @Test
    void derAnzulegendeWertReistNurBeiDirektvermarktungMit() {
        Grundlage ev = new Grundlage("eigenverbrauch", false, null, null, LocalDate.of(2023, 6, 15),
                null, new BigDecimal("8.11"), "eeg");
        assertThat(EinspeiseverguetungStand.von(ev, EegRates.defaults()).anzulegenderWertCtKwh())
                .isNull();
    }

    @Test
    void ohneDatumMachtDieAntwortParagraph51aSichtbar() {
        // Eigener Satz ohne Inbetriebnahmedatum: die Antwort „ab dem 25.02.2025"
        // macht die Nullstunden sichtbar, „davor" nimmt sie weg.
        Grundlage ab = new Grundlage("eigenverbrauch", false, new BigDecimal("6"), true, null, null,
                null, "angegeben");
        EinspeiseverguetungDto d = EinspeiseverguetungStand.von(ab, EegRates.defaults());
        assertThat(d.ohneVerguetungBeiNegativpreis()).isTrue();
        assertThat(d.inbetriebnahmeAbSolarspitzengesetz()).isTrue();
        Grundlage vor = new Grundlage("eigenverbrauch", false, new BigDecimal("6"), false, null, null,
                null, "angegeben");
        EinspeiseverguetungDto v = EinspeiseverguetungStand.von(vor, EegRates.defaults());
        assertThat(v.ohneVerguetungBeiNegativpreis()).isFalse();
        assertThat(v.inbetriebnahmeAbSolarspitzengesetz()).isFalse();
    }

    @Test
    void mitDatumEntscheidetDasDatumUndDieAlteAntwortVerschwindet() {
        // Kam das Datum nach der Antwort dazu (MaStR verknüpft), gilt das Datum.
        Grundlage g = new Grundlage("eigenverbrauch", false, new BigDecimal("9"), true,
                LocalDate.of(2023, 6, 15), new BigDecimal("8"), null, "angegeben");
        EinspeiseverguetungDto d = EinspeiseverguetungStand.von(g, EegRates.defaults());
        assertThat(d.ohneVerguetungBeiNegativpreis()).isFalse();
        assertThat(d.inbetriebnahmeAbSolarspitzengesetz()).as("nicht mehr gezeigt").isNull();
    }

    @Test
    void einKorrigierterSatzplanWirktAuchAufDieKarte() {
        // OPTIMIZER_EEG_RATES_JSON ersetzt den Satzplan für Optimierer UND Erlöse -
        // die Karte liest denselben, sonst nennte sie einen anderen Satz.
        EegRates korrigiert = EegRates.fromJson(
                "[{\"from\": \"2020-01-01\", \"le10\": 9.99, \"le40\": 9.0, \"le100\": 8.0}]");
        EinspeiseverguetungDto d = EinspeiseverguetungStand.von(
                grundlage("eigenverbrauch", false, null, LocalDate.of(2023, 6, 15), null, "eeg"),
                korrigiert);
        assertThat(d.hergeleitetCtKwh()).isEqualByComparingTo("9.99");
        assertThat(d.wirksamCtKwh()).isEqualByComparingTo("9.99");
    }
}
