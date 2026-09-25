package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-23 (MG4–MG6): Sitzung, Beschlüsse und Folgen einer Managementbewertung — die Entscheidungen der Leitung,
 * die keine Vorlage erzeugen kann. Namen sind die von heute; im Stand stehen sie, wie sie zum Datenstand hießen.
 */
public final class ManagementbewertungDto {
    private ManagementbewertungDto() {}

    /** Eine Person im Energiemanagement (auch ohne Konto). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(UUID id, String name) {}

    /**
     * Die Sitzung (MG4): Tag, Leitung, Teilnehmende, wahlfrei Ort. {@code leitungGilt}: die Person hat am Tag der Sitzung
     * die laufende Aufgabe „Leitung des Unternehmens“ (PA3) — ohne sie sperrt die Freigabe ({@code leitung_fehlt}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Sitzung(LocalDate tag, Person leitung, boolean leitungGilt, List<Person> teilnehmende, String ort,
            String eingetragenVon, LocalDate eingetragenAm) {}

    /**
     * Eine Folge (MG6): Art des Objekts, sein Kennzeichen, wie verknüpft ({@code von_hand} · {@code herkunft} ·
     * {@code zuordnung} · {@code fassung} · {@code geprueft_bleibt}), sein Zustand heute, ein Tag und eine Angabe des
     * Objekts, wann und von wem verknüpft.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Folge(String art, String objekt, UUID objektId, String wie, String zustand, LocalDate tag,
            String angabe, LocalDate verknuepftAm, String eingetragenVon) {}

    /** Ein Beschluss (MG5) mit seinen Folgen; {@code satz} nur nach der Freigabe und nur ohne Folge. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beschluss(int nr, String kennung, String art, String wortlaut, Person entschiedenVon,
            Person zustaendig, LocalDate termin, String eingetragenVon, LocalDate eingetragenAm, List<Folge> folgen,
            String satz) {}

    /** Die Managementbewertung mit Sitzung und Beschlüssen; {@code freigegeben}: es gibt einen Stand (Nr.). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Managementbewertung(String kennung, boolean freigegeben, Integer standNr, Sitzung sitzung,
            List<Beschluss> beschluesse) {}

    /** Sitzung festhalten (MG4) — bis zur Freigabe; ein zweites Festhalten ersetzt die erste Angabe. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SitzungFesthalten(LocalDate tag, UUID leitung, List<UUID> teilnehmende, String ort) {}

    /**
     * Beschluss festhalten oder ändern (MG5) — bis zur Freigabe. {@code entschiedenVon}: die Leitung (Vorgabe: die Leitung
     * der Sitzung); wahlfrei zuständig und Termin.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record BeschlussFesthalten(String art, String wortlaut, UUID entschiedenVon, UUID zustaendig,
            LocalDate termin) {}

    /**
     * Folge verknüpfen (MG6) — nach der Freigabe: {@code art} {@code energieziel} (EZ-…), {@code dokument} (D-…/n, die
     * Fassung), {@code aufgabe} (die ID der Zuordnung) oder {@code audit} (AU-…).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FolgeVerknuepfen(String art, String objekt) {}
}
