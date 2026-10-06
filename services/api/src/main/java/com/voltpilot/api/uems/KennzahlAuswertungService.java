package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BinaryOperator;
import org.springframework.stereotype.Service;

/**
 * Die Leser zur {@link KennzahlAuswertung} (Konzept Auswerten a1 §6.4, §10.8): {@code GET /api/v1/kennzahlen?mit=auswertung}
 * und die Leitkachel der Übersicht ({@link PortfolioKpiService}) fragen hier - ein Urteil, eine Ableitung. Je Kennzahl
 * die Monatswerte der letzten 24 Monate, der Vergleich der letzten zwölf (nur mit freigegebener Bezugsbasis) und der
 * Stand des offenen Energieziels; gerechnet wird nichts, die reine {@link KennzahlAuswertung} ordnet.
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
        KennzahlDto.Liste liste = kennzahlen.liste();
        if (mit == null) {
            return liste;
        }
        Map<UUID, EnergiezielDto.Energieziel> ziele = offeneZiele();
        return new KennzahlDto.Liste(liste.kennzahlen().stream()
                .map(k -> auswertbar(k) ? mitAuswertung(k, ziele.get(k.id())) : k)
                .toList(), liste.ausserhalbZugriff());
    }

    /**
     * R-A7: lehnt eine Lesung einer gelisteten Kennzahl ab (Sicht, Bezugsbasis, Energieziel), trägt sie keine Auswertung -
     * die Liste bleibt, und das Portal liest diese eine Kennzahl wie bisher über {@code …/werte}. Ein anderer Fehler ist
     * ein Fehler und bricht die Antwort ab.
     */
    private KennzahlDto.Kennzahl mitAuswertung(KennzahlDto.Kennzahl k, EnergiezielDto.Energieziel ziel) {
        try {
            return k.mitAuswertung(auswertung(k.id(), null, ziel));
        } catch (KennzahlAbgelehnt | BezugsbasisAbgelehnt | VerbesserungAbgelehnt e) {
            return k;
        }
    }

    /**
     * {@code GET /api/v1/kennzahlen/{id}[?mit=auswertung]}: ohne {@code mit} die Kennzahl wie bisher; mit
     * {@code mit=auswertung} trägt sie - wie in der Liste - ihre Auswertung (Konzept Auswerten a1 §6.5, die Seite einer
     * Kennzahl), mit dem Stand ihres offenen Energieziels. Ein anderer Wert ist 400 {@code anfrage_ungueltig}.
     */
    public KennzahlDto.Kennzahl eine(UUID id, String mit) {
        if (mit != null && !MIT_AUSWERTUNG.equals(mit)) {
            throw KennzahlAbgelehnt.anfrage("mit");
        }
        KennzahlDto.Kennzahl k = kennzahlen.eine(id);
        if (mit == null || !auswertbar(k)) {
            return k;
        }
        EnergiezielDto.Energieziel ziel = energieziele.liste(Set.of(), null, "offen").energieziele().stream()
                .filter(z -> z.kennzahl().id().equals(id)).min(ZIEL_FOLGE).orElse(null);
        return mitAuswertung(k, ziel);
    }

    /** Eine Auswertung braucht Monatswerte; eine archivierte Kennzahl trägt keine (die Liste klappt sie zu). */
    static boolean auswertbar(KennzahlDto.Kennzahl k) {
        return k.archiviertAm() == null && k.perioden() != null && k.perioden().contains(MONAT);
    }

    /**
     * Die Auswertung der Kennzahl {@code id} bis zum Monat {@code bis} - ohne {@code bis} der letzte abgeschlossene Monat
     * in der Zone ihrer Geltung. {@code ziel} ist das offene Energieziel, dessen Stand mitkommt ({@code null} ohne).
     * Sichtbarkeit wie die Routen der Kennzahl (404 außerhalb der Sicht).
     */
    public KennzahlDto.Auswertung auswertung(UUID id, YearMonth bis, EnergiezielDto.Energieziel ziel) {
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
        YearMonth von = monat.minusMonths(KennzahlAuswertung.MONATE - 1);
        BezugsbasisVergleichDto.Vergleich v = ersteGeltung == null ? null
                : vergleich.vergleichUeber(k, gelesen, von, monat);
        EnergiezielDto.Stand stand = ziel == null ? null : energieziele.stand(ziel.id());
        return KennzahlAuswertung.auswertung(monat, jeMonat, v, ersteGeltung, seitGeltung(k, gelesen, v, ersteGeltung,
                von, monat), stand);
    }

    /**
     * §10.6: der Zeitraum beginnt mit dem ersten der zwölf Monate, für dessen letzten Tag eine Fassung gilt (P4) - die
     * Monate davor hätte der Zeitraum sonst gegen eine Fassung gerechnet, die für sie noch gar nicht galt. Gilt sie für
     * alle zwölf, ist es der Vergleich selbst; gilt sie für keinen, gibt es keinen Zeitraum.
     */
    private BezugsbasisVergleichDto.Vergleich seitGeltung(KennzahlService.BasisKennzahl k, KennzahlDto.Werte gelesen,
            BezugsbasisVergleichDto.Vergleich v, LocalDate ersteGeltung, YearMonth von, YearMonth bis) {
        if (v == null) {
            return null;
        }
        YearMonth erster = YearMonth.from(ersteGeltung);
        if (erster.isAfter(bis)) {
            return null;
        }
        return erster.isAfter(von) ? vergleich.vergleichUeber(k, gelesen, erster, bis) : v;
    }

    /**
     * Das offene Energieziel je Kennzahl; hat eine mehrere, das mit der frühesten Zielperiode (das laufende vor dem
     * nächsten) - dieselbe Wahl für jede Kennzahl, deterministisch über das Kennzeichen.
     */
    private Map<UUID, EnergiezielDto.Energieziel> offeneZiele() {
        BinaryOperator<EnergiezielDto.Energieziel> frueher = (a, b) -> ZIEL_FOLGE.compare(a, b) <= 0 ? a : b;
        Map<UUID, EnergiezielDto.Energieziel> je = new HashMap<>();
        for (EnergiezielDto.Energieziel z : energieziele.liste(Set.of(), null, "offen").energieziele()) {
            je.merge(z.kennzahl().id(), z, frueher);
        }
        return je;
    }

    static final Comparator<EnergiezielDto.Energieziel> ZIEL_FOLGE = Comparator
            .comparing(EnergiezielDto.Energieziel::zielperiode)
            .thenComparing(EnergiezielDto.Energieziel::kennzeichen);
}
