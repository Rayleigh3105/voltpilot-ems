package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * MiSpeL MP-41a: die Erträge am Ladepunkt im Kalendermonat (Verlauf › Erlöse, unter der MiSpeL-Karte von MP-18). Liest
 * den gespeicherten Monatslauf der Abgrenzung (MP-8/MP-32) wie die MiSpeL-Karte und rechnet nichts neu; die reinen
 * Regeln stehen in {@link LadepunktErtraege}. Seit MP-33e kommt der Vergleich „nur laden“ aus der Ablage je
 * Viertelstunde ({@link LadepunktMesslatteRepository}) — nur, wenn sie jede vergangene Viertelstunde jedes Teils für
 * jeden Ladepunkt trägt; eine Lücke ist eine fehlende Summe, keine kleinere.
 */
@Service
public class LadepunktErtragService {

    private final MispelAbgrenzungRepository laeufe;
    private final MispelMengenService mengen;
    private final LadepunktService ladepunkte;
    private final LadepunktMesslatteRepository messlatte;
    private Clock uhr = Clock.systemUTC();

    public LadepunktErtragService(MispelAbgrenzungRepository laeufe, MispelMengenService mengen,
            LadepunktService ladepunkte, LadepunktMesslatteRepository messlatte) {
        this.laeufe = laeufe;
        this.mengen = mengen;
        this.ladepunkte = ladepunkte;
        this.messlatte = messlatte;
    }

    /** Für Tests: die Uhr, bis zu der Viertelstunden vergangen sind. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** {@code null} für eine fremde oder unbekannte Anlage. */
    public LadepunktErtraege.Monat monat(UUID siteId, YearMonth monat) {
        if (monat.isBefore(MispelNachweisService.AB)) {
            throw new LadepunktAbgelehnt("zeitraum_ungueltig", 400, "Die Festlegung gilt ab "
                    + MispelNachweisService.AB + ".", Map.of("feld", "monat"));
        }
        MispelMengen.Preise preise = mengen.preise(siteId);
        if (preise == null) {
            return null;
        }
        List<Zeile> zeilen = laeufe.desMonats(siteId, monat.atDay(1));
        List<LadepunktErtraege.Teil> teile = new ArrayList<>();
        if (!zeilen.isEmpty()) {
            for (MispelNachweis.Lauf l : MispelNachweis.monat(siteId, monat, zeilen).laeufe()) {
                LadepunktErtraege.Teil t = LadepunktErtraege.teil(l);
                if (t != null) {
                    teile.add(t);
                }
            }
        }
        Map<UUID, LadepunktErtraege.Ladepunkt> namen = new LinkedHashMap<>();
        for (LadepunktErtraege.Teil t : teile) {
            for (LadepunktService.Ansicht a : ladepunkte.anlage(siteId, t.letzterTag())) {
                if (LadepunktRegeln.LADEPUNKT_DER_FESTLEGUNG.equals(a.einordnung())) {
                    LadepunktRepository.Komponente k = a.komponente();
                    namen.putIfAbsent(k.id(), new LadepunktErtraege.Ladepunkt(k.id(),
                            k.label() != null ? k.label() : k.chargePointId(), a.einordnung()));
                }
            }
        }
        return LadepunktErtraege.monat(siteId, monat.toString(), List.copyOf(namen.values()), teile, preise,
                teile.isEmpty() ? null : mengen.marktwert(siteId, monat.getYear()),
                teile.isEmpty() ? null : messlatte(siteId, teile, namen.keySet()));
    }

    /**
     * Die Messlatte über die Teile (Berliner Tage, letzter eingeschlossen; Viertelstunden halboffen) bis zur
     * laufenden Viertelstunde — {@code null}, sobald einem Ladepunkt eine Viertelstunde fehlt oder es keinen gibt.
     */
    private LadepunktErtraege.Messlatte messlatte(UUID siteId, List<LadepunktErtraege.Teil> teile,
            Set<UUID> lps) {
        if (lps.isEmpty()) {
            return null;
        }
        Instant jetzt = uhr.instant().truncatedTo(ChronoUnit.SECONDS);
        jetzt = jetzt.minusSeconds(jetzt.getEpochSecond() % 900);
        BigDecimal[] s = new BigDecimal[8];
        Arrays.fill(s, BigDecimal.ZERO);
        boolean getragen = false;
        for (LadepunktErtraege.Teil t : teile) {
            Instant von = t.ersterTag().atStartOfDay(MispelNachweis.ZONE).toInstant();
            Instant bis = t.letzterTag().plusDays(1).atStartOfDay(MispelNachweis.ZONE).toInstant();
            if (bis.isAfter(jetzt)) {
                bis = jetzt;
            }
            if (!bis.isAfter(von)) {
                continue;
            }
            getragen = true;
            long erwartet = Duration.between(von, bis).getSeconds() / 900;
            Map<UUID, LadepunktMesslatteRepository.Summe> je = messlatte.summen(siteId, von, bis);
            for (UUID lp : lps) {
                LadepunktMesslatteRepository.Summe z = je.get(lp);
                if (z == null || z.viertelstunden() != erwartet) {
                    return null;
                }
                BigDecimal[] w = {z.wenigerGekauftEur(), z.wenigerGekauftKwh(), z.mehrGeladenEur(),
                    z.mehrGeladenKwh(), z.insNetzVerkauftEur(), z.insNetzVerkauftKwh(), z.akkuVerschleissEur(),
                    z.rueckgespeistKwh()};
                for (int i = 0; i < s.length; i++) {
                    s[i] = s[i].add(w[i]);
                }
            }
        }
        // Ohne eine vergangene Viertelstunde gibt es nichts zu vergleichen — keine Summe, keine 0.
        return getragen ? new LadepunktErtraege.Messlatte(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]) : null;
    }
}
