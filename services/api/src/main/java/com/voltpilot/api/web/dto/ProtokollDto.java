package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen des Änderungsprotokolls (UEMS AP-04 IP-21): {@code GET …/messstellen/{id}/aenderungen},
 * {@code GET …/geraete/{id}/aenderungen} und {@code GET /api/v1/unternehmen/aenderungen}.
 *
 * <p>In snake_case wie die übrigen UEMS-Schnittstellen. Zeitpunkte auf die Minute mit dem
 * Versatz von Europe/Berlin.
 *
 * <p><b>Die zwei Zeitachsen stehen an JEDER Zeile nebeneinander</b>, damit sie niemand
 * verwechselt: {@code gilt_ab} sagt, WANN die Änderung gilt, {@code eingetragen_am}, WANN sie
 * eingetragen wurde. {@code zeitform} ist das Urteil dazu — {@code rueckwirkend} (gilt vor dem
 * Eintrag), {@code angekuendigt} (gilt danach) oder {@code sofort}. Welche Achse der
 * Zeitraum-Filter nimmt, steht als {@code achse} in der ANTWORT, nicht nur in der Anfrage.
 */
public final class ProtokollDto {

    private ProtokollDto() {}

    /**
     * Wer den Eintrag geschrieben hat — im Akteur-Vokabular von AP-03. {@code rolle} und
     * {@code art} sind {@code null}, wo das Journal sie nicht festhält (die Orts-Einträge, bis
     * AP-03 IP-7 die Journale vereinheitlicht) — nie geraten.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Urheber(String name, String rolle, String art) {}

    /**
     * Das Objekt, um das es geht. {@code art}: {@code messstelle} · {@code datenquelle} ·
     * {@code unternehmen} · {@code standort} · {@code gebaeude} · {@code bereich} ·
     * {@code anlage}. {@code kennzeichen} ist {@code MS-06}, {@code DQ-1}, das Kurzzeichen
     * eines Ortes — oder {@code null}, wenn die Art keins trägt. {@code name} ist {@code null},
     * wenn das Objekt inzwischen gelöscht ist: das Protokoll überlebt es.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezug(String art, UUID id, String kennzeichen, String name) {}

    /**
     * Ein Eintrag. {@code id} ist Herkunft und laufende Nummer zusammen
     * ({@code messstelle:42}) — die drei Journale zählen unabhängig voneinander.
     * {@code text} ist der Kundensatz „was wurde geändert“ ({@link
     * com.voltpilot.api.uems.AenderungSatz}); {@code alt}/{@code neu} sind die rohen Fakten,
     * aus denen er gebaut ist. {@code gilt_bis} (AP-02 IP-14) ist der letzte TAG, an dem ein Eintrag
     * der Ortsstruktur noch gilt — {@code null} = bis heute offen; Einträge der Messstellen und
     * Datenquellen tragen keins (immer {@code null}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eintrag(
            String id,
            String quelle,
            String art,
            String text,
            Bezug bezug,
            OffsetDateTime giltAb,
            LocalDate giltBis,
            OffsetDateTime eingetragenAm,
            String zeitform,
            String grund,
            Urheber urheber,
            JsonNode alt,
            JsonNode neu) {}

    /**
     * Die Antwort. {@code achse} nennt die Zeitachse, nach der gefiltert und sortiert wurde
     * ({@code wirkung} = „gilt ab“, die Vorgabe; {@code eintrag} = „eingetragen am“;
     * {@code gueltigkeit} = welche Einträge in den Zeitraum reichen, sortiert wie {@code wirkung}).
     * {@code von}/{@code bis} sind der Zeitraum, halboffen {@code [von, bis)};
     * {@code null} heißt „ohne Grenze“. {@code weiter} ist der Fortsetzungszeiger für die
     * nächste Seite — {@code null}, wenn es keine weitere gibt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Protokoll(
            List<Eintrag> eintraege,
            String achse,
            OffsetDateTime von,
            OffsetDateTime bis,
            String weiter) {}
}
