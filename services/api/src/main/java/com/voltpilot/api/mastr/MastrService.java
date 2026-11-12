package com.voltpilot.api.mastr;

import com.voltpilot.api.web.dto.MastrLokationEinheitDto;
import com.voltpilot.api.web.dto.MastrLokationPreviewDto;
import com.voltpilot.api.web.dto.MastrPreviewDto;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.stereotype.Service;

/**
 * Turns a raw registry unit into the customer-facing preview: validates the
 * SEE number, fetches via the configured {@link PlantRegistryClient}, decodes
 * the catalog values into degrees, and collects HONEST German warnings for
 * everything that does not map cleanly (Ost-West / nachgeführt orientation,
 * unknown catalog ids, missing charging power on the keyless source). Nothing
 * here persists - the customer confirms first.
 */
@Service
public class MastrService {

    private final PlantRegistryClient registry;

    public MastrService(PlantRegistryClient registry) {
        this.registry = registry;
    }

    public MastrPreviewDto lookup(String rawNumber) throws RegistryLookupException {
        String unitNumber = MastrNumbers.requireSee(rawNumber);
        MastrUnit unit = registry.fetchUnit(unitNumber);
        return preview(unit);
    }

    /**
     * S2 (Lokations-Suche, Abschnitt 5.3): the typed unit plus every sibling
     * at the same Lokation ("eine Nummer genügt"), sorted by commissioning
     * date. A unit of a DIFFERENT operator than the typed one is returned
     * but pre-deselected (the ABR comparison happens only here, in memory -
     * neither operator number is ever persisted, Abschnitt 4.5). A unit
     * without a known Lokation (heavily masked / older records) comes back
     * alone - the customer can still add further numbers by hand later.
     */
    public MastrLokationPreviewDto lookupLocation(String rawNumber) throws RegistryLookupException {
        String unitNumber = MastrNumbers.requireSee(rawNumber);
        MastrUnit anchor = registry.fetchUnit(unitNumber);
        if (anchor.locationNumber() == null) {
            return new MastrLokationPreviewDto(null,
                    List.of(new MastrLokationEinheitDto(preview(anchor), true, null)));
        }
        // Dedupe by unit number - the anchor is itself connected to its own
        // Lokation and reappears in fetchUnitsAtLocation.
        Map<String, MastrUnit> byNumber = new LinkedHashMap<>();
        byNumber.put(anchor.unitNumber(), anchor);
        for (MastrUnit sibling : registry.fetchUnitsAtLocation(anchor.locationNumber())) {
            byNumber.putIfAbsent(sibling.unitNumber(), sibling);
        }
        List<MastrLokationEinheitDto> einheiten = byNumber.values().stream()
                .sorted(Comparator.comparing(MastrUnit::commissionedOn,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .map(u -> {
                    boolean andererBetreiber = anchor.operatorNumber() != null && u.operatorNumber() != null
                            && !Objects.equals(anchor.operatorNumber(), u.operatorNumber());
                    return new MastrLokationEinheitDto(preview(u), !andererBetreiber,
                            andererBetreiber ? "anderer_betreiber" : null);
                })
                .toList();
        return new MastrLokationPreviewDto(anchor.locationNumber(), einheiten);
    }

    private MastrPreviewDto preview(MastrUnit unit) {
        return unit.kind() == MastrUnit.Kind.STORAGE ? previewStorage(unit) : previewSolar(unit);
    }

    private MastrPreviewDto previewSolar(MastrUnit u) {
        List<String> warnings = new ArrayList<>();
        BigDecimal azimuthDeg = MastrCatalog.azimuthDegrees(u.azimuthCatalogId());
        String azimuthLabel = MastrCatalog.azimuthLabel(u.azimuthCatalogId());
        if (u.azimuthCatalogId() != null && azimuthDeg == null) {
            if (azimuthLabel != null) {
                warnings.add("Die Ausrichtung „" + azimuthLabel + "“ lässt sich nicht auf eine "
                        + "einzelne Himmelsrichtung abbilden. Die Prognose nutzt dafür den "
                        + "Standardwert (Süd).");
            } else {
                warnings.add("Unbekannter Registerwert für die Ausrichtung - die Prognose nutzt "
                        + "den Standardwert (Süd).");
            }
        }
        BigDecimal tiltDeg = MastrCatalog.tiltDegrees(u.tiltCatalogId());
        String tiltLabel = MastrCatalog.tiltLabel(u.tiltCatalogId());
        if (u.tiltCatalogId() != null && tiltDeg == null) {
            if (tiltLabel != null) {
                warnings.add("Der Neigungswinkel „" + tiltLabel + "“ lässt sich nicht auf einen "
                        + "festen Winkel abbilden. Die Prognose nutzt dafür den Standardwert (30°).");
            } else {
                warnings.add("Unbekannter Registerwert für den Neigungswinkel - die Prognose "
                        + "nutzt den Standardwert (30°).");
            }
        }
        return new MastrPreviewDto(
                u.unitNumber(), "pv",
                u.name(), u.operatingStatus(), u.plantTypeLabel(),
                u.grossPowerKw(), u.netPowerKw(), u.moduleCount(),
                azimuthLabel, azimuthDeg, tiltLabel, tiltDeg,
                u.commissionedOn(),
                null, null, null,
                u.postalCode(), u.city(), u.linkedUnitNumber(),
                List.copyOf(warnings));
    }

    private MastrPreviewDto previewStorage(MastrUnit u) {
        List<String> warnings = new ArrayList<>();
        BigDecimal dischargeKw = u.grossPowerKw() != null ? u.grossPowerKw() : u.netPowerKw();
        BigDecimal chargeKw = u.chargePowerKw();
        if (chargeKw == null && dischargeKw != null) {
            // The keyless source has no LeistungsaufnahmeBeimEinspeichern;
            // residential batteries are near-symmetric, say so honestly.
            chargeKw = dischargeKw;
            warnings.add("Die Ladeleistung ist im öffentlichen Register nicht hinterlegt - "
                    + "sie wird gleich der Entladeleistung angenommen.");
        }
        return new MastrPreviewDto(
                u.unitNumber(), "storage",
                u.name(), u.operatingStatus(), u.plantTypeLabel(),
                dischargeKw, u.netPowerKw(), null,
                null, null, null, null,
                u.commissionedOn(),
                u.storageCapacityKwh(), chargeKw,
                MastrCatalog.batteryTechnologyLabel(u.batteryTechnologyId()),
                u.postalCode(), u.city(), u.linkedUnitNumber(),
                List.copyOf(warnings));
    }
}
