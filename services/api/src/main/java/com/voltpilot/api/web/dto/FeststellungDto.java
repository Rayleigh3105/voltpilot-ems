package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-19: Feststellung (FS1–FS7) — erfasst mit Quelle, Wortlaut, Vorgabe, Bezug, „festgestellt von“,
 * Verantwortlich und Frist; Einträge nur anhängen; die Wirksamkeit als Stand Nr. n mit Kopie und Prüfsumme; Vier-Augen
 * nach Einstellung mit dem Antwortfeld {@link VierAugen} (FS6, W15).
 */
public final class FeststellungDto {
    private FeststellungDto() {}

    /** Die Quelle (FS1): {@code internes_audit} mit {@code audit_id} · {@code eigene} · {@code extern} mit Wortlaut · {@code managementbewertung} mit Kennung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Quelle(String art, UUID auditId, String kennung, String wortlaut) {}

    /** Die Vorgabe: eine Dokument-Fassung und/oder ein Wortlaut. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorgabe(UUID dokumentId, Integer fassung, String wortlaut) {}

    /** Der Bezug: Standort (ohne = das Unternehmen, der Zaun), wahlfrei eine Aufgabe, ein Dokument, Objekt-Kennzeichen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezug(UUID standortId, String aufgabe, UUID dokumentId, List<String> objekte) {}

    /**
     * Erfassen (FS1): Quelle, Wortlaut, Vorgabe, Bezug, festgestellt von (Person) und am (Vorgabe heute), Verantwortlich
     * (Konto, {@code sub}); ohne Frist gilt festgestellt am + Frist der Einstellung (Startwert 90 Tage).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Erfassen(Quelle quelle, String wortlaut, Vorgabe vorgabe, Bezug bezug, UUID festgestelltVon,
            LocalDate festgestelltAm, String verantwortlich, LocalDate frist) {}

    /** Ein Eintrag (FS2): Art, Wortlaut, die Person, die ihn sagt, und der Tag (Vorgabe heute) — nie ein Satz des Systems. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record EintragFesthalten(String art, String wortlaut, UUID personId, LocalDate am) {}

    /** Frist ändern, solange offen — Begründung Pflicht. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FristAendern(LocalDate frist, String begruendung) {}

    /** Verantwortlich ändern, solange offen — ein aktives Konto, Begründung Pflicht. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VerantwortlichAendern(String verantwortlich, String begruendung) {}

    /**
     * Ein Stand festhalten oder beantragen (FS4, FS5): Ergebnis, Begründung (10–500), „entschieden von“ (Person) und
     * der Tag (Vorgabe heute).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StandFesthalten(String ergebnis, String begruendung, UUID entschiedenVon, LocalDate am) {}

    /** Die zweite Person lehnt den Antrag ab — Begründung Pflicht. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ablehnen(String begruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record QuelleAus(String art, UUID auditId, String kennung, String wortlaut) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VorgabeAus(UUID dokumentId, String dokument, Integer fassung, String wortlaut) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record BezugAus(UUID standortId, String aufgabe, UUID dokumentId, String dokument, List<String> objekte) {}

    /** Die Frist beim Abruf (Operation {@code ueberpruefung}, Art {@code feststellung}); abgeschlossen ohne Frist. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Frist(LocalDate abruf, LocalDate faelligAm, Integer tage, String satz, String grund) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Feststellung(UUID id, String kennzeichen, QuelleAus quelle, String wortlaut, VorgabeAus vorgabe,
            BezugAus bezug, EnergiemanagementPersonenDto.PersonKurz festgestelltVon, LocalDate festgestelltAm,
            EnergiemanagementVerantwortungDto.Person verantwortlich, LocalDate frist, String zustand, Frist lage,
            String ergebnis, int eintraege, List<String> massnahmen, EnergiemanagementPersonenDto.Eingetragen eingetragen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eintrag(long id, String art, LocalDate am, EnergiemanagementPersonenDto.PersonKurz person,
            String wortlaut, EnergiemanagementPersonenDto.Eingetragen eingetragen) {}

    /** Eine Maßnahme mit Herkunft dieser Feststellung (FS3) — mit ihrem Zustand, ihr Vokabular bleibt das von AP-18. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Massnahme(UUID id, String kennzeichen, String titel, String zustand, LocalDate termin,
            LocalDate umgesetztAm, EnergiemanagementVerantwortungDto.Person verantwortlich) {}

    /** Stand Nr. n der Wirksamkeit (FS4, FS5): nie zurückgenommen (FS7). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stand(int nr, String ergebnis, String begruendung, LocalDate am,
            EnergiemanagementPersonenDto.PersonKurz entschiedenVon, JsonNode kopie, String pruefsumme, boolean vieraugen,
            String status, EnergiemanagementPersonenDto.Eingetragen eingetragen,
            EnergiemanagementPersonenDto.Eingetragen zweitePerson, String ablehnungBegruendung) {}

    /**
     * Vier-Augen nach Einstellung (FS6, W15): wer freigeben darf (Kundenadministrator oder Energiemanager am
     * Unternehmen), wer jetzt zweite Person sein kann — nie die Urheberin, nie der Verantwortliche — und, wenn niemand,
     * der Satz „Vier-Augen nicht erfüllbar: …“ mit den Personen. Die Fläche sperrt nicht still.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VierAugen(boolean an, boolean erfuellbar, List<EnergiemanagementVerantwortungDto.Person> berechtigte,
            List<EnergiemanagementVerantwortungDto.Person> zweitePerson, String satz) {}

    /** Die Feststellung mit Einträgen, Maßnahmen, Ständen, Vier-Augen und Verlauf. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FeststellungMitVerlauf(Feststellung feststellung, List<Eintrag> eintraege,
            List<Massnahme> massnahmen, List<Stand> wirksamkeit, VierAugen vieraugen,
            List<EnergiemanagementPersonenDto.Aenderung> verlauf) {}

    /** Die Liste am {@code tag}: offene zuerst (am längsten überfällig oben), dann abgeschlossene. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(LocalDate tag, List<Feststellung> feststellungen) {}
}
