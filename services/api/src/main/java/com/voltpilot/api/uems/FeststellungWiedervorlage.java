package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-21 (WV1, FS1): die Wiedervorlage-Quelle „Feststellungen“ — je offene Feststellung ihre Frist, so wie
 * die Liste sie beim Abruf ableitet ({@link FeststellungService#liste}: gesetzte Frist, sonst festgestellt am + Vorgabe).
 * Eine abgeschlossene hat keine Frist und keine Zeile.
 */
@Component
@Order(30)
public class FeststellungWiedervorlage implements WiedervorlageQuelle {

    private final FeststellungService feststellungen;

    public FeststellungWiedervorlage(FeststellungService feststellungen) {
        this.feststellungen = feststellungen;
    }

    @Override
    public List<Frist> fristen(LocalDate abruf) {
        var aus = new ArrayList<Frist>();
        for (var f : feststellungen.liste(abruf).feststellungen()) {
            if (f.lage() == null || f.lage().faelligAm() == null) continue;
            aus.add(new Frist("feststellung", f.kennzeichen(), "Feststellung — Frist", f.lage().faelligAm(),
                    f.verantwortlich() == null ? null : f.verantwortlich().name(), f.id(), null));
        }
        return aus;
    }
}
