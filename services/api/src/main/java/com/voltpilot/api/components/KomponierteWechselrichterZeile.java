package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import java.util.UUID;

/**
 * Die {@code battery-hybrid}-Zeile einer Anlage, in die ihr Wechselrichter gehört - und wie sie
 * entsteht, wenn die Plattform sie noch nicht komponiert hat.
 *
 * <p><b>Der Live-Fall (Anlage „Zuhause", 02.11.2026):</b> der Kunde richtet seinen Deye-Hybrid
 * über die Gerätesuche ein, der Test mit echten Werten besteht, und „Speichern" antwortet
 * „Für diese Anlage ist noch kein Wechselrichter angelegt. Bitte tragen Sie zuerst die
 * Eckdaten Ihres Speichers ein." Die Anlage war ohne Speicher-Stammsatz angelegt worden, und bis
 * hierher komponierte NUR {@code EntityRegistryService.bootstrap} aus dem Speicher-Asset die
 * battery-hybrid-Zeile; Anlege-Weg und Bestands-Übernahme lehnten ohne sie ab. Dabei zeigte der
 * Aufbau sehr wohl eine Zeile „Wechselrichter" - das Ersatzgerät, das das Portal den beim
 * Verbinden der Box komponierten Netz-/Haus-Zeilen gibt - und der Kunde konnte die Meldung nicht
 * mit dem verbinden, was er sah.
 *
 * <p><b>Die Regel seitdem:</b> ein eingerichteter Wechselrichter braucht keinen Speicher-Stammsatz,
 * um gespeichert zu werden. Gibt es die komponierte Zeile nicht, entsteht sie hier - EINE Zeile
 * je Anlage (die Topologie summiert je Rolle), gebunden an die führende Box, mit den Mess-Vorgaben
 * des Typkatalogs und ohne jede Schreib-Fähigkeit ({@link ComponentDefaults}: „nur-lesend,
 * immer"). Die Eckdaten des Speichers bleiben, was sie sind: die Grundlage für Fahrplan und
 * Steuerung. Sobald der Kunde sie einträgt, frischt {@code bootstrapIfEligible} genau diese Zeile
 * aus dem Asset nach - dieselben Fähigkeiten und Schutzgrenzen wie in der Reihenfolge
 * „Speicher zuerst". Es gibt also weiterhin EINE Wahrheit je Anlage, nur die Reihenfolge des
 * Einrichtens ist frei.
 *
 * <p>Beide Schreiber - der Anlege-Weg ({@link ComponentService}) und die Bestands-Übernahme
 * ({@link ComponentAdoptionService}) - gehen durch diese eine Stelle, damit dieselbe Anlage je
 * nach Entstehungsweg nicht zwei verschiedene Zeilen bekommt.
 */
final class KomponierteWechselrichterZeile {

    /** Der Entitätstyp und die v1-Rolle der Zeile. */
    static final String TYP = "battery-hybrid";

    private KomponierteWechselrichterZeile() {
    }

    /**
     * Legt die battery-hybrid-Zeile der Anlage an, wenn es keine gibt, und gibt ihre Kennung
     * zurück. Eine Zeile derselben Rolle, die ihren Typ verloren hat (ein gelöschtes Modell
     * behält seinen Messpunkt), wird wieder zur Entität statt eine zweite zu bekommen.
     *
     * <p>Im Kontext einer laufenden Transaktion des Aufrufers; der Mandant steht im
     * {@code TenantContext} (RLS ist der Zaun).
     */
    static UUID komponieren(EntityRegistryRepository repo, EntityRegistryService registry,
            EntityTypeCatalog types, ObjectMapper mapper, UUID tenantId, UUID siteId) {
        UUID id = repo.batteryHybridPointId(siteId);
        if (id == null) {
            id = repo.createBatteryHybridPoint(tenantId, siteId, null,
                    registry.gatewayDeviceFor(siteId));
        }
        repo.setEntityConfig(id, TYP,
                ComponentDefaults.capabilities(mapper, types, TYP, ComponentService.ROLE_INVERTER),
                ComponentDefaults.guards(mapper, ComponentService.ROLE_INVERTER, null));
        return id;
    }
}
