package com.voltpilot.api.uems;

import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaecheAmTag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaecheQuelle;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaechenIntervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ort;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import com.voltpilot.api.web.dto.FaktorenVorschlagDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.sql.Date;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Der Vorschlag der statischen Faktoren einer Kennzahl (UEMS AP-17 IP-16a, V3, E6 = A): aus der Struktur ihrer
 * Geltung am Stichtag — Fläche (je Objekt und als Summe), Standorte, Anlagen, Prozesse (eine Ebene), Kostenstellen.
 * Vertrag: {@code docs/contracts/v2/bezugsbasis.md} §14.
 *
 * <p><b>Nur lesen.</b> Nichts wird gespeichert, nichts geändert: die Liste an der Fassung mit der Kopie zum
 * Freigabetag und der Anstoß {@code struktur_geaendert} kommen mit IP-16b. Die Fläche kommt aus derselben Ableitung
 * wie jede Bezugsfläche ({@link OrtsbaumAbleitung#flaecheAm}); ein Objekt ohne Gültigkeit am Stichtag entfällt, eine
 * fehlende Fläche ist nie 0.
 *
 * <p><b>Die Struktur der Geltung</b> sind die Orte der Geltung und die Messstellen, die am Stichtag darin liegen
 * (Unternehmen: alle; Standort, Gebäude, Bereich: über die Verortung; Prozess: der Prozess und seine Unterprozesse;
 * Kostenstelle: über die Verteilung; Messstelle: sie selbst). Über diese Messstellen kommen Anlagen, Prozesse und
 * Kostenstellen dazu — je am Stichtag wirksam, tagesgenau einschließlich des letzten Tags.
 *
 * <p><b>Zaun über die Kennzahl:</b> {@link KennzahlService#eine} — eine Kennzahl, die der Aufrufer nicht ganz sieht,
 * ist 404; die Zeilen der Struktur schneidet RLS auf den Kundenbereich.
 */
@Service
public class FaktorenVorschlag {

    static final String EINHEIT = "m²";

    static final String PARAMETER = "stichtag";

    private static final String WIRKSAM =
            " WHERE aufgehoben_am IS NULL AND daterange(gueltig_ab, gueltig_bis, '[]') @> ?::date";

    private final KennzahlService kennzahlen;
    private final KennzahlRepository repo;
    private final StandortLesemodellService lesemodell;
    private final JdbcTemplate jdbc;

    public FaktorenVorschlag(KennzahlService kennzahlen, KennzahlRepository repo, StandortLesemodellService lesemodell,
            JdbcTemplate jdbc) {
        this.kennzahlen = kennzahlen;
        this.repo = repo;
        this.lesemodell = lesemodell;
        this.jdbc = jdbc;
    }

    private record Stammobjekt(UUID id, String kennzeichen, String name, UUID eltern, LocalDate ab, LocalDate bis) {

        boolean gilt(LocalDate tag) {
            return !ab.isAfter(tag) && (bis == null || !tag.isAfter(bis));
        }
    }

    private record Verortung(UUID messstelle, String standort, String gebaeude, String ort) {}

    /** Der Vorschlag am {@code stichtag} (JJJJ-MM-TT; ohne: heute in der Zeitzone der Kennzahl). */
    public FaktorenVorschlagDto.Vorschlag vorschlag(UUID id, Collection<String> parameter, String stichtag) {
        KennzahlDto.Kennzahl kz = kennzahlen.eine(id);
        KennzahlRepository.Zeile k = repo.finde(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        for (String p : parameter) {
            if (!PARAMETER.equals(p)) {
                throw KennzahlAbgelehnt.anfrage(p);
            }
        }
        LocalDate tag = stichtag == null ? LocalDate.now(kennzahlen.zone(k, kennzahlen.jetzt())) : tag(stichtag);

        Zeilen z = lesemodell.zeilen();
        Ortsbaum baum = StandortLesemodell.baum(z);
        Map<String, String[]> namen = namen(z);
        String art = k.geltungArt();
        String geltung = k.geltungId() == null ? null : k.geltungId().toString();

        List<Verortung> verortet = verortung(baum, tag);
        List<Stammobjekt> prozesse = prozesse();
        Set<UUID> prozessKreis = new LinkedHashSet<>();
        if ("prozess".equals(art)) {
            prozessKreis.add(k.geltungId());
            prozesse.stream().filter(p -> k.geltungId().equals(p.eltern())).forEach(p -> prozessKreis.add(p.id()));
        }
        Set<UUID> messstellen = messstellen(art, k.geltungId(), geltung, verortet, prozessKreis, tag);

        List<FaktorenVorschlagDto.Faktor> faktoren = new ArrayList<>();
        List<String> flaechenObjekte = new ArrayList<>();
        List<String> ohneFlaeche = new ArrayList<>();
        LocalDate[] summeGilt = {null, null};
        int summe = 0;
        for (String o : flaechenOrte(baum, art, geltung, verortet, messstellen, tag, namen)) {
            FlaecheAmTag f = OrtsbaumAbleitung.flaecheAm(baum, o, tag);
            String[] n = namen.get(o);
            if (f.flaecheM2() == null) {
                ohneFlaeche.add(n[0]);
                continue;
            }
            LocalDate[] gilt = flaecheGilt(baum, o, f, tag);
            summeGilt = schnitt(summeGilt, gilt);
            summe += f.flaecheM2();
            flaechenObjekte.add(n[0]);
            faktoren.add(new FaktorenVorschlagDto.Faktor("flaeche", UUID.fromString(o), n[0], n[1], f.flaecheM2(),
                    EINHEIT, gilt[0], gilt[1], "Fläche " + n[1] + " (" + n[0] + "): "
                            + OrtsbaumAbleitung.m2Text(f.flaecheM2()) + " am " + OrtsbaumAbleitung.datumText(tag) + " · "
                            + gueltigText(gilt) + "."));
        }

        for (String s : standorte(baum, art, geltung, verortet, messstellen, tag, namen)) {
            Intervall iv = OrtsbaumAbleitung.intervallAm(baum.ort(s).orElseThrow().intervalle(), tag);
            String[] n = namen.get(s);
            faktoren.add(verweis("standort", UUID.fromString(s), n[0], n[1], iv.ab(), iv.bis()));
        }

        for (OrtsbaumAbleitung.Anlage a : anlagen(baum, art, geltung, messstellen, tag)) {
            Intervall iv = OrtsbaumAbleitung.intervallAm(a.zuordnungen(), tag);
            faktoren.add(verweis("anlage", UUID.fromString(a.kennzeichen()), null, a.name(), iv.ab(), iv.bis()));
        }

        Set<UUID> prozessIds = switch (art) {
            case "unternehmen" -> ids(prozesse);
            case "prozess" -> prozessKreis;
            default -> zugeordnet("messstelle_prozess", "prozess_id", messstellen, tag);
        };
        stammobjekte(prozesse, prozessIds, tag)
                .forEach(p -> faktoren.add(verweis("prozess", p.id(), p.kennzeichen(), p.name(), p.ab(), p.bis())));

        List<Stammobjekt> kostenstellen = kostenstellen();
        Set<UUID> kostenstelleIds = switch (art) {
            case "unternehmen" -> ids(kostenstellen);
            case "kostenstelle" -> Set.of(k.geltungId());
            default -> zugeordnet("messstelle_verteilung", "kostenstelle_id", messstellen, tag);
        };
        stammobjekte(kostenstellen, kostenstelleIds, tag).forEach(
                c -> faktoren.add(verweis("kostenstelle", c.id(), c.kennzeichen(), c.name(), c.ab(), c.bis())));

        return new FaktorenVorschlagDto.Vorschlag(kz.id(), kz.kennzeichen(), kz.geltungArt(), kz.geltungId(),
                kz.geltungName(), tag, List.copyOf(faktoren),
                summe(flaechenObjekte, ohneFlaeche, summe, summeGilt, tag),
                "Vorschlag aus der Struktur am " + OrtsbaumAbleitung.datumText(tag) + " — nichts ist gespeichert. "
                        + "Statische Faktoren gelten erst mit der Bezugsbasis, die Sie freigeben.");
    }

    // ------------------------------------------------------------------------------ Struktur der Geltung

    /** Wo jede Messstelle am Stichtag verortet ist: Standort, Gebäude (ein Bereich zählt zu seinem) und Ort. */
    private List<Verortung> verortung(Ortsbaum baum, LocalDate tag) {
        return jdbc.query("SELECT messstelle_id, standort_id, ort_id FROM messstelle_ort" + WIRKSAM, (rs, i) -> {
            UUID ms = rs.getObject("messstelle_id", UUID.class);
            UUID st = rs.getObject("standort_id", UUID.class);
            UUID ort = rs.getObject("ort_id", UUID.class);
            if (ort == null) {
                return new Verortung(ms, st == null ? null : st.toString(), null, null);
            }
            String o = ort.toString();
            return new Verortung(ms, OrtsbaumAbleitung.pfadAm(baum, o, tag).standort(), gebaeudeVon(baum, o, tag), o);
        }, Date.valueOf(tag));
    }

    private static String gebaeudeVon(Ortsbaum baum, String ort, LocalDate tag) {
        Ort o = baum.ort(ort).orElse(null);
        if (o == null || o.art() == OrtArt.STANDORT) {
            return null;
        }
        if (o.art() == OrtArt.GEBAEUDE) {
            return ort;
        }
        Intervall iv = OrtsbaumAbleitung.intervallAm(o.intervalle(), tag);
        Ort eltern = iv == null ? null : baum.ort(iv.eltern()).orElse(null);
        return eltern != null && eltern.art() == OrtArt.GEBAEUDE ? eltern.kennzeichen() : null;
    }

    private Set<UUID> messstellen(String art, UUID geltungId, String geltung, List<Verortung> verortet,
            Set<UUID> prozessKreis, LocalDate tag) {
        Set<UUID> aus = new LinkedHashSet<>();
        switch (art) {
            case "unternehmen" -> verortet.forEach(v -> aus.add(v.messstelle()));
            case "standort" -> verortet.stream().filter(v -> geltung.equals(v.standort())).forEach(v -> aus.add(v.messstelle()));
            case "gebaeude" -> verortet.stream().filter(v -> geltung.equals(v.gebaeude())).forEach(v -> aus.add(v.messstelle()));
            case "bereich" -> verortet.stream().filter(v -> geltung.equals(v.ort())).forEach(v -> aus.add(v.messstelle()));
            case "messstelle" -> aus.add(geltungId);
            case "prozess" -> jdbc.query("SELECT messstelle_id, prozess_id FROM messstelle_prozess" + WIRKSAM, rs -> {
                if (prozessKreis.contains(rs.getObject("prozess_id", UUID.class))) {
                    aus.add(rs.getObject("messstelle_id", UUID.class));
                }
            }, Date.valueOf(tag));
            case "kostenstelle" -> jdbc.query("SELECT messstelle_id, kostenstelle_id FROM messstelle_verteilung" + WIRKSAM,
                    rs -> {
                        if (geltungId.equals(rs.getObject("kostenstelle_id", UUID.class))) {
                            aus.add(rs.getObject("messstelle_id", UUID.class));
                        }
                    }, Date.valueOf(tag));
            default -> { }
        }
        return aus;
    }

    /**
     * Die Orte, deren Fläche ein Faktor sein kann: im Unternehmen die Standorte, am Standort seine Gebäude (ohne
     * Gebäude er selbst), ein Gebäude oder Bereich selbst; bei Prozess, Kostenstelle und Messstelle die Gebäude, in
     * denen ihre Messstellen liegen. Nur Orte, die es am Stichtag gibt.
     */
    private static List<String> flaechenOrte(Ortsbaum baum, String art, String geltung, List<Verortung> verortet,
            Set<UUID> messstellen, LocalDate tag, Map<String, String[]> namen) {
        List<String> aus = switch (art) {
            case "unternehmen" -> orte(baum, OrtArt.STANDORT, null, tag);
            case "standort" -> {
                List<String> gebaeude = orte(baum, OrtArt.GEBAEUDE, geltung, tag);
                yield gebaeude.isEmpty() ? List.of(geltung) : gebaeude;
            }
            case "gebaeude", "bereich" -> List.of(geltung);
            default -> verortet.stream().filter(v -> messstellen.contains(v.messstelle()))
                    .map(Verortung::gebaeude).filter(Objects::nonNull).distinct().toList();
        };
        return sortiert(aus.stream().filter(o -> vorhanden(baum, o, tag)).toList(), namen);
    }

    private static List<String> standorte(Ortsbaum baum, String art, String geltung, List<Verortung> verortet,
            Set<UUID> messstellen, LocalDate tag, Map<String, String[]> namen) {
        List<String> aus = switch (art) {
            case "unternehmen" -> orte(baum, OrtArt.STANDORT, null, tag);
            case "standort" -> List.of(geltung);
            case "gebaeude", "bereich" -> {
                String st = OrtsbaumAbleitung.pfadAm(baum, geltung, tag).standort();
                yield st == null ? List.of() : List.of(st);
            }
            default -> verortet.stream().filter(v -> messstellen.contains(v.messstelle()))
                    .map(Verortung::standort).filter(Objects::nonNull).distinct().toList();
        };
        return sortiert(aus.stream().filter(o -> vorhanden(baum, o, tag)).toList(), namen);
    }

    /** Die Anlagen der Messstellen (Stellung am Stichtag); im Unternehmen und am Standort auch die dort zugeordneten. */
    private List<OrtsbaumAbleitung.Anlage> anlagen(Ortsbaum baum, String art, String geltung, Set<UUID> messstellen,
            LocalDate tag) {
        Set<String> ids = new LinkedHashSet<>();
        zugeordnet("messstelle_stellung", "site_id", messstellen, tag).forEach(s -> ids.add(s.toString()));
        return baum.anlagen().stream()
                .filter(a -> {
                    Intervall iv = OrtsbaumAbleitung.intervallAm(a.zuordnungen(), tag);
                    if (iv == null || !vorhanden(baum, iv.eltern(), tag)) {
                        return false;
                    }
                    return ids.contains(a.kennzeichen()) || "unternehmen".equals(art)
                            || ("standort".equals(art) && geltung.equals(iv.eltern()));
                })
                .sorted(Comparator.comparing(OrtsbaumAbleitung.Anlage::name))
                .toList();
    }

    /** Die Ziele ({@code spalte}) der am Stichtag wirksamen Zuordnungen dieser Messstellen. */
    private Set<UUID> zugeordnet(String tabelle, String spalte, Set<UUID> messstellen, LocalDate tag) {
        Set<UUID> aus = new LinkedHashSet<>();
        if (messstellen.isEmpty()) {
            return aus;
        }
        jdbc.query("SELECT messstelle_id, " + spalte + " FROM " + tabelle + WIRKSAM, rs -> {
            if (messstellen.contains(rs.getObject("messstelle_id", UUID.class))) {
                aus.add(rs.getObject(spalte, UUID.class));
            }
        }, Date.valueOf(tag));
        return aus;
    }

    private List<Stammobjekt> prozesse() {
        return jdbc.query("SELECT id, kennzeichen, name, eltern_id, gueltig_ab, gueltig_bis FROM prozess",
                (rs, i) -> new Stammobjekt(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                        rs.getString("name"), rs.getObject("eltern_id", UUID.class),
                        rs.getObject("gueltig_ab", LocalDate.class), rs.getObject("gueltig_bis", LocalDate.class)));
    }

    private List<Stammobjekt> kostenstellen() {
        return jdbc.query("SELECT id, kennzeichen, name, gueltig_ab, gueltig_bis FROM kostenstelle",
                (rs, i) -> new Stammobjekt(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                        rs.getString("name"), null, rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class)));
    }

    private static List<Stammobjekt> stammobjekte(List<Stammobjekt> alle, Set<UUID> ids, LocalDate tag) {
        return alle.stream().filter(o -> ids.contains(o.id()) && o.gilt(tag))
                .sorted(Comparator.comparing(Stammobjekt::kennzeichen)).toList();
    }

    private static Set<UUID> ids(List<Stammobjekt> alle) {
        Set<UUID> aus = new LinkedHashSet<>();
        alle.forEach(o -> aus.add(o.id()));
        return aus;
    }

    // ------------------------------------------------------------------------------ Ortsbaum

    private static List<String> orte(Ortsbaum baum, OrtArt art, String eltern, LocalDate tag) {
        return baum.orte().stream().filter(o -> o.art() == art).filter(o -> {
            Intervall iv = OrtsbaumAbleitung.intervallAm(o.intervalle(), tag);
            return iv != null && (eltern == null || eltern.equals(iv.eltern()));
        }).map(Ort::kennzeichen).toList();
    }

    private static boolean vorhanden(Ortsbaum baum, String ort, LocalDate tag) {
        return ort != null && baum.ort(ort).map(o -> OrtsbaumAbleitung.intervallAm(o.intervalle(), tag) != null)
                .orElse(false);
    }

    /** Die Gültigkeit einer Fläche: ihr Intervall; aus Gebäuden summiert der Schnitt der Gebäude-Intervalle. */
    private static LocalDate[] flaecheGilt(Ortsbaum baum, String ort, FlaecheAmTag f, LocalDate tag) {
        if (f.flaecheQuelle() == FlaecheQuelle.EIGEN) {
            return intervall(baum.ort(ort).orElseThrow(), tag);
        }
        LocalDate[] gilt = {null, null};
        for (String g : orte(baum, OrtArt.GEBAEUDE, ort, tag)) {
            gilt = schnitt(gilt, intervall(baum.ort(g).orElseThrow(), tag));
        }
        return gilt;
    }

    private static LocalDate[] intervall(Ort o, LocalDate tag) {
        FlaechenIntervall iv = o.flaechen().stream().filter(x -> x.deckt(tag)).findFirst().orElseThrow();
        return new LocalDate[] {iv.ab(), iv.bis()};
    }

    private static LocalDate[] schnitt(LocalDate[] a, LocalDate[] b) {
        LocalDate ab = a[0] == null || b[0].isAfter(a[0]) ? b[0] : a[0];
        LocalDate bis = a[1] == null ? b[1] : b[1] == null || a[1].isBefore(b[1]) ? a[1] : b[1];
        return new LocalDate[] {ab, bis};
    }

    /** Kennung und Name je Schlüssel des Ortsbaums (Standort, Gebäude, Bereich). */
    private static Map<String, String[]> namen(Zeilen z) {
        Map<String, String[]> aus = new HashMap<>();
        z.standorte().forEach(s -> aus.put(s.id().toString(), new String[] {s.kurzzeichen(), s.name()}));
        z.orte().forEach(o -> aus.put(o.id().toString(), new String[] {o.kurzzeichen(), o.name()}));
        return aus;
    }

    private static List<String> sortiert(List<String> orte, Map<String, String[]> namen) {
        return orte.stream().sorted(Comparator.comparing((String o) -> namen.get(o)[0])).toList();
    }

    // ------------------------------------------------------------------------------ Sätze

    private static FaktorenVorschlagDto.Faktor verweis(String art, UUID id, String kennung, String name, LocalDate ab,
            LocalDate bis) {
        String wort = switch (art) {
            case "standort" -> "Standort";
            case "anlage" -> "Anlage";
            case "prozess" -> "Prozess";
            default -> "Kostenstelle";
        };
        return new FaktorenVorschlagDto.Faktor(art, id, kennung, name, null, null, ab, bis,
                wort + " " + name + (kennung == null ? "" : " (" + kennung + ")") + " · "
                        + gueltigText(new LocalDate[] {ab, bis}) + " · Verweis ohne Zahl.");
    }

    private static FaktorenVorschlagDto.FlaecheDerGeltung summe(List<String> objekte, List<String> ohne, int summe,
            LocalDate[] gilt, LocalDate tag) {
        String am = "Fläche der Geltung am " + OrtsbaumAbleitung.datumText(tag) + ": ";
        if (!ohne.isEmpty()) {
            return new FaktorenVorschlagDto.FlaecheDerGeltung(null, EINHEIT, List.copyOf(objekte), List.copyOf(ohne),
                    null, null, am + "keine Summe — für " + String.join(", ", ohne)
                            + " ist an diesem Tag keine Fläche eingetragen.");
        }
        if (objekte.isEmpty()) {
            return new FaktorenVorschlagDto.FlaecheDerGeltung(null, EINHEIT, List.of(), List.of(), null, null,
                    am + "in der Geltung liegt an diesem Tag kein Ort mit Fläche.");
        }
        return new FaktorenVorschlagDto.FlaecheDerGeltung(summe, EINHEIT, List.copyOf(objekte), List.of(), gilt[0],
                gilt[1], am + OrtsbaumAbleitung.m2Text(summe) + " (" + (objekte.size() == 1 ? objekte.get(0)
                        : "Summe aus " + String.join(", ", objekte)) + ") · " + gueltigText(gilt) + ".");
    }

    private static String gueltigText(LocalDate[] gilt) {
        return gilt[1] == null ? "gültig ab " + OrtsbaumAbleitung.datumText(gilt[0])
                : "gültig " + OrtsbaumAbleitung.datumText(gilt[0]) + " bis " + OrtsbaumAbleitung.datumText(gilt[1]);
    }

    private static LocalDate tag(String text) {
        try {
            return LocalDate.parse(text);
        } catch (DateTimeParseException e) {
            throw KennzahlAbgelehnt.anfrage(PARAMETER);
        }
    }
}
