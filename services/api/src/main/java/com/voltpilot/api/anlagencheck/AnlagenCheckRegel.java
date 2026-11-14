package com.voltpilot.api.anlagencheck;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;

/**
 * Die Regel „fällt ab" des Anlagen-Checks (Bedienkonzept vp-privatkunde-bedienkonzept §6.4, Captain BK-4/BK-5 = A) -
 * rein und rahmenfrei; die Vektoren stehen in {@code src/test/resources/anlagencheck/regel-vektoren.json}.
 *
 * <p>Die Zahlen sind STARTWERTE aus dem Konzept, nicht vom Captain entschieden (§8 „Was daraus folgt"): Sonnentag ab
 * 0,5 kWh erwartet je kWp, ab 3 Sonnentagen, mehrere Einheiten „fällt ab" unter 80 % und mindestens 15 Punkte unter
 * dem Median der anderen, die ganze Anlage unter 70 % über 14 Tage, Lücke ab einem Zehntel fehlender Stunden tagsüber.
 *
 * <ul>
 *   <li><b>Gewertet</b> wird ein Tag einer Reihe, wenn er ein Sonnentag ist (die Erwartung ALLER Reihen zusammen ab
 *       {@link #SONNENTAG_KWH_JE_KWP} je kWp - für alle Reihen derselbe Tag, damit der Wetterfehler beim Vergleich
 *       herausfällt), nicht abgeregelt war, Erwartung und Messung trägt und tagsüber keine Lücke hat.</li>
 *   <li><b>Verhältnis</b> = Summe gemessen ÷ Summe erwartet über die gewerteten Tage (nie ein Mittel der Tage).</li>
 *   <li><b>Messwerte fehlen</b> geht vor „liefert weniger": wer keine Werte schickt, liefert nicht weniger.</li>
 * </ul>
 */
public final class AnlagenCheckRegel {

    /** Ein Sonnentag: die Erwartung liegt ab 0,5 kWh je kWp. */
    public static final double SONNENTAG_KWH_JE_KWP = 0.5;
    /** Ohne bekannte kWp: ein Tag mit mindestens so viel Erwartung zählt als Sonnentag. */
    public static final double SONNENTAG_OHNE_KWP_KWH = 1.0;
    /** So viele Sonnentage braucht ein Vergleich. */
    public static final int MIN_SONNENTAGE = 3;
    /** Fenster der Kachel: 7 Tage, mit zu wenig Sonne 14. */
    public static final int FENSTER_TAGE = 7;
    public static final int FENSTER_LANG_TAGE = 14;
    /** Mehrere Einheiten: „fällt ab" unter 80 % ... */
    public static final double WENIGER_UNTER = 0.80;
    /** ... und mindestens 15 Punkte unter dem Median der anderen. */
    public static final double ABSTAND_ZU_ANDEREN = 0.15;
    /** Eine Zeile („Ganze Anlage"): erst unter 70 %, weil der Wetterfehler nicht herausfällt. */
    public static final double GANZE_ANLAGE_WENIGER_UNTER = 0.70;
    /** Tagsüber fehlt mehr als ein Zehntel der Stunden: der Tag ist eine Lücke. */
    public static final double LUECKE_AB_ANTEIL = 0.10;
    /** Eine Stunde gilt als „tagsüber", wenn die Sonne in ihrer Mitte höher als 5° steht. */
    public static final double TAG_AB_GRAD = 5.0;

    private AnlagenCheckRegel() {
    }

    public enum Modus { EINHEITEN, GANZE_ANLAGE }

    /** Ein Tag einer Reihe. {@code gemessenKwh == null}: an diesem Tag kein einziger Messwert. */
    public record TagWert(LocalDate tag, Double gemessenKwh, Double erwartetKwh, boolean luecke) {}

    /** Eine Reihe: eine Einheit oder die ganze Anlage. */
    public record Reihe(String id, String name, Double kwp, List<TagWert> tage) {
        TagWert am(LocalDate tag) {
            for (TagWert t : tage) {
                if (t.tag().equals(tag)) {
                    return t;
                }
            }
            return null;
        }
    }

    public enum Zustand { WIE_ERWARTET, WENIGER, FEHLT, OFFEN }

    public enum Gesamt { WIE_ERWARTET, WENIGER, MESSWERTE_FEHLEN, ZU_WENIG_SONNE, NOCH_ZU_FRUEH }

    /**
     * @param verhaeltnis gemessen ÷ erwartet über die gewerteten Tage, {@code null} unter {@link #MIN_SONNENTAGE}
     * @param keineWerteSeit der erste Tag ohne einen Messwert, wenn die Reihe bis zum Ende des Fensters schweigt
     * @param wenigerSeit der erste Tag der letzten Folge gewerteter Tage unter {@link #WENIGER_UNTER}; {@code null},
     *     wenn sie schon am ersten gewerteten Tag des Fensters begann (dann ist „seit wann" nicht belegbar)
     */
    public record EinheitUrteil(String id, String name, Double gemessenKwh, Double erwartetKwh, Double verhaeltnis,
            Zustand zustand, LocalDate keineWerteSeit, LocalDate wenigerSeit, int gewerteteTage) {}

    /**
     * @param fensterTage Tage des Fensters (von..bis eingeschlossen)
     * @param sonnenTage gewertete Sonnentage der Anlage (ohne abgeregelte)
     * @param abgeregelteTage Tage im Fenster mit Abregelung (nicht gewertet)
     */
    public record Urteil(Modus modus, Gesamt gesamt, LocalDate von, LocalDate bis, int fensterTage, int sonnenTage,
            int abgeregelteTage, List<EinheitUrteil> einheiten) {}

    /** Die Kachel: die letzten 7 abgeschlossenen Tage bis {@code bis}, mit zu wenig Sonne 14; die ganze Anlage 14. */
    public static Urteil rollend(List<Reihe> reihen, Modus modus, Set<LocalDate> abgeregelt, LocalDate bis) {
        if (modus == Modus.GANZE_ANLAGE) {
            return urteil(reihen, modus, abgeregelt, bis.minusDays(FENSTER_LANG_TAGE - 1L), bis);
        }
        Urteil kurz = urteil(reihen, modus, abgeregelt, bis.minusDays(FENSTER_TAGE - 1L), bis);
        if (kurz.sonnenTage() >= MIN_SONNENTAGE) {
            return kurz;
        }
        return urteil(reihen, modus, abgeregelt, bis.minusDays(FENSTER_LANG_TAGE - 1L), bis);
    }

    /** Das Urteil über ein festes Fenster [von, bis] (eingeschlossen). */
    public static Urteil urteil(List<Reihe> reihen, Modus modus, Set<LocalDate> abgeregelt, LocalDate von,
            LocalDate bis) {
        List<LocalDate> tage = new ArrayList<>();
        for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
            tage.add(d);
        }
        double kwpSumme = 0;
        boolean kwpBekannt = !reihen.isEmpty();
        for (Reihe r : reihen) {
            if (r.kwp() == null || r.kwp() <= 0) {
                kwpBekannt = false;
            } else {
                kwpSumme += r.kwp();
            }
        }
        List<LocalDate> sonnentage = new ArrayList<>();
        int abgeregelte = 0;
        int mitErwartung = 0;
        for (LocalDate d : tage) {
            boolean ab = abgeregelt.contains(d);
            if (ab) {
                abgeregelte++;
            }
            double erwartet = 0;
            boolean irgendeine = false;
            for (Reihe r : reihen) {
                TagWert t = r.am(d);
                if (t != null && t.erwartetKwh() != null) {
                    erwartet += t.erwartetKwh();
                    irgendeine = true;
                }
            }
            if (irgendeine) {
                mitErwartung++;
            }
            boolean sonne = irgendeine && (kwpBekannt
                    ? erwartet >= SONNENTAG_KWH_JE_KWP * kwpSumme
                    : erwartet >= SONNENTAG_OHNE_KWP_KWH);
            if (sonne && !ab) {
                sonnentage.add(d);
            }
        }

        List<Reihe> geordnet = List.copyOf(reihen);
        List<Double> verhaeltnisse = new ArrayList<>();
        List<Teil> teile = new ArrayList<>();
        for (Reihe r : geordnet) {
            Teil t = teil(r, tage, sonnentage, modus);
            teile.add(t);
            verhaeltnisse.add(t.verhaeltnis);
        }

        List<EinheitUrteil> urteile = new ArrayList<>();
        for (int i = 0; i < teile.size(); i++) {
            Teil t = teile.get(i);
            Zustand z = t.fehlt ? Zustand.FEHLT : Zustand.OFFEN;
            if (!t.fehlt && t.verhaeltnis != null) {
                z = weniger(t.verhaeltnis, andere(verhaeltnisse, i), modus) ? Zustand.WENIGER : Zustand.WIE_ERWARTET;
            }
            LocalDate wenigerSeit = z == Zustand.WENIGER ? t.wenigerSeit : null;
            urteile.add(new EinheitUrteil(t.reihe.id(), t.reihe.name(), t.gemessen, t.erwartet, t.verhaeltnis, z,
                    t.keineWerteSeit, wenigerSeit, t.gewertet));
        }

        Gesamt gesamt;
        if (urteile.stream().anyMatch(u -> u.zustand() == Zustand.WENIGER)) {
            gesamt = Gesamt.WENIGER;
        } else if (urteile.stream().anyMatch(u -> u.zustand() == Zustand.FEHLT)) {
            gesamt = Gesamt.MESSWERTE_FEHLEN;
        } else if (mitErwartung < MIN_SONNENTAGE) {
            gesamt = Gesamt.NOCH_ZU_FRUEH;
        } else if (sonnentage.size() < MIN_SONNENTAGE
                || urteile.stream().noneMatch(u -> u.zustand() == Zustand.WIE_ERWARTET)) {
            gesamt = Gesamt.ZU_WENIG_SONNE;
        } else {
            gesamt = Gesamt.WIE_ERWARTET;
        }
        return new Urteil(modus, gesamt, von, bis, tage.size(), sonnentage.size(), abgeregelte, List.copyOf(urteile));
    }

    private static final class Teil {
        Reihe reihe;
        Double gemessen;
        Double erwartet;
        Double verhaeltnis;
        boolean fehlt;
        LocalDate keineWerteSeit;
        LocalDate wenigerSeit;
        int gewertet;
    }

    private static Teil teil(Reihe r, List<LocalDate> tage, List<LocalDate> sonnentage, Modus modus) {
        Teil t = new Teil();
        t.reihe = r;
        double gem = 0;
        double erw = 0;
        int sonneOhneWerte = 0;
        List<LocalDate> gewerteteTage = new ArrayList<>();
        List<Boolean> unter = new ArrayList<>();
        for (LocalDate d : sonnentage) {
            TagWert w = r.am(d);
            if (w == null || w.erwartetKwh() == null) {
                continue;
            }
            if (w.gemessenKwh() == null || w.luecke()) {
                sonneOhneWerte++;
                continue;
            }
            gem += w.gemessenKwh();
            erw += w.erwartetKwh();
            gewerteteTage.add(d);
            unter.add(w.erwartetKwh() > 0 && w.gemessenKwh() / w.erwartetKwh() < WENIGER_UNTER);
        }
        t.gewertet = gewerteteTage.size();
        if (t.gewertet > 0) {
            t.gemessen = gem;
            t.erwartet = erw;
        }
        if (t.gewertet >= MIN_SONNENTAGE && erw > 0) {
            t.verhaeltnis = gem / erw;
        }
        // Schweigt die Reihe bis zum Ende des Fensters, und war darunter ein Sonnentag?
        if (modus == Modus.EINHEITEN) {
            LocalDate seit = null;
            boolean sonneDarin = false;
            for (int i = tage.size() - 1; i >= 0; i--) {
                TagWert w = r.am(tage.get(i));
                if (w != null && w.gemessenKwh() != null) {
                    break;
                }
                seit = tage.get(i);
                sonneDarin |= sonnentage.contains(tage.get(i));
            }
            if (seit != null && sonneDarin) {
                t.keineWerteSeit = seit;
            }
        }
        t.fehlt = t.keineWerteSeit != null
                || (t.verhaeltnis == null && sonneOhneWerte > 0 && sonnentage.size() >= MIN_SONNENTAGE);
        // „seit": die letzte Folge gewerteter Tage unter der Schwelle.
        int start = unter.size();
        while (start > 0 && unter.get(start - 1)) {
            start--;
        }
        if (start < unter.size() && start > 0) {
            t.wenigerSeit = gewerteteTage.get(start);
        }
        return t;
    }

    private static List<Double> andere(List<Double> alle, int ohne) {
        List<Double> out = new ArrayList<>();
        for (int i = 0; i < alle.size(); i++) {
            if (i != ohne && alle.get(i) != null) {
                out.add(alle.get(i));
            }
        }
        return out;
    }

    static boolean weniger(double verhaeltnis, List<Double> andere, Modus modus) {
        if (modus == Modus.GANZE_ANLAGE || andere.isEmpty()) {
            return verhaeltnis < GANZE_ANLAGE_WENIGER_UNTER;
        }
        return verhaeltnis < WENIGER_UNTER && verhaeltnis <= median(andere) - ABSTAND_ZU_ANDEREN + 1e-9;
    }

    static double median(Collection<Double> werte) {
        List<Double> s = new ArrayList<>(werte);
        s.sort(Double::compare);
        int n = s.size();
        return n % 2 == 1 ? s.get(n / 2) : (s.get(n / 2 - 1) + s.get(n / 2)) / 2;
    }

    /**
     * Ein Tag einer Einheit aus ihren Stundenwerten: Summe der vorhandenen Stunden; eine fehlende Stunde nachts zählt
     * 0 (der Wechselrichter schläft), tagsüber ist sie eine Lücke - mehr als {@link #LUECKE_AB_ANTEIL} der
     * Tagstunden fehlend macht den Tag zur Lücke. Ohne eine einzige Stunde: {@code gemessenKwh == null}.
     *
     * @param stundenKwh je Stunde des Tages die kWh, {@code null} = kein Messwert
     * @param tagsueber je Stunde, ob die Sonne in ihrer Mitte über {@link #TAG_AB_GRAD} steht
     */
    public static TagWert tagAusStunden(LocalDate tag, List<Double> stundenKwh, List<Boolean> tagsueber,
            Double erwartetKwh) {
        double summe = 0;
        int vorhanden = 0;
        int tagStunden = 0;
        int tagFehlt = 0;
        for (int i = 0; i < stundenKwh.size(); i++) {
            Double v = stundenKwh.get(i);
            boolean tagStunde = tagsueber.get(i);
            if (tagStunde) {
                tagStunden++;
            }
            if (v == null) {
                if (tagStunde) {
                    tagFehlt++;
                }
                continue;
            }
            vorhanden++;
            summe += Math.max(0, v);
        }
        boolean luecke = tagStunden > 0 && tagFehlt > LUECKE_AB_ANTEIL * tagStunden;
        return new TagWert(tag, vorhanden == 0 ? null : summe, erwartetKwh, luecke);
    }
}
