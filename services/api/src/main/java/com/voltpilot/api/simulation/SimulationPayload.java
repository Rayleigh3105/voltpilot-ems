package com.voltpilot.api.simulation;

import com.voltpilot.api.repo.SimulationDefaultsRepository.SimulationDefaults;
import com.voltpilot.api.web.Speicherschonung;
import com.voltpilot.api.web.dto.SimulationRequestDto;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Builds the simulation service's job payload (design report §6/§7): the
 * CUSTOMER route resolves everything from the site's master data and lets the
 * request body override single fields (the what-if), the ADMIN/prospect route
 * forwards explicit inputs. The Speicherschonung preset maps onto ct/kWh HERE
 * (the one {@link Speicherschonung} constant - no second preset truth in
 * Python); absent values are OMITTED so the service's documented defaults
 * apply in exactly one place.
 */
public final class SimulationPayload {

    private SimulationPayload() {
    }

    /** Customer route: master-data defaults, body overrides. */
    public static Map<String, Object> forSite(SimulationRequestDto dto, SimulationDefaults site) {
        dto = dto != null ? dto : new SimulationRequestDto(null, null, null, null, null, null, null);
        SimulationRequestDto.Plant plant = dto.plant();
        SimulationRequestDto.Consumption consumption = dto.consumption();
        SimulationRequestDto.Tariff tariff = dto.tariff();
        SimulationRequestDto.Battery battery = dto.battery();

        BigDecimal latitude = firstOf(plant == null ? null : plant.latitude(), site.latitude());
        BigDecimal longitude = firstOf(plant == null ? null : plant.longitude(), site.longitude());
        if (latitude == null || longitude == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für die Simulation braucht die Anlage einen Standort. Bitte hinterlegen "
                            + "Sie zuerst die Adresse (Technik → Standort & Einstellungen).");
        }
        BigDecimal capacity = firstOf(battery == null ? null : battery.capacityKwh(),
                site.batteryCapacityKwh());
        if (capacity == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für die Simulation braucht es einen Speicher. Bitte hinterlegen Sie die "
                            + "Speicherdaten oder geben Sie eine Kapazität an.");
        }

        Map<String, Object> doc = new LinkedHashMap<>();
        put(doc, "year", dto.year());
        put(doc, "zone", site.biddingZone());

        Map<String, Object> plantDoc = new LinkedHashMap<>();
        put(plantDoc, "pvKwp", firstOf(plant == null ? null : plant.pvKwp(),
                site.pvCapacityKwp(), BigDecimal.ZERO));
        put(plantDoc, "latitude", latitude);
        put(plantDoc, "longitude", longitude);
        put(plantDoc, "azimuthDeg", firstOf(plant == null ? null : plant.azimuthDeg(),
                site.pvAzimuthDeg()));
        put(plantDoc, "tiltDeg", firstOf(plant == null ? null : plant.tiltDeg(),
                site.pvTiltDeg()));
        doc.put("plant", plantDoc);

        Map<String, Object> consumptionDoc = new LinkedHashMap<>();
        // Master data carries no annual consumption (Inkrement 1) - the portal
        // pre-fills a typical household and the customer edits it.
        put(consumptionDoc, "annualKwh", firstOf(
                consumption == null ? null : consumption.annualKwh(),
                BigDecimal.valueOf(4500)));
        put(consumptionDoc, "profile", consumption == null ? null : consumption.profile());
        doc.put("consumption", consumptionDoc);

        Map<String, Object> tariffDoc = new LinkedHashMap<>();
        put(tariffDoc, "plantKind", firstOfObj(tariff == null ? null : tariff.plantKind(),
                site.plantKind()));
        put(tariffDoc, "tarifArt", firstOfObj(tariff == null ? null : tariff.tarifArt(),
                site.tarifArt()));
        put(tariffDoc, "tarifParamCtKwh", firstOf(
                tariff == null ? null : tariff.tarifParamCtKwh(), site.tarifParamCtKwh()));
        put(tariffDoc, "anzulegenderWertCtKwh", firstOf(
                tariff == null ? null : tariff.anzulegenderWertCtKwh(),
                site.anzulegenderWertCtKwh()));
        Object commissioned = firstOfObj(
                tariff == null ? null : tariff.commissionedOn(), site.pvCommissionedOn());
        put(tariffDoc, "commissionedOn", commissioned == null ? null : commissioned.toString());
        put(tariffDoc, "netzladenErlaubt", firstOfObj(
                tariff == null ? null : tariff.netzladenErlaubt(), site.netzladenErlaubt()));
        doc.put("tariff", tariffDoc);

        Map<String, Object> batteryDoc = new LinkedHashMap<>();
        put(batteryDoc, "capacityKwh", capacity);
        put(batteryDoc, "maxChargeKw", firstOf(battery == null ? null : battery.maxChargeKw(),
                site.batteryMaxChargeKw()));
        put(batteryDoc, "maxDischargeKw", firstOf(
                battery == null ? null : battery.maxDischargeKw(), site.batteryMaxDischargeKw()));
        put(batteryDoc, "roundtripEfficiencyPct", firstOf(
                battery == null ? null : battery.roundtripEfficiencyPct(),
                site.batteryRoundtripEfficiencyPct()));
        put(batteryDoc, "wearCostCtPerKwh", wearCt(battery, site.batteryWearCostCtPerKwh()));
        put(batteryDoc, "socMinPct", site.batterySocMinPct());
        put(batteryDoc, "socMaxPct", site.batterySocMaxPct());
        put(batteryDoc, "backupReserveSocPct", site.backupReserveSocPct());
        doc.put("battery", batteryDoc);

        put(doc, "sizeSweep", dto.sizeSweep());
        return doc;
    }

    /**
     * Admin/prospect route: explicit inputs forwarded as-is (the simulation
     * service validates completeness with German messages the api relays);
     * only the Speicherschonung preset is mapped server-side.
     */
    public static Map<String, Object> forProspect(SimulationRequestDto dto) {
        dto = dto != null ? dto : new SimulationRequestDto(null, null, null, null, null, null, null);
        Map<String, Object> doc = new LinkedHashMap<>();
        put(doc, "year", dto.year());
        put(doc, "zone", dto.zone());
        SimulationRequestDto.Plant plant = dto.plant();
        if (plant != null) {
            Map<String, Object> plantDoc = new LinkedHashMap<>();
            put(plantDoc, "pvKwp", plant.pvKwp());
            put(plantDoc, "latitude", plant.latitude());
            put(plantDoc, "longitude", plant.longitude());
            put(plantDoc, "azimuthDeg", plant.azimuthDeg());
            put(plantDoc, "tiltDeg", plant.tiltDeg());
            doc.put("plant", plantDoc);
        }
        SimulationRequestDto.Consumption consumption = dto.consumption();
        if (consumption != null) {
            Map<String, Object> c = new LinkedHashMap<>();
            put(c, "annualKwh", consumption.annualKwh());
            put(c, "profile", consumption.profile());
            doc.put("consumption", c);
        }
        SimulationRequestDto.Tariff tariff = dto.tariff();
        if (tariff != null) {
            Map<String, Object> t = new LinkedHashMap<>();
            put(t, "plantKind", tariff.plantKind());
            put(t, "tarifArt", tariff.tarifArt());
            put(t, "tarifParamCtKwh", tariff.tarifParamCtKwh());
            put(t, "anzulegenderWertCtKwh", tariff.anzulegenderWertCtKwh());
            put(t, "commissionedOn",
                    tariff.commissionedOn() == null ? null : tariff.commissionedOn().toString());
            put(t, "netzladenErlaubt", tariff.netzladenErlaubt());
            doc.put("tariff", t);
        }
        SimulationRequestDto.Battery battery = dto.battery();
        if (battery != null) {
            Map<String, Object> b = new LinkedHashMap<>();
            put(b, "capacityKwh", battery.capacityKwh());
            put(b, "maxChargeKw", battery.maxChargeKw());
            put(b, "maxDischargeKw", battery.maxDischargeKw());
            put(b, "roundtripEfficiencyPct", battery.roundtripEfficiencyPct());
            put(b, "wearCostCtPerKwh", wearCt(battery, null));
            doc.put("battery", b);
        }
        put(doc, "sizeSweep", dto.sizeSweep());
        return doc;
    }

    /**
     * The wear ct the simulation dispatches with: a requested preset wins
     * (mapped via the ONE constant), else the stored raw value (which may be
     * an admin-configured "individuell" ct), else absent = service default.
     */
    private static BigDecimal wearCt(SimulationRequestDto.Battery battery, BigDecimal stored) {
        if (battery != null && battery.speicherschonung() != null) {
            try {
                return Speicherschonung.wearCtFor(battery.speicherschonung());
            } catch (IllegalArgumentException e) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Unbekannte Speicherschonung - erlaubt sind aggressiv, ausgewogen, "
                                + "schonend.");
            }
        }
        return stored;
    }

    private static BigDecimal firstOf(BigDecimal... values) {
        for (BigDecimal value : values) {
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private static Object firstOfObj(Object... values) {
        for (Object value : values) {
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private static void put(Map<String, Object> doc, String key, Object value) {
        if (value != null) {
            doc.put(key, value);
        }
    }
}
