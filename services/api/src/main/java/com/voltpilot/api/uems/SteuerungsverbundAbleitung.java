package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import java.math.BigDecimal;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Eingänge der Anteile (UEMS AP-15 IP-7, G3/G4, I1, E2 = A): aus Mitgliedern, Geräten je Box, Grenze und Vorbehalt
 * je Richtung genau das, was {@link SteuerungsverbundRegeln#pruefen} und {@link SteuerungsverbundAnteile#anteile}
 * erwarten. Die Rechnung selbst bleibt dort (NW-1); hier wird nur summiert.
 *
 * <p>Je Box und Richtung meinen {@code nennKw} und {@code rueckfallKw} dieselbe Menge hinter ihrem Abgang (Vertrag
 * §1): ein freigegebenes Gerät zählt mit Nennleistung und seinem Rückfall aus IP-6 ({@code unbekannt} = Nennleistung),
 * ein Gerät OHNE Schreibfreigabe zählt als ungeregelt mit der Nennleistung in BEIDEN Summen (I1), ebenso das
 * Ungeregelte hinter dem Abgang (Komponente leer, sein Höchstwert). Eine Box ohne Gerät in einer Richtung steht dort
 * mit 0/0. Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class SteuerungsverbundAbleitung {

    private SteuerungsverbundAbleitung() {}

    /** Ein Mitglied: Box und Rolle. */
    public record Mitglied(String box, Rolle rolle) {}

    /**
     * Ein Gerät hinter dem Abgang einer Box in EINER Richtung. {@code komponente} leer = das Ungeregelte hinter dem
     * Abgang (nie freigegeben). {@code rueckfallKw} = der Rückfall aus IP-6 ({@link GeraeteRueckfallRegel.Rueckfall#kw});
     * er zählt nur mit Schreibfreigabe.
     */
    public record Geraet(String box, String komponente, Grenzart richtung, BigDecimal nennKw, boolean schreibfreigabe,
            BigDecimal rueckfallKw) {}

    /**
     * Je Richtung der Eingang von {@link SteuerungsverbundRegeln#pruefen}. Fehlt die Grenze oder der Vorbehalt einer
     * Richtung, fehlt die Richtung — unbekannt ist keine Null.
     */
    public static Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge(List<Mitglied> mitglieder,
            List<Geraet> geraete, Map<Grenzart, BigDecimal> grenze, Map<Grenzart, BigDecimal> vorbehalt) {
        Map<Grenzart, SteuerungsverbundRegeln.Richtung> ergebnis = new EnumMap<>(Grenzart.class);
        for (Grenzart richtung : SteuerungsverbundAnteile.RICHTUNGEN) {
            BigDecimal g = grenze.get(richtung);
            BigDecimal v = vorbehalt.get(richtung);
            if (g == null || v == null) {
                continue;
            }
            Map<String, BigDecimal[]> summe = new LinkedHashMap<>();
            for (Mitglied m : mitglieder) {
                summe.put(m.box(), new BigDecimal[] {BigDecimal.ZERO, BigDecimal.ZERO});
            }
            for (Geraet geraet : geraete) {
                if (geraet.richtung() != richtung) {
                    continue;
                }
                BigDecimal[] s = summe.get(geraet.box());
                if (s == null) {
                    throw new IllegalArgumentException("Gerät an einer Box außerhalb des Verbunds: " + geraet.box());
                }
                boolean geregelt = geraet.schreibfreigabe() && geraet.komponente() != null;
                BigDecimal rueckfall = geregelt ? geraet.rueckfallKw() : geraet.nennKw();
                if (rueckfall == null) {
                    throw new IllegalArgumentException("Rückfall fehlt: " + geraet.komponente());
                }
                s[0] = s[0].add(geraet.nennKw());
                s[1] = s[1].add(rueckfall.min(geraet.nennKw()));
            }
            Map<String, SteuerungsverbundRegeln.Leistung> jeBox = new LinkedHashMap<>();
            summe.forEach((box, s) -> jeBox.put(box, new SteuerungsverbundRegeln.Leistung(s[0], s[1])));
            ergebnis.put(richtung, new SteuerungsverbundRegeln.Richtung(g, v, jeBox));
        }
        return ergebnis;
    }

    /** Die Auslegung je Richtung — genau die Rechnung von {@link SteuerungsverbundAnteile#anteile} (NW-1). */
    public static Map<Grenzart, SteuerungsverbundAnteile.Auslegung> auslegung(List<Mitglied> mitglieder,
            Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge) {
        Map<Grenzart, SteuerungsverbundAnteile.Auslegung> ergebnis = new EnumMap<>(Grenzart.class);
        eingaenge.forEach((richtung, e) -> ergebnis.put(richtung, SteuerungsverbundAnteile.anteile(e.grenzeKw(),
                e.vorbehaltKw(), mitglieder.stream().map(m -> new SteuerungsverbundAnteile.Mitglied(m.box(), m.rolle(),
                        e.jeBox().get(m.box()).nennKw(), e.jeBox().get(m.box()).rueckfallKw())).toList())));
        return ergebnis;
    }

    /** Scharf nur mit {@code passt} in BEIDEN Richtungen (E2 = A); eine fehlende Richtung passt nicht. */
    public static boolean passt(Map<Grenzart, SteuerungsverbundAnteile.Auslegung> auslegung) {
        return SteuerungsverbundAnteile.RICHTUNGEN.stream().allMatch(r -> auslegung.get(r) != null
                && auslegung.get(r).ablehnung() == null);
    }
}
