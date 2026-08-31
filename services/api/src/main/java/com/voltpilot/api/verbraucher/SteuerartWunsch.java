package com.voltpilot.api.verbraucher;

import java.math.BigDecimal;

/**
 * Der GEWUENSCHTE Steuerart-Satz eines Verbrauchers - die Eingabe des
 * Steuerart-Dialogs (Konzept {@code vp-verbrauchsmgmt-konzept-v1} §3.2, Paket
 * P2).
 *
 * <p><b>⚠ Er ist die SPIEGELFORM von {@link Steuerart}, und das ist Absicht.</b>
 * Was der Kunde waehlt und was die Zeile danach zeigt, sind dieselben Felder -
 * nur {@code herkunft} fehlt (die entscheidet der Server, nie der Aufrufer).
 * Dadurch ist der Rundlauf pruefbar: {@code projiziere(dokument(wunsch))} muss
 * denselben Satz zurueckgeben. Ein Feld, das dieser Wunsch nicht traegt, kann
 * die Steuerart auch nicht setzen.
 *
 * <p><b>⚠ Jedes Feld ist NULLABLE, und {@code null} heisst „dazu sagt der Kunde
 * nichts" - dann gilt die VORGABE aus {@link SteuerartSatz}, nie eine 0.</b>
 * Der Dialog schickt genau die Antworten, die er wirklich gestellt hat.
 *
 * <p><b>⚠ {@code ueberschussModus}/{@code mindestleistungKw} beschreiben die
 * Quellen-Bahn der BOX</b> ({@code charging-config.charge_points[].source} /
 * {@code .min_kw}) und gelten deshalb NUR an einem Ladepunkt. An jedem anderen
 * Verbraucher gibt es diese Bahn nicht - dort werden sie ignoriert, statt eine
 * Zusage ueber einen Schreibweg zu machen, den es fuer ihn nicht gibt.
 *
 * @param quelle               eine Quelle aus {@link SteuerartSatz#quellenFuer}
 * @param schwelleKw           Quelle {@code ueberschuss}: ab wie viel Ueberschuss
 * @param preisgrenzeCtKwh     Quelle {@code guenstig}: die Preisgrenze
 * @param mindestlaufzeitMinuten Quelle {@code ueberschuss}/{@code freigabe_*}:
 *                             die Mindestlaufzeit ({@code min_on_seconds} des
 *                             Profils, kein Dokument-Feld)
 * @param sperrzeitMinuten     Quelle {@code freigabe_*}: die Sperrzeit danach
 *                             ({@code min_off_seconds} des Profils)
 * @param fenster              Quelle {@code feste_zeiten}: das eine Fenster
 * @param ziel                 {@code null}, {@code bis_uhrzeit} oder
 *                             {@code laufzeit_bis}
 * @param zielFenster          die Frist; {@code von} darf fehlen (dann gilt
 *                             {@link SteuerartSatz#ZIEL_FENSTER_STUNDEN})
 * @param zielEnergieKwh       Ziel {@code bis_uhrzeit}: die Menge
 * @param zielLaufzeitMinuten  Ziel {@code laufzeit_bis}: die Laufzeit
 * @param zielAmStueck         {@code true} = am Stueck, {@code false} =
 *                             aufteilbar, {@code null} = nicht gefragt
 * @param ueberschussModus     Ladepunkt + Quelle {@code ueberschuss}:
 *                             {@code pausieren} (nur Sonnenstrom) oder
 *                             {@code mindestleistung} (Sonne zuerst);
 *                             {@code null} = die Vorgabe „pausieren"
 * @param mindestleistungKw    Ladepunkt + {@code mindestleistung}: ab welcher
 *                             Leistung er ueberhaupt anfaengt; {@code null} =
 *                             die Box behaelt ihre eigene Zahl, nie eine 0
 */
public record SteuerartWunsch(String quelle, BigDecimal schwelleKw,
        BigDecimal preisgrenzeCtKwh, Integer mindestlaufzeitMinuten, Integer sperrzeitMinuten,
        Steuerart.Fenster fenster, String ziel, Steuerart.Fenster zielFenster,
        BigDecimal zielEnergieKwh, Integer zielLaufzeitMinuten, Boolean zielAmStueck,
        String ueberschussModus, BigDecimal mindestleistungKw) {

    /** Die schmale Form „nur diese Quelle, keine Antwort auf eine Folgefrage". */
    public static SteuerartWunsch von(String quelle) {
        return new SteuerartWunsch(quelle, null, null, null, null, null, null, null, null, null,
                null, null, null);
    }
}
