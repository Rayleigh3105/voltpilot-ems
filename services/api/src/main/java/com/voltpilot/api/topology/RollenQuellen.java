package com.voltpilot.api.topology;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.MessstelleFormelService;
import com.voltpilot.api.uems.MessstelleQuelleRepository;
import com.voltpilot.api.uems.MessstelleRegeln;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.RollenZuordnungRegeln;
import com.voltpilot.api.uems.RollenZuordnungRegeln.Quelle;
import com.voltpilot.api.uems.RollenZuordnungRegeln.Stand;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** Auflösung vor dem Zahlenzwilling: aktive Formel, vollständige Herkunft und genau ein Zustand je Quelle. */
@Component
public class RollenQuellen {
    private final EntityRegistryRepository registry;
    private final MessstelleRepository messstellen;
    private final MessstelleFormelService formeln;
    private final MessstelleQuelleRepository bindungen;
    private final TopologyRepository topology;
    private final MeasurementCatalog katalog;
    private final ObjectMapper json;

    public RollenQuellen(EntityRegistryRepository registry, MessstelleRepository messstellen,
            MessstelleFormelService formeln, MessstelleQuelleRepository bindungen,
            TopologyRepository topology, MeasurementCatalog katalog, ObjectMapper json) {
        this.registry = registry;
        this.messstellen = messstellen;
        this.formeln = formeln;
        this.bindungen = bindungen;
        this.topology = topology;
        this.katalog = katalog;
        this.json = json;
    }

    public Quelle quelle(RollenZuordnungRepository.Zuordnung z, UUID site) {
        if (z.quellMessstelleId() != null) return summe(z.quellMessstelleId());
        // Explizite Punktbindung schlägt den nativen Kanalnamen. Nie aus Box/Transport/Name raten.
        var entity = registry.entityForSite(site, z.entityId());
        if (entity != null && entity.capabilitiesJson() != null) {
            try {
                for (JsonNode cap : json.readTree(entity.capabilitiesJson()).path("measure")) {
                    if (z.capability().equals(cap.path("channel").asText())
                            && cap.path("point_key").isTextual() && !cap.path("point_key").asText().isBlank()) {
                        return kanal(z.entityId(), cap.path("point_key").asText());
                    }
                }
            } catch (JsonProcessingException e) {
                throw konflikt("quelle_nicht_aufloesbar");
            }
        }
        return kanal(z.entityId(), z.capability());
    }

    /** Die Anlagenzahl ist Leistung. Katalogpunkte werden aus W nach kW normiert. */
    public boolean leistungsKanal(UUID site, UUID entityId, String capability) {
        if (Set.of("pv_power_kw", "power_kw", "load_kw", "battery_power_kw").contains(capability)) return true;
        var punkt = katalog.resolve(capability);
        if (punkt != null) return "active_power".equals(punkt.quantity())
                && ("W".equals(punkt.unit()) || "kW".equals(punkt.unit())) && "gauge".equals(punkt.aggregationKind());
        var entity = registry.entityForSite(site, entityId);
        if (entity == null || entity.capabilitiesJson() == null) return false;
        try {
            for (JsonNode cap : json.readTree(entity.capabilitiesJson()).path("measure")) {
                if (capability.equals(cap.path("channel").asText())) return "kW".equals(cap.path("unit").asText());
            }
        } catch (JsonProcessingException e) {
            return false;
        }
        return false;
    }

    public List<Quelle> herkunft(UUID messstelle, UUID site, Instant jetzt) {
        Set<Quelle> aus = new LinkedHashSet<>();
        herkunft(messstelle, site, jetzt, aus, new LinkedHashSet<>());
        return List.copyOf(aus);
    }

    private void herkunft(UUID id, UUID site, Instant jetzt, Set<Quelle> aus, Set<UUID> pfad) {
        if (!pfad.add(id) || pfad.size() > 16) throw konflikt("quelle_nicht_aufloesbar");
        var m = messstellen.finde(id).orElseThrow(() -> konflikt("quelle_nicht_aufloesbar"));
        if (MessstelleRegeln.BERECHNET.equals(m.art())) {
            var f = formeln.formel(id); // ausschließlich die JETZT wirksame Fassung
            if (f.terme().isEmpty()) throw konflikt("quelle_nicht_aufloesbar");
            for (var t : f.terme()) {
                if ("messkanal".equals(t.eingangArt())) {
                    pruefeKanal(site, t.entityId());
                    aus.add(kanal(t.entityId(), t.pointKey()));
                } else if ("messstelle".equals(t.eingangArt())) {
                    aus.add(summe(t.quellMessstelleId()));
                    herkunft(t.quellMessstelleId(), site, jetzt, aus, pfad);
                } else {
                    // Eine Verteilung ist kein ganzer Summenwert und darf nicht als solcher dedupliziert werden.
                    throw konflikt("quelle_nicht_aufloesbar");
                }
            }
        } else {
            var passend = bindungen.derMessstelle(id).stream().filter(b -> "fuehrend".equals(b.rolle())
                    && m.hauptgroesse().groesse().equals(b.groesse())
                    && m.hauptgroesse().richtung().equals(b.richtung())
                    && !b.gueltigAb().isAfter(jetzt)
                    && (b.gueltigBis() == null || b.gueltigBis().isAfter(jetzt))).toList();
            if (passend.size() != 1) throw konflikt("quelle_nicht_aufloesbar");
            var b = passend.getFirst();
            pruefeKanal(site, b.entityId());
            aus.add(kanal(b.entityId(), b.kanal()));
        }
        pfad.remove(id);
    }

    private void pruefeKanal(UUID site, UUID entity) {
        if (entity == null || registry.entityForSite(site, entity) == null) {
            throw konflikt("quelle_nicht_aufloesbar");
        }
    }

    public List<RollenZuordnungRegeln.Zuordnung> aufloesen(UUID site, String rolle,
            List<RollenZuordnungRepository.Zuordnung> zeilen, Instant jetzt, boolean mitWerten) {
        Map<Quelle, List<Quelle>> herkunft = new HashMap<>();
        Map<Quelle, Stand> werte = new HashMap<>();
        List<RollenZuordnungRegeln.Zuordnung> aus = new ArrayList<>();
        for (var z : zeilen) {
            Quelle q = quelle(z, site);
            List<Quelle> innen = herkunft.computeIfAbsent(q, k -> z.quellMessstelleId() == null
                    ? List.of() : herkunft(z.quellMessstelleId(), site, jetzt));
            Stand wert = werte.computeIfAbsent(q, k -> mitWerten ? wert(site, z) : new Stand(null, null, "kein_wert"));
            aus.add(new RollenZuordnungRegeln.Zuordnung(site.toString(), rolle, z.entityId().toString(), q, innen, wert));
        }
        // Ohne explizite Punktbindung ist die Gleichheit eines nativen Kanals mit einem Register
        // desselben Geräts nicht belegbar. Keine Doppelzählung durch eine geratene Alias-Zuordnung.
        for (var z : aus) {
            if (z.quelle().entity_id() == null || katalog.resolve(z.quelle().point_key()) != null) continue;
            if (aus.stream().anyMatch(s -> s.enthaelt().stream().anyMatch(q ->
                    z.quelle().entity_id().equals(q.entity_id()) && !z.quelle().equals(q)))) {
                throw konflikt("kanalidentitaet_nicht_aufloesbar");
            }
        }
        return aus;
    }

    private Stand wert(UUID site, RollenZuordnungRepository.Zuordnung z) {
        if (z.capability() != null) {
            if (registry.entityForSite(site, z.entityId()) == null) return new Stand(null, null, "kein_geraet");
            var vals = topology.latestValues(site,
                    List.of(new TopologyRepository.ChannelKey(z.entityId().toString(), z.capability())));
            if (vals.isEmpty()) return new Stand(null, null, "kein_wert");
            var v = vals.getFirst();
            if (!leistungsKanal(site, z.entityId(), z.capability())) return new Stand(null, null, "kein_wert");
            var punkt = katalog.resolve(z.capability());
            double faktor = punkt != null && "W".equals(punkt.unit()) ? 0.001 : 1;
            return new Stand(v.value() * faktor, zeit(v.receivedAt()), null);
        }
        var m = messstellen.finde(z.quellMessstelleId());
        if (m.isEmpty()) return new Stand(null, null, "kein_geraet");
        if (m.get().archiviertAm() != null) return new Stand(null, null, "archiviert");
        var groesse = m.get().hauptgroesse();
        if (!"Wirkleistung".equals(groesse.groesse()) || !"Momentanwert".equals(groesse.wertart())
                || !"kW".equals(groesse.einheit())) return new Stand(null, null, "kein_wert");
        MessstelleFormelDto.Wert w = formeln.wert(z.quellMessstelleId());
        return new Stand(w.wert(), w.stand() == null ? null : zeit(w.stand().toInstant()),
                w.wert() == null ? "unvollstaendig" : null);
    }

    private static String zeit(Instant zeit) {
        return zeit == null ? null : zeit.truncatedTo(java.time.temporal.ChronoUnit.MILLIS).toString();
    }

    public static Quelle summe(UUID id) { return new Quelle(null, null, id.toString()); }
    private static Quelle kanal(UUID entity, String punkt) { return new Quelle(entity.toString(), punkt, null); }
    private static RollenKonflikt konflikt(String code) {
        return new RollenKonflikt(code, "Die Quellen dieser Rollen-Zuordnung sind nicht eindeutig auflösbar.", List.of());
    }
}
