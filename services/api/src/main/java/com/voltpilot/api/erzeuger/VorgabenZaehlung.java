package com.voltpilot.api.erzeuger;

import com.voltpilot.api.erzeuger.VorgabenRepository.Zeile;
import com.voltpilot.api.web.dto.ErzeugerVorgabenDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Zählung der Vorgaben je Tag oder Monat (UEMS EZ-7, Konzept §4.6 „Zählung“): Anzahl, Summe Dauer, Summe
 * geschätzte Energie — je Urheber, Art und Einheit. Rein, ohne Datenbank.
 *
 * <p>Eine Vorgabe zählt in jedem Abschnitt, den sie berührt (über Mitternacht an beiden Tagen); ihre Dauer nur mit
 * dem Anteil darin, eine laufende bis zur letzten Lesung, in der sie galt. Die Energie liegt je Tag an der Vorgabe
 * ({@code energie_je_tag}); der Euro-Wert teilt sich im Verhältnis der Energie.
 */
public final class VorgabenZaehlung {

    static final ZoneId ZONE = VorgabenAbleitung.ZONE;

    private VorgabenZaehlung() {}

    /** Die Gruppen eines Abschnitts {@code [beginn, ende)}; seine Tage sind {@code ersterTag} … {@code letzterTag}. */
    public static List<ErzeugerVorgabenDto.Gruppe> gruppen(List<Zeile> zeilen, Instant beginn, Instant ende,
            LocalDate ersterTag, LocalDate letzterTag) {
        Map<String, Summe> je = new LinkedHashMap<>();
        for (Zeile z : sortiert(zeilen)) {
            if (!beruehrt(z, beginn, ende)) {
                continue;
            }
            Summe s = je.computeIfAbsent(z.urheber() + "|" + z.art() + "|" + z.teNr(),
                    k -> new Summe(z.urheber(), z.art(), z.teNr()));
            s.nimm(z, beginn, ende, ersterTag, letzterTag);
        }
        return je.values().stream().map(Summe::gruppe).toList();
    }

    /**
     * Je Urheber über alle Arten, nur die ganze Anlage ({@code te_nr} leer): die Dauer als Vereinigung der
     * Zeiträume im Abschnitt, damit überlappende Arten desselben Urhebers nicht doppelt zählen.
     */
    public static List<ErzeugerVorgabenDto.JeUrheber> jeUrheber(List<Zeile> zeilen, Instant beginn, Instant ende,
            LocalDate ersterTag, LocalDate letzterTag) {
        List<ErzeugerVorgabenDto.JeUrheber> out = new ArrayList<>();
        for (String urheber : VorgabenAbleitung.URHEBER) {
            List<Zeile> eigene = sortiert(zeilen).stream()
                    .filter(z -> z.teNr() == null && z.urheber().equals(urheber) && beruehrt(z, beginn, ende)).toList();
            if (eigene.isEmpty()) {
                continue;
            }
            Summe s = new Summe(urheber, null, null);
            eigene.forEach(z -> s.nimm(z, beginn, ende, ersterTag, letzterTag));
            out.add(new ErzeugerVorgabenDto.JeUrheber(urheber, eigene.size(), vereinigt(eigene, beginn, ende),
                    s.energie(), s.wert()));
        }
        return out;
    }

    /**
     * Berührt die Vorgabe {@code [beginn, ende)}? Eine ohne Dauer zählt, wenn sie darin beginnt. Der Verlauf (EZ-9)
     * schneidet seine Ereignisse nach derselben Regel.
     */
    public static boolean beruehrt(Zeile z, Instant beginn, Instant ende) {
        boolean beginntDarin = !z.beginn().isBefore(beginn) && z.beginn().isBefore(ende);
        return beginntDarin || (z.beginn().isBefore(ende) && z.belegtBis().isAfter(beginn));
    }

    /** Ihr Anteil an {@code [beginn, ende)} in Sekunden. */
    static long anteilS(Zeile z, Instant beginn, Instant ende) {
        Instant von = z.beginn().isAfter(beginn) ? z.beginn() : beginn;
        Instant bis = z.belegtBis().isBefore(ende) ? z.belegtBis() : ende;
        return bis.isAfter(von) ? Duration.between(von, bis).getSeconds() : 0;
    }

    private static long vereinigt(List<Zeile> zeilen, Instant beginn, Instant ende) {
        List<Instant[]> teile = new ArrayList<>();
        for (Zeile z : zeilen) {
            Instant von = z.beginn().isAfter(beginn) ? z.beginn() : beginn;
            Instant bis = z.belegtBis().isBefore(ende) ? z.belegtBis() : ende;
            if (bis.isAfter(von)) {
                teile.add(new Instant[] {von, bis});
            }
        }
        teile.sort(Comparator.comparing(t -> t[0]));
        long summe = 0;
        Instant offenVon = null;
        Instant offenBis = null;
        for (Instant[] t : teile) {
            if (offenBis != null && !t[0].isAfter(offenBis)) {
                offenBis = t[1].isAfter(offenBis) ? t[1] : offenBis;
                continue;
            }
            if (offenBis != null) {
                summe += Duration.between(offenVon, offenBis).getSeconds();
            }
            offenVon = t[0];
            offenBis = t[1];
        }
        if (offenBis != null) {
            summe += Duration.between(offenVon, offenBis).getSeconds();
        }
        return summe;
    }

    private static List<Zeile> sortiert(List<Zeile> zeilen) {
        List<Zeile> out = new ArrayList<>(zeilen);
        out.sort(Comparator.comparing((Zeile z) -> VorgabenAbleitung.URHEBER.indexOf(z.urheber()))
                .thenComparing(z -> VorgabenAbleitung.ARTEN.indexOf(z.art()))
                .thenComparing(Zeile::teNr, Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparing(Zeile::beginn));
        return out;
    }

    /** Die Summen einer Gruppe. */
    private static final class Summe {
        final String urheber;
        final String art;
        final Integer teNr;
        int anzahl;
        long dauerS;
        BigDecimal energie;
        BigDecimal wert;
        int ohneSchaetzung;
        int unvollstaendig;

        Summe(String urheber, String art, Integer teNr) {
            this.urheber = urheber;
            this.art = art;
            this.teNr = teNr;
        }

        void nimm(Zeile z, Instant beginn, Instant ende, LocalDate ersterTag, LocalDate letzterTag) {
            anzahl++;
            dauerS += anteilS(z, beginn, ende);
            if (z.unvollstaendig()) {
                unvollstaendig++;
            }
            if (z.energieKwh() == null) {
                ohneSchaetzung++;
                return;
            }
            BigDecimal hier = BigDecimal.ZERO;
            for (Map.Entry<String, BigDecimal> e : z.energieJeTag().entrySet()) {
                LocalDate tag = LocalDate.parse(e.getKey());
                if (!tag.isBefore(ersterTag) && !tag.isAfter(letzterTag)) {
                    hier = hier.add(e.getValue());
                }
            }
            energie = energie == null ? hier : energie.add(hier);
            if (z.wertEur() != null) {
                BigDecimal anteil = z.energieKwh().signum() == 0 ? BigDecimal.ZERO
                        : z.wertEur().multiply(hier).divide(z.energieKwh(), 2, RoundingMode.HALF_UP);
                wert = wert == null ? anteil : wert.add(anteil);
            }
        }

        BigDecimal energie() {
            return energie == null ? null : energie.setScale(3, RoundingMode.HALF_UP);
        }

        BigDecimal wert() {
            return wert;
        }

        ErzeugerVorgabenDto.Gruppe gruppe() {
            return new ErzeugerVorgabenDto.Gruppe(urheber, art, teNr, anzahl, dauerS, energie(), wert(),
                    ohneSchaetzung, unvollstaendig);
        }
    }
}
