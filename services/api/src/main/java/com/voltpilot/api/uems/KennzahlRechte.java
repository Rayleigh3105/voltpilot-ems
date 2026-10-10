package com.voltpilot.api.uems;

import com.voltpilot.api.uems.RechteAbleitung.Aktion;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.uems.RechteAbleitung.Zelle;
import java.time.Instant;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Die Rechte der Kennzahl-Routen (UEMS AP-11 IP-5, E10, G1) — nach {@link KorrekturRechte} die zweite Stelle,
 * an der die API die Rechte-Matrix durchsetzt. Sie baut nichts nach: das Urteil fällt
 * {@link RechteAbleitung#darf}; welche Kennung gilt, sagt {@link KennzahlRegeln#geltung} aus dem
 * Geltungsbereich (Standort · Gebäude · Bereich · Messstelle → {@code kennzahl.standort_definieren} am
 * Standort des Objekts; Unternehmen · Prozess · Kostenstelle → {@code kennzahl.unternehmen_definieren}).
 *
 * <p><b>Durchgesetzt wird das Definieren</b> (Anlegen, Vorschau, Fassung, Stammdaten, Archivieren, Löschen).
 * Das Ansehen trägt die Kennung {@code messwerte.ansehen} als Vertrag; die Sichtbarkeit R-A1 ∧ R-A6 je Person
 * setzt der Geltungsbereich-Prüfpunkt durch (AP-03 IP-11, Report AP-11 §8.3).
 *
 * <p><b>Der Aufrufer</b> kommt aus {@link KennzahlAufrufer}: bis AP-03 IP-2 Zuweisungen bringt, derselbe wie
 * bei der Korrektur — Kundenbenutzer = Kundenadministrator unternehmensweit, Plattform-Admin = VoltPilot-
 * Unterstützung (die Kennzahl-Zeilen tragen für den Unterstützer „-“). Die Standorte des Kundenbereichs sind
 * seine Standort-IDs; die Kundenadministratoren kennt die API noch nicht, ein 403 nennt darum keinen Weg.
 *
 * <p>{@link #MATRIX} trägt die drei Zeilen als Daten, Zelle für Zelle gleich
 * {@code docs/contracts/v2/rechte-matrix.json} ({@code KennzahlSchnittstelleVertragTest}).
 */
public final class KennzahlRechte {

    public static final String STANDORT_DEFINIEREN = "kennzahl.standort_definieren";
    public static final String UNTERNEHMEN_DEFINIEREN = "kennzahl.unternehmen_definieren";
    public static final String ANSEHEN = KennzahlRegeln.ANSEHEN;

    public static final Matrix MATRIX = matrix();

    private KennzahlRechte() {
    }

    /**
     * darf(aufrufer, kennung, Ziel): {@code standort} ist die Standort-ID des Rechte-Geltungsbereichs, {@code null}
     * für das Unternehmen.
     */
    public static DarfErgebnis darf(Benutzer wer, Kundenbereich k, String kennung, String standort, Instant jetzt) {
        Ziel ziel = standort == null ? Ziel.unternehmen() : Ziel.standort(standort);
        return RechteAbleitung.darf(MATRIX, wer, k, kennung, ziel, jetzt);
    }

    private static Matrix matrix() {
        Map<String, Aktion> m = new LinkedHashMap<>();
        zeile(m, STANDORT_DEFINIEREN, "Kennzahl definieren — Geltungsbereich Standort", "U", "U", "S", "-", "-", "-", "-",
                "-");
        zeile(m, UNTERNEHMEN_DEFINIEREN, "Kennzahl definieren — Geltungsbereich Unternehmen", "U", "U", "-", "-", "-",
                "-", "-", "-");
        zeile(m, ANSEHEN, "Messwerte, Zeitreihen, Datenqualität ansehen", "U", "U", "S", "S", "S", "A", "-", "U");
        return new Matrix(Map.copyOf(m));
    }

    private static void zeile(Map<String, Aktion> m, String kennung, String kundenwort, String... zellen) {
        Map<Rolle, Zelle> z = new EnumMap<>(Rolle.class);
        Rolle[] rollen = {Rolle.KUNDENADMINISTRATOR, Rolle.ENERGIEMANAGER, Rolle.BEARBEITER, Rolle.BEDIENBERECHTIGT,
            Rolle.LESER, Rolle.UNTERSTUETZER, Rolle.VOLTPILOT_BETRIEB, Rolle.EINSICHT};
        for (int i = 0; i < rollen.length; i++) {
            z.put(rollen[i], Zelle.vonCode(zellen[i]));
        }
        m.put(kennung, new Aktion(kennung, kundenwort, Map.copyOf(z)));
    }
}
