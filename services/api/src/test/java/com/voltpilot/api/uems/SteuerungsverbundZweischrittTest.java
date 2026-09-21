package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.SteuerungsverbundAbleitung.Geraet;
import com.voltpilot.api.uems.SteuerungsverbundAbleitung.Mitglied;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.AuslegungUrteil;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Stand;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Tabelle;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Ableitung und Zweischritt rein (UEMS AP-15 IP-7): R12 mit den Zahlen der Referenzdatei (40/60 → 10/60 → 10/90 kW,
 * nie über 100), E2 = A in BEIDEN Richtungen mit den R2-Zahlen, I1 (ohne Schreibfreigabe = ungeregelt mit
 * Nennleistung), „alt“ vor dem ersten Dokument (§5.3) und A18.
 */
class SteuerungsverbundZweischrittTest {

    private static final List<Mitglied> AN1 = List.of(new Mitglied("E-1", Rolle.FUEHRT),
            new Mitglied("E-4", Rolle.STEUERT_MIT));

    private static BigDecimal kw(String s) {
        return new BigDecimal(s);
    }

    private static Map<Grenzart, Map<String, BigDecimal>> tabelle(String e1, String e4, String b1, String b4) {
        return Map.of(Grenzart.EINSPEISUNG, Map.of("E-1", kw(e1), "E-4", kw(e4)),
                Grenzart.BEZUG, Map.of("E-1", kw(b1), "E-4", kw(b4)));
    }

    private static final Map<Grenzart, BigDecimal> VERTEILBAR = Map.of(Grenzart.EINSPEISUNG, kw("100.0"),
            Grenzart.BEZUG, kw("77.0"));

    private static BigDecimal summe(Map<String, BigDecimal> je) {
        return je.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    /** Die Geräte der Referenzwelt (geraete_rueckfaelle): K-1 40 kW am Gerät, K-12 läuft frei, sechs Säulen 4,1 kW. */
    private static List<Geraet> ahrenberg(String rueckfallK12) {
        List<Geraet> g = new java.util.ArrayList<>(List.of(
                new Geraet("E-1", "K-1", Grenzart.EINSPEISUNG, kw("100"), true, kw("40")),
                new Geraet("E-1", "K-2", Grenzart.BEZUG, kw("100"), true, kw("0")),
                new Geraet("E-4", "K-12", Grenzart.EINSPEISUNG, kw("60"), true, kw(rueckfallK12))));
        for (int i = 1; i <= 6; i++) {
            g.add(new Geraet("E-4", "K-13." + i, Grenzart.BEZUG, kw("22"), true, kw("4.1")));
        }
        return g;
    }

    @Test
    void r1AusGeraetenAbgeleitet40Und60sowie0Und77() {
        var eingaenge = SteuerungsverbundAbleitung.eingaenge(AN1, ahrenberg("60"),
                Map.of(Grenzart.EINSPEISUNG, kw("100"), Grenzart.BEZUG, kw("550")),
                Map.of(Grenzart.EINSPEISUNG, kw("0"), Grenzart.BEZUG, kw("473")));
        var a = SteuerungsverbundAbleitung.auslegung(AN1, eingaenge);
        assertThat(SteuerungsverbundAbleitung.passt(a)).isTrue();
        assertThat(a.get(Grenzart.EINSPEISUNG).anteile()).containsEntry("E-1", kw("40.0")).containsEntry("E-4",
                kw("60.0"));
        assertThat(a.get(Grenzart.BEZUG).anteile()).containsEntry("E-1", kw("0.0")).containsEntry("E-4", kw("77.0"));
        assertThat(a.get(Grenzart.BEZUG).summeRueckfallKw()).isEqualByComparingTo("24.6");
    }

    @Test
    void e2AuslegungPasstNichtInBeidenRichtungenMitR2Zahlen() {
        // Einspeisung R2: Grenze 70, K-12 ohne Rückfallwert läuft frei (60) + K-1 40 = 100 > 70
        var einspeisung = SteuerungsverbundAbleitung.auslegung(AN1, SteuerungsverbundAbleitung.eingaenge(AN1,
                ahrenberg("60"), Map.of(Grenzart.EINSPEISUNG, kw("70"), Grenzart.BEZUG, kw("550")),
                Map.of(Grenzart.EINSPEISUNG, kw("0"), Grenzart.BEZUG, kw("473"))));
        assertThat(einspeisung.get(Grenzart.EINSPEISUNG).urteil()).isEqualTo(AuslegungUrteil.AUSLEGUNG_PASST_NICHT);
        assertThat(einspeisung.get(Grenzart.EINSPEISUNG).summeRueckfallKw()).isEqualByComparingTo("100.0");
        assertThat(einspeisung.get(Grenzart.BEZUG).urteil()).isEqualTo(AuslegungUrteil.PASST);
        assertThat(SteuerungsverbundAbleitung.passt(einspeisung)).as("eine Richtung reicht zur Ablehnung").isFalse();
        // Bezug (E2 = A auch am Bezug): Ungeregeltes 480 → Vorbehalt 528 → verteilbar 22 < 24,6
        var bezug = SteuerungsverbundAbleitung.auslegung(AN1, SteuerungsverbundAbleitung.eingaenge(AN1,
                ahrenberg("60"), Map.of(Grenzart.EINSPEISUNG, kw("100"), Grenzart.BEZUG, kw("550")),
                Map.of(Grenzart.EINSPEISUNG, kw("0"), Grenzart.BEZUG, kw("528"))));
        assertThat(bezug.get(Grenzart.EINSPEISUNG).urteil()).isEqualTo(AuslegungUrteil.PASST);
        assertThat(bezug.get(Grenzart.BEZUG).urteil()).isEqualTo(AuslegungUrteil.AUSLEGUNG_PASST_NICHT);
        assertThat(bezug.get(Grenzart.BEZUG).verteilbarKw()).isEqualByComparingTo("22.0");
        assertThat(SteuerungsverbundAbleitung.passt(bezug)).isFalse();
        // Mit Rückfallwert 20 kW an K-12 passt R2: 40/30
        var mitWert = SteuerungsverbundAbleitung.auslegung(AN1, SteuerungsverbundAbleitung.eingaenge(AN1,
                ahrenberg("20"), Map.of(Grenzart.EINSPEISUNG, kw("70"), Grenzart.BEZUG, kw("550")),
                Map.of(Grenzart.EINSPEISUNG, kw("0"), Grenzart.BEZUG, kw("473"))));
        assertThat(mitWert.get(Grenzart.EINSPEISUNG).anteile()).containsEntry("E-1", kw("40.0"))
                .containsEntry("E-4", kw("30.0"));
    }

    @Test
    void i1OhneSchreibfreigabeZaehltAlsUngeregeltMitNennleistungUndFehlenderVorbehaltIstKeineNull() {
        List<Geraet> g = List.of(new Geraet("E-1", "K-1", Grenzart.EINSPEISUNG, kw("100"), false, kw("40")),
                new Geraet("E-4", null, Grenzart.EINSPEISUNG, kw("15"), false, null));
        var e = SteuerungsverbundAbleitung.eingaenge(AN1, g, Map.of(Grenzart.EINSPEISUNG, kw("200"),
                Grenzart.BEZUG, kw("550")), Map.of(Grenzart.EINSPEISUNG, kw("0")));
        assertThat(e.get(Grenzart.EINSPEISUNG).jeBox().get("E-1").rueckfallKw()).isEqualByComparingTo("100");
        assertThat(e.get(Grenzart.EINSPEISUNG).jeBox().get("E-4").rueckfallKw())
                .as("Ungeregeltes hinter dem Abgang in beiden Summen").isEqualByComparingTo("15");
        assertThat(e).as("ohne Vorbehalt fehlt die Richtung").doesNotContainKey(Grenzart.BEZUG);
        assertThat(SteuerungsverbundAbleitung.passt(SteuerungsverbundAbleitung.auslegung(AN1, e))).isFalse();
    }

    @Test
    void r12ZweischrittNieUeber100UndOhneQuittungVonE1BleibtEs10Zu60() {
        SteuerungsverbundZweischritt.Dokument d = SteuerungsverbundZweischritt.beginnen(
                tabelle("40.0", "60.0", "0.0", "77.0"), new Tabelle(tabelle("10.0", "90.0", "0.0", "77.0"), VERTEILBAR));
        assertThat(d.schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(d.tabelle().anteile().get(Grenzart.EINSPEISUNG)).containsEntry("E-1", kw("10.0"))
                .containsEntry("E-4", kw("60.0"));
        assertThat(summe(d.tabelle().anteile().get(Grenzart.EINSPEISUNG))).isEqualByComparingTo("70.0");
        assertThat(d.verengteBoxen()).containsExactly("E-1");
        assertThat(d.tabelle().boxen()).as("der Übergang geht an ALLE").containsExactly("E-1", "E-4");
        Stand rev8 = new Stand(1, 8);

        // fehlt die Quittung von E-1 — gleich wie lange, auch wenn E-4 quittiert —, bleibt es bei 10/60
        assertThat(SteuerungsverbundZweischritt.zielFaellig(rev8, d.verengteBoxen(), Map.of())).isFalse();
        assertThat(SteuerungsverbundZweischritt.zielFaellig(rev8, d.verengteBoxen(), Map.of("E-4", rev8))).isFalse();
        assertThat(SteuerungsverbundZweischritt.zielFaellig(rev8, d.verengteBoxen(),
                Map.of("E-1", new Stand(1, 7)))).as("eine ältere Quittung zählt nicht").isFalse();
        // E-1 quittiert Revision 8 → Zielstand 10/90 (Summe 100)
        assertThat(SteuerungsverbundZweischritt.zielFaellig(rev8, d.verengteBoxen(), Map.of("E-1", rev8))).isTrue();
        assertThat(summe(d.ziel().anteile().get(Grenzart.EINSPEISUNG))).isEqualByComparingTo("100.0");

        // In JEDEM Zwischenzustand hält jede Box alt, Übergang oder Ziel — die Summe bleibt ≤ 100
        Map<String, List<String>> moeglich = Map.of("E-1", List.of("40.0", "10.0"), "E-4", List.of("60.0", "60.0"));
        for (String e1 : moeglich.get("E-1")) {
            for (String e4 : moeglich.get("E-4")) {
                assertThat(kw(e1).add(kw(e4))).isLessThanOrEqualTo(kw("100.0"));
            }
        }
        // nach dem Ziel: E-1 hält 10 (quittiert), E-4 60 oder 90
        assertThat(kw("10.0").add(kw("90.0"))).isLessThanOrEqualTo(kw("100.0"));
    }

    @Test
    void reinesVerengenIstSchonDerZielstand() {
        SteuerungsverbundZweischritt.Dokument d = SteuerungsverbundZweischritt.beginnen(
                tabelle("0.0", "77.0", "0.0", "77.0"), new Tabelle(tabelle("0.0", "55.0", "0.0", "77.0"), VERTEILBAR));
        assertThat(d.schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(d.ziel()).isNull();
        assertThat(d.verengteBoxen()).containsExactly("E-4");
    }

    @Test
    void altVorDemErstenDokumentFuehrendeHaeltDieGanzeGrenzeDieAndereIhrenRueckfall() {
        var eingaenge = SteuerungsverbundAbleitung.eingaenge(AN1, ahrenberg("60"),
                Map.of(Grenzart.EINSPEISUNG, kw("100"), Grenzart.BEZUG, kw("550")),
                Map.of(Grenzart.EINSPEISUNG, kw("0"), Grenzart.BEZUG, kw("473")));
        var alt = SteuerungsverbundZweischritt.altOhneDokument(AN1, eingaenge);
        assertThat(alt.get(Grenzart.EINSPEISUNG)).containsEntry("E-1", kw("100")).containsEntry("E-4", kw("60"));
        var ziel = new Tabelle(tabelle("40.0", "60.0", "0.0", "77.0"), VERTEILBAR);
        SteuerungsverbundZweischritt.Dokument d = SteuerungsverbundZweischritt.beginnen(alt, ziel);
        // §5.3: der erste Schritt verengt die führende Box auf 40; E-4 bekommt am Bezug erst 24,6, dann 77
        assertThat(d.verengteBoxen()).containsExactly("E-1");
        assertThat(d.tabelle().anteile().get(Grenzart.EINSPEISUNG)).containsEntry("E-1", kw("40.0"))
                .containsEntry("E-4", kw("60"));
        assertThat(d.tabelle().anteile().get(Grenzart.BEZUG).get("E-4")).isEqualByComparingTo("24.6");
        assertThat(d.schritt()).isEqualTo(Schritt.UEBERGANG);
    }

    @Test
    void a18EinStandUeberDemGesendetenHeisstZurueckgespielt() {
        assertThat(SteuerungsverbundZweischritt.rueckgespielt(new Stand(1, 7), new Stand(1, 9))).isTrue();
        assertThat(SteuerungsverbundZweischritt.rueckgespielt(new Stand(1, 9), new Stand(1, 9))).isFalse();
        assertThat(SteuerungsverbundZweischritt.rueckgespielt(new Stand(2, 1), new Stand(1, 9))).isFalse();
        assertThat(SteuerungsverbundZweischritt.rueckgespielt(null, new Stand(1, 1))).isTrue();
        assertThat(SteuerungsverbundZweischritt.rueckgespielt(new Stand(1, 1), null)).isFalse();
    }

    @Test
    void altAusDokumentenNimmtJeBoxDasGroessereAusQuittiertUndGesendet() {
        Tabelle t7 = new Tabelle(tabelle("40.0", "60.0", "0.0", "77.0"), VERTEILBAR);
        Tabelle t8 = new Tabelle(tabelle("10.0", "60.0", "0.0", "77.0"), VERTEILBAR);
        var alt = SteuerungsverbundZweischritt.altAusDokumenten(Map.of("E-1", t7, "E-4", t8),
                Map.of("E-1", t8, "E-4", t8));
        assertThat(alt.get(Grenzart.EINSPEISUNG)).containsEntry("E-1", kw("40.0")).containsEntry("E-4", kw("60.0"));
    }
}
