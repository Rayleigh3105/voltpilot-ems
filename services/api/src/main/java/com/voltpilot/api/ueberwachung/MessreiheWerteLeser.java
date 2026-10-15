package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.topology.TopologyRepository;
import com.voltpilot.api.topology.TopologyRepository.ChannelKey;
import com.voltpilot.api.topology.TopologyRepository.LiveValue;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der {@code messreihe}-Leser (Alerting Scheibe 2, Konzept §6.3): liest jede Reihe einer
 * Komponente (Familie {@code geraet.messwert@komponente:<id>;kanal=<messkanal>}) GENAU SO, wie
 * die Spalte "Wert" von Anlage › Aufbau sie zeigt - über
 * {@link TopologyRepository#liveValues(UUID, List)}, denselben 30-Sekunden-Mittelwert wie das
 * Cockpit (§6.1 Nr. 3) - nie eine eigene Rohwert-Abfrage. Eine neue Komponente oder ein neuer
 * Messkanal im Messpunkt-Katalog ist damit ohne Sondercode überwachbar (§6.3 Nr. 1).
 *
 * <p>UNBEKANNT IST KEINE NULL (§6.1 Nr. 4): keine Probe innerhalb von
 * {@link TopologyRepository#LATEST_VALUE_LOOKBACK} oder eine Komponente ohne (mehr) sichtbare
 * Anlage liefert {@link Lesung#unbekannt()}.
 */
@Component
public class MessreiheWerteLeser implements WerteLeser {

    private final TopologyRepository topologie;
    private final UeberwachungRepository repo;

    public MessreiheWerteLeser(TopologyRepository topologie, UeberwachungRepository repo) {
        this.topologie = topologie;
        this.repo = repo;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"komponente".equals(bezug.art()) || bezug.parameter() == null) {
            return Lesung.unbekannt();
        }
        UUID anlageId = repo.anlageDerKomponente(bezug.id());
        if (anlageId == null) {
            return Lesung.unbekannt();
        }
        List<LiveValue> werte = topologie.liveValues(anlageId,
                List.of(new ChannelKey(bezug.id().toString(), bezug.parameter())));
        if (werte.isEmpty()) {
            return Lesung.unbekannt();
        }
        LiveValue w = werte.get(0);
        return Lesung.zahl(w.mean(), null, w.receivedAt());
    }
}
