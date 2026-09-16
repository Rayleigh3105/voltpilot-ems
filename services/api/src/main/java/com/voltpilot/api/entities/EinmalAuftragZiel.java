package com.voltpilot.api.entities;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.UebergabeRepository;
import com.voltpilot.api.uems.ZustaendigkeitRepository.Zeitraum;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Gemeinsame Adresse für Einmal-Aufträge: Ausführung der Quelle, sonst führende Box. */
@Service
public class EinmalAuftragZiel {
    private final EntityRegistryRepository entities;
    private final LeadDeviceService lead;
    private final DeviceRepository devices;
    private final UebergabeRepository uebergaben;

    public EinmalAuftragZiel(EntityRegistryRepository entities, LeadDeviceService lead,
            DeviceRepository devices, UebergabeRepository uebergaben) {
        this.entities = entities;
        this.lead = lead;
        this.devices = devices;
        this.uebergaben = uebergaben;
    }

    /** Eine ausdrückliche Box-Wahl ist nur für noch ungebundene Prüfziele maßgeblich. */
    public DeviceDto pruefung(UUID siteId, UUID requested, UUID entityId) {
        if (entityId != null) return komponente(siteId, entityId);
        if (requested != null) return box(siteId, requested, true);
        return fuehrend(siteId);
    }

    public DeviceDto fuehrend(UUID siteId) {
        var wahl = lead.fuehrendeBox(siteId);
        if (!wahl.bestimmt()) throw fehlt("Für diese Anlage ist keine führende Box bestimmt.");
        return box(siteId, wahl.box(), false);
    }

    public boolean hatQuelle(UUID siteId, UUID entityId) {
        return entities.datenquelleJeEntitaet(siteId).containsKey(entityId);
    }

    public DeviceDto komponente(UUID siteId, UUID entityId) {
        return komponente(siteId, entityId, Instant.now());
    }

    DeviceDto komponente(UUID siteId, UUID entityId, Instant jetzt) {
        if (entities.entityForSite(siteId, entityId) == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        UUID quelle = entities.datenquelleJeEntitaet(siteId).get(entityId);
        if (quelle == null) return fuehrend(siteId);
        var stand = uebergaben.stand(quelle);
        UUID leser;
        if (stand != null) {
            // Der Plan darf pending NICHT vorzeitig an die neue Box umleiten.
            leser = switch (stand.phase()) {
                case "active", "pending" -> stand.leser();
                case "receiving" -> stand.revision() == null ? null : stand.ziel();
                default -> null; // removing/reconciling: keine sichere Ausführung
            };
        } else {
            List<Zeitraum> reihe = entities.zustaendigkeitenDerQuellen(siteId).stream()
                    .filter(z -> quelle.equals(z.dataSourceId())).toList();
            Zeitraum soll = reihe.stream().filter(z -> !z.effectiveFrom().isAfter(jetzt)
                    && (z.effectiveTo() == null || z.effectiveTo().isAfter(jetzt)))
                    .findFirst().orElse(null);
            // Beim Upgrade nach einem Wechsel ist der Leser ohne Ausführungsstand unbekannt.
            boolean wechsel = soll != null && reihe.stream()
                    .anyMatch(z -> z.effectiveFrom().isBefore(soll.effectiveFrom()));
            leser = soll == null || wechsel ? null : soll.deviceId();
        }
        if (leser == null) throw fehlt(
                "Für diese Quelle ist derzeit keine ausführende Box bestimmt. Eine Übergabe kann noch ausstehen.");
        return box(siteId, leser, false);
    }

    private DeviceDto box(UUID siteId, UUID id, boolean requested) {
        DeviceDto box = devices.findById(id).orElse(null);
        if (box == null || !siteId.equals(box.siteId())) {
            if (requested) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden.");
            // Wie der Registry-Push: kein anlagenübergreifender Auftrag vor dem AP-07-Gate.
            throw fehlt("Die zuständige Box ist in dieser Anlage nicht verfügbar.");
        }
        return box;
    }

    private static ResponseStatusException fehlt(String text) {
        return new ResponseStatusException(HttpStatus.CONFLICT, text);
    }
}
