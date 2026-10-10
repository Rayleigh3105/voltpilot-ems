package com.voltpilot.api.measurement;

import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Revisions-Anstoß des Messplans (AP-07 IP-18b Einschalten): meldet eine Box
 * {@link MeasurementConfigPublisher#FAEHIGKEIT_JE_KOMPONENTE} neu - nach ihrem Update - oder nicht
 * mehr - nach einem Zurücksetzen -, braucht sie den Plan in der anderen Form. Ihr Core weist
 * dieselbe Revision mit anderem Inhalt ab ({@code stale revision}), also legt
 * {@link MeasurementSelectionService#planNeuAusliefern} Revision + 1 an und der
 * {@link MeasurementConfigReconciler} liefert aus.
 *
 * <p>Nach dem Commit der Fähigkeitsmeldung und in eigener Transaktion: ein Fehler hier nimmt der
 * Box nie ihre gemeldeten Fähigkeiten. Ein verlorener Anstoß schadet nicht - die Box behält den
 * Plan, den sie hat, bis zur nächsten Revision. Jede andere Änderung der Liste stößt nichts an.
 */
@Component
public class MessplanRevisionsAnstoss {
    private static final Logger log = LoggerFactory.getLogger(MessplanRevisionsAnstoss.class);
    private final MeasurementSelectionService selections;

    public MessplanRevisionsAnstoss(MeasurementSelectionService selections) {
        this.selections = selections;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void nachFaehigkeitsmeldung(BoxFaehigkeiten.Gemeldet meldung) {
        if (kann(meldung.vorher()) == kann(meldung.nachher())) return;
        try {
            long revision = selections.planNeuAusliefern(meldung.deviceId());
            if (revision > 0) {
                log.info("measurement plan of device {} re-issued as revision {}: {} {}", meldung.deviceId(),
                        revision, MeasurementConfigPublisher.FAEHIGKEIT_JE_KOMPONENTE,
                        kann(meldung.nachher()) ? "reported" : "withdrawn");
            }
        } catch (RuntimeException e) {
            log.warn("measurement plan re-issue for device {} failed: {}", meldung.deviceId(), e.getMessage());
        }
    }

    static boolean kann(List<String> supports) {
        return supports != null && supports.contains(MeasurementConfigPublisher.FAEHIGKEIT_JE_KOMPONENTE);
    }
}
