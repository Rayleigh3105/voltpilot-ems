package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die DTOs der berechneten Messstelle (UEMS AP-10, Formel-Typ „gewichtete Summe"): das Anlegen mit
 * ihren Termen, das Lesen der Formel und das Lesen von Live-Wert und Verlauf. Vertrag
 * {@code docs/contracts/v2/messstelle-formel.md}. Kundentexte kommen erst im Frontend — hier keine.
 */
public final class MessstelleFormelDto {

    private MessstelleFormelDto() {}

    /**
     * Ein Term der Anfrage. {@code eingang_art} ist {@code messkanal} (dann {@code entity_id} +
     * {@code point_key}) oder {@code messstelle} (dann {@code quell_messstelle_id}). {@code faktor}
     * fehlend = 1; {@code vorzeichen} {@code +} oder {@code -}. {@code gilt_als_erzeugung} (AP-08,
     * fehlend = false) macht einen richtungslosen Messkanal als Term zulaessig und laesst ihn in
     * der Summe als Erzeugung zaehlen — nur an einem Kanal OHNE Katalog-Richtung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record TermEingabe(
            String eingangArt,
            UUID entityId,
            String pointKey,
            UUID quellMessstelleId,
            String vorzeichen,
            Double faktor,
            Boolean giltAlsErzeugung) {}

    /**
     * {@code POST /api/v1/messstellen/berechnet}. Das Kennzeichen wird automatisch vergeben (E7);
     * {@code name} leer = ein Entwurf. Die Hauptgröße wird aus den Termen abgeleitet, nie gewählt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String name, String notiz, List<TermEingabe> terme) {}

    /** Eine Messgröße wie im Messstellen-Vertrag. */
    public record Groesse(String groesse, String richtung, String einheit, String wertart) {}

    /**
     * Ein Term, so wie er gespeichert ist, mit der aufgelösten Größe des Messwerts (für die Anzeige).
     * {@code eingerichtet} sagt, ob sein Eingang noch auflösbar ist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Term(
            int position,
            String eingangArt,
            UUID entityId,
            String pointKey,
            UUID quellMessstelleId,
            String vorzeichen,
            double faktor,
            boolean giltAlsErzeugung,
            Groesse groesse,
            boolean eingerichtet) {}

    /**
     * {@code GET /api/v1/messstellen/{id}/formel}: die Formel einer berechneten Messstelle.
     * {@code formel_vorhanden}/{@code eingaenge_eingerichtet} sind die Eingänge des Lebenszyklus.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Formel(
            UUID messstelleId,
            String schemaVersion,
            Groesse hauptgroesse,
            List<Term> terme,
            boolean formelVorhanden,
            boolean eingaengeEingerichtet) {}

    /** Ein fehlender/veralteter Term, genannt statt verschwiegen (Ehrlichkeit). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FehlenderTerm(int position, String grund) {}

    /**
     * {@code GET /api/v1/messstellen/{id}/wert}: der Live-Wert = gewichtete Summe der frischesten
     * Eingangswerte. Fehlt/veraltet EIN Pflicht-Term, ist {@code wert} {@code null}
     * ({@code unvollstaendig} = true) und {@code fehlende} nennt die Terme — NIE eine Teilsumme.
     * {@code stand} ist der jüngste Messzeitpunkt der Eingänge (null, wenn unvollständig).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wert(
            Double wert,
            String einheit,
            boolean unvollstaendig,
            List<FehlenderTerm> fehlende,
            OffsetDateTime stand) {}

    /** Ein 15-min-Bucket des Verlaufs; {@code wert} {@code null} = unvollständig (nicht 0). */
    public record VerlaufPunkt(OffsetDateTime zeit, Double wert) {}

    /**
     * {@code GET /api/v1/messstellen/{id}/verlauf}: je 15-min-Bucket die Summe, WENN alle Terme im
     * Bucket einen Wert haben, sonst {@code null} (nie eine stille Teilsumme).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verlauf(UUID messstelleId, String einheit, List<VerlaufPunkt> punkte) {}
}
