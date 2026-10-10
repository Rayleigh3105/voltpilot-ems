package com.voltpilot.api.metrics;

import java.util.Optional;
import java.util.UUID;

/**
 * AP-14 IP-18 (Kasten E11): der interne Dauerläufer-Kundenbereich „VoltPilot Dauerläufer (intern)“.
 *
 * <p>Zwei simulierte Boxen gehen in Produktion dauerhaft den Weg Box → Bericht. Der Kundenbereich
 * zählt in <b>keiner Flottenkennzahl</b> ({@link FleetMetricsCollector}); sein Messkunden-Alter
 * ({@link UemsMetricsCollector#MESSWERT_ALTER}) bleibt dagegen mit seinem {@code tenant}-Etikett
 * sichtbar — genau darauf schaut die gitops-Regel {@code VoltPilotDauerlaeuferStumm}
 * ({@code and on (namespace, tenant) voltpilot:uems_dauerlaeufer}).
 *
 * <p>Der Schalter ist {@code voltpilot.uems.dauerlaeufer.tenant}
 * ({@code VOLTPILOT_UEMS_DAUERLAEUFER_TENANT}): leer = kein Dauerläufer, jede Kennzahl bytegleich
 * wie vorher. Ein gesetzter Wert, der keine UUID ist, bricht den Start ab — ein still ignorierter
 * Tippfehler zählte den Dauerläufer wieder als Kunden mit.
 */
public final class Dauerlaeufer {

    /** Die Spring-Eigenschaft des Schalters. */
    public static final String EIGENSCHAFT = "voltpilot.uems.dauerlaeufer.tenant";

    private Dauerlaeufer() {
    }

    /**
     * Die interne Kennung aus dem Schalter; leer oder nur Leerzeichen = kein Dauerläufer.
     *
     * @throws IllegalArgumentException wenn ein Wert gesetzt ist, der keine UUID ist
     */
    public static Optional<UUID> kennung(String roh) {
        if (roh == null || roh.isBlank()) {
            return Optional.empty();
        }
        String wert = roh.trim();
        try {
            UUID kennung = UUID.fromString(wert);
            // UUID.fromString nimmt auch verkürzte Gruppen an ("1-1-1-1-1"); das Etikett der
            // Metrik muss aber wörtlich die kanonische Form tragen, die gitops einträgt.
            if (!kennung.toString().equalsIgnoreCase(wert)) {
                throw new IllegalArgumentException("not canonical");
            }
            return Optional.of(kennung);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(EIGENSCHAFT
                    + " muss leer oder die interne UUID des Kundenbereichs sein (8-4-4-4-12)", e);
        }
    }
}
