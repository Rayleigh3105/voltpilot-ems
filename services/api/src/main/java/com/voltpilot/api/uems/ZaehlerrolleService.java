package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.uems.ZaehlerrolleRegeln.Angaben;
import com.voltpilot.api.uems.ZaehlerrolleRegeln.Befund;
import com.voltpilot.api.uems.ZaehlerrolleRegeln.Knoten;
import com.voltpilot.api.uems.ZaehlerrolleRepository.Fassung;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Zählerrolle einer Messstelle (MiSpeL MP-6, Vertrag {@code docs/contracts/v2/mispel-zaehlerrolle.md}):
 * lesen mit den Befunden der Plausibilität und setzen als neue Fassung ab einem Tag.
 *
 * <p><b>Was hinter einem Zähler liegt</b> liest dieser Dienst aus dem Bestand des Registers: die
 * elektrische Stellung des Tages ({@code messstelle_stellung}: Anlage und „Unterzähler von“) und die
 * Komponenten der führenden Quellen der Hauptgröße an dem Tag, deren Rolle die Topologie der Anlage nennt
 * ({@link TopologyService}: pv, storage, consumer, grid, charging). Eine Messstelle ohne Quelle hat ein
 * UNBEKANNTES Messobjekt — nie „nichts dahinter“.
 *
 * <p><b>Setzen</b> urteilt an jedem Tag der neuen Fassung, an dem sich die Stellungen der Anlage ändern
 * (und an ihrem ersten): ohne Anlage 422 {@code ohne_anlage}, dieselbe Größe der Festlegung an einer
 * anderen Messstelle der Anlage 409 {@code zaehlerrolle_vergeben}, ein Verstoß gegen die Trennung (A1 S. 25)
 * an diesem Zähler 422 {@code zaehler_nicht_getrennt}. Ändert sich der Baum SPÄTER über einen anderen
 * Schreibweg, zeigt es der Befund beim Lesen — das Rechenwerk (MP-8) liest das Urteil, nicht die Rolle allein.
 */
@Service
public class ZaehlerrolleService {

    private final MessstelleRepository messstellen;
    private final MessstelleZuordnungRepository zuordnungen;
    private final MessstelleQuelleRepository quellen;
    private final ZaehlerrolleRepository rollen;
    private final TopologyService topologie;
    private final UnternehmenRepository unternehmen;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public ZaehlerrolleService(MessstelleRepository messstellen, MessstelleZuordnungRepository zuordnungen,
            MessstelleQuelleRepository quellen, ZaehlerrolleRepository rollen, TopologyService topologie,
            UnternehmenRepository unternehmen, PlatformTransactionManager transactionManager) {
        this.messstellen = messstellen;
        this.zuordnungen = zuordnungen;
        this.quellen = quellen;
        this.rollen = rollen;
        this.topologie = topologie;
        this.unternehmen = unternehmen;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests. */
    public void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Die Anfrage von {@code PUT …/zaehlerrolle}. */
    public record Aendern(String rolle, String zaehlpunkt, String messstellenbetreiber, String eichstatus,
            LocalDate eichfristBis, String wertequelle, LocalDate gueltigAb) {}

    /** Eine Fassung mit ihrem abgeleiteten letzten Tag ({@code null} = offen). */
    public record FassungAnsicht(Fassung fassung, LocalDate gueltigBis) {}

    /** Die Zählerrolle einer Messstelle am Tag: Fassung, Größe der Festlegung, Befunde, Urteil, Historie. */
    public record Ansicht(Messstelle messstelle, LocalDate am, UUID anlage, Fassung aktuell, String festlegungsgroesse,
            List<Befund> befunde, String urteil, List<FassungAnsicht> fassungen) {}

    /** Die Zähler einer Anlage am Tag — die Eingabe des Rechenwerks (MP-8): Größe der Festlegung → Messstelle. */
    public record AnlageStand(UUID anlage, LocalDate am, Map<String, Knoten> zaehler, List<Knoten> knoten,
            List<Befund> befunde) {}

    // ------------------------------------------------------------------ lesen

    public Ansicht ansicht(UUID id, LocalDate am) {
        Messstelle m = finde(id);
        LocalDate tag = am != null ? am : uhr.instant().atZone(zone()).toLocalDate();
        List<Fassung> eigene = wirksam(rollen.derMessstelle(id));
        Fassung aktuell = amTag(eigene, tag);
        Angaben a = aktuell == null ? null : aktuell.angaben();
        String rolle = a == null ? null : a.rolle();
        StellungZeile st = stellungAm(zuordnungen.stellungen(id), tag);
        List<Befund> befunde = List.of();
        if (st != null && rolle != null) {
            AnlageStand stand = anlage(st.siteId(), tag);
            befunde = ZaehlerrolleRegeln.befundeZu(m.kennzeichen(), stand.befunde());
        }
        List<FassungAnsicht> historie = new ArrayList<>();
        List<Fassung> alle = rollen.derMessstelle(id);
        for (Fassung f : alle) {
            historie.add(new FassungAnsicht(f, f.aufgehoben() ? null : bis(eigene, f)));
        }
        return new Ansicht(m, tag, st == null ? null : st.siteId(), rolle == null ? null : aktuell,
                ZaehlerrolleRegeln.festlegungsgroesse(rolle, m.hauptgroesse().richtung()), befunde,
                ZaehlerrolleRegeln.urteil(rolle, befunde), historie);
    }

    /** Die Zähler der Anlage am Tag mit allen Befunden (für das Rechenwerk, MP-8). */
    public AnlageStand anlage(UUID siteId, LocalDate tag) {
        List<Knoten> knoten = knoten(siteId, tag, Map.of(), zuordnungen.stellungenAlle(), rollen.alle());
        Map<String, Knoten> zaehler = new LinkedHashMap<>();
        for (Knoten k : knoten) {
            String g = ZaehlerrolleRegeln.festlegungsgroesse(k.rolle(), k.richtung());
            if (g != null) {
                zaehler.putIfAbsent(g, k);
            }
        }
        return new AnlageStand(siteId, tag, zaehler, knoten, ZaehlerrolleRegeln.befunde(knoten, tag));
    }

    // ---------------------------------------------------------------- setzen

    public void setzen(UUID id, Aendern a, ProtokollAkteur wer) {
        Messstelle m = finde(id);
        if (a == null) {
            throw ZaehlerrolleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        if (a.gueltigAb() == null) {
            throw ZaehlerrolleAbgelehnt.anfrage("gueltig_ab", "„gültig ab“ fehlt (ein Tag, JJJJ-MM-TT).");
        }
        if (m.archiviertAm() != null) {
            throw new ZaehlerrolleAbgelehnt("zustand_passt_nicht", 409,
                    m.kennzeichen() + " ist archiviert. Eine archivierte Messstelle bekommt keine Zählerrolle.",
                    Map.of());
        }
        Angaben neu = new Angaben(a.rolle(), a.zaehlpunkt(), a.messstellenbetreiber(), a.eichstatus(),
                a.eichfristBis(), a.wertequelle());
        ZaehlerrolleRegeln.Ablehnung form = ZaehlerrolleRegeln.formPruefen(neu);
        if (form == null) {
            form = ZaehlerrolleRegeln.passtPruefen(m.art(), m.medium(), m.hauptgroesse().groesse(),
                    m.hauptgroesse().richtung(), neu.rolle());
        }
        if (form != null) {
            throw ZaehlerrolleAbgelehnt.aus(form);
        }
        LocalDate ab = a.gueltigAb();
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        transaktion.executeWithoutResult(tx -> {
            zuordnungen.sperren(tenant);
            List<Fassung> eigene = wirksam(rollen.derMessstelle(id));
            Fassung gleicherTag = eigene.stream().filter(f -> f.gueltigAb().equals(ab)).findFirst().orElse(null);
            List<Fassung> ohne = eigene.stream().filter(f -> f != gleicherTag).toList();
            Fassung vorher = gleicherTag != null ? gleicherTag : amTag(ohne, ab);
            Angaben alt = vorher == null ? new Angaben(null, null, null, null, null, null) : vorher.angaben();
            if (ZaehlerrolleRegeln.gleich(alt, neu)) {
                throw new ZaehlerrolleAbgelehnt("zaehlerrolle_unveraendert", 409,
                        "Ab " + ab + " gilt für " + m.kennzeichen() + " bereits genau diese Zählerrolle.",
                        Map.of("am", ab.toString()));
            }
            if (neu.rolle() != null) {
                LocalDate naechste = ohne.stream().map(Fassung::gueltigAb).filter(d -> d.isAfter(ab))
                        .min(Comparator.naturalOrder()).orElse(null);
                regelnPruefen(m, neu, ab, naechste);
            }
            if (gleicherTag != null) {
                rollen.aufheben(gleicherTag.id(), jetzt);
            }
            rollen.eintragen(tenant, id, neu, ab, wer == null ? null : wer.name());
        });
    }

    private void regelnPruefen(Messstelle m, Angaben neu, LocalDate ab, LocalDate naechste) {
        List<StellungZeile> stellungen = wirksameStellungen(zuordnungen.stellungenAlle());
        List<Fassung> alleRollen = rollen.alle();
        Set<LocalDate> tage = new TreeSet<>();
        tage.add(ab);
        for (StellungZeile s : stellungen) {
            tage.add(s.gueltigAb());
            if (s.gueltigBis() != null) {
                tage.add(s.gueltigBis().plusDays(1));
            }
        }
        for (LocalDate tag : tage) {
            if (tag.isBefore(ab) || (naechste != null && !tag.isBefore(naechste))) {
                continue;
            }
            StellungZeile st = stellungAm(stellungen.stream().filter(s -> s.messstelleId().equals(m.id())).toList(),
                    tag);
            if (st == null) {
                if (tag.equals(ab)) {
                    throw new ZaehlerrolleAbgelehnt("ohne_anlage", 422, m.kennzeichen() + " steht am " + ab
                            + " in keiner Anlage. Eine Zählerrolle braucht die elektrische Stellung der Messstelle.",
                            Map.of("am", ab.toString()));
                }
                continue;
            }
            List<Knoten> knoten = knoten(st.siteId(), tag, Map.of(m.id(), neu), stellungen, alleRollen);
            String groesse = ZaehlerrolleRegeln.festlegungsgroesse(neu.rolle(), m.hauptgroesse().richtung());
            Knoten anderer = ZaehlerrolleRegeln.vergeben(m.id(), groesse, knoten);
            if (anderer != null) {
                throw new ZaehlerrolleAbgelehnt("zaehlerrolle_vergeben", 409, "In dieser Anlage liefert am " + tag
                        + " bereits " + anderer.kennzeichen() + " die Größe " + groesse + ".",
                        Map.of("am", tag.toString(), "groesse", groesse, "messstelle", anderer.kennzeichen()));
            }
            List<Befund> trennung = ZaehlerrolleRegeln.befunde(knoten, tag).stream()
                    .filter(b -> m.kennzeichen().equals(b.messstelle())
                            && ZaehlerrolleRegeln.TRENNUNG.contains(b.code()))
                    .toList();
            if (!trennung.isEmpty()) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("am", tag.toString());
                fakten.put("fundstelle", ZaehlerrolleRegeln.A1_S25);
                fakten.put("befunde", trennung);
                throw new ZaehlerrolleAbgelehnt("zaehler_nicht_getrennt", 422, trennung.get(0).satz(), fakten);
            }
        }
    }

    // ---------------------------------------------------------------- Bausteine

    /**
     * Die Messstellen der Anlage am Tag als Knoten der Regeln; {@code ersatz} setzt für einzelne Messstellen
     * die Angaben einer noch nicht gespeicherten Fassung ein.
     */
    private List<Knoten> knoten(UUID siteId, LocalDate tag, Map<UUID, Angaben> ersatz, List<StellungZeile> stellungen,
            List<Fassung> alleRollen) {
        Map<UUID, Messstelle> jeId = messstellen.alle().stream()
                .collect(Collectors.toMap(Messstelle::id, Function.identity(), (x, y) -> x, LinkedHashMap::new));
        Map<UUID, List<Fassung>> rollenJe = new HashMap<>();
        for (Fassung f : wirksam(alleRollen)) {
            rollenJe.computeIfAbsent(f.messstelleId(), x -> new ArrayList<>()).add(f);
        }
        Map<UUID, Set<String>> rollenDerKomponente = komponentenRollen(siteId);
        ZoneId zone = zone();
        Instant von = tag.atStartOfDay(zone).toInstant();
        Instant bis = tag.plusDays(1).atStartOfDay(zone).toInstant();
        Map<UUID, Set<String>> messobjekt = new HashMap<>();
        for (MessstelleQuelleRepository.Quelle q : quellen.alle()) {
            Messstelle m = jeId.get(q.messstelleId());
            if (m == null || !"fuehrend".equals(q.rolle()) || !m.hauptgroesse().groesse().equals(q.groesse())
                    || !m.hauptgroesse().richtung().equals(q.richtung())) {
                continue;
            }
            if (!q.gueltigAb().isBefore(bis) || (q.gueltigBis() != null && !q.gueltigBis().isAfter(von))) {
                continue;
            }
            messobjekt.computeIfAbsent(m.id(), x -> new LinkedHashSet<>())
                    .addAll(rollenDerKomponente.getOrDefault(q.entityId(), Set.of()));
        }
        List<Knoten> out = new ArrayList<>();
        for (StellungZeile s : wirksameStellungen(stellungen)) {
            if (!s.siteId().equals(siteId) || !s.deckt(tag)) {
                continue;
            }
            Messstelle m = jeId.get(s.messstelleId());
            if (m == null) {
                continue;
            }
            Angaben a = ersatz.containsKey(m.id()) ? ersatz.get(m.id()) : angabenAm(rollenJe.get(m.id()), tag);
            out.add(new Knoten(m.id(), m.kennzeichen(), m.hauptgroesse().richtung(), s.stellung(),
                    s.unterzaehlerVon(), a, Set.copyOf(messobjekt.getOrDefault(m.id(), Set.of()))));
        }
        out.sort(Comparator.comparing(Knoten::kennzeichen));
        return out;
    }

    /** Je Komponente der Anlage die Rollen ihrer Messwerte in der Topologie (leer = keine bekannte). */
    private Map<UUID, Set<String>> komponentenRollen(UUID siteId) {
        Map<UUID, Set<String>> out = new HashMap<>();
        for (TopologyService.EntityTopologyDto e : topologie.topology(siteId).entities()) {
            Set<String> r = new LinkedHashSet<>();
            for (TopologyService.CapabilityDto c : e.capabilities()) {
                if (c.role() != null && !c.role().isBlank()) {
                    r.add(c.role());
                }
            }
            out.put(e.id(), r);
        }
        return out;
    }

    private static Angaben angabenAm(List<Fassung> fassungen, LocalDate tag) {
        Fassung f = fassungen == null ? null : amTag(fassungen, tag);
        return f == null || f.angaben().rolle() == null ? null : f.angaben();
    }

    /** Die Fassung, die am Tag gilt: die letzte mit „gültig ab“ ≤ Tag. */
    private static Fassung amTag(List<Fassung> wirksame, LocalDate tag) {
        Fassung out = null;
        for (Fassung f : wirksame) {
            if (!f.gueltigAb().isAfter(tag) && (out == null || f.gueltigAb().isAfter(out.gueltigAb()))) {
                out = f;
            }
        }
        return out;
    }

    /** Der letzte Tag einer wirksamen Fassung: der Tag vor der nächsten, sonst offen. */
    private static LocalDate bis(List<Fassung> wirksame, Fassung f) {
        return wirksame.stream().map(Fassung::gueltigAb).filter(d -> d.isAfter(f.gueltigAb()))
                .min(Comparator.naturalOrder()).map(d -> d.minusDays(1)).orElse(null);
    }

    private static StellungZeile stellungAm(List<StellungZeile> zeilen, LocalDate tag) {
        return wirksameStellungen(zeilen).stream().filter(s -> s.deckt(tag)).findFirst().orElse(null);
    }

    private static List<StellungZeile> wirksameStellungen(List<StellungZeile> zeilen) {
        return zeilen.stream().filter(z -> !z.aufgehoben()).toList();
    }

    private static List<Fassung> wirksam(List<Fassung> zeilen) {
        return zeilen.stream().filter(f -> !f.aufgehoben()).toList();
    }

    private Messstelle finde(UUID id) {
        return messstellen.finde(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    private ZoneId zone() {
        return unternehmen.desKundenbereichs().map(u -> ZoneId.of(u.zeitzone())).orElse(MessstelleService.ZEITZONE);
    }
}
