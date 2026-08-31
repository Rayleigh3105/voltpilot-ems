package com.voltpilot.api.verbraucher;

import com.voltpilot.api.chargers.ChargingConfigRepository;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.consumers.ConsumerRepository;
import com.voltpilot.api.verbraucher.RanglisteAbleitung.Ableitung;
import com.voltpilot.api.verbraucher.RanglisteAbleitung.Wunsch;
import com.voltpilot.api.verbraucher.RanglisteProjektion.Kandidat;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import com.voltpilot.api.web.dto.VerbraucherDto;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der SCHREIBWEG der Rangliste (Konzept {@code vp-verbrauchsmgmt-konzept-v1}
 * §5, Paket P4) - die einzige Stelle, die eine gewuenschte Reihenfolge in die
 * Maschine bringt.
 *
 * <p><b>Es entsteht keine Rangliste-Tabelle.</b> Geschrieben werden genau die
 * vier Felder, die es schon gibt ({@link RanglisteAbleitung}); gelesen wird
 * daraus wieder ueber {@link RanglisteProjektion}. „Eine Wahrheit, kein
 * zweites Format" (§5) ist damit eine Eigenschaft der Konstruktion und nicht
 * eine Zusage.
 *
 * <p><b>⚠ Erst pruefen, dann schreiben.</b> Jede Ablehnung faellt VOR dem
 * ersten Schreibvorgang - eine halb gespeicherte Reihenfolge waere eine
 * Aussage, die niemand getroffen hat. Das ist auch der Grund, warum die
 * Ableitung rein ist: sie kennt weder DB noch HTTP.
 *
 * <p><b>⚠ Der Speicher-Push laeuft ueber {@link ChargingConfigService#save}</b>
 * und nicht an ihm vorbei: nur dort wird das retained Dokument der Box neu
 * veroeffentlicht, und die Box ist die Instanz, die die Speicher-Frage
 * tatsaechlich ausfuehrt. Er wird NUR aufgerufen, wenn sich wirklich etwas
 * aendert - ein unveraenderter Push waere ein Rundlauf zum Broker fuer nichts.
 */
@Service
public class RanglisteService {

    private final VerbraucherService verbraucher;
    private final ConsumerRepository consumers;
    private final ChargingConfigRepository configs;
    private final ChargingConfigService charging;

    public RanglisteService(VerbraucherService verbraucher, ConsumerRepository consumers,
            ChargingConfigRepository configs, ChargingConfigService charging) {
        this.verbraucher = verbraucher;
        this.consumers = consumers;
        this.configs = configs;
        this.charging = charging;
    }

    /**
     * Speichert die Reihenfolge und liefert die Zone zurueck, wie sie danach
     * GELESEN wird - also die Normalform. Die Flaeche zeigt damit sofort, was
     * wirklich gespeichert ist, statt eine Anordnung stehen zu lassen, die beim
     * naechsten Laden zurueckspringt.
     */
    @Transactional
    public VerbraucherDto speichere(UUID siteId, List<Wunsch> wunsch, String actor) {
        List<Kandidat> kandidaten = verbraucher.kandidatenFuer(siteId);
        boolean hatSpeicher = verbraucher.hatSpeicher(siteId);

        List<String> fehler = RanglisteAbleitung.pruefe(wunsch, kandidaten, hatSpeicher);
        if (!fehler.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, String.join(" ", fehler));
        }

        Ableitung ab = RanglisteAbleitung.ableiten(wunsch, kandidaten, hatSpeicher);
        for (Kandidat k : kandidaten) {
            if (!k.rankbar()) {
                continue;
            }
            Integer rang = ab.rang().get(k.entityId());
            String relation = ab.storageRelation().get(k.entityId());
            if (rang == null || relation == null) {
                continue;
            }
            consumers.setServiceRank(siteId, k.entityId(), rang, relation);
        }

        ChargingConfigDto vorher = configs.forSite(siteId);
        String storagePriority = geaendert(ab.storagePriority(), vorher.storagePriority());
        List<String> vorrang = geaendert(ab.vorrangKennungen(), vorher.priorityChargePointIds());

        // P6: die zwei ZAHLEN, mit denen die BOX dieselbe Reihenfolge faehrt.
        // `null` = die Raenge sind unveraendert und werden nicht angefasst.
        Map<String, Integer> raenge = raengeGeaendert(ab, vorher, configs.chargePointRanks(siteId))
                ? ab.saeulenRang() : null;

        // ⚠ GENAU EIN Push, auch wenn sich alles geaendert hat: das retained
        // Dokument wird als GANZES ersetzt, zwei Aufrufe waeren zwei Rundlaeufe
        // zum Broker fuer denselben Zustand.
        if (storagePriority != null || vorrang != null || raenge != null) {
            charging.saveRangliste(siteId, vorrang, storagePriority, raenge, ab.speicherRang(),
                    actor);
        }
        return verbraucher.forSite(siteId);
    }

    /**
     * Haben sich die P6-Zahlen geaendert? Verglichen wird gegen das, was die
     * Box heute wirklich bekommt (die Raenge der ZUGELASSENEN Saeulen plus die
     * Position des Speichers) - ein unveraenderter Stapel darf keinen Rundlauf
     * zum Broker ausloesen.
     */
    private static boolean raengeGeaendert(Ableitung ab, ChargingConfigDto vorher,
            Map<String, Integer> gespeichert) {
        if (!Objects.equals(ab.speicherRang(), vorher.storageRank())) {
            return true;
        }
        // ⚠ Verglichen wird gegen die GESPEICHERTEN Raenge, nicht gegen die der
        // zugelassenen Saeulen: eine Anlage, deren Saeulen nur an der Box
        // eingetragen sind, hat gar keine Allowlist - ueber sie gemessen waere
        // jede Reihenfolge fuer immer „unveraendert" und wuerde nie gespeichert.
        return !new LinkedHashMap<>(gespeichert).equals(new LinkedHashMap<>(ab.saeulenRang()));
    }

    /** {@code null} = unveraendert (oder gar keine Aussage) ⇒ nicht schreiben. */
    private static String geaendert(String neu, String alt) {
        if (neu == null) {
            return null;
        }
        // Die Vorgabe der Box ist „Speicher vor Auto": eine Anlage, die noch nie
        // gefragt wurde, faehrt sie schon - dann ist es keine Aenderung.
        String wirksam = alt == null ? RanglisteProjektion.STORAGE_VOR_AUTO : alt;
        return neu.equals(wirksam) ? null : neu;
    }

    /** {@code null} = nicht anfassen; sonst die Menge, wenn sie eine andere ist. */
    private static List<String> geaendert(List<String> neu, List<String> alt) {
        if (neu == null) {
            return null;
        }
        Set<String> a = new LinkedHashSet<>(alt == null ? List.of() : alt);
        Set<String> b = new LinkedHashSet<>(neu);
        return a.equals(b) ? null : neu;
    }

}
