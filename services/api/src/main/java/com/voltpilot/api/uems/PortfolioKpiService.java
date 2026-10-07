package com.voltpilot.api.uems;

import com.voltpilot.api.repo.PortfolioKpiRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.PortfolioKpiDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.Month;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * DIE PORTFOLIO-KENNZAHLEN des Kachel-Rasters der UEMS-Übersicht (Konzept
 * {@code data/vp-portfolio-konzept2-p2} §4.2): aggregiert über die sichtbaren
 * Anlagen des Mandanten (RLS, via {@link SiteRepository#findAll()}) die vier
 * Leitkacheln - Leitkennzahl (EnPI gegen Ziel), Energieverbrauch (Netzbezug)
 * gegen Vorjahr, Lastspitze gegen vereinbarte Leistung und Energiekosten gegen
 * Vorjahr - Verbrauch und Kosten für den LETZTEN ABGESCHLOSSENEN Berliner Monat.
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
 *   <li>Die Leitkennzahl ist der EnPI mit offenem Energieziel, Wahl, Wert, Urteil
 *       und Ziel-Stand aus {@link KennzahlAuswertungService#leit()} - derselben
 *       Auswertung wie die Karte der Kennzahl (Konzept Auswerten a1 §10.8), auf
 *       der Uhr der Kennzahlen und in der Zone ihrer Geltung; gibt es keinen, ist
 *       {@code leit} null und das Portal zeigt den Datenlage-Fallback.</li>
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
    private final NetzanschlussRepository netzanschluss;
    private final PortfolioKpiRepository spitzen;
    private final MessstelleRegisterService messstellen;
    private final KennzahlAuswertungService auswertung;

    public PortfolioKpiService(SiteRepository sites, BilanzService bilanz, NetzanschlussRepository netzanschluss,
            PortfolioKpiRepository spitzen, MessstelleRegisterService messstellen, KennzahlAuswertungService auswertung) {
        this.sites = sites;
        this.bilanz = bilanz;
        this.netzanschluss = netzanschluss;
        this.spitzen = spitzen;
        this.messstellen = messstellen;
        this.auswertung = auswertung;
    }

    /**
     * Die aggregierten Kennzahlen: Verbrauch/Kosten/Leitkennzahl für den letzten
     * abgeschlossenen Monat, die Lastspitze für den laufenden Abrechnungszeitraum.
     */
    public PortfolioKpiDto kpis(Instant jetzt) {
        LocalDate heute = LocalDate.ofInstant(jetzt, BERLIN);
        YearMonth aktuell = YearMonth.from(heute).minusMonths(1);
        YearMonth vorjahr = aktuell.minusYears(1);

        List<SiteDto> alle = sites.findAll();
        // Review PR3 §1: die Lastspitze bemisst sich am laufenden ABRECHNUNGSZEITRAUM bis jetzt (Leistungspreis-Basis),
        // je Anlage „jahr" (Kalenderjahr) oder „monat" (laufender Monat) - so trägt die Kachel live echte Werte.
        // Welche Fenster gebraucht werden und ihre Grenzen/Labels bestimmt die REINE fenster() (Review R2: Fensterwahl testbar).
        Fenster f = fenster(alle.stream().map(SiteDto::abrechnungLeistung).toList(), heute);
        Map<UUID, PortfolioKpiRepository.Spitze> spJahr = f.brauchtJahr() ? spitzen.importSpitzen(f.jahrVon(), jetzt) : Map.of();
        Map<UUID, PortfolioKpiRepository.Spitze> spMonat = f.brauchtMonat() ? spitzen.importSpitzen(f.monatVon(), jetzt) : Map.of();

        List<AnlageKpiRoh> roh = new ArrayList<>();
        for (SiteDto s : alle) {
            Netzbezug jetztM = netzbezugAus(bilanz.bilanz(s.id(), "monat", aktuell.atDay(15)));
            Netzbezug vorM = netzbezugAus(bilanz.bilanz(s.id(), "monat", vorjahr.atDay(15)));
            boolean monat = "monat".equals(s.abrechnungLeistung());
            PortfolioKpiRepository.Spitze sp = (monat ? spMonat : spJahr).get(s.id());
            roh.add(new AnlageKpiRoh(s.name(), jetztM.kwh(), jetztM.vollstaendig(), vorM.kwh(),
                    arbeitspreis(s), sp != null ? sp.kw() : null, vereinbartKw(s.id(), heute),
                    sp != null ? sp.zeitpunkt() : null, monat ? f.monatLabel() : f.jahrLabel()));
        }

        PortfolioKpiDto.Periode periode = new PortfolioKpiDto.Periode(
                aktuell.atDay(1), aktuell.atEndOfMonth(), aktuell.getYear(), aktuell.getMonthValue());
        return aggregiere(periode, roh, datenlage(), leitkennzahl());
    }

    /** Die Abrechnungszeitraum-Fenster der Lastspitze: Grenzen (Berlin), Labels und welche Fenster überhaupt gebraucht werden. */
    record Fenster(Instant jahrVon, Instant monatVon, boolean brauchtJahr, boolean brauchtMonat,
            String jahrLabel, String monatLabel) {}

    /**
     * Die Fensterwahl für die Lastspitze (Review PR3 §1) - REIN, ohne Datenbank testbar: aus den
     * {@code abrechnungLeistung}-Werten der sichtbaren Anlagen und {@code heute}. „monat" braucht das
     * Monatsfenster (Monatsanfang Berlin), alles andere - auch {@code null} - das Jahresfenster
     * (1. Januar Berlin). Beide Flags {@code false} ohne Anlage (kein unnötiger DB-Treffer).
     */
    static Fenster fenster(List<String> abrechnungen, LocalDate heute) {
        Instant jahrVon = LocalDate.of(heute.getYear(), 1, 1).atStartOfDay(BERLIN).toInstant();
        Instant monatVon = heute.withDayOfMonth(1).atStartOfDay(BERLIN).toInstant();
        boolean brauchtMonat = abrechnungen.stream().anyMatch("monat"::equals);
        boolean brauchtJahr = abrechnungen.stream().anyMatch(a -> !"monat".equals(a));
        String jahrLabel = String.valueOf(heute.getYear());
        String monatLabel = Month.of(heute.getMonthValue()).getDisplayName(TextStyle.FULL, Locale.GERMAN)
                + " " + heute.getYear();
        return new Fenster(jahrVon, monatVon, brauchtJahr, brauchtMonat, jahrLabel, monatLabel);
    }

    /** Die Datenlage: aktuell liefernde Messstellen / gesamt (dieselbe Ableitung wie der Messstellen-Baustein). */
    private PortfolioKpiDto.Datenlage datenlage() {
        MessstelleDto.RegisterAggregat agg = messstellen.liste(null, MessstelleRegisterService.Filter.KEINER).aggregat();
        if (agg == null || agg.unternehmen() == null || agg.unternehmen().gesamt() <= 0) {
            return null;
        }
        return new PortfolioKpiDto.Datenlage(agg.unternehmen().erfuellt(), agg.unternehmen().gesamt());
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
            BigDecimal vereinbartKw,
            Instant lastspitzeZeitpunkt,
            String lastspitzeZeitraum) {}

    record Netzbezug(BigDecimal kwh, boolean vollstaendig) {}

    /**
     * Rechnet die Anlagen-Rohwerte zu den vier Kacheln zusammen - REIN, ohne
     * Datenbank (direkt testbar). Summen sind {@code null}, solange keine Anlage
     * beiträgt; Kosten nur mit hinterlegtem Arbeitspreis; die Lastspitze ist die
     * höchste gemessene Spitze samt der vereinbarten Leistung IHRER Anlage.
     */
    public static PortfolioKpiDto aggregiere(PortfolioKpiDto.Periode periode, List<AnlageKpiRoh> anlagen,
            PortfolioKpiDto.Datenlage datenlage, PortfolioKpiDto.Leitkennzahl leit) {
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
                // Review R2 §B5: die Vorjahreskosten bepreisen die VORJAHRESMENGE mit dem HEUTE
                // hinterlegten Arbeitspreis (historische Tarife werden nicht gespeichert). „Kosten
                // ggü. Vorjahr" bildet damit den MENGENeffekt ab, nicht die echte Tarifänderung.
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
                datenlage,
                leit);
    }

    private static PortfolioKpiDto.Lastspitze lastspitzeAus(AnlageKpiRoh spitze) {
        if (spitze == null) {
            return new PortfolioKpiDto.Lastspitze(null, null, null, null, null, null);
        }
        BigDecimal kw = runde(spitze.lastspitzeKw(), 1);
        BigDecimal vereinbart = spitze.vereinbartKw();
        Integer anteil = (vereinbart != null && vereinbart.signum() > 0)
                ? kw.multiply(HUNDERT).divide(vereinbart, 0, RoundingMode.HALF_UP).intValue()
                : null;
        String zeitpunkt = spitze.lastspitzeZeitpunkt() != null ? spitze.lastspitzeZeitpunkt().toString() : null;
        return new PortfolioKpiDto.Lastspitze(kw, vereinbart, anteil, spitze.name(), zeitpunkt,
                spitze.lastspitzeZeitraum());
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
     * Die führende Kennzahl (Konzept Auswerten a1 §10.8: ein Urteil, eine Ableitung). Welche Kennzahl führt, ihr Wert,
     * das Urteil und der Stand des Energieziels kommen aus {@link KennzahlAuswertungService#leit()} - derselben Auswertung
     * wie die Karte der Kennzahl, auf der Uhr der Kennzahlen und in der Zone ihrer Geltung, nie auf der Uhr dieser Route.
     * Der Trend ist die Veränderung des jüngsten Werts gegen den Monat davor ({@code vormonat}, Operation {@code roh}) -
     * hier nicht neu gerechnet. Ohne führende Kennzahl {@code null}
     * (Datenlage-Fallback).
     */
    PortfolioKpiDto.Leitkennzahl leitkennzahl() {
        return auswertung.leit().map(PortfolioKpiService::leitkachel).orElse(null);
    }

    /** Die Leitkachel aus der Auswertung der führenden Kennzahl - REIN. */
    static PortfolioKpiDto.Leitkennzahl leitkachel(KennzahlAuswertungService.Leit leit) {
        KennzahlDto.Kennzahl k = leit.kennzahl();
        EnergiezielDto.Energieziel ziel = leit.ziel();
        KennzahlDto.Auswertung a = k.auswertung();
        KennzahlDto.AuswertungWert w = a.wert();
        YearMonth monat = YearMonth.parse(w.periode());
        return new PortfolioKpiDto.Leitkennzahl(
                k.kennzeichen(),
                k.name(),
                dezimal(w.wert()),
                w.einheit() != null ? w.einheit() : k.einheit(),
                monat.getYear(),
                monat.getMonthValue(),
                w.zustand(),
                dezimal(ziel.zielwertProzent()),
                ziel.zielperiode(),
                ziel.wortlaut(),
                a.vormonat() == null ? null : dezimal(a.vormonat().deltaProzent()),
                a.vergleich() != null ? a.vergleich().urteil() : null,
                a.energieziel());
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
