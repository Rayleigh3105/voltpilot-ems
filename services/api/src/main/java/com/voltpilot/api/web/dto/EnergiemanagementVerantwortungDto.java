package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-10: „Wer ist wofür verantwortlich“ (PA2, PA4) — die Aufgaben am Tag, die Verantwortlichen der
 * bestehenden Objekte und wer die Bezugsbasen freigegeben hat. Alles gelesen, nichts kopiert; Verantwortung verleiht
 * kein Recht (AP-18 M1).
 */
public final class EnergiemanagementVerantwortungDto {
    private EnergiemanagementVerantwortungDto() {}

    /** So nennt ein Objekt seinen Verantwortlichen — {@code sub} nur, wo das Objekt ein Konto führt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(String sub, String name) {}

    /**
     * Ein Objekt mit seinem Verantwortlichen: {@code art} {@code kennzahl · energieeinsatz · bezugsbasis · energieziel ·
     * massnahme · abweichung} (ab IP-18/IP-19 dazu Audit und Feststellung); {@code zustand} nur, wo das Objekt selbst
     * einen führt (Energieziel, Maßnahme, Abweichung). {@code verantwortlich} {@code null} heißt: am Objekt ist niemand
     * eingetragen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Objekt(String art, UUID id, String kennzeichen, String titel, Person verantwortlich, String zustand) {}

    /**
     * Eine freigegebene Fassung einer Bezugsbasis: wer sie freigegeben hat und bei Vier-Augen die zweite Person (AP-17
     * F1, F2) — neben dem Verantwortlichen der Basis, der meist ein anderer ist (R5).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Freigabe(UUID bezugsbasisId, String bezugsbasis, UUID kennzahlId, String kennzahl, int fassung,
            String freigegebenVon, OffsetDateTime freigegebenAm, boolean vieraugen, String zweitePerson) {}

    /**
     * {@code GET /api/v1/energiemanagement/verantwortung}: die Aufgaben am {@code tag} wie {@code GET …/aufgaben}
     * (je Wort die laufenden Zuordnungen, ohne Person der Satz), {@code ohne_person} die Wörter ohne laufende Zuordnung,
     * die Objekte heute und die Freigaben der Bezugsbasen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verantwortung(LocalDate tag, List<EnergiemanagementPersonenDto.PersonKurz> leitung,
            List<EnergiemanagementPersonenDto.Aufgabe> aufgaben, List<String> ohnePerson, List<Objekt> objekte,
            List<Freigabe> bezugsbasenFreigaben) {}
}
