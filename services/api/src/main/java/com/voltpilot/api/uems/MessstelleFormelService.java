package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementCatalog.Point;
import com.voltpilot.api.measurement.MeasurementCatalog.Semantik;
import com.voltpilot.api.measurement.MesskanalAbbildung;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleFormelRegeln.SummeUrteil;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Summand;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.FormelStand;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.TermZeile;
import com.voltpilot.api.uems.MessstelleFormelWerteRepository.Messwert;
import com.voltpilot.api.uems.MessstelleFormelWerteRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Schnittstelle der berechneten Messstelle (UEMS AP-10, Formel-Typ „gewichtete Summe"):
 * anlegen (mit Ableitung der Hauptgröße aus den Termen), die Formel lesen und Live-Wert sowie
 * Verlauf rechnen. Die REINEN Regeln (Ableitung, Zyklus, Summe) stehen in
 * {@link MessstelleFormelRegeln}; hier steht nur, was Zustand berührt: Persistenz, das Auflösen
 * der Eingänge auf die historisierten Werte und die Transaktion.
 *
 * <p><b>Cloud-Berechnung, on-the-fly.</b> Ein berechneter Wert liest NIE eine Box — er summiert
 * die schon gespeicherten Werte (Samples/15-min-Rollups) anderer Komponenten; der Edge-Vertrag
 * bleibt unangetastet. <b>Ehrlichkeit hart:</b> fehlt/veraltet EIN Pflicht-Term, ist das Ergebnis
 * {@code null} („unvollständig"), nie eine stillschweigend reduzierte Teilsumme.
 *
 * <p>Der Mandant ist die RLS: eine fremde Messstelle/Komponente ist nicht da (404, nie 403).
 */
@Service
public class MessstelleFormelService {

    /** Ab wann ein frischester Messwert als „veraltet" gilt (dann fehlt der Term). */
    static final Duration FRISCHE = Duration.ofMinutes(15);

    private static final String SCHEMA_VERSION = "1.0";
    private static final String MESSKANAL = "messkanal";
    private static final String MESSSTELLE = "messstelle";
    private static final String FUEHREND = "fuehrend";
    private static final int MAX_TIEFE = 16;

    private final MessstelleRepository messstellen;
    private final MessstelleAenderungRepository aenderungen;
    private final MessstelleFormelTermRepository terme;
    private final MessstelleFormelWerteRepository werte;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleService messstellenDienst;
    private final MeasurementCatalog katalog;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleFormelService(MessstelleRepository messstellen,
            MessstelleAenderungRepository aenderungen, MessstelleFormelTermRepository terme,
            MessstelleFormelWerteRepository werte, MessstelleQuelleRepository quellen,
            MessstelleService messstellenDienst, MeasurementCatalog katalog,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.messstellen = messstellen;
        this.aenderungen = aenderungen;
        this.terme = terme;
        this.werte = werte;
        this.quellen = quellen;
        this.messstellenDienst = messstellenDienst;
        this.katalog = katalog;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Nur für Tests: die Uhr, an der „jetzt" (und die Frische-Grenze) hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ---------------------------------------------------------------- anlegen

    /** Ein Term auf dem Weg zum Anlegen: die gespeicherte Bindung und die abgeleitete Größe. */
    private record Bindung(String eingangArt, UUID entityId, String pointKey, UUID quellMessstelleId,
            String vorzeichen, double faktor, boolean giltAlsErzeugung, Groesse groesse) {}

    /**
     * Legt eine berechnete Messstelle mit ihrer Formel an — in EINER Transaktion mit dem
     * Kennzeichen (automatisch, E7) und dem Protokolleintrag „angelegt". Die Hauptgröße wird aus
     * den Termen abgeleitet (nie gewählt); gemischte Größen lehnt {@link MessstelleFormelRegeln} ab.
     */
    public MessstelleDto.Messstelle anlegen(MessstelleFormelDto.Anlegen a, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Kein Kundenbereich gewählt.");
        }
        if (a == null || a.terme() == null || a.terme().isEmpty()) {
            throw MessstelleFormelAbgelehnt.anfrage("terme", "Eine Formel braucht mindestens einen Term.");
        }
        List<Bindung> bindungen = new ArrayList<>();
        List<MessstelleFormelRegeln.Term> fuerAbleitung = new ArrayList<>();
        for (int i = 0; i < a.terme().size(); i++) {
            Bindung b = bindung(a.terme().get(i), i);
            bindungen.add(b);
            fuerAbleitung.add(new MessstelleFormelRegeln.Term(b.groesse().groesse(), b.groesse().richtung(),
                    b.groesse().einheit(), b.groesse().wertart(), b.vorzeichen()));
        }
        MessstelleFormelRegeln.GroesseUrteil urteil = MessstelleFormelRegeln.formelGroesse(fuerAbleitung);
        if (urteil.fehler() != null) {
            throw MessstelleFormelAbgelehnt.regel(urteil.fehler(),
                    "Die Terme tragen nicht dieselbe Messgröße — sie lassen sich nicht summieren.",
                    Map.of("grund", urteil.grund()));
        }
        Groesse haupt = urteil.hauptgroesse();
        String medium = medium(haupt.groesse());
        String name = leerAlsNull(a.name());
        String notiz = leerAlsNull(a.notiz());
        Instant jetzt = minute(uhr.instant());
        UUID id = transaktion.execute(s -> {
            Messstelle m = messstellen.anlegen(new NeueMessstelle(tenant, null, name, "berechnet",
                    medium, haupt, notiz));
            for (int i = 0; i < bindungen.size(); i++) {
                Bindung b = bindungen.get(i);
                terme.anlegen(m.id(), i, b.eingangArt(), b.entityId(), b.pointKey(),
                        b.quellMessstelleId(), b.vorzeichen(), b.faktor(), b.giltAlsErzeugung());
            }
            protokoll(m.id(), name, medium, haupt, bindungen, notiz, jetzt, wer);
            return m.id();
        });
        return messstellenDienst.eine(id);
    }

    private Bindung bindung(MessstelleFormelDto.TermEingabe t, int index) {
        String feld = "terme[" + index + "]";
        if (t == null) {
            throw MessstelleFormelAbgelehnt.anfrage(feld, "Ein Term ist leer.");
        }
        String vorzeichen = t.vorzeichen();
        if (!"+".equals(vorzeichen) && !"-".equals(vorzeichen)) {
            throw MessstelleFormelAbgelehnt.anfrage(feld + ".vorzeichen", "Das Vorzeichen ist „+“ oder „-“.");
        }
        double faktor = t.faktor() == null ? 1.0 : t.faktor();
        if (faktor == 0) {
            throw MessstelleFormelAbgelehnt.anfrage(feld + ".faktor", "Ein Faktor 0 wäre ein Term ohne Wirkung.");
        }
        boolean haken = Boolean.TRUE.equals(t.giltAlsErzeugung());
        if (MESSKANAL.equals(t.eingangArt())) {
            if (t.entityId() == null || leerAlsNull(t.pointKey()) == null) {
                throw MessstelleFormelAbgelehnt.anfrage(feld,
                        "Ein Messkanal-Term braucht die Komponente und den Kanal.");
            }
            if (!werte.komponenteGehoert(t.entityId())) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
            }
            // AP-08: der Haken „gilt als Erzeugung" nur auf einem Kanal OHNE Katalog-Richtung —
            // sonst ein wirkungsloser Schalter (die Regel steht in beiden Zwillingen).
            if (haken && !MessstelleFormelRegeln.erzeugungsHakenErlaubt(kanalRichtung(t.pointKey()))) {
                throw MessstelleFormelAbgelehnt.anfrage(feld + ".gilt_als_erzeugung",
                        "„Gilt als Erzeugung“ ist nur für einen Kanal ohne eigene Richtung — "
                                + "dieser Kanal trägt schon eine.");
            }
            Groesse g = kanalGroesse(t.pointKey(), haken, false);
            if (g == null) {
                throw MessstelleFormelAbgelehnt.anfrage(feld,
                        "Dieser Messwert hat keine Vertrags-Messgröße — er kann kein Term sein.");
            }
            return new Bindung(MESSKANAL, t.entityId(), t.pointKey(), null, vorzeichen, faktor, haken, g);
        }
        if (MESSSTELLE.equals(t.eingangArt())) {
            if (haken) {
                throw MessstelleFormelAbgelehnt.anfrage(feld + ".gilt_als_erzeugung",
                        "„Gilt als Erzeugung“ gilt nur für einen Messkanal-Term.");
            }
            if (t.quellMessstelleId() == null) {
                throw MessstelleFormelAbgelehnt.anfrage(feld, "Ein Baustein-Term braucht eine Messstelle.");
            }
            Messstelle quell = messstellen.finde(t.quellMessstelleId()).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
            return new Bindung(MESSSTELLE, null, null, quell.id(), vorzeichen, faktor, false,
                    quell.hauptgroesse());
        }
        throw MessstelleFormelAbgelehnt.anfrage(feld + ".eingang_art",
                "Der Eingang ist „messkanal“ oder „messstelle“.");
    }

    // ------------------------------------------------------------------ lesen

    /** Die Formel einer berechneten Messstelle: ihre Terme in Reihenfolge und ihr Stand. */
    public MessstelleFormelDto.Formel formel(UUID id) {
        Messstelle m = berechnete(id);
        FormelStand stand = terme.stand(id);
        List<MessstelleFormelDto.Term> aus = new ArrayList<>();
        for (TermZeile t : terme.derMessstelle(id)) {
            aus.add(new MessstelleFormelDto.Term(t.position(), t.eingangArt(), t.entityId(),
                    t.pointKey(), t.quellMessstelleId(), t.vorzeichen(), t.faktor(),
                    t.giltAlsErzeugung(), dtoGroesse(groesse(t)), eingerichtet(t)));
        }
        Groesse h = m.hauptgroesse();
        return new MessstelleFormelDto.Formel(id, SCHEMA_VERSION,
                new MessstelleFormelDto.Groesse(h.groesse(), h.richtung(), h.einheit(), h.wertart()),
                aus, stand.vorhanden(), stand.eingerichtet());
    }

    // ------------------------------------------------------------- Live-Wert

    /** Ein Zwischenergebnis der Rechnung: Wert (oder null), jüngster Messzeitpunkt, fehlende Terme. */
    private record RohWert(Double wert, Instant stand, String einheit,
            List<MessstelleFormelDto.FehlenderTerm> fehlende) {}

    public MessstelleFormelDto.Wert wert(UUID id) {
        Messstelle m = berechnete(id);
        Instant cutoff = uhr.instant().minus(FRISCHE);
        RohWert r = liveWert(m, cutoff, new HashSet<>(List.of(id)), 0);
        return new MessstelleFormelDto.Wert(r.wert(), r.einheit(), r.wert() == null, r.fehlende(),
                r.stand() == null ? null : zeit(r.stand()));
    }

    private RohWert liveWert(Messstelle m, Instant cutoff, Set<UUID> besucht, int tiefe) {
        Groesse haupt = m.hauptgroesse();
        String ziel = haupt.einheit();
        List<Summand> summanden = new ArrayList<>();
        List<MessstelleFormelDto.FehlenderTerm> fehlende = new ArrayList<>();
        Instant stand = null;
        for (TermZeile t : terme.derMessstelle(m.id())) {
            Double wert = null;
            String einheit = ziel;
            if (MESSKANAL.equals(t.eingangArt())) {
                Optional<Quelle> q = werte.quelle(t.entityId(), t.pointKey());
                if (q.isEmpty()) {
                    fehlende.add(fehlt(t, "kein_geraet"));
                } else {
                    Optional<Messwert> mw = werte.frischester(q.get(), t.pointKey());
                    if (mw.isEmpty()) {
                        fehlende.add(fehlt(t, "kein_wert"));
                    } else if (mw.get().zeit().isBefore(cutoff)) {
                        fehlende.add(fehlt(t, "veraltet"));
                    } else {
                        wert = mw.get().wert();
                        einheit = kanalEinheit(t.pointKey(), ziel);
                        stand = juenger(stand, mw.get().zeit());
                    }
                }
            } else {
                RohWert sub = bausteinWert(t.quellMessstelleId(), cutoff, besucht, tiefe);
                if (sub == null || sub.wert() == null) {
                    fehlende.add(fehlt(t, "unvollstaendig"));
                } else {
                    wert = sub.wert();
                    einheit = sub.einheit();
                    stand = juenger(stand, sub.stand());
                }
            }
            summanden.add(new Summand(t.vorzeichen(), t.faktor(), wert, einheit));
        }
        SummeUrteil u = MessstelleFormelRegeln.gewichteteSumme(ziel, summanden);
        return new RohWert(u.wert(), u.wert() == null ? null : stand, ziel, fehlende);
    }

    /** Der Live-Wert eines Baustein-Terms: bei einer berechneten Messstelle rekursiv, bei einer
     * gemessenen aus ihrer führenden Quelle. Ein Kreis (bereits besucht, oder zu tief) fehlt. */
    private RohWert bausteinWert(UUID quellId, Instant cutoff, Set<UUID> besucht, int tiefe) {
        if (tiefe >= MAX_TIEFE || !besucht.add(quellId)) {
            return null;
        }
        try {
            Messstelle q = messstellen.finde(quellId).orElse(null);
            if (q == null) {
                return null;
            }
            if (MessstelleRegeln.BERECHNET.equals(q.art())) {
                return liveWert(q, cutoff, besucht, tiefe + 1);
            }
            KanalRef ref = fuehrenderKanal(q);
            if (ref == null) {
                return new RohWert(null, null, q.hauptgroesse().einheit(), List.of());
            }
            Optional<Messwert> mw = werte.frischester(ref.quelle(), ref.pointKey());
            if (mw.isEmpty() || mw.get().zeit().isBefore(cutoff)) {
                return new RohWert(null, null, q.hauptgroesse().einheit(), List.of());
            }
            double wert = MessstelleFormelRegeln.normiere(mw.get().wert(), ref.einheit(),
                    q.hauptgroesse().einheit());
            return new RohWert(wert, mw.get().zeit(), q.hauptgroesse().einheit(), List.of());
        } finally {
            besucht.remove(quellId);
        }
    }

    // --------------------------------------------------------------- Verlauf

    public MessstelleFormelDto.Verlauf verlauf(UUID id, String range) {
        Messstelle m = berechnete(id);
        Instant bis = viertelstunde(uhr.instant());
        Instant von = bis.minus(zeitraum(range));
        List<MessstelleFormelDto.VerlaufPunkt> punkte = new ArrayList<>();
        List<Map<Instant, Double>> proTerm = termVerlaeufe(m, von, bis, new HashSet<>(List.of(id)), 0);
        // Ein Bucket zählt nur, wenn ALLE Terme in ihm einen Wert haben — sonst null (nie Teilsumme).
        Set<Instant> alle = new java.util.TreeSet<>();
        proTerm.forEach(map -> alle.addAll(map.keySet()));
        for (Instant b : alle) {
            boolean vollstaendig = proTerm.stream().allMatch(map -> map.containsKey(b));
            Double summe = null;
            if (vollstaendig) {
                double s = 0;
                for (Map<Instant, Double> map : proTerm) {
                    s += map.get(b);
                }
                summe = runde(s);
            }
            punkte.add(new MessstelleFormelDto.VerlaufPunkt(zeit(b), summe));
        }
        return new MessstelleFormelDto.Verlauf(id, m.hauptgroesse().einheit(), punkte);
    }

    /** Je Term eine Bucket→Wert-Karte (Vorzeichen · Faktor · normiert), nur wo es einen Wert gibt. */
    private List<Map<Instant, Double>> termVerlaeufe(Messstelle m, Instant von, Instant bis,
            Set<UUID> besucht, int tiefe) {
        String ziel = m.hauptgroesse().einheit();
        String wertart = m.hauptgroesse().wertart();
        List<Map<Instant, Double>> out = new ArrayList<>();
        for (TermZeile t : terme.derMessstelle(m.id())) {
            double vz = ("-".equals(t.vorzeichen()) ? -1 : 1) * t.faktor();
            Map<Instant, Double> roh;
            String von_einheit = ziel;
            if (MESSKANAL.equals(t.eingangArt())) {
                Optional<Quelle> q = werte.quelle(t.entityId(), t.pointKey());
                roh = q.isEmpty() ? Map.of() : werte.verlauf15m(q.get(), t.pointKey(), wertart, von, bis);
                von_einheit = kanalEinheit(t.pointKey(), ziel);
            } else {
                roh = bausteinVerlauf(t.quellMessstelleId(), wertart, von, bis, besucht, tiefe);
            }
            Map<Instant, Double> gewichtet = new TreeMap<>();
            for (Map.Entry<Instant, Double> e : roh.entrySet()) {
                gewichtet.put(e.getKey(), vz * MessstelleFormelRegeln.normiere(e.getValue(), von_einheit, ziel));
            }
            out.add(gewichtet);
        }
        return out;
    }

    /** Der Verlauf eines Baustein-Terms: nur VOLLSTÄNDIGE Buckets (Bucket→Summe), sonst fehlt er. */
    private Map<Instant, Double> bausteinVerlauf(UUID quellId, String wertart, Instant von, Instant bis,
            Set<UUID> besucht, int tiefe) {
        if (tiefe >= MAX_TIEFE || !besucht.add(quellId)) {
            return Map.of();
        }
        try {
            Messstelle q = messstellen.finde(quellId).orElse(null);
            if (q == null) {
                return Map.of();
            }
            if (MessstelleRegeln.BERECHNET.equals(q.art())) {
                List<Map<Instant, Double>> proTerm = termVerlaeufe(q, von, bis, besucht, tiefe + 1);
                Set<Instant> alle = new java.util.TreeSet<>();
                proTerm.forEach(map -> alle.addAll(map.keySet()));
                Map<Instant, Double> out = new TreeMap<>();
                for (Instant b : alle) {
                    if (proTerm.stream().allMatch(map -> map.containsKey(b))) {
                        double s = 0;
                        for (Map<Instant, Double> map : proTerm) {
                            s += map.get(b);
                        }
                        out.put(b, s);
                    }
                }
                return out;
            }
            KanalRef ref = fuehrenderKanal(q);
            if (ref == null) {
                return Map.of();
            }
            Map<Instant, Double> roh = werte.verlauf15m(ref.quelle(), ref.pointKey(),
                    q.hauptgroesse().wertart(), von, bis);
            Map<Instant, Double> out = new TreeMap<>();
            roh.forEach((b, w) -> out.put(b, MessstelleFormelRegeln.normiere(w, ref.einheit(),
                    q.hauptgroesse().einheit())));
            return out;
        } finally {
            besucht.remove(quellId);
        }
    }

    // ----------------------------------------------------------------- Helfer

    /** Ein aufgelöster Messkanal einer gemessenen Messstelle. */
    private record KanalRef(Quelle quelle, String pointKey, String einheit) {}

    /** Die führende Quelle der Hauptgröße, die jetzt gilt, auf ihre lesende Box aufgelöst. */
    private KanalRef fuehrenderKanal(Messstelle q) {
        Instant jetzt = uhr.instant();
        Groesse h = q.hauptgroesse();
        for (MessstelleQuelleRepository.Quelle b : quellen.derMessstelle(q.id())) {
            if (!FUEHREND.equals(b.rolle()) || !h.groesse().equals(b.groesse())
                    || !h.richtung().equals(b.richtung())) {
                continue;
            }
            if (b.gueltigAb().isAfter(jetzt) || (b.gueltigBis() != null && !b.gueltigBis().isAfter(jetzt))) {
                continue;
            }
            Optional<Quelle> scope = werte.quelle(b.entityId(), b.kanal());
            if (scope.isPresent()) {
                return new KanalRef(scope.get(), b.kanal(), kanalEinheit(b.kanal(), h.einheit()));
            }
        }
        return null;
    }

    private Messstelle berechnete(UUID id) {
        Messstelle m = messstellen.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        if (!MessstelleRegeln.BERECHNET.equals(m.art())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Keine berechnete Messstelle.");
        }
        return m;
    }

    /**
     * Die Vertrags-Größe eines Formel-Eingangs; {@code null}, wenn er nicht zulässig ist
     * (keine Größe/Richtung oder neuer Vorzeichen-Netzterm, der auf AP-08 wartet). Die Wertart ist
     * die VERTRAGS-Wertart (Momentanwert · Zählerstand · Intervallmenge), abgeleitet aus der Größe
     * und der Wertart des KANALS ({@code gauge}/{@code counter}) — nicht die des Kanals selbst.
     */
    private Groesse kanalGroesse(String pointKey, boolean giltAlsErzeugung, boolean gespeicherterTerm) {
        Point p = katalog.resolve(pointKey);
        Semantik s = katalog.semantik(pointKey);
        if (p == null || s == null) {
            return null;
        }
        // W1: Vorzeichen-Netzkanäle warten auf den Anteil-Leseweg. Nur ein bereits
        // gespeicherter Term mit Haken behält seine bisherige Erzeugungs-Richtung.
        // Keine Umdeutung beim GET, keine Bestandsmigration; neue Terme bleiben gesperrt.
        boolean vorzeichenNetz = "import_export".equals(s.direction());
        if (vorzeichenNetz && !(gespeicherterTerm && giltAlsErzeugung)) {
            return null;
        }
        String groesse = MesskanalAbbildung.groesse(s.quantity());
        // AP-08: ein richtungsloser Kanal (Katalog ohne Richtung) traegt mit gesetztem Haken die
        // Richtung Erzeugung — sonst bleibt er ohne Richtung und kann kein Term sein.
        String richtung = MessstelleFormelRegeln.richtungMitErzeugungsHaken(
                vorzeichenNetz ? null : MesskanalAbbildung.richtung(s.direction()), giltAlsErzeugung);
        String kanalWertart = MesskanalAbbildung.wertart(p.aggregationKind());
        if (groesse == null || richtung == null || kanalWertart == null || p.unit() == null) {
            return null;
        }
        String wertart = vertragsWertart(groesse, kanalWertart);
        if (wertart == null) {
            return null;
        }
        return new Groesse(groesse, richtung, p.unit(), wertart);
    }

    /** Die Katalog-Richtung eines Messkanals (oder {@code null}, wenn der Katalog keine gibt). */
    private String kanalRichtung(String pointKey) {
        Semantik s = katalog.semantik(pointKey);
        return s == null ? null : MesskanalAbbildung.richtung(s.direction());
    }

    /** Die Vertrags-Wertart: eine Momentan-Größe ist Momentanwert; ein Zähler ist Zählerstand,
     * eine Leistung als Menge Intervallmenge (wie die Herleitung der Quellenbindung, Regel 7). */
    private static String vertragsWertart(String groesse, String kanalWertart) {
        for (MessstelleRegeln.KatalogEintrag e : MessstelleRegeln.GROESSEN_KATALOG) {
            if (!e.groesse().equals(groesse)) {
                continue;
            }
            if (e.wertarten().contains("Momentanwert")) {
                return "Momentanwert";
            }
            return "counter".equals(kanalWertart) ? "Zählerstand" : "Intervallmenge";
        }
        return null;
    }

    private static MessstelleFormelDto.Groesse dtoGroesse(Groesse g) {
        return g == null ? null
                : new MessstelleFormelDto.Groesse(g.groesse(), g.richtung(), g.einheit(), g.wertart());
    }

    private Groesse groesse(TermZeile t) {
        if (MESSKANAL.equals(t.eingangArt())) {
            return kanalGroesse(t.pointKey(), t.giltAlsErzeugung(), true);
        }
        return messstellen.finde(t.quellMessstelleId()).map(Messstelle::hauptgroesse).orElse(null);
    }

    private boolean eingerichtet(TermZeile t) {
        if (MESSKANAL.equals(t.eingangArt())) {
            return werte.quelle(t.entityId(), t.pointKey()).isPresent();
        }
        return messstellen.finde(t.quellMessstelleId())
                .map(q -> q.archiviertAm() == null).orElse(false);
    }

    private String kanalEinheit(String pointKey, String ersatz) {
        Point p = katalog.resolve(pointKey);
        return p == null || p.unit() == null ? ersatz : p.unit();
    }

    private static String medium(String groesse) {
        return MessstelleRegeln.GROESSEN_KATALOG.stream()
                .filter(e -> e.groesse().equals(groesse)).findFirst()
                .map(e -> e.medien().get(0)).orElse("Strom");
    }

    private void protokoll(UUID id, String name, String medium, Groesse haupt, List<Bindung> bindungen,
            String notiz, Instant jetzt, ProtokollAkteur wer) {
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("name", name);
        neu.put("art", "berechnet");
        neu.put("medium", medium);
        neu.put("hauptgroesse", Map.of("groesse", haupt.groesse(), "richtung", haupt.richtung(),
                "einheit", haupt.einheit(), "wertart", haupt.wertart()));
        List<Map<String, Object>> formel = new ArrayList<>();
        for (Bindung b : bindungen) {
            Map<String, Object> term = new LinkedHashMap<>();
            term.put("eingang_art", b.eingangArt());
            term.put("entity_id", b.entityId() == null ? null : b.entityId().toString());
            term.put("point_key", b.pointKey());
            term.put("quell_messstelle_id",
                    b.quellMessstelleId() == null ? null : b.quellMessstelleId().toString());
            term.put("vorzeichen", b.vorzeichen());
            term.put("faktor", b.faktor());
            if (b.giltAlsErzeugung()) {
                term.put("gilt_als_erzeugung", true);
            }
            formel.add(term);
        }
        neu.put("formel", formel);
        neu.put("notiz", notiz);
        aenderungen.eintragen(new NeuerEintrag(TenantContext.get(), id, "angelegt", null, alsJson(neu),
                jetzt, false, null, wer.sub(), wer.name(), wer.rolle(), wer.art()));
    }

    private String alsJson(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (Exception e) {
            throw new IllegalStateException("Konnte den Protokolleintrag nicht schreiben", e);
        }
    }

    private static Duration zeitraum(String range) {
        return switch (range == null ? "24h" : range) {
            case "24h" -> Duration.ofHours(24);
            case "7d" -> Duration.ofDays(7);
            case "30d" -> Duration.ofDays(30);
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unbekannter Zeitraum.");
        };
    }

    private static Instant juenger(Instant a, Instant b) {
        return a == null || (b != null && b.isAfter(a)) ? b : a;
    }

    private static Instant minute(Instant t) {
        return t.truncatedTo(ChronoUnit.MINUTES);
    }

    private static Instant viertelstunde(Instant t) {
        long sekunden = 15 * 60;
        return Instant.ofEpochSecond(t.getEpochSecond() / sekunden * sekunden);
    }

    private static double runde(double wert) {
        double faktor = Math.pow(10, MessstelleFormelRegeln.SUMME_NACHKOMMASTELLEN);
        return Math.round(wert * faktor) / faktor;
    }

    private static OffsetDateTime zeit(Instant t) {
        return OffsetDateTime.ofInstant(t, MessstelleService.ZEITZONE);
    }

    private static String leerAlsNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static MessstelleFormelDto.FehlenderTerm fehlt(TermZeile t, String grund) {
        return new MessstelleFormelDto.FehlenderTerm(t.position(), grund);
    }
}
