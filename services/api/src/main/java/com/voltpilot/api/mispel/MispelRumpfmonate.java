package com.voltpilot.api.mispel;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;

/**
 * MiSpeL MP-21: teilt einen Kalendermonat an bestimmungsrelevanten Änderungen in Rumpfmonate (Anlage 1 S. 102–104,
 * Abschn. 11) — reine Regel, Zwilling in Python ({@code mispel_abgrenzung.rumpfmonate}), Vektoren unter
 * {@code rumpfmonate} in {@code docs/contracts/v2/mispel-abgrenzung-vectors.json}.
 *
 * <p>Ein {@link Stand} beschreibt die Anlage hinter der Einspeise- bzw. Entnahmestelle ab einem Tag: Fallkonstellation
 * (Formelsatz und zugrunde liegender Basisfall; Formelsatz {@code null} = keine Bestimmung nach Anlage 1), Messkonzept
 * (Zähler der Festlegung → Messstelle) und Werte zur Bestimmung (Painst/Pbinst, AW-Regel). Bestimmungsrelevant ist eine
 * Änderung, die die Fallkonstellation, das Messkonzept oder die Werte ändert (A1 S. 102); ein Zählerwechsel ohne neues
 * Messkonzept und Wechsel von Netznutzer, Direktvermarkter oder Personen sind es nicht (A1 S. 103–104). Am Monatsersten
 * entsteht kein Rumpfmonat. Rumpfmonate gibt es nur für Teile, die nach Anlage 1 zu bestimmen sind: „vor und/oder nach“
 * der Änderung, zwei nur, wenn beide Teile zu bestimmen sind (A1 S. 102).
 */
public final class MispelRumpfmonate {

    /** Anlässe nach A1 S. 102–104; die Wirkung entscheidet der Vergleich der Stände, nicht das Wort. */
    public static final Set<String> ANLAESSE = Set.of("speicher_ladepunkt", "erzeugung", "sonstiger_verbrauch",
            "messkonzept", "erstmalige_zuordnung", "wechsel_zuordnung", "zaehlerwechsel", "netznutzer",
            "direktvermarkter", "personell");
    /** Wirkungen, die einen Rumpfmonat begründen (A1 S. 102: Formelsatz/Fallkonstellation, Messkonzept, Werte). */
    public static final Set<String> BESTIMMUNGSRELEVANT = Set.of("fallkonstellation", "messkonzept", "werte");

    private MispelRumpfmonate() {}

    /**
     * Die Anlage ab Tag {@code ab}. {@code zaehler}: Zähler der Festlegung (Z1, Z2, Z3) → Messstelle; {@code werte}:
     * Werte zur Bestimmung als exakter Text (Painst, Pbinst, AW-Regel …).
     */
    public record Stand(LocalDate ab, String anlass, String formelsatz, String basisfall, Map<String, String> zaehler,
            Map<String, String> werte) {
        public Stand {
            Objects.requireNonNull(ab, "ab");
            if (anlass != null && !ANLAESSE.contains(anlass)) {
                throw new MispelAbgrenzungAbgelehnt("vorgaben_ungueltig", "Anlass „" + anlass + "“ ist keiner der "
                        + "Anlässe aus Anlage 1 S. 102–104: " + new java.util.TreeSet<>(ANLAESSE) + ".");
            }
            zaehler = zaehler == null ? Map.of() : Map.copyOf(zaehler);
            werte = werte == null ? Map.of() : Map.copyOf(werte);
        }
    }

    /** Eine Änderung im Monat: ihr Tag, ihr Anlass, was sie ändert und ob sie den Monat teilt. */
    public record Aenderung(LocalDate tag, String anlass, List<String> wirkung, boolean bestimmungsrelevant) {}

    /** Ein Teil des Monats {@code [von, bis)}, der nach Anlage 1 zu bestimmen ist; {@code rumpf} = kein ganzer Monat. */
    public record Rumpfmonat(String schluessel, LocalDate von, LocalDate bis, boolean rumpf, Stand stand) {}

    /** Die Teilung eines Monats: die Teile, die zu bestimmen sind, und jede Änderung im Monat. */
    public record Teilung(YearMonth monat, List<Rumpfmonat> rumpfmonate, List<Aenderung> aenderungen) {}

    /** Schlüssel eines Teils: {@code JJJJ-MM} für den ganzen Monat, {@code JJJJ-MM/T} ab Tag T für einen Rumpfmonat. */
    public static String schluessel(YearMonth monat, LocalDate von, boolean rumpf) {
        return rumpf ? monat + "/" + von.getDayOfMonth() : monat.toString();
    }

    public static Teilung teilen(YearMonth monat, List<Stand> staende) {
        LocalDate erster = monat.atDay(1);
        LocalDate ende = monat.plusMonths(1).atDay(1);
        List<Stand> sortiert = new ArrayList<>(staende);
        sortiert.sort(Comparator.comparing(Stand::ab));
        for (int i = 1; i < sortiert.size(); i++) {
            if (sortiert.get(i).ab().equals(sortiert.get(i - 1).ab())) {
                throw new MispelAbgrenzungAbgelehnt("vorgaben_ungueltig", "Zwei Stände ab " + sortiert.get(i).ab()
                        + " — je Tag gilt genau ein Stand.");
            }
        }
        Stand aktuell = null;
        List<Stand> imMonat = new ArrayList<>();
        for (Stand s : sortiert) {
            if (!s.ab().isAfter(erster)) {
                aktuell = s;
            } else if (s.ab().isBefore(ende)) {
                imMonat.add(s);
            }
        }
        // Teile [von, bis) mit ihrem Stand; eine Änderung ohne bestimmungsrelevante Wirkung teilt nicht.
        List<Aenderung> aenderungen = new ArrayList<>();
        List<LocalDate> grenzen = new ArrayList<>(List.of(erster));
        List<Stand> teile = new ArrayList<>();
        teile.add(aktuell);
        for (Stand s : imMonat) {
            if ("wechsel_zuordnung".equals(s.anlass())) {
                throw new MispelAbgrenzungAbgelehnt("wechsel_nur_zum_monatsersten", "Der Wechsel der Zuordnung "
                        + "bereits zugeordneter Anlagen auf die Abgrenzungsoption geht nur zum ersten Kalendertag eines "
                        + "Kalendermonats (Anlage 1 S. 103; § 21b Abs. 1 S. 2 EEG) — nicht am " + s.ab() + ".");
            }
            List<String> wirkung = wirkung(aktuell, s);
            boolean relevant = wirkung.stream().anyMatch(BESTIMMUNGSRELEVANT::contains);
            aenderungen.add(new Aenderung(s.ab(), s.anlass(), wirkung, relevant));
            if (relevant) {
                grenzen.add(s.ab());
                teile.add(s);
            } else {
                teile.set(teile.size() - 1, s);
            }
            aktuell = s;
        }
        grenzen.add(ende);
        boolean geteilt = teile.size() > 1;
        List<Rumpfmonat> out = new ArrayList<>();
        for (int i = 0; i < teile.size(); i++) {
            Stand s = teile.get(i);
            if (s == null || s.formelsatz() == null) {
                continue;
            }
            LocalDate von = grenzen.get(i);
            out.add(new Rumpfmonat(schluessel(monat, von, geteilt), von, grenzen.get(i + 1), geteilt, s));
        }
        return new Teilung(monat, List.copyOf(out), List.copyOf(aenderungen));
    }

    /** Was sich zwischen zwei Ständen ändert, in fester Reihenfolge; {@code vorher == null} = nichts bekannt. */
    static List<String> wirkung(Stand vorher, Stand nachher) {
        List<String> w = new ArrayList<>();
        String fsVorher = vorher == null ? null : vorher.formelsatz();
        String bfVorher = vorher == null ? null : vorher.basisfall();
        if (!Objects.equals(fsVorher, nachher.formelsatz()) || !Objects.equals(bfVorher, nachher.basisfall())) {
            w.add("fallkonstellation");
        }
        Map<String, String> zVorher = vorher == null ? Map.of() : vorher.zaehler();
        if (!zVorher.keySet().equals(nachher.zaehler().keySet())) {
            w.add("messkonzept");
        } else if (!zVorher.equals(nachher.zaehler())) {
            w.add("zaehlerwechsel");
        }
        if (!new TreeMap<>(vorher == null ? Map.of() : vorher.werte()).equals(new TreeMap<>(nachher.werte()))) {
            w.add("werte");
        }
        return List.copyOf(w);
    }
}
