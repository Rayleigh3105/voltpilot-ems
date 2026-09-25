package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.Aenderung;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.Beleg;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.Eingetragen;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonKurz;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-7: Dokumente im Energiemanagement (DK1–DK8). Ein Dokument hat Art, Titel und Bezug; seine Fassungen
 * sind Wortlaut oder Verweis und werden mit „entschieden von“ freigegeben; Einträge halten Bekanntmachung, „geprüft,
 * bleibt“ und das Aufheben fest. Die Überprüfung wird beim Abruf abgeleitet, nie gespeichert.
 */
public final class EnergiemanagementDokumentDto {
    private EnergiemanagementDokumentDto() {}

    /** Der Bezug eines Dokuments: das Unternehmen oder ein Standort (Energieeinsatz, Person, Aufgabe folgen, IP-14). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezug(String art, UUID standortId) {}

    /** Dokument anlegen: Art, Titel, Bezug; wahlfrei Überprüfung in Monaten (nur Vorgabe-Arten) und das Original. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record DokumentAnlegen(String art, String titel, Bezug bezug, Integer ueberpruefungMonate, Beleg beleg) {}

    /** Ein Verweis (G3): wo das Original liegt — ohne Ablage keiner seiner Teile; die Prüfsumme bildet der Browser. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verweis(String bezeichnung, String ablage, String kennung, String adresse, String fassungsangabe,
            LocalDate datum, String sha256) {}

    /** Ein Ausschluss des Anwendungsbereichs: Art ({@code standort · anlage · prozess}), Verweis und Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ausschluss(String art, UUID verweis, String begruendung) {}

    /** DK7: Standorte, Energieträger (Vokabular des Betrachtungsumfangs) und Ausschlüsse einer Fassung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnwendungsbereichEingang(List<UUID> standortIds, List<String> traeger,
            List<Ausschluss> ausschluesse) {}

    /**
     * Fassung entwerfen: Wortlaut ODER Verweis; beim Anwendungsbereich Standorte und Träger; Begründung ab Fassung 2.
     * Ein offener Entwurf wird überschrieben (dieselbe Nr.), ein offener Antrag nicht.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungEntwerfen(String form, String wortlaut, Verweis verweis,
            AnwendungsbereichEingang anwendungsbereich, String begruendung, String beschlussKennung) {}

    /** Beantragen oder freigeben: wer entschieden hat (eine Person, auch ohne Konto), an welchem Tag, warum. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entscheid(UUID entschiedenVon, LocalDate entschiedenAm, String begruendung) {}

    /** Die zweite Person lehnt einen Antrag ab — mit Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ablehnen(String begruendung) {}

    /** „Geprüft, bleibt“ (DK5): entschieden von, am, Begründung, wahlfrei der Beschluss. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Geprueft(UUID entschiedenVon, LocalDate am, String begruendung, String beschlussKennung) {}

    /** Bekannt machen (DK6): an wen, am, über welchen Weg, durch welche Person — VoltPilot verschickt nichts. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bekanntmachen(String kreis, LocalDate am, String weg, String wegWortlaut, UUID personId) {}

    /** Aufheben (DK8): entschieden von, am, Begründung, wahlfrei der Beschluss — das Dokument bleibt lesbar. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Aufheben(UUID entschiedenVon, LocalDate am, String begruendung, String beschlussKennung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StandortKurz(UUID id, String kurzzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record BezugAus(String art, StandortKurz standort) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anwendungsbereich(List<StandortKurz> standorte, List<String> traeger,
            List<Ausschluss> ausschluesse) {}

    /**
     * Eine Fassung: {@code status} ist das gespeicherte Wort, bei einer früheren freigegebenen „abgeloest“ (DK4, beim
     * Lesen). {@code freigabe} ist das Konto, das die Entscheidung eingetragen (bei Vier-Augen: beantragt) hat,
     * {@code zweite_person} das Konto, das bei Vier-Augen bestätigt oder abgelehnt hat.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(int nr, String form, String wortlaut, Verweis verweis, Anwendungsbereich anwendungsbereich,
            String status, String begruendung, String beschlussKennung, String pruefsumme, boolean vieraugen,
            PersonKurz entschiedenVon, LocalDate entschiedenAm, String freigabeBegruendung, Eingetragen freigabe,
            Eingetragen zweitePerson, String ablehnungBegruendung, Instant freigegebenAm, Eingetragen eingetragen) {}

    /** Ein Eintrag: bekannt gemacht · geprüft, bleibt · aufgehoben · Kommentar. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eintrag(long id, String art, Integer fassung, LocalDate am, PersonKurz person,
            PersonKurz entschiedenVon, String kreis, String weg, String wegWortlaut, String begruendung,
            String beschlussKennung, String kommentar, String satz, Eingetragen eingetragen) {}

    /** DK5 beim Abruf (Vertrag {@code ueberpruefung}); {@code null} an einem aufgehobenen Dokument. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ueberpruefung(LocalDate abruf, LocalDate faelligAm, LocalDate basis, Integer fassung, Integer tage,
            String satz, String grund) {}

    /** Die Kundensätze der Seite (Vertrag §7), wörtlich; {@code null}, wo die Lage keinen trägt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Saetze(String kopf, String ueberpruefung, String freigabeGesperrt) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record DokumentKurz(UUID id, String kennzeichen, String art, String artWort, String klasse, String titel,
            BezugAus bezug, String zustand, Integer gueltigeFassung, Ueberpruefung ueberpruefung,
            Eingetragen eingetragen) {}

    public record Dokumente(List<DokumentKurz> dokumente) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Dokument(UUID id, String kennzeichen, String art, String artWort, String klasse, String titel,
            BezugAus bezug, String zustand, Integer ueberpruefungMonate, Beleg beleg, Integer gueltigeFassung,
            List<Fassung> fassungen, List<Eintrag> eintraege, Ueberpruefung ueberpruefung, Saetze saetze,
            Eingetragen eingetragen, List<Aenderung> verlauf) {}

    /** Der laufende Betrachtungsumfang der energetischen Bewertung (AP-16 U1), wie er am Abruf-Tag gilt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Betrachtungsumfang(int fassung, LocalDate gueltigAb, List<StandortKurz> standorte,
            List<String> traeger, String begruendung) {}

    /** Vertrag {@code anwendungsbereich_vergleich}: Mengen in beiden Richtungen, kein Urteil. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VergleichErgebnis(List<StandortKurz> standorteNurImAnwendungsbereich,
            List<StandortKurz> standorteNurImBetrachtungsumfang, List<String> traegerNurImAnwendungsbereich,
            List<String> traegerNurImBetrachtungsumfang, boolean deckungsgleich) {}

    /**
     * DK7, W5: der Anwendungsbereich (gültige Fassung) neben dem laufenden Betrachtungsumfang; ohne eines von beiden
     * {@code vergleich = null} und keine Sätze.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vergleich(LocalDate abruf, Integer fassung, Anwendungsbereich anwendungsbereich,
            Betrachtungsumfang betrachtungsumfang, VergleichErgebnis vergleich, List<String> saetze) {}
}
