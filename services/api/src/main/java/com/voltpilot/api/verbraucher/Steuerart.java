package com.voltpilot.api.verbraucher;

import java.math.BigDecimal;

/**
 * Die STEUERART einer Komponente: genau EINE Quelle, hoechstens EIN Ziel
 * (Konzept {@code vp-verbrauchsmgmt-konzept-v1} §3, Captain-Entscheid
 * „Kombination = eine Quelle + optionales Ziel").
 *
 * <p><b>Sie ist eine PROJEKTION, nie ein zweites Datenformat.</b> Was hier
 * steht, wird aus der aktiven {@code consumer_policy} bzw. aus der
 * Quellen-Wahl der Box abgeleitet ({@link SteuerartProjektion}); geschrieben
 * wird weiterhin ausschliesslich Policy und {@code charging-config}. Deshalb
 * traegt dieser Satz Werte, aber keine Ids der Maschine.
 *
 * <p>Jedes Feld ist NULLABLE, und {@code null} heisst „diese Steuerart kennt
 * diesen Wert nicht" - nie eine 0. Die Ids sind stabil, die WOERTER gehoeren
 * dem Portal (Kundendeutsch wohnt dort, nicht hier).
 *
 * @param quelle         {@link SteuerartProjektion#QUELLE_SOFORT} …
 *                       {@link SteuerartProjektion#QUELLE_EIGENE_REGEL}
 * @param herkunft       woher die Projektion sie hat:
 *                       {@link SteuerartProjektion#HERKUNFT_POLICY} (eigene
 *                       Policy), {@link SteuerartProjektion#HERKUNFT_STANDARD}
 *                       (der Anlagen-Standard der Ladepunkte) oder
 *                       {@link SteuerartProjektion#HERKUNFT_OHNE} (es gibt
 *                       keine Policy - „laeuft, wie das Geraet es tut")
 * @param schwelleKw     Quelle {@code ueberschuss}: ab wie viel Ueberschuss
 * @param preisgrenzeCtKwh Quelle {@code guenstig}: die Preisgrenze
 * @param ueberschussModus Ladepunkt-Ueberschuss:
 *                       {@link SteuerartProjektion#MODUS_PAUSIEREN} oder
 *                       {@link SteuerartProjektion#MODUS_MINDESTLEISTUNG}
 * @param mindestleistungKw die Mindestleistung, die dabei gehalten wird
 * @param fenster        Quelle {@code feste_zeiten}: das wiederkehrende Fenster
 * @param ziel           {@code null}, {@link SteuerartProjektion#ZIEL_BIS_UHRZEIT}
 *                       oder {@link SteuerartProjektion#ZIEL_LAUFZEIT_BIS}
 * @param zielFenster    die Frist des Ziels (dessen {@code recurrence})
 * @param zielEnergieKwh wie viel bis dahin mindestens geflossen sein muss
 * @param zielLaufzeitMinuten wie lange bis dahin mindestens gelaufen sein muss
 * @param zielAmStueck   {@code true} = am Stueck, {@code false} = aufteilbar,
 *                       {@code null} = das Dokument sagt dazu nichts
 */
public record Steuerart(String quelle, String herkunft, BigDecimal schwelleKw,
        BigDecimal preisgrenzeCtKwh, String ueberschussModus, BigDecimal mindestleistungKw,
        Fenster fenster, String ziel, Fenster zielFenster, BigDecimal zielEnergieKwh,
        Integer zielLaufzeitMinuten, Boolean zielAmStueck) {

    /** Ein wiederkehrendes Fenster in der Zeitzone der Anlage. */
    public record Fenster(String tage, String von, String bis) {}

    /** Die schmale Form ohne Ziel und ohne Parameter. */
    public static Steuerart quelleOnly(String quelle, String herkunft) {
        return new Steuerart(quelle, herkunft, null, null, null, null, null, null, null, null,
                null, null);
    }

    /** Dieselbe Quelle, aber mit dem Ziel {@code andere} - fuer Regel 8. */
    public Steuerart mitZiel(Steuerart ziel) {
        return new Steuerart(quelle, herkunft, schwelleKw, preisgrenzeCtKwh, ueberschussModus,
                mindestleistungKw, fenster, ziel.ziel(), ziel.zielFenster(), ziel.zielEnergieKwh(),
                ziel.zielLaufzeitMinuten(), ziel.zielAmStueck());
    }

    /** Dieselbe Steuerart, aber mit einer anderen Herkunft. */
    public Steuerart mitHerkunft(String neu) {
        return new Steuerart(quelle, neu, schwelleKw, preisgrenzeCtKwh, ueberschussModus,
                mindestleistungKw, fenster, ziel, zielFenster, zielEnergieKwh, zielLaufzeitMinuten,
                zielAmStueck);
    }
}
