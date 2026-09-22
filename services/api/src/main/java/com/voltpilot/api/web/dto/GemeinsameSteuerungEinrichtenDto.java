package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * „Einrichten in sechs Fragen“ (UEMS AP-15, Konzept §5.2; Vertrag {@code docs/contracts/v2/steuerungsverbund.md} §6a):
 * die Antwort von {@code GET …/gemeinsame-steuerung/einrichten} — was der Bestand vorschlägt (Fragen 1–5), was
 * erklärt ist, und das Ergebnis (Frage 6). Wörter sind Codes, keine Kundensätze; IP-23 übersetzt sie.
 */
public final class GemeinsameSteuerungEinrichtenDto {

    private GemeinsameSteuerungEinrichtenDto() {}

    /**
     * @param eingerichtet        hat die Anlage eine Gemeinsame Steuerung — ohne: nur der Vorschlag aus dem Bestand,
     *                            nichts wird geschrieben (I6)
     * @param netzzaehlerBoxId    Frage 2: die Box, die heute den Netzzähler liest (Anlagen-Rolle {@code grid-meter}),
     *                            leer = keine
     * @param grenzen             Frage 3: die wirksamen Grenzen heute ({@code AnlageGrenzen}, W1), leer = unbekannt
     * @param boxen               Frage 1 und 5: jede Box der Anlage mit dem, was sie liest und steuern darf
     * @param ungesteuerteErzeuger Frage 4: {@code "keine"}, die Liste — oder leer: nicht erklärt (unbekannt ist keine
     *                            Null)
     * @param vorbehalt           Frage 4: der Vorbehalt je Richtung mit Herkunft und dem Vorschlag aus den Messwerten
     *                            (IP-13) — leer ohne Gemeinsame Steuerung
     * @param ergebnis            Frage 6: Anteile je Box und Richtung und das Urteil der Auslegung — leer ohne
     * @param hinweise            Abweichungen und Lücken, keine Ablehnung
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einrichten(boolean eingerichtet, UUID netzzaehlerBoxId, Grenzen grenzen, List<Box> boxen,
            Object ungesteuerteErzeuger, Vorbehalt vorbehalt, Ergebnis ergebnis, List<Hinweis> hinweise) {}

    /**
     * Antwort von {@code POST …/einrichten/vorschau}: Frage 6 für einen ENTWURF — {@code einrichten} wie
     * {@code GET …/einrichten}, {@code zustand} wie {@code GET …/gemeinsame-steuerung}, beides als wäre der Entwurf
     * gespeichert. Geschrieben ist nichts.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschau(Einrichten einrichten, GemeinsameSteuerungDto.Zustand zustand) {}

    /** Die wirksamen Grenzen am Netzanschluss; eine leere Richtung ist unbekannt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Grenzen(BigDecimal einspeisungKw, BigDecimal bezugKw) {}

    /**
     * Eine Box der Anlage. {@code rolle}/{@code messpunktId} nur als wirksames Mitglied; {@code komponenten} = was sie
     * heute liest (Bestand); {@code geraete}/{@code ungeregelt} = was für sie erklärt ist (leer, solange nichts
     * erklärt ist — dann {@code geraeteErklaert = false}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Box(UUID boxId, String name, String rolle, UUID messpunktId, boolean liestNetzzaehler,
            List<Komponente> komponenten, boolean geraeteErklaert, List<Geraet> geraete,
            List<Ungeregelt> ungeregelt) {}

    /**
     * Eine Komponente, die die Box heute liest. {@code schreibfreigabe} aus dem Bestand (die Box schreibt an sie);
     * {@code richtungen} der Vorschlag nach Typ; {@code nennKw} soweit der Bestand sie kennt (PV-Leistung,
     * Verbraucher-Profil), sonst leer — der Kunde trägt sie ein.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Komponente(UUID komponenteId, String name, String typ, boolean schreibfreigabe,
            List<String> richtungen, BigDecimal nennKw) {}

    /**
     * Ein erklärtes Gerät hinter dem Abgang der Box. {@code schreibfreigabe} kommt aus dem Bestand; ohne sie zählt das
     * Gerät als ungeregelt mit Nennleistung (I1). Der Rückfall (IP-6): Wort, kW und Herkunft ({@code am_geraet} ·
     * {@code katalog} · {@code ohne_angabe}) — nur mit Schreibfreigabe, sonst leer.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Geraet(UUID komponenteId, String richtung, BigDecimal nennKw, boolean schreibfreigabe,
            String rueckfall, BigDecimal rueckfallKw, String rueckfallHerkunft) {}

    /** Das Ungeregelte hinter dem Abgang der Box (B3): Richtung und Höchstwert. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ungeregelt(String richtung, BigDecimal hoechstwertKw) {}

    /** Ein Erzeuger hinter dem Netzanschluss, den keine Box steuert (Frage 4). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Erzeuger(String bezeichnung, BigDecimal nennKw) {}

    /**
     * Der Vorbehalt: Einspeisung = Summe der ungesteuerten Erzeuger (immer {@code erklaert}); Bezug erklärt oder
     * gemessen (B4, IP-13) mit wer/wann; {@code ausMesswerten} = was IP-13 heute aus den Messwerten rechnet (leer ohne
     * Messtag).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorbehalt(BigDecimal einspeisungKw, BigDecimal bezugKw, String bezugHerkunft, String von,
            OffsetDateTime am, AusMesswerten ausMesswerten) {}

    /** Der Wert aus den Messwerten (IP-13): Höchstwert × 1,1 und woraus er kommt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AusMesswerten(BigDecimal kw, BigDecimal hoechstwertKw, OffsetDateTime hoechstwertVon, int messtage,
            LocalDate zeitraumVon, LocalDate zeitraumBis) {}

    /** Frage 6: je Richtung die Auslegung; eine Richtung ist leer, solange sie nicht rechenbar ist. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ergebnis(Auslegung einspeisung, Auslegung bezug) {}

    /**
     * Die Auslegung einer Richtung — genau die Rechnung von {@code SteuerungsverbundAnteile} (NW-1).
     * {@code uebergangszuschlagKw}: der Puffer für den Ausfall der führenden Box (0,0 ohne Speicher dort);
     * {@code uebergangszuschlagFehltKw}: was davon über den Rückfällen keinen Platz fand (nur bei {@code passt}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Auslegung(String urteil, BigDecimal grenzeKw, BigDecimal vorbehaltKw, BigDecimal verteilbarKw,
            BigDecimal summeRueckfallKw, List<Anteil> anteile, BigDecimal ungenutztKw, BigDecimal uebergangszuschlagKw,
            BigDecimal uebergangszuschlagFehltKw) {}

    /** Der Anteil einer Box. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anteil(UUID boxId, BigDecimal kw) {}

    /**
     * Ein Hinweis, keine Ablehnung: {@code wort} ({@code nennleistung_weicht_ab} · {@code ohne_schreibfreigabe} ·
     * {@code geraete_nicht_erklaert} · {@code geraet_nicht_erklaert} · {@code erzeuger_nicht_erklaert} ·
     * {@code vorbehalt_nicht_erklaert} · {@code netzzaehler_nicht_gelesen}) mit Box, Komponente, Richtung und den
     * beiden Zahlen, wo er daran hängt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Hinweis(String wort, UUID boxId, UUID komponenteId, String richtung, BigDecimal bestandKw,
            BigDecimal erklaertKw) {}

    /**
     * Eine Rückfall-Angabe am Gerät (IP-6): Richtung, Wort ({@code haelt_letzten_wert} · {@code faellt_auf_wert} ·
     * {@code laeuft_frei} · {@code unbekannt}), kW nur bei {@code faellt_auf_wert}, nach wie vielen Sekunden, wer/wann;
     * {@code aufgehobenAm} gesetzt = nicht mehr wirksam.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RueckfallAngabe(UUID id, String richtung, String rueckfall, BigDecimal rueckfallKw, Integer nachS,
            String hinweis, String eingetragenVon, OffsetDateTime eingetragenAm, OffsetDateTime aufgehobenAm) {}

    /** Eine Lücke der Erklärung (422 {@code erklaerung_unvollstaendig}). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Luecke(String wort, UUID boxId, UUID komponenteId) {}
}
