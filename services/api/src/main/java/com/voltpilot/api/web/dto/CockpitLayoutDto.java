package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Die Layout-Antwort einer Fläche (Anwendungs-Programm Stufe 3).
 *
 * <p>Sie liefert ALLE Schichten getrennt, nicht das aufgelöste Ergebnis: die
 * Auflösung ist eine reine Funktion und wohnt im Portal
 * ({@code cockpitLayout.ts layoutResolve}) — der Server hält Katalog und
 * Absicht, nie die abgeleitete Fläche (BUILD.md §4.1, „kein {@code /surface}").
 * Getrennt müssen sie sein, damit die Fläche sagen kann, WORAUF ein
 * „Zurücksetzen" fällt („auf die Vorgabe Ihres Betreibers" vs. „auf den
 * VoltPilot-Standard") — Captain-Entscheid E2.
 *
 * @param surface       {@code cockpit} (Stufe 4: {@code portfolio})
 * @param profil        das Preset der Anlage ({@code privat}|{@code gewerbe}|null)
 * @param presetLayout  die Preset-Schicht aus dem Katalog (nie null, evtl. leer)
 * @param tenantVorgabe die kunden-weite Vorgabe, oder null
 * @param siteVorgabe   die Vorgabe DIESER Anlage, oder null (schlägt die kunden-weite)
 * @param eigen         der Wille des Kunden, oder null — er GEWINNT
 * @param bausteine     der Baustein-Katalog dieser Fläche (Labels, Pflicht, Lead)
 * @param darfVorgabe   true = dieser Aufrufer darf die Vorgabe-Schicht schreiben
 * @param vorlagen      die ARTEN eigener Auswertungen, die diese Fläche kennt
 *                      (Stufe 5; leer, wo es keine gibt)
 */
public record CockpitLayoutDto(String surface, String profil, LayoutDocumentDto presetLayout,
        LayerDto tenantVorgabe, LayerDto siteVorgabe, LayerDto eigen, List<BausteinDto> bausteine,
        boolean darfVorgabe, List<VorlageDto> vorlagen) {

    /**
     * Ein Layout-Dokument: NUR Absicht.
     *
     * @param version die Dokument-Fassung (heute immer 1)
     * @param order   genannte Bausteine in ihrer Reihenfolge; ungenannte
     *                bleiben an ihrer kanonischen Stelle
     * @param hidden  ausdrücklich ausgeblendet (Pflicht-Bausteine ignorieren es)
     * @param shown   ausdrücklich gezeigt — nimmt einer TIEFEREN Schicht ihr
     *                {@code hidden} zurück
     * @param lead    der hervorgehobene Block, oder null
     * @param custom  die EIGENEN Auswertungen dieses Dokuments (Stufe 5). Sie
     *                sind die einzigen Bausteine, die das Dokument selbst
     *                DEFINIERT statt nur zu nennen — ihr Schlüssel steht
     *                zusätzlich in {@code order}/{@code hidden}.
     */
    public record LayoutDocumentDto(int version, List<String> order, List<String> hidden,
            List<String> shown, String lead, List<CustomBausteinDto> custom, List<String> seen) {}

    /**
     * Eine eigene Auswertung: Titel, Darstellung und die QUELLE (Komponente ×
     * Messwert × Kennzahl). Ob die Kennzahl zu diesem Messwert ehrlich ist,
     * entscheidet der Server ({@code cockpit/EigeneAuswertung}) — hier steht
     * nur, was gespeichert wurde.
     */
    public record CustomBausteinDto(String id, String titel, String darstellung, String entityId,
            String channel, String aggregat) {}

    /**
     * Eine ART eigener Auswertung, wie der Katalog sie beschreibt — die Wahl im
     * Anlege-Dialog. Sie ist NICHT renderbar; erst ihre Instanz ist es.
     *
     * @param nach der Baustein, hinter dem eine Instanz kanonisch einsortiert wird
     */
    public record VorlageDto(String id, String label, String satz, String darstellung,
            String anwendung, String nach) {}

    /** Eine gespeicherte Schicht samt Papier-Spur. */
    public record LayerDto(LayoutDocumentDto document, String updatedBy, Instant updatedAt) {}

    /**
     * Ein Baustein des Katalogs.
     *
     * @param id             der Schlüssel des Dokuments
     * @param label          der kundenseitige deutsche Name
     * @param pflicht        true = nie ausblendbar (E2)
     * @param beweglich      false = bleibt an seiner kanonischen Stelle
     * @param leadBlock      der Block, den sein Stern als Lead setzt, oder null
     * @param beigesteuertVon die Anwendungen, die ihn beisteuern (leer = Basis)
     */
    public record BausteinDto(String id, String label, boolean pflicht, boolean beweglich,
            String leadBlock, List<String> beigesteuertVon) {}
}
