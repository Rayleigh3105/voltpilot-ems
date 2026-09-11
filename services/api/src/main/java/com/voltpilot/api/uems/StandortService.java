package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ArchivErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ArchivGrund;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ArchivGrundArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Archiviert;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.OrtsbaumAbleitung.WiederherstellErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.WiederherstellGrund;
import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import com.voltpilot.api.uems.StandortLesemodell.Lage;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import com.voltpilot.api.uems.StandortRepository.NeuerStandort;
import com.voltpilot.api.uems.StandortRepository.Stammdaten;
import com.voltpilot.api.web.dto.StandortDto;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Schreibrouten des STANDORTS (UEMS AP-02 IP-4): anlegen, bearbeiten, archivieren,
 * wiederherstellen — je Schreibvorgang EINE Transaktion und GENAU EIN Eintrag im
 * Änderungsprotokoll mit Urheber ({@link OrtProtokoll}); eine Ablehnung schreibt nichts.
 *
 * <p><b>Keine zweite Prüflogik.</b> Die Namensregel unter Geschwistern, die Sperrgründe beim
 * Archivieren (in ihrer festen Reihenfolge, mit Satz und Weg) und das Wiederherstellen
 * urteilt {@link OrtsbaumAbleitung} — auf DEMSELBEN Baum, den das Lesemodell zeigt
 * ({@link StandortLesemodell#baum}), nur mit den Kurzzeichen als Schlüssel, damit die Sätze
 * „Werk Lindach (ST-2)" sagen. Hier steht, was der Vertrag der Schnittstelle lässt: die Form
 * der Anfrage ({@link OrtFelder}), die Kurzzeichen ({@link OrtKurzzeichen}) und die Zeilen,
 * die ein Urteil schreibt.
 *
 * <h2>Die Tage (E9)</h2>
 *
 * Archivieren und Wiederherstellen gelten ab HEUTE in der Zeitzone des Standorts: das
 * Bestehen endet am Vortag, ein Wiederherstellen beginnt ein neues ab dem Tag. Die Lücke
 * dazwischen steht nur im Protokoll (das Paar {@code archiviert} → {@code wiederhergestellt}
 * mit seinem „gilt ab"); daraus liest sie {@link StandortLesemodell#bestehen}.
 *
 * <h2>Was es nicht gibt</h2>
 *
 * Kein Löschen: §4.1 nennt beim Standort nur Anlegen · Bearbeiten · Archivieren ·
 * Wiederherstellen, das Löschen ohne Historie (E1) bringt IP-15 für Gebäude und Bereiche,
 * und die App-Rolle hat auf {@code standort} kein DELETE. Keine Fläche (IP-5), keine
 * Anlagen-Zuordnung (IP-11). Die Messstellen im Sperrgrund kommen über
 * {@link OrtsbaumMessstellen} — seit AP-04 IP-7 aus {@code messstelle_ort}.
 *
 * <p>Der Mandant ist die RLS: ein fremder Standort ist nicht da (404, nie 403).
 */
@Service
public class StandortService {

    static final String ENTWURF = "entwurf";
    static final String AKTIV = "aktiv";
    private static final String OBJEKT = "standort";
    private static final DateTimeFormatter ZEIT = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    private final StandortLesemodellService lesemodell;
    private final StandortRepository standorte;
    private final UnternehmenRepository unternehmen;
    private final OrtRepository orte;
    private final OrtZuordnungRepository ortZuordnungen;
    private final OrtKurzzeichen kurzzeichen;
    private final OrtProtokoll protokoll;
    private final ObjectProvider<OrtsbaumMessstellen> messstellen;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public StandortService(StandortLesemodellService lesemodell, StandortRepository standorte,
            UnternehmenRepository unternehmen, OrtRepository orte, OrtZuordnungRepository ortZuordnungen,
            OrtKurzzeichen kurzzeichen, OrtProtokoll protokoll, ObjectProvider<OrtsbaumMessstellen> messstellen,
            PlatformTransactionManager transactionManager) {
        this.lesemodell = lesemodell;
        this.standorte = standorte;
        this.unternehmen = unternehmen;
        this.orte = orte;
        this.ortZuordnungen = ortZuordnungen;
        this.kurzzeichen = kurzzeichen;
        this.protokoll = protokoll;
        this.messstellen = messstellen;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der „heute" hängt (Archivieren an einem Tag, Wiederherstellen an einem späteren). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ---------------------------------------------------------------- anlegen

    /** Der Vorschlag des Anlege-Dialogs („vorbelegt, meist unberührt", E8) — der Zähler bleibt stehen. */
    public StandortDto.Vorschlag vorschlag() {
        return new StandortDto.Vorschlag(kurzzeichen.vorschlag(kundenbereich(), OrtArt.STANDORT));
    }

    /**
     * Legt einen Standort an: ohne Kurzzeichen vergibt die Datenbank unter der Zeilensperre
     * des Zählers das nächste (ST-1 …) — in DERSELBEN Transaktion wie Zeile und
     * Protokolleintrag. Geprüft wird erst jede Form (400), dann Name und Kurzzeichen (409).
     * Mit Adresse ist er sofort eingerichtet und aktiv (§4.2: „Strukturobjekte starten niemand").
     */
    public StandortAmStichtag anlegen(StandortDto.Stammdaten a, ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        UnternehmenRepository.Unternehmen u = unternehmen.desKundenbereichs().orElseThrow(() ->
                OrtAbgelehnt.nichtGefunden("Für diesen Kundenbereich ist noch kein Unternehmen angelegt."));
        Werte w = werte(a, u.zeitzone(), true);
        OrtFelder.adressePflicht(w.adresse(), "adresse");
        Instant jetzt = uhr.instant();
        ZoneId zone = ZoneId.of(w.zeitzone());
        LocalDate heute = tag(jetzt, zone);
        nameFrei(baum(), w.name(), heute, null);
        if (w.kurzzeichen() != null) {
            kurzzeichen.pruefeFrei(w.kurzzeichen(), null);
        }
        UUID id = schreibe(w.name(), w.kurzzeichen(), null, heute, () -> transaktion.execute(s -> {
            String kz = w.kurzzeichen() != null ? w.kurzzeichen() : kurzzeichen.vergeben(tenant, OrtArt.STANDORT);
            Adresse ad = w.adresse();
            Lage lage = w.lage();
            UUID neu = standorte.anlegen(new NeuerStandort(tenant, u.id(), w.name(), kz, ad.strasse(), ad.plz(),
                    ad.ort(), ad.land(), w.zeitzone(), w.nutzung(), w.notiz(),
                    lage == null ? null : lage.breitengrad(), lage == null ? null : lage.laengengrad(),
                    AKTIV, wer.sub()), jetzt);
            protokoll.eintragen(tenant, OBJEKT, neu, "angelegt", null, alleFelder(kz, w, AKTIV), heute, zone,
                    jetzt, wer);
            return neu;
        }));
        return lesen(id, heute);
    }

    // ------------------------------------------------------------- bearbeiten

    /**
     * Schreibt die Stammdaten (die ganze Menge — ein fehlendes Feld ist leer). Ein Entwurf,
     * dem die Adresse nachgetragen wird, ist ab jetzt eingerichtet und aktiv (E10); einem
     * eingerichteten Standort darf sie nicht mehr fehlen. Ändert sich nichts, wird nichts
     * geschrieben und nichts protokolliert; sonst trägt der Eintrag „bearbeitet" alt/neu NUR
     * der geänderten Felder.
     */
    public StandortAmStichtag bearbeiten(UUID id, StandortDto.Stammdaten b, ProtokollAkteur wer) {
        StandortRepository.Standort s = finde(id);
        if (s.archiviertAm() != null) {
            throw archiviert(s);
        }
        Werte w = werte(b, null, false);
        boolean entwurf = ENTWURF.equals(s.zustand());
        if (!entwurf) {
            OrtFelder.adressePflicht(w.adresse(), "adresse");
        }
        String zustand = !entwurf ? s.zustand()
                : StandortLesemodell.adresseVollstaendig(w.adresse().strasse(), w.adresse().ort(),
                        w.adresse().land()) ? AKTIV : ENTWURF;
        Instant jetzt = uhr.instant();
        ZoneId zone = ZoneId.of(w.zeitzone());
        LocalDate heute = tag(jetzt, zone);
        nameFrei(baum(), w.name(), heute, s.kurzzeichen());
        if (!w.kurzzeichen().equals(s.kurzzeichen())) {
            kurzzeichen.pruefeFrei(w.kurzzeichen(), id);
        }

        Map<String, Object> vorher = alleFelder(s.kurzzeichen(), new Werte(s.name(), s.kurzzeichen(),
                new Adresse(s.strasse(), s.plz(), s.ort(), s.land()), s.zeitzone(), s.nutzung(), s.notiz(),
                s.lageBreitengrad() == null ? null : new Lage(s.lageBreitengrad(), s.lageLaengengrad())), s.zustand());
        Map<String, Object> nachher = alleFelder(w.kurzzeichen(), w, zustand);
        Map<String, Object> alt = new LinkedHashMap<>();
        Map<String, Object> neu = new LinkedHashMap<>();
        nachher.forEach((feld, wert) -> {
            if (!Objects.equals(vorher.get(feld), wert)) {
                alt.put(feld, vorher.get(feld));
                neu.put(feld, wert);
            }
        });
        if (neu.isEmpty()) {
            return lesen(id, heute);
        }
        UUID tenant = TenantContext.get();
        schreibe(w.name(), w.kurzzeichen(), id, heute, () -> transaktion.execute(tx -> {
            Adresse ad = w.adresse();
            Lage lage = w.lage();
            if (!standorte.bearbeiten(id, new Stammdaten(w.name(), w.kurzzeichen(), ad.strasse(), ad.plz(),
                    ad.ort(), ad.land(), w.zeitzone(), w.nutzung(), w.notiz(),
                    lage == null ? null : lage.breitengrad(), lage == null ? null : lage.laengengrad(), zustand))) {
                throw archiviert(finde(id));
            }
            protokoll.eintragen(tenant, OBJEKT, id, "bearbeitet", alt, neu, heute, zone, jetzt, wer);
            return id;
        }));
        return lesen(id, heute);
    }

    // ------------------------------------------------------------ archivieren

    /**
     * E12: nur ohne aktive Anlage (am Standort, heute), ohne aktive Messstelle im Teilbaum und
     * ohne geplante Zuordnung hinein oder heraus — sonst 409 mit ALLEN Sperrgründen in fester
     * Reihenfolge, dem Satz mit Grund und Weg ({@link OrtsbaumAbleitung#archivieren}) und je
     * Grund dem Weg als Code. Leere Gebäude und Bereiche werden mitarchiviert: ihr laufendes
     * Intervall endet am Vortag (begann es erst heute, wird es aufgehoben — es belegte keinen
     * Tag). Keine Kaskade auf Anlagen oder Messstellen. EIN Protokolleintrag am Standort, der
     * die Mitarchivierten nennt.
     */
    public StandortAmStichtag archivieren(UUID id, ProtokollAkteur wer) {
        StandortRepository.Standort s = finde(id);
        Instant jetzt = uhr.instant();
        ZoneId zone = ZoneId.of(s.zeitzone());
        LocalDate heute = tag(jetzt, zone);
        Baum b = baum();
        ArchivErgebnis e = OrtsbaumAbleitung.archivieren(b.baum(), s.kurzzeichen(), heute);
        if (!e.erlaubt()) {
            throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.ARCHIVIEREN_GESPERRT, e.text(),
                    Map.of("gruende", e.gruende().stream().map(g -> grund(g, b)).toList()));
        }
        UUID tenant = TenantContext.get();
        transaktion.execute(tx -> {
            if (!standorte.archivieren(id, jetzt, wer.sub())) {
                throw archiviert(finde(id));
            }
            List<Map<String, Object>> mit = new ArrayList<>();
            for (Archiviert a : e.archiviert()) {
                if (a.kennzeichen().equals(s.kurzzeichen())) {
                    continue;
                }
                OrtRepository.Ort o = b.ort(a.kennzeichen());
                orte.archivieren(o.id(), jetzt, wer.sub());
                for (OrtZuordnungRepository.Zuordnung iv : b.zeilen().ortZuordnungen()) {
                    if (iv.ortId().equals(o.id()) && !iv.aufgehoben()
                            && (iv.gueltigBis() == null || !iv.gueltigBis().isBefore(heute))) {
                        if (a.letzterTag().isBefore(iv.gueltigAb())) {
                            ortZuordnungen.aufheben(iv.id(), jetzt);
                        } else {
                            ortZuordnungen.beenden(iv.id(), a.letzterTag());
                        }
                    }
                }
                Map<String, Object> kind = new LinkedHashMap<>();
                kind.put("id", o.id().toString());
                kind.put("art", o.art());
                kind.put("kurzzeichen", o.kurzzeichen());
                kind.put("name", o.name());
                mit.add(kind);
            }
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("zustand", s.zustand());
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("zustand", "archiviert");
            neu.put("archiviert_am", ZEIT.format(jetzt.atZone(zone)));
            neu.put("letzter_tag", heute.minusDays(1).toString());
            neu.put("mitarchiviert", mit);
            protokoll.eintragen(tenant, OBJEKT, id, OrtAenderungRepository.ARCHIVIERT, alt, neu, heute, zone,
                    jetzt, wer);
            return id;
        });
        return lesen(id, heute);
    }

    // -------------------------------------------------------- wiederherstellen

    /**
     * Ein NEUES Bestehen ab heute; die Lücke seit dem Archivieren bleibt sichtbar und wird nie
     * aufgefüllt (§4.2, A8). Der Name muss unter den Standorten, die es heute gibt, frei sein —
     * sonst 409 mit Verweis, und {@code name} benennt ihn im selben Dialog um. Mitarchivierte
     * Gebäude und Bereiche kommen NICHT still mit zurück (Vektor-Fall
     * {@code standort-kinder-bleiben-archiviert}). Zustand danach: aktiv mit Adresse, sonst
     * wieder Entwurf.
     */
    public StandortAmStichtag wiederherstellen(UUID id, StandortDto.Wiederherstellen w, ProtokollAkteur wer) {
        StandortRepository.Standort s = finde(id);
        String neuerName = w == null || w.name() == null ? null : OrtFelder.name(w.name(), "name");
        Instant jetzt = uhr.instant();
        ZoneId zone = ZoneId.of(s.zeitzone());
        LocalDate heute = tag(jetzt, zone);
        Baum b = baum();
        WiederherstellErgebnis e = OrtsbaumAbleitung.wiederherstellen(b.baum(), s.kurzzeichen(), heute, neuerName);
        if (!e.erlaubt()) {
            throw wiederherstellenGesperrt(e, b, s, heute, neuerName);
        }
        String zustand = StandortLesemodell.adresseVollstaendig(s.strasse(), s.ort(), s.land()) ? AKTIV : ENTWURF;
        UUID tenant = TenantContext.get();
        schreibe(e.name(), null, id, heute, () -> transaktion.execute(tx -> {
            if (!standorte.wiederherstellen(id, e.name(), zustand)) {
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.WIEDERHERSTELLEN_GESPERRT,
                        s.name() + " ist nicht archiviert.", Map.of("grund", "nicht_archiviert"));
            }
            Map<String, Object> alt = new LinkedHashMap<>();
            Map<String, Object> neu = new LinkedHashMap<>();
            alt.put("zustand", "archiviert");
            neu.put("zustand", zustand);
            if (!e.name().equals(s.name())) {
                alt.put("name", s.name());
                neu.put("name", e.name());
            }
            Map<String, Object> luecke = null;
            if (e.luecke() != null) {
                luecke = new LinkedHashMap<>();
                luecke.put("von", e.luecke().von().toString());
                luecke.put("bis", e.luecke().bis().toString());
            }
            neu.put("luecke", luecke);
            protokoll.eintragen(tenant, OBJEKT, id, OrtAenderungRepository.WIEDERHERGESTELLT, alt, neu, heute,
                    zone, jetzt, wer);
            return id;
        }));
        return lesen(id, heute);
    }

    // ------------------------------------------------------------ Urteile

    private void nameFrei(Baum b, String name, LocalDate heute, String ausser) {
        Optional<OrtsbaumAbleitung.Ort> belegt =
                OrtsbaumAbleitung.nameBelegt(b.baum(), OrtArt.STANDORT, null, name, heute, ausser);
        if (belegt.isPresent()) {
            throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.NAME_BELEGT, OrtsbaumAbleitung.nameBelegtSatz(belegt.get()),
                    Map.of("verweis", verweis(belegt.get(), b)));
        }
    }

    private OrtAbgelehnt wiederherstellenGesperrt(WiederherstellErgebnis e, Baum b,
            StandortRepository.Standort s, LocalDate heute, String neuerName) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("grund", e.grund().name().toLowerCase(Locale.ROOT));
        if (e.grund() == WiederherstellGrund.NAME_BELEGT) {
            String name = neuerName == null ? s.name() : neuerName;
            OrtsbaumAbleitung.nameBelegt(b.baum(), OrtArt.STANDORT, null, name, heute, s.kurzzeichen())
                    .ifPresent(o -> fakten.put("verweis", verweis(o, b)));
        }
        return OrtAbgelehnt.von(OrtAbgelehnt.Grund.WIEDERHERSTELLEN_GESPERRT, e.text(), fakten);
    }

    private static OrtAbgelehnt archiviert(StandortRepository.Standort s) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("archiviert_am", s.archiviertAm() == null ? null
                : ZEIT.format(s.archiviertAm().atZone(ZoneId.of(s.zeitzone()))));
        return OrtAbgelehnt.von(OrtAbgelehnt.Grund.ARCHIVIERT, s.name() + " ist archiviert. Stellen Sie den "
                + "Standort zuerst wieder her, um ihn zu bearbeiten.", fakten);
    }

    /** Ein Sperrgrund in der Antwort: der Grund des Vertrags, wer sperrt, und der Weg als Code. */
    private static Map<String, Object> grund(ArchivGrund g, Baum b) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("art", g.art().name().toLowerCase(Locale.ROOT));
        OrtRepository.Ort ort = b.orte().get(g.kennzeichen());
        UUID standort = b.standorte().get(g.kennzeichen());
        boolean anlage = b.anlagen().containsKey(g.kennzeichen());
        m.put("objekt", anlage ? "anlage" : standort != null ? "standort" : ort != null ? ort.art() : "messstelle");
        m.put("id", anlage ? b.anlagen().get(g.kennzeichen()) : standort != null ? standort
                : ort != null ? ort.id() : null);
        m.put("kennzeichen", anlage ? null : g.kennzeichen());
        m.put("name", g.name());
        if (g.art() == ArchivGrundArt.GEPLANTE_ZUORDNUNG) {
            m.put("ab", g.ab().toString());
            m.put("eltern", g.eltern());
        }
        m.put("weg", switch (g.art()) {
            case ANLAGE_AKTIV -> "anlage_zuordnen";
            case MESSSTELLE_AKTIV -> "messstelle_umziehen";
            case GEPLANTE_ZUORDNUNG -> "zuordnung_aufheben";
            case GAB_ES_NOCH_NICHT, ARCHIVIERT -> null;
        });
        return m;
    }

    /** Der Verweis auf den Standort, der den Namen trägt — der Link „oder öffnen Sie …". */
    private static Map<String, Object> verweis(OrtsbaumAbleitung.Ort o, Baum b) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("objekt_art", o.art().code());
        m.put("id", b.standorte().get(o.kennzeichen()));
        m.put("kurzzeichen", o.kennzeichen());
        m.put("name", o.name());
        return m;
    }

    // ---------------------------------------------------------------- Baum

    /**
     * Der Stand, auf dem geurteilt wird: die Zeilen des Lesemodells als Ortsbaum des Vertrags
     * — Orte mit ihren Kurzzeichen als Schlüssel (eindeutig über Standorte und Orte,
     * V20260911210000), Anlagen mit ihrer ID, dazu die Messstellen aus {@link OrtsbaumMessstellen}.
     * Derselbe Baum trägt die Zuordnung der Messstelle zu ihrem Ort ({@link MessstelleZuordnungService}).
     */
    record Baum(Ortsbaum baum, Zeilen zeilen, Map<String, UUID> standorte,
            Map<String, OrtRepository.Ort> orte, Map<String, UUID> anlagen) {

        OrtRepository.Ort ort(String kennzeichen) {
            return orte.get(kennzeichen);
        }
    }

    private Baum baum() {
        return baum(messstellen.getIfAvailable(OrtsbaumMessstellen.Keine::new).messstellen());
    }

    /** Der Baum mit genau diesen Messstellen (deren Intervall-Eltern Kurzzeichen bzw. „U“ sind). */
    Baum baum(List<OrtsbaumAbleitung.Messstelle> ms) {
        Zeilen z = lesemodell.zeilen();
        Map<String, String> kz = new HashMap<>();
        Map<String, UUID> standortJeKz = new HashMap<>();
        Map<String, OrtRepository.Ort> ortJeKz = new HashMap<>();
        Map<String, UUID> anlageJeKz = new HashMap<>();
        z.standorte().forEach(s -> {
            kz.put(s.id().toString(), s.kurzzeichen());
            standortJeKz.put(s.kurzzeichen(), s.id());
        });
        z.orte().forEach(o -> {
            kz.put(o.id().toString(), o.kurzzeichen());
            ortJeKz.put(o.kurzzeichen(), o);
        });
        z.anlagen().forEach(a -> anlageJeKz.put(a.id().toString(), a.id()));
        Ortsbaum roh = StandortLesemodell.baum(z);
        List<OrtsbaumAbleitung.Ort> baumOrte = roh.orte().stream()
                .map(o -> new OrtsbaumAbleitung.Ort(kz.get(o.kennzeichen()), o.art(), o.name(), o.zeitzone(),
                        umschluesseln(o.intervalle(), kz), o.flaechen()))
                .toList();
        List<OrtsbaumAbleitung.Anlage> baumAnlagen = roh.anlagen().stream()
                .map(a -> new OrtsbaumAbleitung.Anlage(a.kennzeichen(), a.name(), a.netzanschluss(), a.zustand(),
                        umschluesseln(a.zuordnungen(), kz)))
                .toList();
        return new Baum(new Ortsbaum(roh.zeitzone(), baumOrte, baumAnlagen, ms), z, standortJeKz, ortJeKz,
                anlageJeKz);
    }

    private static List<Intervall> umschluesseln(List<Intervall> liste, Map<String, String> kz) {
        return liste.stream()
                .map(i -> new Intervall(i.ab(), i.bis(), i.eltern() == null ? null : kz.getOrDefault(i.eltern(),
                        i.eltern()), i.aufgehoben()))
                .toList();
    }

    // ---------------------------------------------------------------- Gerüst

    /** Die Felder der Anfrage in ihrer gespeicherten Form. */
    private record Werte(String name, String kurzzeichen, Adresse adresse, String zeitzone,
            List<String> nutzung, String notiz, Lage lage) {}

    /**
     * Die Form (400): beim Anlegen sind Kurzzeichen und Zeitzone optional (automatisch bzw.
     * die Vorgabe des Unternehmens), beim Bearbeiten Pflicht.
     */
    private static Werte werte(StandortDto.Stammdaten a, String zeitzonenVorgabe, boolean anlegen) {
        if (a == null) {
            throw OrtAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        String name = OrtFelder.name(a.name(), "name");
        String kz = OrtKurzzeichen.form(a.kurzzeichen(), "kurzzeichen");
        if (kz == null && !anlegen) {
            throw OrtAbgelehnt.anfrage("kurzzeichen", "Das Kurzzeichen fehlt.");
        }
        return new Werte(name, kz, OrtFelder.adresse(a.adresse(), "adresse"),
                OrtFelder.zeitzone(a.zeitzone(), "zeitzone", zeitzonenVorgabe),
                OrtFelder.nutzung(a.nutzung(), "nutzung"),
                OrtFelder.text(a.notiz(), "notiz", OrtFelder.NOTIZ_HOECHSTENS, "Die Notiz"),
                OrtFelder.lage(a.lage(), "lage"));
    }

    /** Alle Felder, wie das Protokoll sie nennt (snake_case, Codes, nie Kundenworte). */
    private static Map<String, Object> alleFelder(String kz, Werte w, String zustand) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kurzzeichen", kz);
        m.put("name", w.name());
        Adresse a = w.adresse();
        Map<String, Object> adresse = new LinkedHashMap<>();
        adresse.put("strasse", a.strasse());
        adresse.put("plz", a.plz());
        adresse.put("ort", a.ort());
        adresse.put("land", a.land());
        m.put("adresse", adresse);
        m.put("zeitzone", w.zeitzone());
        m.put("nutzung", w.nutzung());
        m.put("notiz", w.notiz());
        Map<String, Object> lage = null;
        if (w.lage() != null) {
            lage = new LinkedHashMap<>();
            lage.put("breitengrad", w.lage().breitengrad().stripTrailingZeros().toPlainString());
            lage.put("laengengrad", w.lage().laengengrad().stripTrailingZeros().toPlainString());
        }
        m.put("lage", lage);
        m.put("zustand", zustand);
        return m;
    }

    /**
     * Schreibt und fängt das eine Rennen, das die Prüfung vorher nicht ausschließen kann: ein
     * anderer belegt denselben Namen oder dasselbe Kurzzeichen zwischen Prüfung und Schreiben.
     * Die Datenbank lehnt mit 23505 ab; nach dem Zurückrollen urteilen die Regeln neu und
     * nennen den Träger.
     */
    private <T> T schreibe(String name, String kz, UUID fuer, LocalDate heute, Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            if ("23505".equals(sqlState(e))) {
                String ausser = fuer == null ? null : finde(fuer).kurzzeichen();
                nameFrei(baum(), name, heute, ausser);
                if (kz != null) {
                    kurzzeichen.pruefeFrei(kz, fuer);
                }
            }
            throw e;
        }
    }

    private StandortRepository.Standort finde(UUID id) {
        return standorte.finde(id).orElseThrow(() -> OrtAbgelehnt.nichtGefunden("Diesen Standort gibt es nicht."));
    }

    private StandortAmStichtag lesen(UUID id, LocalDate heute) {
        return lesemodell.standort(id, heute).orElseThrow(() ->
                OrtAbgelehnt.nichtGefunden("Diesen Standort gibt es nicht."));
    }

    private static UUID kundenbereich() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw OrtAbgelehnt.nichtGefunden("Kein Kundenbereich gewählt.");
        }
        return tenant;
    }

    private static LocalDate tag(Instant jetzt, ZoneId zone) {
        return jetzt.atZone(zone).toLocalDate();
    }

    private static String sqlState(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException s && s.getSQLState() != null) {
                return s.getSQLState();
            }
        }
        return null;
    }
}
