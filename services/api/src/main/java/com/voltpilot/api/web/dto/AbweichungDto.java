package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Auffälligkeit und Abweichung (UEMS AP-18 IP-16, A2–A6, U1–U3; Vertrag {@code verbesserung.md}). Der Anlass ist die
 * kanonische Kopie, wie gespeichert, mit Prüfsumme; {@code vorbehalte} sind die Kennzeichen „vorläufig“ des Anlasses —
 * geerbt, nicht neu gebildet (R8).
 */
public final class AbweichungDto {

    private AbweichungDto() {}

    /**
     * {@code POST /api/v1/kennzahlen/{id}/auffaelligkeiten/{aid}/antwort}. {@code abweichung}: {@code verantwortlich}
     * Pflicht, {@code frist} wahlfrei (ohne: Eröffnungstag + 30), {@code begruendung} wahlfrei; {@code zur_kenntnis}:
     * {@code begruendung} Pflicht (10–500), ohne Frist und Verantwortlichen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Antwort(String antwort, String begruendung, LocalDate frist, String verantwortlich) {}

    /**
     * {@code POST /api/v1/abweichungen} (von Hand, A3): Kennzahl, wahlfrei die Bezugsbasis ({@code BB-…}; ohne: die der
     * Kennzahl), die Monate ({@code JJJJ-MM} oder {@code JJJJ-MM/JJJJ-MM}, abgeschlossen), der Wortlaut, warum
     * (10–500), Verantwortlicher und wahlfrei die Frist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(UUID kennzahl, String bezugsbasis, String monate, String wortlaut, String verantwortlich,
            LocalDate frist) {}

    /**
     * {@code POST …/{id}/eintraege}: {@code kommentar} mit {@code text} (1–2 000) · {@code ursache_aussage} mit
     * {@code wortlaut} (10–500), der aussagenden Person ({@code aussage_sub} eines Kontos oder {@code aussage_name}),
     * {@code aussage_am} (nie in der Zukunft) und wahlfrei {@code beleg_kennung} (U1, U2).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NeuerEintrag(String art, String text, String wortlaut, String aussageSub, String aussageName,
            LocalDate aussageAm, String belegKennung) {}

    /** {@code PUT …/{id}/frist}: der neue Tag (nie vor dem Eröffnungstag) mit Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Frist(LocalDate frist, String begruendung) {}

    /** {@code PUT …/{id}/verantwortlicher}: ein aktiver Benutzer des Kundenbereichs ({@code sub}) mit Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verantwortlicher(String benutzer, String begruendung) {}

    /** {@code POST …/{id}/abschliessen}: Ergebnis, Begründung (10–500), bei {@code massnahme} die Maßnahme (A6). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Abschliessen(String ergebnis, String begruendung, UUID massnahme) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Verweis(UUID id, String kennzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Person(String sub, String name) {}

    /** Herkunft {@code auffaelligkeit · von_hand}; {@code wortlaut} nur von Hand. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Herkunft(String art, String wortlaut) {}

    /** F1: die Frist beim Abruf (Operation {@code frist}); {@code faellig} {@code ueberfaellig} oder {@code null}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record FristStand(LocalDate abruf, LocalDate termin, String faellig, Integer seitTagen) {}

    /** A6: Ergebnis, Verweis bei {@code massnahme}, Begründung, Tag und Person; {@code satz} §5.9 oder {@code null}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Abschluss(String ergebnis, Verweis massnahme, String begruendung, LocalDate am, String person,
            String satz) {}

    /**
     * U1/U2: die Aussage einer Person — nie ein Fakt des Systems. {@code kennzeichen} „Aussage von …, TT.MM.JJJJ —
     * keine Messung“ bzw. „— mit Beleg …“; {@code satz} §5.9.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Aussage(String wortlaut, String sub, String name, LocalDate am, String belegKennung,
            String kennzeichen, String satz) {}

    /**
     * Eine Zeile des Protokolls {@code abweichung_aenderung}; {@code person} ist, wer eingetragen hat — bei einer
     * Ursache-Aussage nicht die aussagende Person (R2).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Eintrag(long nr, String art, Map<String, Object> alt, Map<String, Object> neu, String begruendung,
            String kommentar, Aussage aussage, String person, Instant am) {}

    /** Ein Vermerk an der Kennzahl (A1, A2); {@code satz} §5.9 nur bei {@code zur_kenntnis}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Vermerk(UUID id, Verweis kennzahl, Verweis bezugsbasis, int fassung, String periode,
            UUID standortId, String anlass, String anlassPruefsumme, Map<String, Object> anlassInhalt,
            List<String> vorbehalte, Instant vermerktAm, String zustand, String antwort, String antwortBegruendung,
            Verweis abweichung, Instant beantwortetAm, String beantwortetVon, String satz) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Vermerke(Verweis kennzahl, LocalDate abruf, int offen, List<Vermerk> vermerke) {}

    /** Die Antwort auf einen Vermerk: der beantwortete Vermerk und bei {@code abweichung} die eröffnete Abweichung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Beantwortet(Vermerk vermerk, Abweichung abweichung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Abweichung(UUID id, String kennzeichen, Verweis kennzahl, Verweis bezugsbasis, int fassung,
            List<String> monate, Herkunft herkunft, String anlass, String anlassPruefsumme,
            Map<String, Object> anlassInhalt, List<String> vorbehalte, Person verantwortlich, FristStand frist,
            UUID standortId, String zustand, LocalDate eroeffnetAm, String eroeffnetVon, Abschluss abschluss,
            String kopfSatz, List<Vermerk> vermerke, List<Eintrag> verlauf) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Liste(LocalDate abruf, List<Abweichung> abweichungen) {}
}
