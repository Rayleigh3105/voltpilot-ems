package com.voltpilot.api.components;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Die REINEN Regeln des Zählerbaums (Konzept {@code vp-zaehlerbaum-konzept},
 * Captain-Entscheide E1-E5 vom 10.11.2026, alle A; Prosa in
 * {@code docs/contracts/v2/zaehlerbaum.md} §2, R6): darf eine Komponente an
 * dieser Eltern-Komponente hängen?
 *
 * <p>Ohne Spring, ohne Repository (dem Muster von {@code MessstelleRegeln}
 * folgend) - jede Regel ist ohne einen einzigen Container prüfbar. Der
 * Zwilling im Portal ist {@code frontend/portal/src/zaehlerbaum.ts}; beide
 * fahren dieselben Vektoren ({@code docs/contracts/v2/zaehlerbaum-vectors.json}).
 * <b>Wer eine Regel ändert, ändert beide Seiten und die Vektor-Datei.</b>
 *
 * <p>{@link ZaehlerbaumService} löst Anlage, Rolle/Typ der Eltern-Komponente
 * und den bestehenden Baum aus der Datenbank auf und ruft
 * {@link #haengtAnPruefen} mit den schon aufgelösten Werten - diese Klasse
 * selbst stellt keine einzige Frage an eine Datenbank.
 */
public final class ZaehlerbaumRegeln {

    /** Die Rolle des Netzanschlusses ({@code ComponentService.ROLE_NETZ}) - hängt nie irgendwo. */
    public static final String ROLLE_NETZ = "grid-meter";

    /** Der Entitätstyp eines Unterzählers ({@code ComponentDefaults.TYPE_SUB_METER}) - ein Zähler, kein Netzanschluss. */
    public static final String TYP_UNTERZAEHLER = "sub-meter";

    /** Die Rolle eines gemessenen Verbrauchers ({@code ComponentService.ROLE_CONSUMER}) - dasselbe Wort in beiden Vokabularen. */
    public static final String ROLLE_VERBRAUCHER = "consumer";

    private ZaehlerbaumRegeln() {}

    /** Eine Komponente, wie sie heute im Baum hängt (für den Zyklus-Test). */
    public record Zuordnung(String komponenteId, String haengtAn) {}

    /** Die Eltern-Komponente, die geprüft wird. {@code null} = die Wurzel (kein Eltern). */
    public record ElternKandidat(String id, String anlage, String rolle, String entityType) {}

    public record HaengtAnUrteil(boolean gueltig, String grund, List<String> kette) {
        private static final HaengtAnUrteil GUELTIG = new HaengtAnUrteil(true, null, List.of());

        static HaengtAnUrteil ungueltig(String grund) {
            return new HaengtAnUrteil(false, grund, List.of());
        }

        static HaengtAnUrteil zyklus(List<String> kette) {
            return new HaengtAnUrteil(false, "zyklus", kette);
        }
    }

    /**
     * Darf {@code komponenteId} (Rolle {@code eigeneRolle}, Anlage
     * {@code eigeneAnlage}) an {@code eltern} hängen? Reihenfolge (Vertrag R6):
     * {@code wurzel_haengt_nirgends} → {@code selbst} → {@code fremde_anlage} →
     * {@code eltern_kein_zaehler} → {@code zyklus}. {@code eltern = null} (die
     * Wurzel) ist immer gültig - das ist die Vorgabe des Berichts: was nicht
     * ausdrücklich woanders hängt, hängt an der Wurzel.
     *
     * @param baum der heute aktive Baum der Anlage (jede Komponente mit einer
     *     eigenen Zeile), für den Zyklus-Test; eine Komponente ohne Zeile hängt
     *     an der Wurzel
     */
    public static HaengtAnUrteil haengtAnPruefen(String komponenteId, String eigeneAnlage,
            String eigeneRolle, ElternKandidat eltern, List<Zuordnung> baum) {
        if (eltern == null) {
            return HaengtAnUrteil.GUELTIG;
        }
        if (ROLLE_NETZ.equals(eigeneRolle)) {
            return HaengtAnUrteil.ungueltig("wurzel_haengt_nirgends");
        }
        if (eltern.id().equals(komponenteId)) {
            return HaengtAnUrteil.ungueltig("selbst");
        }
        if (!eltern.anlage().equals(eigeneAnlage)) {
            return HaengtAnUrteil.ungueltig("fremde_anlage");
        }
        boolean elternIstZaehler = ROLLE_NETZ.equals(eltern.rolle())
                || TYP_UNTERZAEHLER.equals(eltern.entityType());
        if (!elternIstZaehler) {
            return HaengtAnUrteil.ungueltig("eltern_kein_zaehler");
        }
        List<String> kette = new ArrayList<>(List.of(komponenteId));
        Set<String> gesehen = new HashSet<>();
        for (String cur = eltern.id(); cur != null && gesehen.add(cur); ) {
            kette.add(cur);
            if (cur.equals(komponenteId)) {
                return HaengtAnUrteil.zyklus(List.copyOf(kette));
            }
            cur = haengtAnVon(baum, cur);
        }
        return HaengtAnUrteil.GUELTIG;
    }

    private static String haengtAnVon(List<Zuordnung> baum, String komponenteId) {
        for (Zuordnung z : baum) {
            if (z.komponenteId().equals(komponenteId)) {
                return z.haengtAn();
            }
        }
        return null;
    }

    /** Eine Komponente, wie viel {@link #effektiveEltern} über sie wissen muss. */
    public record EffektiveElternEingabe(String haengtAn, String rolle) {}

    /**
     * Die EFFEKTIVE Eltern-Komponente (Vertrag §1, Vorgabe: „was nicht
     * ausdrücklich woanders hängt, hängt an der Wurzel") - das gesetzte
     * {@code haengtAn}, wenn es eins gibt; sonst, für einen gemessenen
     * Verbraucher (Unterzähler oder ein Verbraucher mit eigener Messung), der
     * Netzanschluss der Anlage. Gibt es keinen Netzanschluss, bleibt es bei
     * {@code null} - die heutige flache Anzeige. Erzeugung und Speicher hängen
     * nach R4 immer an der Wurzel selbst und werden hier nie umgehängt (ihre
     * Rolle ist nie {@link #ROLLE_VERBRAUCHER}).
     *
     * <p>Schreibt NICHTS fest - keine Migration liest diese Methode; sie
     * entscheidet nur, was eine Anzeige für eine Komponente OHNE eigene Zeile
     * in {@code komponente_haengt_an} zeigen soll.
     */
    public static String effektiveEltern(EffektiveElternEingabe komponente, String netzanschlussId) {
        if (komponente.haengtAn() != null) {
            return komponente.haengtAn();
        }
        if (!ROLLE_VERBRAUCHER.equals(komponente.rolle())) {
            return null;
        }
        return netzanschlussId;
    }
}
