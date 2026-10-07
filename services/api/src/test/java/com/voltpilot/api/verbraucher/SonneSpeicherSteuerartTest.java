package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.chargers.ChargerComponentComposer;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * „Sonne + Speicher" (06.10.2026) in der Steuerart: die Karte, ihre Sperren MIT
 * Grund, der Zaun des Schreibpfads und die Abbildung auf die Bahn der Box. Rein,
 * ohne Docker.
 */
class SonneSpeicherSteuerartTest {

    private static final String OCPP = ChargerComponentComposer.TYPE_EV_CHARGER;

    private static SteuerartSatz.Kontext k(String typ, boolean pv, boolean speicher,
            String kapazitaet) {
        return new SteuerartSatz.Kontext(typ, new BigDecimal("11"), null, "power_kw",
                "dynamisch", pv, null, speicher, kapazitaet == null ? null : new BigDecimal(kapazitaet));
    }

    private static SteuerartSatz.Option karte(SteuerartSatz.Kontext k) {
        return SteuerartSatz.quellen(k).stream()
                .filter(o -> o.id().equals(SteuerartSatz.OPTION_SONNE_SPEICHER))
                .findFirst().orElseThrow();
    }

    private static SteuerartWunsch wunsch(String modus) {
        return new SteuerartWunsch(SteuerartProjektion.QUELLE_UEBERSCHUSS, null, null, null, null,
                null, null, null, null, null, null, modus, null);
    }

    @Test
    void dieKarteStehtHinterDemUeberschussUndIstMitSpeicherFrei() {
        var k = k(OCPP, true, true, "10");
        assertThat(SteuerartSatz.quellen(k).stream().map(SteuerartSatz.Option::id).toList())
                .containsExactly("sofort", "ueberschuss", SteuerartSatz.OPTION_SONNE_SPEICHER,
                        "guenstig");
        assertThat(karte(k).gesperrt()).isFalse();
        assertThat(SteuerartSatz.pruefe(k, wunsch(SteuerartProjektion.MODUS_SPEICHER))).isEmpty();
    }

    @Test
    void jedeSperreNenntIhrenGrundUndDerSchreibpfadLehntMitGenauDiesemAb() {
        record Fall(SteuerartSatz.Kontext k, String grund) {}
        for (Fall f : List.of(
                new Fall(k(OCPP, false, true, "10"), SteuerartSatz.GRUND_OHNE_PV),
                new Fall(k(VerbraucherService.TYPE_WALLBOX, true, true, "10"),
                        SteuerartSatz.GRUND_SPEICHER_NUR_OCPP),
                new Fall(k(OCPP, true, false, null), SteuerartSatz.GRUND_OHNE_SPEICHER),
                new Fall(k(OCPP, true, true, null), SteuerartSatz.GRUND_SPEICHER_OHNE_KAPAZITAET))) {
            SteuerartSatz.Option o = karte(f.k());
            assertThat(o.gesperrt()).as(f.grund()).isTrue();
            assertThat(o.grund()).isEqualTo(f.grund());
            assertThat(SteuerartSatz.pruefe(f.k(), wunsch(SteuerartProjektion.MODUS_SPEICHER)))
                    .containsExactly(f.grund());
        }
    }

    @Test
    void nurSonneUndSonnePlusMinimumBleibenOhneSpeicherWaehlbar() {
        var ohneSpeicher = k(OCPP, true, false, null);
        assertThat(SteuerartSatz.pruefe(ohneSpeicher, wunsch(SteuerartProjektion.MODUS_PAUSIEREN)))
                .isEmpty();
        assertThat(SteuerartSatz.pruefe(ohneSpeicher,
                wunsch(SteuerartProjektion.MODUS_MINDESTLEISTUNG))).isEmpty();
    }

    @Test
    void einUnbekannterModusWirdNichtStillZuNurSonne() {
        assertThat(SteuerartSatz.pruefe(k(OCPP, true, true, "10"), wunsch("mondschein")))
                .containsExactly(SteuerartSatz.GRUND_MODUS_UNBEKANNT);
    }

    @Test
    void sonnePlusSpeicherIstDieBahnNurSonneMitDemFlag() {
        assertThat(SteuerartProjektion.bahnAus(SteuerartProjektion.QUELLE_UEBERSCHUSS,
                SteuerartProjektion.MODUS_SPEICHER)).isEqualTo(SteuerartProjektion.POLICY_NUR_SONNE);
        assertThat(SteuerartProjektion.speicherFreigabeAus(SteuerartProjektion.QUELLE_UEBERSCHUSS,
                SteuerartProjektion.MODUS_SPEICHER)).isTrue();
        assertThat(SteuerartProjektion.speicherFreigabeAus(SteuerartProjektion.QUELLE_UEBERSCHUSS,
                SteuerartProjektion.MODUS_PAUSIEREN)).isFalse();
        assertThat(SteuerartProjektion.speicherFreigabeAus(SteuerartProjektion.QUELLE_GUENSTIG,
                SteuerartProjektion.MODUS_SPEICHER)).isFalse();
    }

    @Test
    void dieSaeuleLiestSichZurueckAlsSonnePlusSpeicher() {
        Steuerart s = SteuerartProjektion.saeulenSteuerart("nur_sonne", null, null, true);
        assertThat(s.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(s.ueberschussModus()).isEqualTo(SteuerartProjektion.MODUS_SPEICHER);
        assertThat(s.herkunft()).isEqualTo(SteuerartProjektion.HERKUNFT_SAEULE);
        // Neben einer anderen Bahn ist das Flag keine Aussage.
        assertThat(SteuerartProjektion.saeulenSteuerart("sonne_zuerst", null, null, true)
                .ueberschussModus()).isEqualTo(SteuerartProjektion.MODUS_MINDESTLEISTUNG);
        // Und ohne Flag bleibt „Nur Sonne" byte-gleich.
        assertThat(SteuerartProjektion.saeulenSteuerart("nur_sonne", null, null, false))
                .isEqualTo(SteuerartProjektion.saeulenSteuerart("nur_sonne", null, null));
    }

    @Test
    void einFahrzeugProfilLehntSonnePlusSpeicherBeimNamenAb() {
        var w = new com.voltpilot.api.fahrzeuge.FahrzeugSteuerart.Wunsch(null,
                SteuerartProjektion.QUELLE_UEBERSCHUSS, SteuerartProjektion.MODUS_SPEICHER, null);
        assertThat(com.voltpilot.api.fahrzeuge.FahrzeugSteuerart.pruefe(w))
                .contains(com.voltpilot.api.fahrzeuge.FahrzeugSteuerart.GRUND_SONNE_SPEICHER);
    }
}
