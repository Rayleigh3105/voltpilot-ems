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

    public record Fassung(int fassung, String zustand, String contentHash, JsonNode bericht, Instant angelegtAm,
            String angelegtVon, Instant stillgelegtAm, Instant scharfAm, String scharfVon, JsonNode hinweise) {}

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
}
