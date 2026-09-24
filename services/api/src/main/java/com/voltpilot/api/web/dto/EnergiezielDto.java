package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Das Energieziel und sein Ziel-Stand (UEMS AP-18 IP-6, Z1–Z4; Vertrag {@code verbesserung.md} §4). Zahlen sind
 * Dezimaltexte wie im Vergleich der Bezugsbasis.
 */
public final class EnergiezielDto {

    private EnergiezielDto() {}

    /** {@code POST /api/v1/energieziele}: Kennzahl, Zielwert in Prozent, Zielperiode {@code JJJJ-MM/JJJJ-MM}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(UUID kennzahl, BigDecimal zielwertProzent, String zielperiode, String wortlaut,
            String begruendung, String verantwortlich) {}

    /** {@code PUT …/{id}}: Wortlaut und/oder das Ende der Zielperiode (nur nach hinten), immer mit Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Aendern(String wortlaut, String zielperiode, String begruendung) {}

    /** {@code PUT …/{id}/verantwortlicher}: ein aktiver Benutzer des Kundenbereichs ({@code sub}) mit Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verantwortlicher(String benutzer, String begruendung) {}

    /** {@code POST …/{id}/beenden}: der Tag (ohne: heute) und die Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beenden(LocalDate zum, String begruendung) {}

    /**
     * {@code POST …/{id}/bewerten} und {@code …/bewertung/beantragen} (Z4, Z5): das Ergebnis
     * {@code erreicht · verfehlt · nicht_bewertbar} und die Begründung (10–500 Zeichen).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bewerten(String ergebnis, String begruendung) {}

    /** {@code …/bewertung/freigeben} (Begründung wahlfrei) und {@code …/bewertung/ablehnen} (Begründung Pflicht). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entscheid(String begruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Kennzahl(UUID id, String kennzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Basis(UUID id, String kennzeichen, int fassung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Person(String sub, String name) {}

    /** Eine Zeile des Protokolls {@code energieziel_aenderung}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Eintrag(String art, Map<String, Object> alt, Map<String, Object> neu, String begruendung,
            String person, Instant am) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Energieziel(UUID id, String kennzeichen, Kennzahl kennzahl, Basis bezugsbasis,
            String zielwertProzent, String zielperiode, String wortlaut, String begruendung, Person verantwortlich,
            UUID standortId, String zustand, LocalDate angelegtAm, LocalDate beendetZum, String beendetGrund,
            String ergebnis, Frist frist, Bewertung bewertung, List<Anstoss> anstoesse, List<Eintrag> verlauf) {}

    /**
     * F1 (Operation {@code frist}): Termin = letzter Tag der Zielperiode; {@code faellig} = {@code bewertung_faellig}
     * mit {@code seit_tagen} (0 am Termintag), solange das Ziel offen und der letzte Monat endgültig ist — beim Abruf
     * abgeleitet, nie gespeichert.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Frist(LocalDate termin, String faellig, Integer seitTagen) {}

    /**
     * Z5: die Bewertung — {@code status} {@code beantragt · bewertet · abgelehnt}; die Kopie des Ziel-Stands zum
     * Bewertungstag (kanonischer Text) mit Prüfsumme; bei Vier-Augen die zweite Person. Ohne Bewertung {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Bewertung(String status, String ergebnis, String begruendung, String vorschlag, boolean vieraugen,
            Person person, Instant am, Person entscheidung, Instant entschiedenAm, String entscheidungsBegruendung,
            String kopie, String pruefsumme) {}

    /** Ein Anstoß am Ziel ({@code vorgang_anstoss}, Z5): Basis beendet oder neu gefasst — eine Person antwortet. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Anstoss(UUID id, String art, String anlassKennung, Instant angestossenAm, String zustand,
            String antwort, String antwortBegruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Liste(List<Energieziel> energieziele) {}

    /** Ein Monat der Zielperiode: die Vergleichszeile des Bezugsbasis-Lesers und ob er endgültig ist. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Monat(String periode, boolean endgueltig, BezugsbasisVergleichDto.Monat vergleich) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Ausschluss(String monat, String grund) {}

    /** Σ ÷ Σ über die bewertbaren endgültigen Monate (Operation {@code zielstand} → {@code zeitraum}). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Summe(String gemessen, String erwartet, String deltaProzent, String bandProzent, String richtung,
            String urteil, List<String> kennzeichen) {}

    /**
     * {@code GET …/{id}/stand} (Z3, Z4): je Monat der Zielperiode das Vergleichsergebnis, die Summe, „x von y“, die
     * Ausschlüsse mit Grund und der Vorschlag nur bei vollständiger Periode; {@code satz} und {@code vorschlag_satz}
     * sind die Kundensätze des Vertrags.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Stand(Energieziel energieziel, LocalDate abruf, String zielperiode, String zielwertProzent,
            List<Monat> monate, int monateBewertbar, int monateEndgueltig, int monateSoll, String monateText,
            boolean vollstaendig, List<Ausschluss> nichtGezaehlt, Summe summe, String vorschlag, String satz,
            String vorschlagSatz) {}
}
