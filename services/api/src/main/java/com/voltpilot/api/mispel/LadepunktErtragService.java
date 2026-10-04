package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * MiSpeL MP-41a: die Erträge am Ladepunkt im Kalendermonat (Verlauf › Erlöse, unter der MiSpeL-Karte von MP-18). Liest
 * den gespeicherten Monatslauf der Abgrenzung (MP-8/MP-32) wie die MiSpeL-Karte und rechnet nichts neu; die reinen
 * Regeln stehen in {@link LadepunktErtraege}.
 */
@Service
public class LadepunktErtragService {

    private final MispelAbgrenzungRepository laeufe;
    private final MispelMengenService mengen;
    private final LadepunktService ladepunkte;

    public LadepunktErtragService(MispelAbgrenzungRepository laeufe, MispelMengenService mengen,
            LadepunktService ladepunkte) {
        this.laeufe = laeufe;
        this.mengen = mengen;
        this.ladepunkte = ladepunkte;
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
                teile.isEmpty() ? null : mengen.marktwert(siteId, monat.getYear()));
    }
}
