package com.voltpilot.api.uems;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

/**
 * Die Reihenfolge im Stundentakt (UEMS AP-10 IP-10): die berechneten Messstellen rechnen NACH allen gemessenen
 * Stufen — Viertelstunden werden endgültig, Tage und Monate/Jahre gebildet, DANN die berechneten, zuletzt die
 * Korrektur-Vorschläge. Vorher gerechnet, läse eine berechnete Messstelle den Tag von gestern.
 *
 * <p>Rein (Mocks); die Reihenfolge der berechneten Messstellen UNTEREINANDER beweist
 * {@code UemsBerechnetePeriodenwerteTest} an der Datenbank.
 */
class EndgueltigkeitLaeuferReihenfolgeTest {

    private final EndgueltigkeitLauf endgueltigkeit = mock(EndgueltigkeitLauf.class);
    private final TagVerdichter tage = mock(TagVerdichter.class);
    private final PeriodeVerdichter perioden = mock(PeriodeVerdichter.class);
    private final BerechnetePeriodenLauf berechnete = mock(BerechnetePeriodenLauf.class);
    private final KorrekturVorschlagLauf vorschlaege = mock(KorrekturVorschlagLauf.class);

    @Test
    void dieBerechnetenRechnenNachAllenGemessenenStufenUndVorDenVorschlaegen() {
        new EndgueltigkeitLaeufer(endgueltigkeit, tage, perioden, berechnete, vorschlaege).takt();
        InOrder reihenfolge = inOrder(endgueltigkeit, tage, perioden, berechnete, vorschlaege);
        reihenfolge.verify(endgueltigkeit).umschalten(any());
        reihenfolge.verify(tage).lauf(any());
        reihenfolge.verify(perioden).lauf(any());
        reihenfolge.verify(berechnete).lauf(any());
        reihenfolge.verify(vorschlaege).lauf(any());
    }

    /** Ein Fehlschlag einer Stufe kostet nie den Takt: die berechneten laufen trotzdem (auf dem Stand, der steht). */
    @Test
    void einFehlschlagDerMonatsstufeHaeltDieBerechnetenNichtAuf() {
        when(perioden.lauf(any())).thenThrow(new IllegalStateException("Monatslauf kaputt"));
        when(berechnete.lauf(any())).thenThrow(new IllegalStateException("berechnete kaputt"));
        new EndgueltigkeitLaeufer(endgueltigkeit, tage, perioden, berechnete, vorschlaege).takt();
        verify(berechnete).lauf(any());
        verify(vorschlaege).lauf(any());
    }
}
