package com.voltpilot.api.uems;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
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
    private final KennzahlLauf kennzahlen = mock(KennzahlLauf.class);

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

    /**
     * AP-11 IP-6: die Kennzahlen rechnen NACH den berechneten Messstellen (ein Gesamtwert ist ihr Zähler) und VOR den
     * Korrektur-Vorschlägen — der Takt, den Spring baut ({@code @Autowired}-Konstruktor mit dem Kennzahl-Schritt).
     */
    @Test
    void dieKennzahlenRechnenNachDenBerechnetenUndVorDenVorschlaegen() {
        new EndgueltigkeitLaeufer(endgueltigkeit, tage, perioden, berechnete, kennzahlen, vorschlaege).takt();
        InOrder reihenfolge = inOrder(endgueltigkeit, tage, perioden, berechnete, kennzahlen, vorschlaege);
        reihenfolge.verify(endgueltigkeit).umschalten(any());
        reihenfolge.verify(tage).lauf(any());
        reihenfolge.verify(perioden).lauf(any());
        reihenfolge.verify(berechnete).lauf(any());
        reihenfolge.verify(kennzahlen).lauf(any());
        reihenfolge.verify(vorschlaege).lauf(any());
    }

    /** Ein Fehlschlag der berechneten Messstellen kostet die Kennzahlen nicht — ein Fehlschlag der Kennzahlen nie den Rest. */
    @Test
    void einFehlschlagVorOderImKennzahlSchrittHaeltDenTaktNichtAuf() {
        when(berechnete.lauf(any())).thenThrow(new IllegalStateException("berechnete kaputt"));
        when(kennzahlen.lauf(any())).thenThrow(new IllegalStateException("Kennzahlen kaputt"));
        new EndgueltigkeitLaeufer(endgueltigkeit, tage, perioden, berechnete, kennzahlen, vorschlaege).takt();
        verify(kennzahlen).lauf(any());
        verify(vorschlaege).lauf(any());
    }

    @Test
    void ablesungslueckenLaufenAuchNachFehlerDerMonatsstufeUndHaltenDenRestNichtAuf() {
        AblesungLueckenLauf ablesungen = mock(AblesungLueckenLauf.class);
        EndgueltigkeitLaeufer takt = new EndgueltigkeitLaeufer(
                endgueltigkeit, tage, perioden, berechnete, kennzahlen, vorschlaege);
        takt.ablesungen(ablesungen);
        when(perioden.lauf(any())).thenThrow(new IllegalStateException("Monatslauf kaputt"));
        when(ablesungen.lauf(any())).thenThrow(new IllegalStateException("Ablesungslücken kaputt"));
        takt.takt();
        InOrder reihenfolge = inOrder(perioden, ablesungen, berechnete, kennzahlen, vorschlaege);
        reihenfolge.verify(perioden).lauf(any());
        reihenfolge.verify(ablesungen).lauf(any());
        reihenfolge.verify(berechnete).lauf(any());
        reihenfolge.verify(kennzahlen).lauf(any());
        reihenfolge.verify(vorschlaege).lauf(any());
    }

    /** Der Takt ohne Kennzahl-Schritt (die Tests der Stufen davor bauen ihn so) ruft keine Kennzahl. */
    @Test
    void ohneKennzahlSchrittBleibtDerTaktWieVorher() {
        new EndgueltigkeitLaeufer(endgueltigkeit, tage, perioden, berechnete, vorschlaege).takt();
        verifyNoInteractions(kennzahlen);
        verify(vorschlaege).lauf(any());
    }
    @Test
    void kanalbindungNachGemessenenUndVorKennzahlenAuchBeiFehlerIsoliert() {
        KanalbindungLauf kanal = mock(KanalbindungLauf.class);
        EndgueltigkeitLaeufer takt = new EndgueltigkeitLaeufer(endgueltigkeit,tage,perioden,berechnete,kennzahlen,vorschlaege);
        takt.kanalbindungen(kanal);
        when(kanal.lauf(any())).thenThrow(new IllegalStateException("Zusatz kaputt"));
        takt.takt();
        InOrder folge = inOrder(perioden,berechnete,kanal,kennzahlen,vorschlaege);
        folge.verify(perioden).lauf(any());
        folge.verify(berechnete).lauf(any());
        folge.verify(kanal).lauf(any());
        folge.verify(kennzahlen).lauf(any());
        folge.verify(vorschlaege).lauf(any());
    }
}
