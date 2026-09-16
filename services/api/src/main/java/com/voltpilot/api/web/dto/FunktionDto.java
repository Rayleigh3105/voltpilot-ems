package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Funktionen je Standort (UEMS AP-01 IP-3, E6 = C) in snake_case wie der Vertrag
 * {@code docs/contracts/v2/funktion-zustand.schema.json}: Zustände, Prüfungen, Aktionen und Gründe sind
 * dessen Wörter, jeder Satz kommt aus {@code FunktionZustandAbleitung}. Zeitpunkte tragen den Versatz der
 * Zeitzone des Standorts; {@code null} heißt „nicht bekannt“, nie „jetzt“.
 */
public final class FunktionDto {

    private FunktionDto() {}

    /** {@code GET /api/v1/funktionen} — das Unternehmen und seine nicht archivierten Standorte. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Funktionen(Unternehmen unternehmen, List<Standort> standorte) {}

    /** Die Unternehmens-Ableitung je Funktion: „läuft an x von y Standorten“. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Unternehmen(Verbreitung messen, Verbreitung steuern) {}

    /**
     * @param laeuftAn Standorte, an denen die Funktion {@code aktiv} ist
     * @param standorte alle nicht archivierten Standorte
     * @param text „Messen &amp; Auswerten läuft an 2 von 2 Standorten“; {@code null} ohne Standort
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verbreitung(int laeuftAn, int standorte, String text) {}

    /** Ein Standort mit BEIDEN Funktionen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Standort(UUID id, String kurzzeichen, String name, String zeitzone, Messen messen,
            Steuern steuern) {}

    /** „Messen &amp; Auswerten“ am Standort; {@code datenlage} nur, wenn die Funktion angelegt ist. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messen(String zustand, OffsetDateTime seit, String text, List<String> fehlt, String datenlage) {}

    /**
     * „Steuern &amp; Optimieren“ am Standort = der höchste Zustand seiner Teilnahmen. {@code fehlt} ist,
     * was den Teilnahmen IN diesem Zustand fehlt; {@code aktionen} die Standort-Aktionen, die jetzt
     * erlaubt wären.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Steuern(String zustand, OffsetDateTime seit, String text, List<String> fehlt,
            List<String> aktionen, List<Anlage> anlagen) {}

    /** Eine Anlage des Standorts (heute zugeordnet oder mit einer Teilnahme an seiner Funktion). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlage(UUID id, String name, Teilnahme teilnahme) {}

    /**
     * Die Teilnahme einer Anlage. {@code pruefliste} steht nur in entwurf, eingerichtet und angehalten —
     * dort entscheidet sie über Start und Fortsetzen; {@code wege} nennt je roter Zeile, was zu tun ist.
     * {@code aktionen} sind die Aktionen, die jetzt erlaubt wären.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Teilnahme(String zustand, OffsetDateTime seit, String text, boolean uebernommen,
            List<PruefZeile> pruefliste, List<String> fehlt, List<Weg> wege, List<String> aktionen) {}

    /** {@code bestanden == null} heißt „nicht prüfbar“, nie „bestanden“. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PruefZeile(String pruefung, Boolean bestanden) {}

    /** Was der Kunde tun muss, damit eine rote Zeile grün wird. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Weg(String pruefung, String satz) {}

    /** {@code GET …/funktionen/steuern/pruefung} — die Startprüfung einer Anlage aus frischen Fakten. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SteuernPruefung(UUID anlageId, String anlage, UUID standortId, String standort, boolean bereit,
            List<SteuernPruefZeile> zeilen, FreigabeStand freigaben, String folgen) {}

    /** Der komponentengenaue Freigabe-Stand; die Zählung umfasst nur die drei bestehenden Wege. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FreigabeStand(int freigegeben, int gesamt, String text, List<FreigabeZeile> komponenten) {}

    /** Selbstbau, OCPP und Wechselrichter behalten ihre getrennten Tatsachen und Zuständigkeiten. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FreigabeZeile(UUID entityId, String name, String weg, boolean freigegeben, String status,
            Boolean stationVerbunden, Boolean steuerartGesetzt) {}

    /** Eine Zeile nennt den Fakt; nur eine rote Zeile trägt zusätzlich Grund und Weg. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SteuernPruefZeile(String pruefung, Boolean bestanden, String fakt, String grund, String weg) {}

    /** {@code PUT …/funktionen/steuern} — genau ein Feld. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SteuernAnfrage(String aktion) {}

    /** Die Antwort eines erlaubten Übergangs: wen er traf, und der Standort, wie er danach steht. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SteuernErgebnis(String aktion, List<AnlageRef> betroffen, Standort standort) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnlageRef(UUID id, String name) {}

    /** {@code PUT …/standorte/{id}/funktionen/messen} — genau ein Feld (AP-01 IP-9a). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MessenAnfrage(String aktion) {}

    /** Die Antwort des Einrichtens: der Standort, wie er danach steht — „Messen &amp; Auswerten“ im Entwurf. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MessenErgebnis(String aktion, Standort standort) {}
}
