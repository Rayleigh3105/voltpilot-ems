package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * UEMS EZ-23: die Form von {@code GET /api/v1/sites/{siteId}/erzeuger/jetzt} — das Erzeuger-Cockpit (EZ-8). Anders als
 * {@link AnlagensteuerungDto} camelCase: das Portal hat die Form mit EZ-8 festgelegt ({@code ErzeugerJetzt} in
 * {@code frontend/portal/src/api.ts}), und {@code request()} wandelt nichts um. „Nicht erhoben“ ist null, nie
 * abwesend und nie 0.
 */
public final class ErzeugerJetztDto {
    private ErzeugerJetztDto() {}

    /**
     * Die Anlage mit Anlagensteuerung. {@code werte} je Punktname des Portals ({@code erzeuger.nb.bits},
     * {@code erzeuger.te2.p_ist_w}, …), {@code wechselHeute} für die Tagesleiste.
     */
    public record Jetzt(Steuerung steuerung, String netzbetreiber, String direktvermarkter, List<Einheit> einheiten,
            Map<String, Wert> werte, Map<String, List<Wechsel>> wechselHeute) {}

    /** Das Gerät „Anlagensteuerung“. */
    public record Steuerung(UUID geraetId, String name) {}

    /**
     * Ein Teil {@code erzeugungseinheit}: {@code art} ist {@code pv} · {@code bhkw} · null. {@code bezeichnung} ist
     * der Name, den der Kunde der Einheit gab (GE-3, additiv); null = keiner, dann nennt das Portal die Nummer.
     */
    public record Einheit(int teNr, String art, String typName, BigDecimal nennKw, String bezeichnung) {}

    /**
     * Der jüngste Wert eines Punkts: Zahl in der Einheit des Punkts (W, %, kW, s; Zustand und Bitfeld als
     * Ganzzahl), {@code qualitaet} aus dem Vokabular der Messreihe. Ohne Lesung alles null.
     */
    public record Wert(BigDecimal wert, OffsetDateTime gelesenAm, String qualitaet) {}

    /** Ab {@code ab} gilt {@code wert}; null = unbekannt (keine Lesung). */
    public record Wechsel(OffsetDateTime ab, BigDecimal wert) {}
}
