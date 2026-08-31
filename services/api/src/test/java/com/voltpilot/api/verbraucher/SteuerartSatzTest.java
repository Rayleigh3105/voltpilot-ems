package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.consumers.SgReady;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Steuerart-SAETZE je Typ (§3.1/§3.2, Captain-Entscheide E1/E7/E8).
 *
 * <p>Rein, ohne Docker. Zwei Dinge nagelt er fest: welche Wahl ein Typ
 * ueberhaupt kennt, und dass eine gesperrte Wahl IMMER ihren Grund nennt - der
 * Dialog rendert diese Liste, und der Schreibpfad prueft sie ein zweites Mal.
 */
class SteuerartSatzTest {

    private static SteuerartSatz.Kontext k(String typ, String rated, String tarif, boolean pv,
            String kanal) {
        return new SteuerartSatz.Kontext(typ, rated == null ? null : new BigDecimal(rated), null,
                kanal, tarif, pv, new BigDecimal("12"));
    }

    private static List<String> ids(List<SteuerartSatz.Option> o) {
        return o.stream().map(SteuerartSatz.Option::id).toList();
    }

    private static SteuerartSatz.Option finde(List<SteuerartSatz.Option> o, String id) {
        return o.stream().filter(x -> x.id().equals(id)).findFirst().orElseThrow();
    }

    // --- §3.1: die Saetze ---------------------------------------------------

    @Test
    void jederTypKenntGenauSeineQuellenUndZiele() {
        assertThat(ids(SteuerartSatz.quellen(
                k(VerbraucherService.TYPE_WALLBOX, "11", "dynamisch", true, "power_kw"))))
                .containsExactly("sofort", "ueberschuss", "guenstig");
        // ⚠ Ueberall HINTEN die Ruecknahme `sofort` („VoltPilot steuert das
        // nicht") - ohne sie gaebe es keinen Weg zurueck in den Anfangszustand,
        // den die Projektion fuer eine Komponente ohne Policy zurueckgibt.
        assertThat(ids(SteuerartSatz.quellen(k("heating-rod", "3", "dynamisch", true, "relay_state"))))
                .containsExactly("ueberschuss", "feste_zeiten", "guenstig", "sofort");
        assertThat(ids(SteuerartSatz.quellen(k("pump", "0.8", "dynamisch", true, "relay_state"))))
                .as("E1: eine Pumpe laeuft nach Zeitplan, nicht nach Preis")
                .containsExactly("feste_zeiten", "sofort");
        assertThat(ids(SteuerartSatz.quellen(k(SgReady.TYPE, null, "dynamisch", true, "freigabe"))))
                .containsExactly("freigabe_ueberschuss", "freigabe_guenstig", "sofort");
        assertThat(ids(SteuerartSatz.quellen(k("generic-load", "2", "dynamisch", true, "relay_state"))))
                .containsExactly("ueberschuss", "feste_zeiten", "guenstig", "sofort");
        // Ein Typ, den dieser Stand nicht kennt, bekommt den generischen Satz -
        // nie eine leere Auswahl.
        assertThat(ids(SteuerartSatz.quellen(k("modbus-load", "1", "dynamisch", true, "relay_state"))))
                .containsExactly("ueberschuss", "feste_zeiten", "guenstig", "sofort");

        assertThat(ids(SteuerartSatz.ziele(
                k(VerbraucherService.TYPE_WALLBOX, "11", "dynamisch", true, "power_kw"),
                "ueberschuss"))).containsExactly("bis_uhrzeit");
        assertThat(ids(SteuerartSatz.ziele(k("heating-rod", "3", "dynamisch", true, "relay_state"),
                "ueberschuss"))).containsExactly("laufzeit_bis");
        assertThat(SteuerartSatz.ziele(k("generic-load", "2", "dynamisch", true, "relay_state"),
                "ueberschuss")).isEmpty();
        assertThat(SteuerartSatz.ziele(k(SgReady.TYPE, null, "dynamisch", true, "freigabe"),
                "freigabe_ueberschuss"))
                .as("E9: die Pumpe entscheidet selbst - es gibt gar kein Ziel").isEmpty();
    }

    // --- Die Sperrgruende ---------------------------------------------------

    @Test
    void guenstigIstOhneDynamischenTarifGesperrtUndNenntDenPassendenGrund() {
        var fest = finde(SteuerartSatz.quellen(
                k("heating-rod", "3", "fest", true, "relay_state")), "guenstig");
        assertThat(fest.gesperrt()).isTrue();
        assertThat(fest.grund()).isEqualTo(SteuerartSatz.GRUND_TARIF_FEST);

        // ⚠ „ohne" ist NICHT dasselbe wie „fest": wir wissen den Tarif nicht -
        // „hat keine stuendlichen Preise" waere eine Aussage ueber einen
        // Vertrag, den uns niemand genannt hat. Der Satz nennt stattdessen den
        // Weg, auf dem es geht.
        var ohne = finde(SteuerartSatz.quellen(
                k("heating-rod", "3", "ohne", true, "relay_state")), "guenstig");
        assertThat(ohne.gesperrt()).isTrue();
        assertThat(ohne.grund()).isEqualTo(SteuerartSatz.GRUND_TARIF_UNBEKANNT);
        assertThat(ohne.grund()).isNotEqualTo(fest.grund());

        var dyn = finde(SteuerartSatz.quellen(
                k("heating-rod", "3", "dynamisch", true, "relay_state")), "guenstig");
        assertThat(dyn.gesperrt()).isFalse();
        assertThat(dyn.grund()).isNull();
    }

    @Test
    void ueberschussBrauchtPvUndEineNennleistung() {
        var ohnePv = finde(SteuerartSatz.quellen(
                k("heating-rod", "3", "dynamisch", false, "relay_state")), "ueberschuss");
        assertThat(ohnePv.grund()).isEqualTo(SteuerartSatz.GRUND_OHNE_PV);

        var ohneKw = finde(SteuerartSatz.quellen(
                k("heating-rod", null, "dynamisch", true, "relay_state")), "ueberschuss");
        assertThat(ohneKw.grund()).isEqualTo(SteuerartSatz.GRUND_OHNE_NENNLEISTUNG);

        // ⚠ Die SG-Ready-Freigabe braucht KEINE Nennleistung: sie schaltet einen
        // Kontakt, keine Leistung (P8) - ihre Schwelle hat eine eigene Vorgabe.
        var freigabe = finde(SteuerartSatz.quellen(
                k(SgReady.TYPE, null, "dynamisch", true, "freigabe")), "freigabe_ueberschuss");
        assertThat(freigabe.gesperrt()).isFalse();
    }

    @Test
    void einZielNebenSofortIstImmerSchonErfuellt() {
        var ziel = finde(SteuerartSatz.ziele(
                k(VerbraucherService.TYPE_WALLBOX, "11", "dynamisch", true, "power_kw"), "sofort"),
                "bis_uhrzeit");
        assertThat(ziel.gesperrt()).isTrue();
        assertThat(ziel.grund()).isEqualTo(SteuerartSatz.GRUND_ZIEL_BEI_SOFORT);
    }

    @Test
    void einKwhZielBrauchtEineMessung() {
        // D3: ohne Messkanal ist „fertig" geraten - die Regel, an der die
        // Fragen des Baukastens seit Inkrement 1 haengen.
        var ohne = finde(SteuerartSatz.ziele(
                k(VerbraucherService.TYPE_WALLBOX, "11", "dynamisch", true, "relay_state"),
                "ueberschuss"), "bis_uhrzeit");
        assertThat(ohne.gesperrt()).isTrue();
        assertThat(ohne.grund()).isEqualTo(SteuerartSatz.GRUND_ZIEL_OHNE_MESSUNG);

        var mit = finde(SteuerartSatz.ziele(
                k(VerbraucherService.TYPE_WALLBOX, "11", "dynamisch", true, "power_kw"),
                "ueberschuss"), "bis_uhrzeit");
        assertThat(mit.gesperrt()).isFalse();
    }

    // --- Der Zaun -----------------------------------------------------------

    @Test
    void jederTypKommtWiederZurueckInDenAnfangszustand() {
        // Die Ruecknahme ist an JEDEM Typ zulaessig - und sie ist genau der
        // Zustand, den die Projektion fuer eine Komponente ohne Policy meldet.
        for (String typ : List.of(VerbraucherService.TYPE_WALLBOX, "heating-rod", "pump",
                "generic-load", SgReady.TYPE, "modbus-load")) {
            assertThat(SteuerartSatz.pruefe(k(typ, "2", "ohne", false, "relay_state"),
                    SteuerartWunsch.von(SteuerartProjektion.QUELLE_SOFORT)))
                    .as("Ruecknahme an %s", typ).isEmpty();
        }
    }

    @Test
    void derSchreibpfadLehntEineWahlAbDieDerDialogNichtAnbietet() {
        var pumpe = k("pump", "0.8", "dynamisch", true, "relay_state");
        assertThat(SteuerartSatz.pruefe(pumpe,
                SteuerartWunsch.von(SteuerartProjektion.QUELLE_GUENSTIG)))
                .singleElement().asString().contains("kennt");
        // Und eine GESPERRTE Wahl wird mit GENAU ihrem Grund abgelehnt - der
        // Client kann sie nicht am Dialog vorbei setzen.
        assertThat(SteuerartSatz.pruefe(k("heating-rod", "3", "fest", true, "relay_state"),
                SteuerartWunsch.von(SteuerartProjektion.QUELLE_GUENSTIG)))
                .containsExactly(SteuerartSatz.GRUND_TARIF_FEST);
        assertThat(SteuerartSatz.pruefe(k(SgReady.TYPE, null, "dynamisch", true, "freigabe"),
                new SteuerartWunsch(SgReady.QUELLE_UEBERSCHUSS, null, null, null, null, null,
                        SteuerartProjektion.ZIEL_BIS_UHRZEIT, null, null, null, null)))
                .containsExactly(SteuerartSatz.GRUND_KEIN_ZIEL_SGREADY);
    }

    @Test
    void ohneQuelleUndMitUnbekannterQuelleWirdNichtsGeschrieben() {
        var lp = k(VerbraucherService.TYPE_WALLBOX, "11", "dynamisch", true, "power_kw");
        assertThat(SteuerartSatz.pruefe(lp, null)).hasSize(1);
        assertThat(SteuerartSatz.pruefe(lp, SteuerartWunsch.von(""))).hasSize(1);
        assertThat(SteuerartSatz.pruefe(lp, SteuerartWunsch.von("nachts_wenn_der_mond"))).hasSize(1);
    }

    @Test
    void festeZeitenBrauchenEinEchtesFenster() {
        var last = k("generic-load", "2", "dynamisch", true, "relay_state");
        assertThat(SteuerartSatz.pruefe(last,
                SteuerartWunsch.von(SteuerartProjektion.QUELLE_FESTE_ZEITEN)))
                .as("ohne Fenster gibt es keine Zeitregel").isNotEmpty();
        assertThat(SteuerartSatz.pruefe(last, new SteuerartWunsch(
                SteuerartProjektion.QUELLE_FESTE_ZEITEN, null, null, null, null,
                new Steuerart.Fenster("daily", "13:00", "13:00"), null, null, null, null, null)))
                .as("Anfang gleich Ende ist kein Fenster").isNotEmpty();
        assertThat(SteuerartSatz.pruefe(last, new SteuerartWunsch(
                SteuerartProjektion.QUELLE_FESTE_ZEITEN, null, null, null, null,
                new Steuerart.Fenster("montags", "13:00", "15:00"), null, null, null, null, null)))
                .as("ein unbekannter Tagesbezug wird nicht geraten").isNotEmpty();
    }

    @Test
    void zahlenAusserhalbIhrerGrenzenWerdenBenanntAbgelehnt() {
        var last = k("generic-load", "2", "dynamisch", true, "relay_state");
        assertThat(SteuerartSatz.pruefe(last, new SteuerartWunsch(
                SteuerartProjektion.QUELLE_UEBERSCHUSS, BigDecimal.ZERO, null, null, null, null,
                null, null, null, null, null))).singleElement().asString().contains("größer als 0");
        assertThat(SteuerartSatz.pruefe(last, new SteuerartWunsch(
                SteuerartProjektion.QUELLE_UEBERSCHUSS, null, null, -1, null, null, null, null,
                null, null, null))).singleElement().asString().contains("Mindestlaufzeit");
    }

    // --- §3.2: die Vorgaben -------------------------------------------------

    @Test
    void jedeVorgabeIstBelegtOderNull() {
        var heiz = SteuerartSatz.vorgaben(k("heating-rod", "3", "dynamisch", true, "relay_state"));
        assertThat(heiz.schwelleKw()).as("Vorgabe = Nennleistung (§3.2)").isEqualByComparingTo("3");
        assertThat(heiz.mindestlaufzeitMinuten()).isEqualTo(SteuerartSatz.MINDESTLAUFZEIT_MINUTEN);
        assertThat(heiz.zielEnergieKwh()).as("E8").isEqualByComparingTo("20");
        assertThat(heiz.zielUhrzeit()).isEqualTo("06:00");

        // ⚠ Ohne gepflegte Nennleistung gibt es KEINE Schwellen-Vorgabe: das
        // Feld startet leer, statt eine Zahl ueber das Geraet zu erfinden.
        assertThat(SteuerartSatz.vorgaben(k("heating-rod", null, "dynamisch", true, "relay_state"))
                .schwelleKw()).isNull();
        // Und ohne belastbare Preise auch keine Preisgrenze.
        assertThat(SteuerartSatz.vorgaben(new SteuerartSatz.Kontext("heating-rod",
                new BigDecimal("3"), null, "relay_state", "dynamisch", true, null))
                .preisgrenzeCtKwh()).isNull();

        // Die SG-Ready-Freigabe hat ihre EIGENEN Zahlen (P8).
        var sg = SteuerartSatz.vorgaben(k(SgReady.TYPE, null, "dynamisch", true, "freigabe"));
        assertThat(sg.schwelleKw()).isEqualByComparingTo(SgReady.SCHWELLE_KW_VORGABE);
        assertThat(sg.mindestlaufzeitMinuten()).isEqualTo(SgReady.MINDESTFREIGABE_MINUTEN);
        assertThat(sg.sperrzeitMinuten()).isEqualTo(SgReady.SPERRZEIT_MINUTEN);
    }

    @Test
    void einLadepunktStartetBeiSeinerMindestLadeleistung() {
        var mit = SteuerartSatz.vorgaben(new SteuerartSatz.Kontext(VerbraucherService.TYPE_WALLBOX,
                new BigDecimal("11"), new BigDecimal("4.2"), "power_kw", "dynamisch", true, null));
        assertThat(mit.schwelleKw()).isEqualByComparingTo("4.2");
        var ohne = SteuerartSatz.vorgaben(new SteuerartSatz.Kontext(VerbraucherService.TYPE_WALLBOX,
                new BigDecimal("11"), null, "power_kw", "dynamisch", true, null));
        assertThat(ohne.schwelleKw()).isEqualByComparingTo("11");
    }
}
