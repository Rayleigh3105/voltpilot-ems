package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-18 IP-19 (F1–F3, W7): die Übersicht „Ziele und Maßnahmen“ — Zähler je Art und je überfälligem Vorgang eine
 * Zeile, beim Abruf abgeleitet (Operation {@code frist}, Uhr der Kennzahlen). Nichts davon ist gespeichert.
 */
public final class VerbesserungUebersichtDto {

    private VerbesserungUebersichtDto() {}

    /**
     * Die Zähler aus R9 — Namen wie im Referenzfall. {@code massnahmen_umgesetzt_ohne_bewertung} = Zustand
     * {@code umgesetzt}; {@code energieziele_laufend} = Zustand {@code offen}; {@code messbedarfe_ueberfaellig} liest die
     * Frist des Messbedarfs (AP-16) mit, ohne ihn umzubauen (W7).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Zaehler(int auffaelligkeitenOffen, int abweichungenOffen, int abweichungenUeberfaellig,
            int massnahmenGeplant, int massnahmenUeberfaellig, int massnahmenUmgesetztOhneBewertung,
            int energiezieleLaufend, int energiezieleBewertungFaellig, int anstoesseOffen,
            int messbedarfeUeberfaellig) {}

    /**
     * Ein fälliger Vorgang: {@code art} {@code massnahme · abweichung} ({@code faellig} {@code ueberfaellig}) oder
     * {@code energieziel} ({@code bewertung_faellig}). {@code satz} ist der Kundensatz „Überfällig“ (§5.9, Operation
     * {@code satz}) — beim Energieziel {@code null}, dafür gibt es keinen Satz im Vertrag. Sprungziele: {@code id} (die
     * Seite des Vorgangs, sobald es sie gibt), {@code kennzahl_id} (Messgrundlage bzw. Anker), {@code einsatz_id}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Zeile(String art, UUID id, String kennzeichen, String titel, String zustand, LocalDate termin,
            String faellig, int seitTagen, String verantwortlich, String satz, UUID kennzahlId, UUID einsatzId) {}

    /** Die Übersicht am Abruf-Tag; {@code faellig} überfällige Vorgänge zuerst die ältesten, dann nach Kennzeichen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Uebersicht(LocalDate abruf, Zaehler zaehler, List<Zeile> faellig) {}
}
