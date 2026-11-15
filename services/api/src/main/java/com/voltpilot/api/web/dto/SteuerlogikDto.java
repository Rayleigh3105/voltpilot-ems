package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Antworten der Steuerlogik-Routen: der Plattform ({@code /api/v1/admin/sites/{siteId}/steuerlogik}) und, seit Stufe 3,
 * des Kunden ({@code /api/v1/sites/{siteId}/steuerlogik}: Karte, Blatt "Warum?", Verlauf, gestellte Werte).
 */
public final class SteuerlogikDto {

    private SteuerlogikDto() {
    }

    /**
     * Eine Logik als Text (YAML-Schreibform oder kanonisches JSON). {@code scharf} lässt die neue Fassung gleich
     * scharf gehen (ein protokollierter Schritt), {@code bestaetigt} bestätigt die Hinweise des Dialogs.
     */
    public record Text(String text, Boolean scharf, Boolean bestaetigt) {

        public Text(String text) {
            this(text, null, null);
        }
    }

    /** Die angenommene oder geänderte Fassung, ob der Satz an die Box ging und welche Werte sie verworfen hat. */
    public record Angenommen(UUID logikId, int fassung, String name, String contentHash, JsonNode bericht,
            UUID box, boolean veroeffentlicht, String zustand, List<Verworfen> verworfen) {}

    /** Ein gestellter Wert, den eine neue Fassung nicht übernimmt. */
    public record Verworfen(String kennung, String grund) {}

    /** Das Blatt der Plattform: die Logiken der Anlage und ihr Lauf. */
    public record Blatt(UUID box, boolean boxKann, boolean boxKannScharf, List<Logik> logiken) {}

    /**
     * Eine Logik mit ihren Fassungen (jüngste zuerst), der Quittung der Box, dem gemeldeten Lauf und den gestellten
     * Werten.
     */
    public record Logik(UUID logikId, String name, List<Fassung> fassungen, Quittung quittung, List<Lauf> laeufe,
            Einstellung einstellung) {}

    /**
     * Eine Fassung im Blatt der Plattform. Stufe 4: Rolle des Urhebers, Notiz und wer sie wann zur Freigabe vorgelegt
     * hat ({@code null}, wenn nicht).
     */
    public record Fassung(int fassung, String zustand, String contentHash, JsonNode bericht, Instant angelegtAm,
            String angelegtVon, Instant stillgelegtAm, Instant scharfAm, String scharfVon, JsonNode hinweise,
            String angelegtRolle, String notiz, Instant vorgelegtAm, String vorgelegtVon) {

        public Fassung(int fassung, String zustand, String contentHash, JsonNode bericht, Instant angelegtAm,
                String angelegtVon, Instant stillgelegtAm, Instant scharfAm, String scharfVon, JsonNode hinweise) {
            this(fassung, zustand, contentHash, bericht, angelegtAm, angelegtVon, stillgelegtAm, scharfAm, scharfVon,
                    hinweise, null, null, null, null);
        }
    }

    /** Die gestellten Werte einer Logik (Form des Dokuments) und ihr Stand. */
    public record Einstellung(long stand, JsonNode werte) {}

    /** Bestätigt das Scharfschalten einer Fassung. */
    public record Scharf(Integer fassung, Boolean bestaetigt) {}

    /** Was der Dialog "Scharf schalten" zeigt. */
    public record Vorschau(UUID logikId, int fassung, String name, String zustand, boolean boxKann, JsonNode bericht,
            List<String> hinweise, List<Konflikt> konflikte, List<String> geraete, List<String> kundeStellt,
            boolean moeglich) {}

    /** Ein Grund, warum eine Logik ein Gerät nicht bekommt. */
    public record Konflikt(UUID entityId, String geraet, String art, String text) {}

    /** Ein gestellter Wert: Wert in der Form des Dokuments ({@code "72 °C"}, {@code "on"}, {@code "06:00"}). */
    public record Wert(JsonNode wert) {}

    /** Ein Wert ist gestellt: Stand und ob der Satz an die Box ging. */
    public record Gestellt(UUID logikId, String kennung, JsonNode wert, long stand, boolean veroeffentlicht) {}

    /** Ein Schritt des Protokolls. */
    public record Schritt(int fassung, String was, Instant am, String von, String rolle, JsonNode daten) {}

    /** Die Schritte eines Tages. */
    public record Schritte(UUID logikId, String tag, List<Schritt> schritte) {}

    // --- Kunde -------------------------------------------------------------------------------------------------

    /** Die scharfen Logiken der Anlage für den Kunden. */
    public record Karten(List<Karte> logiken) {}

    /**
     * Eine scharfe Logik, wie der Kunde sie sieht: Lage, Störungen (die erste zeigt die Karte), die Geräte mit
     * Wunsch, Schaltstand, Befehl und Grund, die Werte mit Recht und Hilfe, die Liste "Warum?" und die Meldungen.
     * {@code gemeldetAm} ist das Alter dessen, was die Box zuletzt sagte; ohne Meldung fehlen Lage und Liste.
     */
    public record Karte(UUID logikId, String name, int fassung, Instant scharfSeit, Instant gemeldetAm,
            JsonNode lage, List<Stoerung> stoerungen, List<Geraet> geraete, List<Stellwert> stellwerte,
            long stand, Long standBox, JsonNode warum, JsonNode meldungen) {}

    public record Stoerung(String code, String text) {}

    /** Ein Gerät der Logik jetzt; die Teile kommen aus der Rückmeldung der Box, unbekannt fehlt. */
    public record Geraet(String kennung, String entityId, String name, JsonNode wunsch, JsonNode ist,
            JsonNode befehl, String halter, JsonNode schutz, JsonNode konflikt) {}

    /**
     * Ein Stellwert für die Oberfläche: Beschreibung aus dem Prüfbericht, der gestellte Wert der Cloud, was die Box
     * gerade anwendet (Anzeige und Hilfesatz), ob er zu „Das stellen Sie ein“ gehört ({@code frei}: Zielwert oder
     * {@code editable_by: customer}) und ob DIESER Aufrufer ihn ändern darf.
     */
    public record Stellwert(String kennung, String name, String art, String einheit, Double von, Double bis,
            Double schritt, JsonNode optionen, boolean zielwert, String darf, JsonNode wert, JsonNode wertBox,
            String text, String hilfe, boolean frei, boolean aendern, boolean uebernommen) {}

    /** Der Verlauf eines Tages: die Schaltungen (Wunsch und Schaltstand) und die Schritte von Menschen. */
    public record Verlauf(UUID logikId, String tag, List<Wechsel> wechsel, List<Schritt> schritte) {}

    /** Was die Box im Block {@code flows.applied} zur Logik quittiert. */
    public record Quittung(int fassung, String contentHash, String zustand, String detail, Instant gemeldetAm) {}

    /** Der jüngste Block {@code logik} einer Box zu dieser Logik, bereinigt. */
    public record Lauf(UUID box, int fassung, String contentHash, String zustand, Instant seit,
            JsonNode rueckmeldung, Instant gemeldetAm) {}

    /** Das Vergleichsprotokoll eines Tages. */
    public record Protokoll(UUID logikId, String tag, List<Wechsel> wechsel) {}

    public record Wechsel(UUID box, int fassung, Instant laufSeit, long nr, Instant t, String geraet, String was,
            JsonNode neu, JsonNode andere, String lage) {}

    // --- Stufe 4: Aufbau und Text --------------------------------------------------------------------------------

    /** Ein Text zum Prüfen (YAML-Schreibform oder kanonisches JSON). */
    public record Pruefen(String text) {}

    /**
     * Das Ergebnis der Prüfung: {@code lesbar} mit Bericht ({@code sperrt}, Proben, Stellwerte ...) oder unlesbar mit
     * dem Satz des Lesers; {@code meldungen} je Befund, Probe und Hinweis mit der Zeile im Text.
     */
    public record Geprueft(boolean lesbar, boolean sperrt, String message, JsonNode bericht, JsonNode meldungen) {}

    /** Ein Text als neue Fassung: Notiz und die Fassung, von der die Änderung ausging. */
    public record Speichern(String text, String notiz, Integer basis) {}

    /** Die gespeicherte Fassung (Zustand {@code geprueft}). */
    public record Gespeichert(UUID logikId, int fassung, String name, String contentHash, JsonNode bericht) {}

    /** Die Logiken der Anlage im Reiter "Regeln", mit den Rechten des Aufrufers. */
    public record Logiken(boolean darfBearbeiten, boolean darfAnfragen, List<LogikKopf> logiken) {}

    /**
     * Eine Logik im Überblick: neueste Fassung, die aktive mit ihrem Zustand ({@code null} = läuft nicht), die
     * vorgelegte, die auf die Freigabe wartet, offene Anfragen und wann die Box zuletzt von ihr berichtete.
     */
    public record LogikKopf(UUID logikId, String name, int neueste, Integer aktiv, String zustand, Integer vorgelegt,
            int offeneAnfragen, Instant gemeldetAm, JsonNode lage) {}

    /** Eine Logik zum Ansehen und Bearbeiten. */
    public record LogikAnsicht(UUID logikId, String name, boolean darfBearbeiten, boolean darfAnfragen,
            boolean plattform, boolean boxKann, boolean boxKannScharf, List<FassungKopf> fassungen,
            List<Anfrage> anfragen, Einstellung einstellung, Lauf lauf, boolean darfBausteinSpeichern) {}

    /**
     * Eine Fassung im Portal: Zustand ({@code geprueft}, {@code mitlaufend}, {@code scharf}, {@code stillgelegt}),
     * Urheber mit Anzeigename und Rolle, Notiz, Scharf und Vorlage, der Prüfbericht (Stellwerte, Proben).
     */
    public record FassungKopf(int fassung, String zustand, String contentHash, Instant angelegtAm, String angelegtVon,
            String rolle, String notiz, Instant scharfAm, Instant vorgelegtAm, String vorgelegtVon, JsonNode bericht) {}

    /** Der Text einer Fassung, wie er gespeichert wurde. */
    public record FassungText(UUID logikId, int fassung, String zustand, String text, JsonNode bericht) {}

    /** Eine Anfrage an einer Logik ("Änderung anfragen"). */
    public record Anfrage(UUID id, String kennung, String text, Instant am, String von, String rolle,
            Instant erledigtAm, String erledigtVon) {}

    /** Eine neue Anfrage: zu einem Wert ({@code kennung}) oder zur ganzen Logik. */
    public record AnfrageNeu(String kennung, String text) {}

    /** Die Schritte an einer Logik über einen Zeitraum (Tage der Anlage, letzter eingeschlossen). */
    public record Zeitraum(UUID logikId, String von, String bis, List<Schritt> schritte) {}
}
