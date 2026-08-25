package com.voltpilot.api.web.dto;

import com.voltpilot.api.repo.EntityHistoryRepository.Bucket;
import java.time.Instant;
import java.util.List;

/**
 * Die WERTE der eigenen Auswertungen einer Anlage (Anwendungs-Programm
 * Stufe 5, {@code GET /api/v1/sites/{id}/eigene-auswertung}).
 *
 * <p>Bewusst EINE schmale Route statt einer je Kachel: ein Cockpit rendert alle
 * eigenen Bausteine zusammen, und mehrere Kacheln auf derselben Komponente
 * teilen sich serverseitig eine Abfrage.
 *
 * <p>Die Route liefert die Werte der GESPEICHERTEN Auswertungen — sie nimmt
 * keine Definition entgegen. Was auf dem Cockpit steht, entscheidet das
 * Layout-Dokument, und eine Route, die eine mitgeschickte Definition
 * beantwortet, wäre ein zweiter Weg an der Prüfung des Schreibpfads vorbei.
 *
 * @param at            der Anker-Tag (Europe/Berlin, {@code YYYY-MM-DD})
 * @param from          Beginn des Tagesfensters
 * @param to            Ende des Tagesfensters
 * @param bucketMinutes die Eimer-Breite der Kurve (15)
 * @param werte         eine Zeile je gespeicherter Auswertung
 */
public record EigeneAuswertungDto(String at, Instant from, Instant to, int bucketMinutes,
        List<WertDto> werte) {

    /**
     * Der Wert EINER eigenen Auswertung.
     *
     * <p><b>{@code wert} ist {@code null}, wo es keinen gibt — nie eine 0.</b>
     * Eine Kachel ohne Messung sagt das; sie behauptet keine Null.
     *
     * @param id          der Baustein-Schlüssel ({@code eigen:…})
     * @param titel       die Überschrift des Kunden
     * @param darstellung {@code kachel} | {@code chart}
     * @param entityId    die Komponente
     * @param channel     ihr Messwert-Kanal
     * @param aggregat    die gewählte Kennzahl
     * @param wert        die Zahl, oder null
     * @param kanalart    {@code energie}|{@code leistung}|{@code anteil}|{@code messwert}
     *                    — sie sagt der Fläche, welche Einheit und welcher
     *                    Zeitbezug gemeint sind, ohne dass sie den Kanalnamen
     *                    zerlegen muss
     * @param komponente  der Name der Komponente (für die Unterzeile)
     * @param entityType  ihr Typ (für das Rollen-Symbol)
     * @param hinweis     der ehrliche deutsche Satz, wenn es nichts zu zeigen
     *                    gibt; sonst null
     * @param verlauf     die Tages-Eimer — NUR bei {@code chart} gefüllt
     */
    public record WertDto(String id, String titel, String darstellung, String entityId,
            String channel, String aggregat, Double wert, String kanalart, String komponente,
            String entityType, String hinweis, List<Bucket> verlauf) {}
}
