package com.voltpilot.api.uems;

import com.voltpilot.api.uems.KennzahlRepository.Gespeichert;
import com.voltpilot.api.uems.KennzahlService.Aufgeloest;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Lesewege eines Kennzahl-Eingangs (UEMS AP-11 §4.4, Q1) — EINMAL, für die Vorschau (IP-5) und den Rechenlauf (IP-6).
 *
 * <p><b>Gelesen, nie nachgerechnet:</b>
 * <ul>
 *   <li>eine Messstelle — gemessen oder berechnet — über ihr Lesemodell ({@link MessstelleWerteService#werte}) im Raster
 *       der Periode: Menge aus den Periodenständen, AP-08-Zustand, Abdeckung, Version;</li>
 *   <li>eine Bezugsgröße als Periodenwert über ihre wirksame Fassung ({@link BezugsgroesseService#werte}, Lesart
 *       {@code wirksam}) — auch ein Wert mit Herkunft {@code messkanal}: {@code bezugsgroesse_wert} trägt keinen
 *       AP-08-Zustand, eine Kanal-Bezugsgröße mit eigenem Zustand gibt es erst mit AP-09 IP-17;</li>
 *   <li>eine Bezugsgröße als Stammdatum am Stichtag, dem letzten Tag der Periode ({@link BezugsgroesseService#stammdatum},
 *       E17);</li>
 *   <li>eine Kennzahl über ihren gespeicherten Wert derselben Periode (R3) — als Paar einer Zusammenfassung mit Zähler und
 *       Nenner (R4).</li>
 * </ul>
 * Den Zustand eines Bezugsgrößen-Nenners setzt nicht der Leser, er wird in {@link KennzahlRegeln#wert} abgeleitet (Q1).
 *
 * <p><b>Feinere Bezugsgrößen-Perioden</b> zählen nur, wenn JEDE einen wirksamen Betrag hat — sonst fehlt der Nenner; nie
 * verteilt, nie geschätzt (P3). Eine Bezugsfläche der Ortsstruktur ist keine Bezugsgröße mit Kennzeichen und darum kein
 * Eingang (AP-09 IP-6: „Flächen pflegen Sie am Gebäude“).
 */
@Component
public class KennzahlEingangLeser {

    /** Das Kurzzeichen, das eine Unternehmens-Kennzahl ihren geerbten Kennzeichen voranstellt (Referenzunternehmen „U“). */
    static final String UNTERNEHMEN_KURZ = "U";

    /** „x von y …“ über Ebenen — die Wörter der Regel {@code x_von_y}, je Geltungsbereich der Paare. */
    static final Map<String, String> WORT_EBENE = Map.of("gebaeude", "Gebäuden", "bereich", "Bereichen", "standort",
            "Standorten", "prozess", "Prozessen", "kostenstelle", "Kostenstellen", "messstelle", "Messstellen");
    static final String WORT_KENNZAHLEN = "Kennzahlen";

    private static final BigDecimal HUNDERT = new BigDecimal("100");

    /**
     * Was ein Eingang in einer Periode trägt: der Eingang der Regel, und für die Herkunft seine Version (Messstelle,
     * Kennzahl) bzw. Fassung (Bezugsgröße), seine Kennzeichen und wann er endgültig wurde ({@code null} = unbekannt).
     */
    record Gelesen(KennzahlRegeln.Eingang eingang, Integer version, Integer fassung, List<String> herkunft,
            Instant endgueltigAb) {}

    /** Ein Paar einer Zusammenfassung: der Teil der Regel und die gespeicherte Zeile dahinter ({@code null} = keine). */
    record Paar(KennzahlRegeln.Teil teil, Gespeichert zeile) {}

    private final KennzahlRepository repo;
    private final MessstelleWerteService messwerte;
    private final BezugsgroesseService bezugswerte;
    /** Die Versionen ab 2 der Messstellen — {@code null}: die des Lesemodells (gespeichert, Kundenbereich). */
    private final WertVersionenLeser versionen;

    @Autowired
    public KennzahlEingangLeser(KennzahlRepository repo, MessstelleWerteService messwerte,
            BezugsgroesseService bezugswerte) {
        this(repo, messwerte, bezugswerte, null);
    }

    private KennzahlEingangLeser(KennzahlRepository repo, MessstelleWerteService messwerte,
            BezugsgroesseService bezugswerte, WertVersionenLeser versionen) {
        this.repo = repo;
        this.messwerte = messwerte;
        this.bezugswerte = bezugswerte;
        this.versionen = versionen;
    }

    /**
     * Derselbe Leser für die Korrektur-Kaskade (IP-8): gespeicherte Kennzahl-Werte über {@code repo}, Messstellen-Versionen
     * ab 2 über {@code versionen} — beide auf der Transaktion der Kaskade, damit die nächste Kennzahl liest, was die
     * Stufen und die Kennzahl davor eben schrieben. Bezugsgrößen, Version 1 und Quellen ändert die Kaskade nicht.
     */
    KennzahlEingangLeser mit(KennzahlRepository repo, WertVersionenLeser versionen) {
        return new KennzahlEingangLeser(repo, messwerte, bezugswerte, versionen);
    }

    // ------------------------------------------------------------------------------ je Zeitraum

    /**
     * Je Periode der Art in {@code [von, bis]} (Tage, ganze Perioden) der Eingang — jede Periode steht in der Antwort, eine
     * ohne Wert als „keine Werte“ ohne Status.
     */
    Map<String, Gelesen> lies(Aufgeloest x, String art, LocalDate von, LocalDate bis) {
        List<LocalDate[]> perioden = perioden(art, von, bis);
        Map<String, Gelesen> gelesen = switch (x.art()) {
            case KennzahlRegeln.MESSSTELLE -> messstelle(x, art, von, bis);
            case KennzahlRegeln.BEZUGSGROESSE -> KennzahlRegeln.STAMMDATUM.equals(x.wertart())
                    ? stammdatum(x, art, von, bis) : periodenwert(x, art, perioden);
            default -> kennzahl(x, art, von, bis);
        };
        Map<String, Gelesen> aus = new LinkedHashMap<>();
        for (LocalDate[] p : perioden) {
            String s = BezugsPeriode.schluesselVon(p[0], art);
            aus.put(s, gelesen.getOrDefault(s, keineWerte(x)));
        }
        return aus;
    }

    /** Je Periode der Art in {@code [von, bis]} das Paar einer Zusammenfassung — die gespeicherte Zeile der Kennzahl. */
    Map<String, Paar> paare(Aufgeloest x, String art, LocalDate von, LocalDate bis) {
        String geltung = geltung(x);
        Map<LocalDate, Gespeichert> zeilen = repo.werte(x.id(), art, von, bis);
        Map<String, Paar> aus = new LinkedHashMap<>();
        for (LocalDate[] p : perioden(art, von, bis)) {
            Gespeichert g = zeilen.get(p[0]);
            aus.put(BezugsPeriode.schluesselVon(p[0], art), new Paar(teil(x.kennzeichen(), geltung, g), g));
        }
        return aus;
    }

    /** Eine Periode — für die Vorschau. */
    KennzahlRegeln.Eingang eingang(Aufgeloest x, String art, LocalDate[] spanne) {
        return lies(x, art, spanne[0], spanne[1]).get(BezugsPeriode.schluesselVon(spanne[0], art)).eingang();
    }

    /** Ein Paar in einer Periode — für die Vorschau. */
    KennzahlRegeln.Teil teil(Aufgeloest x, String art, LocalDate[] spanne) {
        return paare(x, art, spanne[0], spanne[1]).get(BezugsPeriode.schluesselVon(spanne[0], art)).teil();
    }

    /** Die Perioden der Art, die {@code [von, bis]} berühren, je als {@code [erster, letzter Tag]}. */
    static List<LocalDate[]> perioden(String art, LocalDate von, LocalDate bis) {
        List<LocalDate[]> aus = new ArrayList<>();
        for (LocalDate[] s = BezugsPeriode.spanneUm(von, art); !s[0].isAfter(bis);
                s = BezugsPeriode.spanneUm(s[1].plusDays(1), art)) {
            aus.add(s);
        }
        return aus;
    }

    /**
     * Eine gespeicherte Zeile als Teil von Summe durch Summe. Eine Zeile ohne Zahl mit Zähler UND Nenner (Nenner 0) zählt
     * mit (K9) — ihren Zustand hat sie selbst nicht, er ist der schlechteste ihrer Eingänge.
     */
    static KennzahlRegeln.Teil teil(String objekt, String geltung, Gespeichert g) {
        if (g == null) {
            return new KennzahlRegeln.Teil(objekt, geltung, null, null, ErgebnisZustand.KEINE_WERTE, null, null, false,
                    List.of());
        }
        String zustand = g.wert() == null && g.zaehler() != null && g.nenner() != null && g.eingangZustand() != null
                ? g.eingangZustand() : g.mengeZustand();
        return new KennzahlRegeln.Teil(objekt, geltung, g.zaehler(), g.nenner(), zustand, g.richtung(),
                g.abdeckungProzent(), g.endgueltig(), g.kennzeichen());
    }

    /** Das Wort der Paare in „x von y …“: ihr gemeinsamer Geltungsbereich, gemischt „Kennzahlen“. */
    static String wortEbene(List<Aufgeloest> paare) {
        Set<String> arten = paare.stream().map(x -> x.kennzahl() == null ? null : x.kennzahl().geltungArt())
                .collect(Collectors.toCollection(LinkedHashSet::new));
        return arten.size() == 1 && arten.iterator().next() != null
                ? WORT_EBENE.getOrDefault(arten.iterator().next(), WORT_KENNZAHLEN) : WORT_KENNZAHLEN;
    }

    // ------------------------------------------------------------------------------ die Wege

    private Map<String, Gelesen> messstelle(Aufgeloest x, String art, LocalDate von, LocalDate bis) {
        MessstelleWerteDto.Werte w;
        try {
            w = versionen == null ? messwerte.werte(x.kennzeichen(), art, von.toString(), bis.toString(), null)
                    : messwerte.werte(x.kennzeichen(), art, von.toString(), bis.toString(), null, versionen);
        } catch (ResponseStatusException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                return Map.of();
            }
            throw ex;
        }
        Map<String, Gelesen> aus = new HashMap<>();
        for (MessstelleWerteDto.Wert v : w.werte()) {
            if (v.menge() == null) {
                continue;
            }
            List<String> kennzeichen = v.kennzeichen() == null ? List.of() : v.kennzeichen();
            KennzahlRegeln.Eingang e = new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, null, null,
                    v.menge(), w.messstelle().einheit(), v.zustand(),
                    v.abdeckungProzent() == null ? null : BigDecimal.valueOf(v.abdeckungProzent()),
                    ViertelstundeRegeln.ENDGUELTIG.equals(v.fassung()), ursache(v), kennzeichen);
            aus.put(BezugsPeriode.schluesselVon(OffsetDateTime.parse(v.von()).toLocalDate(), art),
                    new Gelesen(e, v.version(), null, kennzeichen, zeit(v.endgueltigAb())));
        }
        return aus;
    }

    /**
     * Q3 in Kundenwörtern: warum eine berechnete Messstelle unvollständig ist — die Eingänge ihrer Herkunft ohne Werte
     * („MS-16 fehlt“, K10). Ohne Herkunft (gemessen) nennt die Regel die Messstelle selbst.
     */
    static String ursache(MessstelleWerteDto.Wert v) {
        if (!ErgebnisZustand.UNVOLLSTAENDIG.equals(v.zustand()) || v.herkunft() == null) {
            return null;
        }
        Object satz = v.herkunft().containsKey("satz") ? v.herkunft().get("satz") : v.herkunft();
        if (!(satz instanceof Map<?, ?> s) || !(s.get("eingaenge") instanceof List<?> eingaenge)) {
            return null;
        }
        List<String> fehlen = new ArrayList<>();
        for (Object o : eingaenge) {
            if (o instanceof Map<?, ?> m && ErgebnisZustand.KEINE_WERTE.equals(m.get("zustand"))
                    && m.get("messstelle") != null) {
                fehlen.add(String.valueOf(m.get("messstelle")));
            }
        }
        return fehlen.isEmpty() ? null : String.join(", ", fehlen) + (fehlen.size() == 1 ? " fehlt" : " fehlen");
    }

    /**
     * Ein Periodenwert: in der eigenen Periode der wirksame Betrag; aus feineren Perioden die Summe, wenn JEDE einen
     * wirksamen Betrag hat — sonst kein Wert (der Nenner fehlt). Ein zurückgenommener Wert heißt so.
     */
    private Map<String, Gelesen> periodenwert(Aufgeloest x, String art, List<LocalDate[]> perioden) {
        String eigene = x.periodeArt();
        List<BezugsgroesseDto.Wert> werte = bezugswerte.werte(x.id(), perioden.get(0)[0],
                perioden.get(perioden.size() - 1)[1], BezugsgroesseRegeln.LESARTEN.get(0)).werte();
        Map<String, Gelesen> aus = new HashMap<>();
        for (LocalDate[] spanne : perioden) {
            Set<String> erwartet = new LinkedHashSet<>();
            for (LocalDate t = spanne[0]; !t.isAfter(spanne[1]); t = t.plusDays(1)) {
                erwartet.add(BezugsPeriode.schluesselVon(t, eigene));
            }
            Map<String, BezugsgroesseDto.Wert> jeSchluessel = new LinkedHashMap<>();
            for (BezugsgroesseDto.Wert w : werte) {
                if (w.periodeVon() != null && !w.periodeVon().isBefore(spanne[0])
                        && (w.periodeBis() == null || !w.periodeBis().isAfter(spanne[1]))) {
                    jeSchluessel.put(BezugsPeriode.schluesselVon(w.periodeVon(), eigene), w);
                }
            }
            boolean einzeln = erwartet.size() == 1;
            BigDecimal summe = BigDecimal.ZERO;
            boolean endgueltig = true;
            Instant ab = null;
            Gelesen ohne = null;
            BezugsgroesseDto.Wert letzter = null;
            for (String k : erwartet) {
                BezugsgroesseDto.Wert w = jeSchluessel.get(k);
                if (w == null || w.wirksamerBetrag() == null) {
                    boolean zurueck = w != null && w.fassungen() != null && w.fassungen().stream()
                            .anyMatch(f -> KennzahlRegeln.ZURUECKGENOMMEN.equals(f.status()));
                    BezugsgroesseDto.Fassung juengste = einzeln && w != null ? juengste(w) : null;
                    ohne = new Gelesen(new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null,
                            KennzahlRegeln.PERIODENWERT, zurueck && einzeln ? KennzahlRegeln.ZURUECKGENOMMEN : null, null,
                            x.einheit(), null, null, zurueck && einzeln, null, List.of()), null,
                            juengste == null ? null : juengste.fassung(),
                            juengste == null || juengste.kennzeichen() == null ? List.of() : juengste.kennzeichen(), null);
                    break;
                }
                summe = summe.add(new BigDecimal(w.wirksamerBetrag()));
                endgueltig &= !w.standOffen();
                BezugsgroesseDto.Fassung wirksame = wirksame(w);
                if (wirksame != null && wirksame.eingetragenAm() != null) {
                    Instant t = wirksame.eingetragenAm().toInstant();
                    ab = ab == null || t.isAfter(ab) ? t : ab;
                }
                letzter = w;
            }
            String s = BezugsPeriode.schluesselVon(spanne[0], art);
            if (ohne != null) {
                aus.put(s, ohne);
                continue;
            }
            BezugsgroesseDto.Fassung wirksame = einzeln && letzter != null ? wirksame(letzter) : null;
            aus.put(s, new Gelesen(new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null,
                    KennzahlRegeln.PERIODENWERT, KennzahlRegeln.WIRKSAM, summe, x.einheit(), null, null, endgueltig, null,
                    List.of()), null, einzeln && letzter != null ? letzter.wirksameFassung() : null,
                    wirksame == null || wirksame.kennzeichen() == null ? List.of() : wirksame.kennzeichen(),
                    endgueltig ? ab : null));
        }
        return aus;
    }

    private static BezugsgroesseDto.Fassung wirksame(BezugsgroesseDto.Wert w) {
        return w.fassungen() == null || w.wirksameFassung() == null ? null : w.fassungen().stream()
                .filter(f -> f.fassung() == w.wirksameFassung()).findFirst().orElse(null);
    }

    private static BezugsgroesseDto.Fassung juengste(BezugsgroesseDto.Wert w) {
        return w.fassungen() == null ? null : w.fassungen().stream()
                .max((a, b) -> Integer.compare(a.fassung(), b.fassung())).orElse(null);
    }

    /** E17: der Wert am letzten Tag der Periode; die Herkunft nennt den Stichtag („Stichtag 31.10.2026“, K12). */
    private Map<String, Gelesen> stammdatum(Aufgeloest x, String art, LocalDate von, LocalDate bis) {
        BezugsgroesseDto.Stammdatum sd = bezugswerte.stammdatum(x.id(), art, von, bis);
        Map<String, Gelesen> aus = new HashMap<>();
        if (sd.perioden() == null) {
            return aus;
        }
        for (BezugsgroesseDto.Stichtagwert p : sd.perioden()) {
            if (p.betrag() == null || p.von() == null) {
                continue;
            }
            List<String> kennzeichen = p.kennzeichen() == null ? List.of() : p.kennzeichen();
            List<String> herkunft = new ArrayList<>();
            if (p.stichtag() != null) {
                herkunft.add("Stichtag " + OrtsbaumAbleitung.datumText(p.stichtag()));
            }
            herkunft.addAll(kennzeichen);
            aus.put(BezugsPeriode.schluesselVon(p.von(), art), new Gelesen(new KennzahlRegeln.Eingang(x.art(),
                    x.kennzeichen(), x.name(), null, KennzahlRegeln.STAMMDATUM, null, new BigDecimal(p.betrag()),
                    x.einheit(), null, null, true, null, kennzeichen), null, null, List.copyOf(herkunft), null));
        }
        return aus;
    }

    /** R3: der gespeicherte Wert der Kennzahl in derselben Periode — mit dem Kurzzeichen ihres Geltungsobjekts (Q8). */
    private Map<String, Gelesen> kennzahl(Aufgeloest x, String art, LocalDate von, LocalDate bis) {
        String geltung = geltung(x);
        Map<String, Gelesen> aus = new HashMap<>();
        for (Gespeichert g : repo.werte(x.id(), art, von, bis).values()) {
            KennzahlRegeln.Eingang e = new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), geltung, null, null,
                    g.wert(), x.einheit() == null ? "" : x.einheit(),
                    g.wert() == null ? ErgebnisZustand.KEINE_WERTE : g.mengeZustand(), g.abdeckungProzent(),
                    g.endgueltig(), null, g.kennzeichen());
            aus.put(BezugsPeriode.schluesselVon(g.periodeVon(), art),
                    new Gelesen(e, g.version(), null, g.kennzeichen(), g.endgueltigAb()));
        }
        return aus;
    }

    private String geltung(Aufgeloest x) {
        return x.kennzahl() == null ? null
                : repo.geltungKurzzeichen(x.kennzahl().geltungArt(), x.kennzahl().geltungId()).orElse(null);
    }

    private static Gelesen keineWerte(Aufgeloest x) {
        return new Gelesen(new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, x.wertart(), null, null,
                x.einheit() == null ? "" : x.einheit(), ErgebnisZustand.KEINE_WERTE, null, false, null, List.of()), null,
                null, List.of(), null);
    }

    private static Instant zeit(String iso) {
        return iso == null ? null : OffsetDateTime.parse(iso).toInstant();
    }

    /** Ob ein Eingang in der Periode gar nichts trägt — keine Zahl und keinen Status (P4). */
    static boolean leer(Gelesen g) {
        return g.eingang().wert() == null && g.eingang().status() == null;
    }

    /** Die Abdeckung eines Eingangs in der Herkunft: die gelesene, sonst 100 % mit Zahl und 0 ohne (Q4). */
    static BigDecimal abdeckung(Gelesen g) {
        KennzahlRegeln.Eingang e = g.eingang();
        return Objects.requireNonNullElse(e.abdeckungProzent(), e.wert() == null ? BigDecimal.ZERO : HUNDERT);
    }
}
