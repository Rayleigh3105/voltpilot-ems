package com.voltpilot.api.measurement;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Der Vergleich des Bestand-Geräte-CSV mit seinem Stand VOR UEMS AP-12 IP-10 (E11 DA4) — geteilt von
 * {@code BestandGeraeteCsvTest}, {@code UemsLesepfadTest} und {@code UemsLesepfadMengenTest}.
 */
public final class BestandGeraeteCsvVergleich {

    /** So viele Kopfzeilen hatte der Export vorher (bis {@code # catalog_version_gespeichert=}); die neun neuen folgen. */
    public static final int KOPFZEILEN_VORHER = 15;

    private BestandGeraeteCsvVergleich() {
    }

    /** Eine feste Erzeugung für Tests, deren Kopf nicht von der Uhr abhängen soll. */
    public static MeasurementHistoryService.Erzeugung erzeugung() {
        return new MeasurementHistoryService.Erzeugung(Instant.parse("2027-01-19T10:00:00Z"), "Jonas Wendlinger",
                "ST-1 Werk Ahrenberg", "Kunststoffwerk Ahrenberg GmbH");
    }

    /**
     * Der Export ohne die neun Kopfzeilen von AP-12 IP-10 — und nur, wenn sie genau hinter den bisherigen Kopfzeilen in der
     * Folge von {@link MeasurementHistoryService#KOPF_ERZEUGUNG} stehen; sonst ist der Vergleich selbst falsch.
     */
    public static byte[] ohneNeueKopfzeilen(byte[] csv) {
        List<String> zeilen = new ArrayList<>(List.of(new String(csv, StandardCharsets.UTF_8).split("\n", -1)));
        List<String> neu = MeasurementHistoryService.KOPF_ERZEUGUNG;
        for (int i = 0; i < neu.size(); i++) {
            String zeile = zeilen.get(KOPFZEILEN_VORHER + i);
            if (!zeile.startsWith("# " + neu.get(i) + "=")) {
                throw new AssertionError("Kopfzeile " + (KOPFZEILEN_VORHER + i + 1) + " sollte # " + neu.get(i)
                        + "= sein, ist: " + zeile);
            }
        }
        zeilen.subList(KOPFZEILEN_VORHER, KOPFZEILEN_VORHER + neu.size()).clear();
        return String.join("\n", zeilen).getBytes(StandardCharsets.UTF_8);
    }
}
