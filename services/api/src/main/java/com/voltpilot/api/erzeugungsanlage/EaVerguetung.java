package com.voltpilot.api.erzeugungsanlage;

import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.EinspeiseverguetungStand;
import com.voltpilot.api.optimizer.SlotEconomics;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Der Satz EINER Erzeugungsanlage mit Herkunft (Messkonzepte S1, F3: die Vergütung gehört zur EA am Netzanschluss) -
 * rein, ohne Datenbank. Dieselbe Regel wie die Karte „Einspeisevergütung“ der Anlage
 * ({@link EinspeiseverguetungStand}), nur aus den Angaben der EA: ihrer Inbetriebnahme, ihrer Leistung, ihrem
 * angegebenen Satz. Der hergeleitete Satz kommt aus demselben {@link EegRates}-Satzplan wie Optimierer und Erlöse.
 *
 * <p>NUR ANZEIGE: Fahrplan und Erlöse rechnen bis Schritt S4 weiter mit dem einen Satz der Anlage. Für eine EA, die
 * der Anlage folgt (EA 1 einer einfachen Anlage), ergibt diese Regel genau den Stand der Karte - das prüft
 * {@code ErzeugungsanlageApiTest}.
 *
 * <p>{@code zustand} ist dasselbe geschlossene Vokabular wie an der Karte ({@code einspeiseverguetung-vectors.json},
 * Block {@code zustaende}); {@code naeherung} sagt, warum ein hergeleiteter Satz nur genähert ist.
 */
public final class EaVerguetung {

    /** Der Satzplan kennt vor seinem ersten Band keinen Satz; er nimmt den ersten. */
    public static final String VOR_ERSTEM_BAND = "vor_erstem_band";
    /** Vor dem EEG 2023 rechnet der Satzplan mit Jahresstufen. */
    public static final String JAHRESSTUFEN = "jahresstufen";
    /** Der Satzplan kennt nur Überschusseinspeisung (Teileinspeisung); Volleinspeisung hat höhere Sätze. */
    public static final String VOLLEINSPEISUNG = "volleinspeisung";
    /** Ohne Leistung nimmt der Satzplan das Band bis 10 kWp. */
    public static final String LEISTUNG_UNBEKANNT = "leistung_unbekannt";

    private static final int CT_SCALE = 3;

    /**
     * @param zustand angegeben · eeg · eeg_abgelaufen · ohne_angabe · netzladen · direktvermarktung
     * @param wirksamCtKwh der feste Satz, der für diese EA gälte; null = keiner (Börse)
     * @param angegebenCtKwh der angegebene Satz der EA am Stichtag; null = keiner
     * @param hergeleitetCtKwh der Satz aus dem Satzplan für ihre Inbetriebnahme und Leistung; null ohne Inbetriebnahme
     * @param naeherung warum der hergeleitete Satz genähert ist (leer = genau)
     * @param foerderendeAm der letzte Tag der EEG-Vergütung; null ohne Inbetriebnahme
     * @param ohneVerguetungBeiNegativpreis § 51a EEG gilt für diese EA
     */
    public record Stand(String zustand, BigDecimal wirksamCtKwh, BigDecimal angegebenCtKwh,
            BigDecimal hergeleitetCtKwh, List<String> naeherung, LocalDate foerderendeAm,
            boolean ohneVerguetungBeiNegativpreis) {
    }

    private EaVerguetung() {
    }

    /**
     * Der Stand einer EA am Stichtag.
     *
     * @param plantKind Veräußerungsform der Anlage (heute je Anlage, bis der Förderweg in die EA zieht)
     * @param netzladenErlaubt Netzladen der Anlage (Ausschließlichkeitsprinzip, je Anlage)
     */
    public static Stand von(String plantKind, boolean netzladenErlaubt, LocalDate inbetriebnahme,
            Boolean abSolarspitzengesetz, BigDecimal leistungKwp, String einspeiseart, BigDecimal angegebenCtKwh,
            LocalDate stichtag, EegRates rates) {
        BigDecimal hergeleitet = inbetriebnahme == null ? null
                : ct(rates.festeVerguetungCtPerKwh(inbetriebnahme,
                        leistungKwp == null ? null : leistungKwp.doubleValue()));
        List<String> naeherung = new ArrayList<>();
        if (hergeleitet != null) {
            if (inbetriebnahme.isBefore(rates.firstBandFrom())) {
                naeherung.add(VOR_ERSTEM_BAND);
            } else if (inbetriebnahme.isBefore(EinspeiseverguetungStand.GENAUER_SATZPLAN_AB)) {
                naeherung.add(JAHRESSTUFEN);
            }
            if ("voll".equals(einspeiseart)) {
                naeherung.add(VOLLEINSPEISUNG);
            }
            if (leistungKwp == null) {
                naeherung.add(LEISTUNG_UNBEKANNT);
            }
        }
        String zustand = zustand(plantKind, netzladenErlaubt, inbetriebnahme, angegebenCtKwh, stichtag);
        BigDecimal wirksam = switch (zustand) {
            case "angegeben" -> angegebenCtKwh;
            case "eeg" -> hergeleitet;
            default -> null;
        };
        return new Stand(zustand, wirksam, angegebenCtKwh, hergeleitet, List.copyOf(naeherung),
                inbetriebnahme == null ? null : LocalDate.of(inbetriebnahme.getYear() + 20, 12, 31),
                SlotEconomics.solarspitzengesetzGilt(inbetriebnahme, abSolarspitzengesetz));
    }

    /**
     * Dieselbe Reihenfolge wie {@code EinspeiseverguetungStand.zustand}: Veräußerungsform, Netzladen, eine Angabe,
     * dann die Herleitung bis zum Ende im 20. Jahr nach dem Inbetriebnahmejahr (gegen das Jahr des Stichtags, wie die
     * Herkunft der Erlöse gegen das Jahr von heute).
     */
    static String zustand(String plantKind, boolean netzladenErlaubt, LocalDate inbetriebnahme,
            BigDecimal angegebenCtKwh, LocalDate stichtag) {
        if ("direktvermarktung".equals(plantKind)) {
            return "direktvermarktung";
        }
        if (netzladenErlaubt) {
            return "netzladen";
        }
        if (angegebenCtKwh != null) {
            return "angegeben";
        }
        if (inbetriebnahme == null) {
            return "ohne_angabe";
        }
        return stichtag.getYear() <= inbetriebnahme.getYear() + 20 ? "eeg" : "eeg_abgelaufen";
    }

    private static BigDecimal ct(double value) {
        return BigDecimal.valueOf(value).setScale(CT_SCALE, RoundingMode.HALF_UP);
    }
}
