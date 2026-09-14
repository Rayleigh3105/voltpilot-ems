package com.voltpilot.api.topology;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.topology.RollenZuordnungRepository.Zuordnung;
import com.voltpilot.api.uems.MessstelleFormelService;
import com.voltpilot.api.uems.MessstelleRegeln;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleService;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import com.voltpilot.api.web.dto.RollenDto;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die geraeteseitige Rollen-Zuordnung als KUNDEN-Fläche (Konzept vp-agg-konzept2-f3 §2.3/§2.6.3,
 * vp-agg-konzept3-r8): lesen und schreiben, welcher Wert die (heute nur) PV-Produktion EINES
 * Geraets ist, und den kanonischen, ueber alle Geraete zusammengefassten Rollen-Wert der Anlage
 * lesen. Der zugeordnete Wert ist ENTWEDER ein nativer Kanal ODER ein Gesamtwert (berechnete
 * Messstelle) — dasselbe verallgemeinerte {@link RollenZuordnungRepository}, kein zweites Modell.
 *
 * <p><b>Sicherheit:</b> der Mandant ist die RLS (wie jede {@code /api/v1/sites/**}-Route). Eine
 * fremde Anlage/Komponente ist nicht sichtbar → 404, nie 403. Eine Rollen-Zuordnung ist
 * Praesentation und weitet keine Steuerung — der Box-Schutzpfad bleibt unberuehrt.
 *
 * <p><b>Konfliktfall (is_primary-Semantik):</b> das Zuordnen eines zweiten Werts auf dieselbe Rolle
 * ERSETZT den bisher massgeblichen; die Antwort nennt den abgeloesten Wert.
 *
 * <p><b>Rueckfall:</b> hat eine Anlage keine PV-Zuordnung, ist {@code zuordnung_vorhanden = false}
 * und der Wert {@code null} — die Cockpit-Scheibe bleibt dann bei {@code telemetry.pv_power_kw}
 * (Vertrag docs/contracts/v2/topology-read-model.md).
 */
@Service
public class RollenZuordnungService {

    /** Ab wann ein nativer Live-Wert als „veraltet" gilt (dieselbe 5-Minuten-Sicht wie die Box). */
    static final Duration FRISCHE = Duration.ofMinutes(5);

    /** Die Rolle, deren Aggregation eine reine Summe ist — ab Tag 1 die einzige. */
    public static final String ROLLE_PV = "pv";

    /**
     * Die Rollen, die als massgeblicher Geraete-Wert zuordenbar sind. Ab Tag 1 nur {@code pv};
     * die Struktur (rollen-generische Methoden) traegt {@code grid}/{@code storage}/{@code consumer}
     * nach — sie tragen aber eigene Aggregationsgesetze (grid = keine Summe, storage = Summe + SoC),
     * darum erst mit ihrer eigenen Scheibe.
     */
    private static final Set<String> ZUORDENBARE_ROLLEN = Set.of(ROLLE_PV);

    private static final String MESSKANAL = "messkanal";
    private static final String GESAMTWERT = "gesamtwert";

    private final SiteRepository sites;
    private final EntityRegistryRepository registry;
    private final RollenZuordnungRepository repo;
    private final TopologyRepository topology;
    private final MessstelleRepository messstellen;
    private final MessstelleFormelService formeln;

    public RollenZuordnungService(SiteRepository sites, EntityRegistryRepository registry,
            RollenZuordnungRepository repo, TopologyRepository topology,
            MessstelleRepository messstellen, MessstelleFormelService formeln) {
        this.sites = sites;
        this.registry = registry;
        this.repo = repo;
        this.topology = topology;
        this.messstellen = messstellen;
        this.formeln = formeln;
    }

    // ------------------------------------------------- lesen: Geraete-Zuordnung

    /** Der massgebliche Rollen-Wert eines Geraets (oder {@code null}, wenn keiner zugeordnet ist). */
    public RollenDto.GeraetRolle lies(UUID siteId, UUID entityId, String role) {
        pruefeRolle(role);
        pruefeGeraet(siteId, entityId);
        return new RollenDto.GeraetRolle(entityId, role,
                repo.primaer(entityId, role).map(this::alsWert).orElse(null));
    }

    // ----------------------------------------------- schreiben: Geraete-Zuordnung

    /**
     * Ordnet einem Geraet den massgeblichen Wert der Rolle zu (nativer Kanal ODER Gesamtwert) und
     * loest den bisher massgeblichen ab (is_primary-Semantik). Die Antwort nennt den abgeloesten Wert.
     */
    public RollenDto.ZuordnungAntwort zuordnen(UUID siteId, UUID entityId, String role,
            RollenDto.Eingabe e) {
        pruefeRolle(role);
        pruefeGeraet(siteId, entityId);
        if (e == null || e.art() == null) {
            throw badRequest("Ein zugeordneter Wert braucht eine Art (messkanal oder gesamtwert).");
        }
        Zuordnung vorher = repo.primaer(entityId, role).orElse(null);
        RollenDto.Wert zugeordnet;
        if (MESSKANAL.equals(e.art())) {
            String capability = e.capability() == null ? "" : e.capability().trim();
            if (capability.isEmpty()) {
                throw badRequest("Ein Messkanal-Wert braucht einen Kanal (capability).");
            }
            repo.primaerLoesen(entityId, role);
            repo.setzeKanal(siteId, entityId, capability, role);
            zugeordnet = new RollenDto.Wert(MESSKANAL, capability, null, capability);
        } else if (GESAMTWERT.equals(e.art())) {
            UUID quell = e.quellMessstelleId();
            if (quell == null) {
                throw badRequest("Ein Gesamtwert-Wert braucht eine Messstelle (quell_messstelle_id).");
            }
            Messstelle m = messstellen.finde(quell).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
            if (!MessstelleRegeln.BERECHNET.equals(m.art())) {
                throw badRequest("Nur ein Gesamtwert (berechnete Messstelle) kann einer Rolle "
                        + "zugeordnet werden.");
            }
            if (m.archiviertAm() != null) {
                throw badRequest("Diese Messstelle ist archiviert und kann nicht zugeordnet werden.");
            }
            repo.primaerLoesen(entityId, role);
            repo.setzeMessstelle(siteId, entityId, quell, role);
            zugeordnet = new RollenDto.Wert(GESAMTWERT, null, quell, m.name());
        } else {
            throw badRequest("Die Art ist 'messkanal' oder 'gesamtwert'.");
        }
        RollenDto.Wert abgeloest = (vorher != null && !derselbeWert(vorher, zugeordnet))
                ? alsWert(vorher) : null;
        return new RollenDto.ZuordnungAntwort(zugeordnet, abgeloest);
    }

    // ---------------------------------------- lesen: kanonischer Rollen-Wert

    /**
     * Der kanonische Rollen-Wert der Anlage: die (benannte) Summe der massgeblichen Geraete-Werte
     * dieser Rolle. Ehrlich — jedes Geraet ist benannt (liefernd mit Wert, oder stumm mit Grund),
     * nie eine stille Teilsumme; innerhalb eines Geraets ist ein unvollstaendiger Wert {@code null}
     * (die Regel des Gesamtwerts), nicht heimlich reduziert.
     */
    public RollenDto.KanonischerWert kanonisch(UUID siteId, String role) {
        if (!ROLLE_PV.equals(role)) {
            throw badRequest("Ein zusammengefasster Rollen-Wert gibt es bisher nur fuer 'pv'.");
        }
        pruefeAnlage(siteId);
        List<Zuordnung> primaere = repo.primaereDerAnlage(siteId, role);
        List<RollenDto.GeraetBeitrag> beitraege = new ArrayList<>();
        Double summe = null;
        boolean unvollstaendig = false;
        Instant stand = null;
        for (Zuordnung z : primaere) {
            String name = geraetName(siteId, z.entityId());
            Beitrag b = wertVon(siteId, z);
            if (b.liefernd()) {
                summe = (summe == null ? 0.0 : summe) + b.wert();
                stand = juenger(stand, b.stand());
            } else {
                unvollstaendig = true;
            }
            beitraege.add(new RollenDto.GeraetBeitrag(z.entityId(), name,
                    z.capability() != null ? MESSKANAL : GESAMTWERT,
                    b.liefernd() ? b.wert() : null, b.liefernd(), b.grund()));
        }
        boolean vorhanden = !primaere.isEmpty();
        OffsetDateTime standTz = stand == null ? null
                : OffsetDateTime.ofInstant(stand, MessstelleService.ZEITZONE);
        return new RollenDto.KanonischerWert(role, vorhanden, summe, "kW", unvollstaendig,
                beitraege, standTz);
    }

    // ------------------------------------------------------------------ Helfer

    /** Das Zwischenergebnis eines Geraete-Beitrags. */
    private record Beitrag(boolean liefernd, Double wert, Instant stand, String grund) {}

    private Beitrag wertVon(UUID siteId, Zuordnung z) {
        if (z.capability() != null) {
            List<TopologyRepository.LatestValue> vals = topology.latestValues(siteId,
                    List.of(new TopologyRepository.ChannelKey(z.entityId().toString(), z.capability())));
            if (vals.isEmpty()) {
                return new Beitrag(false, null, null, "kein_wert");
            }
            TopologyRepository.LatestValue lv = vals.get(0);
            if (lv.receivedAt().isBefore(Instant.now().minus(FRISCHE))) {
                return new Beitrag(false, null, null, "veraltet");
            }
            return new Beitrag(true, lv.value(), lv.receivedAt(), null);
        }
        // Ein Gesamtwert: seine eigene Ehrlichkeitsregel gilt (null statt Teilsumme innerhalb).
        Optional<Messstelle> m = messstellen.finde(z.quellMessstelleId());
        if (m.isEmpty() || !MessstelleRegeln.BERECHNET.equals(m.get().art())) {
            return new Beitrag(false, null, null, "kein_geraet");
        }
        if (m.get().archiviertAm() != null) {
            return new Beitrag(false, null, null, "archiviert");
        }
        MessstelleFormelDto.Wert w = formeln.wert(z.quellMessstelleId());
        if (w.wert() == null) {
            return new Beitrag(false, null, null, "unvollstaendig");
        }
        Instant stand = w.stand() == null ? null : w.stand().toInstant();
        return new Beitrag(true, w.wert(), stand, null);
    }

    private RollenDto.Wert alsWert(Zuordnung z) {
        if (z.capability() != null) {
            return new RollenDto.Wert(MESSKANAL, z.capability(), null, z.capability());
        }
        String name = messstellen.finde(z.quellMessstelleId()).map(Messstelle::name).orElse(null);
        return new RollenDto.Wert(GESAMTWERT, null, z.quellMessstelleId(), name);
    }

    private static boolean derselbeWert(Zuordnung a, RollenDto.Wert b) {
        if (a.capability() != null) {
            return MESSKANAL.equals(b.art()) && a.capability().equals(b.capability());
        }
        return GESAMTWERT.equals(b.art()) && Objects.equals(a.quellMessstelleId(), b.quellMessstelleId());
    }

    private String geraetName(UUID siteId, UUID entityId) {
        EntityRow row = registry.entityForSite(siteId, entityId);
        if (row == null || row.label() == null || row.label().isBlank()) {
            return "Gerät";
        }
        return row.label();
    }

    private void pruefeRolle(String role) {
        if (role == null || !ZUORDENBARE_ROLLEN.contains(role)) {
            throw badRequest("Diese Rolle ist noch nicht zuordenbar (bisher nur 'pv').");
        }
    }

    private void pruefeAnlage(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    private void pruefeGeraet(UUID siteId, UUID entityId) {
        pruefeAnlage(siteId);
        if (registry.entityForSite(siteId, entityId) == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
    }

    private static ResponseStatusException badRequest(String satz) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, satz);
    }

    private static Instant juenger(Instant a, Instant b) {
        return a == null || (b != null && b.isAfter(a)) ? b : a;
    }
}
