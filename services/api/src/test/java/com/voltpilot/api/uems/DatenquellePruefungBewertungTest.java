package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeResult.OpResult;
import com.voltpilot.api.uems.DatenquelleService.Bewertung;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Wann eine Antwort der Box als Erreichbarkeitsprüfung ZÄHLT (Vertrag
 * {@code data-source-assignment.md} §7): nur „ok“ oder eine Fehlerklasse, die die BOX feststellen
 * kann. Schweigen, eine Ablehnung des Prüf-Kanals und ein fremdes Wort zählen nicht — und landen
 * deshalb auch nicht im Protokoll. Box und Adresse aus A11 (Referenzunternehmen).
 */
class DatenquellePruefungBewertungTest {

    private static final String BOX = "Box Halle 2 (neu)";
    private static final String ADRESSE = "192.168.10.31:502";

    private static Optional<ProbeResult> zeile(boolean ok, String code, String satz) {
        return Optional.of(new ProbeResult("a1b2c3d4e5f60718", null, null, List.of(new OpResult(
                DatenquelleService.PRUEF_SCHRITT, ok, ok ? 1_400_204_883.0 : null, null,
                ok ? 1_400_204_883.0 : null, code, satz))));
    }

    @Test
    void okZaehltMitDemSatzDerErreichtenAdresse() {
        Bewertung b = DatenquelleService.bewerte(zeile(true, null, null), BOX, ADRESSE);
        assertThat(b).isEqualTo(new Bewertung("ok", true, "Box Halle 2 (neu) erreicht 192.168.10.31:502"));
    }

    @Test
    void a11UnreachableZaehltMitDemSatzDerFehlerklasse() {
        Bewertung b = DatenquelleService.bewerte(zeile(false, "unreachable", "keine Verbindung"), BOX, ADRESSE);
        assertThat(b).isEqualTo(new Bewertung("unreachable", true,
                "Box Halle 2 (neu) erreicht 192.168.10.31:502 nicht — Netz/VLAN prüfen (Bogen D1/D2)"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"no_answer", "invalid_response", "implausible", "fronius_api", "timeout",
        "layout_changed", "budget"})
    void jedeFehlerklasseDerBoxZaehlt(String code) {
        Bewertung b = DatenquelleService.bewerte(zeile(false, code, "x"), BOX, ADRESSE);
        assertThat(b.gewertet()).isTrue();
        assertThat(b.ergebnis()).isEqualTo(code);
    }

    @Test
    void schweigtDieBoxZaehltNichtsUndDieCloudSagtNurDassSieSichNichtMeldet() {
        Bewertung b = DatenquelleService.bewerte(Optional.empty(), BOX, ADRESSE);
        assertThat(b).isEqualTo(new Bewertung("box_meldet_sich_nicht", false, "Box Halle 2 (neu) meldet sich nicht"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"invalid_request", "not_supported", "rate_limited", "exception",
        "Unreachable", "box_meldet_sich_nicht"})
    void keinLeseergebnisOderEinFremdesWortZaehltNicht(String code) {
        Bewertung b = DatenquelleService.bewerte(zeile(false, code, "Satz der Box"), BOX, ADRESSE);
        assertThat(b.gewertet()).as(code).isFalse();
        assertThat(b.text()).isEqualTo("Satz der Box");
    }

    @Test
    void eineAbgelehnteGanzeAnfrageZaehltNicht() {
        Bewertung b = DatenquelleService.bewerte(Optional.of(new ProbeResult("a1b2c3d4e5f60718",
                "rate_limited", "Die Box klopft gerade nicht noch einmal an.", List.of())), BOX, ADRESSE);
        assertThat(b).isEqualTo(new Bewertung("rate_limited", false, "Die Box klopft gerade nicht noch einmal an."));
    }
}
