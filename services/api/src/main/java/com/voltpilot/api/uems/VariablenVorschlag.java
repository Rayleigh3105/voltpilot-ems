package com.voltpilot.api.uems;

import com.voltpilot.api.uems.KennzahlEingangLeser.Gelesen;
import com.voltpilot.api.uems.KennzahlRepository.EingangZeile;
import com.voltpilot.api.uems.KennzahlRepository.FassungZeile;
import com.voltpilot.api.uems.KennzahlService.Aufgeloest;
import com.voltpilot.api.web.dto.KennzahlDto;
import com.voltpilot.api.web.dto.VariablenVorschlagDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Der Variablen-Vorschlag einer Kennzahl aus dem Energieeinsatz (UEMS AP-17 IP-11a, V4, E3 = A, W1). Gelesen werden die
 * Einflussgrößen der laufenden Energieeinsätze, deren Prozess die Geltung der Kennzahl ist — sonst derer, deren Prozess
 * eine Zähler-Messstelle der heute geltenden Fassung zugeordnet ist. Verweise (BZ-…) werden Kandidaten mit ihrer
 * Bezugsgröße, Wortlaute Zeilen „ohne Zahl — erst als Bezugsgröße erfassen“.
 *
 * <p><b>Nur lesen</b> (AP-16 B5 wörtlich: benannt, nie gerechnet): nichts wird übernommen, nichts am Einsatz, an der
 * Kennzahl oder an einer Bezugsgröße verändert. Die Abhängigkeit eines Kandidaten von Variable 1 (G4,
 * {@link VariablenAbhaengigkeit}) ist ein Hinweis; abgelehnt wird erst beim Übernehmen in eine Fassung (IP-11b).
 *
 * <p>Die Monatswerte liest {@link KennzahlEingangLeser} genau wie einen Nenner (wirksame Fassung, nie verteilt).
 * Sichtbarkeit und Zaun: über die Kennzahl ({@link KennzahlService#eine}) — fremd oder verborgen ist 404.
 */
@Service
public class VariablenVorschlag {

    public static final String OHNE_ZAHL = "ohne Zahl — erst als Bezugsgröße erfassen";
    public static final String KEIN_EINSATZ = "Zu dieser Kennzahl gehört kein Energieeinsatz: weder ihr Prozess noch die "
            + "Messstellen ihres Zählers sind einem Energieeinsatz zugeordnet. Es gibt keine Einflussgrößen vorzuschlagen.";
    public static final String STATISCHER_FAKTOR = "Stammdatum — ein statischer Faktor, keine Variable.";

    public static final String BEZUG_PROZESS = "prozess";
    public static final String BEZUG_ZAEHLER = "zaehler_messstellen";
    public static final String BEZUG_KEINER = "keiner";
    public static final List<String> BEZUEGE = List.of(BEZUG_PROZESS, BEZUG_ZAEHLER, BEZUG_KEINER);

    public static final String VARIABLE_1 = "variable_1";
    public static final String VARIABLE = "variable";
    public static final String FAKTOR = "statischer_faktor";
    public static final List<String> VORSCHLAEGE = List.of(VARIABLE_1, VARIABLE, FAKTOR);

    static final Set<String> PARAMETER = Set.of("referenzperiode");
    /** Wie die Referenzperiode einer Bezugsbasis: {@code JJJJ-MM/JJJJ-MM}, beide Monate eingeschlossen. */
    private static final Pattern REFERENZPERIODE = Pattern.compile("\\d{4}-\\d{2}/\\d{4}-\\d{2}");
    static final int HOECHSTENS_MONATE = 120;

    private final KennzahlService kennzahlen;
    private final KennzahlRepository repo;
    private final EnergieeinsatzRepository einsaetze;
    private final BezugsgroesseRepository bezugsgroessen;
    private final KennzahlEingangLeser leser;
    private final JdbcTemplate jdbc;

    public VariablenVorschlag(KennzahlService kennzahlen, KennzahlRepository repo, EnergieeinsatzRepository einsaetze,
            BezugsgroesseRepository bezugsgroessen, KennzahlEingangLeser leser, JdbcTemplate jdbc) {
        this.kennzahlen = kennzahlen;
        this.repo = repo;
        this.einsaetze = einsaetze;
        this.bezugsgroessen = bezugsgroessen;
        this.leser = leser;
        this.jdbc = jdbc;
    }

    /**
     * Ohne {@code referenzperiode} die zwölf abgeschlossenen Monate vor dem laufenden (Zeitzone der Geltung) — die
     * Mindestlänge einer Referenzperiode als Startwert.
     */
    public VariablenVorschlagDto.Vorschlag vorschlag(UUID id, Collection<String> parameter, String referenzperiode) {
        parameter.stream().filter(p -> !PARAMETER.contains(p)).findFirst().ifPresent(p -> {
            throw KennzahlAbgelehnt.anfrage(p);
        });
        KennzahlDto.Kennzahl heute = kennzahlen.eine(id);
        KennzahlRepository.Zeile k = repo.finde(id)
                .orElseThrow(() -> KennzahlAbgelehnt.von(KennzahlAbgelehnt.Ablehnung.NICHT_GEFUNDEN));
        LocalDate tag = LocalDate.ofInstant(kennzahlen.jetzt(), kennzahlen.zone(k, kennzahlen.jetzt()));
        YearMonth[] periode = referenzperiode(referenzperiode, YearMonth.from(tag));
        KennzahlDto.WerteKennzahl kopf = new KennzahlDto.WerteKennzahl(heute.id(), heute.kennzeichen(), heute.name(),
                heute.rechenform(), heute.einheit(), heute.einheitAnzeige());
        String text = periode[0] + "/" + periode[1];

        KennzahlService.Katalog kat = kennzahlen.katalog();
        List<EingangZeile> eingaenge = kat.fassungAm(id, tag).map(FassungZeile::id).map(kat::eingaenge).orElse(List.of());

        String bezug = BEZUG_KEINER;
        List<EnergieeinsatzRepository.Zeile> gelesen = List.of();
        if (BEZUG_PROZESS.equals(k.geltungArt())) {
            gelesen = laufende(einsaetze.jeProzess(k.geltungId()));
            bezug = gelesen.isEmpty() ? BEZUG_KEINER : BEZUG_PROZESS;
        }
        if (gelesen.isEmpty()) {
            List<UUID> zaehler = eingaenge.stream().filter(e -> "zaehler".equals(e.rolle())
                    && KennzahlRegeln.MESSSTELLE.equals(e.art())).map(EingangZeile::objektId).toList();
            gelesen = laufende(prozesseDerMessstellen(zaehler, tag).stream()
                    .flatMap(p -> einsaetze.jeProzess(p).stream()).toList());
            bezug = gelesen.isEmpty() ? BEZUG_KEINER : BEZUG_ZAEHLER;
        }

        Optional<KennzahlRepository.BezugsgroesseZeile> nenner = eingaenge.stream()
                .filter(e -> "nenner".equals(e.rolle()) && KennzahlRegeln.BEZUGSGROESSE.equals(e.art()))
                .map(EingangZeile::objektId).findFirst().flatMap(repo::bezugsgroesse);
        VariablenVorschlagDto.Variable variable1 = nenner.map(b -> variable(b.id())).orElse(null);
        Map<String, BigDecimal> werte1 = nenner.filter(b -> !KennzahlRegeln.STAMMDATUM.equals(b.wertart()))
                .map(b -> monate(b, periode)).orElse(null);

        List<VariablenVorschlagDto.Einsatz> einsatzListe = new ArrayList<>();
        Map<UUID, List<String>> nennungen = new LinkedHashMap<>();
        Map<UUID, String> artJeVerweis = new LinkedHashMap<>();
        List<VariablenVorschlagDto.OhneZahl> ohneZahl = new ArrayList<>();
        for (EnergieeinsatzRepository.Zeile e : gelesen) {
            einsatzListe.add(new VariablenVorschlagDto.Einsatz(e.id(), e.kennzeichen(), e.name(), e.traeger()));
            for (EnergieeinsatzRepository.EinflussZeile f : einsaetze.einflussgroessen(e.id(), false)) {
                if (f.bezugsgroesseId() == null) {
                    ohneZahl.add(new VariablenVorschlagDto.OhneZahl(f.wortlaut(), f.art(), e.kennzeichen(), OHNE_ZAHL));
                    continue;
                }
                List<String> von = nennungen.computeIfAbsent(f.bezugsgroesseId(), x -> new ArrayList<>());
                if (!von.contains(e.kennzeichen())) {
                    von.add(e.kennzeichen());
                }
                artJeVerweis.putIfAbsent(f.bezugsgroesseId(), f.art());
            }
        }

        List<VariablenVorschlagDto.Kandidat> kandidaten = new ArrayList<>();
        nennungen.forEach((bz, von) -> repo.bezugsgroesse(bz).ifPresent(b -> kandidaten.add(
                kandidat(b, artJeVerweis.get(bz), List.copyOf(von), variable1, werte1, periode))));

        return new VariablenVorschlagDto.Vorschlag(kopf, k.geltungArt(), bezug, text, List.copyOf(einsatzListe),
                variable1, List.copyOf(kandidaten), List.copyOf(ohneZahl), BEZUG_KEINER.equals(bezug) ? KEIN_EINSATZ : null);
    }

    private VariablenVorschlagDto.Kandidat kandidat(KennzahlRepository.BezugsgroesseZeile b, String einflussArt,
            List<String> von, VariablenVorschlagDto.Variable variable1, Map<String, BigDecimal> werte1,
            YearMonth[] periode) {
        VariablenVorschlagDto.Variable v = variable(b.id());
        if (variable1 != null && variable1.id().equals(b.id())) {
            return new VariablenVorschlagDto.Kandidat(v, einflussArt, VARIABLE_1, von, null, null);
        }
        if (KennzahlRegeln.STAMMDATUM.equals(b.wertart())) {
            return new VariablenVorschlagDto.Kandidat(v, einflussArt, FAKTOR, von, null, STATISCHER_FAKTOR);
        }
        VariablenAbhaengigkeit.Ergebnis g = werte1 == null ? VariablenAbhaengigkeit.ohneVariable1()
                : VariablenAbhaengigkeit.pruefe(paare(werte1, monate(b, periode)));
        String satz = VariablenAbhaengigkeit.ABHAENGIG.equals(g.ergebnis())
                ? VariablenAbhaengigkeit.abhaengigSatz(b.name(), variable1.name(), g.r()) : null;
        return new VariablenVorschlagDto.Kandidat(v, einflussArt, VARIABLE, von,
                new VariablenVorschlagDto.Abhaengigkeit(g.ergebnis(), g.r(), g.paare(), g.grund(),
                        variable1 == null ? null : variable1.kennzeichen(), VariablenAbhaengigkeit.SCHWELLE),
                satz);
    }

    /** Die Monatspaare: nur Monate, in denen BEIDE einen Wert haben — nie ergänzt, nie verteilt. */
    static List<VariablenAbhaengigkeit.Paar> paare(Map<String, BigDecimal> x, Map<String, BigDecimal> y) {
        List<VariablenAbhaengigkeit.Paar> aus = new ArrayList<>();
        x.forEach((monat, wx) -> {
            BigDecimal wy = y.get(monat);
            if (wx != null && wy != null) {
                aus.add(new VariablenAbhaengigkeit.Paar(wx, wy));
            }
        });
        return aus;
    }

    /** Je Monat der Referenzperiode der Periodenwert, gelesen wie ein Nenner; {@code null} = kein Wert. */
    private Map<String, BigDecimal> monate(KennzahlRepository.BezugsgroesseZeile b, YearMonth[] periode) {
        Aufgeloest x = new Aufgeloest("nenner", KennzahlRegeln.BEZUGSGROESSE, b.id(), b.kennzeichen(), b.name(),
                b.einheit(), null, b.wertart(), b.periodeArt(), null, b, null);
        Map<String, BigDecimal> aus = new LinkedHashMap<>();
        for (Map.Entry<String, Gelesen> g : leser.lies(x, "monat", periode[0].atDay(1), periode[1].atEndOfMonth())
                .entrySet()) {
            aus.put(g.getKey(), g.getValue().eingang().wert());
        }
        return aus;
    }

    private VariablenVorschlagDto.Variable variable(UUID id) {
        BezugsgroesseRepository.Zeile b = bezugsgroessen.finde(id).orElseThrow();
        Boolean kanal = jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung WHERE bezugsgroesse_id = ?)", Boolean.class, id);
        return new VariablenVorschlagDto.Variable(b.id(), b.kennzeichen(), b.name(), b.art(), b.wertart(), b.einheit(),
                b.periodeArt(), b.hatWerte(), Boolean.TRUE.equals(kanal));
    }

    /** Die Prozesse, denen eine der Messstellen am Tag direkt zugeordnet ist (unter der RLS der Anwendungsrolle). */
    private List<UUID> prozesseDerMessstellen(List<UUID> messstellen, LocalDate tag) {
        if (messstellen.isEmpty()) {
            return List.of();
        }
        return jdbc.queryForList("SELECT DISTINCT p.prozess_id FROM messstelle_prozess p "
                + "WHERE p.messstelle_id = ANY (?::uuid[]) AND p.gueltig_ab <= ? "
                + "AND (p.gueltig_bis IS NULL OR p.gueltig_bis >= ?) ORDER BY p.prozess_id", UUID.class,
                messstellen.stream().map(UUID::toString).toArray(String[]::new), tag, tag);
    }

    /** Laufende Einsätze (nicht beendet), einmal je Einsatz, nach Kennzeichen-Nummer. */
    private static List<EnergieeinsatzRepository.Zeile> laufende(List<EnergieeinsatzRepository.Zeile> alle) {
        Map<UUID, EnergieeinsatzRepository.Zeile> je = new LinkedHashMap<>();
        alle.stream().filter(e -> e.gueltigBis() == null).forEach(e -> je.putIfAbsent(e.id(), e));
        return je.values().stream().sorted(Comparator.comparingLong(VariablenVorschlag::nummer)).toList();
    }

    private static long nummer(EnergieeinsatzRepository.Zeile e) {
        return Long.parseLong(e.kennzeichen().substring("EE-".length()));
    }

    static YearMonth[] referenzperiode(String text, YearMonth laufend) {
        if (text == null) {
            return new YearMonth[] {laufend.minusMonths(12), laufend.minusMonths(1)};
        }
        if (!REFERENZPERIODE.matcher(text).matches()) {
            throw KennzahlAbgelehnt.anfrage("referenzperiode");
        }
        try {
            YearMonth von = YearMonth.parse(text.substring(0, 7));
            YearMonth bis = YearMonth.parse(text.substring(8));
            if (bis.isBefore(von) || von.plusMonths(HOECHSTENS_MONATE).isBefore(bis.plusMonths(1))) {
                throw KennzahlAbgelehnt.anfrage("referenzperiode");
            }
            return new YearMonth[] {von, bis};
        } catch (DateTimeParseException x) {
            throw KennzahlAbgelehnt.anfrage("referenzperiode");
        }
    }
}
