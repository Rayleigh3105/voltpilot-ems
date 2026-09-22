package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundAnteilRepository.DokumentZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.DokumentAblehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Stand;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Tabelle;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Anteils-Ableitung und Zweischritt einer Gemeinsamen Steuerung (UEMS AP-15 IP-7; G3–G5, E2 = A, Y1, A10, A18, R12).
 *
 * <ul>
 *   <li><b>Ableitung</b>: Mitglieder (IP-4), Geräte je Box mit Nennleistung und Schreibfreigabe, ihr Rückfall (IP-6),
 *       die wirksame Grenze (IP-3) und der gespeicherte Vorbehalt → {@link SteuerungsverbundAbleitung}; gerechnet von
 *       {@link SteuerungsverbundAnteile#anteile} (NW-1).</li>
 *   <li><b>Auslegungsprüfung</b> für IP-5 (Bedingung „Auslegung passt“ beim Scharfschalten): {@link #eingaenge} ist
 *       der Eingang {@code auslegung} von {@link SteuerungsverbundRegeln#pruefen}, {@link #auslegungPasst} die kurze
 *       Antwort. {@code auslegung_passt_nicht} ist in BEIDEN Richtungen eine Ablehnung (E2 = A).</li>
 *   <li><b>Zweischritt</b>: Übergangsstand an ALLE Mitglieder → Quittung JEDER verengten Box → Zielstand; ohne
 *       Quittung bleibt der Übergangsstand, es gibt keinen Zeitablauf. Revision steigt je Dokument, die Epoche nur
 *       mit {@link #anteileScharfschalten}. Nach einem erkannten Rückspielen (A18) ändert die Cloud nichts mehr, bis
 *       neu scharfgeschaltet wird.</li>
 * </ul>
 *
 * <p>Nur eine Anlage MIT Verbund und ab Stufe S1 bekommt je ein Dokument (LA2: der erste Schritt verengt schon in S1);
 * ohne Verbund antwortet jeder Aufruf {@link Grund#KEIN_VERBUND} und nichts wird veröffentlicht (I6). Keine Route:
 * die ruft IP-5 bzw. der Handgriff des Betreibers (nach IP-24).
 */
@Service
public class SteuerungsverbundAnteilDienst {

    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    /** Der Zielstand nach der letzten Quittung geht ohne Person — VoltPilot selbst. */
    private static final ProtokollAkteur ZWEISCHRITT = new ProtokollAkteur(null, "Zweischritt", "voltpilot_betrieb",
            ProtokollAkteur.ART_VOLTPILOT);

    /** Warum ein Aufruf nichts veröffentlicht hat — Dienst-Antworten, kein Vertragswort. */
    public enum Grund {
        KEIN_VERBUND,
        STUFE_ZU_FRUEH,
        NOCH_NICHT_SCHARF,
        AUSLEGUNG_PASST_NICHT,
        ZWEISCHRITT_LAEUFT,
        RUECKGESPIELT,
        WIRKSAME_ANTEILE_UNBEKANNT,
        UNVERAENDERT
    }

    /** Das Ergebnis: entweder das veröffentlichte Dokument samt Empfängern oder der Grund. */
    public record Ergebnis(Grund grund, DokumentZeile dokument, List<UUID> gesendetAn) {

        static Ergebnis nicht(Grund grund) {
            return new Ergebnis(grund, null, List.of());
        }

        public boolean veroeffentlicht() {
            return grund == null;
        }
    }

    /** Die Ableitung einer Anlage: Mitglieder, Eingänge und Urteil je Richtung. */
    public record Ableitung(List<SteuerungsverbundAbleitung.Mitglied> mitglieder,
            Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge,
            Map<Grenzart, SteuerungsverbundAnteile.Auslegung> auslegung) {

        public boolean passt() {
            return SteuerungsverbundAbleitung.passt(auslegung);
        }

        /** Der Zielstand, wenn die Auslegung passt. */
        public Tabelle ziel() {
            Map<Grenzart, Map<String, BigDecimal>> a = new EnumMap<>(Grenzart.class);
            Map<Grenzart, BigDecimal> v = new EnumMap<>(Grenzart.class);
            auslegung.forEach((r, x) -> {
                a.put(r, x.anteile());
                v.put(r, x.verteilbarKw());
            });
            return new Tabelle(a, v);
        }
    }

    private final SteuerungsverbundRepository verbuende;
    private final SteuerungsverbundAnteilRepository anteile;
    private final GeraeteRueckfallDienst rueckfaelle;
    private final AnlageGrenzen grenzen;
    private final ObjectProvider<VerbundAnteileVersand> versand;
    private final ObjectProvider<WirksameAnteileQuelle> herzschlag;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    public SteuerungsverbundAnteilDienst(SteuerungsverbundRepository verbuende,
            SteuerungsverbundAnteilRepository anteile, GeraeteRueckfallDienst rueckfaelle, AnlageGrenzen grenzen,
            ObjectProvider<VerbundAnteileVersand> versand, ObjectProvider<WirksameAnteileQuelle> herzschlag,
            ObjectMapper mapper) {
        this(verbuende, anteile, rueckfaelle, grenzen, versand, herzschlag, mapper, Clock.systemUTC());
    }

    SteuerungsverbundAnteilDienst(SteuerungsverbundRepository verbuende, SteuerungsverbundAnteilRepository anteile,
            GeraeteRueckfallDienst rueckfaelle, AnlageGrenzen grenzen, ObjectProvider<VerbundAnteileVersand> versand,
            ObjectProvider<WirksameAnteileQuelle> herzschlag, ObjectMapper mapper, Clock clock) {
        this.verbuende = verbuende;
        this.anteile = anteile;
        this.rueckfaelle = rueckfaelle;
        this.grenzen = grenzen;
        this.versand = versand;
        this.herzschlag = herzschlag;
        this.mapper = mapper;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ Ableitung und Auslegung (Naht zu IP-5)

    /** Die Ableitung der Anlage — leer ohne Verbund (Bestand). */
    @Transactional(readOnly = true)
    public Optional<Ableitung> ableiten(UUID siteId) {
        return verbuende.derAnlage(siteId).map(this::ableitung);
    }

    /**
     * Der Eingang {@code auslegung} für {@link SteuerungsverbundRegeln#pruefen} (IP-5). Eine Richtung ohne Grenze oder
     * ohne Vorbehalt fehlt — unbekannt ist keine Null; {@link #auslegungPasst} sagt dann „passt nicht“.
     */
    @Transactional(readOnly = true)
    public Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge(UUID siteId) {
        return ableiten(siteId).map(Ableitung::eingaenge).orElse(Map.of());
    }

    /** Scharf nur mit {@code passt} in BEIDEN Richtungen (E2 = A, I1). Ohne Verbund: false. */
    @Transactional(readOnly = true)
    public boolean auslegungPasst(UUID siteId) {
        return ableiten(siteId).map(Ableitung::passt).orElse(false);
    }

    /**
     * Die Naht von IP-5 ({@link SteuerungsverbundNachweise#auslegung}): der Eingang je Richtung für genau diese Boxen
     * am Tag — leer ohne Verbund, ohne Boxen oder wenn eine Richtung nicht rechenbar ist (unbekannt ist nicht „passt“).
     */
    @Transactional(readOnly = true)
    public Optional<Map<Grenzart, SteuerungsverbundRegeln.Richtung>> auslegungFuer(UUID siteId, List<UUID> boxen,
            LocalDate tag) {
        if (boxen.isEmpty()) {
            return Optional.empty();
        }
        return verbuende.derAnlage(siteId).map(v -> ableitung(v, tag, java.util.Set.copyOf(boxen)).eingaenge())
                .filter(e -> e.keySet().containsAll(SteuerungsverbundAnteile.RICHTUNGEN));
    }

    private Ableitung ableitung(VerbundZeile v) {
        return ableitung(v, LocalDate.ofInstant(clock.instant(), ZONE), null);
    }

    private Ableitung ableitung(VerbundZeile v, LocalDate tag, java.util.Set<UUID> nurBoxen) {
        Instant jetzt = clock.instant();
        List<SteuerungsverbundAbleitung.Mitglied> mitglieder = verbuende.mitglieder(v.id(), jetzt).stream()
                .filter(m -> nurBoxen == null || nurBoxen.contains(m.deviceId()))
                .map(m -> new SteuerungsverbundAbleitung.Mitglied(m.deviceId().toString(), m.rolle())).toList();
        java.util.Set<String> imVerbund = new java.util.HashSet<>();
        mitglieder.forEach(m -> imVerbund.add(m.box()));
        List<SteuerungsverbundAbleitung.Geraet> geraete = new ArrayList<>();
        for (SteuerungsverbundAnteilRepository.GeraetZeile g : anteile.geraete(v.id())) {
            if (!imVerbund.contains(g.deviceId().toString())) {
                continue; // Gerät an einer Box, die gerade kein Mitglied ist
            }
            BigDecimal rueckfall = g.entityId() != null && g.schreibfreigabe()
                    ? rueckfaelle.rueckfall(g.entityId(), g.richtung(), g.nennKw()).kw() : g.nennKw();
            geraete.add(new SteuerungsverbundAbleitung.Geraet(g.deviceId().toString(),
                    g.entityId() == null ? null : g.entityId().toString(), g.richtung(), g.nennKw(),
                    g.schreibfreigabe(), rueckfall));
        }
        Map<Grenzart, BigDecimal> grenze = new EnumMap<>(Grenzart.class);
        BigDecimal[] anlage = anteile.grenzwerteDerAnlage(v.siteId());
        GrenzeAufloesung.Wirksam wirksam = grenzen.wirksam(v.siteId(), tag, anlage[0], anlage[1]);
        if (wirksam.einspeisungKw() != null) {
            grenze.put(Grenzart.EINSPEISUNG, wirksam.einspeisungKw());
        }
        if (wirksam.bezugKw() != null) {
            grenze.put(Grenzart.BEZUG, wirksam.bezugKw());
        }
        Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge = SteuerungsverbundAbleitung.eingaenge(mitglieder,
                geraete, grenze, anteile.vorbehalt(v.id()).kw());
        return new Ableitung(mitglieder, eingaenge, SteuerungsverbundAbleitung.auslegung(mitglieder, eingaenge));
    }

    // ------------------------------------------------------------------ Zweischritt

    /**
     * Neue Epoche und Zweischritt (G5) — das Scharfschalten der Anteile; ab Stufe S1 (LA2: der erste Schritt verengt
     * schon dort). „Alt“ ist, was die Boxen wirksam halten: nach einem erkannten Rückspielen NUR aus dem Herzschlag
     * (A18, fehlt er für eine Box: {@link Grund#WIRKSAME_ANTEILE_UNBEKANNT}), sonst aus den gesendeten und quittierten
     * Dokumenten, vor dem allerersten Dokument die führende Box mit der ganzen Grenze und jede andere mit ihrem
     * Rückfall (§5.3, W11).
     */
    @Transactional
    public Ergebnis anteileScharfschalten(UUID siteId, ProtokollAkteur wer) {
        return ausrollen(siteId, wer, true);
    }

    /**
     * Das Scharfschalten S3 (IP-5, {@code GemeinsameSteuerungService#scharfschalten}) hat die neue Epoche schon gesetzt:
     * der Zweischritt läuft in DIESER Epoche, einmal — gibt es in ihr schon ein Dokument, geschieht nichts.
     */
    @Transactional
    public Ergebnis anteileAusrollen(UUID siteId, ProtokollAkteur wer) {
        return ausrollen(siteId, wer, false);
    }

    private Ergebnis ausrollen(UUID siteId, ProtokollAkteur wer, boolean neueEpoche) {
        Optional<VerbundZeile> gefunden = verbuende.derAnlage(siteId);
        if (gefunden.isEmpty()) {
            return Ergebnis.nicht(Grund.KEIN_VERBUND);
        }
        VerbundZeile v = gefunden.get();
        if (v.stufe() == Stufe.ERKLAERT) {
            return Ergebnis.nicht(Grund.STUFE_ZU_FRUEH);
        }
        Ableitung a = ableitung(v);
        if (!a.passt()) {
            return Ergebnis.nicht(Grund.AUSLEGUNG_PASST_NICHT);
        }
        List<DokumentZeile> bisher = anteile.dokumente(v.id());
        if (!neueEpoche && (v.epoche() == 0 || bisher.stream().anyMatch(d -> d.epoche() == v.epoche()))) {
            return Ergebnis.nicht(v.epoche() == 0 ? Grund.NOCH_NICHT_SCHARF : Grund.UNVERAENDERT);
        }
        Map<Grenzart, Map<String, BigDecimal>> alt;
        boolean rueckgespielt = anteile.rueckgespieltErkannt(v.id()).isPresent();
        if (rueckgespielt) {
            Optional<Map<Grenzart, Map<String, BigDecimal>>> gemeldet = wirksamAusHerzschlag(v, a.mitglieder());
            if (gemeldet.isEmpty()) {
                return Ergebnis.nicht(Grund.WIRKSAME_ANTEILE_UNBEKANNT);
            }
            alt = gemeldet.get();
        } else if (bisher.isEmpty()) {
            alt = SteuerungsverbundZweischritt.altOhneDokument(a.mitglieder(), a.eingaenge());
        } else {
            alt = wirksamAusHerzschlag(v, a.mitglieder()).orElseGet(() -> altAusDokumenten(v));
        }
        long epoche = v.epoche();
        if (neueEpoche) {
            epoche = verbuende.epocheErhoehen(v.id()).orElseThrow();
            verbuende.protokoll(TenantContext.get(), v.id(), v.siteId(), "epoche", "{\"epoche\":" + (epoche - 1)
                    + "}", "{\"epoche\":" + epoche + "}", clock.instant(), false, "Anteile scharfgeschaltet", wer);
        }
        if (rueckgespielt) {
            anteile.rueckgespieltAufheben(v.id());
        }
        return veroeffentlichen(v, epoche, SteuerungsverbundZweischritt.beginnen(alt, a.ziel()), "scharfschalten",
                wer);
    }

    /**
     * Zweischritt in derselben Epoche (neues Gerät, neue Grenze, neuer Vorbehalt): nur nach dem Scharfschalten, nie
     * während ein Übergang auf Quittungen wartet und nie nach einem erkannten Rückspielen.
     */
    @Transactional
    public Ergebnis anteileAendern(UUID siteId, ProtokollAkteur wer) {
        Optional<VerbundZeile> gefunden = verbuende.derAnlage(siteId);
        if (gefunden.isEmpty()) {
            return Ergebnis.nicht(Grund.KEIN_VERBUND);
        }
        VerbundZeile v = gefunden.get();
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        if (dokumente.isEmpty() || v.epoche() == 0) {
            return Ergebnis.nicht(Grund.NOCH_NICHT_SCHARF);
        }
        if (anteile.rueckgespieltErkannt(v.id()).isPresent()) {
            return Ergebnis.nicht(Grund.RUECKGESPIELT);
        }
        if (dokumente.get(0).ziel() != null) {
            return Ergebnis.nicht(Grund.ZWEISCHRITT_LAEUFT);
        }
        Ableitung a = ableitung(v);
        if (!a.passt()) {
            return Ergebnis.nicht(Grund.AUSLEGUNG_PASST_NICHT);
        }
        Tabelle ziel = a.ziel();
        if (gleich(dokumente.get(0).tabelle(), ziel)) {
            return Ergebnis.nicht(Grund.UNVERAENDERT);
        }
        Map<Grenzart, Map<String, BigDecimal>> alt = wirksamAusHerzschlag(v, a.mitglieder())
                .orElseGet(() -> altAusDokumenten(v));
        return veroeffentlichen(v, v.epoche(), SteuerungsverbundZweischritt.beginnen(alt, ziel), "aendern", wer);
    }

    /**
     * Die Quittung einer Box (Uplink {@code …/v2/verbund-anteile-result}); der Mandant steht im TenantContext.
     * {@code gemeldet} = der Stand, den die Box danach wirksam hält (wahlfrei). Nimmt die Box an, wird quittiert und
     * der Zielstand geprüft; meldet sie einen Stand über dem Gesendeten oder lehnt sie mit {@code revision_aelter}
     * ab, ist die Cloud zurückgespielt (A18). False = verworfen (keine aktive Box dieses Verbunds).
     */
    @Transactional
    public boolean quittungEmpfangen(UUID siteId, UUID box, Stand stand, boolean angenommen,
            DokumentAblehnung grund, Stand gemeldet, Instant am) {
        Optional<VerbundZeile> gefunden = verbuende.derAnlage(siteId);
        if (gefunden.isEmpty()) {
            return false;
        }
        VerbundZeile v = gefunden.get();
        MitgliedZeile m = verbuende.mitglieder(v.id(), clock.instant()).stream()
                .filter(x -> x.deviceId().equals(box)).findFirst().orElse(null);
        if (m == null) {
            return false;
        }
        // Kein Stand, den die Box hält, kann über dem liegen, was die Cloud je gemacht hat — außer sie wurde
        // zurückgespielt. Das Dokument ist vor dem Senden gespeichert (nach dem Commit), also nie ein Wettlauf.
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        Stand hoechster = dokumente.isEmpty() ? null : dokumente.get(0).stand();
        boolean zurueck = SteuerungsverbundZweischritt.rueckgespielt(hoechster, gemeldet)
                || SteuerungsverbundZweischritt.rueckgespielt(hoechster, stand)
                || !angenommen && grund == DokumentAblehnung.REVISION_AELTER;
        if (zurueck) {
            anteile.rueckgespieltMarkieren(v.id(), am);
            return true;
        }
        // Eine Quittung zählt nur für ein Dokument, das diese Datenbank gespeichert hat: nach dem Rückspielen (neue
        // Epoche) ist ein verspäteter Stand der alten Epoche keiner, den die Cloud je gesendet hat (IP-30).
        if (angenommen && dokumente.stream().anyMatch(d -> d.stand().equals(stand))) {
            verbuende.quittiert(m.id(), stand.epoche(), stand.revision(), am);
            zielstandPruefen(v);
        }
        return true;
    }

    /** Ist jede verengte Box quittiert, geht der Zielstand an alle (neue Revision, dieselbe Epoche). */
    private void zielstandPruefen(VerbundZeile v) {
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        if (dokumente.isEmpty() || dokumente.get(0).ziel() == null) {
            return;
        }
        DokumentZeile uebergang = dokumente.get(0);
        if (uebergang.epoche() != v.epoche() || anteile.rueckgespieltErkannt(v.id()).isPresent()) {
            return;
        }
        Map<String, Stand> quittiert = new HashMap<>();
        Map<UUID, UUID> kennungen = verbuende.anteilKennungen(v.id());
        for (MitgliedZeile m : verbuende.mitglieder(v.id(), clock.instant())) {
            if (m.quittiertEpoche() != null) {
                Stand q = new Stand(m.quittiertEpoche(), m.quittiertRevision());
                quittiert.put(m.deviceId().toString(), q);
                // Box-Tausch (A14): die Quittung der Nachfolgerin zählt für den Eintrag, den sie trägt.
                UUID kennung = kennungen.get(m.deviceId());
                if (kennung != null && uebergang.tabelle().boxen().contains(kennung.toString())
                        && !uebergang.tabelle().boxen().contains(m.deviceId().toString())) {
                    quittiert.put(kennung.toString(), q);
                }
            }
        }
        if (!SteuerungsverbundZweischritt.zielFaellig(uebergang.stand(), uebergang.verengteBoxen(), quittiert)) {
            return;
        }
        veroeffentlichen(v, v.epoche(), new SteuerungsverbundZweischritt.Dokument(Schritt.ZIEL,
                uebergang.ziel(), null, List.of()), "zielstand", ZWEISCHRITT);
    }

    private Ergebnis veroeffentlichen(VerbundZeile v, long epoche, SteuerungsverbundZweischritt.Dokument d,
            String anlass, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        long revision = anteile.hoechsteRevision(v.id()) + 1;
        UUID id = anteile.dokumentAnhaengen(tenant, v.id(), epoche, revision, d.schritt(), d.tabelle(), d.ziel(),
                d.verengteBoxen(), anlass, wer.name());
        Instant jetzt = clock.instant();
        Map<String, MitgliedZeile> mitglieder = new HashMap<>();
        verbuende.mitglieder(v.id(), jetzt).forEach(m -> mitglieder.put(m.deviceId().toString(), m));
        // Box-Tausch (A14): ein Zielstand aus einem Übergang vor dem Tausch führt die Nachfolgerin unter der Vorgängerin.
        Map<String, MitgliedZeile> getragen = new HashMap<>();
        verbuende.anteilKennungen(v.id()).forEach((b, k) -> {
            if (mitglieder.containsKey(b.toString())) {
                getragen.put(k.toString(), mitglieder.get(b.toString()));
            }
        });
        List<UUID> gesendetAn = new ArrayList<>();
        List<Map.Entry<String, byte[]>> auftraege = new ArrayList<>();
        VerbundAnteileVersand weg = versand.getIfAvailable();
        Map<String, BigDecimal> reserven = reserveVerbraucher(v, jetzt);
        Map<String, BigDecimal> ungeregelt = ungeregeltHinterAbgang(v, jetzt);
        for (String eintrag : d.tabelle().boxen()) {
            MitgliedZeile m = mitglieder.containsKey(eintrag) ? mitglieder.get(eintrag) : getragen.get(eintrag);
            if (m == null || weg == null) {
                continue; // eine ausgeschiedene Box hat keinen Mitglieds-Stand mehr; ohne Broker bleibt es ungesendet
            }
            UUID b = m.deviceId();
            String box = b.toString();
            auftraege.add(Map.entry(VerbundAnteileDokument.topic(tenant, v.siteId(), b),
                    VerbundAnteileDokument.nutzlast(mapper, tenant, v.siteId(), b, m.rolle(), epoche, revision,
                            d.schritt(), fuerBox(d.tabelle(), b, UUID.fromString(eintrag)),
                            reserven.getOrDefault(box, BigDecimal.ZERO.setScale(1)),
                            ungeregelt.get(box), jetzt)));
            verbuende.gesendet(m.id(), epoche, revision, jetzt);
            gesendetAn.add(b);
        }
        // Erst nach dem Commit auf den Draht: eine schnelle Quittung findet Dokument und „gesendet“ schon vor.
        nachCommit(() -> auftraege.forEach(a -> weg.senden(a.getKey(), a.getValue())));
        DokumentZeile zeile = anteile.dokumente(v.id()).stream().filter(z -> z.id().equals(id)).findFirst()
                .orElseThrow();
        return new Ergebnis(null, zeile, List.copyOf(gesendetAn));
    }

    /**
     * Box-Tausch (A14/R17): das jüngste gespeicherte Dokument geht an die Nachfolgerin — dieselbe Epoche, dieselbe
     * Revision, der Eintrag der Vorgängerin auf ihre Kennung umgeschlüsselt (die Summe bleibt, die Box prüft sie). Es ist
     * keine Änderung der Anteile: kein neues Dokument, kein Zielstand, keine andere Box bekommt etwas. Ihre Quittung
     * nimmt {@link #quittungEmpfangen} wie jede an. Aufzurufen in der Transaktion des Tauschs; auf den Draht erst nach
     * dem Commit. Die Kennung, unter der das Dokument den Anteil führt, oder null ohne Dokument mit diesem Eintrag.
     */
    public UUID nachfolgerinZustellen(VerbundZeile v, UUID mitgliedId, UUID box, SteuerungsverbundVokabular.Rolle rolle,
            UUID vorgaengerKennung, Instant jetzt) {
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        if (dokumente.isEmpty() || vorgaengerKennung == null
                || !dokumente.get(0).tabelle().boxen().contains(vorgaengerKennung.toString())) {
            return null;
        }
        DokumentZeile d = dokumente.get(0);
        UUID tenant = TenantContext.get();
        Tabelle t = fuerBox(d.tabelle(), box, vorgaengerKennung);
        // Reserve und Ungeregeltes aus den Geräte-Angaben, die mit der Box umgezogen sind (Stand zum Tauschzeitpunkt).
        byte[] nutzlast = VerbundAnteileDokument.nutzlast(mapper, tenant, v.siteId(), box, rolle, d.epoche(),
                d.revision(), d.schritt(), t, reserveVerbraucher(v, jetzt).getOrDefault(box.toString(),
                        BigDecimal.ZERO.setScale(1)), ungeregeltHinterAbgang(v, jetzt).get(box.toString()), jetzt);
        verbuende.gesendet(mitgliedId, d.epoche(), d.revision(), jetzt);
        VerbundAnteileVersand weg = versand.getIfAvailable();
        if (weg != null) {
            String topic = VerbundAnteileDokument.topic(tenant, v.siteId(), box);
            nachCommit(() -> weg.senden(topic, nutzlast));
        }
        return vorgaengerKennung;
    }

    /**
     * Die Tabelle, wie sie für {@code box} gilt: führt sie die Box nicht, wohl aber {@code kennung} (die Vorgängerin
     * nach einem Box-Tausch, A14), steht deren Eintrag unter der Box — sonst unverändert.
     */
    static Tabelle fuerBox(Tabelle t, UUID box, UUID kennung) {
        if (t == null || kennung == null || t.boxen().contains(box.toString())
                || !t.boxen().contains(kennung.toString())) {
            return t;
        }
        Map<Grenzart, Map<String, BigDecimal>> je = new EnumMap<>(Grenzart.class);
        t.anteile().forEach((r, m) -> {
            Map<String, BigDecimal> neu = new java.util.TreeMap<>(m);
            BigDecimal kw = neu.remove(kennung.toString());
            if (kw != null) {
                neu.put(box.toString(), kw);
            }
            je.put(r, neu);
        });
        return new Tabelle(je, t.verteilbar());
    }

    /**
     * Stellt das jüngste Dokument noch einmal an alle Mitglieder zu (gespeichert, dieselbe Epoche und Revision — die
     * Box nimmt dieselbe Revision noch einmal an). Für den Fall, dass der Broker beim ersten Mal nicht erreichbar war.
     */
    @Transactional(readOnly = true)
    public List<UUID> erneutSenden(UUID siteId) {
        Optional<VerbundZeile> gefunden = verbuende.derAnlage(siteId);
        VerbundAnteileVersand weg = versand.getIfAvailable();
        if (gefunden.isEmpty() || weg == null) {
            return List.of();
        }
        VerbundZeile v = gefunden.get();
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        if (dokumente.isEmpty()) {
            return List.of();
        }
        DokumentZeile d = dokumente.get(0);
        UUID tenant = TenantContext.get();
        List<UUID> an = new ArrayList<>();
        Map<String, BigDecimal> reserven = reserveVerbraucher(v, clock.instant());
        Map<String, BigDecimal> ungeregelt = ungeregeltHinterAbgang(v, clock.instant());
        Map<UUID, UUID> kennungen = verbuende.anteilKennungen(v.id());
        for (MitgliedZeile m : verbuende.mitglieder(v.id(), clock.instant())) {
            Tabelle t = fuerBox(d.tabelle(), m.deviceId(), kennungen.get(m.deviceId()));
            if (t.boxen().contains(m.deviceId().toString()) && weg.senden(
                    VerbundAnteileDokument.topic(tenant, v.siteId(), m.deviceId()), VerbundAnteileDokument.nutzlast(
                            mapper, tenant, v.siteId(), m.deviceId(), m.rolle(), d.epoche(), d.revision(),
                            d.schritt(), t, reserven.getOrDefault(m.deviceId().toString(),
                                    BigDecimal.ZERO.setScale(1)), ungeregelt.get(m.deviceId().toString()),
                            clock.instant()))) {
                an.add(m.deviceId());
            }
        }
        return List.copyOf(an);
    }

    /**
     * Die Reserve der anderen steuerbaren Verbraucher je Mitglied (AP-15 Folge von IP-19, V3) aus den erklärten
     * Geräten ({@code steuerungsverbund_geraet}, Richtung bezug, Schreibfreigabe) — so, wie sie beim Versand gelten.
     */
    private Map<String, BigDecimal> reserveVerbraucher(VerbundZeile v, Instant jetzt) {
        return SteuerungsverbundAbleitung.reserveVerbraucher(mitgliederDerAbleitung(v, jetzt), geraeteDerAbleitung(v),
                anteile.komponentenZurReserve(v.siteId()));
    }

    /**
     * Der erklärte Höchstwert des Ungeregelten hinter dem Abgang je mitsteuernder Box (AP-15 Folge von IP-19, B3) aus
     * denselben erklärten Geräten — nur Boxen mit einem Wert über 0; ohne ihn reist das Feld nicht.
     */
    private Map<String, BigDecimal> ungeregeltHinterAbgang(VerbundZeile v, Instant jetzt) {
        return SteuerungsverbundAbleitung.ungeregeltHinterAbgang(mitgliederDerAbleitung(v, jetzt),
                geraeteDerAbleitung(v));
    }

    private List<SteuerungsverbundAbleitung.Mitglied> mitgliederDerAbleitung(VerbundZeile v, Instant jetzt) {
        return verbuende.mitglieder(v.id(), jetzt).stream()
                .map(m -> new SteuerungsverbundAbleitung.Mitglied(m.deviceId().toString(), m.rolle())).toList();
    }

    private List<SteuerungsverbundAbleitung.Geraet> geraeteDerAbleitung(VerbundZeile v) {
        return anteile.geraete(v.id()).stream()
                .map(g -> new SteuerungsverbundAbleitung.Geraet(g.deviceId().toString(),
                        g.entityId() == null ? null : g.entityId().toString(), g.richtung(), g.nennKw(),
                        g.schreibfreigabe(), null))
                .toList();
    }

    private static void nachCommit(Runnable r) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    r.run();
                }
            });
        } else {
            r.run();
        }
    }

    private Optional<Map<Grenzart, Map<String, BigDecimal>>> wirksamAusHerzschlag(VerbundZeile v,
            List<SteuerungsverbundAbleitung.Mitglied> mitglieder) {
        WirksameAnteileQuelle quelle = herzschlag.getIfAvailable();
        if (quelle == null) {
            return Optional.empty();
        }
        Map<Grenzart, Map<String, BigDecimal>> alt = new EnumMap<>(Grenzart.class);
        for (SteuerungsverbundAbleitung.Mitglied m : mitglieder) {
            Optional<Map<Grenzart, BigDecimal>> je = quelle.wirksam(v.siteId(), UUID.fromString(m.box()));
            if (je.isEmpty() || !je.get().keySet().containsAll(SteuerungsverbundAnteile.RICHTUNGEN)) {
                return Optional.empty(); // unbekannt ist keine Null — dann nicht aus dem Herzschlag
            }
            je.get().forEach((r, kw) -> alt.computeIfAbsent(r, x -> new java.util.TreeMap<>()).put(m.box(), kw));
        }
        return Optional.of(alt);
    }

    private Map<Grenzart, Map<String, BigDecimal>> altAusDokumenten(VerbundZeile v) {
        Map<Stand, Tabelle> jeStand = new HashMap<>();
        anteile.dokumente(v.id()).forEach(d -> jeStand.put(d.stand(), d.tabelle()));
        Map<String, Tabelle> quittiert = new HashMap<>();
        Map<String, Tabelle> gesendet = new HashMap<>();
        Map<UUID, UUID> kennungen = verbuende.anteilKennungen(v.id());
        for (MitgliedZeile m : verbuende.mitgliederGeschichte(v.id())) {
            if (m.aufgehobenAm() != null) {
                continue;
            }
            String box = m.deviceId().toString();
            UUID kennung = kennungen.get(m.deviceId());
            if (m.quittiertEpoche() != null) {
                quittiert.put(box, fuerBox(jeStand.get(new Stand(m.quittiertEpoche(), m.quittiertRevision())),
                        m.deviceId(), kennung));
            }
            if (m.gesendetEpoche() != null) {
                gesendet.put(box, fuerBox(jeStand.get(new Stand(m.gesendetEpoche(), m.gesendetRevision())),
                        m.deviceId(), kennung));
            }
        }
        return SteuerungsverbundZweischritt.altAusDokumenten(quittiert, gesendet);
    }

    private static boolean gleich(Tabelle a, Tabelle b) {
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            if (a.verteilbar().get(r).compareTo(b.verteilbar().get(r)) != 0) {
                return false;
            }
            Map<String, BigDecimal> x = a.anteile().getOrDefault(r, Map.of());
            Map<String, BigDecimal> y = b.anteile().getOrDefault(r, Map.of());
            if (!x.keySet().equals(y.keySet())
                    || x.entrySet().stream().anyMatch(e -> e.getValue().compareTo(y.get(e.getKey())) != 0)) {
                return false;
            }
        }
        return true;
    }
}
