package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Der EINE Flotten-Aggregat hinter {@code GET /api/v1/admin/fleet} (Admin-Umbau
 * Stufe 2): eine Zeile je Anlage über ALLE Mandanten, mit allem, was der
 * Flotten-Puls braucht - und nur damit.
 *
 * <p>Er löst die Client-Schleife der Stufe 1 ab (je Mandant {@code /overview} +
 * Anlagen + {@code /edge-versions}, dazu je Anlage die Quellen und beim
 * Aufklappen zwei Steuerungs-Belege). Die Oberfläche bleibt dieselbe - nur die
 * Datenquelle wechselt.
 *
 * <p><b>Ehrlichkeit ist Teil des Vertrags:</b> ein Block, den niemand gemessen
 * hat, ist {@code null} und trägt seinen Grund ({@code reason}) - nie eine
 * erfundene Null und nie ein geratener Zustand. Wer eine Zahl zeigt, muss sagen
 * können, woher sie kommt.
 */
public record AdminFleetDto(List<FleetSiteDto> sites) {

    /**
     * Eine Anlage der Flotte.
     *
     * <p>Die Geräte-Felder tragen exakt die Semantik von
     * {@link OverviewDto.OverviewSiteDto} (Lebendigkeit aus der ANKUNFT der
     * Telemetrie, 5-Minuten-Fenster; {@code worstStatus} = {@code stale} schlägt
     * {@code waiting} schlägt {@code online}, {@code null} ohne Gerät).
     *
     * <p>{@code lastPlanGeneratedAt} ist der jüngste Optimierer-Lauf im
     * Nachschau-Fenster ({@code null} = kein Lauf darin - der Optimierer plant
     * alle 15 Minuten, das ALTER ist die Aussage).
     *
     * <p>{@code control}/{@code curtailment} sind die schon vorhandenen
     * Beleg-Zeilen ({@code null} = kein Beleg) - identisch zu dem, was die
     * Kunden-Routen je Anlage liefern, damit Puls und Anlagen-Fläche nie
     * Verschiedenes behaupten können.
     *
     * <p>{@code pflege} sind die SERVER-abgeleiteten Pflege-Punkte (eine
     * Wahrheit, keine zweite Ableitung im Client).
     */
    public record FleetSiteDto(
            UUID siteId,
            String siteName,
            UUID tenantId,
            String tenantName,
            String plantKind,
            boolean netzladenErlaubt,
            String tarifArt,
            int deviceCount,
            int onlineCount,
            int waitingCount,
            String worstStatus,
            Instant lastSeenAt,
            Instant lastPlanGeneratedAt,
            boolean hasStorage,
            boolean batteryWithoutDevice,
            FleetSourcesDto sources,
            FleetEdgeDto edge,
            ControlStatusDto control,
            CurtailmentStatusDto curtailment,
            FleetKwpDto kwp,
            List<FleetForecastDto> forecast,
            List<PflegeFlagDto> pflege) {
    }

    /**
     * Die vom Gerät gemeldeten Quellen, nach Gesundheit gezählt. {@code null} an
     * der Anlage heißt „das Gerät hat keine Quellen gemeldet" - nicht „0
     * gesund".
     */
    public record FleetSourcesDto(int total, int ok, int stale, int never) {
    }

    /**
     * Der gemeldete Edge-Stand. {@code null} an der Anlage heißt UNBEKANNT (die
     * Edge meldet erst nach ihrem ersten Flow-Deployment), nie „veraltet";
     * beide Versionsfelder können einzeln fehlen.
     */
    public record FleetEdgeDto(String coreVersion, String paletteVersion, Instant reportedAt) {
    }

    /**
     * Die kWp-Plausibilität (B4): die gemessene PV-Spitze gegen die gepflegte
     * Nennleistung.
     *
     * <p>{@code verdict} ist {@code ok} | {@code zu_hoch} | {@code zu_niedrig} |
     * {@code unbekannt}; {@code reason} sagt in einem Satz, WARUM - auch (und
     * gerade) beim Urteil {@code unbekannt}, damit eine Lücke ihren Grund nennt.
     */
    public record FleetKwpDto(BigDecimal configuredKwp, BigDecimal observedPeakKw, long buckets,
            String verdict, String reason) {
    }

    /**
     * Die Prognosequalität einer Anlage für EINE Prognoseart ({@code load} /
     * {@code pv}), gemessen als mittlerer normierter Fehler über das Fenster,
     * plus das Flotten-Mittel als Maßstab.
     *
     * <p>{@code outlier} wird nur behauptet, wenn es einen Maßstab GIBT - ohne
     * genug bewertete Anlagen bleibt es {@code false} und {@code reason} sagt
     * das (dieselbe Disziplin wie beim Edge-Stand: ohne Maßstab ist nichts
     * veraltet).
     */
    public record FleetForecastDto(String kind, double nmaePct, int days, Double fleetMedianPct,
            boolean outlier, String reason) {
    }

    /**
     * Ein offener Pflege-Punkt. {@code code} ist das maschinenlesbare Kennwort,
     * {@code label} die kurze deutsche Beschriftung des Chips, {@code detail}
     * die Begründung (nullable - die zwei Existenz-Checks brauchen keine).
     */
    public record PflegeFlagDto(String code, String label, String detail) {
    }
}
