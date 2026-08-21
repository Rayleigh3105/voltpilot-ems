package com.voltpilot.api.command;

import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Die EINE Regel „welche Komponenten gehören zu diesem Gerät?" - das
 * Attributions-Modell „Ziel-Gerät führt, Transportweg ist Detail" (Konzept
 * {@code vp-geraeteseite-rev-b8} §5, Stufe 1 „Attribution").
 *
 * <p><b>Der behobene Befund war eine ZWEITE WAHRHEIT.</b> Dieselbe Frage wurde
 * an zwei Orten verschieden beantwortet: das Portal hängt die KOMPONIERTEN
 * Komponenten (Speicher, Netzanschluss, Hausverbrauch) an den ersten gemeldeten
 * Wechselrichter ({@code komponenten.ts plantModel} Regel 2), der Server fand zu
 * einem Gerät hinter der Box nur Komponenten mit gesetztem
 * {@code edge_source_id}-Pin - und eine komponierte Zeile trägt per Konstruktion
 * KEINEN Pin. Auf EINER Seite stand deshalb oben „⚡ VoltPilot steuert den
 * Speicher" und darunter „VoltPilot sendet an dieses Gerät keine Befehle."
 *
 * <p>Die Regel lebt seither hier, EINMAL, und ist wörtlich {@code plantModel}
 * Regel 1 + 2:
 *
 * <ol>
 *   <li><b>Pin gewinnt.</b> Eine Komponente mit {@code edge_source_id} gehört
 *       genau dem Gerät, dessen Kennung dort steht - nie einem anderen.</li>
 *   <li><b>Der PRIMÄRE Wechselrichter erbt das Komponierte.</b> Zeilen ohne Pin,
 *       die an der Box hängen ({@code device_id} gesetzt), entstehen aus der
 *       Auto-Komposition und beschreiben genau das Gerät, über das die Box
 *       misst und steuert.</li>
 * </ol>
 *
 * <p><b>Wer NICHT der primäre Wechselrichter ist, erbt nichts.</b> Ein zweiter
 * Wechselrichter, ein PV-Melder oder ein Zähler bekommt ausschliesslich seine
 * gepinnten Zeilen - eine komponierte Zeile einem beliebigen Gerät
 * zuzuschreiben wäre genau die erfundene Zuordnung, gegen die dieses Modell
 * gebaut ist.
 *
 * <p>Rein und Docker-frei prüfbar (das {@code Tagesprotokoll}/{@code FleetPflege}-Muster);
 * {@link DeviceScopes} ist ihr einziger Aufrufer.
 */
public final class DeviceAttribution {

    private DeviceAttribution() {
    }

    /**
     * Die Komponenten des Geräts, das {@code key} nennt.
     *
     * @param all             alle Komponenten der Anlage (einmal gelesen).
     * @param key             die Quellen-Kennung des Geräts ({@code inverter},
     *                        {@code src-…}).
     * @param deviceId        das beanspruchte Gerät (die Box), an dem die
     *                        komponierten Zeilen hängen; {@code null} = keine.
     * @param primaryInverter ob {@code key} den PRIMÄREN Wechselrichter dieser
     *                        Box nennt - nur er erbt das Komponierte.
     */
    public static List<EntityRow> componentsOf(List<EntityRow> all, String key, UUID deviceId,
            boolean primaryInverter) {
        List<EntityRow> out = new ArrayList<>();
        for (EntityRow e : all) {
            if (key != null && key.equals(e.edgeSourceId())) {
                out.add(e);
            }
        }
        if (!primaryInverter || deviceId == null) {
            return List.copyOf(out);
        }
        for (EntityRow e : all) {
            // Komponiert = kein Pin, aber an DIESER Box. Eine Zeile ohne
            // Geräte-Bindung gehört keinem Gerät - sie wird nie geraten.
            if (e.edgeSourceId() == null && deviceId.equals(e.deviceId()) && !out.contains(e)) {
                out.add(e);
            }
        }
        return List.copyOf(out);
    }
}
