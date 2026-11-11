package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Der Auftrag der Cloud an die Box auf {@code ems/{t}/{s}/{d}/v2/geraetesuche} (QoS 1, nicht retained;
 * {@code docs/contracts/v2/mqtt-geraetesuche.md} §2). Die Cloud sendet genau diese Form; Netze, Ports, Takt und Dauer
 * hat sie nicht zu sagen (DP-5 A) - es gibt kein Feld dafür.
 *
 * @param gueltigBis    nur bei starten: ausgeloest_am + 120 s
 * @param erkenner      nur bei starten und nur zum Einengen; null = alle Erkenner der Box
 * @param ausgeloestVon das JWT-Subject, Papier-Spur im Log der Box; null = keines
 */
public record GeraetesucheAuftrag(UUID tenantId, UUID siteId, UUID deviceId, String aktion, UUID suchId,
        Instant ausgeloestAm, Instant gueltigBis, List<String> erkenner, String ausgeloestVon) {

    public GeraetesucheAuftrag {
        if (erkenner != null && (erkenner.isEmpty() || !GeraetesucheVertrag.ERKENNER.containsAll(erkenner))) {
            throw new IllegalArgumentException("erkenner " + erkenner);
        }
        if (ausgeloestVon != null && (ausgeloestVon.isEmpty() || ausgeloestVon.length() > 200)) {
            throw new IllegalArgumentException("ausgeloest_von");
        }
        erkenner = erkenner == null ? null : List.copyOf(erkenner);
    }

    public static GeraetesucheAuftrag starten(UUID tenant, UUID site, UUID device, UUID suchId, Instant jetzt,
            List<String> erkenner, String ausgeloestVon) {
        return new GeraetesucheAuftrag(tenant, site, device, "starten", suchId, jetzt,
                jetzt.plus(GeraetesucheVertrag.FRIST), erkenner, ausgeloestVon);
    }

    public static GeraetesucheAuftrag abbrechen(UUID tenant, UUID site, UUID device, UUID suchId, Instant jetzt,
            String ausgeloestVon) {
        return new GeraetesucheAuftrag(tenant, site, device, "abbrechen", suchId, jetzt, null, null, ausgeloestVon);
    }

    public String topic() {
        return GeraetesucheVertrag.topic(tenantId, siteId, deviceId, GeraetesucheVertrag.TOPIC_AUFTRAG);
    }

    public ObjectNode json(ObjectMapper mapper) {
        ObjectNode n = mapper.createObjectNode()
                .put("schema_version", GeraetesucheVertrag.SCHEMA_VERSION)
                .put("tenant_id", tenantId.toString())
                .put("site_id", siteId.toString())
                .put("device_id", deviceId.toString())
                .put("aktion", aktion)
                .put("such_id", suchId.toString())
                .put("ausgeloest_am", ausgeloestAm.toString());
        if (gueltigBis != null) {
            n.put("gueltig_bis", gueltigBis.toString());
        }
        if (erkenner != null) {
            erkenner.forEach(n.putArray("erkenner")::add);
        }
        if (ausgeloestVon != null) {
            n.put("ausgeloest_von", ausgeloestVon);
        }
        return n;
    }
}
