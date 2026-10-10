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

    /**
     * {@code POST …/bezugsbasen/{bid}/fassungen}: ein Entwurf mit Vorschau (F1). Ab Fassung 2 mit Anpassungsgründen
     * (A1, {@code sonstiger} nur mit Wortlaut) und Begründung (F4, IP-8); {@code gilt_ab} Vorgabe: Tag nach der
     * Referenzperiode (P4). {@code faktoren} sind die statischen Faktoren (V3, IP-16b): ohne das Feld oder leer hat die
     * Fassung keine.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entwurf(String referenzperiode, String methode, List<String> variablen, String toleranzProzent,
            Integer wiedervorlageMonate, List<String> anpassungsgruende, String anpassungWortlaut, String begruendung,
            LocalDate giltAb, List<FaktorWahl> faktoren) {}

    /**
     * Ein gewählter statischer Faktor (V3, IP-16b): ein Verweis ({@code art} {@code flaeche · standort · anlage ·
     * prozess · kostenstelle} mit {@code objekt_id} aus dem Faktoren-Vorschlag am Bildungstag) oder ein Wortlaut
     * ({@code art} {@code wortlaut} mit {@code wortlaut}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FaktorWahl(String art, UUID objektId, String wortlaut) {}

    /**
     * Ein statischer Faktor der Fassung — die Kopie zum Stichtag (V3, E6): {@code wert}/{@code einheit} nur bei der
     * Fläche; ein Wortlaut hat keinen Wert und stößt nie an ({@code ohne_anstoss}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Faktor(int position, String art, UUID objektId, String kennung, String bezeichnung, String wortlaut,
            String wert, String einheit, LocalDate gueltigAb, LocalDate stichtag, boolean ohneAnstoss, String satz) {}

    /** {@code POST …/fassungen/{n}/beantragen · freigeben · ablehnen}: die Begründung (10–500 Zeichen, F1). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entscheid(String begruendung) {}

    /** {@code PUT …/bezugsbasen/{bid}/verantwortlicher}: ein Benutzer des Kundenbereichs (B4, Schnappschuss des Namens). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verantwortlicher(String benutzer) {}

    /**
     * {@code GET /api/v1/kennzahlen/{id}/bezugsbasen}: alle Bezugsbasen der Kennzahl in der Form der Einzel-Route, die
     * laufende zuerst (IP-8). Die Register-Zeile trägt {@code KennzahlDto.Kennzahl#bezugsbasis} (B3).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(List<Bezugsbasis> bezugsbasen) {}

    /** Wer beantragt bzw. freigegeben hat, und die zweite Person bei Vier-Augen (F1, F2). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(String name, String rolle, OffsetDateTime am) {}

    /**
     * Die Basis mit ihren Fassungen. {@code anstoesse} (A2–A4, Nachlese 3): jeder Anstoß an einer ihrer Fassungen, jüngster
     * zuerst — ohne Anstoß {@code []}. {@code frist} (F5, §15): die Frist der laufenden freigegebenen Fassung über
     * {@code BezugsbasisRegeln.frist} — {@code null} ohne freigegebene Fassung und an einer beendeten Basis.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezugsbasis(UUID id, String kennzeichen, UUID kennzahlId, String kennzahl, String zweck,
            String verantwortlichName, LocalDate beendetZum, String beendetGrund, OffsetDateTime angelegtAm,
            List<FassungKurz> fassungen, List<Anstoss> anstoesse, Frist frist) {}

    /**
     * Ein Anstoß an einer Fassung (A2–A4, IP-15; Nachlese 3): {@code art} {@code grundlage_korrigiert · struktur_geaendert ·
     * variable_geaendert · nicht_mehr_anwendbar}, {@code pfad} 1 (Kaskade) oder 2 (Struktur-Läufer), {@code anlass_satz}
     * der Kundensatz (§10), {@code offen} bis eine Person antwortet ({@code antwort}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anstoss(String art, int pfad, String anlassKennung, String anlassSatz, OffsetDateTime zeitpunkt,
            int fassung, boolean offen, AnstossAntwort antwort) {}

    /** Die Antwort einer Person auf einen Anstoß (A4): {@code neue_fassung · beendet · bleibt}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnstossAntwort(String art, String person, OffsetDateTime am, String begruendung) {}

    /**
     * Die Frist der laufenden Fassung (F5): Beginn = Freigabetag oder jüngstes „geprüft, bleibt“ ({@code bestaetigt_am}),
     * fällig am Beginn + {@code wiedervorlage_monate}; Stichtag = heute in der Zone der Kennzahl.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Frist(boolean ueberpruefungFaellig, LocalDate faelligAm, Integer faelligSeitTagen,
            int wiedervorlageMonate, LocalDate bestaetigtAm) {}

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
            List<Map<String, Object>> abgelehnteVariablen, List<String> kennzeichen, String toleranzProzent, int wiedervorlageMonate, List<Variable> variablen, List<Faktor> faktoren,
            String freigabeStatus, OffsetDateTime gebildetAm, String gebildetVon, LocalDate giltBis,
            List<String> anpassungsgruende, String anpassungWortlaut, String begruendung, boolean vieraugen,
            Person freigabe, Person entscheidung, String entscheidungsBegruendung, OffsetDateTime freigegebenAm,
            @JsonRawValue String grundlage, String pruefsumme) {}
}
