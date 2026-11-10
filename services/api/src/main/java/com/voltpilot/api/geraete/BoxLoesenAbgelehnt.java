package com.voltpilot.api.geraete;

import com.voltpilot.api.geraete.BoxLoesenRegel.BoxBefund;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * 409 {@code box_hat_sich_gemeldet} (Vertrag Abschnitt 3.5): die Gründe UND der Befund, auf dem sie
 * beruhen - das Portal zeigt beides wörtlich („Hat Daten gespeichert · Herzschlag vor 12 s · …").
 * Nichts wurde geändert; die Transaktion von {@link BoxLoesenService} rollt zurück.
 */
public final class BoxLoesenAbgelehnt extends ResponseStatusException {

    private final List<String> gruende;
    private final BoxBefund befund;

    public BoxLoesenAbgelehnt(List<String> gruende, BoxBefund befund) {
        super(HttpStatus.CONFLICT, "box_hat_sich_gemeldet: " + gruende);
        this.gruende = gruende;
        this.befund = befund;
    }

    public Map<String, Object> koerper() {
        return Map.of("grund", "box_hat_sich_gemeldet", "gruende", gruende, "fakten", Map.of(
                "herzschlagAm", String.valueOf(befund.herzschlagAm()),
                "messwertAm", String.valueOf(befund.messwertAm()),
                "meldungAm", String.valueOf(befund.meldungAm()),
                "hatZustaendigkeiten", befund.hatZustaendigkeiten(),
                "schluesselAbgeholtAm", String.valueOf(befund.schluesselAbgeholtAm())));
    }
}
