package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.measurement.MeasurementSelectionService.SelectionPoint;
import com.voltpilot.api.uems.ErwarteteKadenz.Messkanal;
import com.voltpilot.api.uems.KadenzRegeln;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** The exact current wire plan: one row per point key, with the fastest requested cadence. */
public final class MeasurementPlan {

    private MeasurementPlan() {}

    public record Entry(UUID entityId, String pointKey, Integer cadenceS, JsonNode customDefinition,
            String retentionClass, int rawRetentionDays, Integer longTermCadenceS,
            String longTermStrategy) {}

    public static List<Entry> compose(List<SelectionPoint> selections,
            Map<Messkanal, Integer> cadenceVersions) {
        Map<String, Entry> byPointKey = new LinkedHashMap<>();
        Map<String, Boolean> unambiguousEntity = new LinkedHashMap<>();
        for (SelectionPoint point : selections) {
            if (!point.enabled()) continue;
            Integer cadence = cadence(point, cadenceVersions);
            Entry existing = byPointKey.get(point.pointKey());
            if (existing == null) {
                byPointKey.put(point.pointKey(), entry(point.entityId(), point, cadence));
                unambiguousEntity.put(point.pointKey(), Boolean.TRUE);
                continue;
            }
            if (cadence != null && (existing.cadenceS() == null
                    || cadence < existing.cadenceS())) {
                byPointKey.put(point.pointKey(), new Entry(existing.entityId(), existing.pointKey(),
                        cadence, existing.customDefinition(), existing.retentionClass(),
                        existing.rawRetentionDays(), existing.longTermCadenceS(),
                        existing.longTermStrategy()));
            }
            if (!Objects.equals(point.entityId(), existing.entityId())) {
                unambiguousEntity.put(point.pointKey(), Boolean.FALSE);
            }
        }
        return byPointKey.values().stream().map(entry ->
                Boolean.TRUE.equals(unambiguousEntity.get(entry.pointKey())) ? entry
                        : new Entry(null, entry.pointKey(), entry.cadenceS(), entry.customDefinition(),
                                entry.retentionClass(), entry.rawRetentionDays(),
                                entry.longTermCadenceS(), entry.longTermStrategy()))
                .toList();
    }

    /**
     * Der Plan für eine Box, die {@code measurement_config_per_component} meldet (AP-07 IP-18b
     * Teil 2): ein {@code point_key}, den ZWEI oder mehr Komponenten beobachten, steht einmal JE
     * KOMPONENTE da, jede mit ihrer {@code entity_id} und ihrer eigenen Kadenz - ein
     * <b>geteilter Punkt</b> wie in {@code mqtt-measurement-samples-2.1.md} §2. Die Box liest ihn
     * je Ziel einmal (schnellste Kadenz) und sendet je Komponente.
     *
     * <p>⚠ Nur wenn JEDE aktive Zeile dieses {@code point_key} eine Komponente nennt. Steht eine
     * Zeile ohne Komponente daneben, bleibt es beim Zusammenlegen von {@link #compose} (die Regel
     * des Vertrags: fehlt einem Vorkommen die Komponente, bleibt der {@code point_key} eindeutig).
     * Ohne geteilten Punkt ist das Ergebnis Eintrag für Eintrag das von {@link #compose}.
     */
    public static List<Entry> composeJeKomponente(List<SelectionPoint> selections,
            Map<Messkanal, Integer> cadenceVersions) {
        Map<String, Boolean> alleMitKomponente = new LinkedHashMap<>();
        for (SelectionPoint point : selections) {
            if (!point.enabled()) continue;
            alleMitKomponente.merge(point.pointKey(), point.entityId() != null, Boolean::logicalAnd);
        }
        Map<String, Map<UUID, Entry>> geteilt = new LinkedHashMap<>();
        List<SelectionPoint> zusammenzulegen = new java.util.ArrayList<>();
        for (SelectionPoint point : selections) {
            if (!point.enabled()) continue;
            if (!Boolean.TRUE.equals(alleMitKomponente.get(point.pointKey()))) {
                zusammenzulegen.add(point);
                continue;
            }
            Integer cadence = cadence(point, cadenceVersions);
            geteilt.computeIfAbsent(point.pointKey(), k -> new LinkedHashMap<>())
                    .merge(point.entityId(), entry(point.entityId(), point, cadence), (alt, neu) ->
                            neu.cadenceS() != null && (alt.cadenceS() == null
                                    || neu.cadenceS() < alt.cadenceS())
                                    ? new Entry(alt.entityId(), alt.pointKey(), neu.cadenceS(),
                                            alt.customDefinition(), alt.retentionClass(),
                                            alt.rawRetentionDays(), alt.longTermCadenceS(),
                                            alt.longTermStrategy())
                                    : alt);
        }
        Map<String, Entry> zusammengelegt = new LinkedHashMap<>();
        for (Entry e : compose(zusammenzulegen, cadenceVersions)) zusammengelegt.put(e.pointKey(), e);
        List<Entry> out = new java.util.ArrayList<>();
        for (String pointKey : alleMitKomponente.keySet()) {
            Map<UUID, Entry> je = geteilt.get(pointKey);
            if (je != null) out.addAll(je.values());
            else out.add(zusammengelegt.get(pointKey));
        }
        return List.copyOf(out);
    }

    private static Entry entry(UUID entityId, SelectionPoint point, Integer cadence) {
        return new Entry(entityId, point.pointKey(), cadence, point.customDefinition(),
                point.retentionClass(), point.rawRetentionDays(), point.longTermCadenceS(),
                point.longTermStrategy());
    }

    /**
     * A stored cadence version wins only inside the wire contract's range. A hand-written invalid
     * version is ignored instead of being silently clamped.
     */
    private static Integer cadence(SelectionPoint point, Map<Messkanal, Integer> cadenceVersions) {
        Integer version = point.entityId() == null ? null
                : cadenceVersions.get(new Messkanal(point.entityId(), point.pointKey()));
        Integer effective = KadenzRegeln.imRahmen(version) ? version : point.cadenceS();
        return effective;
    }
}
