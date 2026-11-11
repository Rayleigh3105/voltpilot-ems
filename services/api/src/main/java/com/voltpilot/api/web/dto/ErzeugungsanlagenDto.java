package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Die Erzeugungsanlagen einer Anlage am Stichtag (Messkonzepte S1, NUR ANZEIGE): je EA Identität, die Fassung am Tag,
 * alle Fassungen, die Komponenten, die sie speisen, und ihr Satz mit Herkunft ({@link Verguetung}); dazu die
 * Vorschläge weiterer EA und der Netzanschluss der Anlage am Tag. Fahrplan und Erlöse rechnen weiter mit dem Satz der
 * Anlage ({@code GET /api/v1/sites/{id}/einspeiseverguetung}).
 *
 * @param stichtag der Tag, für den Fassung und Satz gelten
 * @param netzanschluss der Netzanschluss, an dem die Anlage am Tag hängt; null = keiner angelegt oder gebunden
 * @param erzeugungsanlagen die nicht aufgehobenen EA nach Nummer
 * @param vorschlaege weitere Erzeuger mit kWp, die keine EA speisen - nie still angelegt
 */
public record ErzeugungsanlagenDto(
        LocalDate stichtag,
        Netzanschluss netzanschluss,
        List<Erzeugungsanlage> erzeugungsanlagen,
        List<Vorschlag> vorschlaege) {

    public record Netzanschluss(UUID id, String kennzeichen, String name) {
    }

    /**
     * @param bezeichnung „EA 1“ oder „EA 2 · PV Scheune“ - nie „Anlage“ allein (F2)
     * @param art pv · wind · wasser · biomasse · kwk · sonstige (Vokabular {@code energietraeger} des Katalogs)
     * @param inbetriebnahme null = nicht erhoben
     * @param inbetriebnahmeAbSolarspitzengesetz nur ohne Inbetriebnahme: ab dem 25.02.2025?
     * @param folgtAnlage EA 1 einer Anlage mit einer EA: Leistung, Inbetriebnahme, MaStR-Einheit und eigener Satz
     *     kommen aus der Anlage (Registrierung, PV-Leistung, Karte „Einspeisevergütung“)
     * @param fassung die Fassung am Stichtag; null = noch keine gilt
     */
    public record Erzeugungsanlage(
            UUID id,
            int nummer,
            String name,
            String bezeichnung,
            String art,
            LocalDate inbetriebnahme,
            Boolean inbetriebnahmeAbSolarspitzengesetz,
            String registryUnitId,
            Instant registryFetchedAt,
            boolean folgtAnlage,
            Fassung fassung,
            List<Fassung> fassungen,
            List<Komponente> komponenten,
            Verguetung verguetung) {
    }

    /**
     * @param gueltigAb null = von der Inbetriebnahme an
     * @param einspeiseart voll · ueberschuss; null = nicht erhoben
     * @param herkunft bestand (folgt der Anlage) · mastr (bestätigte Registerwerte) · angegeben
     */
    public record Fassung(
            UUID id,
            LocalDate gueltigAb,
            BigDecimal leistungKwp,
            String einspeiseart,
            BigDecimal satzAngegebenCtKwh,
            String herkunft) {
    }

    /** @param eingang null = die ganze Komponente, sonst ihr Eingang k */
    public record Komponente(
            UUID id,
            UUID komponenteId,
            String name,
            Integer eingang,
            LocalDate gueltigAb,
            LocalDate gueltigBis) {
    }

    /**
     * Der Satz der EA mit Herkunft - Vokabular wie die Karte „Einspeisevergütung“.
     *
     * @param zustand angegeben · eeg · eeg_abgelaufen · ohne_angabe · netzladen · direktvermarktung
     * @param naeherung vor_erstem_band · jahresstufen · volleinspeisung · leistung_unbekannt (leer = genau)
     * @param foerderendeAm letzter Tag der EEG-Vergütung (31.12. im 20. Jahr nach dem Inbetriebnahmejahr)
     */
    public record Verguetung(
            String zustand,
            BigDecimal wirksamCtKwh,
            BigDecimal angegebenCtKwh,
            BigDecimal hergeleitetCtKwh,
            List<String> naeherung,
            LocalDate foerderendeAm,
            boolean ohneVerguetungBeiNegativpreis) {
    }

    /** @param registryUnitId die MaStR-Nummer, die am Erzeuger eingetragen ist (wird nicht geprüft); null = keine */
    public record Vorschlag(UUID komponenteId, String name, BigDecimal leistungKwp, String registryUnitId) {
    }

    // ------------------------------------------------------------------------------------------ Anfragen

    /**
     * Eine EA anlegen. {@code mastrBestaetigt}: die Angaben kommen aus dem Nachschlagen im Marktstammdatenregister
     * und der Kunde hat sie bestätigt ({@code POST …/mastr-lookup}). {@code komponenteId}: die Komponente, die sie
     * speist (z. B. aus einem Vorschlag), {@code eingang} ihr Eingang k oder null für die ganze.
     */
    public record Anlegen(
            String name,
            String art,
            LocalDate inbetriebnahme,
            Boolean inbetriebnahmeAbSolarspitzengesetz,
            String registryUnitId,
            boolean mastrBestaetigt,
            BigDecimal leistungKwp,
            String einspeiseart,
            BigDecimal satzAngegebenCtKwh,
            UUID komponenteId,
            Integer eingang) {
    }

    /** Die Identität in voller Darstellung: ein Feld, das fehlt, ist leer. */
    public record Bearbeiten(
            String name,
            String art,
            LocalDate inbetriebnahme,
            Boolean inbetriebnahmeAbSolarspitzengesetz,
            String registryUnitId,
            boolean mastrBestaetigt) {
    }

    /** Eine Fassung ab {@code gueltigAb} (null = von der Inbetriebnahme an); am selben Tag ersetzt sie die alte. */
    public record FassungSetzen(
            LocalDate gueltigAb,
            BigDecimal leistungKwp,
            String einspeiseart,
            BigDecimal satzAngegebenCtKwh,
            boolean mastrBestaetigt) {
    }

    /** {@code gueltigAb} null = heute. */
    public record Verweisen(UUID komponenteId, Integer eingang, LocalDate gueltigAb) {
    }
}
