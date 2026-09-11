package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Geräte-Schnittstelle (UEMS AP-04 IP-10, {@code /api/v1/sites/{siteId}/geraete}
 * und {@code /api/v1/geraete/{id}}).
 *
 * <p>In snake_case wie die übrigen UEMS-Schnittstellen: dieselben Wörter wie die Verträge —
 * {@code kennzeichen} ist das Gerät (GR-4), {@code einbau_kennzeichen} das konkret eingebaute
 * (Z-5a), das Paar {@code geraet}/{@code einbau} des Herkunfts- und des Messstellen-Vertrags.
 * Zeitpunkte auf die Minute mit dem Versatz von Europe/Berlin. Fakten, keine Sätze: ob ein
 * Gerät eingebaut ist, sagt {@code ausgebaut_am == null}; welches Wort daraus wird, entscheidet
 * die Geräteseite (IP-12).
 */
public final class GeraetDto {
    private GeraetDto() {}

    /**
     * Ein Einbau. {@code aus_bestand}: aus der Komponente abgeleitet (Bestand oder Anlege-Weg,
     * dieselbe Regel — V20260911240000) — dann ist {@code eingebaut_am} der Beginn ihres
     * Verlaufs in VoltPilot, nicht der Einbautag.
     * {@code seriennummer}, {@code hersteller}, {@code typ}, {@code bezeichnung},
     * {@code data_source_id} und {@code geraete_id} sind {@code null}, solange nichts erhoben
     * ist — nie geraten. {@code vorgaenger}: die früheren Einbauten desselben Geräts, der
     * jüngste zuerst.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Geraet(
            UUID id,
            UUID siteId,
            String kennzeichen,
            String einbauKennzeichen,
            String geraeteart,
            String hersteller,
            String typ,
            String seriennummer,
            String bezeichnung,
            UUID dataSourceId,
            Integer geraeteId,
            OffsetDateTime eingebautAm,
            OffsetDateTime ausgebautAm,
            boolean ausBestand,
            List<Komponente> komponenten,
            List<Teil> teile,
            List<Vorgaenger> vorgaenger) {}

    /**
     * Ein Zeitraum, in dem der Einbau die Komponente speist, halboffen {@code [ab, bis)};
     * {@code gueltig_bis == null} heißt „bis auf Weiteres". Über eine Karte ({@code teil_id} +
     * {@code steckplatz}) oder direkt ({@code null}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Komponente(
            UUID entityId,
            UUID teilId,
            Integer steckplatz,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis) {}

    /** Eine Energiekarte im Steckplatz eines Controllers; {@code steckplatz == null} = nicht erhoben. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Teil(
            UUID id,
            String teilart,
            Integer steckplatz,
            String bezeichnung,
            String typ,
            String seriennummer,
            OffsetDateTime eingebautAm,
            OffsetDateTime ausgebautAm) {}

    /** Ein früherer Einbau desselben Geräts — „Z-5a · ausgebaut am 18.11.2026 10:40". */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorgaenger(
            UUID id,
            String einbauKennzeichen,
            String hersteller,
            String typ,
            String seriennummer,
            OffsetDateTime eingebautAm,
            OffsetDateTime ausgebautAm) {}

    /** Die Liste als Objekt, nicht als nacktes Array — erweiterbar, ohne die Form zu brechen. */
    public record Liste(List<Geraet> geraete) {}
}
