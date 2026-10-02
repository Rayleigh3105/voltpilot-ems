package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.ZaehlerrolleRegeln.Angaben;
import com.voltpilot.api.uems.ZaehlerrolleRegeln.Befund;
import com.voltpilot.api.uems.ZaehlerrolleRegeln.Knoten;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Zählerrollen-Regeln (MiSpeL MP-6) gegen die Festlegung: Größen der Formelsätze (Anlage 1
 * S. 32–33), Passung (S. 23) und die Trennung hinter Z2/Z3 (S. 25, Abschn. 3.2.4).
 */
class ZaehlerrolleRegelnTest {

    private static final LocalDate TAG = LocalDate.of(2026, 10, 2);
    private static final String ZP = "DE0001234567890000000000000000001";

    private static Angaben rolle(String r) {
        return new Angaben(r, ZP, "Netze Musterstadt GmbH", "eichrechtskonform", null, "messstellenbetreiber");
    }

    private static Knoten knoten(String kz, String richtung, String stellung, Knoten ueber, Angaben a,
            String... messobjekt) {
        return new Knoten(UUID.nameUUIDFromBytes(kz.getBytes()), kz, richtung, stellung,
                ueber == null ? null : ueber.id(), a, Set.of(messobjekt));
    }

    @Test
    void groessenDerFormelsaetze() {
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z1", "Bezug")).isEqualTo("Z1NB");
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z1", "Abgabe")).isEqualTo("Z1NE");
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z1", "Laden")).isNull();
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z2", "Laden")).isEqualTo("Z2V");
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z2", "Bezug")).isEqualTo("Z2V");
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z2", "Entladen")).isEqualTo("Z2E");
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z3", "Abgabe")).isEqualTo("Z3E");
        assertThat(ZaehlerrolleRegeln.festlegungsgroesse("Z2", "Laden / Entladen")).isNull();
    }

    @Test
    void formUndPassung() {
        assertThat(ZaehlerrolleRegeln.formPruefen(rolle("Z2"))).isNull();
        assertThat(ZaehlerrolleRegeln.formPruefen(rolle("Z4")).grund()).isEqualTo("rolle");
        assertThat(ZaehlerrolleRegeln.formPruefen(new Angaben("Z1", "de0001234567890000000000000000001", null, null,
                null, "geraet")).grund()).isEqualTo("zaehlpunkt");
        assertThat(ZaehlerrolleRegeln.formPruefen(new Angaben("Z1", null, null, null, null, null)).grund())
                .isEqualTo("wertequelle");
        assertThat(ZaehlerrolleRegeln.formPruefen(new Angaben(null, ZP, null, null, null, null)).grund())
                .isEqualTo("angaben_ohne_rolle");
        assertThat(ZaehlerrolleRegeln.formPruefen(new Angaben(null, null, null, null, null, null))).isNull();
        assertThat(ZaehlerrolleRegeln.passtPruefen("berechnet", "Strom", "Wirkenergie", "Bezug", "Z1").grund())
                .isEqualTo("nicht_gemessen");
        assertThat(ZaehlerrolleRegeln.passtPruefen("gemessen", "Strom", "Wirkleistung", "Bezug", "Z1").grund())
                .isEqualTo("keine_wirkenergie");
        assertThat(ZaehlerrolleRegeln.passtPruefen("gemessen", "Gas", "Wirkenergie", "Bezug", "Z1").grund())
                .isEqualTo("nicht_strom");
        assertThat(ZaehlerrolleRegeln.passtPruefen("gemessen", "Strom", "Wirkenergie", "Laden / Entladen", "Z2")
                .grund()).isEqualTo("richtung");
        assertThat(ZaehlerrolleRegeln.passtPruefen("gemessen", "Strom", "Wirkenergie", "Laden", "Z2")).isNull();
    }

    /** A1 S. 25: hinter Z2 darf kein sonstiger Verbrauch stattfinden und keine sonstige Erzeugung hängen. */
    @Test
    void hinterZ2keinSonstigerVerbrauchUndKeineSonstigeErzeugung() {
        Knoten z1 = knoten("MS-01", "Bezug", "Hauptzähler", null, rolle("Z1"), "grid");
        Knoten z2 = knoten("MS-02", "Laden", "Speicher", null, rolle("Z2"), "storage");
        Knoten wp = knoten("MS-03", "Bezug", "Unterzähler", z2, null, "consumer");
        Knoten pv = knoten("MS-04", "Abgabe", "Unterzähler", wp, null, "pv");
        List<Befund> b = ZaehlerrolleRegeln.befunde(List.of(z1, z2, wp, pv), TAG);
        assertThat(b).filteredOn(x -> x.messstelle().equals("MS-02") && x.schwere().equals("fehler"))
                .extracting(Befund::code, Befund::betroffen, Befund::fundstelle)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("sonstiger_verbrauch_hinter_zaehler", "MS-03",
                                ZaehlerrolleRegeln.A1_S25),
                        org.assertj.core.groups.Tuple.tuple("sonstige_erzeugung_hinter_zaehler", "MS-04",
                                ZaehlerrolleRegeln.A1_S25));
        assertThat(ZaehlerrolleRegeln.urteil("Z2", ZaehlerrolleRegeln.befundeZu("MS-02", b)))
                .isEqualTo("nicht_tauglich");
    }

    @Test
    void speicherUndLadepunktHinterZ2sindErlaubtZ3nurDerSpeicher() {
        Knoten z2 = knoten("MS-02", "Laden", "Speicher", null, rolle("Z2"), "storage");
        Knoten lp = knoten("MS-05", "Bezug", "Unterzähler", z2, null, "charging");
        Knoten z3 = knoten("MS-06", "Laden", "Unterzähler", z2, rolle("Z3"), "storage");
        List<Befund> b = ZaehlerrolleRegeln.befunde(List.of(z2, lp, z3), TAG);
        assertThat(b).noneMatch(x -> x.schwere().equals("fehler"));

        Knoten z3mitLp = knoten("MS-07", "Laden", "Speicher", null, rolle("Z3"), "storage");
        Knoten lp2 = knoten("MS-08", "Bezug", "Unterzähler", z3mitLp, null, "charging");
        assertThat(ZaehlerrolleRegeln.befunde(List.of(z3mitLp, lp2), TAG)).extracting(Befund::code)
                .contains("ladepunkt_hinter_z3");
    }

    @Test
    void unbekanntIstNichtGetrenntUndDcKopplungWarnt() {
        Knoten z2 = knoten("MS-02", "Laden", "Speicher", null, rolle("Z2"));
        List<Befund> b = ZaehlerrolleRegeln.befunde(List.of(z2), TAG);
        assertThat(b).extracting(Befund::code).contains("messobjekt_unbekannt");
        assertThat(ZaehlerrolleRegeln.urteil("Z2", b)).isEqualTo("nicht_pruefbar");

        Knoten hybrid = knoten("MS-09", "Laden", "Speicher", null, rolle("Z2"), "storage", "pv");
        List<Befund> h = ZaehlerrolleRegeln.befunde(List.of(hybrid), TAG);
        assertThat(h).extracting(Befund::code, Befund::fundstelle)
                .contains(org.assertj.core.groups.Tuple.tuple("dc_kopplung_erzeugung", ZaehlerrolleRegeln.T_S32));
        assertThat(h).noneMatch(x -> x.schwere().equals("fehler"));
    }

    @Test
    void zweirichtungszaehlerEinZaehlpunktUndEichstatus() {
        Knoten nb = knoten("MS-01", "Bezug", "Hauptzähler", null, rolle("Z1"), "grid");
        Knoten ne = knoten("MS-02", "Abgabe", "Hauptzähler", null, new Angaben("Z1",
                "DE0001234567890000000000000000002", null, "nicht_eichrechtskonform", null, "geraet"), "grid");
        List<Befund> b = ZaehlerrolleRegeln.befunde(List.of(nb, ne), TAG);
        assertThat(b).extracting(Befund::code).contains("zaehlpunkt_abweichend", "nicht_eichrechtskonform",
                "wertequelle_geraet", "messstellenbetreiber_fehlt");
        assertThat(ZaehlerrolleRegeln.befunde(List.of(nb), TAG)).extracting(Befund::code)
                .contains("gegenrichtung_fehlt");
        Knoten abgelaufen = knoten("MS-01", "Bezug", "Hauptzähler", null, new Angaben("Z1", ZP, "MSB",
                "eichrechtskonform", TAG.minusDays(1), "messstellenbetreiber"), "grid");
        assertThat(ZaehlerrolleRegeln.befunde(List.of(abgelaufen), TAG)).extracting(Befund::code)
                .contains("eichfrist_abgelaufen");
        assertThat(ZaehlerrolleRegeln.vergeben(UUID.randomUUID(), "Z1NB", List.of(nb))).isEqualTo(nb);
    }
}
