package com.voltpilot.api.optimizer;

import com.voltpilot.api.repo.EinspeiseverguetungRepository.Grundlage;
import com.voltpilot.api.web.dto.EinspeiseverguetungDto;
import com.voltpilot.api.web.dto.EinspeiseverguetungDto.EinheitMischsatzDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Der Stand der Karte "Einspeisevergütung": aus der {@link Grundlage} einer
 * Anlage, was heute wirkt und woher es kommt. Rein, ohne Datenbank - die eine
 * Frage, ob die Einspeisung FEST bewertet ist und womit, beantwortet die
 * SQL-Wahrheit der Erlöse ({@code Grundlage.quelle} =
 * {@link SlotEconomics#exportVerguetungQuelleSql}); hier wird sie nur benannt
 * und um die Zahlen ergänzt, die die Karte zeigt. So kann die Karte nie einen
 * Satz behaupten, mit dem die Erlöse nicht rechnen.
 *
 * <p>Der hergeleitete Satz kommt aus demselben {@link EegRates}-Satzplan wie
 * Optimierer und Erlöse (inkl. {@code OPTIMIZER_EEG_RATES_JSON}); die Angabe
 * des Kunden ist eine Ebene darüber und ändert den Satzplan nicht.
 */
public final class EinspeiseverguetungStand {

    /**
     * Ab dieser Inbetriebnahme rechnet der Satzplan exakt (die Bänder des EEG
     * 2023, {@link EegRates} / config.py "EEG 2023 (exact)"); davor stehen
     * Jahresstufen und vor 2012 das erste Band - ein Näherungswert, den die
     * Karte so nennt und für den sie die genaue Angabe anbietet.
     */
    static final LocalDate GENAUER_SATZPLAN_AB = LocalDate.of(2022, 7, 30);

    /** ct/kWh mit einer Stelle mehr, als das Portal zeigt (SchedulePricingService). */
    private static final int CT_SCALE = 3;

    private EinspeiseverguetungStand() {
    }

    /** Der Stand der Karte aus der Grundlage einer Anlage, ohne Einheiten (die
     * bisherige, unveränderte Anlagen-Rechnung - weiterhin der einzige Weg bei
     * weniger als zwei bestätigten PV-Einheiten, siehe {@link #von(Grundlage,
     * List, EegRates)}). */
    public static EinspeiseverguetungDto von(Grundlage g, EegRates rates) {
        LocalDate inbetrieb = g.inbetriebnahme();
        Double kwp = g.leistungKwp() == null ? null : g.leistungKwp().doubleValue();
        BigDecimal hergeleitet = inbetrieb == null ? null
                : ct(rates.festeVerguetungCtPerKwh(inbetrieb, kwp));
        String zustand = zustand(g);
        BigDecimal wirksam = switch (zustand) {
            case "angegeben" -> g.angegebenCtKwh();
            case "eeg" -> hergeleitet;
            default -> null;
        };
        boolean direktvermarktung = "direktvermarktung".equals(g.plantKind());
        return new EinspeiseverguetungDto(
                zustand,
                wirksam,
                g.angegebenCtKwh(),
                // Die Antwort zählt nur ohne Datum - mit Datum wird sie nicht gezeigt.
                inbetrieb == null ? g.inbetriebnahmeAbSolarspitzengesetz() : null,
                hergeleitet,
                inbetrieb != null && inbetrieb.isBefore(GENAUER_SATZPLAN_AB),
                inbetrieb,
                g.leistungKwp(),
                inbetrieb == null ? null : LocalDate.of(inbetrieb.getYear() + 20, 12, 31),
                SlotEconomics.solarspitzengesetzGilt(inbetrieb, g.inbetriebnahmeAbSolarspitzengesetz(), kwp),
                direktvermarktung ? g.anzulegenderWertCtKwh() : null,
                List.of());
    }

    /**
     * Der Stand der Karte MIT den bestätigten PV-Einheiten (S4, vp-mastr-
     * mehrere-einheiten-konzept §5.2: "zeigt den Mischsatz mit Rechenweg").
     * Bei weniger als zwei Einheiten, bei Direktvermarktung, mit Netzladen,
     * oder wenn der Mischsatz nicht eindeutig feststeht (eine Einheit ohne
     * Datum und keine Angabe, oder eine abgelaufene Einheit ohne Angabe),
     * fällt diese Methode auf {@link #von(Grundlage, EegRates)} zurück -
     * UNVERÄNDERT, also für jede Bestandsanlage mit genau einer Einheit
     * byte-gleich (ihr Anteil wäre exakt 1.0 ohnehin, aber diese Methode
     * berührt den Pfad für weniger als zwei Einheiten gar nicht erst).
     */
    public static EinspeiseverguetungDto von(Grundlage g, List<SlotEconomics.UnitPv> einheiten,
            EegRates rates) {
        if (einheiten == null || einheiten.size() < 2
                || "direktvermarktung".equals(g.plantKind()) || g.netzladenErlaubt()) {
            return von(g, rates);
        }
        double totalKwp = 0.0;
        for (SlotEconomics.UnitPv u : einheiten) {
            totalKwp += u.kwp();
        }
        // Der hergeleitete Mischsatz steht wie beim Einzel-Asset UNABHAENGIG
        // davon, ob er gerade wirkt (das Blatt zeigt ihn als Vorschau der
        // Karte „Aus dem EEG herleiten" auch, wenn eine Angabe aktiv ist) -
        // nur wenn JEDE Einheit ein eigenes, nicht abgelaufenes Datum hat;
        // sonst null (eine solche Einheit waere nur am Boersenpreis zu
        // bewerten, der nicht in einen einzelnen ct/kWh-Mischsatz passt).
        boolean jedeDatiertUndAktiv = einheiten.stream().allMatch(u ->
                u.commissionedOn() != null
                        && !EegRates.remunerationExpired(u.commissionedOn(), Instant.now()));
        BigDecimal hergeleitet = null;
        if (jedeDatiertUndAktiv) {
            double summe = 0.0;
            for (SlotEconomics.UnitPv u : einheiten) {
                summe += (u.kwp() / totalKwp) * rates.festeVerguetungCtPerKwh(u.commissionedOn(), u.kwp());
            }
            hergeleitet = ct(summe);
        }
        boolean angegeben = g.angegebenCtKwh() != null;
        if (!angegeben && !jedeDatiertUndAktiv) {
            // Weder Angabe noch eindeutige Herleitung: die Anlagen-Rechnung bleibt.
            return von(g, rates);
        }
        List<EinheitMischsatzDto> rechenweg = new ArrayList<>();
        boolean irgendeinS51a = false;
        for (SlotEconomics.UnitPv u : einheiten) {
            double satz = angegeben
                    ? g.angegebenCtKwh().doubleValue()
                    : rates.festeVerguetungCtPerKwh(u.commissionedOn(), u.kwp());
            rechenweg.add(new EinheitMischsatzDto(
                    u.commissionedOn(), BigDecimal.valueOf(u.kwp()), ct(satz)));
            irgendeinS51a |= SlotEconomics.solarspitzengesetzGilt(
                    u.commissionedOn(), g.inbetriebnahmeAbSolarspitzengesetz(), u.kwp());
        }
        return new EinspeiseverguetungDto(
                angegeben ? "angegeben" : "eeg",
                angegeben ? g.angegebenCtKwh() : hergeleitet,
                g.angegebenCtKwh(),
                null, // mehrere Einheiten: die Antwort ist je Einheit im Rechenweg, nicht hier
                hergeleitet, // die Vorschau „Aus dem EEG herleiten" - unabhaengig von angegeben
                false,
                null, // keine EINE Inbetriebnahme - siehe einheiten
                null, // keine EINE Leistung - siehe einheiten
                null, // kein EIN Ende - jede Einheit hat ihr eigenes
                irgendeinS51a,
                null,
                List.copyOf(rechenweg));
    }

    /**
     * Das geschlossene Vokabular von {@link EinspeiseverguetungDto#zustand()}.
     * Die feste Bewertung ({@code angegeben}/{@code eeg}) nennt allein die
     * SQL-Herkunft; die übrigen Zustände sagen nur, WARUM sie fehlt: zuerst die
     * Veräußerungsform (bei Direktvermarktung gibt es keinen festen Satz, mit
     * oder ohne Netzladen), dann Netzladen (Ausschließlichkeitsprinzip), dann
     * die fehlende Grundlage.
     */
    static String zustand(Grundlage g) {
        if ("direktvermarktung".equals(g.plantKind())) {
            return "direktvermarktung";
        }
        if (g.netzladenErlaubt()) {
            return "netzladen";
        }
        if (g.quelle() != null) {
            return g.quelle();
        }
        return g.inbetriebnahme() != null ? "eeg_abgelaufen" : "ohne_angabe";
    }

    private static BigDecimal ct(double value) {
        return BigDecimal.valueOf(value).setScale(CT_SCALE, RoundingMode.HALF_UP);
    }
}
