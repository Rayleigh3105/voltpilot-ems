package com.voltpilot.api.uems;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.OrtZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.uems.OrtRepository.Ort;
import com.voltpilot.api.uems.OrtZuordnungRepository.Zuordnung;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.StandorteAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.ZugeordneteAnlage;
import com.voltpilot.api.web.dto.SiteDto;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die Versorgung eines Gebäudes am Stichtag (UEMS AP-10 IP-17/F15): eine reine Sicht aus dem
 * wirksamen Ort und der wirksamen elektrischen Stellung jeder Messstelle. Es gibt kein gepflegtes
 * Versorgungsfeld. Ein Ort außerhalb eines Gebäudes bleibt sichtbar; ein Gebäude ohne solche
 * Messstelle ist {@code messbar = false}, nie vermeintlich mit 0 versorgt.
 */
@Service
public class VersorgungService {

    public record Bezug(UUID id, String kennzeichen, String name) {}

    public record AnlageBezug(UUID id, String name, String netzanschlussKennzeichen) {}

    public record MessstelleBezug(String kennzeichen, String name) {}

    public record SystemVersorgung(AnlageBezug anlage, List<MessstelleBezug> messstellen) {}

    public record GebaeudeVersorgung(Bezug gebaeude, boolean messbar, List<SystemVersorgung> systeme) {}

    public record AusserhalbGebaeude(MessstelleBezug messstelle, AnlageBezug anlage) {}

    public record Versorgung(LocalDate stichtag, Bezug standort, List<GebaeudeVersorgung> gebaeude,
            List<AusserhalbGebaeude> ausserhalbGebaeude) {}

    private final StandortLesemodellService standorte;
    private final OrtRepository orte;
    private final OrtZuordnungRepository ortZuordnungen;
    private final MessstelleRepository messstellen;
    private final MessstelleZuordnungRepository messstelleZuordnungen;
    private final SiteRepository anlagen;

    public VersorgungService(StandortLesemodellService standorte, OrtRepository orte,
            OrtZuordnungRepository ortZuordnungen, MessstelleRepository messstellen,
            MessstelleZuordnungRepository messstelleZuordnungen, SiteRepository anlagen) {
        this.standorte = standorte;
        this.orte = orte;
        this.ortZuordnungen = ortZuordnungen;
        this.messstellen = messstellen;
        this.messstelleZuordnungen = messstelleZuordnungen;
        this.anlagen = anlagen;
    }

    /** Leer heißt: der Standort ist durch den Mandantenzaun nicht sichtbar (Route: 404, nie 403). */
    public Optional<Versorgung> versorgung(UUID standortId, LocalDate stichtag) {
        StandorteAmStichtag stand = standorte.standorte(stichtag);
        LocalDate tag = stand.stichtag();
        StandortAmStichtag standort = beide(stand).stream()
                .filter(s -> s.id().equals(standortId))
                .findFirst().orElse(null);
        if (standort == null) {
            return Optional.empty();
        }

        List<Ort> ortListe = orte.alle();
        Map<UUID, Ort> ortJeId = new LinkedHashMap<>();
        ortListe.forEach(o -> ortJeId.put(o.id(), o));
        Map<UUID, Zuordnung> eltern = wirksameEltern(tag);

        List<Ort> gebaeude = ortListe.stream()
                .filter(o -> "gebaeude".equals(o.art()))
                .filter(o -> standortId.equals(wurzelStandort(o.id(), eltern)))
                .toList();
        Map<UUID, Map<UUID, List<MessstelleBezug>>> jeGebaeude = new LinkedHashMap<>();
        gebaeude.forEach(g -> jeGebaeude.put(g.id(), new LinkedHashMap<>()));

        Map<UUID, StellungZeile> stellung = wirksameStellungen(tag);
        Map<UUID, OrtZeile> ort = wirksameMessstellenOrte(tag);
        Map<UUID, SiteDto> anlageJeId = new LinkedHashMap<>();
        anlagen.findAll().forEach(a -> anlageJeId.put(a.id(), a));
        Map<UUID, String> netzanschluss = new LinkedHashMap<>();
        for (ZugeordneteAnlage a : standort.anlagen()) {
            if (a.netzanschluss() != null) {
                netzanschluss.put(a.id(), a.netzanschluss().kennzeichen());
            }
        }

        List<AusserhalbGebaeude> ausserhalb = new ArrayList<>();
        for (Messstelle m : messstellen.alle()) {
            StellungZeile s = stellung.get(m.id());
            OrtZeile o = ort.get(m.id());
            if (s == null || o == null || "keine".equals(s.stellung())) {
                continue;
            }
            UUID wurzel = wurzelStandort(o, eltern);
            if (!standortId.equals(wurzel)) {
                continue;
            }
            AnlageBezug anlage = anlage(s.siteId(), anlageJeId, netzanschluss);
            MessstelleBezug messstelle = new MessstelleBezug(m.kennzeichen(), m.name());
            UUID gebaeudeId = gebaeude(o, ortJeId, eltern);
            if (gebaeudeId == null) {
                ausserhalb.add(new AusserhalbGebaeude(messstelle, anlage));
            } else {
                jeGebaeude.get(gebaeudeId).computeIfAbsent(s.siteId(), k -> new ArrayList<>()).add(messstelle);
            }
        }

        List<GebaeudeVersorgung> antwort = new ArrayList<>();
        for (Ort g : gebaeude) {
            List<SystemVersorgung> systeme = new ArrayList<>();
            jeGebaeude.get(g.id()).forEach((anlageId, ms) -> systeme.add(
                    new SystemVersorgung(anlage(anlageId, anlageJeId, netzanschluss), List.copyOf(ms))));
            systeme.sort(Comparator.comparing(x -> x.anlage().name()));
            antwort.add(new GebaeudeVersorgung(new Bezug(g.id(), g.kurzzeichen(), g.name()),
                    !systeme.isEmpty(), List.copyOf(systeme)));
        }
        Bezug st = new Bezug(standort.id(), standort.kurzzeichen(), standort.name());
        return Optional.of(new Versorgung(tag, st, List.copyOf(antwort), List.copyOf(ausserhalb)));
    }

    private static List<StandortAmStichtag> beide(StandorteAmStichtag stand) {
        List<StandortAmStichtag> out = new ArrayList<>(stand.standorte());
        out.addAll(stand.nichtGezeigt());
        return out;
    }

    private Map<UUID, Zuordnung> wirksameEltern(LocalDate tag) {
        Map<UUID, Zuordnung> out = new LinkedHashMap<>();
        ortZuordnungen.alle().stream().filter(z -> !z.aufgehoben() && deckt(z.gueltigAb(), z.gueltigBis(), tag))
                .forEach(z -> out.put(z.ortId(), z));
        return out;
    }

    private Map<UUID, StellungZeile> wirksameStellungen(LocalDate tag) {
        Map<UUID, StellungZeile> out = new LinkedHashMap<>();
        messstelleZuordnungen.stellungenAlle().stream().filter(z -> !z.aufgehoben() && z.deckt(tag))
                .forEach(z -> out.put(z.messstelleId(), z));
        return out;
    }

    private Map<UUID, OrtZeile> wirksameMessstellenOrte(LocalDate tag) {
        Map<UUID, OrtZeile> out = new LinkedHashMap<>();
        messstelleZuordnungen.orteAlle().stream().filter(z -> !z.aufgehoben() && z.deckt(tag))
                .forEach(z -> out.put(z.messstelleId(), z));
        return out;
    }

    private static AnlageBezug anlage(UUID id, Map<UUID, SiteDto> anlagen, Map<UUID, String> netzanschluss) {
        SiteDto a = anlagen.get(id);
        return new AnlageBezug(id, a == null ? id.toString() : a.name(), netzanschluss.get(id));
    }

    private static UUID gebaeude(OrtZeile ort, Map<UUID, Ort> orte, Map<UUID, Zuordnung> eltern) {
        if ("standort".equals(ort.zielArt()) || "unternehmen".equals(ort.zielArt())) {
            return null;
        }
        UUID id = ort.zielId();
        while (id != null) {
            Ort o = orte.get(id);
            if (o != null && "gebaeude".equals(o.art())) {
                return id;
            }
            Zuordnung z = eltern.get(id);
            id = z == null ? null : z.elternOrtId();
        }
        return null;
    }

    private static UUID wurzelStandort(OrtZeile ort, Map<UUID, Zuordnung> eltern) {
        if ("unternehmen".equals(ort.zielArt())) {
            return null;
        }
        if ("standort".equals(ort.zielArt())) {
            return ort.zielId();
        }
        return wurzelStandort(ort.zielId(), eltern);
    }

    private static UUID wurzelStandort(UUID ortId, Map<UUID, Zuordnung> eltern) {
        UUID id = ortId;
        while (id != null) {
            Zuordnung z = eltern.get(id);
            if (z == null) {
                return null;
            }
            if (z.elternStandortId() != null) {
                return z.elternStandortId();
            }
            id = z.elternOrtId();
        }
        return null;
    }

    private static boolean deckt(LocalDate ab, LocalDate bis, LocalDate tag) {
        return !ab.isAfter(tag) && (bis == null || !tag.isAfter(bis));
    }
}
