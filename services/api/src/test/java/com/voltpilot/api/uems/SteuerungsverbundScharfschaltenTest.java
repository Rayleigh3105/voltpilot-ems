package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.SteuerungsverbundScharfschalten.Box;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die reine Regel des Scharfschaltens (UEMS AP-15 IP-5, I1, G6/R18): Reihenfolge der Befunde nach dem Vokabular,
 * „unbekannt ist nicht vorhanden“, die zwei Lesarten von G6 und die Stufe nach einer Änderung (I3).
 */
class SteuerungsverbundScharfschaltenTest {

    private static final List<SteuerungsverbundRegeln.Mitglied> AN1 = List.of(
            new SteuerungsverbundRegeln.Mitglied("E-1", "AN-1", Rolle.FUEHRT, "DQ-2"),
            new SteuerungsverbundRegeln.Mitglied("E-4", "AN-1", Rolle.STEUERT_MIT, "DQ-10"));
    private static final SteuerungsverbundRegeln.Urteil OBJEKT_OK = new SteuerungsverbundRegeln.Urteil(List.of());

    @Test
    void allesDaIstZulaessig() {
        var u = SteuerungsverbundScharfschalten.pruefen(OBJEKT_OK, AN1, true, true,
                Map.of("E-1", box("E-1", true, true, false, true), "E-4", box("E-4", true, true, false, true)));
        assertThat(u.zulaessig()).isTrue();
    }

    @Test
    void heuteFehlenFaehigkeitNachweisAuslegungUndVorgabeInVokabularReihenfolge() {
        var u = SteuerungsverbundScharfschalten.pruefen(OBJEKT_OK, AN1, true, false,
                Map.of("E-1", new Box("E-1", true, false, false, null, null),
                        "E-4", new Box("E-4", true, false, false, null, null)));
        assertThat(u.befunde()).extracting(SteuerungsverbundRegeln.Befund::ablehnung).containsExactly(
                Ablehnung.FAEHIGKEIT_FEHLT, Ablehnung.FAEHIGKEIT_FEHLT, Ablehnung.NACHWEIS_FEHLT,
                Ablehnung.NACHWEIS_FEHLT, Ablehnung.AUSLEGUNG_PASST_NICHT,
                Ablehnung.VORGABE_SIGNAL_NICHT_AN_JEDER_BOX, Ablehnung.VORGABE_SIGNAL_NICHT_AN_JEDER_BOX);
        assertThat(u.ablehnung()).isEqualTo(Ablehnung.FAEHIGKEIT_FEHLT);
        assertThat(SteuerungsverbundScharfschalten.struktur(u)).as("S0 → S1 verlangt nur die Struktur").isEmpty();
        assertThat(SteuerungsverbundScharfschalten.stufeNachAenderung(u)).isEqualTo(Stufe.BEOBACHTET);
    }

    /** R18: das Signal liegt nur an E-1, die Ladepunkte (§ 14a) hängen an E-4 — scharf_ohne_signal_an_e4 = false. */
    @Test
    void r18SignalNurAnDerBoxOhneVerbraucher() {
        var u = SteuerungsverbundScharfschalten.pruefen(OBJEKT_OK, AN1, true, true,
                Map.of("E-1", box("E-1", true, true, false, true), "E-4", box("E-4", true, true, true, false)));
        assertThat(u.befunde()).containsExactly(
                new SteuerungsverbundRegeln.Befund(Ablehnung.VORGABE_SIGNAL_NICHT_AN_JEDER_BOX, "E-4", null));
    }

    /** G6, zweite Lesart: alle Verbraucher nach § 14a hängen an der Box mit dem Signal. */
    @Test
    void g6AlleVerbraucherAnDerBoxMitDemSignal() {
        assertThat(SteuerungsverbundScharfschalten.vorgabeSignalPasst(new Box("E-4", true, true, true, false, null)))
                .as("keine Verbraucher, kein Signal nötig").isTrue();
        assertThat(SteuerungsverbundScharfschalten.vorgabeSignalPasst(new Box("E-4", true, true, true, null, true)))
                .as("Verbraucher unbekannt, Signal liegt an").isTrue();
        assertThat(SteuerungsverbundScharfschalten.vorgabeSignalPasst(new Box("E-4", true, true, true, null, null)))
                .as("unbekannt ist nicht vorhanden").isFalse();
    }

    @Test
    void ausgebauteBoxUndFehlendeGrenzeSindStruktur() {
        var objekt = new SteuerungsverbundRegeln.Urteil(List.of(
                new SteuerungsverbundRegeln.Befund(Ablehnung.KEIN_NETZANSCHLUSS, null, null)));
        var u = SteuerungsverbundScharfschalten.pruefen(objekt, AN1, false, true,
                Map.of("E-1", box("E-1", true, true, false, true), "E-4", new Box("E-4", false, true, true, false,
                        null)));
        assertThat(u.befunde()).extracting(SteuerungsverbundRegeln.Befund::ablehnung).containsExactly(
                Ablehnung.BOX_NICHT_IN_ANLAGE, Ablehnung.KEIN_NETZANSCHLUSS, Ablehnung.GRENZE_FEHLT);
        assertThat(SteuerungsverbundScharfschalten.stufeNachAenderung(u)).isEqualTo(Stufe.ERKLAERT);
    }

    @Test
    void boxNichtInAnlageAusDemObjektStehtNurEinmal() {
        var objekt = new SteuerungsverbundRegeln.Urteil(List.of(
                new SteuerungsverbundRegeln.Befund(Ablehnung.BOX_NICHT_IN_ANLAGE, "E-4", null)));
        var u = SteuerungsverbundScharfschalten.pruefen(objekt, AN1, true, true,
                Map.of("E-1", box("E-1", true, true, false, true), "E-4", new Box("E-4", false, true, true, false,
                        null)));
        assertThat(u.befunde()).hasSize(1);
    }

    private static Box box(String kennung, boolean faehig, boolean geprueft, Boolean verbraucher, Boolean signal) {
        return new Box(kennung, true, faehig, geprueft, verbraucher, signal);
    }
}
