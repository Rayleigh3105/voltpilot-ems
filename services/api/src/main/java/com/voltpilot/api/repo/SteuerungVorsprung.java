package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * DER VORSPRUNG MIT BESTAND FÜR DAS VORSPRUNG-BUDGET (NS-2 A, Captain-Entscheid
 * 15.10.2026, Untersuchung {@code vp-herzogau-nie-schlechter-k5} §7, Bauplan
 * NS-P2). Der Optimierer hält Monat und letzte 7 Tage mit Bestand - die beiden
 * Zahlen der Kachel (HZ-3 A) - nie tiefer als das Budget unter dem sturen
 * Speicher. Dazu braucht er sie beim Einlesen; er liest die Datenbank direkt,
 * deshalb legt {@code SteuerungVorsprungLaeufer} je Anlage einen {@link Stand}
 * in der Tabelle {@code steuerung_vorsprung} ab (Vertrag
 * {@code docs/contracts/steuerung-vorsprung-v1.md}).
 *
 * <p>Die Regeln:
 * <ol>
 *   <li><b>Dieselben Zahlen wie die Kachel.</b> Monat und 7 Tage kommen aus
 *       {@link SteuerungMitBestand#zeitraum} über DENSELBEN Walk
 *       ({@link EarningsRepository#vorsprungStaende}); gegen die faire
 *       Messlatte aus NS-1 A, mit Bestand symmetrisch bewertet.</li>
 *   <li><b>Das 7-Tage-Fenster schließt den laufenden Tag ein</b> ({@code D-6}
 *       bis {@code D}): die Kachel zeigt, solange D läuft, die 7 Tage davor -
 *       morgen aber genau dieses Fenster. Was der Plan heute tut, kann nur
 *       noch dieses Fenster bewegen.</li>
 *   <li><b>Der Stand gehört zum jüngsten gemessenen Tag</b>: ohne Eimer an
 *       {@code D} gibt es für D keinen Stand (der Läufer fragt kurz nach
 *       Mitternacht den Vortag). So verankert der Optimierer einen
 *       Monatswechsel selbst, statt einen Monat ohne Tag zu lesen.</li>
 *   <li><b>Die 6 abgeschlossenen Tage {@code D-6..D-1}</b> stehen einzeln
 *       daneben, ältester zuerst: an jeder Mitternacht des Plan-Horizonts
 *       fällt der älteste heraus. Ein Tag ohne Messung zählt 0 (er fehlt auch
 *       in der Summe), ein Tag mit Lücke ist {@code null}.</li>
 *   <li><b>Fehlende Daten = kein Budget.</b> Eine Lücke im Monat oder im
 *       Fenster lässt die Summe leer ({@code null}, wie auf der Kachel); fehlen
 *       Vorsprung, Bewertung oder Kapazität, gibt es gar keinen Stand.</li>
 * </ol>
 *
 * <p>Fälle: {@code SteuerungVorsprungTest}, rein und Docker-frei.
 */
public final class SteuerungVorsprung {

    /** So viele abgeschlossene Tage stehen einzeln im Stand ({@code D-6..D-1}). */
    public static final int ABGESCHLOSSENE_TAGE = SteuerungMitBestand.FENSTER_TAGE - 1;

    private SteuerungVorsprung() {
    }

    /**
     * Der Vorsprung mit Bestand einer Anlage am Ende des letzten gemessenen
     * Eimers des Tages {@code tag}.
     *
     * @param tag der Berliner Tag D
     * @param messungBis Ende des letzten gemessenen Eimers - der Moment von
     *     {@code vorsprungKwh}
     * @param bewertungCtKwh Bezugspreis × √0,92
     * @param vorsprungKwh gemessener Ladestand − Vergleichsspeicher, Rückstand negativ
     * @param kapazitaetKwh kWh je 100 % des Vergleichsspeichers
     * @param monatMitBestandEur Σ der Tage vom Monatsersten bis D; null bei einer Lücke
     * @param siebenTageMitBestandEur Σ der Tage D-6..D; null bei einer Lücke
     * @param tageMitBestandEur D-6..D-1, ältester zuerst; ungemessen 0, Lücke null
     */
    public record Stand(
            LocalDate tag,
            Instant messungBis,
            BigDecimal bewertungCtKwh,
            BigDecimal vorsprungKwh,
            BigDecimal kapazitaetKwh,
            BigDecimal monatMitBestandEur,
            BigDecimal siebenTageMitBestandEur,
            List<BigDecimal> tageMitBestandEur) {
    }

    /**
     * Der Stand zum Tag {@code tag} aus seinem {@link SteuerungMitBestand.Zeitraum}
     * mit abgeschlossenem 7-Tage-Fenster ({@code laeuft = false}, also
     * {@code D-6..D}); null, wenn D keinen gemessenen Eimer mit Ladestand hat
     * oder Bewertung bzw. Kapazität fehlen.
     */
    public static Stand stand(SteuerungMitBestand.Zeitraum zeitraum, LocalDate tag,
            Double kapazitaetKwh) {
        if (zeitraum == null || zeitraum.heute() == null || zeitraum.bewertungCtKwh() == null
                || kapazitaetKwh == null || !(kapazitaetKwh > 0.0)) {
            return null;
        }
        SteuerungMitBestand.Bewertet heute = zeitraum.heute();
        if (!heute.tag().equals(tag) || heute.vorsprungEndeKwh() == null
                || heute.messungBis() == null) {
            return null;
        }
        Map<LocalDate, SteuerungMitBestand.Bewertet> fenster = new HashMap<>();
        for (SteuerungMitBestand.Bewertet t : zeitraum.tage()) {
            fenster.put(t.tag(), t);
        }
        List<BigDecimal> tage = new ArrayList<>(ABGESCHLOSSENE_TAGE);
        for (int vor = ABGESCHLOSSENE_TAGE; vor >= 1; vor--) {
            SteuerungMitBestand.Bewertet t = fenster.get(tag.minusDays(vor));
            tage.add(t == null ? BigDecimal.ZERO.setScale(2) : t.mitBestandEur());
        }
        return new Stand(tag, heute.messungBis(), zeitraum.bewertungCtKwh(),
                heute.vorsprungEndeKwh(),
                BigDecimal.valueOf(kapazitaetKwh).setScale(3, RoundingMode.HALF_UP),
                zeitraum.monat() == null ? null : zeitraum.monat().mitBestandEur(),
                zeitraum.sieben() == null ? null : zeitraum.sieben().mitBestandEur(),
                Collections.unmodifiableList(tage));
    }
}
