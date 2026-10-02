package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Die Abweichungsampel (MP-15, BK-15 Variante A) und die CSV des Messstellenbetreibers — rein, ohne Docker. */
class MsbAbgleichRegelnTest {

    private static final MsbAbgleichRegeln.Schwellen S = new MsbAbgleichRegeln.Schwellen(new BigDecimal("2"),
            new BigDecimal("5"));

    private static MsbAbgleichRegeln.Ergebnis v(String geraet, String msb) {
        return MsbAbgleichRegeln.vergleichen(new MsbAbgleichRegeln.Eingang(96, 96, new BigDecimal(geraet), 96,
                new BigDecimal(msb), false), S);
    }

    @Test
    void dieSchwellenGeltenEinschliesslichUndInBeideRichtungen() {
        assertThat(v("102", "100").ampel()).isEqualTo("gruen");
        assertThat(v("98", "100").ampel()).isEqualTo("gruen");
        assertThat(v("102.01", "100").ampel()).isEqualTo("gelb");
        assertThat(v("105", "100").ampel()).isEqualTo("gelb");
        assertThat(v("94.99", "100").ampel()).isEqualTo("rot");
        // Bekannte Abweichung des Beispielmonats (BK-15): Speicherzähler Entladen 9 120 gegen 8 820 kWh = +3,4 %.
        MsbAbgleichRegeln.Ergebnis e = v("9120", "8820");
        assertThat(e.ampel()).isEqualTo("gelb");
        assertThat(e.abweichungProzent()).isEqualByComparingTo("3.4");
        assertThat(e.unterschiedKwh()).isEqualByComparingTo("300");
    }

    @Test
    void nichtVergleichbarIstGrauMitGrundUndNieNull() {
        MsbAbgleichRegeln.Ergebnis ohne = MsbAbgleichRegeln.vergleichen(new MsbAbgleichRegeln.Eingang(96, 96,
                BigDecimal.TEN, 0, BigDecimal.ZERO, false), S);
        assertThat(ohne.ampel()).isEqualTo("grau");
        assertThat(ohne.grund()).isEqualTo("keine_msb_werte");
        assertThat(ohne.msbKwh()).isNull();
        assertThat(MsbAbgleichRegeln.vergleichen(new MsbAbgleichRegeln.Eingang(96, 0, BigDecimal.ZERO, 96,
                BigDecimal.TEN, false), S).grund()).isEqualTo("keine_geraetewerte");
        assertThat(MsbAbgleichRegeln.vergleichen(new MsbAbgleichRegeln.Eingang(96, 96, BigDecimal.TEN, 96,
                BigDecimal.TEN, true), S).grund()).isEqualTo("zaehlerwechsel");
        MsbAbgleichRegeln.Ergebnis luecke = MsbAbgleichRegeln.vergleichen(new MsbAbgleichRegeln.Eingang(96, 96,
                BigDecimal.TEN, 88, BigDecimal.TEN, false), S);
        assertThat(luecke.grund()).isEqualTo("luecke");
        assertThat(luecke.abweichungProzent()).isNull();
        assertThat(v("0", "0").ampel()).isEqualTo("gruen");
        assertThat(v("1", "0").ampel()).isEqualTo("rot");
        assertThatThrownBy(() -> new MsbAbgleichRegeln.Schwellen(new BigDecimal("5"), new BigDecimal("2")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void dieCsvLiestBeideRichtungenObisUndDezimalkomma() {
        String zp = "DE0003374000000000000000001234567";
        List<MsbWerteCsv.Wert> w = MsbWerteCsv.lesen("﻿# Kopf\nkwh;zeitstempel;zaehlpunkt;richtung\n"
                + "1,250;2026-12-01T00:00+01:00;" + zp + ";1-1:1.29.0\n"
                + "0,5;2026-12-01T00:15+01:00;" + zp + ";ABGABE\n\n");
        assertThat(w).hasSize(2);
        assertThat(w.get(0).richtung()).isEqualTo("bezug");
        assertThat(w.get(0).kwh()).isEqualByComparingTo("1.25");
        assertThat(w.get(1).richtung()).isEqualTo("abgabe");
        assertThat(MsbWerteCsv.lesen("zeitstempel,zaehlpunkt,richtung,kwh\n2026-12-01T00:00Z," + zp
                + ",bezug,2.5\n").get(0).kwh()).isEqualByComparingTo("2.5");
    }

    @Test
    void eineKaputteDateiNenntGrundUndZeile() {
        String zp = "DE0003374000000000000000001234567";
        String kopf = "zeitstempel;zaehlpunkt;richtung;kwh\n";
        assertThatThrownBy(() -> MsbWerteCsv.lesen(kopf + "2026-12-01T00:00+01:00;DE12;bezug;1\n"))
                .hasFieldOrPropertyWithValue("grund", "zaehlpunkt").hasFieldOrPropertyWithValue("zeile", 2);
        assertThatThrownBy(() -> MsbWerteCsv.lesen(kopf + "2026-12-01T00:00;" + zp + ";bezug;1\n"))
                .hasFieldOrPropertyWithValue("grund", "zeitstempel");
        assertThatThrownBy(() -> MsbWerteCsv.lesen(kopf + "2026-12-01T00:00+01:00;" + zp + ";hin;1\n"))
                .hasFieldOrPropertyWithValue("grund", "richtung");
        assertThatThrownBy(() -> MsbWerteCsv.lesen(kopf + "2026-12-01T00:00+01:00;" + zp + ";bezug;-1\n"))
                .hasFieldOrPropertyWithValue("grund", "kwh");
        assertThatThrownBy(() -> MsbWerteCsv.lesen(kopf + "2026-12-01T00:00+01:00;" + zp + ";bezug;1\n"
                + "2026-11-30T23:00Z;" + zp + ";bezug;2\n")).hasFieldOrPropertyWithValue("grund", "doppelt");
        assertThatThrownBy(() -> MsbWerteCsv.lesen("a;b;c;d\n")).hasFieldOrPropertyWithValue("grund", "kopf");
        assertThatThrownBy(() -> MsbWerteCsv.lesen(kopf)).hasFieldOrPropertyWithValue("grund", "leer");
    }
}
