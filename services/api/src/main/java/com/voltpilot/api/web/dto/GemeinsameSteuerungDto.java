package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Gemeinsame Steuerung einer Anlage (UEMS AP-15 IP-5; Vertrag {@code docs/contracts/v2/steuerungsverbund.md} §6).
 * Wörter sind die des Vokabulars {@code SteuerungsverbundVokabular} — Codes, keine Kundensätze; die Kundenfläche
 * (IP-23/IP-24) übersetzt sie.
 */
public final class GemeinsameSteuerungDto {

    private GemeinsameSteuerungDto() {}

    /**
     * Der Zustand. Ohne Gemeinsame Steuerung: {@code eingerichtet = false}, {@code zustand = nicht_eingerichtet}, alle
     * anderen Felder leer — die Anlage merkt nichts (I6). {@code zustand} ist die Stufe ({@code erklaert} …
     * {@code anteile_aktiv}, {@code angehalten}) oder {@code aufgeloest} (keine wirksamen Mitglieder mehr).
     *
     * @param fehlt           was zum {@code naechsterSchritt} fehlt — je Bedingung ein Wort des Ablehnungs-Vokabulars
     * @param warnungFuehrung Z1/W2 — nur OHNE Gemeinsame Steuerung: führende Box und Speicher-Box fallen auseinander
     * @param bilanz          die Verbund-Bilanz (IP-12) — {@code null}, solange kein Tag gerechnet ist
     * @param vorbehalt       der Vorbehalt je Richtung mit Herkunft und offenem Vorschlag (IP-13) — {@code null} ohne
     *                        Gemeinsame Steuerung
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zustand(boolean eingerichtet, String zustand, String stufe, Long epoche, UUID netzanschlussId,
            List<Mitglied> mitglieder, String naechsterSchritt, List<Befund> fehlt, WarnungFuehrung warnungFuehrung,
            Bilanz bilanz, Vorbehalt vorbehalt) {}

    /**
     * Der Vorbehalt (IP-13, B4): je Richtung Zahl und Herkunft, dazu ein offener Vorschlag zum Senken. Die
     * Einspeiseseite ist heute immer {@code erklaert}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorbehalt(VorbehaltRichtung einspeisung, VorbehaltRichtung bezug, VorbehaltVorschlag vorschlag) {}

    /**
     * Eine Richtung: {@code kw} leer = unbekannt (keine Null); {@code herkunft} {@code erklaert} · {@code gemessen};
     * {@code seit} wann der Wert gilt; {@code zweischritt} nur bei {@code gemessen}: was der Zweischritt danach tat
     * ({@code veroeffentlicht}, {@code auslegung_passt_nicht}, … — Wörter von {@code SteuerungsverbundAnteilDienst.Grund}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VorbehaltRichtung(BigDecimal kw, String herkunft, OffsetDateTime seit, String zweischritt) {}

    /** Ein offener Vorschlag zum Senken: Zahl, Herkunft (Höchstwert, Viertelstunde, Zeitraum, Messtage), seit wann. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VorbehaltVorschlag(String richtung, BigDecimal altKw, BigDecimal neuKw, BigDecimal hoechstwertKw,
            OffsetDateTime hoechstwertVon, LocalDate zeitraumVon, LocalDate zeitraumBis, int messtage,
            OffsetDateTime erstelltAm) {}

    /**
     * Die Verbund-Bilanz (IP-12, A17): {@code zustand} des jüngsten gerechneten Tages ({@code plausibel} ·
     * {@code unplausibel} · {@code unbekannt}), {@code seit} dem ersten Tag, an dem sie ununterbrochen so steht,
     * {@code grund} nur bei {@code unbekannt} (Vokabular {@code VerbundBilanzRegel.Grund}), {@code gerechnetAm} wann.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bilanz(String zustand, LocalDate tag, LocalDate seit, String grund, OffsetDateTime gerechnetAm) {}

    /** Ein wirksames Mitglied: Box, Rolle ({@code fuehrt} · {@code steuert_mit}), Messpunkt (Datenquelle, wahlfrei). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Mitglied(UUID boxId, String rolle, UUID messpunktId, OffsetDateTime gueltigAb,
            OffsetDateTime bestaetigtAm) {}

    /** Ein Grund aus dem Ablehnungs-Vokabular; {@code boxId} bzw. {@code richtung} nur, wo er daran hängt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Befund(String wort, UUID boxId, String richtung) {}

    /**
     * Z1 (W2): die Anlage hat keine Gemeinsame Steuerung, und ihre führende Box ist nicht die Box des Speichers —
     * Flows gehen an die eine, der Fahrplan an die andere. Wort {@code fuehrende_box_ist_nicht_speicher_box}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record WarnungFuehrung(String wort, UUID fuehrendeBoxId, UUID speicherBoxId) {}

    /** Ein gewünschtes Mitglied aus {@code PUT {"mitglieder": […]}} — Mandant und Anlage kommen nie aus dem Körper. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MitgliedWunsch(UUID boxId, String rolle, UUID messpunktId) {}
}
