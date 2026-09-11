package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Vorschlagsliste der Bestandsübernahme je Standort (UEMS AP-04 IP-16,
 * {@code GET /api/v1/standorte/{id}/messstellen-vorschlag} und
 * {@code POST …/messstellen-vorschlag/uebernehmen}).
 *
 * <p>In snake_case wie die Messstellen-Schnittstelle und in den Wörtern des Vertrags
 * ({@code docs/contracts/v2/messstelle.md} §11): eine Zeile ist ein Messwert einer Komponente,
 * aus dem eine Messstelle würde. Die Regeln stehen in {@code MessstelleRegeln.vorschlagsliste}
 * (Vektoren: Familie {@code vorschlag}) — dieser Weg sammelt nur die Eingänge und schreibt.
 *
 * <p><b>Bestätigt wird, was gezeigt wurde:</b> {@link Bestaetigt} trägt die Zeile zurück, wie das
 * GET sie gezeigt hat ({@code name} darf der Kunde überschreiben). Weicht sie ab, ist das
 * 409 {@code vorschlag_geaendert} — nichts wird geschrieben.
 */
public final class MessstelleVorschlagDto {
    private MessstelleVorschlagDto() {}

    /**
     * Der Messwert hinter einer Größe: der Kanal der Komponente, seine Wertart und wie aus ihm
     * die Größe wird ({@code zaehlerstand} · {@code differenzen} · {@code integration} ·
     * {@code momentanwert}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Quelle(String kanal, String anzeigename, String kanalWertart, String herleitung) {}

    /** Eine Nebengröße des Vorschlags (der Ladestand am Speicher) mit ihrem Messwert. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Nebengroesse(MessstelleDto.Groesse groesse, Quelle quelle) {}

    /**
     * „Unterzähler von“: {@code bestehend} = eine schon vorhandene Messstelle; sonst ein Vorschlag
     * DIESER Liste — dann sagen {@code komponente} und {@code kanal}, welcher.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezug(String messstelle, boolean bestehend, UUID komponente, String kanal) {}

    /** Was an einer Zeile hängt, ohne sie zu verhindern. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Hinweis(String code, String text) {}

    /**
     * Eine Zeile der Liste. {@code ab} ist der Beginn der Bindung (Verlaufsbeginn, nie vor dem
     * Standort und nie vor der laufenden Speisung), {@code stellung_ab} der Tag, ab dem die
     * Stellung gilt. {@code kennzeichen} ist der automatische Vorschlag (E7) — das Kennzeichen
     * vergibt bei der Übernahme der Server.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschlag(
            String kennzeichen,
            String name,
            UUID anlage,
            String anlageName,
            UUID komponente,
            String komponenteName,
            MessstelleDto.Groesse hauptgroesse,
            Quelle quelle,
            List<Nebengroesse> nebengroessen,
            String stellung,
            Bezug unterzaehlerVon,
            String ort,
            OffsetDateTime ab,
            LocalDate stellungAb,
            List<Hinweis> hinweise) {}

    /** Was nicht vorgeschlagen wird, mit Grund und Satz; {@code kanal} leer = die ganze Komponente. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ausgelassen(
            UUID anlage,
            UUID komponente,
            String komponenteName,
            String kanal,
            String grund,
            String zu,
            String text) {}

    /**
     * {@code GET …/messstellen-vorschlag}. {@code leer} und {@code text} sind gesetzt, WENN es
     * keinen Vorschlag gibt ({@code alle_zugeordnet} · {@code keine_komponente}) — nie daneben.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(
            UUID standort,
            String standortKennzeichen,
            String standortName,
            List<Vorschlag> vorschlaege,
            List<Ausgelassen> ausgelassen,
            String leer,
            String text) {}

    /**
     * Eine bestätigte Zeile: die Felder, die das GET gezeigt hat. {@code name} darf überschrieben
     * werden („benennt um“); alles andere muss noch so sein, sonst 409 {@code vorschlag_geaendert}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bestaetigt(
            UUID komponente,
            String kanal,
            MessstelleDto.Groesse hauptgroesse,
            List<Nebengroesse> nebengroessen,
            String stellung,
            OffsetDateTime ab,
            String name) {}

    /** {@code POST …/messstellen-vorschlag/uebernehmen}: die ausgewählten Zeilen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Uebernehmen(List<Bestaetigt> vorschlaege) {}

    /**
     * Das Ergebnis der Übernahme: wie viele Messstellen neu entstanden sind, wie viele es schon
     * gab (ein zweiter Aufruf legt nichts an), und die Messstellen in der Reihenfolge der Anfrage.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Uebernommen(int neu, int unveraendert, List<MessstelleDto.Messstelle> messstellen) {}
}
