package com.voltpilot.api.uems;

import com.voltpilot.api.uems.RechteAbleitung.Aktion;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zelle;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import java.time.Instant;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Rechte der Berichts-Routen (UEMS AP-12 IP-7, E12 G1–G3) — nach {@link KorrekturRechte} und {@link KennzahlRechte}
 * die dritte Stelle, an der die API die Rechte-Matrix durchsetzt. Sie baut nichts nach: welche Kennung eine Handlung an
 * einem Bericht braucht, sagt {@link BerichtRegeln#kennung} (G1), das Urteil spricht {@link RechteAbleitung#darf} (G2),
 * die Teilansicht {@link BerichtRegeln#teilansicht} (G3) — dieselben Regeln wie die Vektoren ({@code bericht-vectors.json},
 * Familie {@code rechte}) und der TS-Zwilling.
 *
 * <p><b>Ein Bericht ist ein Datenabfluss an Dritte</b> (W-R4): fremder Standort 404, fehlendes Recht 403, der Unterstützer
 * bekommt weder Entwurf noch Stand. Die Ablehnungen liegen ausschließlich an den Berichts-Routen.
 *
 * <p><b>Der Aufrufer</b> kommt aus {@link KennzahlAufrufer} — der EINEN Naht, die AP-03 gegen echte Zuweisungen tauscht; bis
 * dahin Kundenbenutzer = Kundenadministrator unternehmensweit, Plattform-Admin = VoltPilot-Unterstützung. Die Standorte des
 * Kundenbereichs sind seine Standort-IDs.
 *
 * <p>{@link #MATRIX} trägt die fünf Berichts-Zeilen und {@code messwerte.ansehen} (für G3) als Daten, Zelle für Zelle gleich
 * {@code docs/contracts/v2/rechte-matrix.json} ({@code BerichtRechteTest}); die Matrix-Datei liegt nicht im Jar.
 */
public final class BerichtRechte {

    public static final String STANDORT_ABRUFEN = "bericht.standort_abrufen";
    public static final String STANDORT_FREIGEBEN = "bericht.standort_freigeben";
    public static final String UNTERNEHMEN = "bericht.unternehmen";
    public static final String EXPORT_STANDORT = "export.standort";
    public static final String EXPORT_UNTERNEHMEN = "export.unternehmen";
    public static final String ANSEHEN = BerichtRegeln.TEILANSICHT_RECHT;

    /** Die Handlungen der Routen dieses Pakets (G1: Anlegen und Archivieren folgen dem Freigabe-Recht). */
    public static final String ABRUFEN = "abrufen";
    /** Der Berichts-CSV eines Stands (IP-10): {@code export.standort} bzw. {@code export.unternehmen}. */
    public static final String CSV = "csv";
    public static final String ANLEGEN = "anlegen";
    public static final String FREIGEBEN = "freigeben";
    public static final String VERWERFEN = "verwerfen";
    public static final String ARCHIVIEREN = "archivieren";

    public static final Matrix MATRIX = matrix();

    private BerichtRechte() {
    }

    /**
     * darf(aufrufer, Handlung, Bericht dieser Geltung): {@code standort} ist die Standort-ID eines Standort-Berichts,
     * am Unternehmens-Bericht {@code null}.
     */
    public static DarfErgebnis darf(Benutzer wer, Kundenbereich k, String handlung, String geltungArt, String standort,
            Instant jetzt) {
        Ziel ziel = BerichtRegeln.STANDORT.equals(geltungArt) ? Ziel.standort(standort) : Ziel.unternehmen();
        return RechteAbleitung.darf(MATRIX, wer, k, BerichtRegeln.kennung(handlung, geltungArt), ziel, jetzt);
    }

    /** G3 — die Standortnamen einer Teilansicht in der Folge des Kundenbereichs; {@code null} = unternehmensweit. */
    public static List<String> teilansicht(Benutzer wer, Kundenbereich k, Instant jetzt) {
        return BerichtRegeln.teilansicht(MATRIX, wer, k, jetzt);
    }

    private static Matrix matrix() {
        Map<String, Aktion> m = new LinkedHashMap<>();
        zeile(m, STANDORT_ABRUFEN, "Standort-Bericht abrufen (Entwurf, PDF/CSV auf Abruf)", "U", "U", "S", "S", "S", "-", "-");
        zeile(m, STANDORT_FREIGEBEN, "Standort-Bericht freigeben (Berichtsstand)", "U", "U", "S", "-", "-", "-", "-");
        zeile(m, UNTERNEHMEN, "Unternehmens-Bericht abrufen / freigeben", "U", "U", "-", "-", "-", "-", "-");
        zeile(m, EXPORT_STANDORT, "Export je Standort (CSV: Messwerte, Kennzahlen)", "U", "U", "S", "S", "S", "-", "-");
        zeile(m, EXPORT_UNTERNEHMEN, "Unternehmens-Export (alle Standorte)", "U", "U", "-", "-", "-", "-", "-");
        zeile(m, ANSEHEN, "Messwerte, Zeitreihen, Datenqualität ansehen", "U", "U", "S", "S", "S", "A", "-");
        return new Matrix(Map.copyOf(m));
    }

    private static void zeile(Map<String, Aktion> m, String kennung, String kundenwort, String... zellen) {
        Map<Rolle, Zelle> z = new EnumMap<>(Rolle.class);
        Rolle[] rollen = {Rolle.KUNDENADMINISTRATOR, Rolle.ENERGIEMANAGER, Rolle.BEARBEITER, Rolle.BEDIENBERECHTIGT,
            Rolle.LESER, Rolle.UNTERSTUETZER, Rolle.VOLTPILOT_BETRIEB};
        for (int i = 0; i < rollen.length; i++) {
            z.put(rollen[i], Zelle.vonCode(zellen[i]));
        }
        m.put(kennung, new Aktion(kennung, kundenwort, Map.copyOf(z)));
    }
}
