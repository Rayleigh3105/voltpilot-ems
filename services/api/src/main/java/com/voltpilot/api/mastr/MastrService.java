package com.voltpilot.api.mastr;

import com.voltpilot.api.web.dto.MastrPreviewDto;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
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
