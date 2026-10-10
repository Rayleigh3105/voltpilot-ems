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
     *
     * <p>Additiv seit dem Konzept Wiedervorlage w1: {@code herleitung} sagt, woraus die Frist folgt (Angaben, keine
     * Sätze), {@code bezug} nennt den Gegenstand, wo der Titel ihn nicht trägt, {@code einsatz_id} den Energieeinsatz
     * eines Messbedarfs, {@code aufgabe} die Aufgabe im Energiemanagement (Vokabular {@code aufgabe}), zu der diese Art
     * Frist gehört, {@code zustaendig} die Person: am Objekt oder laut dieser Aufgabe, {@code null} wo niemand
     * festgelegt ist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zeile(String art, String kennzeichen, String titel, LocalDate faelligAm, int tage, String satz,
            String verantwortlich, UUID id, UUID kennzahlId, Herleitung herleitung, String bezug, UUID einsatzId,
            String aufgabe, Zustaendig zustaendig) {}

    /**
     * Woraus die Frist folgt: {@code basis} aus {@code wiedervorlage_basis} (freigabe, geprueft_bleibt, durchgefuehrt,
     * sitzung, erkannt, festgestellt, termin, zielperiode), {@code am} der Tag, an dem die Regel ansetzt; dazu, wo die
     * Regel sie kennt, {@code fassung} (Fassung bzw. Stand Nr.), {@code monate} (Rhythmus), {@code kennung} (das Objekt,
     * an dem die Regel ansetzt, oder die Herkunft), {@code quelle_art} (Herkunft einer Maßnahme bzw. Quelle einer
     * Feststellung) und {@code anzahl} (Korrekturen an einem Bericht).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Herleitung(String basis, LocalDate am, Integer fassung, Integer monate, String kennung,
            String quelleArt, Integer anzahl) {}

    /**
     * Wer die Frist erledigt: {@code herkunft} {@code objekt} (die verantwortliche Person am Objekt) oder {@code aufgabe}
     * (die Person der laufenden Zuordnung der Aufgabe der Zeile). {@code ich}: die Person ist die angemeldete.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zustaendig(String name, String herkunft, boolean ich) {}

    /**
     * Die Wiedervorlage am Abruf ({@code stichtag}, Zeitzone des Unternehmens): {@code faellig} am längsten fällig
     * zuerst, dann nach Kennzeichen; {@code vorschau} die nächsten {@code vorschau_tage} Tage; {@code nicht_in_liste} die
     * Kennzeichen mit späterer Frist. {@code verantwortung} ist der Verantwortungs-Satz (SP4).
     * {@code naechste_managementbewertung} (additiv, Folge AP-19 IP-24) ist die Frist von MG7 mit ihrer Herkunft — auch
     * außerhalb des Vorschau-Fensters; {@code null} ohne freigegebene Managementbewertung mit Sitzung.
     *
     * <p>Additiv seit Vertrag 1.1 (Konzept Wiedervorlage w1): {@code spaeter} der Jahresplan (nach dem Fenster bis
     * Abruf + 12 Monate, dieselbe Zeilenform), {@code anzahl_ueberfaellig} (abgelaufen), {@code anzahl_naechste} (heute
     * und das Fenster), {@code anzahl_spaeter}. Ein Gegenstand ist eine Zeile: die offenen Korrekturen eines Berichts
     * stehen in einer. {@code aufgaben_lesbar}: der Aufrufer liest die Aufgaben im Energiemanagement (unternehmensweit);
     * sonst bleibt {@code zustaendig} laut Aufgabe leer, ohne zu behaupten, dass niemand zuständig ist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wiedervorlage(OffsetDateTime stichtag, int vorschauTage, List<Zeile> faellig, List<Zeile> vorschau,
            int anzahlFaellig, int anzahlVorschau, List<String> nichtInListe, String verantwortung,
            NaechsteManagementbewertung naechsteManagementbewertung, List<Zeile> spaeter, int anzahlUeberfaellig,
            int anzahlNaechste, int anzahlSpaeter, boolean aufgabenLesbar) {}

    /**
     * MG7: die nächste Managementbewertung ist fällig am {@code faellig_am} = Tag der letzten Sitzung ({@code sitzung_am})
     * der freigegebenen Managementbewertung {@code kennzeichen} + {@code rhythmus_monate} — gerechnet in
     * {@code ManagementbewertungWiedervorlage}, derselben Stelle wie die Zeile der Wiedervorlage (WV2).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NaechsteManagementbewertung(LocalDate faelligAm, String kennzeichen, LocalDate sitzungAm,
            int rhythmusMonate) {}

    /**
     * Konzept Wiedervorlage w1: eine erledigte Frist, also eine Entscheidung, die eine Frist beendet oder neu beginnen
     * lässt. {@code art} ist die Art der Verzeichnis-Zeile ({@code gruppe} ihre Gruppe) oder {@code dokument_geprueft_bleibt} /
     * {@code bezugsbasis_geprueft_bleibt} („geprüft, bleibt“ steht nicht im Verzeichnis); {@code nr} Fassung bzw. Stand
     * Nr., {@code am} der Tag der Entscheidung, {@code entschieden_von} die Person, {@code eingetragen_von} das Konto.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Erledigt(String art, String gruppe, String kennzeichen, String titel, Integer nr, LocalDate am,
            String entschiedenVon, String eingetragenVon) {}

    /** Zuletzt erledigt: die letzten Entscheidungen in {@code tage} Tagen bis zum Abruf, die jüngste zuerst. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zuletzt(OffsetDateTime stichtag, int tage, List<Erledigt> eintraege) {}
}
