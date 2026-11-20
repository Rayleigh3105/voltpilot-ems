package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.probe.ProbeResult;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * PFC200 Stufe 4: die Formen des Koppelbilds einer Anlagensteuerung ({@code docs/contracts/v2/koppelbild.md} §15) -
 * der Stand, den die Box meldet, und je Stellplatz Angebot, Wunsch, Quittung und Freigabe. Snake-Case wie
 * {@link AnlagensteuerungDto}; „nicht bekannt“ ist null, nie abwesend und nie 0.
 */
public final class KoppelbildDto {
    private KoppelbildDto() {}

    /**
     * {@code GET /api/v1/sites/{siteId}/anlagensteuerungen/{geraetId}/koppelbild}. {@code unterstuetzt}: die Box, die
     * die Steuerung liest, meldet {@code koppelbild}. Stellplätze sind die des jüngsten Stands und die mit einer
     * Freigabe-Zeile.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Koppelbild(boolean unterstuetzt, Stand stand, List<Stellplatz> stellplaetze) {}

    /**
     * Der jüngste Stand der Box: {@code aktuell} = höchstens 120 s alt; Kopf-Felder null ohne lesbare Lesung;
     * {@code fernsteuerung_frei}, {@code edge_lebt}, {@code hand_ort} null, wenn die Box die Lage-Bits nicht las.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stand(OffsetDateTime empfangenAt, boolean aktuell, String lage, String grund,
            OffsetDateTime gelesenAt, String bibliothek, String bibliothekSoll, Boolean bibliothekVeraltet,
            String kopfUrteil, Integer restS, Boolean fernsteuerungFrei, Boolean edgeLebt, Boolean handOrt,
            Integer angenommenZaehler, Integer abgelehntZaehler) {}

    /**
     * Ein Stellplatz. {@code kommando} ist das Kommando des Schiedsrichters zur Art des Angebots (oder der Freigabe,
     * wenn gerade keines da ist). {@code freigabe_grund} nennt, warum die Freigabe gerade nicht möglich ist
     * ({@code box_kann_nicht} · {@code angebot_fehlt} · {@code kein_test} · {@code test_nicht_angenommen} ·
     * {@code kommando_belegt}), null wenn möglich oder schon freigegeben.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stellplatz(int platz, Angebot angebot, Wunsch wunsch, boolean test, String urteil, Integer folge,
            Long wirksam, String kommando, Freigabe freigabe, boolean freigabeMoeglich, String freigabeGrund) {}

    /** Das Angebot in ganzen Einheiten des Bilds; {@code gruende} sind die gesetzten Gründe aus {@code a_bits}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Angebot(String art, String ziel, int nr, long min, long max, boolean bereit,
            List<String> gruende) {}

    /** Der Wunsch der Box; {@code folge} ist ihre eigene Folge. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wunsch(String art, long wert, String grund, int folge) {}

    /**
     * Die Freigabe des Stellplatzes: {@code offen} · {@code getestet} (bestandener Test für das jetzige Angebot) ·
     * {@code freigegeben} · {@code verfallen} (das Angebot änderte sich, die Freigabe fiel). {@code test} ist der
     * Beleg, null ohne einen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Freigabe(String status, OffsetDateTime freigegebenAt, String freigegebenVon, Test test,
            String verfallenGrund) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Test(long wert, String urteil, Long wirksam, OffsetDateTime at) {}

    /** {@code POST …/stellplaetze/{platz}/test}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record TestAnfrage(Long wert) {}

    /** {@code POST …/stellplaetze/{platz}/freigabe}. */
    public record FreigabeAnfrage(Boolean physicallyConfirmed) {}

    /**
     * Die Antwort des Schalt-Tests: {@code ok} = bestanden (die SPS quittierte den Testwunsch zu genau seiner Folge
     * mit angenommen, begrenzt oder überstimmt); {@code koppel_test} sagt, was die Box sah; {@code satz} ist der Satz
     * für die Fläche; {@code beleg_gespeichert} = der Beleg steht für die Freigabe bereit.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record TestErgebnis(boolean ok, ProbeResult.KoppelTest koppelTest, String satz, String errorCode,
            boolean belegGespeichert) {}
}
