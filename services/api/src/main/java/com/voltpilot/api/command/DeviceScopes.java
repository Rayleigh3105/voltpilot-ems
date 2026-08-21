package com.voltpilot.api.command;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.DeviceSourceStatusRepository;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargePointDto;
import com.voltpilot.api.web.dto.SiteSourceDto;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die Auflösung „welches GERÄT meint diese Adresse?" (Anlagen-Zentrale Stufe 1,
 * Konzept {@code vp-anlagen-zentrale-konzept-h6} §7.1/§7.4).
 *
 * <p>Die Geräteseite adressiert drei Arten von Gerät, und alle drei kommen als
 * EINE Zeichenkette an: die VoltPilot-BOX unter ihrer Referenz, ein Gerät
 * DAHINTER unter seiner vom Edge gemeldeten Quellen-Kennung
 * ({@code inverter} · {@code src-…}) und eine Ladesäule unter
 * {@code cp-<ChargePointId>}. Diese Klasse ist die einzige Stelle, die das
 * auseinandernimmt - und sie tut es ausschließlich über BESTEHENDE
 * Lesepfade, ohne eine einzige neue Abfrage-Form.
 *
 * <p><b>Sie ist der Zaun.</b> Jeder Lesepfad hier ist RLS-gefenced, also kann
 * eine Referenz aus einer fremden Anlage gar nicht auflösen - der Aufrufer
 * macht daraus ein 404, nie ein 403.
 */
@Service
public class DeviceScopes {

    /**
     * Das Präfix, unter dem eine Ladesäule adressiert wird.
     *
     * <p>⚠ Es ist der ZWILLING der Portal-Funktion
     * {@code geraetSeite.chargerGeraetId} - beide zusammen ändern. Die
     * OCPP-ChargePointId ist die Identität der Säule; das Präfix hält sie nur
     * von einer gleichnamigen Quellen-Kennung auseinander.
     */
    public static final String CHARGER_PREFIX = "cp-";

    /**
     * Der aufgelöste Bezug.
     *
     * @param deviceId  das beanspruchte Gerät (die Box), an dem die Zeilen
     *                  hängen - immer gesetzt.
     * @param entityIds {@code null} = die BOX SELBST - und das heißt seit der
     *                  Ziel-Attribution AUSDRÜCKLICH: ihre ANLAGENWEITEN Zeilen
     *                  (die ohne Komponente), nicht mehr alles. Sonst die
     *                  Komponenten des Geräts hinter der Box; eine LEERE Liste
     *                  ist gültig und heißt „dieses Gerät hat noch keine
     *                  Komponente" - nie „alles".
     * @param writes    ob VoltPilot an dieses Gerät überhaupt schreibt (die
     *                  F4-Tatsache). {@code false} = es wird nur gelesen.
     */
    public record Scope(String ref, UUID deviceId, List<UUID> entityIds, boolean writes) {

        /** Die Box selbst - sie IST der Schreibweg der Anlage. */
        public boolean box() {
            return entityIds == null;
        }
    }

    private final DeviceRepository devices;
    private final DeviceSourceStatusRepository sources;
    private final DeviceChargerStatusRepository chargers;
    private final EntityRegistryRepository entities;

    public DeviceScopes(DeviceRepository devices, DeviceSourceStatusRepository sources,
            DeviceChargerStatusRepository chargers, EntityRegistryRepository entities) {
        this.devices = devices;
        this.sources = sources;
        this.chargers = chargers;
        this.entities = entities;
    }

    /**
     * Löst eine Geräte-Adresse auf; {@code null} = diese Anlage kennt sie nicht.
     *
     * <p>Die Reihenfolge ist eine Aussage: zuerst die BOX (ihre Referenz ist die
     * stabile Kennung, die Unclaim und Re-Claim überlebt), dann die gemeldeten
     * Quellen, dann die Ladesäulen. Eine Quellen-Kennung kann per Konstruktion
     * nie wie eine Geräte-Referenz aussehen (die eine ist eine Edge-Kennung, die
     * andere ein Aufkleber bzw. eine {@code edge-}-Referenz), die Reihenfolge
     * entscheidet also nichts weg - sie macht den häufigsten Fall zuerst.
     */
    public Scope resolve(UUID siteId, String ref) {
        String key = ref == null ? "" : ref.trim();
        if (key.isEmpty()) {
            return null;
        }
        // EINMAL gelesen und dreimal befragt: die Komponenten-Liste ist die
        // Grundlage jeder der drei Auflösungen, und dieser Pfad läuft je
        // Anfrage.
        List<EntityRow> components = entities.entitiesForSite(siteId);
        UUID box = boxOf(siteId, key);
        if (box != null) {
            // Die BOX ist ein TOR, kein Gerät (Konzept vp-geraeteseite-rev-b8
            // §4.1): sie zeigt, was sie ÜBERBRINGT - die anlagenweiten Zeilen
            // ohne Komponente (Abregelung, Wächter, Not-Aus, Lücke). Alles, was
            // eine Komponente trägt, hat seit der Ziel-Attribution ein eigenes
            // Gerät, auf dessen Seite es steht; die ganze Anlage auf einmal
            // zeigt weiterhin die Befehle-Seite ohne Filter.
            return new Scope(key, box, null, writesAnyOf(components.stream()
                    .filter(e -> box.equals(e.deviceId())).toList()));
        }
        // Ein Gerät hinter der Box gilt als BELEGT, sobald eines von beiden
        // vorliegt: eine Komponente ist darauf gepinnt (dann kennt die Anlage
        // es, auch wenn die Box gerade schweigt) ODER die Box meldet es. Nur
        // eines von beiden zu verlangen hiesse, ein real vorhandenes Gerät je
        // nach Tagesform nicht zu finden.
        List<EntityRow> pinned = components.stream()
                .filter(e -> key.equals(e.edgeSourceId()))
                .toList();
        SiteSourceDto source = sources.forSite(siteId).stream()
                .filter(s -> key.equals(s.sourceId()))
                .findFirst().orElse(null);
        UUID behind = !pinned.isEmpty() ? pinned.get(0).deviceId()
                : source != null ? source.deviceId() : null;
        if (!pinned.isEmpty() || source != null) {
            // ⚠ Die Zuordnung entscheidet EINE Regel (DeviceAttribution),
            // wörtlich die des Portals - sonst behauptet dieselbe Seite oben
            // „⚡ VoltPilot steuert den Speicher" und darunter „VoltPilot
            // sendet an dieses Gerät keine Befehle".
            List<EntityRow> own = DeviceAttribution.componentsOf(components, key, behind,
                    isPrimaryInverter(source));
            // Gemeldet, aber noch keiner Komponente zugeordnet: ehrlich LEER -
            // nie zu „alle Zeilen der Anlage" aufgeweitet.
            return new Scope(key, behind, own.stream().map(EntityRow::id).toList(),
                    writesAnyOf(own));
        }
        ChargePointDto charger = charger(siteId, key);
        if (charger != null) {
            // Eine Säule IST ihre eine Komponente; ohne gebundene Entität hat
            // sie ehrlich keine Zeile (nie die der ganzen Box).
            List<UUID> ids = charger.entityId() == null ? List.of() : List.of(charger.entityId());
            return new Scope(key, charger.deviceId(), ids, writesAnyOf(components.stream()
                    .filter(e -> ids.contains(e.id())).toList()));
        }
        return null;
    }

    /** Die Box unter ihrer Referenz - oder, falls jemand eine UUID schickt, direkt. */
    private UUID boxOf(UUID siteId, String key) {
        UUID byRef = devices.findByExternalRef(key)
                .filter(d -> siteId.equals(d.siteId()))
                .map(d -> d.id()).orElse(null);
        if (byRef != null) {
            return byRef;
        }
        UUID asUuid = parseUuid(key);
        if (asUuid == null) {
            return null;
        }
        return devices.findById(asUuid)
                .filter(d -> siteId.equals(d.siteId()))
                .map(d -> d.id()).orElse(null);
    }

    /**
     * Nennt diese gemeldete Quelle den PRIMÄREN Wechselrichter der Box?
     *
     * <p>Die Box meldet ihn als einzige Quelle mit {@code kind = "primary"}
     * (Kennung {@code inverter}) - dieselbe Bedingung, unter der der
     * {@code local_setup}-Block seinen Wechselrichter-Eintrag baut, an dem das
     * Portal seine Regel 2 festmacht. Ohne gemeldete Quelle wird NICHTS
     * angenommen: ein Gerät, das nur über einen Pin bekannt ist, erbt kein
     * Komponiertes.
     */
    private static boolean isPrimaryInverter(SiteSourceDto source) {
        return source != null && "primary".equalsIgnoreCase(source.kind());
    }

    private ChargePointDto charger(UUID siteId, String key) {
        String id = key.startsWith(CHARGER_PREFIX) ? key.substring(CHARGER_PREFIX.length()) : key;
        if (id.isEmpty()) {
            return null;
        }
        return chargers.forSite(siteId).chargers().stream()
                .filter(c -> id.equals(c.chargePointId()))
                .findFirst().orElse(null);
    }



    /**
     * Schreibt VoltPilot an IRGENDEINE Komponente dieses Geräts? Ohne einen
     * einzigen Beleg ist die Antwort „nur gelesen" - die vorsichtigere der
     * beiden Aussagen (dieselbe Regel wie {@link CommandLogReader#writesTo}).
     */
    private static boolean writesAnyOf(List<EntityRow> components) {
        return components.stream()
                .anyMatch(e -> CommandLogReader.writesTo(e.control(), e.capabilitiesJson()));
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
