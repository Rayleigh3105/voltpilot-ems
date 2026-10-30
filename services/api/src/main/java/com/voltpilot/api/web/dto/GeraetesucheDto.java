package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Antworten der Gerätesuche (OpenAPI-Tag {@code geraetesuche}: {@code Geraetesuche}, {@code GeraetesucheVerlauf},
 * {@code GeraetesucheFehler}). Jedes Feld ist immer da; was (noch) unbekannt ist, ist null - nie 0. Keine MAC, kein
 * Hostname (DP-3 A).
 */
public final class GeraetesucheDto {

    private GeraetesucheDto() {
    }

    /** {@code ProtokollUrheber}: Name der Person, Rolle und Art im Akteur-Vokabular von AP-03. */
    public record Urheber(String name, String rolle, String art) {
    }

    public record Suche(UUID suchId, UUID deviceId, String zustand, String grund, Instant gestartetAm,
            Urheber gestartetVon, Instant beendetAm, Integer dauerMs, String schritt, Integer erledigt, Integer gesamt,
            Integer restSekunden, List<Netz> netze, List<String> erkenner, List<Gruppe> gruppen, Weitere weitere,
            List<LadesaeuleKlopftAn> ladesaeulenKlopfenAn) {
    }

    public record Netz(String rolle, String netz, String boxAdresse, Boolean ausschnitt, boolean erreichbar,
            int aktiv) {
    }

    public record Gruppe(String gruppe, List<Fund> funde) {
    }

    /**
     * @param verbindung die Verbindungsfelder in den Schlüsseln der Vorlagen ({@code communication}, {@code ip},
     *                   {@code port}, {@code serial}, {@code unit_id}); genau so gehen sie als {@code connection} an
     *                   {@code POST …/component-test}
     */
    public record Fund(String schluessel, String erkenner, String art, String hersteller, String modell,
            String seriennummer, String firmware, String familie, String spannung, Integer kanaele, String erkennung,
            List<String> merkmale, String anbindung, String hindernis, Map<String, Object> verbindung,
            boolean liestBoxSchon, String abgleich, Komponente komponente, String bekannteAdresse,
            List<String> vorlagen) {
    }

    public record Komponente(UUID id, String name) {
    }

    public record Weitere(Integer telefonTablet, Integer rechner, Integer unbekannt) {
    }

    public record LadesaeuleKlopftAn(String chargePointId, String ip, Instant zuerst, Instant zuletzt, int versuche) {
    }

    public record Verlauf(List<VerlaufEintrag> suchen) {
    }

    /** @param zaehler Funde je Gruppe, alle sechs in fester Reihenfolge */
    public record VerlaufEintrag(UUID suchId, UUID deviceId, String zustand, String grund, Instant gestartetAm,
            Urheber gestartetVon, Integer dauerMs, Map<String, Integer> zaehler) {
    }

    /** {@code GeraetesucheFehler}: Code, der deutsche Satz und die Fakten zum Grund. */
    public record Fehler(String code, String message, UUID suchId, Instant zuletztGesehen, Instant wiederAb) {
    }
}
