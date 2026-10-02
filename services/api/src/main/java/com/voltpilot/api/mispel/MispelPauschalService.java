package com.voltpilot.api.mispel;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import com.voltpilot.api.mispel.FoerderwegService.Ansicht;
import com.voltpilot.api.mispel.MispelPauschalRechenwerk.Ergebnis;
import com.voltpilot.api.mispel.MispelPauschalRechenwerk.Rumpfjahr;
import com.voltpilot.api.mispel.MispelPauschalRechenwerk.Viertelstunde;
import com.voltpilot.api.mispel.MispelPauschalRepository.Zeile;
import com.voltpilot.api.repo.MispelMarktdatenRepository;
import com.voltpilot.api.repo.MispelMarktdatenRepository.AwHerkunft;
import com.voltpilot.api.repo.MispelMarktdatenRepository.AwViertelstunde;
import com.voltpilot.api.repo.MispelMarktdatenRepository.SpotViertelstunde;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import com.voltpilot.api.uems.ZaehlerrolleService;
import com.voltpilot.api.uems.ZaehlerrolleService.AnlageStand;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * MiSpeL MP-25: der Jahreslauf der Pauschaloption je Anlage (Einspeisestelle) — Muster des Monatslaufs der
 * Abgrenzung ({@link MispelAbgrenzungService}, MP-8). Liest den Förderweg ({@link FoerderwegService}, MP-5: an jedem
 * Tag „Marktprämie mit Pauschaloption“, AW-Regel der Anlage aus MP-12b), den Zweirichtungszähler Z1
 * ({@link ZaehlerrolleService#anlage}, MP-6 — ein Zähler genügt, A2 S. 27) mit seinen Viertelstundenmengen
 * ({@link MispelZaehlerLeser}), SP¼ und AW¼ &gt; 0 ({@link MispelMarktdatenRepository}, MP-7), rechnet mit
 * {@link MispelPauschalRechenwerk} und speichert das Ergebnis mit dem Nachweis-Datensatz als Fassung in
 * {@code mispel_pauschal_jahr}.
 *
 * <p><b>Stand (E4 = C wie MP-8):</b> {@code endgueltig} nur, wenn jede Viertelstunde des (Rumpf-)Jahres gerechnet ist,
 * jeder Zähler die Wertequelle „Messstellenbetreiber“ und das Urteil „tauglich“ trägt, alle Viertelstunden endgültig
 * sind, AW¼ aus der Liste der ÜNB stammt, das (Rumpf-)Jahr vorbei ist — und die Pauschaloption überhaupt gilt: erst ab
 * dem Monatsersten nach der EU-Genehmigung (T S. 3, Tenorziffer 9 b; A2 S. 20, Voraussetzung 10), hier der Schalter
 * {@code voltpilot.mispel.pauschaloption-ab} (wie {@link FoerderwegService}). Bis dahin rechnet der Lauf (E7 = B),
 * bleibt aber {@code vorlaeufig} mit {@code eu_genehmigung_ausstehend}. Eine fehlende Viertelstunde ist eine Lücke.
 *
 * <p>Formelsatz und Stammdaten (Pinst, SKinst, Painst/Pbinst) kommen heute vom Aufrufer ({@link Vorgaben}) — die
 * Förderweg-Fassung trägt nur A-Formelsätze. Ein Rumpfjahr gibt der Aufrufer als Tage {@code [rumpfVon, rumpfBis]}
 * (einschließlich) vor; der Tag der Änderung zählt zum Rumpfjahr davor (A2 S. 53, TR). Sind Messeinrichtungen für das
 * A-Messkonzept vorhanden (Z2/Z3), ist die Pauschaloption ausgeschlossen (A2 S. 22, Abschn. 3.2.3).
 */
@Service
public class MispelPauschalService {

    /** Die Fassung dieses Rechenwerks; steigt mit jeder Änderung an Rechenweg oder Nachweis-Aufbau. */
    public static final String RECHENWERK_VERSION = "MP-25/1";
    /** Der Vertrag und seine Fassung ({@code schema_version} der Vektor-Datei). */
    public static final String VERTRAG = "docs/contracts/v2/mispel-pauschal.md";
    public static final String VERTRAG_VERSION = "1.0";

    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int LUECKEN_IM_NACHWEIS = 96;

    /**
     * Was der Lauf von der Anlage wissen muss: der Formelsatz (P1, P2, P3, P4, P4-Variante; P5 braucht den Zähler ZW,
     * den MP-6 noch nicht kennt), die Stammdaten des Formelsatzes, ungeförderte AW-Eingänge (A2 S. 40, S. 50), die
     * AW-Regel der Anlage b in P4/P4-Variante (die Förderweg-Regel ist die der Anlage a), optional ein Rumpfjahr
     * {@code [rumpfVon, rumpfBis]} in Tagen ({@code null} = 1. Januar bzw. 31. Dezember) und für P4/P4-Variante/P5
     * der Basisfall der Abwandlung ({@code null} = P1, A2 S. 34, S. 43, S. 49).
     */
    public record Vorgaben(String formelsatz, Map<String, BigDecimal> stammdaten, Set<String> ungefoerdert,
            String awRegelB, LocalDate rumpfVon, LocalDate rumpfBis, String basisfall) {

        public static Vorgaben von(String formelsatz, Map<String, BigDecimal> stammdaten) {
            return new Vorgaben(formelsatz, stammdaten, Set.of(), null, null, null, null);
        }
    }

    /** Ein Lauf: die gespeicherte Fassung, das Ergebnis und die Gründe für „vorläufig“; {@code neu} = angehängt. */
    public record Lauf(Zeile zeile, boolean neu, Ergebnis ergebnis, List<String> gruende) {}

    private final ZaehlerrolleService zaehlerrollen;
    private final MispelMarktdatenRepository marktdaten;
    private final MispelPauschalRepository laeufe;
    private final FoerderwegService foerderwege;
    private final LocalDate pauschaloptionAb;
    private MispelZaehlerLeser leser;
    private Clock uhr = Clock.systemUTC();

    public MispelPauschalService(ZaehlerrolleService zaehlerrollen, MispelMarktdatenRepository marktdaten,
            MispelPauschalRepository laeufe, FoerderwegService foerderwege, MispelZaehlerLeser leser,
            @Value("${voltpilot.mispel.pauschaloption-ab:}") String pauschaloptionAb) {
        this.zaehlerrollen = zaehlerrollen;
        this.marktdaten = marktdaten;
        this.laeufe = laeufe;
        this.foerderwege = foerderwege;
        this.leser = leser;
        this.pauschaloptionAb = pauschaloptionAb == null || pauschaloptionAb.isBlank() ? null
                : LocalDate.parse(pauschaloptionAb.trim());
    }

    /** Nur für Tests: die Uhr, an der „Zeitraum vorbei“ gemessen wird. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Nur für Tests: die Zählerwerte ohne die Verdichtungskette der Messreihen. */
    void leserSetzen(MispelZaehlerLeser leser) {
        this.leser = leser;
    }

    /** Die gespeicherten Läufe eines Kalenderjahres (für Nachweis, Optimierer-Jahreszustand MP-26, Portal MP-27). */
    public List<Zeile> laeufe(UUID siteId, int jahr) {
        return laeufe.desJahres(siteId, jahr);
    }

    private record Zaehler(String eingang, ZaehlerrolleRegeln.Knoten knoten, String urteil) {}

    public Lauf jahreslauf(UUID siteId, int jahr, Vorgaben v) {
        String fs = v.formelsatz();
        if (!MispelPauschalRechenwerk.FORMELSAETZE.contains(fs)) {
            throw new MispelPauschalAbgelehnt("formelsatz_unbekannt", "Formelsatz „" + fs + "“ ist nicht im Umfang "
                    + "(Anlage 2, Vertrag mispel-pauschal.md): " + String.join(", ", MispelPauschalRechenwerk.FORMELSAETZE)
                    + ".");
        }
        String basisfall;
        try {
            basisfall = MispelPauschalRechenwerk.basisfallVon(fs, v.basisfall());
        } catch (IllegalArgumentException ex) {
            throw new MispelPauschalAbgelehnt("vorgaben_ungueltig", ex.getMessage());
        }
        LocalDate vonTag = v.rumpfVon() != null ? v.rumpfVon() : LocalDate.of(jahr, 1, 1);
        LocalDate bisTag = v.rumpfBis() != null ? v.rumpfBis() : LocalDate.of(jahr, 12, 31);
        if (vonTag.getYear() != jahr || bisTag.getYear() != jahr || bisTag.isBefore(vonTag)) {
            throw new MispelPauschalAbgelehnt("vorgaben_ungueltig", "Ein Rumpfjahr liegt in seinem Kalenderjahr "
                    + "(Anlage 2 S. 53, Abschn. 9.1): " + vonTag + " bis " + bisTag + " passt nicht zu " + jahr + ".");
        }
        boolean rumpf = v.rumpfVon() != null || v.rumpfBis() != null;
        Rumpfjahr rumpfjahr = rumpf ? new Rumpfjahr(vonTag, bisTag, v.stammdaten()) : null;
        Instant von = vonTag.atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
        Instant bis = bisTag.plusDays(1).atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
        Set<String> ohne = v.ungefoerdert() == null ? Set.of() : v.ungefoerdert();

        String awRegel = foerderweg(siteId, vonTag, bisTag);
        List<Zaehler> zaehler = zaehler(siteId, fs, vonTag, bisTag);
        Map<String, Map<Instant, MispelZaehlerLeser.Menge>> mengen = new LinkedHashMap<>();
        try {
            for (Zaehler z : zaehler) {
                mengen.put(z.eingang(), leser.lesen(z.knoten().kennzeichen(), von, bis));
            }
        } catch (MispelAbgrenzungAbgelehnt ex) {
            throw new MispelPauschalAbgelehnt(ex.code(), ex.getMessage());
        }
        Map<Instant, BigDecimal> sp = new LinkedHashMap<>();
        for (SpotViertelstunde s : marktdaten.spotmarktpreise(MispelAbgrenzungService.GEBOTSZONE, von, bis)) {
            sp.put(s.beginn(), s.spCtKwh());
        }
        Map<String, String> awRegeln = awRegeln(fs, awRegel, v, ohne);
        Map<String, Map<Instant, AwViertelstunde>> aw = new LinkedHashMap<>();
        awRegeln.forEach((eingang, regel) -> {
            Map<Instant, AwViertelstunde> je = new LinkedHashMap<>();
            if (regel != null) {
                marktdaten.awZeiten(regel, MispelAbgrenzungService.GEBOTSZONE, von, bis).viertelstunden()
                        .forEach(a -> je.put(a.beginn(), a));
            }
            aw.put(eingang, je);
        });

        // Die Viertelstunden des (Rumpf-)Jahres: vollständig gerechnet oder Lücke — nie als Null.
        List<Viertelstunde> eingaenge = new ArrayList<>();
        Map<String, List<String>> luecken = new TreeMap<>();
        boolean alleEndgueltig = true;
        boolean awAmtlich = true;
        int erwartet = 0;
        for (Instant t = von; t.isBefore(bis); t = t.plus(VIERTELSTUNDE)) {
            erwartet++;
            List<String> fehlt = new ArrayList<>();
            Map<String, BigDecimal> z = new LinkedHashMap<>();
            for (Zaehler zl : zaehler) {
                MispelZaehlerLeser.Menge m = mengen.get(zl.eingang()).get(t);
                if (m == null) {
                    fehlt.add(zl.eingang());
                } else {
                    z.put(zl.eingang(), m.kwh());
                    alleEndgueltig &= m.endgueltig();
                }
            }
            BigDecimal preis = sp.get(t);
            if (preis == null) {
                fehlt.add("SP¼");
            }
            Map<String, Boolean> a = new LinkedHashMap<>();
            for (Map.Entry<String, String> r : awRegeln.entrySet()) {
                if (r.getValue() == null) {
                    // W4-Rückfall ohne AW-Regel der Anlage: „AW¼ = 0 bei SP¼ < 0“, nur vorläufig (Bauplan § 8, W4).
                    if (preis != null) {
                        a.put(r.getKey(), preis.signum() >= 0);
                    }
                    awAmtlich = false;
                    continue;
                }
                AwViertelstunde q = aw.get(r.getKey()).get(t);
                if (q == null || q.awGroesserNull() == null) {
                    fehlt.add(r.getKey());
                } else {
                    a.put(r.getKey(), q.awGroesserNull());
                    awAmtlich &= q.herkunft() == AwHerkunft.UENB_LISTE;
                }
            }
            if (fehlt.isEmpty()) {
                eingaenge.add(new Viertelstunde(OffsetDateTime.ofInstant(t, MispelAbgrenzungRechenwerk.BERLIN), z, a,
                        preis));
            } else {
                luecken.computeIfAbsent(String.join("+", fehlt), k -> new ArrayList<>())
                        .add(OffsetDateTime.ofInstant(t, MispelAbgrenzungRechenwerk.BERLIN).toString());
            }
        }
        if (eingaenge.isEmpty()) {
            throw new MispelPauschalAbgelehnt("keine_werte", "Für " + vonTag + " bis " + bisTag + " liegt keine "
                    + "vollständige Viertelstunde vor — ohne Werte rechnet der Lauf nichts (unbekannt ist keine Null).");
        }

        Ergebnis e;
        try {
            e = MispelPauschalRechenwerk.rechne(fs, eingaenge, rumpf ? null : v.stammdaten(),
                    rumpf ? List.of(rumpfjahr) : null, ohne, basisfall);
        } catch (IllegalArgumentException ex) {
            throw new MispelPauschalAbgelehnt("vorgaben_ungueltig", ex.getMessage());
        }
        String schluessel = rumpf ? rumpfjahr.schluessel() : String.valueOf(jahr);

        String wertequelle = zaehler.stream()
                .allMatch(z -> MispelAbgrenzungService.MSB.equals(z.knoten().angaben().wertequelle()))
                ? MispelAbgrenzungService.MSB : MispelAbgrenzungService.GERAET;
        List<String> gruende = new ArrayList<>();
        if (pauschaloptionAb == null || vonTag.isBefore(pauschaloptionAb)) {
            gruende.add("eu_genehmigung_ausstehend");
        }
        if (!luecken.isEmpty()) {
            gruende.add("luecken");
        }
        if (MispelAbgrenzungService.GERAET.equals(wertequelle)) {
            gruende.add("wertequelle_geraet");
        }
        zaehler.stream().filter(z -> !"tauglich".equals(z.urteil()))
                .forEach(z -> gruende.add("zaehler_" + z.urteil() + ":" + z.knoten().kennzeichen()));
        if (!alleEndgueltig) {
            gruende.add("viertelstunden_vorlaeufig");
        }
        if (awRegeln.containsValue(null)) {
            gruende.add("aw_regel_fehlt");
        }
        if (!awAmtlich) {
            gruende.add("aw_rueckfall");
        }
        if (uhr.instant().isBefore(bis)) {
            gruende.add("zeitraum_offen");
        }
        String stand = gruende.isEmpty() ? MispelAbgrenzungService.ENDGUELTIG : MispelAbgrenzungService.VORLAEUFIG;

        String nachweis = nachweis(siteId, jahr, schluessel, vonTag, bisTag, von, bis, v, awRegeln, zaehler, stand,
                gruende, wertequelle, erwartet, eingaenge, luecken, e);
        String pruefsumme = MispelAbgrenzungService.sha256(nachweis);
        UUID tenant = TenantContext.get();
        Optional<Zeile> letzte = laeufe.letzte(siteId, vonTag);
        if (letzte.isPresent() && letzte.get().pruefsumme().equals(pruefsumme)) {
            return new Lauf(letzte.get(), false, e, List.copyOf(gruende));
        }
        Zeile z = new Zeile(null, siteId, jahr, vonTag, bisTag, von, bis, letzte.map(Zeile::fassung).orElse(0) + 1, fs,
                stand, wertequelle, erwartet, eingaenge.size(), RECHENWERK_VERSION, VERTRAG_VERSION, nachweis,
                pruefsumme, uhr.instant());
        UUID id = laeufe.anhaengen(tenant, z);
        return new Lauf(new Zeile(id, z.siteId(), z.jahr(), z.tagVon(), z.tagBis(), z.zeitraumVon(), z.zeitraumBis(),
                z.fassung(), z.formelsatz(), z.stand(), z.wertequelle(), z.viertelstundenErwartet(),
                z.viertelstundenGerechnet(), z.rechenwerkVersion(), z.vertragVersion(), z.nachweis(), z.pruefsumme(),
                z.gerechnetAm()), true, e, List.copyOf(gruende));
    }

    /**
     * Der Förderweg an jedem Tag des Zeitraums ist „Marktprämie mit Pauschaloption“ (A2 S. 18–20, Voraussetzungen 4
     * und 7; Tenorziffer 5) — geprüft am ersten Tag und an jedem Tag, an dem eine Fassung beginnt. Liefert die
     * AW-Regel der Anlage ({@code null} = keine eingetragen, W4-Rückfall); sie wechselt im Zeitraum nicht.
     */
    private String foerderweg(UUID siteId, LocalDate vonTag, LocalDate bisTag) {
        Ansicht erste = foerderwege.ansicht(siteId, vonTag);
        if (erste == null) {
            throw new MispelPauschalAbgelehnt("anlage_unbekannt", "Die Anlage gibt es nicht.");
        }
        Set<LocalDate> tage = new TreeSet<>();
        tage.add(vonTag);
        erste.fassungen().stream().filter(f -> !f.fassung().aufgehoben()).map(f -> f.fassung().gueltigAb())
                .filter(d -> d.isAfter(vonTag) && !d.isAfter(bisTag)).forEach(tage::add);
        Set<String> regeln = new LinkedHashSet<>();
        for (LocalDate tag : tage) {
            Ansicht a = tag.equals(vonTag) ? erste : foerderwege.ansicht(siteId, tag);
            if (a.angaben() == null || a.angaben().foerderweg() != Foerderweg.MARKTPRAEMIE_PAUSCHAL) {
                throw new MispelPauschalAbgelehnt("foerderweg_nicht_pauschal", "Am " + tag + " ist der Förderweg der "
                        + "Anlage „" + (a.angaben() == null ? "unbestimmt" : a.angaben().foerderweg().begriff())
                        + "“, nicht „Marktprämie mit Pauschaloption“ (Anlage 2 S. 18–20, Tenorziffer 5) — für die Tage "
                        + "in der Pauschaloption gilt ein Rumpfjahr (Anlage 2 S. 52).");
            }
            regeln.add(Objects.toString(a.angaben().awRegel(), ""));
        }
        if (regeln.size() > 1) {
            throw new MispelPauschalAbgelehnt("aw_regel_wechselt", "Die AW-Regel der Anlage wechselt zwischen " + vonTag
                    + " und " + bisTag + " (" + String.join(", ", regeln) + ") — der Lauf liest eine Regel je (Rumpf-)Jahr.");
        }
        String r = regeln.iterator().next();
        return r.isEmpty() ? null : r;
    }

    /** Die Zähler des Formelsatzes am ersten und letzten Tag; sie müssen an beiden dieselben Messstellen sein. */
    private List<Zaehler> zaehler(UUID siteId, String fs, LocalDate erster, LocalDate letzter) {
        AnlageStand anfang = zaehlerrollen.anlage(siteId, erster);
        AnlageStand ende = zaehlerrollen.anlage(siteId, letzter);
        for (AnlageStand stand : List.of(anfang, ende)) {
            Set<String> genauer = new TreeSet<>();
            stand.zaehler().keySet().stream().filter(g -> g.startsWith("Z2") || g.startsWith("Z3"))
                    .forEach(genauer::add);
            if (!genauer.isEmpty()) {
                throw new MispelPauschalAbgelehnt("messkonzept_anlage_1", "Am " + stand.am() + " trägt die Anlage "
                        + "die Zähler " + String.join(", ", genauer) + " — „Keine vereinfachte pauschale Bestimmung nach "
                        + "Anlage 2 bei Messwerten für die genauere Bestimmung nach Anlage 1“ (Anlage 2 S. 22, Abschn. "
                        + "3.2.3); es gilt die Abgrenzungsoption.");
            }
        }
        List<Zaehler> out = new ArrayList<>();
        List<String> fehlt = new ArrayList<>();
        for (String eingang : MispelPauschalRechenwerk.zaehlerEingaenge(fs)) {
            String groesse = eingang.substring(0, eingang.length() - 1);
            ZaehlerrolleRegeln.Knoten k = anfang.zaehler().get(groesse);
            if (k == null) {
                fehlt.add(groesse);
                continue;
            }
            ZaehlerrolleRegeln.Knoten k2 = ende.zaehler().get(groesse);
            if (k2 == null) {
                throw new MispelPauschalAbgelehnt("bestimmungsrelevante_aenderung", "Der Zähler " + groesse
                        + " fällt zwischen " + erster + " und " + letzter + " weg — für die Teile gelten Rumpfjahre "
                        + "(Anlage 2 S. 51–52, Abschn. 9).");
            }
            if (!k2.id().equals(k.id()) || !Objects.equals(k2.angaben(), k.angaben())) {
                throw new MispelPauschalAbgelehnt("zaehlerwechsel_im_zeitraum", "Der Zähler " + groesse
                        + " wechselt zwischen " + erster + " und " + letzter + " ohne neues Messkonzept — kein "
                        + "Rumpfjahr (Anlage 2 S. 52–53), aber der Lauf liest ihn noch nicht abschnittsweise.");
            }
            String urteil = ZaehlerrolleRegeln.urteil(k.angaben().rolle(),
                    ZaehlerrolleRegeln.befundeZu(k.kennzeichen(), anfang.befunde()));
            out.add(new Zaehler(eingang, k, urteil));
        }
        if (!fehlt.isEmpty()) {
            throw new MispelPauschalAbgelehnt("zaehler_fehlt", "Formelsatz " + fs + " braucht die Zähler "
                    + String.join(", ", fehlt) + " am " + erster + " (Anlage 2 S. 27" + (MispelPauschalRechenwerk.P5
                    .equals(fs) ? ", S. 45–46: ZW misst die Netzeinspeisung" : "") + ") — keine Messstelle der Anlage "
                    + "trägt diese Größe der Festlegung.");
        }
        return out;
    }

    /** Die AW-Regel je geförderter AW-Eingang; {@code null} = keine Regel eingetragen (W4-Rückfall). */
    private static Map<String, String> awRegeln(String fs, String awRegel, Vorgaben v, Set<String> ohne) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String eingang : MispelPauschalRechenwerk.awEingaenge(fs)) {
            if (ohne.contains(eingang)) {
                continue;
            }
            String regel = eingang.equals("AWb¼") ? v.awRegelB() : awRegel;
            if (eingang.equals("AWb¼") && (regel == null || !MispelMarktdatenRepository.REGELN.contains(regel))) {
                throw new MispelPauschalAbgelehnt("vorgaben_ungueltig", "Für AWb¼ fehlt die AW-Regel der Anlage b "
                        + "(eine von " + new TreeSet<>(MispelMarktdatenRepository.REGELN) + ", Anlage 2 S. 36–37).");
            }
            out.put(eingang, regel);
        }
        return out;
    }

    // ------------------------------------------------------------------ der Nachweis-Datensatz

    private String nachweis(UUID siteId, int jahr, String schluessel, LocalDate vonTag, LocalDate bisTag, Instant von,
            Instant bis, Vorgaben v, Map<String, String> awRegeln, List<Zaehler> zaehler, String stand,
            List<String> gruende, String wertequelle, int erwartet, List<Viertelstunde> eingaenge,
            Map<String, List<String>> luecken, Ergebnis e) {
        Map<String, Object> n = new LinkedHashMap<>();
        n.put("festlegung", "BNetzA, Marktintegration von Speichern und Ladepunkten (MiSpeL), Az. 618-25-02, "
                + "Beschluss 2026-10-01, Anlage 2 – Pauschaloption");
        n.put("anwendbar_ab", pauschaloptionAb == null ? null : pauschaloptionAb.toString());
        n.put("vertrag", VERTRAG);
        n.put("vertrag_version", VERTRAG_VERSION);
        n.put("rechenwerk_version", RECHENWERK_VERSION);
        n.put("anlage", siteId.toString());
        n.put("jahr", jahr);
        n.put("schluessel", schluessel);
        // Geordnete Maps, nie Map.of: dessen Reihenfolge wechselt von JVM zu JVM, und mit ihr Text und Prüfsumme.
        Map<String, Object> zeitraum = new LinkedHashMap<>();
        zeitraum.put("tag_von", vonTag.toString());
        zeitraum.put("tag_bis", bisTag.toString());
        zeitraum.put("von", OffsetDateTime.ofInstant(von, MispelAbgrenzungRechenwerk.BERLIN).toString());
        zeitraum.put("bis", OffsetDateTime.ofInstant(bis, MispelAbgrenzungRechenwerk.BERLIN).toString());
        n.put("zeitraum", zeitraum);
        n.put("zeitzone", MispelAbgrenzungRechenwerk.BERLIN.getId());
        n.put("formelsatz", v.formelsatz());
        n.put("basisfall", MispelPauschalRechenwerk.basisfallVon(v.formelsatz(), v.basisfall()));
        Map<String, String> stamm = new TreeMap<>();
        if (v.stammdaten() != null) {
            v.stammdaten().forEach((k, w) -> stamm.put(k, w.stripTrailingZeros().toPlainString()));
        }
        n.put("stammdaten", stamm);
        n.put("ungefoerdert", v.ungefoerdert() == null ? List.of() : v.ungefoerdert().stream().sorted().toList());
        n.put("stand", stand);
        n.put("stand_gruende", gruende);
        n.put("wertequelle", wertequelle);
        List<Map<String, Object>> zl = new ArrayList<>();
        for (Zaehler z : zaehler) {
            Map<String, Object> m = new LinkedHashMap<>();
            ZaehlerrolleRegeln.Angaben a = z.knoten().angaben();
            m.put("eingang", z.eingang());
            m.put("messstelle", z.knoten().kennzeichen());
            m.put("rolle", a.rolle());
            m.put("zaehlpunkt", a.zaehlpunkt());
            m.put("messstellenbetreiber", a.messstellenbetreiber());
            m.put("eichstatus", a.eichstatus());
            m.put("eichfrist_bis", a.eichfristBis() == null ? null : a.eichfristBis().toString());
            m.put("wertequelle", a.wertequelle());
            m.put("urteil", z.urteil());
            zl.add(m);
        }
        n.put("zaehler", zl);
        n.put("aw_regeln", awRegeln);
        n.put("gebotszone", MispelAbgrenzungService.GEBOTSZONE);
        Map<String, Object> qh = new LinkedHashMap<>();
        qh.put("erwartet", erwartet);
        qh.put("gerechnet", eingaenge.size());
        qh.put("luecken", erwartet - eingaenge.size());
        Map<String, Object> lueckenNachweis = new LinkedHashMap<>();
        luecken.forEach((fehlt, beginne) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("anzahl", beginne.size());
            m.put("erste", beginne.subList(0, Math.min(LUECKEN_IM_NACHWEIS, beginne.size())));
            lueckenNachweis.put(fehlt, m);
        });
        qh.put("luecken_je_eingang", lueckenNachweis);
        n.put("viertelstunden", qh);
        // Ein Jahr hat bis 35 136 Viertelstunden: je Viertelstunde eine Zeile in der Spaltenfolge von „spalten“ —
        // Eingänge und Viertelstundenwerte ungerundet (Regel vergleich).
        List<String> spalten = new ArrayList<>();
        spalten.add("beginn");
        spalten.addAll(MispelPauschalRechenwerk.zaehlerEingaenge(v.formelsatz()));
        awRegeln.keySet().forEach(k -> spalten.add(k + " > 0"));
        spalten.add("SP¼");
        spalten.addAll(MispelPauschalRechenwerk.formeln(v.formelsatz(), "viertelstunde"));
        n.put("spalten", spalten);
        List<List<Object>> zeilen = new ArrayList<>();
        for (int i = 0; i < eingaenge.size(); i++) {
            Viertelstunde q = eingaenge.get(i);
            List<Object> zeile = new ArrayList<>();
            zeile.add(q.beginn().toString());
            q.zaehler().values().forEach(w -> zeile.add(w.stripTrailingZeros().toPlainString()));
            awRegeln.keySet().forEach(k -> zeile.add(q.awGroesserNull().get(k)));
            zeile.add(q.sp().stripTrailingZeros().toPlainString());
            e.viertelstunden().get(i).werte().values().forEach(b -> zeile.add(b.text()));
            zeilen.add(zeile);
        }
        n.put("eingaenge_und_viertelstundenwerte", zeilen);
        Map<String, Map<String, String>> jahre = new LinkedHashMap<>();
        e.jahre().forEach((k, m) -> {
            Map<String, String> t = new LinkedHashMap<>();
            m.forEach((nr, b) -> t.put(nr, b.text()));
            jahre.put(k, t);
        });
        n.put("jahreswerte", jahre);
        try {
            return MAPPER.writeValueAsString(n);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
