package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-6: Personen im Energiemanagement und ihre Aufgaben (PA1–PA3, PA5). Eine Person ist, wer außerhalb des
 * Systems entscheidet, prüft oder teilnimmt — auch ohne Konto; eine Aufgabe ist eine datierte Zuordnung mit
 * „entschieden von“.
 */
public final class EnergiemanagementPersonenDto {
    private EnergiemanagementPersonenDto() {}

    /** Person erfassen: Name und Funktion Pflicht, alles andere wahlfrei. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PersonAnlegen(String name, String funktion, String kuerzel, String organisation, String kontoSub,
            LocalDate seit) {}

    /**
     * Person ändern — der ganze änderbare Stand: Name, Funktion, Kürzel, Organisation, Konto, seit; mit {@code bis}
     * beendet. Ein anderes Konto (verknüpfen, wechseln, lösen) und {@code bis} brauchen eine Begründung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PersonAendern(String name, String funktion, String kuerzel, String organisation, String kontoSub,
            LocalDate seit, LocalDate bis, String begruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Konto(String sub, String name, String zustand) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eingetragen(ProtokollAkteur akteur, Instant am) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(UUID id, String name, String funktion, String kuerzel, String organisation, Konto konto,
            LocalDate seit, LocalDate bis, String zustand, String beendetBegruendung, Eingetragen eingetragen) {}

    public record Personen(List<Person> personen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Aenderung(long id, String art, JsonNode alt, JsonNode neu, String begruendung,
            ProtokollAkteur akteur, Instant zeit) {}

    /** Die Person mit ihrem Verlauf (erfasst, geändert, Konto verknüpft, beendet). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PersonMitVerlauf(Person person, List<Aenderung> verlauf) {}

    /** So nennen Zuordnung und Leitung eine Person. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PersonKurz(UUID id, String name, String funktion, String kuerzel, boolean mitKonto) {}

    /** Der Beleg ist ein Verweis (G3): ohne Ablage keiner seiner Teile. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beleg(String bezeichnung, String ablage, String kennung, String adresse, String sha256) {}

    /** Zuordnen: Aufgabe, Person, gilt ab, Begründung; „entschieden von“ Pflicht außer bei der Leitung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AufgabeZuordnen(String aufgabe, String aufgabeWortlaut, UUID personId, LocalDate giltAb,
            UUID vertretungPersonId, UUID entschiedenVon, String begruendung, Beleg beleg, String beschlussKennung) {}

    /** Beenden: der letzte Tag zählt mit; eine Übergabe ist eine neue Zuordnung ab dem Folgetag. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AufgabeBeenden(LocalDate giltBis, String begruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zuordnung(UUID id, String aufgabe, String wort, String aufgabeWortlaut, PersonKurz person,
            PersonKurz vertretung, LocalDate giltAb, LocalDate giltBis, String zustand, PersonKurz entschiedenVon,
            String begruendung, Beleg beleg, String beschlussKennung, String beendetBegruendung,
            Eingetragen eingetragen) {}

    /** Eine Aufgabe des Vokabulars am Tag: ihre laufenden Zuordnungen, ohne Person der Satz (PA2). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Aufgabe(String aufgabe, String wort, List<Zuordnung> laufend, String satz) {}

    /**
     * Die Aufgaben am {@code tag}: je Wort des Vokabulars die laufenden Zuordnungen, die Leitung (PA3) und alle
     * Zuordnungen samt beendeter und künftiger.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Aufgaben(LocalDate tag, List<PersonKurz> leitung, List<Aufgabe> aufgaben,
            List<Zuordnung> zuordnungen) {}
}
