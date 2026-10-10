package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Der EINE Flotten-Aggregat hinter {@code GET /api/v1/admin/fleet} (Admin-Umbau
 * Stufe 2): Anlagen als Gruppen über ALLE Mandanten, darin eine Zeile je Box,
 * mit allem, was der Flotten-Puls braucht - und nur damit.
 *
 * <p>Er löst die Client-Schleife der Stufe 1 ab (je Mandant {@code /overview} +
 * Anlagen + {@code /edge-versions}, dazu je Anlage die Quellen und beim
 * Aufklappen zwei Steuerungs-Belege). Die Anlagen-Fakten bleiben erhalten;
 * {@code boxes} ergänzt die je-Box-Sicht.
 *
 * <p><b>Ehrlichkeit ist Teil des Vertrags:</b> ein Block, den niemand gemessen
 * hat, ist {@code null} und trägt seinen Grund ({@code reason}) - nie eine
 * erfundene Null und nie ein geratener Zustand. Wer eine Zahl zeigt, muss sagen
 * können, woher sie kommt.
 *
 * <p>{@code releases} ist das Release-Register (OTA Stufe 0), NEUESTE zuerst -
 * der flottenweite SOLL-Stand ist sein erster Eintrag. Es reist mit, weil
 * „veraltet" nur gegen diese Ordnung eine Aussage ist: der gemeldete Stand
 * einer Anlage wird darin GESUCHT, und ein Stand, den das Register nicht kennt
 * (eine Bestands-Edge trägt eine nackte Commit-SHA), ist „nicht registriert" -
 * ausdrücklich nicht „veraltet". Leere Liste = kein Maßstab, also wird nichts
 * als veraltet behauptet.
 */
public record AdminFleetDto(List<FleetSiteDto> sites, List<FleetReleaseDto> releases,
        java.util.Map<UUID, Instant> unterstuetzungBis,
        List<com.voltpilot.api.repo.AdminFleetRepository.UnterstuetzungStandort> unterstuetzungStandorte) {
    public AdminFleetDto(List<FleetSiteDto> sites, List<FleetReleaseDto> releases) {
        this(sites, releases, java.util.Map.of(), List.of());
    }

    /**
     * Eine Anlage der Flotte.
     *
     * <p>Die Geräte-Felder tragen exakt die Semantik von
     * {@link OverviewDto.OverviewSiteDto} (Lebendigkeit aus der ANKUNFT des
     * Status-Herzschlags, 5-Minuten-Fenster; {@code worstStatus} = {@code stale} schlägt
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
            List<FleetBoxDto> boxes,
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
            FleetUpdateDto update,
            ControlStatusDto control,
            CurtailmentStatusDto curtailment,
            FleetKwpDto kwp,
            FleetFeedInDto feedIn,
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
     * Eine Box innerhalb ihrer Anlagen-Gruppe. {@code fuehrtAnlage == null}
     * heißt, dass keine führende Box bestimmt ist; {@code false} ist dagegen
     * die belegte Nebenrolle neben einer anderen führenden Box.
     */
    public record FleetBoxDto(UUID deviceId, String externalRef, String name,
            Boolean fuehrtAnlage, Instant lastSeenAt, FleetEdgeDto edge, FleetUpdateDto update,
            List<String> supports) {
    }

    /**
     * Der gemeldete OTA-Stand (Stufe 0) - {@code null} heißt UNBEKANNT, nie
     * „veraltet".
     *
     * <p>Er steht bewusst NEBEN {@link FleetEdgeDto} statt darin: die Version
     * reist hier TOP-LEVEL im Herzschlag, also unabhängig vom {@code flows}
     * -Block, den eine Edge erst nach ihrem ersten Flow-Deployment baut - genau
     * deshalb füllt dieser Block auch die Geräte, über die {@code edge} nichts
     * weiß. Beide tragen ihren EIGENEN {@code reportedAt}: ein Gerät, das den
     * einen Block einstellt, während der andere weiterläuft, darf keine alte
     * Aussage am Leben halten.
     *
     * <p>{@code version} ist der Stempel VERBATIM (eine Bestands-Edge meldet
     * eine nackte Commit-SHA - die Oberfläche zeigt sie dann als „nicht
     * registriert", nie als veraltet). {@code target}/{@code lastKnownGood}
     * bleiben in Stufe 0 leer: es gibt weder Soll-Zuweisung noch angewandtes
     * Update auf dem Gerät. {@code state} ist ein Wort des Vertrags-Vokabulars
     * oder {@code null} - ein unbekanntes wird beim Ingest verworfen.
     */
    public record FleetUpdateDto(String version, String backend, String current, String target,
            String state, String reason, String lastKnownGood, Instant reportedAt) {
    }

    /**
     * Ein Eintrag des Release-Registers. {@code releaseSeq} ist DIE Ordnung -
     * eine monotone Ganzzahl, nie ein String- oder SHA-Vergleich (D5).
     */
    public record FleetReleaseDto(long releaseSeq, String version) {
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
     * Die Plausibilität der gepflegten Einspeisegrenze (B4c): die über N Tage
     * GEMESSENE Export-Decke gegen {@code site.max_feed_in_kw}.
     *
     * <p>Nach dem B4a-kWp-Muster - der reale Präzedenzfall ist Pilsting, wo die
     * Grenze mit 75 statt 30 gepflegt war (vermutlich Summe der
     * Wechselrichter-Nennleistungen statt der Netzanschluss-Grenze): der Fahrplan
     * plant dann Verkaufs-Orders, die physisch nie fließen können, und der
     * Einspeise-Wächter der Box regelt gegen die falsche Zahl.
     *
     * <p>{@code verdict} ist {@code ok} | {@code zu_hoch} (die Anlage klebt
     * wiederholt deutlich UNTER der Grenze - vermutlich zu hoch gepflegt) |
     * {@code nicht_gehalten} (die gemessene Einspeisung überschreitet die Grenze
     * wiederholt) | {@code unbekannt}; {@code reason} sagt in einem Satz, WARUM -
     * auch (und gerade) beim Urteil {@code unbekannt}. {@code observedCeilingKw}
     * ist die robuste Decke (90.-Perzentil der Tages-Maxima), {@code exportDays}
     * die Zahl bewerteter Export-Tage, {@code clingDays} die Tage, deren
     * Tages-Maximum an derselben Decke klebt.
     */
    public record FleetFeedInDto(BigDecimal configuredKw, BigDecimal observedCeilingKw,
            int exportDays, int clingDays, String verdict, String reason) {
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
