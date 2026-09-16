package com.voltpilot.api.entities;

import com.voltpilot.api.entities.EntityRegistryRepository.BatteryAsset;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung.Ergebnis;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung.Grund;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die führende Box einer Anlage (UEMS AP-06 IP-5, E3 = A): die EINE Box, der der Registry-Push
 * ({@code …/v2/entities}) und die Flow-Aktivierung ({@code …/v2/flows}) zugestellt werden. Sie
 * ersetzt die Einzel-Gateway-Weiche {@code EntityRegistryService.gatewayDevice} und ihre Kopie in
 * {@code FlowActivationService} — beide rufen jetzt diesen Dienst, es gibt keine zweite Regel.
 *
 * <p>Die Ableitung ist {@link FuehrendeBoxAbleitung}: {@code site.lead_device_id}, wenn die Box in
 * dieser Anlage angemeldet ist, sonst die Box des Speichers, sonst die einzige Box, sonst keine —
 * mit benanntem Grund statt {@code null}. Für jede Bestandsanlage ist {@code lead_device_id} NULL
 * (kein Backfill, gesetzt wird es erst mit der Wahl im Portal); dann liefert der Dienst genau die
 * Box der alten Weiche (Speicher-Box, sonst einzige Box) und genau dort keine, wo sie keine hatte.
 *
 * <p>Einmal-Aufträge nutzen diesen Dienst über {@link EinmalAuftragZiel}, wenn keine
 * Datenquelle an der Komponente hängt. Eine Quellenübergabe bestimmt dagegen die ausführende Box.
 * Fahrplan, Ladepark und OCPP haben weiterhin eigene Wege.
 */
@Service
public class LeadDeviceService {

    /** Die führende Box, oder {@code null} und der benannte Grund, warum keine führt. */
    public record FuehrendeBox(UUID box, Grund grund) {

        /** Ob eine Box führt. */
        public boolean bestimmt() {
            return box != null;
        }
    }

    private final EntityRegistryRepository repo;

    public LeadDeviceService(EntityRegistryRepository repo) {
        this.repo = repo;
    }

    /** Die führende Box der Anlage, unter dem Mandanten der Sitzung. Schreibt nichts. */
    public FuehrendeBox fuehrendeBox(UUID siteId) {
        BatteryAsset speicher = repo.batteryAsset(siteId);
        Ergebnis<UUID> ergebnis = FuehrendeBoxAbleitung.ableiten(repo.siteDeviceIds(siteId),
                speicher == null ? null : speicher.deviceId(), repo.storedLeadDeviceId(siteId));
        return new FuehrendeBox(ergebnis.box(), ergebnis.grund());
    }
}
