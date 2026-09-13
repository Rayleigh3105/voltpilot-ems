package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Verteilungs-Schnittstelle (UEMS AP-10 IP-8): {@code PUT/GET /api/v1/messstellen/{id}/verteilung}.
 * snake_case wie die übrigen UEMS-Schnittstellen; Tage als {@code JJJJ-MM-TT}, {@code gueltig_bis} ist der
 * LETZTE gültige Tag (einschließlich), {@code null} = offen. Ein Anteil reist als Dezimaltext
 * ({@code "70"}, {@code "33.5"}) — nie als Gleitkommazahl.
 */
public final class VerteilungDto {
    private VerteilungDto() {}

    /**
     * {@code PUT …/verteilung}: ab {@code gueltig_ab} gilt GENAU dieser Satz — alle Ziele eines Tages in einer
     * Anfrage ({@code zeilen} leer = ab dem Tag „nicht verteilt“). {@code korrektur}: der Satz ersetzt den, der
     * genau an diesem Tag beginnt (er bleibt aufgehoben lesbar).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Setzen(String gueltigAb, List<ZeileEingabe> zeilen, Boolean korrektur, String grund) {}

    /** Eine Zeile des Satzes: die Kostenstelle und ihr Anteil in Prozent. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record ZeileEingabe(String kostenstelleId, String anteilProzent) {}

    /** Ein Verweis auf die Kostenstelle: ID und Kennzeichen. */
    public record Kostenstelle(UUID id, String kennzeichen) {}

    /**
     * Ein Anteil der Messstelle an einer Kostenstelle über Tage; {@code endet_mit_kostenstelle}: der letzte Tag ist
     * der ihrer Kostenstelle (die Zeile gilt nie länger als ihr Ziel).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anteil(UUID id, Kostenstelle kostenstelle, String name, String anteilProzent, LocalDate gueltigAb,
            LocalDate gueltigBis, boolean endetMitKostenstelle) {}

    /**
     * Die Verteilung einer Messstelle: ohne {@code am} alle wirksamen Anteile (jede Fassung); mit {@code am} die an
     * dem Tag geltenden und der {@code zustand} des Tages — {@code verteilt} oder ausdrücklich {@code nicht verteilt}
     * (nie „zu 0 % verteilt“); ohne {@code am} ist er {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verteilung(UUID messstelleId, String kennzeichen, LocalDate am,
            String zustand, List<Anteil> anteile) {}
}
