package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-21: die Wiedervorlage (WV1–WV5) — alle Fristen des Energiemanagements und seiner Vorgänger an einer
 * Stelle, beim Abruf gelesen; nichts wird verschickt, nichts gespeichert.
 */
public final class EnergiemanagementWiedervorlageDto {
    private EnergiemanagementWiedervorlageDto() {}

    /**
     * Eine Zeile — die Ausgabe der Operation {@code wiedervorlage} (WV3): {@code art} aus {@code wiedervorlage_art},
     * {@code faellig_am} aus der Regel des Objekts, {@code tage} = Abruf − fällig am (positiv = fällig, 0 = heute,
     * negativ = Vorschau), {@code satz} die Lage in Worten. {@code id} und {@code kennzahl_id} tragen den Sprung auf die
     * Seite des Objekts; wo es keine gibt, {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zeile(String art, String kennzeichen, String titel, LocalDate faelligAm, int tage, String satz,
            String verantwortlich, UUID id, UUID kennzahlId) {}

    /**
     * Die Wiedervorlage am Abruf ({@code stichtag}, Zeitzone des Unternehmens): {@code faellig} am längsten fällig
     * zuerst, dann nach Kennzeichen; {@code vorschau} die nächsten {@code vorschau_tage} Tage; {@code nicht_in_liste} die
     * Kennzeichen mit späterer Frist. {@code verantwortung} ist der Verantwortungs-Satz (SP4).
     * {@code naechste_managementbewertung} (additiv, Folge AP-19 IP-24) ist die Frist von MG7 mit ihrer Herkunft — auch
     * außerhalb des Vorschau-Fensters; {@code null} ohne freigegebene Managementbewertung mit Sitzung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wiedervorlage(OffsetDateTime stichtag, int vorschauTage, List<Zeile> faellig, List<Zeile> vorschau,
            int anzahlFaellig, int anzahlVorschau, List<String> nichtInListe, String verantwortung,
            NaechsteManagementbewertung naechsteManagementbewertung) {}

    /**
     * MG7: die nächste Managementbewertung ist fällig am {@code faellig_am} = Tag der letzten Sitzung ({@code sitzung_am})
     * der freigegebenen Managementbewertung {@code kennzeichen} + {@code rhythmus_monate} — gerechnet in
     * {@code ManagementbewertungWiedervorlage}, derselben Stelle wie die Zeile der Wiedervorlage (WV2).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NaechsteManagementbewertung(LocalDate faelligAm, String kennzeichen, LocalDate sitzungAm,
            int rhythmusMonate) {}
}
