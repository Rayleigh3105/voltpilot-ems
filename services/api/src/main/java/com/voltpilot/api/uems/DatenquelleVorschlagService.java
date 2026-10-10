package com.voltpilot.api.uems;

import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.entities.LeadDeviceService.FuehrendeBox;
import com.voltpilot.api.uems.BestandAnschluss.Anschluss;
import com.voltpilot.api.uems.DatenquelleAbgelehnt.Schnittstelle;
import com.voltpilot.api.uems.DatenquelleBestandRepository.Bestand;
import com.voltpilot.api.uems.DatenquelleRegeln.AntragErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.BestandKomponente;
import com.voltpilot.api.uems.DatenquelleRegeln.Grund;
import com.voltpilot.api.uems.DatenquelleRegeln.Quelle;
import com.voltpilot.api.uems.DatenquelleRegeln.Vorschlag;
import com.voltpilot.api.uems.DatenquelleRegeln.Vorschlagsliste;
import com.voltpilot.api.uems.DatenquelleRepository.Box;
import com.voltpilot.api.uems.DatenquelleRepository.Datenquelle;
import com.voltpilot.api.uems.DatenquelleRepository.NeueDatenquelle;
import com.voltpilot.api.web.dto.DatenquelleDto;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Vorschlagsliste der Bestands-Übernahme (UEMS AP-06 IP-4, Vertrag
 * {@code docs/contracts/v2/data-source-assignment.md} §8, Abnahme A12): die vorhandenen
 * Komponenten einer Anlage, gruppiert zu Datenquellen je Box — und erst die Bestätigung schreibt.
 *
 * <p><b>Keine zweite Regel.</b> Gruppiert wird allein von {@link DatenquelleRegeln#vorschlagsliste}
 * (Vektoren: Familie {@code bestand}); ob eine Adresse an der Box schon vergeben ist, sagt
 * {@link DatenquelleRegeln#bestandWegVergeben} mit dem Grund und Satz des Antrags. Dieser Dienst
 * sammelt nur die Eingänge — den Anschluss je Komponente ({@link BestandAnschluss}), die Box, die
 * sie heute liest, und den Reihenbeginn ({@link DatenquelleBestandRepository}) — und schreibt mit
 * den Bausteinen der Datenquellen-Schnittstelle ({@link DatenquelleRepository#anlegen},
 * {@link ZustaendigkeitRepository#eintragen}, {@link DatenquelleService#eintragen}).
 *
 * <p><b>Die Box einer Komponente</b> ist die, die sie heute liest: die eigene einer komponierten
 * Zeile ({@code measurement_point.device_id}), die Box, an deren Zentrale eine Ladestation hängt,
 * sonst die führende Box ({@link LeadDeviceService}) — ihr stellt der Registry-Push die
 * Komponenten zu. Führt keine, liest keine: {@code keine_box}.
 *
 * <p><b>Der Reihenbeginn</b> ist der Beginn der ersten Speisung der Komponente (AP-04: der Beginn
 * ihres Verlaufs), aber nie vor der Ankunft der Box in ihrer Anlage (auf die nächste volle Minute):
 * vorher hat diese Box nichts gelesen. Es ist der EINZIGE Weg, auf dem eine Zuständigkeit in der
 * Vergangenheit beginnt (Vertrag §4).
 *
 * <p><b>Ohne Bestätigung ändert sich nichts</b> (A12): das GET liest nur. Und auch nach der
 * Bestätigung nicht, was eine Box erreicht — Registry-Push, Flow-Aktivierung, Mess-Plan und
 * Herzschlag lesen keine der geschriebenen Spalten (Push je Box ist IP-6).
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt {@code authenticated()} plus die Mandanten-RLS — eine
 * fremde Anlage ist 404.
 */
@Service
public class DatenquelleVorschlagService {

    private final DatenquelleBestandRepository bestand;
    private final DatenquelleRepository quellen;
    private final ZustaendigkeitRepository zustaendigkeiten;
    private final DatenquelleService datenquellen;
    private final LeadDeviceService fuehrung;
    private final TransactionTemplate transaktion;

    public DatenquelleVorschlagService(DatenquelleBestandRepository bestand, DatenquelleRepository quellen,
            ZustaendigkeitRepository zustaendigkeiten, DatenquelleService datenquellen, LeadDeviceService fuehrung,
            PlatformTransactionManager transaktionen) {
        this.bestand = bestand;
        this.quellen = quellen;
        this.zustaendigkeiten = zustaendigkeiten;
        this.datenquellen = datenquellen;
        this.fuehrung = fuehrung;
        this.transaktion = new TransactionTemplate(transaktionen);
    }

    // ------------------------------------------------------------------- Lesen

    /** Die Vorschlagsliste der Anlage — schreibt nichts. */
    public DatenquelleDto.Vorschlagsliste vorschlag(UUID siteId) {
        datenquellen.anlage(siteId);
        Lage lage = lage(siteId);
        List<DatenquelleDto.Vorschlag> vorschlaege = new ArrayList<>();
        for (Vorschlag v : lage.liste().vorschlaege()) {
            Optional<AntragErgebnis> gesperrt = sperre(v, lage);
            vorschlaege.add(new DatenquelleDto.Vorschlag(v.kennzeichen(), box(v.box(), lage), v.protokoll(),
                    v.adresse(), v.geraeteIds(), v.kadenzS(), v.steuerquelle(), beginn(v),
                    v.komponenten().stream().map(k -> komponente(k, lage)).toList(),
                    gesperrt.map(e -> e.grund().code()).orElse(null),
                    gesperrt.map(AntragErgebnis::text).orElseGet(() -> DatenquelleRegeln.liestAb(beginn(v),
                            lage.boxNamen().getOrDefault(v.box(), v.box()), DatenquelleService.ZONE)),
                    ziel(siteId, v, gesperrt, lage)
                            .map(q -> new DatenquelleDto.VorschlagZiel(q.id(), q.kennzeichen(), q.name()))
                            .orElse(null)));
        }
        List<DatenquelleDto.Ausgelassen> ausgelassen = lage.liste().ausgelassen().stream()
                .map(a -> new DatenquelleDto.Ausgelassen(komponente(a.komponente(), lage), a.grund().code(),
                        a.protokoll(), a.anker() == null ? null : komponente(a.anker(), lage), a.text()))
                .toList();
        UUID fuehrend = lage.fuehrend().box();
        return new DatenquelleDto.Vorschlagsliste(fuehrend == null ? null : DatenquelleService.dto(fuehrend,
                lage.boxen()), lage.fuehrend().grund().code(), vorschlaege, ausgelassen);
    }

    // -------------------------------------------------------------- Übernehmen

    /**
     * Schreibt die bestätigten Vorschläge — je Vorschlag die Quelle (Kennzeichen DQ-n vergibt die
     * Datenbank), ihre Zuständigkeit {@code [Reihenbeginn, offen)}, {@code measurement_point.data_source_id}
     * und {@code geraet.data_source_id} der laufenden Speisung, und EINEN Protokoll-Eintrag
     * {@code aus_bestand_uebernommen} — alles in EINER Transaktion. Bestätigt wird nur, was gezeigt
     * wurde: ein Vorschlag, den es so nicht mehr gibt, ist 409 {@code vorschlag_geaendert}; eine
     * Komponente, die inzwischen auf anderem Weg eine Quelle hat, 409 {@code komponente_hat_quelle}.
     * Ein schon übernommener Vorschlag zählt als unverändert — ein zweiter Aufruf legt nichts an.
     *
     * <p><b>Gerät dort hinzufügen.</b> Nennt ein bestätigter Vorschlag {@code datenquelle_id}, hängt
     * die Bestätigung seine Komponenten an diese VORHANDENE Quelle — nur, wenn das GET sie als
     * {@code ziel} zeigt ({@link #ziel}: der Vorschlag ist {@code adresse_an_box_vergeben}, die
     * Quelle hat an dieser Box eine nicht beendete Zuständigkeit unter demselben Weg); sonst 409
     * {@code vorschlag_geaendert}.
     * Ihre Zuständigkeit bleibt, wie sie ist — die Komponenten gehören ab jetzt dazu, nie rückwirkend.
     */
    public DatenquelleDto.Uebernommen uebernehmen(UUID siteId, DatenquelleDto.Uebernehmen u, ProtokollAkteur wer) {
        datenquellen.anlage(siteId);
        List<DatenquelleDto.Bestaetigt> bestaetigt = gepruefteAnfrage(u);
        UUID mandant = DatenquelleService.mandant();
        Ergebnis e;
        try {
            e = transaktion.execute(s -> uebernehmenInDerTransaktion(mandant, siteId, bestaetigt, wer));
        } catch (DataIntegrityViolationException ex) {
            throw DatenquelleService.rueckwand(ex);
        }
        return new DatenquelleDto.Uebernommen(e.neu(), e.unveraendert(), e.angehaengt(),
                e.quellen().stream().map(id -> datenquellen.eine(siteId, id)).toList());
    }

    private record Ergebnis(int neu, int unveraendert, int angehaengt, List<UUID> quellen) {}

    private Ergebnis uebernehmenInDerTransaktion(UUID mandant, UUID siteId, List<DatenquelleDto.Bestaetigt> bestaetigt,
            ProtokollAkteur wer) {
        bestand.sperreAnlage(siteId);
        Lage lage = lage(siteId);
        Map<DatenquelleDto.Bestaetigt, UUID> schon = new HashMap<>();
        Map<DatenquelleDto.Bestaetigt, Vorschlag> neu = new HashMap<>();
        Map<DatenquelleDto.Bestaetigt, Vorschlag> anhaengen = new HashMap<>();
        for (DatenquelleDto.Bestaetigt b : bestaetigt) {
            Optional<UUID> uebernommen = schonUebernommen(b, lage);
            if (uebernommen.isPresent()) {
                schon.put(b, uebernommen.get());
                continue;
            }
            versorgt(b, lage);
            Vorschlag v = lage.liste().vorschlaege().stream()
                    .filter(x -> x.box().equals(b.deviceId().toString()) && x.protokoll().equals(b.protokoll())
                            && x.adresse().equals(b.adresse())
                            && Set.copyOf(x.komponenten()).equals(texte(b.komponenten())))
                    .findFirst()
                    .orElseThrow(() -> DatenquelleAbgelehnt.schnittstelle(Schnittstelle.VORSCHLAG_GEAENDERT,
                            "Dieser Vorschlag hat sich inzwischen geändert — bitte die Vorschlagsliste neu laden",
                            fakten(b)));
            Optional<AntragErgebnis> gesperrt = sperre(v, lage);
            if (b.datenquelleId() != null) {
                // Gezeigt war „an diese Quelle hängen" — gilt nur, solange das GET genau sie zeigt.
                if (!ziel(siteId, v, gesperrt, lage).map(q -> q.id().equals(b.datenquelleId())).orElse(false)) {
                    throw DatenquelleAbgelehnt.schnittstelle(Schnittstelle.VORSCHLAG_GEAENDERT,
                            "Dieser Vorschlag hat sich inzwischen geändert — bitte die Vorschlagsliste neu laden",
                            fakten(b));
                }
                anhaengen.put(b, v);
                continue;
            }
            if (gesperrt.isPresent()) {
                throw DatenquelleAbgelehnt.regel(gesperrt.get());
            }
            neu.put(b, v);
        }

        // Geschrieben wird in der Reihenfolge der Liste — so vergibt die Datenbank die
        // Kennzeichen, die das GET gezeigt hat, wenn alles (oder der Anfang) bestätigt wird.
        Map<Vorschlag, UUID> angelegt = new HashMap<>();
        for (Vorschlag v : lage.liste().vorschlaege()) {
            if (neu.containsValue(v)) {
                angelegt.put(v, schreibe(mandant, siteId, v, lage, wer));
            }
        }
        for (Map.Entry<DatenquelleDto.Bestaetigt, Vorschlag> a : anhaengen.entrySet()) {
            haenge(mandant, siteId, a.getValue(), a.getKey().datenquelleId(), lage, wer);
        }
        List<UUID> ergebnis = new ArrayList<>();
        for (DatenquelleDto.Bestaetigt b : bestaetigt) {
            ergebnis.add(schon.containsKey(b) ? schon.get(b)
                    : anhaengen.containsKey(b) ? b.datenquelleId() : angelegt.get(neu.get(b)));
        }
        return new Ergebnis(angelegt.size(), schon.size(), anhaengen.size(), ergebnis);
    }

    /**
     * Hängt die Komponenten eines gesperrten Vorschlags an die vorhandene Quelle {@code ziel} —
     * dieselben Schreibbausteine wie {@link #schreibe}, ohne neue Quelle und ohne neue
     * Zuständigkeit; der Protokoll-Eintrag {@code aus_bestand_uebernommen} gilt ab jetzt.
     */
    private void haenge(UUID mandant, UUID siteId, Vorschlag v, UUID ziel, Lage lage, ProtokollAkteur wer) {
        List<UUID> komponenten = v.komponenten().stream().map(UUID::fromString).toList();
        if (bestand.verknuepfeKomponenten(ziel, siteId, komponenten) != komponenten.size()) {
            throw DatenquelleService.gleichzeitig(Grund.UEBERSCHNEIDUNG);
        }
        bestand.verknuepfeGeraete(ziel, komponenten);
        Datenquelle q = lage.quellen().get(ziel);
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("kennzeichen", q.kennzeichen());
        werte.put("protokoll", q.protokoll());
        werte.put("adresse", q.adresse());
        werte.put("box", v.box());
        werte.put("box_name", lage.boxNamen().get(v.box()));
        werte.put("komponenten", v.komponenten());
        werte.put("angehaengt", true);
        datenquellen.eintragen(mandant, ziel, "aus_bestand_uebernommen", UUID.fromString(v.box()), null, null, werte,
                Instant.now().truncatedTo(ChronoUnit.MINUTES), wer);
    }

    /**
     * Die vorhandene Quelle, an die ein gesperrter Vorschlag seine Komponenten hängen kann
     * („Gerät dort hinzufügen?"): nur bei {@code adresse_an_box_vergeben}, und nur, wenn es genau
     * EINE gibt — dieselbe Anlage, nicht archiviert, derselbe Weg (Protokoll + Adresse, wie
     * {@link DatenquelleRegeln#bestandWegVergeben} vergleicht), ihre Zuständigkeit an der Box des
     * Vorschlags ist nicht beendet (eine Zuweisung „ab jetzt“ beginnt erst an der nächsten vollen
     * Minute), sie nennt alle seine Geräte-IDs und ist Steuerquelle, wenn er es ist. Sonst keine:
     * dann bleibt es bei der Ablehnung — der Kunde ordnet die Quelle von Hand.
     */
    private static Optional<Datenquelle> ziel(UUID siteId, Vorschlag v, Optional<AntragErgebnis> gesperrt,
            Lage lage) {
        if (gesperrt.isEmpty() || gesperrt.get().grund() != Grund.ADRESSE_AN_BOX_VERGEBEN) {
            return Optional.empty();
        }
        UUID box = UUID.fromString(v.box());
        Instant jetzt = Instant.now();
        List<Datenquelle> passend = lage.quellen().values().stream()
                .filter(q -> siteId.equals(q.siteId()) && q.archiviertAm() == null)
                .filter(q -> q.protokoll().equals(v.protokoll()) && q.adresse().equals(v.adresse()))
                .filter(q -> lage.zeitraeume().getOrDefault(q.id(), List.of()).stream()
                        .anyMatch(z -> z.deviceId().equals(box)
                                && (z.effectiveTo() == null || z.effectiveTo().isAfter(jetzt))))
                .filter(q -> q.geraeteIds() != null && q.geraeteIds().containsAll(v.geraeteIds()))
                .filter(q -> !v.steuerquelle() || q.steuerquelle())
                .toList();
        return passend.size() == 1 ? Optional.of(passend.get(0)) : Optional.empty();
    }

    private UUID schreibe(UUID mandant, UUID siteId, Vorschlag v, Lage lage, ProtokollAkteur wer) {
        UUID box = UUID.fromString(v.box());
        Instant ab = beginn(v);
        List<UUID> komponenten = v.komponenten().stream().map(UUID::fromString).toList();
        Datenquelle q = quellen.anlegen(new NeueDatenquelle(mandant, siteId, null, v.protokoll(), v.adresse(),
                v.geraeteIds(), null, false, v.steuerquelle(), v.kadenzS(), wer.sub()));
        zustaendigkeiten.eintragen(mandant, q.id(), box, ab, null, wer.sub())
                .orElseThrow(() -> DatenquelleService.gleichzeitig(Grund.UEBERSCHNEIDUNG));
        if (bestand.verknuepfeKomponenten(q.id(), siteId, komponenten) != komponenten.size()) {
            // Eine Komponente hat seit dem Lesen (unter der Sperre) eine Quelle bekommen.
            throw DatenquelleService.gleichzeitig(Grund.UEBERSCHNEIDUNG);
        }
        bestand.verknuepfeGeraete(q.id(), komponenten);

        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("kennzeichen", q.kennzeichen());
        werte.put("protokoll", q.protokoll());
        werte.put("adresse", q.adresse());
        werte.put("geraete_ids", q.geraeteIds());
        werte.put("kadenz_s", q.kadenzS());
        werte.put("steuerquelle", q.steuerquelle());
        werte.put("box", box.toString());
        werte.put("box_name", lage.boxNamen().get(v.box()));
        werte.put("ab", ab.toString());
        werte.put("komponenten", v.komponenten());
        datenquellen.eintragen(mandant, q.id(), "aus_bestand_uebernommen", box, null, null, werte, ab, wer);
        return q.id();
    }

    /**
     * Schon übernommen: jede genannte Komponente trägt DIESELBE Quelle, und die hat genau diesen
     * Weg an genau dieser Box — das, was eine frühere Bestätigung dieses Vorschlags geschrieben hat.
     */
    private static Optional<UUID> schonUebernommen(DatenquelleDto.Bestaetigt b, Lage lage) {
        Set<UUID> ihre = new HashSet<>();
        for (UUID k : b.komponenten()) {
            Bestand kb = lage.komponenten().get(k);
            if (kb == null || kb.datenquelle() == null) {
                return Optional.empty();
            }
            ihre.add(kb.datenquelle());
        }
        if (ihre.size() != 1) {
            return Optional.empty();
        }
        UUID id = ihre.iterator().next();
        Datenquelle q = lage.quellen().get(id);
        boolean weg = q != null && q.protokoll().equals(b.protokoll()) && q.adresse().equals(b.adresse());
        boolean box = lage.zeitraeume().getOrDefault(id, List.of()).stream()
                .anyMatch(z -> z.deviceId().equals(b.deviceId()));
        return weg && box ? Optional.of(id) : Optional.empty();
    }

    /** Hat eine genannte Komponente (oder das Gerät, das sie speist) inzwischen eine Quelle? Dann 409. */
    private static void versorgt(DatenquelleDto.Bestaetigt b, Lage lage) {
        Set<String> komponenten = new LinkedHashSet<>();
        Set<String> kennzeichen = new LinkedHashSet<>();
        for (UUID k : b.komponenten()) {
            Bestand kb = lage.komponenten().get(k);
            UUID q = kb == null ? null : kb.datenquelle() != null ? kb.datenquelle() : kb.geraetQuelle();
            if (q != null) {
                komponenten.add(k.toString());
                Datenquelle d = lage.quellen().get(q);
                kennzeichen.add(d == null ? q.toString() : d.kennzeichen());
            }
        }
        if (!komponenten.isEmpty()) {
            Map<String, Object> f = new LinkedHashMap<>(fakten(b));
            f.put("komponenten", List.copyOf(komponenten));
            f.put("datenquellen", List.copyOf(kennzeichen));
            throw DatenquelleAbgelehnt.schnittstelle(Schnittstelle.KOMPONENTE_HAT_QUELLE,
                    "Inzwischen hat eine Komponente dieses Vorschlags eine Datenquelle ("
                            + String.join(", ", kennzeichen) + ") — bitte die Vorschlagsliste neu laden", f);
        }
    }

    // ---------------------------------------------------------------- Die Lage

    /** Alles, woraus die Liste entsteht — einmal gelesen, unter RLS. */
    private record Lage(FuehrendeBox fuehrend, Map<UUID, Box> boxen, Map<String, String> boxNamen,
            Map<UUID, Bestand> komponenten, Map<UUID, Datenquelle> quellen,
            Map<UUID, List<ZustaendigkeitRepository.Zeitraum>> zeitraeume, List<Quelle> regelQuellen,
            Vorschlagsliste liste) {}

    private Lage lage(UUID siteId) {
        FuehrendeBox fuehrend = fuehrung.fuehrendeBox(siteId);
        Map<UUID, Box> boxen = new LinkedHashMap<>();
        quellen.boxen().forEach(b -> boxen.put(b.id(), b));
        Map<String, String> boxNamen = new LinkedHashMap<>();
        boxen.values().forEach(b -> boxNamen.put(b.id().toString(), DatenquelleService.anzeigename(b)));

        List<Bestand> alle = bestand.derAnlage(siteId);
        Map<UUID, Bestand> komponenten = new LinkedHashMap<>();
        Map<Bestand, UUID> leser = new LinkedHashMap<>();
        for (Bestand b : alle) {
            komponenten.put(b.id(), b);
            leser.put(b, b.stationen() == 1 ? b.stationBox() : b.box() != null ? b.box() : fuehrend.box());
        }
        Map<UUID, Instant> seit = bestand.seitWannIhreAnlage(leser.values().stream().filter(Objects::nonNull)
                .distinct().toList());

        List<BestandKomponente> eingang = new ArrayList<>();
        Map<String, String> namen = new HashMap<>();
        for (Bestand b : alle) {
            namen.put(b.id().toString(), b.name() == null || b.name().isBlank() ? "den Wechselrichter"
                    : "„" + b.name().strip() + "“");
            if (b.datenquelle() != null) {
                continue;
            }
            UUID box = leser.get(b);
            Anschluss a = b.stationen() == 1 ? BestandAnschluss.ocpp(b.stationId())
                    : b.stationen() > 1 ? new Anschluss("ocpp", null, null, null)
                    : BestandAnschluss.aus(b.communication(), b.connectionJson());
            Instant ab = b.reihenbeginn();
            Instant boxSeit = box == null ? null : seit.get(box);
            if (boxSeit != null) {
                Instant volleMinute = boxSeit.truncatedTo(ChronoUnit.MINUTES);
                Instant frueheste = volleMinute.equals(boxSeit) ? boxSeit : volleMinute.plus(1, ChronoUnit.MINUTES);
                if (frueheste.isAfter(ab)) {
                    ab = frueheste;
                }
            }
            eingang.add(new BestandKomponente(b.id().toString(), siteId.toString(), box == null ? null : box.toString(),
                    a.protokoll(), a.adresse(), a.geraeteId(), b.anker() == null ? null : b.anker().toString(),
                    a.kadenzS(), ab, b.steuerbar()));
        }
        Vorschlagsliste liste = DatenquelleRegeln.vorschlagsliste(eingang, bestand.naechsteNummer(),
                bestand.belegteKennzeichen(), namen);

        Map<UUID, Datenquelle> alleQuellen = new LinkedHashMap<>();
        quellen.alle().forEach(q -> alleQuellen.put(q.id(), q));
        Map<UUID, List<ZustaendigkeitRepository.Zeitraum>> zeitraeume = new LinkedHashMap<>();
        for (ZustaendigkeitRepository.Zeitraum z : zustaendigkeiten.alle()) {
            zeitraeume.computeIfAbsent(z.dataSourceId(), k -> new ArrayList<>()).add(z);
        }
        List<Quelle> regelQuellen = alleQuellen.values().stream()
                .map(q -> new Quelle(q.kennzeichen(), q.protokoll(), q.adresse(), q.netz(), q.steuerquelle(),
                        q.mehrereLeser(), zeitraeume.getOrDefault(q.id(), List.of()).stream()
                                .map(z -> new DatenquelleRegeln.Zeitraum(z.deviceId().toString(), z.effectiveFrom(),
                                        z.effectiveTo()))
                                .toList()))
                .toList();
        return new Lage(fuehrend, boxen, boxNamen, komponenten, alleQuellen, zeitraeume, regelQuellen, liste);
    }

    /** Liest an der Box des Vorschlags ab Reihenbeginn schon eine andere Quelle denselben Weg? */
    private static Optional<AntragErgebnis> sperre(Vorschlag v, Lage lage) {
        return DatenquelleRegeln.bestandWegVergeben(v, lage.regelQuellen(), lage.boxNamen());
    }

    // ------------------------------------------------------------------ Gerüst

    private static Instant beginn(Vorschlag v) {
        return v.zeitraeume().get(0).von();
    }

    private static DatenquelleDto.Box box(String id, Lage lage) {
        return DatenquelleService.dto(UUID.fromString(id), lage.boxen());
    }

    private static DatenquelleDto.VorschlagKomponente komponente(String id, Lage lage) {
        Bestand b = lage.komponenten().get(UUID.fromString(id));
        return new DatenquelleDto.VorschlagKomponente(UUID.fromString(id), b == null ? null : text(b.name()),
                b == null ? null : b.art());
    }

    private static Set<String> texte(List<UUID> ids) {
        Set<String> s = new HashSet<>();
        ids.forEach(i -> s.add(i.toString()));
        return s;
    }

    private static Map<String, Object> fakten(DatenquelleDto.Bestaetigt b) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("device_id", b.deviceId().toString());
        f.put("protokoll", b.protokoll());
        f.put("adresse", b.adresse());
        return f;
    }

    /** Die Anfrage in ihrer Form: mindestens ein Vorschlag, je Vorschlag Box, Weg, Komponenten — keine doppelt. */
    private static List<DatenquelleDto.Bestaetigt> gepruefteAnfrage(DatenquelleDto.Uebernehmen u) {
        if (u.vorschlaege() == null || u.vorschlaege().isEmpty()) {
            throw DatenquelleAbgelehnt.anfrage("vorschlaege", "Welche Vorschläge sollen übernommen werden?");
        }
        Set<UUID> gesehen = new HashSet<>();
        for (int i = 0; i < u.vorschlaege().size(); i++) {
            DatenquelleDto.Bestaetigt b = u.vorschlaege().get(i);
            String feld = "vorschlaege[" + i + "]";
            if (b == null) {
                throw DatenquelleAbgelehnt.anfrage(feld, "Ein Vorschlag fehlt.");
            }
            if (b.deviceId() == null) {
                throw DatenquelleAbgelehnt.anfrage(feld + ".device_id", "Welche Box liest diesen Vorschlag?");
            }
            if (text(b.protokoll()) == null || text(b.adresse()) == null) {
                throw DatenquelleAbgelehnt.anfrage(feld + (text(b.protokoll()) == null ? ".protokoll" : ".adresse"),
                        "Ein Vorschlag nennt Protokoll und Adresse, so wie die Liste sie zeigt.");
            }
            if (b.komponenten() == null || b.komponenten().isEmpty() || b.komponenten().contains(null)) {
                throw DatenquelleAbgelehnt.anfrage(feld + ".komponenten", "Ein Vorschlag nennt seine Komponenten.");
            }
            for (UUID k : b.komponenten()) {
                if (!gesehen.add(k)) {
                    throw DatenquelleAbgelehnt.anfrage(feld + ".komponenten",
                            "Eine Komponente steht in genau einem Vorschlag.");
                }
            }
        }
        return List.copyOf(u.vorschlaege());
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
