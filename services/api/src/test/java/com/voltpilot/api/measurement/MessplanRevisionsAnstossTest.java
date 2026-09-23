package com.voltpilot.api.measurement;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Revisions-Anstoß (AP-07 IP-18b Einschalten): nur ein Wechsel von
 * {@code measurement_config_per_component} legt eine neue Revision an - jede andere Änderung der
 * gemeldeten Liste lässt die Box bei ihrem Plan, und ein Fehler erreicht die Meldung nie.
 */
class MessplanRevisionsAnstossTest {
    private static final UUID BOX = UUID.fromString("00000000-0000-0000-0000-0000000000b0");
    private static final String WORT = MeasurementConfigPublisher.FAEHIGKEIT_JE_KOMPONENTE;

    @Test
    void nurDerWechselDesWortsStoesstAn() {
        MeasurementSelectionService service = mock(MeasurementSelectionService.class);
        MessplanRevisionsAnstoss anstoss = new MessplanRevisionsAnstoss(service);

        anstoss.nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, null, List.of("data_sources")));
        anstoss.nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, List.of("data_sources"),
                List.of("data_sources", "events")));
        anstoss.nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, List.of(WORT), List.of(WORT, "events")));
        verify(service, never()).planNeuAusliefern(any());

        anstoss.nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, List.of("data_sources"),
                List.of("data_sources", WORT)));
        anstoss.nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, null, List.of(WORT)));
        anstoss.nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, List.of(WORT), List.of()));
        anstoss.nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, List.of(WORT), null));
        verify(service, times(4)).planNeuAusliefern(BOX);
    }

    @Test
    void einFehlerDesAnstossesErreichtDieMeldungNie() {
        MeasurementSelectionService service = mock(MeasurementSelectionService.class);
        when(service.planNeuAusliefern(any())).thenThrow(new IllegalStateException("db weg"));
        new MessplanRevisionsAnstoss(service)
                .nachFaehigkeitsmeldung(new BoxFaehigkeiten.Gemeldet(BOX, null, List.of(WORT)));
        verify(service).planNeuAusliefern(BOX);
    }
}
