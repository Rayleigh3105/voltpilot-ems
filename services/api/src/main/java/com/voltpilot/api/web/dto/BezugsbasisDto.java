package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonRawValue;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Formen der Bezugsbasis-Routen (UEMS AP-17 IP-7, Vertrag {@code bezugsbasis.md} „Routen“). Die Fassung ist
 * Vorschau und gespeicherte Kopie in einem: beide Routen lesen dieselbe Zeile, die Grundlage kommt als der
 * gespeicherte kanonische Text ({@link JsonRawValue}) — byte-gleich zu seiner Prüfsumme.
 */
public final class BezugsbasisDto {

    private BezugsbasisDto() {}

    /** {@code POST /api/v1/kennzahlen/{id}/bezugsbasen}: alles wahlfrei; der Verantwortliche ist der der Kennzahl (B4). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String zweck) {}

    /** {@code POST …/bezugsbasen/{bid}/fassungen}: ein Entwurf mit Vorschau (F1). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entwurf(String referenzperiode, String methode, List<String> variablen, String toleranzProzent,
            Integer wiedervorlageMonate) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezugsbasis(UUID id, String kennzeichen, UUID kennzahlId, String kennzahl, String zweck,
            String verantwortlichName, LocalDate beendetZum, String beendetGrund, OffsetDateTime angelegtAm,
            List<FassungKurz> fassungen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungKurz(int fassung, String referenzperiode, String methode, String datenlage,
            String freigabeStatus, String basiswert, LocalDate giltAb, LocalDate giltBis, String pruefsumme) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Variable(int position, String rolle, UUID bezugsgroesseId, String kennzeichen, Integer fassung,
            String spannweiteVon, String spannweiteBis) {}

    /**
     * Die Fassung. Beim Modell (M2/M4) eingefroren: {@code koeffizienten} ({@code a}, {@code b}, beim Modell mit zwei
     * Einflussgrößen {@code c}; vier Stellen), {@code r2} (drei), {@code streuung_prozent} (eine) — beim Verhältnis
     * {@code null}. {@code abgelehnte_variablen}: eine abhängige zweite Variable (G4) mit r. {@code kennzeichen}: was jede
     * Zahl aus dieser Fassung trägt, etwa „ohne Grundlast“ beim Verhältnis über eine Gradtagzahl (M3).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(UUID bezugsbasisId, String bezugsbasis, UUID kennzahlId, String kennzahl, int fassung,
            String referenzperiode, String methode, LocalDate giltAb, int monate, int mindestMonate, String datenlage,
            List<Map<String, Object>> datenlageGruende, List<String> vorbehalte, String basiswert,
            Map<String, String> koeffizienten, String r2, String streuungProzent,
            List<Map<String, Object>> abgelehnteVariablen, List<String> kennzeichen, String toleranzProzent, int wiedervorlageMonate, List<Variable> variablen, List<Object> faktoren,
            String freigabeStatus, OffsetDateTime gebildetAm, String gebildetVon,
            @JsonRawValue String grundlage, String pruefsumme) {}
}
