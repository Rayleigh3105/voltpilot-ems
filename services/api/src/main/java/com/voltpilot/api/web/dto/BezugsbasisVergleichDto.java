package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Die Form von {@code GET /api/v1/kennzahlen/{id}/vergleich} (UEMS AP-17 IP-19, U1–U6, E7 = A, E8 = A). Vertrag:
 * {@code docs/contracts/v2/bezugsbasis.md} §16 „Vergleich“. Nur Lesen — gerechnet wird in
 * {@code BezugsbasisRegeln}; Zahlen sind ungerundete Dezimaltexte, Prozent mit einer Stelle (M5).
 */
public final class BezugsbasisVergleichDto {
    private BezugsbasisVergleichDto() {}

    /**
     * Der Vergleich einer Kennzahl gegen ihre Bezugsbasis über die Monate {@code von} … {@code bis}.
     *
     * @param bezugsbasis {@code null}, wenn die Kennzahl keine hat (dann trägt jeder Monat {@code basis_fehlt})
     * @param satz nur ohne Bezugsbasis: der Leer-Satz (§10 „Leer“)
     * @param staende die Leistungsvergleichs-Stände dieser Kennzahl (S5) — heute immer leer (Leser IP-21b)
     * @param standSatz „Stand Nr. n vom TT.MM.JJJJ“ bzw. „ungesichert — noch kein Stand“
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Vergleich(KennzahlDto.WerteKennzahl kennzahl, Basis bezugsbasis, String von, String bis,
            String zeitzone, List<Monat> monate, Zeitraum zeitraum, List<Stand> staende, String standSatz, String satz) {}

    /** Die gelesene Bezugsbasis; {@code beendet_zum}/{@code beendet_grund} nur an einer beendeten. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Basis(UUID id, String kennzeichen, LocalDate beendetZum, String beendetGrund) {}

    /**
     * Ein Monat: {@code roh} und {@code bereinigt} getrennt (U1) — die rohe Veränderung trägt nie ein Urteil (VG3).
     *
     * @param periode {@code JJJJ-MM}
     * @param satz der Kundensatz des Monats (§10, U6: keine Ursache)
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Monat(String periode, String beschriftung, Roh roh, Bereinigt bereinigt, String satz) {}

    /**
     * Die rohe Veränderung zum Vormonat: gemessen gegen gemessen, die Variable 1 (der Nenner) daneben; {@code urteil} ist
     * immer {@code ohne_urteil} (U1, Operation {@code roh}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Roh(String gemessen, String vorher, String deltaProzent, String richtung, String variableDeltaProzent,
            String urteil) {}

    /**
     * Der bereinigte Vergleich gegen die Fassung, die am LETZTEN Tag des Monats gilt (P4) — das Ergebnis der Operation
     * {@code vergleich}, dazu gemessen mit Version und die Bedingung mit Fassung (U4).
     *
     * @param fassung {@code null} bei {@code basis_fehlt}/{@code basis_beendet}
     * @param bedingung je Variable der Fassung ihr Wert — leer ohne Fassung
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Bereinigt(Fassung fassung, Gemessen gemessen, List<Bedingung> bedingung, String erwartet,
            String deltaProzent, String bandProzent, String richtung, String urteil, String grund,
            List<String> kennzeichen) {}

    /** Die gelesene Fassung (freigegeben) mit Methode und Referenzperiode (U4). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Fassung(int fassung, String methode, String referenzperiode, String datenlage, LocalDate giltAb,
            LocalDate giltBis) {}

    /** Der gespeicherte Kennzahl-Zähler des Monats (die Energie) mit Version; {@code wert} {@code null} = keiner. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Gemessen(String wert, String einheit, Integer version, String zustand) {}

    /**
     * Eine Variable der Bedingung: eine Bezugsgröße mit ihrer wirksamen Fassung ({@code quelle} {@code bezugsgroesse}),
     * oder — ohne Bezugsgröße als Variable 1 (Stammdatum-Nenner, Zusammenfassung) — der gespeicherte Nenner der Kennzahl
     * mit ihrer Version ({@code quelle} {@code kennzahl}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Bedingung(int position, String quelle, String kennzeichen, String name, String wert, String einheit,
            Integer fassung, Integer version, String zustand) {}

    /**
     * Der Zeitraum (U5): Σ gemessen ÷ Σ erwartet gegen die Fassung am letzten Tag von {@code bis} (P4) — nie ein Mittel.
     *
     * @param monate „x von y“
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Zeitraum(Integer fassung, String gemessen, String erwartet, String deltaProzent, String bandProzent,
            String richtung, String urteil, String grund, String monate, List<String> kennzeichen, String satz) {}

    /** Ein Leistungsvergleichs-Stand (S5). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Stand(int nummer, LocalDate am) {}
}
