package com.voltpilot.api.uems;

import com.voltpilot.api.uems.RechteAbleitung.Aktion;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import com.voltpilot.api.uems.RechteAbleitung.Zelle;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import com.voltpilot.api.zugriff.RechtPruefung;
import java.time.Instant;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Rechte der Korrektur-Routen (UEMS AP-08 IP-15, Entscheid E8) — die ERSTE Stelle, an der die
 * API die Rechte-Matrix durchsetzt. Sie baut nichts nach: das Urteil fällt
 * {@link RechteAbleitung#darf} bzw. {@link RechteAbleitung#korrekturEntscheiden}, dieselbe Regel
 * wie das Portal und die Vektoren ({@code rechte-vectors.json}, Familien {@code darf} und
 * {@code vieraugen}). Hier steht nur, wer der Aufrufer HEUTE ist und welche Zeilen gelten.
 *
 * <h2>Der Aufrufer, bis AP-03 Zuweisungen bringt</h2>
 *
 * Es gibt zwei Prinzipale ({@link ProtokollAkteur}); beide werden zu einem {@link Benutzer} mit
 * genau einer Zuweisung:
 * <ul>
 *   <li>Kundenbenutzer → Kundenadministrator, unternehmensweit (AP-03 E12) — dasselbe Wort, das
 *       sein Protokolleintrag trägt.</li>
 *   <li>Plattform-Admin mit gewähltem Kundenbereich ({@code X-Tenant-Id}) → ein VoltPilot-Konto mit
 *       wirksamer Unterstützung, Art {@code voltpilot}, Umfang „Einrichten und Bedienen“ (AP-03 E8:
 *       „Admin-Zugriff wird Unterstützung“). Der größte Umfang ist Absicht: die Korrektur-Zeilen
 *       tragen für den Unterstützer „-“, er wird darum abgewiesen, WEIL er Unterstützer ist, nicht
 *       weil ihm ein Umfang fehlt. Im Protokoll bleibt er {@code voltpilot_betrieb} (unverändert).</li>
 * </ul>
 * Das Ziel ist das Unternehmen: die heutigen Rollen gelten unternehmensweit, und ein Bearbeiter je
 * Standort (Zelle S) wäre damit abgewiesen, nicht zugelassen — bis Zuweisungen je Standort
 * existieren, schließt die Stelle, statt zu raten. Die Kundenadministratoren kennt die API noch
 * nicht; der Satz einer Ablehnung nennt darum keinen Weg.
 *
 * <h2>Die Zeilen</h2>
 *
 * {@link #MATRIX} trägt die fünf Zeilen, die die Korrektur betreffen, als Daten — Zelle für Zelle
 * gleich {@code docs/contracts/v2/rechte-matrix.json} ({@code KorrekturRechteTest}); die Matrix-Datei
 * liegt nicht im Jar. Wer eine Zelle ändert, ändert die Datei, erzeugt die Tabelle neu und
 * zieht diese Stelle nach.
 */
public final class KorrekturRechte {

    public static final String ERSATZWERT_ERFASSEN = "ersatzwert.erfassen";
    public static final String KORREKTUR_ERFASSEN = "korrektur.erfassen";
    public static final String KORREKTUR_FREIGEBEN = RechteAbleitung.KORREKTUR_FREIGEBEN;
    public static final String KORREKTUR_ZURUECKNEHMEN = RechteAbleitung.KORREKTUR_ZURUECKNEHMEN;
    public static final String VIERAUGEN_EINSTELLEN = "vieraugen.einstellen";

    /** Die fünf Zeilen der Rechte-Matrix, die AP-08 IP-15 nennt. */
    public static final Matrix MATRIX = matrix();

    private static final Instant IMMER = Instant.EPOCH;

    private KorrekturRechte() {
    }

    /** Der heutige Aufrufer als Benutzer der Rechte-Ableitung. */
    public static Benutzer benutzer(ProtokollAkteur wer) {
        boolean voltpilot = ProtokollAkteur.ART_VOLTPILOT.equals(wer.art());
        Zuweisung z = voltpilot
                ? new Zuweisung(Rolle.UNTERSTUETZER, null, Umfang.EINRICHTEN_UND_BEDIENEN, RechteAbleitung.Art.VOLTPILOT,
                        IMMER, null, null)
                : new Zuweisung(Rolle.KUNDENADMINISTRATOR, null, null, null, IMMER, null, null);
        return new Benutzer(wer.sub(), wer.name(), voltpilot ? Konto.PLATTFORM : Konto.BENUTZER, KontoZustand.AKTIV,
                List.of(z));
    }

    /**
     * Der Aufrufer, seit AP-03 IP-6: die Zuweisungen aus dem Zugriff-Kontext ({@link RechtPruefung#aufrufer};
     * seit IP-9 auch die BEENDETEN, die nichts freigeben und nur die Ablehnung benennen) —
     * ohne Kontext und am Plattform-Umschalter bleibt es bei {@link #benutzer} (W3, bis IP-8). Das Ziel bleibt das
     * Unternehmen: ein Bearbeiter je Standort wird abgewiesen, bis die Korrektur ihren Standort nennt.
     */
    public static Benutzer aufrufer(ProtokollAkteur wer) {
        return RechtPruefung.aufrufer().orElseGet(() -> benutzer(wer));
    }

    /** darf(aufrufer, aktion, Unternehmen) — für Aktionen ohne Vier-Augen-Bedingung. */
    public static DarfErgebnis darf(ProtokollAkteur wer, String aktion, Instant jetzt) {
        return RechteAbleitung.darf(MATRIX, aufrufer(wer), kundenbereich(), aktion, Ziel.unternehmen(), jetzt);
    }

    /**
     * Freigeben oder zurücknehmen: {@code ersteller} ist das Subject der Fassung 1 ({@code null} bei
     * einem System-Vorschlag), {@code vierAugen} die Einstellung in DIESEM Augenblick.
     */
    public static DarfErgebnis entscheiden(ProtokollAkteur wer, String aktion, String ersteller, boolean vierAugen,
            Instant jetzt) {
        return RechteAbleitung.korrekturEntscheiden(MATRIX, aufrufer(wer), kundenbereich(), aktion,
                Ziel.unternehmen(), jetzt, ersteller, vierAugen);
    }

    private static Kundenbereich kundenbereich() {
        return new Kundenbereich("Kundenbereich", List.of(), List.of());
    }

    private static Matrix matrix() {
        Map<String, Aktion> m = new LinkedHashMap<>();
        zeile(m, KORREKTUR_ERFASSEN, "Korrektur / Ersatzwert erfassen (versioniert, begründet)", "U", "U", "S");
        zeile(m, ERSATZWERT_ERFASSEN, "Ersatzwert erfassen / zurücknehmen", "U", "U", "S");
        zeile(m, KORREKTUR_FREIGEBEN, "Korrektur prüfen und freigeben", "U", "U", "S");
        zeile(m, KORREKTUR_ZURUECKNEHMEN, "Korrektur zurücknehmen (widerrufen)", "U", "U", "S");
        zeile(m, VIERAUGEN_EINSTELLEN, "Vier-Augen-Einstellung ändern", "U", "-", "-");
        return new Matrix(Map.copyOf(m));
    }

    /** Bedienberechtigt, Leser, Unterstützer, VoltPilot-Betrieb und Einsicht tragen in allen fünf Zeilen „-“. */
    private static void zeile(Map<String, Aktion> m, String kennung, String kundenwort, String ka, String em,
            String be) {
        Map<Rolle, Zelle> z = new EnumMap<>(Rolle.class);
        z.put(Rolle.KUNDENADMINISTRATOR, Zelle.vonCode(ka));
        z.put(Rolle.ENERGIEMANAGER, Zelle.vonCode(em));
        z.put(Rolle.BEARBEITER, Zelle.vonCode(be));
        z.put(Rolle.BEDIENBERECHTIGT, Zelle.NEIN);
        z.put(Rolle.LESER, Zelle.NEIN);
        z.put(Rolle.UNTERSTUETZER, Zelle.NEIN);
        z.put(Rolle.VOLTPILOT_BETRIEB, Zelle.NEIN);
        z.put(Rolle.EINSICHT, Zelle.NEIN);
        m.put(kennung, new Aktion(kennung, kundenwort, Map.copyOf(z)));
    }
}
