package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.web.dto.KennzahlDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.OptionalInt;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Das Lese-Modell der WERTE einer Kennzahl (UEMS AP-11 IP-7, Meilenstein „Kennzahl lesbar“): je Periode die Zahl mit
 * Zustand, Richtung, Abdeckung, Kennzeichen, vorläufig/endgültig, Version und gelesener Fassung — und die Herkunft,
 * gebaut von {@link KennzahlRegeln#herkunft} aus dem, was die Zeile beim Bilden las. Dazu die Versions-Historie einer
 * Periode nach dem Muster der Messstelle (AP-08 IP-18).
 *
 * <p><b>Nichts wird nachgerechnet.</b> Jede Zahl ist die gespeicherte, ungerundet; die Herkunft nennt die gespeicherten
 * Eingänge. Eine Zeit-Periode, die der Lauf über ihre eigenen Teilperioden bildet, hat keine Eingangs-Zeilen — ihre
 * Herkunft ist darum die ehrliche Antwort der Regel: kein Satz, {@code fehlt} = {@code eingaenge}.
 *
 * <p><b>Aufgerufen, nicht nachgebaut:</b> die Wahl einer Version, die es nirgends gibt
 * ({@link WertVersionenRegeln#pruefeVorhanden}), die Fassungen der Korrekturen und Ersatzwerte
 * ({@link WertVersionenLeser#fassungen}) und wie eine Entscheidung gesprochen wird
 * ({@link MessstelleWerteService#entscheidung}).
 */
@Service
public class KennzahlWerteService {

    /** Höchstens so viele Perioden je Anfrage — dieselbe Grenze wie der Werte-Leseweg der Messstelle. */
    static final int HOECHSTENS_SCHRITTE = 2200;
    /** Für die Periode ist keine Zeile gespeichert — dasselbe Wort wie am Messstellen-Wert. */
    public static final String NOCH_NICHT_GEBILDET = "noch_nicht_gebildet";
    /** Die angefragte Version gibt es an diesem Schritt nicht (an einem anderen schon) — wie am Messstellen-Wert. */
    public static final String VERSION_NICHT_GESPEICHERT = "version_nicht_gespeichert";
    /** Die Wörter, mit denen der Leser einen Schritt ohne gespeicherte Zahl erklärt — neben {@code grund_ohne_zahl}. */
    public static final List<String> GRUENDE_DES_LESERS = List.of(NOCH_NICHT_GEBILDET, VERSION_NICHT_GESPEICHERT);
    /** Die Anlass-Arten einer Version ab 2 — die Wörter von {@code kennzahl_wert_anlass_art_chk}. */
    public static final List<String> ANLASS_ARTEN = List.of("eingang", "definition");
    /** Eine Entscheidung aus der Fassung der Kennzahl selbst (Anlass {@code definition}). */
    public static final String VORGANG_BERECHNUNG = "berechnung";
    /** Die Vorgänge einer Entscheidung: Ersatzwert und Korrektur (AP-08) und die Berechnung der Kennzahl. */
    public static final List<String> VORGAENGE = List.of(WertVersionenRegeln.Vorgang.ERSATZWERT.wort(),
            WertVersionenRegeln.Vorgang.KORREKTUR.wort(), VORGANG_BERECHNUNG);

    static final Set<String> PARAMETER_WERTE = Set.of("periode", "von", "bis", "version");
    static final Set<String> PARAMETER_VERSIONEN = Set.of("periode", "von");

    /** Die Kennung eines Ersatzwerts oder einer Korrektur, wo ein Beleg sie nennt („K-2026-0007 (freigegeben …)“). */
    private static final Pattern VORGANG_KENNUNG = Pattern.compile("(?<![A-Za-z0-9])(?:EW|K)-[0-9]{4}-[0-9]{4,}(?![0-9])");

    private final KennzahlRepository repo;
    private final KennzahlService kennzahlen;
    private final KennzahlWerteLeser leser;
    private final WertVersionenLeser vorgaenge;
    private final JdbcTemplate jdbc;

    public KennzahlWerteService(KennzahlRepository repo, KennzahlService kennzahlen, JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.repo = repo;
        this.kennzahlen = kennzahlen;
        this.leser = new KennzahlWerteLeser(jdbc);
        this.vorgaenge = new WertVersionenLeser(jdbc);
    }

    // ================================================================================ Werte

    /**
     * Je Periode von {@code von} bis {@code bis} ein Schritt. Ohne {@code version} die neueste Zeile, mit
     * {@code version=n} die neueste Zeile der Version n — die damalige Zahl, nie die heutige mit Etikett.
     */
    public KennzahlDto.Werte werte(UUID id, Collection<String> parameter, String periode, String von, String bis,
            String version) {
        Anfrage a = anfrage(parameter, periode, von, bis, version);
        Lesung l = lesung(id);
        Map<LocalDate, List<KennzahlWerteLeser.Zeile>> jePeriode = new HashMap<>();
        leser.zeilen(id, a.periode(), a.von(), a.bis())
                .forEach(z -> jePeriode.computeIfAbsent(z.periodeVon(), k -> new ArrayList<>()).add(z));
        int hoechste = 0;
        for (List<KennzahlWerteLeser.Zeile> zeilen : jePeriode.values()) {
            Integer n = versionen(zeilen);
            hoechste = n == null ? hoechste : Math.max(hoechste, n);
        }
        WertVersionenRegeln.pruefeVorhanden(a.version(), hoechste);

        List<LocalDate[]> schritte = schritte(a.periode(), a.von(), a.bis());
        Map<LocalDate, KennzahlWerteLeser.Zeile> gewaehlt = new LinkedHashMap<>();
        for (LocalDate[] s : schritte) {
            KennzahlWerteLeser.Zeile z = waehle(jePeriode.getOrDefault(s[0], List.of()), a.version());
            if (z != null) {
                gewaehlt.put(s[0], z);
            }
        }
        Map<UUID, List<KennzahlWerteLeser.Eingang>> eingaenge = leser.eingaenge(gewaehlt.values().stream()
                .filter(z -> z.version() != null).map(KennzahlWerteLeser.Zeile::id).toList());
        List<KennzahlDto.Wert> werte = new ArrayList<>();
        for (LocalDate[] s : schritte) {
            List<KennzahlWerteLeser.Zeile> zeilen = jePeriode.getOrDefault(s[0], List.of());
            KennzahlWerteLeser.Zeile z = gewaehlt.get(s[0]);
            String grund = zeilen.isEmpty() ? NOCH_NICHT_GEBILDET : z == null ? VERSION_NICHT_GESPEICHERT : null;
            werte.add(wert(l, a.periode(), s, z, versionen(zeilen), grund,
                    z == null ? List.of() : eingaenge.getOrDefault(z.id(), List.of())));
        }
        return new KennzahlDto.Werte(l.kopf(), a.periode(), a.von(), a.bis(), l.zone().getId(), a.version(),
                List.copyOf(werte), geteilteRegister(id, a.von(), a.bis(), l.zone()));
    }

    /**
     * Summen-Wächter des geteilten Punkts ({@link GeteiltesRegister}) an einer Zusammenfassung: die Paare der
     * Fassung, die am LETZTEN Tag gilt (wie {@code definition_fassung}), ihre Messstellen je Σ, deren Quellen den
     * Zeitraum berühren. Benennt, ändert keine Zahl; jede andere Rechenform hat keine Summe und keinen Fund.
     */
    private List<KennzahlDto.GeteiltesRegister> geteilteRegister(UUID id, LocalDate von, LocalDate bis, ZoneId zone) {
        List<GeteiltesRegister.Summand> summanden = kennzahlen.summandenDerZusammenfassung(id, bis);
        Set<UUID> ids = new LinkedHashSet<>();
        summanden.forEach(s -> ids.add(s.messstelleId()));
        if (ids.size() < 2) {
            return List.of();
        }
        List<GeteiltesRegister.Bindung> bindungen = GeteiltesRegister.lade(jdbc, ids,
                von.atStartOfDay(zone).toInstant(), bis.plusDays(1).atStartOfDay(zone).toInstant());
        return GeteiltesRegister.finde(summanden, bindungen).stream()
                .map(f -> new KennzahlDto.GeteiltesRegister(f.rolle(), f.register(), f.messstellen())).toList();
    }

    // ================================================================================ Versionen

    /**
     * Die Versions-Historie EINER Periode: je Version der Wert, genau wie {@code version=n} ihn zeigt, der Wert davor,
     * wann sie gebildet wurde (und zuletzt nachzog) und ihre Entscheidungen — wer, wann, warum. Die Entscheidung liest
     * der Leser aus dem Vorgang, den der Anlass nennt: eine Korrektur oder ein Ersatzwert über ihre Fassungen, eine
     * geänderte Berechnung über die Fassung der Kennzahl. Ein Beleg ohne lesbaren Vorgang hat keine Entscheidung — sein
     * Text steht im Anlass.
     */
    public KennzahlDto.Historie historie(UUID id, Collection<String> parameter, String periode, String von) {
        Anfrage a = historieAnfrage(parameter, periode, von);
        Lesung l = lesung(id);
        List<KennzahlWerteLeser.Zeile> zeilen = leser.zeilen(id, a.periode(), a.von(), a.von());
        Integer versionen = versionen(zeilen);
        if (versionen == null) {
            String grund = zeilen.isEmpty() ? NOCH_NICHT_GEBILDET : zeilen.get(zeilen.size() - 1).grund();
            return new KennzahlDto.Historie(l.kopf(), a.periode(), a.von(), a.bis(), l.zone().getId(), grund, List.of());
        }
        LocalDate[] s = {a.von(), a.bis()};
        Map<Integer, List<KennzahlWerteLeser.Zeile>> jeVersion = new LinkedHashMap<>();
        zeilen.stream().filter(z -> z.version() != null)
                .forEach(z -> jeVersion.computeIfAbsent(z.version(), k -> new ArrayList<>()).add(z));
        Map<UUID, List<KennzahlWerteLeser.Eingang>> eingaenge = leser.eingaenge(jeVersion.values().stream()
                .map(v -> v.get(v.size() - 1).id()).toList());
        List<KennzahlDto.Version> liste = new ArrayList<>();
        KennzahlDto.Wert vorher = null;
        for (Map.Entry<Integer, List<KennzahlWerteLeser.Zeile>> e : jeVersion.entrySet()) {
            int n = e.getKey();
            KennzahlWerteLeser.Zeile erste = e.getValue().get(0);
            KennzahlWerteLeser.Zeile neueste = e.getValue().get(e.getValue().size() - 1);
            KennzahlDto.Wert wert = wert(l, a.periode(), s, neueste, versionen, null,
                    eingaenge.getOrDefault(neueste.id(), List.of()));
            liste.add(new KennzahlDto.Version(n, vorher, wert, iso(erste.berechnetAm(), erste.zone()),
                    e.getValue().size() > 1 ? iso(neueste.berechnetAm(), neueste.zone()) : null,
                    n == 1 ? null : new KennzahlDto.Anlass(erste.anlassArt(), erste.anlassKennung()),
                    n == 1 ? List.of() : entscheidungen(l, erste)));
            vorher = wert;
        }
        return new KennzahlDto.Historie(l.kopf(), a.periode(), a.von(), a.bis(), l.zone().getId(), null,
                List.copyOf(liste));
    }

    private List<KennzahlDto.Entscheidung> entscheidungen(Lesung l, KennzahlWerteLeser.Zeile erste) {
        if ("definition".equals(erste.anlassArt())) {
            return repo.fassungen(l.k().id()).stream().filter(f -> f.nummer() == erste.definitionFassung())
                    .map(f -> berechnung(l.k(), f, erste.zone())).toList();
        }
        List<String> kennungen = kennungen(erste.anlassKennung());
        if (kennungen.isEmpty()) {
            return List.of();
        }
        List<WertVersionenLeser.Fassung> fassungen = vorgaenge.fassungen(TenantContext.get(), kennungen);
        List<KennzahlDto.Entscheidung> aus = new ArrayList<>();
        for (String kennung : kennungen) {
            // Die Fassung, die bis zum Bilden der Version gespeichert war: die Kaskade schreibt in der Transaktion der Freigabe.
            OptionalInt fassung = fassungen.stream().filter(f -> f.kennung().equals(kennung))
                    .filter(f -> f.am() == null || !f.am().isAfter(erste.berechnetAm()))
                    .mapToInt(WertVersionenLeser.Fassung::fassung).max();
            if (fassung.isEmpty()) {
                aus.add(new KennzahlDto.Entscheidung(WertVersionenRegeln.Vorgang.aus(kennung).wort(), kennung, null, null,
                        null, null, null, null, null, null, List.of(WertVersionenRegeln.FEHLT_FASSUNG), null));
                continue;
            }
            MessstelleWerteDto.Entscheidung m = MessstelleWerteService.entscheidung(
                    new WertVersionenRegeln.Schluessel(kennung, fassung.getAsInt()), fassungen, erste.zone());
            aus.add(new KennzahlDto.Entscheidung(m.vorgang(), m.kennung(), m.fassung(), m.status(), m.methode(), m.art(),
                    m.wer(), m.wann(), m.warum(), m.beleg(), m.fehlt(), m.angelegt()));
        }
        return aus;
    }

    /** Die geänderte Berechnung als Entscheidung: wer die Fassung eingetragen hat, wann, mit welcher Begründung. */
    private static KennzahlDto.Entscheidung berechnung(KennzahlRepository.Zeile k, KennzahlRepository.FassungZeile f,
            ZoneId zone) {
        String warum = f.begruendung() == null || f.begruendung().isBlank() ? null : f.begruendung();
        return new KennzahlDto.Entscheidung(VORGANG_BERECHNUNG, k.kennzeichen(), f.nummer(), null, null, f.herkunft(),
                new MessstelleWerteDto.Urheber(f.actorName(), f.actorRolle(), f.actorArt()), iso(f.eingetragenAm(), zone),
                warum, null, warum == null ? List.of(WertVersionenRegeln.FEHLT_WARUM) : List.of(), null);
    }

    /** Die Kennungen der Korrekturen und Ersatzwerte, die ein Beleg nennt — in ihrer Reihenfolge, jede einmal. */
    static List<String> kennungen(String beleg) {
        Set<String> aus = new LinkedHashSet<>();
        if (beleg != null) {
            Matcher m = VORGANG_KENNUNG.matcher(beleg);
            while (m.find()) {
                aus.add(m.group());
            }
        }
        return List.copyOf(aus);
    }

    // ================================================================================ Schritt und Herkunft

    private record Lesung(KennzahlRepository.Zeile k, KennzahlDto.WerteKennzahl kopf, ZoneId zone,
            Map<Integer, String> einheiten) {}

    /** Die Kennzahl (404, auch aus einem fremden Kundenbereich), ihre Zeitzone und die Einheit je Fassung. */
    private Lesung lesung(UUID id) {
        KennzahlDto.Kennzahl heute = kennzahlen.eine(id);
        KennzahlRepository.Zeile k = repo.finde(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        Map<Integer, String> einheiten = new HashMap<>();
        kennzahlen.fassungen(id).fassungen().forEach(f -> einheiten.put(f.nummer(), f.einheit()));
        return new Lesung(k, new KennzahlDto.WerteKennzahl(heute.id(), heute.kennzeichen(), heute.name(),
                heute.rechenform(), heute.einheit(), heute.einheitAnzeige()), kennzahlen.zone(k, kennzahlen.jetzt()),
                einheiten);
    }

    private static KennzahlDto.Wert wert(Lesung l, String art, LocalDate[] s, KennzahlWerteLeser.Zeile z,
            Integer versionen, String grundDesLesers, List<KennzahlWerteLeser.Eingang> eingaenge) {
        String schluessel = BezugsPeriode.schluesselVon(s[0], art);
        String beschriftung = KennzahlRegeln.periodeText(art, schluessel);
        if (z == null) {
            return new KennzahlDto.Wert(s[0], s[1], schluessel, beschriftung, null, null, null, null, null, null,
                    List.of(), null, null, null, null, null, null, grundDesLesers, null, versionen);
        }
        String einheit = l.einheiten().get(z.definitionFassung());
        String berechnetAm = iso(z.berechnetAm(), z.zone());
        Map<String, Object> herkunft = z.version() == null ? null
                : herkunft(l.k(), art, schluessel, z, einheit, berechnetAm, eingaenge);
        return new KennzahlDto.Wert(s[0], s[1], schluessel, beschriftung, KennzahlRegeln.text(z.wert()),
                KennzahlRegeln.text(z.zaehler()), KennzahlRegeln.text(z.nenner()), einheit, z.mengeZustand(),
                z.richtung(), z.kennzeichen(), KennzahlRegeln.text(z.abdeckungProzent()), z.zustand(),
                iso(z.endgueltigAb(), z.zone()), z.version(), z.definitionFassung(), berechnetAm, z.grund(), herkunft,
                versionen);
    }

    /** Die Hülle {@code {satz, fehlt}} — gebaut von der Regel aus der gespeicherten Zeile und ihren Eingängen. */
    static Map<String, Object> herkunft(KennzahlRepository.Zeile k, String art, String schluessel,
            KennzahlWerteLeser.Zeile z, String einheit, String berechnetAm, List<KennzahlWerteLeser.Eingang> eingaenge) {
        KennzahlRegeln.Huelle h = KennzahlRegeln.herkunft(new KennzahlRegeln.HerkunftAntrag(k.kennzeichen(),
                k.rechenform(), z.definitionFassung(), new KennzahlRegeln.Periode(art, schluessel), berechnetAm,
                z.version(), z.anlassKennung(),
                eingaenge.stream().map(e -> new KennzahlRegeln.HerkunftEingang(e.rolle(), e.art(), e.objekt(), e.wert(),
                        e.zaehler(), e.nenner(), e.einheit(), e.mengeZustand(), e.abdeckungProzent(), e.version(),
                        e.fassung(), e.kennzeichen())).toList(),
                new KennzahlRegeln.HerkunftErgebnis(z.wert(), einheit, z.mengeZustand(), z.richtung(), z.grund(),
                        z.abdeckungProzent(), z.kennzeichen())));
        Map<String, Object> huelle = new LinkedHashMap<>();
        huelle.put("satz", h.satz());
        huelle.put("fehlt", h.fehlt());
        return huelle;
    }

    /** Die neueste Zeile — ohne Version die letzte gespeicherte, mit Version n die letzte der Version n. */
    static KennzahlWerteLeser.Zeile waehle(List<KennzahlWerteLeser.Zeile> zeilen, Integer version) {
        for (int i = zeilen.size() - 1; i >= 0; i--) {
            if (version == null || version.equals(zeilen.get(i).version())) {
                return zeilen.get(i);
            }
        }
        return null;
    }

    /** Die höchste Version einer Periode; {@code null}, solange keine gebildet ist. */
    static Integer versionen(List<KennzahlWerteLeser.Zeile> zeilen) {
        return zeilen.stream().map(KennzahlWerteLeser.Zeile::version).filter(Objects::nonNull).max(Integer::compare)
                .orElse(null);
    }

    private static String iso(Instant t, ZoneId zone) {
        return t == null ? null : MessstelleWerteRegeln.iso(t, zone);
    }

    // ================================================================================ Anfrage (streng)

    record Anfrage(String periode, LocalDate von, LocalDate bis, Integer version) {}

    /**
     * {@code periode} ein Wort von {@code periode_art}; {@code von} der erste Tag einer Periode, {@code bis} der LETZTE
     * Tag einer Periode, nicht davor, höchstens {@link #HOECHSTENS_SCHRITTE} Perioden; {@code version} eine ganze Zahl
     * ab 1. Ein weiterer Parameter, ein fehlender oder falsch geformter ist 400 {@code anfrage_ungueltig} mit dem Feld.
     */
    static Anfrage anfrage(Collection<String> parameter, String periode, String von, String bis, String version) {
        unbekannt(parameter, PARAMETER_WERTE);
        String art = periode(periode);
        LocalDate ab = periodenBeginn(art, von);
        LocalDate ende = tag("bis", bis);
        if (ende.isBefore(ab) || !BezugsPeriode.spanneUm(ende, art)[1].equals(ende)
                || schritte(art, ab, ende).size() > HOECHSTENS_SCHRITTE) {
            throw KennzahlAbgelehnt.anfrage("bis");
        }
        return new Anfrage(art, ab, ende, version(version));
    }

    /** Die Historie: {@code periode} und {@code von} (der erste Tag der Periode) — genau eine Periode. */
    static Anfrage historieAnfrage(Collection<String> parameter, String periode, String von) {
        unbekannt(parameter, PARAMETER_VERSIONEN);
        String art = periode(periode);
        LocalDate ab = periodenBeginn(art, von);
        return new Anfrage(art, ab, BezugsPeriode.spanneUm(ab, art)[1], null);
    }

    /** Die Perioden von {@code von} bis {@code bis} — bricht nach einer Periode über der Grenze ab. */
    private static List<LocalDate[]> schritte(String art, LocalDate von, LocalDate bis) {
        List<LocalDate[]> aus = new ArrayList<>();
        for (LocalDate[] s = BezugsPeriode.spanneUm(von, art); !s[0].isAfter(bis) && aus.size() <= HOECHSTENS_SCHRITTE;
                s = BezugsPeriode.spanneUm(s[1].plusDays(1), art)) {
            aus.add(s);
        }
        return aus;
    }

    private static void unbekannt(Collection<String> parameter, Set<String> erlaubt) {
        for (String p : parameter) {
            if (!erlaubt.contains(p)) {
                throw KennzahlAbgelehnt.anfrage(p);
            }
        }
    }

    private static String periode(String text) {
        if (text == null || !KennzahlRegeln.PERIODEN.contains(text)) {
            throw KennzahlAbgelehnt.anfrage("periode");
        }
        return text;
    }

    private static LocalDate periodenBeginn(String art, String text) {
        LocalDate tag = tag("von", text);
        if (!BezugsPeriode.spanneUm(tag, art)[0].equals(tag)) {
            throw KennzahlAbgelehnt.anfrage("von");
        }
        return tag;
    }

    private static LocalDate tag(String feld, String text) {
        if (text == null) {
            throw KennzahlAbgelehnt.anfrage(feld);
        }
        try {
            return LocalDate.parse(text);
        } catch (DateTimeParseException e) {
            throw KennzahlAbgelehnt.anfrage(feld);
        }
    }

    private static Integer version(String text) {
        if (text == null) {
            return null;
        }
        if (!text.matches("[1-9][0-9]{0,8}")) {
            throw KennzahlAbgelehnt.anfrage("version");
        }
        return Integer.valueOf(text);
    }
}
