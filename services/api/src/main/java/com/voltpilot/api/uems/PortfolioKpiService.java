package com.voltpilot.api.uems;

import com.voltpilot.api.repo.PortfolioKpiRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import com.voltpilot.api.web.dto.PortfolioKpiDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * DIE PORTFOLIO-KENNZAHLEN des Kachel-Rasters der UEMS-Übersicht (Konzept
 * {@code data/vp-portfolio-konzept2-p2} §4.2): aggregiert über die sichtbaren
 * Anlagen des Mandanten (RLS, via {@link SiteRepository#findAll()}) die vier
 * Leitkacheln - Leitkennzahl (EnPI gegen Ziel), Energieverbrauch (Netzbezug)
 * gegen Vorjahr, Lastspitze gegen vereinbarte Leistung und Energiekosten gegen
 * Vorjahr - für den LETZTEN ABGESCHLOSSENEN Berliner Monat.
 *
 * <p><b>Jede Quelle an ihrem Ort (AGENTS.md „Quelle je Fläche"):</b>
 * <ul>
 *   <li>Netzbezug (Menge) und daraus die Kosten kommen aus der UEMS-Ablesewelt
 *       über {@link BilanzService} - dieselbe Vertrags-Zwilling-Quelle wie die
 *       Energiebilanz, NICHT aus der Telemetrie (die eine reine Einspeiser-Anlage
 *       mit 0 Netzbezug zeigt, während der Zähler den echten Bezug trägt).</li>
 *   <li>Die Lastspitze (15-min-Leistung) kommt aus der maßgeblichen 15-min-Quelle
 *       ({@link PortfolioKpiRepository}, Telemetrie-Netzbezug); fehlt sie, bleibt
 *       {@code kw} null (ehrlicher Leerzustand, nie 0).</li>
 *   <li>Die Leitkennzahl ist der EnPI mit freigegebener Bezugsbasis UND offenem
 *       Energieziel ({@link EnergiezielService}); gibt es keinen, ist {@code leit}
 *       null und das Portal zeigt den Datenlage-Fallback.</li>
 * </ul>
 *
 * <p><b>Rein getrennt:</b> die DB-Lesungen sammeln je Anlage {@link AnlageKpiRoh};
 * die Zusammenrechnung zu den Kacheln macht die REINE {@link #aggregiere} (ohne
 * Datenbank testbar). Ehrlichkeit: jede Summe ist {@code null}, solange keine
 * Anlage einen Wert beiträgt (nie 0); Kosten nur, wo ein Arbeitspreis hinterlegt ist.
 *
 * <p>Reiner Leser: läuft als der Request-Nutzer (TenantContext/Zugriffs-Zaun),
 * startet keine Threads, schreibt nichts. Je Anlage ein {@link BilanzService#bilanz}-
 * Aufruf (dieselbe Ableitung wie die Einzel-Bilanz); für sehr große Portfolios
 * später bündelbar.
 */
@Service
public class PortfolioKpiService {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final BigDecimal HUNDERT = BigDecimal.valueOf(100);

    private final SiteRepository sites;
    private final BilanzService bilanz;
    private final EnergiezielService energieziele;
    private final KennzahlWerteService kennzahlWerte;
    private final NetzanschlussRepository netzanschluss;
    private final PortfolioKpiRepository spitzen;

    public PortfolioKpiService(SiteRepository sites, BilanzService bilanz, EnergiezielService energieziele,
            KennzahlWerteService kennzahlWerte, NetzanschlussRepository netzanschluss, PortfolioKpiRepository spitzen) {
        this.sites = sites;
        this.bilanz = bilanz;
        this.energieziele = energieziele;
        this.kennzahlWerte = kennzahlWerte;
        this.netzanschluss = netzanschluss;
        this.spitzen = spitzen;
    }

    /** Die aggregierten Kennzahlen für den letzten abgeschlossenen Monat vor {@code jetzt}. */
    public PortfolioKpiDto kpis(Instant jetzt) {
        LocalDate heute = LocalDate.ofInstant(jetzt, BERLIN);
        YearMonth aktuell = YearMonth.from(heute).minusMonths(1);
        YearMonth vorjahr = aktuell.minusYears(1);

        Instant peakVon = aktuell.atDay(1).atStartOfDay(BERLIN).toInstant();
        Instant peakBis = aktuell.plusMonths(1).atDay(1).atStartOfDay(BERLIN).toInstant();
        Map<UUID, BigDecimal> peaks = spitzen.importSpitzeKw(peakVon, peakBis);

        List<AnlageKpiRoh> roh = new ArrayList<>();
        for (SiteDto s : sites.findAll()) {
            Netzbezug jetztM = netzbezugAus(bilanz.bilanz(s.id(), "monat", aktuell.atDay(15)));
            Netzbezug vorM = netzbezugAus(bilanz.bilanz(s.id(), "monat", vorjahr.atDay(15)));
            roh.add(new AnlageKpiRoh(s.name(), jetztM.kwh(), jetztM.vollstaendig(), vorM.kwh(),
                    arbeitspreis(s), peaks.get(s.id()), vereinbartKw(s.id(), heute)));
        }

        PortfolioKpiDto.Periode periode = new PortfolioKpiDto.Periode(
                aktuell.atDay(1), aktuell.atEndOfMonth(), aktuell.getYear(), aktuell.getMonthValue());
        return aggregiere(periode, roh, leitkennzahl(aktuell));
    }

    // ------------------------------------------------------------------ Reine Aggregation

    /** Die DB-gelösten Rohwerte EINER Anlage, die {@link #aggregiere} zusammenrechnet. */
    public record AnlageKpiRoh(
            String name,
            BigDecimal bezugKwh,
            boolean bezugVollstaendig,
            BigDecimal bezugVorjahrKwh,
            BigDecimal tarifCtKwh,
            BigDecimal lastspitzeKw,
            BigDecimal vereinbartKw) {}

    record Netzbezug(BigDecimal kwh, boolean vollstaendig) {}

    /**
     * Rechnet die Anlagen-Rohwerte zu den vier Kacheln zusammen - REIN, ohne
     * Datenbank (direkt testbar). Summen sind {@code null}, solange keine Anlage
     * beiträgt; Kosten nur mit hinterlegtem Arbeitspreis; die Lastspitze ist die
     * höchste gemessene Spitze samt der vereinbarten Leistung IHRER Anlage.
     */
    public static PortfolioKpiDto aggregiere(PortfolioKpiDto.Periode periode, List<AnlageKpiRoh> anlagen,
            PortfolioKpiDto.Leitkennzahl leit) {
        BigDecimal bezug = null;
        BigDecimal bezugVorjahr = null;
        BigDecimal kosten = null;
        BigDecimal kostenVorjahr = null;
        boolean vollstaendig = true;
        boolean tarifHinterlegt = false;
        AnlageKpiRoh spitze = null;
        for (AnlageKpiRoh a : anlagen) {
            bezug = plus(bezug, a.bezugKwh());
            bezugVorjahr = plus(bezugVorjahr, a.bezugVorjahrKwh());
            if (a.bezugKwh() != null && !a.bezugVollstaendig()) {
                vollstaendig = false;
            }
            if (a.tarifCtKwh() != null) {
                tarifHinterlegt = true;
                kosten = plus(kosten, kostenAus(a.bezugKwh(), a.tarifCtKwh()));
                kostenVorjahr = plus(kostenVorjahr, kostenAus(a.bezugVorjahrKwh(), a.tarifCtKwh()));
            }
            if (a.lastspitzeKw() != null
                    && (spitze == null || a.lastspitzeKw().compareTo(spitze.lastspitzeKw()) > 0)) {
                spitze = a;
            }
        }
        return new PortfolioKpiDto(periode,
                new PortfolioKpiDto.Verbrauch(bezug, bezugVorjahr, vollstaendig),
                new PortfolioKpiDto.Kosten(runde(kosten, 0), runde(kostenVorjahr, 0), tarifHinterlegt),
                lastspitzeAus(spitze),
                leit);
    }

    private static PortfolioKpiDto.Lastspitze lastspitzeAus(AnlageKpiRoh spitze) {
        if (spitze == null) {
            return new PortfolioKpiDto.Lastspitze(null, null, null, null);
        }
        BigDecimal kw = runde(spitze.lastspitzeKw(), 1);
        BigDecimal vereinbart = spitze.vereinbartKw();
        Integer anteil = (vereinbart != null && vereinbart.signum() > 0)
                ? kw.multiply(HUNDERT).divide(vereinbart, 0, RoundingMode.HALF_UP).intValue()
                : null;
        return new PortfolioKpiDto.Lastspitze(kw, vereinbart, anteil, spitze.name());
    }

    /**
     * Der Netzbezug (Hauptzähler-Bezug, Zufluss) einer Anlage aus ihrer Bilanz -
     * REIN. Summiert die Zufluss-Mengen aller Hauptzähler/Abschnitte (bei
     * Stellungswechsel Tag für Tag); {@code null}, wenn keine Zahl vorliegt
     * (zustand „keine_werte") - nie 0.
     */
    static Netzbezug netzbezugAus(BilanzDto.Bilanz b) {
        BigDecimal summe = null;
        boolean vollstaendig = true;
        for (BilanzDto.Hauptzaehler h : b.hauptzaehler()) {
            for (BilanzDto.Abschnitt a : h.abschnitte()) {
                for (BilanzDto.Werte w : a.werte()) {
                    BilanzDto.Summe z = w.zufluss();
                    if (z == null || z.menge() == null) {
                        continue;
                    }
                    summe = plus(summe, z.menge());
                    if (z.abdeckungProzent() != null && z.abdeckungProzent() < 100) {
                        vollstaendig = false;
                    }
                }
            }
        }
        return new Netzbezug(summe, vollstaendig);
    }

    /** Der hinterlegte Arbeitspreis (ct/kWh) einer Anlage, oder null bei {@code tarif_art='ohne'}. */
    private static BigDecimal arbeitspreis(SiteDto s) {
        if (s.tarifArt() == null || "ohne".equals(s.tarifArt())) {
            return null;
        }
        return s.tarifParamCtKwh();
    }

    private static BigDecimal kostenAus(BigDecimal kwh, BigDecimal ctKwh) {
        if (kwh == null) {
            return null;
        }
        return kwh.multiply(ctKwh).divide(HUNDERT);
    }

    // ------------------------------------------------------------------ DB-Lesungen (IO)

    /** Die am Tag {@code am} vereinbarte Leistung (kW) der Anlage, oder null ohne Netzanschluss. */
    private BigDecimal vereinbartKw(UUID siteId, LocalDate am) {
        return netzanschluss.bindungenDerAnlage(siteId).stream()
                .filter(b -> b.laeuftAm(am))
                .findFirst()
                .flatMap(b -> netzanschluss.finde(b.netzanschlussId()))
                .map(NetzanschlussRepository.Anschluss::vereinbartKw)
                .orElse(null);
    }

    /**
     * Die führende Kennzahl: der EnPI mit offenem Energieziel (das Ziel macht die
     * „Leitkennzahl gegen Ziel" erst möglich). Gibt es mehrere, entscheidet das
     * Kennzeichen deterministisch. Ohne Energieziel: {@code null} (Datenlage-Fallback).
     */
    private PortfolioKpiDto.Leitkennzahl leitkennzahl(YearMonth aktuell) {
        EnergiezielDto.Liste ziele = energieziele.liste(Set.of(), null, "offen");
        EnergiezielDto.Energieziel ziel = ziele.energieziele().stream()
                .min(Comparator.comparing(z -> z.kennzahl().kennzeichen()))
                .orElse(null);
        if (ziel == null) {
            return null;
        }
        UUID kennzahlId = ziel.kennzahl().id();
        // Jüngster Wert + Vormonat für den Trend: die letzten beiden Monate lesen.
        String von = aktuell.minusMonths(1).atDay(1).toString();
        String bis = aktuell.atEndOfMonth().toString();
        KennzahlDto.Werte werte = kennzahlWerte.werte(kennzahlId, Set.of(), "monat", von, bis, null);
        List<KennzahlDto.Wert> mitWert = werte.werte().stream()
                .filter(w -> w.wert() != null)
                .sorted(Comparator.comparing(KennzahlDto.Wert::von))
                .toList();
        if (mitWert.isEmpty()) {
            return null;
        }
        KennzahlDto.Wert juengster = mitWert.get(mitWert.size() - 1);
        BigDecimal wert = dezimal(juengster.wert());
        BigDecimal trend = null;
        if (mitWert.size() >= 2 && wert != null) {
            BigDecimal vorher = dezimal(mitWert.get(mitWert.size() - 2).wert());
            if (vorher != null && vorher.signum() != 0) {
                trend = wert.subtract(vorher).multiply(HUNDERT).divide(vorher, 1, RoundingMode.HALF_UP);
            }
        }
        EnergiezielDto.Stand stand = energieziele.stand(ziel.id());
        String urteil = stand.summe() != null ? stand.summe().urteil() : null;
        String einheit = juengster.einheit() != null ? juengster.einheit()
                : (werte.kennzahl() != null ? werte.kennzahl().einheit() : null);
        return new PortfolioKpiDto.Leitkennzahl(
                ziel.kennzahl().kennzeichen(),
                ziel.kennzahl().name(),
                wert,
                einheit,
                juengster.von().getYear(),
                juengster.von().getMonthValue(),
                juengster.zustand(),
                dezimal(ziel.zielwertProzent()),
                ziel.zielperiode(),
                ziel.wortlaut(),
                trend,
                urteil);
    }

    // ------------------------------------------------------------------ Helfer

    private static BigDecimal plus(BigDecimal a, BigDecimal b) {
        if (b == null) {
            return a;
        }
        return a == null ? b : a.add(b);
    }

    private static BigDecimal runde(BigDecimal v, int stellen) {
        return v == null ? null : v.setScale(stellen, RoundingMode.HALF_UP);
    }

    private static BigDecimal dezimal(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return new BigDecimal(s.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
