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
