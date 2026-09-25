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

    /**
     * Der Bezug eines Dokuments (DK1, G5): das Unternehmen, ein Standort, ein Energieeinsatz, eine Person oder eine
     * Aufgabe (eine Zuordnung) — genau die Kennung seiner Art ist gesetzt. Den Standort eines Einsatzes leitet der Dienst
     * ab (IP-14), er kommt nie aus der Anfrage.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezug(String art, UUID standortId, UUID energieeinsatzId, UUID personId, UUID aufgabeId) {}

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
    public record EinsatzKurz(UUID id, String kennzeichen, String name) {}

    /** Eine Aufgabe als Bezug: die Zuordnung mit dem Wort der Aufgabe (bei „weitere“ ihr Wortlaut) und ihrer Person. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AufgabeKurz(UUID id, String aufgabe, String wort, PersonKurz person) {}

    /**
     * Woran das Dokument hängt: {@code standort} ist der Zaun (beim Energieeinsatz abgeleitet, an Unternehmen, Person
     * und Aufgabe {@code null}); je Art ist genau einer von {@code energieeinsatz}, {@code person}, {@code aufgabe}
     * gesetzt — oder keiner.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record BezugAus(String art, StandortKurz standort, EinsatzKurz energieeinsatz, PersonKurz person,
            AufgabeKurz aufgabe) {}

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

    // ------------------------------------------------------------------ IP-14: Nachweise

    /**
     * KS1, G1: wo der Inhalt der gültigen Fassung liegt. {@code ort} ist das Wort des Vertrags ({@code in_voltpilot ·
     * wortlaut_original_beim_kunden · verweis}), {@code ort_satz} die Zeile des Verzeichnisses, {@code satz} der
     * Kundensatz mit Kennung und Fassungsangabe; die Angaben sind die des Verweises bzw. des Originals. Eine Adresse wird
     * nur mit {@code https:} als Verweis gezeigt ({@code adresse_als_verweis}); VoltPilot öffnet, prüft und lädt nichts.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NachweisOrt(String ort, String ortSatz, String satz, boolean inhaltInVoltpilot, int fassung,
            LocalDate festgehaltenAm, String ablage, String kennung, String adresse, boolean adresseAlsVerweis,
            String fassungsangabe, LocalDate datum, String sha256) {}

    /**
     * DK6: eine Bekanntmachung — an einen Kreis, an einem Tag, durch eine Person, über einen oder mehrere Wege. Die
     * Einträge je Weg sind eine Mitteilung ({@code wege} in ihrer Reihenfolge, {@code wege_wort} „Aushang und
     * Intranet“); VoltPilot hat nichts verschickt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kommunikationsnachweis(UUID dokumentId, String kennzeichen, String titel, String art, int fassung,
            LocalDate am, String kreis, List<String> wege, String wegeWort, PersonKurz person, String satz) {}

    /** Die Bekanntmachungen aller Dokumente im Zaun, nach Tag und Kennzeichen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kommunikationsnachweise(LocalDate abruf, List<Kommunikationsnachweis> bekanntmachungen) {}

    /** Ein Dokument als Nachweis: Art, Titel, Bezug, Ort der gültigen Fassung, Überprüfung beim Abruf, Bekanntmachungen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Nachweis(UUID id, String kennzeichen, String art, String artWort, String klasse, String titel,
            BezugAus bezug, String zustand, Integer gueltigeFassung, NachweisOrt ort, Ueberpruefung ueberpruefung,
            List<Kommunikationsnachweis> bekanntmachungen) {}

    /** Der Abschnitt „Nachweise“ am Energieeinsatz (R7). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NachweiseAmEinsatz(EinsatzKurz energieeinsatz, LocalDate abruf, List<Nachweis> nachweise) {}

    /** Die Nachweise an einer Person: an ihr selbst und an ihren Aufgaben (R8). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NachweiseDerPerson(PersonKurz person, LocalDate abruf, List<Nachweis> nachweise) {}

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
