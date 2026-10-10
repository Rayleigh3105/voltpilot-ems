package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Collection;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
     * Richtung, fehlt die Richtung — unbekannt ist keine Null. Ob eine fehlende Einspeiserichtung ausdrücklich
     * unbegrenzt ist, sagt {@link #unbegrenzt}, nicht diese Rechnung.
     */
    public static Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge(List<Mitglied> mitglieder,
            List<Geraet> geraete, Map<Grenzart, BigDecimal> grenze, Map<Grenzart, BigDecimal> vorbehalt) {
        return eingaenge(mitglieder, geraete, grenze, vorbehalt, Map.of());
    }

    /**
     * Wie {@link #eingaenge(List, List, Map, Map)}, dazu je Richtung der Übergangszuschlag für den Ausfall der führenden
     * Box ({@link SteuerungsverbundAnteile#uebergangszuschlag}); eine Richtung ohne Eintrag hat keinen (0).
     */
    public static Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge(List<Mitglied> mitglieder,
            List<Geraet> geraete, Map<Grenzart, BigDecimal> grenze, Map<Grenzart, BigDecimal> vorbehalt,
            Map<Grenzart, BigDecimal> uebergangszuschlag) {
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
            ergebnis.put(richtung, new SteuerungsverbundRegeln.Richtung(g, v, jeBox,
                    uebergangszuschlag.getOrDefault(richtung, BigDecimal.ZERO)));
        }
        return ergebnis;
    }

    /** Die Auslegung je Richtung — genau die Rechnung von {@link SteuerungsverbundAnteile#anteile} (NW-1). */
    public static Map<Grenzart, SteuerungsverbundAnteile.Auslegung> auslegung(List<Mitglied> mitglieder,
            Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge) {
        Map<Grenzart, SteuerungsverbundAnteile.Auslegung> ergebnis = new EnumMap<>(Grenzart.class);
        eingaenge.forEach((richtung, e) -> ergebnis.put(richtung, SteuerungsverbundAnteile.anteile(e.grenzeKw(),
                e.vorbehaltKw(), e.uebergangszuschlagKw(), mitglieder.stream().map(m -> new SteuerungsverbundAnteile.Mitglied(m.box(), m.rolle(),
                        e.jeBox().get(m.box()).nennKw(), e.jeBox().get(m.box()).rueckfallKw())).toList())));
        return ergebnis;
    }

    /** Die Komponenten-Typen eines Speichers — Einrichten (Frage 5) und die Rückfallzeit des Übergangszuschlags. */
    public static final Set<String> SPEICHER_TYPEN = Set.of("battery-hybrid", "user-defined-battery");

    /**
     * Steuerbare Bezugs-Geräte AUSSERHALB des Ladepark-Rahmens der Box (AP-15 Folge von IP-19, V3): Schalter/Relais,
     * SG-Ready, Wärmepumpen, Heizstäbe, Pumpen. Ladepunkte ({@code ev-charger}, eine Wallbox in {@code wallboxes[]})
     * rechnet die Box schon im Ladebudget; Speicher ({@code guards/bezuganteil.go}) und Erzeuger haben ihren eigenen Weg.
     */
    public static final Set<String> VERBRAUCHER_AUSSERHALB_LADEPARK = Set.of("heating-rod", "heat-pump-sgready",
            "pump", "generic-load", "modbus-load");

    /**
     * Zählt eine Komponente vom Typ {@code typ} zur Reserve? {@code imLadepark} = die Wallbox reist in
     * {@code wallboxes[]} (sie hat ein Verbraucher-Profil, {@code ChargingConfigRepository#wallboxes}) — dann rechnet sie
     * das Ladebudget, eine Wallbox ohne es (go-e außerhalb) steuert die Box wie jeden anderen Verbraucher.
     */
    public static boolean zaehltZurReserve(String typ, boolean imLadepark) {
        return typ != null && (VERBRAUCHER_AUSSERHALB_LADEPARK.contains(typ) || "wallbox".equals(typ) && !imLadepark);
    }

    /**
     * Die Reserve der anderen steuerbaren Verbraucher je Box ({@code reserve_verbraucher.bezug} im Anteils-Dokument,
     * AP-15 Folge von IP-19, V3): die Summe der Nennleistungen ihrer Bezugs-Geräte MIT Schreibfreigabe, deren
     * Komponente in {@code zurReserve} steht ({@link #zaehltZurReserve}) — aufgerundet auf 0,1 kW, die sichere Seite
     * (sie senkt auf der Box nur). Jedes Mitglied steht im Ergebnis, ohne solche Geräte mit 0,0.
     *
     * <p><b>Kein Doppelzählen:</b> ein solches Gerät steckt nicht im Vorbehalt (der deckt, was KEINE Box steuert; die
     * Verbund-Bilanz zieht den Beitrag jeder Box ab), sondern zählt einmal — im Anteil seiner Box, über ihre
     * Nennleistung und ihren Rückfall ({@link #eingaenge}). Die Reserve teilt diesen einen Anteil auf der Box nur auf:
     * Ladepark = Anteil − Reserve. Geräte ohne Schreibfreigabe und das Ungeregelte hinter dem Abgang zählen nicht.
     */
    public static Map<String, BigDecimal> reserveVerbraucher(List<Mitglied> mitglieder, List<Geraet> geraete,
            Collection<String> zurReserve) {
        Map<String, BigDecimal> summe = new LinkedHashMap<>();
        mitglieder.forEach(m -> summe.put(m.box(), BigDecimal.ZERO));
        for (Geraet g : geraete) {
            if (g.richtung() == Grenzart.BEZUG && g.schreibfreigabe() && g.komponente() != null
                    && zurReserve.contains(g.komponente()) && summe.containsKey(g.box())) {
                summe.merge(g.box(), g.nennKw(), BigDecimal::add);
            }
        }
        summe.replaceAll((box, kw) -> kw.setScale(1, RoundingMode.CEILING));
        return summe;
    }

    /**
     * Der erklärte Höchstwert des Ungeregelten hinter dem Abgang je mitsteuernder Box
     * ({@code ungeregelt_hinter_abgang.bezug} im Anteils-Dokument, AP-15 Folge von IP-19, B3): die Summe der
     * Nennleistungen bzw. Höchstwerte ihrer UNGEREGELTEN Bezugs-Geräte — der Eintrag ohne Komponente (die Erklärung
     * {@code ungeregelt}) und jedes Gerät ohne Schreibfreigabe (I1), genau das, was {@link #eingaenge} ohne Rückfall in
     * ihren Anteil zählt —, aufgerundet auf 0,1 kW (die sichere Seite: die Box zieht ihn nur blind ab und senkt damit
     * nur). Nur Boxen, die nicht führen, und nur mit einem Wert über 0 stehen im Ergebnis; fehlt eine Box, reist das
     * Feld nicht und ihr Dokument bleibt Byte für Byte wie vorher.
     *
     * <p><b>Warum die Box ihn braucht:</b> mit frischem Wert ihres Zählers misst die mitsteuernde Box alles hinter ihrem
     * Abgang selbst und hält ihren Anteil dort ({@code lastmgmt/bezuganteil.go}); ohne Messung (Neustart, Ausfall des
     * Zählers) kennt sie nur diesen Höchstwert. Er steckt nicht im Vorbehalt (B3), sondern einmal im Anteil der Box.
     */
    public static Map<String, BigDecimal> ungeregeltHinterAbgang(List<Mitglied> mitglieder, List<Geraet> geraete) {
        Map<String, BigDecimal> summe = new LinkedHashMap<>();
        mitglieder.stream().filter(m -> m.rolle() != Rolle.FUEHRT).forEach(m -> summe.put(m.box(), BigDecimal.ZERO));
        for (Geraet g : geraete) {
            if (g.richtung() == Grenzart.BEZUG && !(g.schreibfreigabe() && g.komponente() != null)
                    && summe.containsKey(g.box())) {
                summe.merge(g.box(), g.nennKw(), BigDecimal::add);
            }
        }
        summe.replaceAll((box, kw) -> kw.setScale(1, RoundingMode.CEILING));
        summe.values().removeIf(kw -> kw.signum() <= 0);
        return summe;
    }

    /** Scharf nur mit {@code passt} in BEIDEN Richtungen (E2 = A); eine fehlende Richtung passt nicht. */
    public static boolean passt(Map<Grenzart, SteuerungsverbundAnteile.Auslegung> auslegung) {
        return passt(auslegung, Set.of());
    }

    /**
     * Wie {@link #passt(Map)}, nur darf eine Richtung aus {@code unbegrenzt} fehlen (AP-15 Folge, Captain 23.09.2026:
     * „Einspeisung unbegrenzt — nur der Bezug wird aufgeteilt“). {@code unbegrenzt} kommt allein aus der ausdrücklichen
     * Angabe „keine Einspeisegrenze“ ({@link GrenzeAufloesung.Wirksam#einspeisungKeine}); eine nur fehlende Grenze steht
     * nicht darin und passt weiter nicht. Eine gerechnete Richtung muss passen, auch wenn sie in {@code unbegrenzt} steht.
     */
    public static boolean passt(Map<Grenzart, SteuerungsverbundAnteile.Auslegung> auslegung,
            Set<Grenzart> unbegrenzt) {
        return SteuerungsverbundAnteile.RICHTUNGEN.stream().allMatch(r -> auslegung.get(r) == null
                ? unbegrenzt.contains(r) : auslegung.get(r).ablehnung() == null);
    }

    /**
     * Sind die Eingänge vollständig — jede Richtung gerechnet oder ausdrücklich {@code unbegrenzt}? Die Naht von IP-5
     * ({@code auslegungFuer}): unvollständig = {@code auslegung_passt_nicht}.
     */
    public static boolean vollstaendig(Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge,
            Set<Grenzart> unbegrenzt) {
        return SteuerungsverbundAnteile.RICHTUNGEN.stream().allMatch(r -> eingaenge.containsKey(r)
                || unbegrenzt.contains(r));
    }

    /**
     * Die ausdrücklich unbegrenzten Richtungen am Tag: nur die Einspeisung, und nur, wenn die wirksame Grenze keine Zahl
     * hat UND das Grenzblatt ausdrücklich „keine Einspeisegrenze“ trägt (I1). Für diese Richtung gibt es keinen Anteil,
     * keinen Wächter und im Anteils-Dokument keine Einspeiseseite.
     */
    public static Set<Grenzart> unbegrenzt(GrenzeAufloesung.Wirksam wirksam) {
        return wirksam != null && wirksam.einspeisungKw() == null && wirksam.einspeisungKeine()
                ? Set.of(Grenzart.EINSPEISUNG) : Set.of();
    }
}
