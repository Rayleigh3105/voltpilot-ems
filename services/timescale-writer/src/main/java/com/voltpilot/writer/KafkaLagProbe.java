package com.voltpilot.writer;

import com.voltpilot.writer.KafkaConsumerLag.PartitionOffsets;
import java.util.List;

/**
 * Liest die aktuellen committeten Offsets und Log-Enden der Consumer-Gruppe vom
 * Broker. Eine Schnittstelle, damit {@link KafkaLagMetricsCollector} in den
 * reinen Tests eine Attrappe bekommt und in Produktion {@link
 * AdminKafkaLagProbe} - genau die Naht, die {@code FleetMetricsRepository} fuer
 * die api-Metriken bildet.
 */
public interface KafkaLagProbe {

    /**
     * Je Partition der Gruppe der committete Offset und das Log-Ende. Eine
     * Partition, fuer die eines von beidem fehlt, wird AUSGELASSEN (kein
     * erfundener Wert); eine Gruppe ohne einen einzigen committeten Offset gibt
     * eine leere Liste (nie konsumiert = kein Rueckstand zu melden).
     *
     * @throws Exception wenn der Broker nicht erreichbar ist - der Sammler
     *         faengt das und laesst den letzten Stand stehen
     */
    List<PartitionOffsets> currentOffsets() throws Exception;
}
