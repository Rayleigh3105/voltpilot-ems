package com.voltpilot.api.topology;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.topology.RollenZuordnungRepository.Zuordnung;
import com.voltpilot.api.uems.MessstelleRegeln;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RollenZuordnungRegeln;
import com.voltpilot.api.uems.RollenZuordnungRegeln.Quelle;
import com.voltpilot.api.web.dto.RollenDto;
import com.voltpilot.api.repo.SiteRepository;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Live-Rollen der Anlage. Rechte/RLS vor Auflösung; H-1 entscheidet Zählung, Frische und Änderungen. */
@Service
public class RollenZuordnungService {
    public static final String ROLLE_PV = "pv";
    private static final String MESSKANAL = "messkanal";
    private static final String GESAMTWERT = "gesamtwert"; // bestehendes API-Vokabular
    private final SiteRepository sites;
    private final EntityRegistryRepository registry;
    private final RollenZuordnungRepository repo;
    private final MessstelleRepository messstellen;
    private final RollenQuellen quellen;
    private final RollenProtokoll protokoll;

    public RollenZuordnungService(SiteRepository sites, EntityRegistryRepository registry,
            RollenZuordnungRepository repo, MessstelleRepository messstellen,
            RollenQuellen quellen, RollenProtokoll protokoll) {
        this.sites = sites;
        this.registry = registry;
        this.repo = repo;
        this.messstellen = messstellen;
        this.quellen = quellen;
        this.protokoll = protokoll;
    }

    public RollenDto.GeraetRolle lies(UUID site, UUID entity, String rolle) {
        pruefeRolle(rolle);
        pruefeGeraet(site, entity);
        return new RollenDto.GeraetRolle(entity, rolle, repo.primaer(entity, rolle).map(this::alsWert).orElse(null));
    }

    public java.util.Set<UUID> geleseneGeraete(UUID site, UUID messstelle) {
        geltungsbereich.requireSite(site);
        return quellen.herkunft(messstelle, site, Instant.now()).stream()
                .filter(q -> q.entity_id() != null).map(q -> UUID.fromString(q.entity_id()))
                .collect(java.util.stream.Collectors.toSet());
    }

    @Transactional
    public RollenDto.ZuordnungAntwort zuordnen(UUID site, UUID entity, String rolle,
            RollenDto.Eingabe eingabe, ProtokollAkteur wer) {
        pruefeRolle(rolle);
        pruefeGeraet(site, entity);
        repo.sperreAnlage(site);
        RollenDto.Wert wert = pruefeWert(site, rolle, eingabe);
        if (wert.capability() != null && !quellen.leistungsKanal(site, entity, wert.capability())) {
            throw badRequest("Die Rolle braucht einen Leistungskanal in W oder kW.");
        }
        return setzen(site, rolle, Map.of(entity, wert), false, wer).get(entity);
    }

    /** Dieselbe Zuordnung an jedem gelesenen Gerät; ein Netz-Austausch braucht ausdrückliches ersetzen. */
    @Transactional
    public RollenDto.AnlageAntwort zuordnenAnlage(UUID site, String rolle,
            RollenDto.AnlageEingabe eingabe, ProtokollAkteur wer) {
        pruefeRolle(rolle);
        pruefeAnlage(site);
        repo.sperreAnlage(site);
        if (eingabe == null || !GESAMTWERT.equals(eingabe.art())) {
            throw badRequest("Die Anlagen-Zuordnung braucht einen Summenwert.");
        }
        RollenDto.Wert wert = pruefeWert(site, rolle,
                new RollenDto.Eingabe(eingabe.art(), null, eingabe.quellMessstelleId()));
        Map<UUID, RollenDto.Wert> neu = new LinkedHashMap<>();
        for (Quelle q : quellen.herkunft(wert.quellMessstelleId(), site, Instant.now())) {
            if (q.entity_id() != null) neu.put(UUID.fromString(q.entity_id()), wert);
        }
        if (neu.isEmpty()) throw badRequest("Der Summenwert hat keine auflösbaren Geräte.");
        setzen(site, rolle, neu, "grid".equals(rolle) && eingabe.ersetzen(), wer);
        return new RollenDto.AnlageAntwort(neu.keySet().stream()
                .map(id -> new RollenDto.GeraetRolle(id, rolle, wert)).toList());
    }

    @Transactional
    public RollenDto.ZuordnungAntwort entziehen(UUID site, UUID entity, String rolle, ProtokollAkteur wer) {
        pruefeRolle(rolle);
        pruefeGeraet(site, entity);
        repo.sperreAnlage(site);
        Zuordnung alt = repo.primaer(entity, rolle).orElse(null);
        // Ein Summenwert ist eine gemeinsame Quelle, auch wenn er an mehreren Geräten hängt.
        // Sein Entzug muss denselben Umfang haben wie anlageZuordnen; sonst bleibt er im Cockpit.
        List<Zuordnung> entziehen = alt != null && alt.quellMessstelleId() != null
                ? repo.primaereDerAnlage(site, rolle).stream()
                        .filter(z -> alt.quellMessstelleId().equals(z.quellMessstelleId())).toList()
                : alt == null ? List.of() : List.of(alt);
        if (alt == null) repo.entziehen(entity, rolle);
        for (Zuordnung z : entziehen) {
            repo.entziehen(z.entityId(), rolle);
            protokolliere(site, z.entityId(), rolle, z, null, wer);
        }
        return new RollenDto.ZuordnungAntwort(null, alt == null ? null : alsWert(alt));
    }

    private Map<UUID, RollenDto.ZuordnungAntwort> setzen(UUID site, String rolle,
            Map<UUID, RollenDto.Wert> neu, boolean netzErsetzen, ProtokollAkteur wer) {
        List<Zuordnung> vorher = repo.primaereDerAnlage(site, rolle);
        List<Zuordnung> danach = new ArrayList<>(vorher.stream()
                .filter(z -> !neu.containsKey(z.entityId()) && !netzErsetzen).toList());
        neu.forEach((id, wert) -> danach.add(zeile(id, rolle, wert)));
        pruefeZaehlen(site, rolle, danach, vorher);
        // Auch eine Rollenänderung derselben Quelle (Unique entity+Quelle) ist Entzug + Setzen.
        for (String andere : List.of("pv", "consumer", "grid")) {
            if (andere.equals(rolle)) continue;
            for (UUID id : neu.keySet()) {
                Zuordnung alt = repo.primaer(id, andere).orElse(null);
                if (alt != null && derselbeWert(alt, neu.get(id))) {
                    repo.entziehen(id, andere);
                    protokolliere(site, id, andere, alt, null, wer);
                }
            }
        }
        if (netzErsetzen) {
            for (Zuordnung alt : vorher) {
                if (!neu.containsKey(alt.entityId())) {
                    repo.entziehen(alt.entityId(), rolle);
                    protokolliere(site, alt.entityId(), rolle, alt, null, wer);
                }
            }
        }
        Map<UUID, RollenDto.ZuordnungAntwort> antwort = new LinkedHashMap<>();
        neu.forEach((id, wert) -> {
            Zuordnung alt = vorher.stream().filter(z -> z.entityId().equals(id)).findFirst().orElse(null);
            if (alt == null || !derselbeWert(alt, wert)) {
                repo.primaerLoesen(id, rolle);
                if (wert.capability() != null) repo.setzeKanal(site, id, wert.capability(), rolle);
                else repo.setzeMessstelle(site, id, wert.quellMessstelleId(), rolle);
                protokolliere(site, id, rolle, alt, wert, wer);
            }
            antwort.put(id, new RollenDto.ZuordnungAntwort(wert,
                    alt == null || derselbeWert(alt, wert) ? null : alsWert(alt)));
        });
        return antwort;
    }

    /** Auch der bestehende Topologie-Schreibweg benutzt dieselbe Sperre und Netz-Regel. */
    public void sperreAnlage(UUID site) { repo.sperreAnlage(site); }

    public Map<String, List<Zuordnung>> protokollVorher(UUID site) {
        Map<String, List<Zuordnung>> vorher = new LinkedHashMap<>();
        for (String rolle : List.of("pv", "consumer", "grid")) vorher.put(rolle, repo.primaereDerAnlage(site, rolle));
        return vorher;
    }

    /** Der ältere Topologie-Stapel schreibt dieselben maßgeblichen Werte; sein Push bleibt unverändert. */
    public void protokollNachher(UUID site, Map<String, List<Zuordnung>> vorher, ProtokollAkteur wer) {
        for (var entry : vorher.entrySet()) {
            String rolle = entry.getKey();
            var nachher = repo.primaereDerAnlage(site, rolle);
            java.util.Set<UUID> geraete = new java.util.LinkedHashSet<>();
            entry.getValue().forEach(z -> geraete.add(z.entityId()));
            nachher.forEach(z -> geraete.add(z.entityId()));
            for (UUID entity : geraete) {
                var alt = entry.getValue().stream().filter(z -> z.entityId().equals(entity)).findFirst().orElse(null);
                var neu = nachher.stream().filter(z -> z.entityId().equals(entity)).findFirst().orElse(null);
                protokolliere(site, entity, rolle, alt, neu == null ? null : alsWert(neu), wer);
            }
        }
    }

    public void pruefeNetz(UUID site) {
        var zeilen = repo.primaereDerAnlage(site, "grid");
        pruefeZaehlen(site, "grid", zeilen, zeilen);
    }

    private void pruefeZaehlen(UUID site, String rolle, List<Zuordnung> zeilen, List<Zuordnung> vorher) {
        Instant jetzt = Instant.now();
        var eingang = quellen.aufloesen(site, rolle, zeilen, jetzt, false);
        if ("grid".equals(rolle) && !RollenZuordnungRegeln.netz(site.toString(), eingang).erlaubt()) {
            throw new RollenKonflikt("netz_mehrfach", "Der Netzwert ist bereits zugeordnet: "
                    + vorher.stream().map(z -> geraetName(site, z.entityId())).distinct().toList(),
                    vorher.stream().map(Zuordnung::entityId).distinct().toList());
        }
        try {
            RollenZuordnungRegeln.zaehlung(site.toString(), rolle, jetzt.toString(), eingang);
        } catch (IllegalArgumentException e) {
            throw new RollenKonflikt(e.getMessage(), "Diese Summenwerte enthalten überlappende Quellen.", List.of());
        }
    }

    private RollenDto.Wert pruefeWert(UUID site, String rolle, RollenDto.Eingabe e) {
        if (e == null) throw badRequest("Ein zugeordneter Wert braucht eine Art.");
        if (MESSKANAL.equals(e.art())) {
            if (e.capability() == null || e.capability().isBlank() || e.quellMessstelleId() != null) {
                throw badRequest("Ein Messkanal-Wert braucht genau einen Kanal (capability).");
            }
            return new RollenDto.Wert(MESSKANAL, e.capability().trim(), null, e.capability().trim());
        }
        if (!GESAMTWERT.equals(e.art()) || e.quellMessstelleId() == null || e.capability() != null) {
            throw badRequest("Die Art ist 'messkanal' oder 'gesamtwert', mit genau einer Quelle.");
        }
        Messstelle m = messstellen.finde(e.quellMessstelleId()).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        if (!MessstelleRegeln.BERECHNET.equals(m.art()) || m.archiviertAm() != null) {
            throw badRequest("Nur ein aktiver Summenwert kann einer Rolle zugeordnet werden.");
        }
        var g = m.hauptgroesse();
        String richtung = switch (rolle) { case "pv" -> "Erzeugung"; case "consumer" -> "Bezug"; default -> "richtungslos"; };
        if (!"Wirkleistung".equals(g.groesse()) || !"Momentanwert".equals(g.wertart())
                || !"kW".equals(g.einheit()) || !richtung.equals(g.richtung())) {
            throw badRequest("Die Rolle braucht eine Leistung in kW mit Richtung „" + richtung + "“.");
        }
        try {
            quellen.herkunft(m.id(), site, Instant.now());
        } catch (RollenKonflikt e1) {
            throw badRequest("Dieser Summenwert gehört nicht vollständig zu dieser Anlage oder ist nicht auflösbar.");
        }
        return new RollenDto.Wert(GESAMTWERT, null, m.id(), m.name());
    }

    public RollenDto.KanonischerWert kanonisch(UUID site, String rolle) {
        pruefeRolle(rolle);
        pruefeAnlage(site);
        return baueKanonisch(site, rolle, repo.primaereDerAnlage(site, rolle));
    }

    /** Kompatibler PV-Einstieg; die Übersicht liest alle drei Rollen flottenweit. */
    public Map<UUID, RollenDto.KanonischerWert> pvJeAnlage() {
        return rollenJeAnlage(ROLLE_PV);
    }

    /** Eine Zuordnungs-Abfrage je Rolle; Anlagen ohne Zuordnung bleiben abwesend. */
    public Map<UUID, RollenDto.KanonischerWert> rollenJeAnlage(String rolle) {
        pruefeRolle(rolle);
        Map<UUID, RollenDto.KanonischerWert> aus = new HashMap<>();
        repo.primaereJeAnlage(rolle).forEach((site, zeilen) -> aus.put(site, baueKanonisch(site, rolle, zeilen)));
        return aus;
    }

    private RollenDto.KanonischerWert baueKanonisch(UUID site, String rolle, List<Zuordnung> zeilen) {
        String jetzt = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString();
        var eingang = quellen.aufloesen(site, rolle, zeilen, Instant.parse(jetzt), true);
        RollenZuordnungRegeln.Ergebnis ergebnis;
        try {
            ergebnis = RollenZuordnungRegeln.zaehlung(site.toString(), rolle, jetzt, eingang);
        } catch (IllegalArgumentException e) {
            throw new RollenKonflikt(e.getMessage(), "Diese Summenwerte enthalten überlappende Quellen.", List.of());
        }
        if (ergebnis.fehler() != null) {
            throw new RollenKonflikt(ergebnis.fehler(), "Der Anlage sind mehrere Netzwerte zugeordnet.",
                    zeilen.stream().map(Zuordnung::entityId).toList());
        }
        List<RollenDto.GeraetBeitrag> beitraege = new ArrayList<>();
        for (int i = 0; i < eingang.size(); i++) {
            var z = eingang.get(i);
            var massgeblich = eingang.stream().filter(a -> ergebnis.gezaehlt().contains(a.quelle())
                    && (a.quelle().equals(z.quelle()) || a.enthaelt().contains(z.quelle()))).findFirst().orElseThrow();
            var stand = RollenZuordnungRegeln.frische(jetzt, massgeblich.zustand());
            var zeile = zeilen.get(i);
            beitraege.add(new RollenDto.GeraetBeitrag(zeile.entityId(), geraetName(site, zeile.entityId()),
                    zeile.capability() == null ? GESAMTWERT : MESSKANAL, stand.wert(), stand.wert() != null, stand.grund()));
        }
        OffsetDateTime stand = ergebnis.stand() == null ? null
                : Instant.parse(ergebnis.stand()).atZone(MessstelleService.ZEITZONE).toOffsetDateTime();
        return new RollenDto.KanonischerWert(rolle, ergebnis.zuordnung_vorhanden(), ergebnis.wert(), "kW",
                ergebnis.unvollstaendig(), beitraege, stand);
    }

    private void protokolliere(UUID site, UUID entity, String rolle, Zuordnung alt,
            RollenDto.Wert neu, ProtokollAkteur wer) {
        try {
            Quelle vorher = alt == null ? null : quellen.quelle(alt, site);
            Quelle nachher = neu == null ? null : quellen.quelle(zeile(entity, rolle, neu), site);
            for (String art : RollenZuordnungRegeln.aenderung(vorher, nachher)) {
                protokoll.schreiben(site, entity, rolle, art, alt == null ? null : alsWert(alt), neu, wer);
            }
        } catch (RuntimeException e) {
            protokoll.fehlgeschlagen(site, e);
        }
    }

    private RollenDto.Wert alsWert(Zuordnung z) {
        return z.capability() != null ? new RollenDto.Wert(MESSKANAL, z.capability(), null, z.capability())
                : new RollenDto.Wert(GESAMTWERT, null, z.quellMessstelleId(),
                        messstellen.finde(z.quellMessstelleId()).map(Messstelle::name).orElse(null));
    }

    private static Zuordnung zeile(UUID entity, String rolle, RollenDto.Wert w) {
        return new Zuordnung(null, entity, w.capability(), w.quellMessstelleId(), rolle, true);
    }

    private static boolean derselbeWert(Zuordnung a, RollenDto.Wert b) {
        return Objects.equals(a.capability(), b.capability()) && Objects.equals(a.quellMessstelleId(), b.quellMessstelleId());
    }

    private String geraetName(UUID site, UUID entity) {
        var row = registry.entityForSite(site, entity);
        return row == null || row.label() == null || row.label().isBlank() ? "Gerät" : row.label();
    }

    private void pruefeAnlage(UUID site) {
        if (!sites.existsForCurrentTenant(site)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    private void pruefeGeraet(UUID site, UUID entity) {
        pruefeAnlage(site);
        if (registry.entityForSite(site, entity) == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
    }

    private static void pruefeRolle(String rolle) {
        if (!RollenZuordnungRegeln.rolle(rolle).zuordnen()) throw badRequest("Diese Rolle ist nicht zuordenbar.");
    }

    private static ResponseStatusException badRequest(String satz) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, satz);
    }
}
