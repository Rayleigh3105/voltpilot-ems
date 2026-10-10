package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Welcher Posten einer Kostenstelle ist in welchem anderen bereits enthalten (Captain-Entscheid 14.09.2026: „Warnen —
 * die Sicht sagt, welcher Posten in welchem enthalten ist, und ändert keine Zahl.“) — als reine Regel.
 *
 * <p><b>Keine Zahl ändert sich.</b> Die Regel liest dieselben Quellen wie {@link KostenstelleEnergieRegeln#energie} und
 * gibt NUR Warnungen zurück: kein Posten wird ausgelassen, keine Summe bereinigt, keine Zuordnung verweigert. Wer
 * bewusst Aggregat und Teile an derselben Kostenstelle sehen will, sieht beides — und den Satz, dass die Summe es
 * doppelt zählt.
 *
 * <p><b>Aus den Formeln, je Tag, rekursiv:</b> eine berechnete Messstelle enthält die Messstellen ihrer Terme und — in
 * der Abhängigkeitsordnung {@link BerechnetePeriode#reihenfolge} — alles, was diese enthalten. Die Verteilung wirkt je
 * Tag (E12), also auch die Überdeckung: ein Posten ist an einem Tag in einem anderen enthalten, wenn beide an DIESEM Tag
 * eine Zeile an die Kostenstelle haben und die Formel des Tages ihn trägt. Ein Kreis wird nicht aufgelöst, sondern
 * benannt ({@link BerechnetePeriode#FORMEL_KREIS}, {@link BerechnetePeriode#HAENGT_AN_KREIS}).
 *
 * <p><b>Anteile (bewusst entschieden):</b> die Warnung nennt nie eine Menge — eine „doppelt gezählte“ Zahl wäre eine
 * zweite Rechnung und damit eine Korrektur in Verkleidung. Sie sagt, ob der Posten GANZ oder ZUM TEIL enthalten ist.
 * Enthalten ist der Anteil des Postens an der Kostenstelle, gemessen am Anteil der Summe daran: geht die Summe zu
 * {@code a} % an die Kostenstelle und trägt ihre Formel den Posten mit dem Beitrag {@code c} (Vorzeichen × Faktor, über
 * jede Stufe multipliziert), ist er ganz enthalten, wenn {@code a/100 × c ≥ 1}, sonst zum Teil. Drei Folgen:
 * <ul>
 *   <li>ein Term „Anteil 4100 von MS-07“ trägt GENAU den Posten MS-07 an 4100 ({@code c = 1}); ein Term „Anteil 4200
 *       von MS-07“ trägt einen ANDEREN Teil von MS-07 und überdeckt den Posten an 4100 nicht;</li>
 *   <li>ein abgezogener Term (Vorzeichen −, beim Rest Abfluss und zugeordnet) ist nicht enthalten, sondern abgezogen —
 *       die Summe zählt ihn nicht doppelt;</li>
 *   <li>ein Term, der nur den positiven oder negativen Teil eines Messwerts liest, trägt den Posten höchstens zum
 *       Teil.</li>
 * </ul>
 *
 * <p><b>Die Einrichtung zählt, nicht der Wert von heute:</b> ein Term ohne Menge (etwa {@code
 * verteilung_nicht_gespeichert}) ist trotzdem enthalten — „fehlt“ ist nicht „nicht enthalten“, und sobald der Wert
 * kommt, zählt die Summe doppelt. Ein Messkanal-Term ist keine Messstelle und damit kein Posten.
 *
 * <p>Die EINE Wahrheit steht in {@code docs/contracts/v2/verteilung-vectors.json} (Regel {@code doppelzaehlung}, Sätze
 * {@code doppelt_*}). Kein TS-Zwilling: die Sicht wird serverseitig gebildet ({@code zwillinge_grund}).
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class KostenstelleDoppelzaehlung {

    private KostenstelleDoppelzaehlung() {}

    public static final String GANZ = "ganz";
    public static final String TEILWEISE = "teilweise";

    /** Der Umfang einer Überdeckung — geschlossen. */
    public static final List<String> UMFAENGE = List.of(GANZ, TEILWEISE);

    public static final String SATZ_ENTHALTEN = "{teil} ist bereits in {summe} enthalten";
    public static final String SATZ_ENTHALTEN_TEILWEISE = "{teil} ist zum Teil bereits in {summe} enthalten";
    public static final String SATZ_KREIS =
            "Ob {messstelle} einen anderen Posten enthält, ist nicht prüfbar: ihre Formel führt im Kreis ({kette})";
    public static final String SATZ_HAENGT_AN_KREIS =
            "Ob {messstelle} einen anderen Posten enthält, ist nicht prüfbar: sie baut auf einer Formel auf, die im "
                    + "Kreis führt ({kette})";

    /** Die Kette in einem Satz: „MS-20 → MS-23 → MS-20“. */
    public static final String KETTE_TRENNER = " → ";

    public static final String VORZEICHEN_MINUS = "-";
    public static final String ANTEIL_GESAMT = "gesamt";

    private static final BigDecimal EINS = BigDecimal.ONE;

    // ------------------------------------------------------------------------------- Eingang

    /**
     * Ein Term einer Formel. {@code messstelle == null} ist ein Messkanal (kein Posten); {@code verteilungZiel} die
     * Kostenstelle eines Verteilungs-Terms („Anteil 4100 von MS-07“), sonst {@code null}; {@code anteil} {@code null}
     * heißt {@code gesamt}; {@code vorzeichen} {@code +}/{@code -}, {@code faktor} {@code null} heißt 1.
     */
    public record Term(String messstelle, String verteilungZiel, String anteil, String vorzeichen, BigDecimal faktor) {}

    /** Die Formel einer berechneten Messstelle über Tage (der letzte einschließlich; {@code null} = offen). */
    public record Formel(String messstelle, LocalDate gueltigAb, LocalDate gueltigBis, List<Term> terme) {

        boolean gilt(LocalDate tag) {
            return (gueltigAb == null || !tag.isBefore(gueltigAb)) && (gueltigBis == null || !tag.isAfter(gueltigBis));
        }
    }

    // ------------------------------------------------------------------------------- Ergebnis

    /** Tage, der letzte einschließlich. */
    public record Zeitraum(LocalDate von, LocalDate bis) {}

    /**
     * {@code teil} ist an den Tagen {@code zeitraeume} in {@code summe} enthalten — {@code kette} ist der Weg durch die
     * Formeln (Summe zuerst, Teil zuletzt), {@code satz} der Kundensatz.
     */
    public record Enthalten(String teil, String summe, String umfang, List<String> kette, List<Zeitraum> zeitraeume,
            String satz) {}

    /** Ein Posten, dessen Formel im Kreis führt oder auf einem Kreis aufbaut — benannt, nie still übergangen. */
    public record NichtPruefbar(String messstelle, String grund, List<String> kette, String satz) {}

    public record Urteil(List<Enthalten> enthalten, List<NichtPruefbar> nichtPruefbar) {}

    // ------------------------------------------------------------------------------- Regel

    /**
     * Die Überdeckungen unter den Posten der Kostenstelle {@code kostenstelle} von {@code von} bis {@code bis}.
     *
     * @param ziele und {@code quellen} wie bei {@link KostenstelleEnergieRegeln#energie} — dieselben Posten
     * @param formeln die Formeln der berechneten Messstellen im Zeitraum (auch die ohne eigene Zuordnung: sie können
     *     Glied einer Kette sein)
     */
    public static Urteil pruefe(String kostenstelle, LocalDate von, LocalDate bis, List<VerteilungRegeln.Ziel> ziele,
            List<KostenstelleEnergieRegeln.Quelle> quellen, List<Formel> formeln) {
        Map<String, KostenstelleEnergieRegeln.Quelle> nachKennzeichen = new LinkedHashMap<>();
        quellen.stream().sorted(Comparator.comparing(KostenstelleEnergieRegeln.Quelle::messstelle))
                .forEach(q -> nachKennzeichen.put(q.messstelle(), q));
        Map<String, List<Formel>> formelnJe = new LinkedHashMap<>();
        formeln.forEach(f -> formelnJe.computeIfAbsent(f.messstelle(), k -> new ArrayList<>()).add(f));

        // Die Abhängigkeitsordnung über den ganzen Zeitraum — dieselbe wie im Lauf, derselbe benannte Kreis.
        Map<String, List<String>> lesen = new LinkedHashMap<>();
        formelnJe.forEach((kz, fs) -> {
            Set<String> kanten = new LinkedHashSet<>();
            fs.stream().filter(f -> ueberschneidet(f, von, bis))
                    .forEach(f -> f.terme().stream().map(Term::messstelle).filter(m -> m != null && formelnJe.containsKey(m))
                            .forEach(kanten::add));
            lesen.put(kz, List.copyOf(kanten));
        });
        BerechnetePeriode.Reihenfolge reihenfolge = BerechnetePeriode.reihenfolge(lesen);
        Map<String, BerechnetePeriode.Abgelehnt> abgelehnt = new HashMap<>();
        reihenfolge.abgelehnt().forEach(a -> abgelehnt.put(a.messstelle(), a));

        Map<String, List<Tagesbefund>> befunde = new LinkedHashMap<>();
        Set<String> postenMitKreis = new LinkedHashSet<>();
        for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
            LocalDate tag = d;
            Map<String, BigDecimal> anteilHier = new LinkedHashMap<>();
            Map<String, Map<String, BigDecimal>> anteileJeZiel = new HashMap<>();
            for (KostenstelleEnergieRegeln.Quelle q : nachKennzeichen.values()) {
                Map<String, BigDecimal> jeZiel = new LinkedHashMap<>();
                VerteilungRegeln.amTag(tag, zeilen(q), ziele).zeilen()
                        .forEach(z -> jeZiel.put(z.kostenstelle(), z.anteilProzent()));
                anteileJeZiel.put(q.messstelle(), jeZiel);
                if (jeZiel.containsKey(kostenstelle)) {
                    anteilHier.put(q.messstelle(), jeZiel.get(kostenstelle));
                }
            }
            Map<String, Map<String, Beitrag>> inhalt = new HashMap<>();
            for (String kz : reihenfolge.ordnung()) {
                Formel f = formelAm(formelnJe.get(kz), tag);
                if (f != null) {
                    inhalt.put(kz, inhalt(kz, f, kostenstelle, anteileJeZiel, inhalt));
                }
            }
            for (Map.Entry<String, BigDecimal> summe : anteilHier.entrySet()) {
                String s = summe.getKey();
                if (abgelehnt.containsKey(s) && formelAm(formelnJe.get(s), tag) != null) {
                    postenMitKreis.add(s);
                }
                Map<String, Beitrag> enthaelt = inhalt.get(s);
                if (enthaelt == null) {
                    continue;
                }
                KostenstelleEnergieRegeln.Quelle sq = nachKennzeichen.get(s);
                for (String t : anteilHier.keySet()) {
                    Beitrag b = enthaelt.get(t);
                    if (t.equals(s) || b == null || !gleicheSumme(sq, nachKennzeichen.get(t))) {
                        continue;
                    }
                    BigDecimal ueberdeckt = summe.getValue().movePointLeft(2).multiply(b.koeffizient());
                    String umfang = ueberdeckt.compareTo(EINS) >= 0 ? GANZ
                            : ueberdeckt.signum() > 0 || b.teilPlus() ? TEILWEISE : null;
                    if (umfang != null) {
                        befunde.computeIfAbsent(t + " " + s + " " + umfang + " " + b.kette(),
                                k -> new ArrayList<>()).add(new Tagesbefund(t, s, umfang, b.kette(), tag));
                    }
                }
            }
        }

        List<Enthalten> enthalten = new ArrayList<>();
        befunde.values().forEach(tage -> {
            Tagesbefund erster = tage.get(0);
            String satz = (GANZ.equals(erster.umfang()) ? SATZ_ENTHALTEN : SATZ_ENTHALTEN_TEILWEISE)
                    .replace("{teil}", erster.teil()).replace("{summe}", erster.summe());
            enthalten.add(new Enthalten(erster.teil(), erster.summe(), erster.umfang(), erster.kette(),
                    zeitraeume(tage.stream().map(Tagesbefund::tag).toList()), satz));
        });
        enthalten.sort(Comparator.comparing(Enthalten::summe).thenComparing(Enthalten::teil)
                .thenComparing(e -> e.zeitraeume().get(0).von()));

        List<NichtPruefbar> nichtPruefbar = new ArrayList<>();
        postenMitKreis.stream().sorted().forEach(kz -> {
            BerechnetePeriode.Abgelehnt a = abgelehnt.get(kz);
            String vorlage = BerechnetePeriode.FORMEL_KREIS.equals(a.grund()) ? SATZ_KREIS : SATZ_HAENGT_AN_KREIS;
            nichtPruefbar.add(new NichtPruefbar(kz, a.grund(), a.kette(),
                    vorlage.replace("{messstelle}", kz).replace("{kette}", String.join(KETTE_TRENNER, a.kette()))));
        });
        return new Urteil(List.copyOf(enthalten), List.copyOf(nichtPruefbar));
    }

    /**
     * Wie eine berechnete Messstelle eine andere trägt, bezogen auf deren Posten an der Kostenstelle: {@code koeffizient}
     * = Summe über alle Wege von Vorzeichen × Faktor (× Anteil eines durchlaufenen Verteilungs-Terms); {@code teilPlus}/
     * {@code teilMinus}, wenn ein Weg nur den positiven oder negativen Teil eines Messwerts liest; {@code kette} der
     * kürzeste Weg.
     */
    private record Beitrag(BigDecimal koeffizient, boolean teilPlus, boolean teilMinus, List<String> kette) {

        Beitrag plus(Beitrag b) {
            List<String> kuerzer = b.kette().size() < kette.size() ? b.kette() : kette;
            return new Beitrag(koeffizient.add(b.koeffizient()), teilPlus || b.teilPlus(), teilMinus || b.teilMinus(),
                    kuerzer);
        }
    }

    private record Tagesbefund(String teil, String summe, String umfang, List<String> kette, LocalDate tag) {}

    /** Der Inhalt von {@code kz} am Tag: jede Messstelle, die seine Formel (über alle Stufen) trägt. */
    private static Map<String, Beitrag> inhalt(String kz, Formel f, String kostenstelle,
            Map<String, Map<String, BigDecimal>> anteileJeZiel, Map<String, Map<String, Beitrag>> fertig) {
        Map<String, Beitrag> raus = new LinkedHashMap<>();
        for (Term t : f.terme()) {
            if (t.messstelle() == null) {
                continue;
            }
            BigDecimal gewicht = t.faktor() == null ? EINS : t.faktor();
            if (VORZEICHEN_MINUS.equals(t.vorzeichen())) {
                gewicht = gewicht.negate();
            }
            boolean teil = t.anteil() != null && !ANTEIL_GESAMT.equals(t.anteil());
            // Der Posten des Terms selbst: ganz, oder genau sein Anteil an DIESER Kostenstelle; der Anteil an einer
            // anderen Kostenstelle ist ein anderer Teil derselben Messstelle.
            BigDecimal direkt = gewicht;
            BigDecimal tiefer = gewicht;
            if (t.verteilungZiel() != null) {
                BigDecimal anteil = anteileJeZiel.getOrDefault(t.messstelle(), Map.of()).get(t.verteilungZiel());
                if (anteil == null) {
                    continue; // ohne Zeile am Tag liest der Term nichts (nicht verteilt)
                }
                direkt = t.verteilungZiel().equals(kostenstelle) ? gewicht : BigDecimal.ZERO;
                tiefer = gewicht.multiply(anteil.movePointLeft(2));
            }
            List<String> weg = List.of(kz, t.messstelle());
            dazu(raus, t.messstelle(), new Beitrag(teil ? BigDecimal.ZERO : direkt,
                    teil && gewicht.signum() > 0, teil && gewicht.signum() < 0, weg));
            Map<String, Beitrag> darunter = fertig.get(t.messstelle());
            if (darunter == null) {
                continue;
            }
            for (Map.Entry<String, Beitrag> e : darunter.entrySet()) {
                Beitrag b = e.getValue();
                List<String> kette = new ArrayList<>(List.of(kz));
                kette.addAll(b.kette());
                boolean plus = tiefer.signum() >= 0 ? b.teilPlus() : b.teilMinus();
                boolean minus = tiefer.signum() >= 0 ? b.teilMinus() : b.teilPlus();
                dazu(raus, e.getKey(), new Beitrag(teil ? BigDecimal.ZERO : tiefer.multiply(b.koeffizient()),
                        plus || (teil && tiefer.signum() > 0), minus || (teil && tiefer.signum() < 0),
                        List.copyOf(kette)));
            }
        }
        return raus;
    }

    private static void dazu(Map<String, Beitrag> in, String kz, Beitrag b) {
        in.merge(kz, b, Beitrag::plus);
    }

    private static Formel formelAm(List<Formel> formeln, LocalDate tag) {
        if (formeln == null) {
            return null;
        }
        return formeln.stream().filter(f -> f.gilt(tag)).findFirst().orElse(null);
    }

    private static boolean ueberschneidet(Formel f, LocalDate von, LocalDate bis) {
        return (f.gueltigAb() == null || !f.gueltigAb().isAfter(bis)) && (f.gueltigBis() == null || !f.gueltigBis().isBefore(von));
    }

    /** Nur Posten derselben Summe (Größe, Richtung, Einheit) können doppelt in EINE Zahl eingehen. */
    private static boolean gleicheSumme(KostenstelleEnergieRegeln.Quelle a, KostenstelleEnergieRegeln.Quelle b) {
        return a.groesse().equals(b.groesse()) && a.richtung().equals(b.richtung()) && a.einheit().equals(b.einheit());
    }

    private static List<VerteilungRegeln.Bestandszeile> zeilen(KostenstelleEnergieRegeln.Quelle q) {
        return q.anteile().stream()
                .map(a -> new VerteilungRegeln.Bestandszeile(a.kostenstelle(), a.anteilProzent(), a.gueltigAb(),
                        a.gueltigBis(), null))
                .toList();
    }

    private static List<Zeitraum> zeitraeume(List<LocalDate> tage) {
        List<Zeitraum> raus = new ArrayList<>();
        LocalDate beginn = null;
        LocalDate letzter = null;
        for (LocalDate t : tage) {
            if (beginn != null && !t.equals(letzter.plusDays(1))) {
                raus.add(new Zeitraum(beginn, letzter));
                beginn = null;
            }
            if (beginn == null) {
                beginn = t;
            }
            letzter = t;
        }
        if (beginn != null) {
            raus.add(new Zeitraum(beginn, letzter));
        }
        return List.copyOf(raus);
    }
}
