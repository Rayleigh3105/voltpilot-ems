package com.voltpilot.api.web.dto;

import com.voltpilot.api.web.dto.EarningsDto.PeakShavingDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * The MEASURED money of ONE Anlage over ONE period - the payload of the Erlöse
 * world (`#/anlage/{id}/erloese`, Historie concept `vp-historie-konzept-t4`
 * §4.2 Welt B / feature F1, performance measure P3).
 *
 * <p><b>Why an own endpoint next to the tenant-wide {@code /api/v1/earnings}.</b>
 * The fleet endpoint answers "all my Anlagen, all their series, plus the
 * 12-month strip and the forward market value" - measured at 3-7,5 s. A page
 * that shows ONE Anlage needs one Anlage; the tenant-wide endpoint stays where
 * it belongs (Cockpit, Übersicht, Portfolio).
 *
 * <p><b>Every number here comes from the SAME price truth</b> the optimizer
 * plans with ({@code SlotEconomics.importPriceCtSql}) and the fleet endpoint
 * reports - this DTO exposes the composition of numbers that already existed,
 * it does not compute money a second way.
 *
 * <p><b>The two reconciliation identities</b> the surface relies on (both hold
 * by construction, not by rounding luck):
 * <pre>
 *   nettoErgebnisEur = einspeiseErloesEur + eigenverbrauchsWertEur − stromkostenEur
 *   stromkostenEur − einspeiseErloesEur = actualEur          (the metered cash flow)
 * </pre>
 *
 * <p><b>Honesty:</b> every money/energy field is {@code null} when it is not
 * computable, never a fabricated 0 - {@code reason} says why
 * ({@code no_data} / {@code missing_channels} / {@code no_prices}, the same
 * vocabulary as the fleet endpoint). {@code eigenverbrauchsWertEur} is the
 * self-consumed energy valued at the SAME import price as
 * {@code stromkostenEur} (captain decision E7 of 2026-09-02 - one card, one
 * price), so {@code tarifPriced} labels it too; {@code marktpraemieEur} is null without an
 * anzulegender Wert; {@code peakShaving} is null unless the module is active.
 *
 * @param range the echoed period vocabulary ({@code day|week|month|year|all})
 * @param from window start - for {@code all} the first covered Berlin day
 * @param tarifPriced whether the import side is valued beyond bare spot (the
 *     "bewertet zu Ihrem Stromtarif" vs "zu Börsenpreisen" switch)
 * @param exportVerguetungPriced the EXPORT-side sibling of {@code tarifPriced}
 *     (B2 fix, audit vp-geldzahlen-audit-x7): whether the feed-in is valued at
 *     the plant's feste EEG-Einspeisevergütung instead of bare spot (a
 *     non-grid-charging {@code eigenverbrauch} plant with a known, unexpired
 *     commissioning date). {@code false} for Direktvermarktung - its spot +
 *     Marktprämie valuation is already explained by the premium fields - and
 *     for plants whose remuneration cannot be determined (they honestly stay
 *     at spot)
 * @param nettoErgebnisEur the period's result: Ertrag minus Stromkosten
 * @param savedEur the ATTRIBUTION of VoltPilot's steering - a delta against an
 *     unregulated plant that already sits INSIDE the result, never a sibling
 *     summand (the MIG §5 rule the money hero follows too)
 * @param savedSpeicherEur der Speicher-Anteil der Dreiteilung
 *     {@code savedEur = savedSpeicherEur + savedSteuerungEur} (Audit
 *     vp-geldzahlen-audit-x7 §2.5, B1): was ein STUR arbeitender
 *     Standard-Speicher (das Greedy-Referenzmodell der Ersparnis-Simulation -
 *     gleiche Physik, lädt jeden Überschuss, deckt jedes Defizit, lädt nie aus
 *     dem Netz, preisblind) gegenüber der speicherlosen Anlage erwirtschaftet
 *     hätte, bewertet mit denselben Preis-Kompositionen wie {@code savedEur}
 *     ({@code EarningsRepository.savedSpeicher}). Null, wenn nichts berechenbar
 *     ist oder die Batterie-Stammdaten fehlen ({@code steuerungSplitReason})
 * @param savedSteuerungEur der exakte Rest {@code savedEur −
 *     savedSpeicherEur}: der Mehrwert der INTELLIGENTEN Steuerung gegenüber dem
 *     sturen Speicher (Preisfenster, Netzladen-Arbitrage, Abregelung) - die
 *     Rekonziliation gilt per Konstruktion. Null wann immer
 *     {@code savedSpeicherEur} null ist
 * @param steuerungSplitReason warum die Dreiteilung fehlt, obwohl
 *     {@code savedEur} berechenbar ist: {@code no_battery_data} = kein
 *     primäres Batterie-Asset mit gepflegter Kapazität und Lade-/
 *     Entladeleistung - die Referenz wird dann ehrlich nicht simuliert, nie
 *     geraten. Null, wenn die Dreiteilung vorliegt oder {@code savedEur}
 *     selbst null ist (dann erklärt {@code reason})
 * @param bezugspreisCtKwh {@code stromkostenEur / bezogenKwh} in ct/kWh - a
 *     division of two shown sums, so the surface can be checked against itself
 * @param marktpraemieEur the premium already CONTAINED in
 *     {@code einspeiseErloesEur} (shown as provenance, never added again)
 * @param gesamtertragEur the money-centric total = {@code einspeiseErloesEur +
 *     eigenverbrauchsWertEur} (the fleet twin's semantics), so the cockpit
 *     money hero reads ONE field; null when nothing is computable. Parity with the fleet twin so the cockpit reads the SAME
 *     number from this cheaper site endpoint (audit vp-portal-perf-a4, B2).
 * @param expectedMarketValueSolarCtKwh the FORWARD expected Marktwert Solar
 *     (day-ahead price weighted with this site's own PV forecast over the
 *     coming horizon) - range-independent, null without forward PV/price
 *     coverage; {@code expectedMarketValueFrom}/{@code ...To} bound and
 *     {@code expectedMarketValueSlots} counts the covered forward slots
 * @param speicherDeltaKwh das BESTANDSKONTO des Zeitraums: wie viel Energie am
 *     Ende MEHR (+) oder weniger (−) im Speicher steckt als am Anfang. Es ist
 *     der GEMESSENE Gegenpol zu {@code savedEur}, das als reine Zahlungsbilanz
 *     eine eingelagerte kWh nur als entgangenen Einspeise-Erlös kennt
 *     (Diagnose vp-tagesbild-minus-f3 §6.1) - null ohne Speicher oder ohne
 *     gemessenen Ladestand, nie eine erfundene 0
 * @param speicherWertCtKwh womit dieser Bestand bewertet ist: λ, der vom
 *     Optimierer selbst persistierte Wert einer gespeicherten kWh
 * @param speicherWertEur {@code speicherDeltaKwh × speicherWertCtKwh / 100} -
 *     ausdrücklich KEIN Summand von {@code savedEur}, sondern der zweite, als
 *     „nach dem Plan bewertet" beschriftete Posten daneben
 * @param speicherWertBasis {@code plan} (λ des Slots) oder {@code terminal}
 *     (der Terminalwert des Laufs, der FK2-Rückfall) - damit die Fläche sagen
 *     kann, WOMIT bewertet wurde
 * @param series the money per Berlin bucket (hour for a day, day for week and
 *     month, month for year/all) - the stacked bars + the cumulative line
 */
public record SiteEarningsDto(
        UUID siteId,
        String name,
        String range,
        Instant from,
        Instant to,
        String plantKind,
        String tarifArt,
        BigDecimal tarifParamCtKwh,
        boolean tarifPriced,
        boolean exportVerguetungPriced,
        BigDecimal anzulegenderWertCtKwh,
        long coveredSlots,
        LocalDate firstCoveredDate,
        String reason,
        BigDecimal einspeiseErloesEur,
        BigDecimal eigenverbrauchsWertEur,
        BigDecimal stromkostenEur,
        BigDecimal nettoErgebnisEur,
        BigDecimal savedEur,
        BigDecimal arbitrageEur,
        BigDecimal pvShiftEur,
        BigDecimal savedSpeicherEur,
        BigDecimal savedSteuerungEur,
        String steuerungSplitReason,
        BigDecimal baselineEur,
        BigDecimal actualEur,
        BigDecimal marktpraemieEur,
        BigDecimal bezugspreisCtKwh,
        BigDecimal realizedExportCtKwh,
        BigDecimal marketValueSolarCtKwh,
        Boolean marketValueProvisional,
        BigDecimal bezogenKwh,
        BigDecimal eingespeistKwh,
        BigDecimal selbstverbrauchKwh,
        BigDecimal batterieBewegtKwh,
        BigDecimal gesamtertragEur,
        BigDecimal expectedMarketValueSolarCtKwh,
        Instant expectedMarketValueFrom,
        Instant expectedMarketValueTo,
        Long expectedMarketValueSlots,
        BigDecimal speicherDeltaKwh,
        BigDecimal speicherWertCtKwh,
        BigDecimal speicherWertEur,
        String speicherWertBasis,
        List<SiteEarningsBucketDto> series,
        PeakShavingDto peakShaving) {

    /**
     * One bucket of the money chart: the three parts that stack (feed-in
     * revenue and self-consumption value up, grid supply cost down) plus their
     * net, so the cumulative line is the running sum of {@code nettoEur} and
     * lands exactly on {@link SiteEarningsDto#nettoErgebnisEur}.
     */
    public record SiteEarningsBucketDto(
            Instant start,
            BigDecimal einspeiseErloesEur,
            BigDecimal eigenverbrauchsWertEur,
            BigDecimal stromkostenEur,
            BigDecimal nettoEur) {
    }
}
