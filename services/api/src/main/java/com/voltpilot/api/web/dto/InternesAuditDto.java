package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-18: internes Audit (IA1–IA5) — geplant, durchgeführt, Hinweise, abgeschlossen mit Kopie und
 * Prüfsumme oder abgesagt; das Auditprogramm ist die Liste der Audits mit dem nächsten fälligen Audit (IA4).
 */
public final class InternesAuditDto {
    private InternesAuditDto() {}

    /**
     * Planen und ändern: Titel, Termin, Auditorinnen/Auditoren (Personen, auch ohne Konto), Unabhängigkeit, was und
     * woran geprüft wird (Wortlaut, Pflicht), Verantwortlich (Konto, {@code sub}); wahlfrei Standorte. Beim Ändern
     * braucht ein anderer Termin eine Begründung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AuditStand(String titel, LocalDate termin, List<UUID> auditorIds, String unabhaengigkeit, String was,
            String woran, String verantwortlich, List<UUID> standortIds, String begruendung) {}

    /** Durchgeführt melden: der Tag, nie in der Zukunft. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Durchgefuehrt(LocalDate am) {}

    /** Einen Hinweis festhalten: Wortlaut und die Person, die ihn festgestellt hat; der Tag, Vorgabe der Durchführungstag. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record HinweisFesthalten(String wortlaut, UUID festgestelltVon, LocalDate am) {}

    /** Welche Maßnahme aus welchem Hinweis wurde (IA2) — die Maßnahme nennt dieses Audit als Herkunft. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record HinweisMassnahme(Integer hinweis, String massnahme) {}

    /** Der Bericht als Verweis (G3): ohne Ablage keiner seiner Teile; die Prüfsumme bildet der Browser. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bericht(String bezeichnung, String ablage, String kennung, String adresse, String sha256) {}

    /**
     * Abschließen (IA3): „entschieden von“ (Person), Tag (Vorgabe heute), Bericht als Verweis oder Zusammenfassung,
     * wahlfrei die Maßnahmen je Hinweis.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Abschliessen(UUID entschiedenVon, LocalDate am, String zusammenfassung, Bericht bericht,
            List<HinweisMassnahme> massnahmen) {}

    /** Absagen: nur geplant, Begründung Pflicht. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Absagen(String begruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Hinweis(int nr, LocalDate am, EnergiemanagementPersonenDto.PersonKurz festgestelltVon,
            String wortlaut, EnergiemanagementPersonenDto.Eingetragen eingetragen) {}

    /** Der Abschluss: wer entschieden hat, der Tag, Bericht oder Zusammenfassung, die Kopie und ihre Prüfsumme. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Abschluss(LocalDate am, EnergiemanagementPersonenDto.PersonKurz entschiedenVon,
            String zusammenfassung, Bericht bericht, JsonNode kopie, String pruefsumme,
            EnergiemanagementPersonenDto.Eingetragen eingetragen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Audit(UUID id, String kennzeichen, String titel, LocalDate termin,
            List<EnergiemanagementPersonenDto.PersonKurz> auditoren, String unabhaengigkeit, String was, String woran,
            EnergiemanagementVerantwortungDto.Person verantwortlich, List<UUID> standortIds, String zustand,
            LocalDate durchgefuehrtAm, String abgesagtBegruendung, int hinweise, List<String> feststellungen,
            Abschluss abschluss, EnergiemanagementPersonenDto.Eingetragen eingetragen) {}

    /** Das Audit mit seinen Hinweisen und seinem Verlauf (jeder Übergang). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AuditMitVerlauf(Audit audit, List<Hinweis> hinweise,
            List<EnergiemanagementPersonenDto.Aenderung> verlauf) {}

    /**
     * Das nächste interne Audit (IA4), beim Abruf: letzter Durchführungstag bis {@code tag} + Rhythmus; ohne
     * durchgeführtes Audit keine Frist ({@code grund} = {@code kein_audit}). Die Felder der Operation
     * {@code ueberpruefung} des Vertrags.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Naechstes(int rhythmusMonate, LocalDate faelligAm, LocalDate basis, Integer tage, String satz,
            String grund) {}

    /** Das Auditprogramm am {@code tag}: alle Audits (Termin absteigend) und das nächste fällige. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Auditprogramm(LocalDate tag, List<Audit> audits, Naechstes naechstes) {}
}
