package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Die Leser zur {@link KennzahlAuswertung} (Konzept Auswerten a1 §6.4, §10.8): {@code GET /api/v1/kennzahlen?mit=auswertung}
 * und die Leitkachel der Übersicht ({@link PortfolioKpiService}) fragen hier - ein Urteil, eine Ableitung. Je Kennzahl
 * die Monatswerte der letzten 24 Monate, der Vergleich der letzten zwölf (nur mit freigegebener Bezugsbasis) und der
 * Stand des offenen Energieziels; gerechnet wird nichts, die reine {@link KennzahlAuswertung} ordnet.
 *
 * <p>Der Monat des Urteils hängt nur an der Uhr der Kennzahlen ({@link KennzahlService#jetzt()}) und der Zone ihrer
 * Geltung - nie an der Uhr oder Zone des Aufrufers. Welche Kennzahl die Leitkachel zeigt und welches offene Energieziel an
 * einer Kennzahl steht, entscheidet allein dieser Dienst ({@link #leit()}, {@link #zielFuer}); die Liste nennt dieselbe
 * Leitkennzahl ({@code leitkennzahl}).
 *
 * <p>Reiner Leser mit der Sicht des Aufrufers: die Liste nimmt nur die Kennzahlen, die {@link KennzahlService#liste()}
 * zeigt; jede weitere Lesung geht über dieselben Dienste wie ihre Routen.
 */
@Service
public class KennzahlAuswertungService {

    /** Der einzige Wert von {@code mit}. */
    static final String MIT_AUSWERTUNG = "auswertung";
    private static final String MONAT = "monat";
    private static final Set<String> WERTE_PARAMETER = Set.of("periode", "von", "bis");
    private static final Logger LOG = LoggerFactory.getLogger(KennzahlAuswertungService.class);

    private final KennzahlService kennzahlen;
    private final KennzahlWerteService werte;
    private final BezugsbasisVergleich vergleich;
    private final EnergiezielService energieziele;

    public KennzahlAuswertungService(KennzahlService kennzahlen, KennzahlWerteService werte, BezugsbasisVergleich vergleich,
            EnergiezielService energieziele) {
        this.kennzahlen = kennzahlen;
        this.werte = werte;
        this.vergleich = vergleich;
        this.energieziele = energieziele;
    }

    /**
     * {@code GET /api/v1/kennzahlen[?mit=auswertung]}: ohne {@code mit} die Liste wie bisher; mit {@code mit=auswertung}
     * trägt jede nicht archivierte Kennzahl mit Monatswerten ihre Auswertung. Ein anderer Wert ist 400
     * {@code anfrage_ungueltig} mit {@code feld} {@code mit}.
     */
    public KennzahlDto.Liste liste(String mit) {
        if (mit != null && !MIT_AUSWERTUNG.equals(mit)) {
            throw KennzahlAbgelehnt.anfrage("mit");
        }
        if (mit == null) {
            return kennzahlen.liste();
        }
        // Ein Katalog für die ganze Liste: jede Auswertung läse ihn sonst mehrfach neu (Review r3, Aufwand je Kennzahl).
        return kennzahlen.mitEinemKatalog(this::listeMitAuswertung);
    }

    private KennzahlDto.Liste listeMitAuswertung() {
        KennzahlDto.Liste liste = kennzahlen.liste();
        Map<UUID, List<EnergiezielDto.Energieziel>> ziele = offeneZiele();
        List<KennzahlDto.Kennzahl> mitAuswertung = liste.kennzahlen().stream()
                .map(k -> auswertbar(k) ? mitAuswertung(k, ziele.getOrDefault(k.id(), List.of())) : k)
                .toList();
        UUID leit = mitAuswertung.stream()
                .filter(k -> ziele.containsKey(k.id()) && fuehrt(k))
                .min(LEIT_FOLGE)
                .map(KennzahlDto.Kennzahl::id)
                .orElse(null);
        return new KennzahlDto.Liste(mitAuswertung, liste.ausserhalbZugriff(), leit);
    }

    /** Die Leitkennzahl mit ihrer Auswertung und dem Energieziel, das an ihr steht (Wortlaut für die Kachel). */
    public record Leit(KennzahlDto.Kennzahl kennzahl, EnergiezielDto.Energieziel ziel) {}

    /**
     * Die Leitkennzahl der Übersicht (§10.8): unter den Kennzahlen mit Auswertung und offenem Energieziel die mit dem
     * kleinsten Kennzeichen, die einen Monatswert trägt - dieselbe Wahl wie {@code leitkennzahl} der Liste, über dieselbe
     * Auswertung (Uhr der Kennzahlen, Zone der Geltung). Leer ohne eine solche Kennzahl. Gelesen wird nur, bis eine
     * Kennzahl führt.
     */
    public Optional<Leit> leit() {
        return kennzahlen.mitEinemKatalog(this::leitImKatalog);
    }

    private Optional<Leit> leitImKatalog() {
        Map<UUID, List<EnergiezielDto.Energieziel>> ziele = offeneZiele();
        if (ziele.isEmpty()) {
            return Optional.empty();
        }
        return kennzahlen.liste().kennzahlen().stream()
                .filter(k -> auswertbar(k) && ziele.containsKey(k.id()))
                .sorted(LEIT_FOLGE)
                .map(k -> mitAuswertung(k, ziele.get(k.id())))
                .filter(KennzahlAuswertungService::fuehrt)
                .findFirst()
                .map(k -> new Leit(k, ziele.get(k.id()).stream()
                        .filter(z -> z.id().equals(k.auswertung().energieziel().id()))
                        .findFirst()
                        .orElseThrow()));
    }

    /** Führen kann eine Kennzahl mit Auswertung, Energieziel und einem Monatswert der zwölf. */
    private static boolean fuehrt(KennzahlDto.Kennzahl k) {
        return k.auswertung() != null && k.auswertung().energieziel() != null && k.auswertung().wert() != null;
    }

    /**
     * R-A7: lehnt eine Lesung einer gelisteten Kennzahl ab (Sicht, Bezugsbasis, Energieziel), trägt sie keine Auswertung -
     * die Liste bleibt, und das Portal liest diese eine Kennzahl wie bisher über {@code …/werte}. Ein unerwarteter Fehler
     * einer Kennzahl nimmt nur ihr die Auswertung (mit Warnung im Log) - die übrigen Karten bleiben stehen. Jede Lesung
     * läuft ohne gemeinsame Transaktion, ein Fehler vergiftet die nächste nicht.
     */
    private KennzahlDto.Kennzahl mitAuswertung(KennzahlDto.Kennzahl k, List<EnergiezielDto.Energieziel> ziele) {
        try {
            return k.mitAuswertung(auswertung(k.id(), null, ziele));
        } catch (KennzahlAbgelehnt | BezugsbasisAbgelehnt | VerbesserungAbgelehnt e) {
            LOG.debug("Kennzahl {}: keine Auswertung ({})", k.kennzeichen(), e.getMessage());
            return k;
        } catch (RuntimeException e) {
            LOG.warn("Kennzahl {}: Auswertung gescheitert, die Liste zeigt sie ohne", k.kennzeichen(), e);
            return k;
        }
    }

    /** Eine Auswertung braucht Monatswerte; eine archivierte Kennzahl trägt keine (die Liste klappt sie zu). */
    static boolean auswertbar(KennzahlDto.Kennzahl k) {
        return k.archiviertAm() == null && k.perioden() != null && k.perioden().contains(MONAT);
    }

    /**
     * Die Auswertung der Kennzahl {@code id} bis zum Monat {@code bis} - ohne {@code bis} der letzte abgeschlossene Monat
     * in der Zone ihrer Geltung, auf der Uhr der Kennzahlen. Von den offenen Energiezielen {@code ziele} der Kennzahl
     * kommt das mit, das {@link #zielFuer} für diesen Monat wählt. Sichtbarkeit wie die Routen der Kennzahl (404
     * außerhalb der Sicht).
     */
    public KennzahlDto.Auswertung auswertung(UUID id, YearMonth bis, List<EnergiezielDto.Energieziel> ziele) {
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(id, null, null, null);
        YearMonth monat = bis != null ? bis : KennzahlAuswertung.letzterMonat(LocalDate.ofInstant(k.jetzt(), k.zone()));
        KennzahlDto.Werte gelesen = werte.werte(id, WERTE_PARAMETER, MONAT,
                monat.minusMonths(KennzahlAuswertung.MONATE_GELESEN - 1).atDay(1).toString(),
                monat.atEndOfMonth().toString(), null);
        Map<String, KennzahlDto.Wert> jeMonat = new HashMap<>();
        gelesen.werte().forEach(w -> jeMonat.put(w.schluessel(), w));
        // Verglichen wird nur gegen eine freigegebene Fassung (U1) - ohne eine gibt es kein Urteil und keine Abweichung.
        // Der Vergleich liest dieselben Monatswerte (sie decken auch den Vormonat des ersten der zwölf Monate).
        LocalDate ersteGeltung = vergleich.ersteGeltung(id);
        BezugsbasisVergleichDto.Vergleich v = ersteGeltung == null ? null
                : vergleich.vergleichUeber(k, gelesen, monat.minusMonths(KennzahlAuswertung.MONATE - 1), monat);
        EnergiezielDto.Energieziel ziel = zielFuer(ziele, monat);
        EnergiezielDto.Stand stand = ziel == null ? null : energieziele.stand(ziel.id());
        return KennzahlAuswertung.auswertung(monat, jeMonat, v, ersteGeltung, stand);
    }

    /**
     * Welches offene Energieziel an der Kennzahl steht, wenn ihr Urteil für {@code monat} gilt - REIN: zuerst das, dessen
     * Zielperiode den Monat enthält; sonst das zuletzt abgelaufene (es ist fällig und wartet auf seine Bewertung); sonst
     * das nächste. Ein Ziel bleibt „offen“, bis es bewertet ist - ein fälliges darf das laufende nicht verdrängen.
     * {@code null} ohne offenes Ziel.
     */
    static EnergiezielDto.Energieziel zielFuer(List<EnergiezielDto.Energieziel> ziele, YearMonth monat) {
        if (ziele == null || ziele.isEmpty()) {
            return null;
        }
        List<EnergiezielDto.Energieziel> laufend = new ArrayList<>();
        List<EnergiezielDto.Energieziel> abgelaufen = new ArrayList<>();
        List<EnergiezielDto.Energieziel> kommend = new ArrayList<>();
        for (EnergiezielDto.Energieziel z : ziele) {
            if (monat.isBefore(beginn(z))) {
                kommend.add(z);
            } else if (monat.isAfter(ende(z))) {
                abgelaufen.add(z);
            } else {
                laufend.add(z);
            }
        }
        if (!laufend.isEmpty()) {
            return laufend.stream().min(ZIEL_FOLGE).orElseThrow();
        }
        if (!abgelaufen.isEmpty()) {
            return abgelaufen.stream()
                    .max(Comparator.comparing(KennzahlAuswertungService::ende)
                            .thenComparing(Comparator.comparing(EnergiezielDto.Energieziel::kennzeichen).reversed()))
                    .orElseThrow();
        }
        return kommend.stream().min(ZIEL_FOLGE).orElseThrow();
    }

    /** {@code JJJJ-MM/JJJJ-MM} - die Form der Zielperiode sichert {@code energieziel_zielperiode_chk}. */
    private static YearMonth beginn(EnergiezielDto.Energieziel z) {
        return YearMonth.parse(z.zielperiode().substring(0, 7));
    }

    private static YearMonth ende(EnergiezielDto.Energieziel z) {
        return YearMonth.parse(z.zielperiode().substring(8, 15));
    }

    /** Die offenen Energieziele je Kennzahl (jedes Ziel wählt {@link #zielFuer} erst mit dem Monat). */
    private Map<UUID, List<EnergiezielDto.Energieziel>> offeneZiele() {
        Map<UUID, List<EnergiezielDto.Energieziel>> je = new HashMap<>();
        for (EnergiezielDto.Energieziel z : energieziele.liste(Set.of(), null, "offen").energieziele()) {
            je.computeIfAbsent(z.kennzahl().id(), x -> new ArrayList<>()).add(z);
        }
        return je;
    }

    /** Mehrere laufende oder kommende Ziele: das mit der frühesten Zielperiode, deterministisch über das Kennzeichen. */
    static final Comparator<EnergiezielDto.Energieziel> ZIEL_FOLGE = Comparator
            .comparing(EnergiezielDto.Energieziel::zielperiode)
            .thenComparing(EnergiezielDto.Energieziel::kennzeichen);

    /** Die Leitkennzahl: das kleinste Kennzeichen führt. */
    static final Comparator<KennzahlDto.Kennzahl> LEIT_FOLGE = Comparator.comparing(KennzahlDto.Kennzahl::kennzeichen);
}
