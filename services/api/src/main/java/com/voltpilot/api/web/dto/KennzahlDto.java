package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Formen der Kennzahl-Schnittstelle (UEMS AP-11 IP-5, {@code /api/v1/kennzahlen}).
 *
 * <p>snake_case wie der Kennzahl-Vertrag ({@code docs/contracts/v2/kennzahl.md}); die Wörter (Rechenform,
 * Geltungsbereich-Art, Eingangs-Rolle und -Art, Periodenart) sind seine Vokabulare. Beträge reisen als
 * DEZIMALTEXT. Ein Eingang wird über das Kennzeichen seines Objekts genannt (MS-12, BZ-6, KZ-0001) — gespeichert
 * wird der Verweis auf das Objekt, eine spätere Umbenennung ändert die Berechnung nicht.
 */
public final class KennzahlDto {
    private KennzahlDto() {}

    /** Ein Eingang der Anfrage: {@code rolle} zaehler · nenner · paar, {@code art} messstelle · bezugsgroesse · kennzahl. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eingang(String rolle, String art, String kennzeichen) {}

    /**
     * {@code POST /api/v1/kennzahlen} und {@code POST …/vorschau}: Stammdaten, Geltungsbereich und die Berechnung
     * der Fassung 1. Ohne {@code kennzeichen} vergibt der Server KZ-0001 …; ohne {@code verantwortlich_name} ist der
     * Aufrufer verantwortlich. {@code periode_art} ist ein WUNSCH, der geprüft, aber nicht gespeichert wird — die
     * Kennzahl entsteht in allen bildbaren Perioden (P2). {@code komplement} nur beim Anteil.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anfrage(
            String kennzeichen,
            String name,
            String rechenform,
            String geltungArt,
            String geltungId,
            String verantwortlichName,
            String zweck,
            String periodeArt,
            Boolean komplement,
            List<Eingang> eingaenge) {}

    /** {@code PUT …/{id}}: die GANZEN Stammdaten (V4) — Geltungsbereich und Rechenform sind fest. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StammdatenAnfrage(String kennzeichen, String name, String verantwortlichName, String zweck) {}

    /** {@code POST …/{id}/fassungen}: die Berechnung ab einem Tag, mit Begründung, auch rückwirkend (V1). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungAnfrage(
            String gueltigAb,
            String begruendung,
            String periodeArt,
            Boolean komplement,
            List<Eingang> eingaenge) {}

    /** Wer eine Fassung eingetragen hat (Akteur-Vokabular AP-03). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(String name, String rolle, String art) {}

    /** Ein Eingang einer Fassung mit dem HEUTIGEN Kennzeichen und Namen seines Objekts. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record EingangAntwort(String rolle, String art, UUID id, String kennzeichen, String name) {}

    /**
     * Eine Fassung der Berechnung (V1): {@code gueltig_ab} {@code null} = gilt seit Beginn, {@code gueltig_bis} der
     * LETZTE Tag einschließlich; {@code abzeichen} „rückwirkend (n Tage)“ nur bei einer rückwirkenden.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Fassung(
            int nummer,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            OffsetDateTime aufgehobenAm,
            String herkunft,
            boolean rueckwirkend,
            String abzeichen,
            String begruendung,
            Person eingetragenVon,
            OffsetDateTime eingetragenAm,
            String rechenform,
            String einheit,
            String einheitAnzeige,
            boolean komplement,
            List<EingangAntwort> eingaenge) {}

    /**
     * Eine Kennzahl — das Lesemodell der Definition. {@code rechte_geltung} und {@code kennung} folgen aus dem
     * Geltungsbereich (G1); {@code standort_id} ist der Standort des Objekts heute ({@code null} beim Unternehmen).
     * {@code fassung}, {@code einheit}, {@code grundperiode} und {@code perioden} beschreiben die HEUTE geltende
     * Berechnung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Kennzahl(
            UUID id,
            String kennzeichen,
            String name,
            String rechenform,
            String geltungArt,
            UUID geltungId,
            String geltungName,
            String rechteGeltung,
            UUID standortId,
            String kennung,
            String verantwortlichName,
            String zweck,
            Integer fassung,
            String einheit,
            String einheitAnzeige,
            String grundperiode,
            List<String> perioden,
            boolean hatWerte,
            OffsetDateTime archiviertAm,
            OffsetDateTime angelegtAm) {}

    /** {@code GET /api/v1/kennzahlen}: archivierte eingeschlossen, nach Kennzeichen (ein Objekt, additiv erweiterbar). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(List<Kennzahl> kennzahlen) {}

    /** {@code GET …/{id}/fassungen}: jede Fassung, nach Nummer. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassungen(UUID kennzahlId, String kennzeichen, List<Fassung> fassungen) {}

    /** {@code GET …/{id}/berechnung?am=}: die Fassung, die an dem Tag galt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Berechnung(UUID kennzahlId, String kennzeichen, LocalDate am, Fassung fassung) {}

    /** Ein Befund der Vorschau: dieselbe Ablehnung, die das Anlegen antworten würde. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Befund(String code, String message, Map<String, Object> fakten) {}

    /** Eine Periode der Vorschau, gerechnet wie die Regel {@code wert} — nichts davon wird gespeichert. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record VorschauPeriode(
            String periodeArt,
            String schluessel,
            String beschriftung,
            LocalDate von,
            LocalDate bis,
            String wert,
            String zaehler,
            String nenner,
            String zustand,
            String richtung,
            String grund,
            String abdeckungProzent,
            String fassung,
            List<String> kennzeichen,
            String anzeige,
            String kundensatz) {}

    /**
     * {@code POST …/vorschau}: die Befunde (leer = das Anlegen würde gelingen) und — nur ohne Befund — die letzten
     * drei abgeschlossenen Perioden. Die Vorschau läuft in einer Nur-Lese-Transaktion und schreibt nichts.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Vorschau(
            List<Befund> befunde,
            String rechteGeltung,
            UUID standortId,
            String kennung,
            String einheit,
            String einheitAnzeige,
            String grundperiode,
            List<String> perioden,
            String periodeArt,
            List<VorschauPeriode> letztePerioden) {}
}
