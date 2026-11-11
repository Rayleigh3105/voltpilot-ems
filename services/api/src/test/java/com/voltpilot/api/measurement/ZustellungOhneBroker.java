package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.ErwarteteKadenz;
import java.util.UUID;

/**
 * Test-Naht (IP-18-Einrichtung): genau das Dokument, das {@link MeasurementConfigPublisher} einer Box
 * gehalten (retained) zustellen würde — gebaut vom echten {@code payload}, nur ohne Broker. Im Testlauf
 * ist {@code voltpilot.provisioning.enabled} aus, der Publisher also kein Bean; der Aufruf baut ihn
 * darum selbst, verbindet ihn aber nie.
 */
public final class ZustellungOhneBroker {

    private ZustellungOhneBroker() {
    }

    public static byte[] dokument(MeasurementSelectionRepository repository, MeasurementSelectionService auswahl,
            ErwarteteKadenz kadenzen, ObjectMapper mapper, UUID tenant, UUID box) throws Exception {
        return dokument(repository, auswahl, kadenzen, mapper, tenant, box, null, null);
    }

    /**
     * Dasselbe mit den Fähigkeiten der Box und den Erzeuger-Bildern aus der Datenbank (UEMS EZ-18): so trägt das
     * Dokument {@code erzeuger_registerbilder}, wie der Publisher im Betrieb es schreibt.
     */
    public static byte[] dokument(MeasurementSelectionRepository repository, MeasurementSelectionService auswahl,
            ErwarteteKadenz kadenzen, ObjectMapper mapper, UUID tenant, UUID box, BoxFaehigkeiten faehigkeiten,
            ErzeugerRegisterbilder erzeuger) throws Exception {
        TenantContext.set(tenant);
        try {
            MeasurementSelectionRepository.DeviceScope scope = repository.aktiverDeviceScope(box);
            MeasurementConfigPublisher publisher = new MeasurementConfigPublisher("tcp://127.0.0.1:9", "", "", mapper,
                    kadenzen);
            if (faehigkeiten != null) publisher.setFaehigkeiten(faehigkeiten);
            if (erzeuger != null) publisher.setErzeugerRegisterbilder(erzeuger);
            return publisher.payload(scope, auswahl.forPublishing(box));
        } finally {
            TenantContext.clear();
        }
    }
}
