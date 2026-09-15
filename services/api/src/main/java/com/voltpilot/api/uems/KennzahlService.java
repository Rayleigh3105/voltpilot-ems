package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.KennzahlRepository.BezugsgroesseZeile;
import com.voltpilot.api.uems.KennzahlRepository.EingangZeile;
import com.voltpilot.api.uems.KennzahlRepository.FassungZeile;
import com.voltpilot.api.uems.KennzahlRepository.MessstelleZeile;
import com.voltpilot.api.uems.KennzahlRepository.Zeile;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Kennzahl wird definierbar (UEMS AP-11 IP-5, E1, E7, E10): anlegen mit Fassung 1, Stammdaten ändern,
 * archivieren, löschen, die Berechnung ab einem Tag als Fassung n + 1 — und das Lesemodell der Definition.
 *
 * <p><b>Die Regeln werden AUFGERUFEN</b>, nie nachgebaut: Rechenform, Einheit (U1–U3), Periode (P1–P3), Kreis
 * (Q10 über {@link MessstelleFormelRegeln#zyklus}), Fassung (V1 über {@link MessstelleFormelRegeln#fassungEintrag}),
 * Geltung (G1, G3) aus {@link KennzahlRegeln}; das Recht aus {@link KennzahlRechte} über
 * {@link RechteAbleitung#darf}. Jede Ablehnung ist eine {@link KennzahlAbgelehnt} aus dem geschlossenen Satz des
 * Vertrags; wenn sie fliegt, ist nichts geschrieben.
 *
 * <p><b>Die Prüfreihenfolge</b> (auch für die Vorschau): die Anfrage (400) → der Geltungsbereich
 * ({@code geltung_unbekannt}) → das Recht am Geltungsbereich (403 {@code recht_fehlt} / 404) → das Kennzeichen (409)
 * → die Berechnung (Rechenform, Eingänge, Einheit, Periode, Kreis, G3 — 422).
 *
 * <p><b>Das Protokoll</b> kennt die drei Wörter des Vertrags: Anlegen = {@code kennzahl_fassung_eingetragen} (Fassung
 * 1), eine Fassung n + 1 ebenso (mit „gilt ab“, rückwirkend, Begründung), Stammdaten und Löschen =
 * {@code kennzahl_geaendert} (beim Löschen ist {@code neu} leer), Archivieren = {@code kennzahl_archiviert}.
 */
@Service
public class KennzahlService {

    static final String HERKUNFT_ANLAGE = "anlage";
    static final String HERKUNFT_EINTRAG = "eintrag";
    static final String FASSUNG_EINGETRAGEN = "kennzahl_fassung_eingetragen";
    static final String GEAENDERT = "kennzahl_geaendert";
    static final String ARCHIVIERT = "kennzahl_archiviert";
    static final int TEXT_HOECHSTENS = 500;

    private static final Pattern KENNZEICHEN = Pattern.compile("^[A-Z0-9./-]{2,16}$");
    private static final Pattern AUTOMATISCH = Pattern.compile("^KZ-(\\d+)$");
    /** Tiefe der Kette Kennzahl → Kennzahl beim Lesen der Perioden (wie der Leseweg der Formel-Maschine). */
    private static final int TIEFE = 16;

    private final KennzahlRepository repo;
    private final KennzahlAufrufer aufrufer;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public KennzahlService(KennzahlRepository repo, KennzahlAufrufer aufrufer,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.repo = repo;
        this.aufrufer = aufrufer;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Für Tests: die Uhr, an der „heute“, „rückwirkend“ und die Rechte hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    Instant jetzt() {
        return uhr.instant();
    }

    // ================================================================================ lesen

    public KennzahlDto.Liste liste() {
        Katalog kat = katalog();
        Instant jetzt = jetzt();
        return new KennzahlDto.Liste(kat.kennzahlen().stream().map(k -> darstellung(k, kat, jetzt)).toList());
    }

    /** Die Parameter von {@code GET …/paare} — jeder andere ist 400 (streng wie die Werte-Route). */
    static final Set<String> PARAMETER_PAARE = Set.of("rechenform", "einheit", "standort_id");

    /**
     * Die möglichen Paare einer Zusammenfassung für den Assistenten (AP-11 IP-11, R4, §5.6): jede nicht archivierte
     * Kennzahl mit heute geltender Berechnung in der Gruppe ihrer Rechenform und Einheit — genau die Gleichheit, die
     * {@link KennzahlRegeln#einheit} beim Anlegen verlangt. {@code rechenform} und {@code einheit} lassen nur ihre Gruppe
     * übrig, {@code standort_id} nur Kennzahlen dieses Standorts (die Eingänge einer Standort-Kennzahl liegen im
     * Standort). Gruppen nach Rechenform, dann Einheit; Kennzahlen nach Kennzeichen. Rechnet nichts, schreibt nichts.
     */
    public KennzahlDto.Paare paare(Collection<String> parameter, String rechenform, String einheit, String standortId) {
        for (String p : parameter) {
            if (!PARAMETER_PAARE.contains(p)) {
                throw KennzahlAbgelehnt.anfrage(p);
            }
        }
        if (rechenform != null && !KennzahlRegeln.RECHENFORMEN.contains(rechenform)) {
            throw KennzahlAbgelehnt.anfrage("rechenform");
        }
        if (einheit != null && einheit.isBlank()) {
            throw KennzahlAbgelehnt.anfrage("einheit");
        }
        UUID standort = standortId == null ? null : paarStandort(standortId);
        Map<String, List<KennzahlDto.Kennzahl>> gruppen = new LinkedHashMap<>();
        liste().kennzahlen().stream()
                .filter(k -> k.archiviertAm() == null && k.einheit() != null)
                .filter(k -> rechenform == null || rechenform.equals(k.rechenform()))
                .filter(k -> einheit == null || einheit.equals(k.einheit()))
                .filter(k -> standort == null || standort.equals(k.standortId()))
                .sorted(Comparator.comparingInt((KennzahlDto.Kennzahl k) -> KennzahlRegeln.RECHENFORMEN.indexOf(k.rechenform()))
                        .thenComparing(KennzahlDto.Kennzahl::einheit).thenComparing(KennzahlDto.Kennzahl::kennzeichen))
                .forEach(k -> gruppen.computeIfAbsent(k.rechenform() + '\n' + k.einheit(), x -> new ArrayList<>()).add(k));
        return new KennzahlDto.Paare(gruppen.values().stream().map(ks -> new KennzahlDto.PaarGruppe(ks.get(0).rechenform(),
                ks.get(0).einheit(), ks.get(0).einheitAnzeige(), List.copyOf(ks))).toList());
    }

    private static UUID paarStandort(String text) {
        try {
            return UUID.fromString(text);
        } catch (IllegalArgumentException x) {
            throw KennzahlAbgelehnt.anfrage("standort_id");
        }
    }

    public KennzahlDto.Kennzahl eine(UUID id) {
        Katalog kat = katalog();
        return darstellung(kat.zeile(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN)), kat, jetzt());
    }

    public KennzahlDto.Fassungen fassungen(UUID id) {
        Katalog kat = katalog();
        Zeile k = kat.zeile(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        ZoneId zone = zone(k, jetzt());
        return new KennzahlDto.Fassungen(k.id(), k.kennzeichen(),
                kat.fassungen(id).stream().map(f -> fassungDarstellung(f, kat, zone)).toList());
    }

    /** Welche Fassung galt am Tag {@code am} ({@code null} = heute in der Zeitzone der Kennzahl)? */
    public KennzahlDto.Berechnung berechnung(UUID id, LocalDate am) {
        Katalog kat = katalog();
        Zeile k = kat.zeile(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        ZoneId zone = zone(k, jetzt());
        LocalDate tag = am != null ? am : LocalDate.ofInstant(jetzt(), zone);
        FassungZeile f = kat.fassungAm(id, tag).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        return new KennzahlDto.Berechnung(k.id(), k.kennzeichen(), tag, fassungDarstellung(f, kat, zone));
    }

    // ================================================================================ schreiben

    /** Legt die Kennzahl mit Fassung 1 „gilt seit Beginn“ an (V1, K1). */
    public KennzahlDto.Kennzahl anlegen(KennzahlDto.Anfrage a, ProtokollAkteur wer) {
        Entwurf e = entwurf(a, true, wer);
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = jetzt();
        UUID id = schreibe(() -> transaktion.execute(s -> {
            repo.kundenbereichSperren(tenant);
            Geltung g = geltung(a.geltungArt(), a.geltungId(), jetzt);
            darf(wer, g, jetzt);
            String kennzeichen = kennzeichenFuerNeue(e.kennzeichen(), repo.jeBelegt());
            Katalog kat = katalog();
            Urteil u = berechnung(a.rechenform(), g, a.eingaenge(), a.komplement(), a.periodeArt(), kennzeichen, null,
                    LocalDate.ofInstant(jetzt, g.zone()), kat);
            UUID neu = repo.anlegen(tenant, kennzeichen, e.name(), u.rechenform(), g.art(), g.id(), e.verantwortlichSub(),
                    e.verantwortlichName(), e.zweck());
            UUID fassung = repo.fassungAnlegen(tenant, neu, 1, u.rechenform(), null, HERKUNFT_ANLAGE, false, null, jetzt,
                    wer, u.komplement(), u.einheit());
            eingaengeAnlegen(tenant, neu, fassung, u);
            Map<String, Object> satz = stammdaten(kennzeichen, e.name(), e.verantwortlichName(), e.zweck());
            satz.put("rechenform", u.rechenform());
            satz.put("geltung_art", g.art());
            satz.put("geltung_id", g.id().toString());
            satz.putAll(berechnungsSatz(1, null, u));
            repo.protokoll(tenant, neu, FASSUNG_EINGETRAGEN, null, alsJson(satz), jetzt, false, null, wer);
            return neu;
        }));
        return eine(id);
    }

    /** V4: die GANZEN Stammdaten ohne Fassung; ein unverändertes PUT schreibt nichts, auch kein Protokoll. */
    public KennzahlDto.Kennzahl aendern(UUID id, KennzahlDto.StammdatenAnfrage a, ProtokollAkteur wer) {
        String kennzeichen = pflicht(a.kennzeichen(), "kennzeichen");
        if (!KENNZEICHEN.matcher(kennzeichen).matches()) {
            throw KennzahlAbgelehnt.feld(Ablehnung.KENNZEICHEN_FORMAT, "kennzeichen");
        }
        String name = pflicht(a.name(), "name");
        String verantwortlich = pflicht(a.verantwortlichName(), "verantwortlich_name");
        String zweck = zweck(a.zweck());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = jetzt();
        schreibe(() -> transaktion.execute(s -> {
            Zeile k = repo.sperre(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            darf(wer, geltungVon(k, jetzt), jetzt);
            if (k.archiviertAm() != null) {
                throw KennzahlAbgelehnt.von(Ablehnung.ARCHIVIERT);
            }
            if (!kennzeichen.equals(k.kennzeichen()) && repo.belegtVonAnderen(id).contains(kennzeichen)) {
                throw KennzahlAbgelehnt.feld(Ablehnung.KENNZEICHEN_BELEGT, "kennzeichen");
            }
            Map<String, Object> alt = stammdaten(k.kennzeichen(), k.name(), k.verantwortlichName(), k.zweck());
            Map<String, Object> neu = stammdaten(kennzeichen, name, verantwortlich, zweck);
            Map<String, Object> altGeaendert = new LinkedHashMap<>();
            Map<String, Object> neuGeaendert = new LinkedHashMap<>();
            for (String feld : neu.keySet()) {
                if (!Objects.equals(alt.get(feld), neu.get(feld))) {
                    altGeaendert.put(feld, alt.get(feld));
                    neuGeaendert.put(feld, neu.get(feld));
                }
            }
            if (!neuGeaendert.isEmpty()) {
                String sub = verantwortlich.equals(k.verantwortlichName()) ? k.verantwortlichSub()
                        : verantwortlich.equals(wer.name()) ? wer.sub() : null;
                repo.stammdatenAendern(id, kennzeichen, name, sub, verantwortlich, zweck);
                repo.protokoll(tenant, id, GEAENDERT, alsJson(altGeaendert), alsJson(neuGeaendert), jetzt, false, null,
                        wer);
            }
            return id;
        }));
        return eine(id);
    }

    /** V5: archiviert — die Werte bleiben lesbar, kein Rechenlauf mehr, das Kennzeichen belegt. */
    public KennzahlDto.Kennzahl archivieren(UUID id, ProtokollAkteur wer) {
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = jetzt();
        transaktion.executeWithoutResult(s -> {
            Zeile k = repo.sperre(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            darf(wer, geltungVon(k, jetzt), jetzt);
            if (k.archiviertAm() != null) {
                throw KennzahlAbgelehnt.von(Ablehnung.ARCHIVIERT);
            }
            repo.archivieren(id);
            repo.protokoll(tenant, id, ARCHIVIERT, null, null, jetzt, false, null, wer);
        });
        return eine(id);
    }

    /** V5: gelöscht wird nur ohne einen einzigen Wert und ohne lesende Kennzahl; das Kennzeichen bleibt belegt. */
    public void loeschen(UUID id, ProtokollAkteur wer) {
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = jetzt();
        Zeile vorher = repo.finde(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        try {
            transaktion.executeWithoutResult(s -> {
                Zeile k = repo.sperre(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
                darf(wer, geltungVon(k, jetzt), jetzt);
                long werte = repo.werteZahl(id);
                if (werte > 0) {
                    throw KennzahlAbgelehnt.hatWerte(k.kennzeichen(), werte);
                }
                List<String> leser = repo.leser(id);
                if (!leser.isEmpty()) {
                    throw KennzahlAbgelehnt.wirdGelesen(k.kennzeichen(), leser);
                }
                repo.loeschen(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
                Map<String, Object> alt = stammdaten(k.kennzeichen(), k.name(), k.verantwortlichName(), k.zweck());
                alt.put("rechenform", k.rechenform());
                alt.put("geltung_art", k.geltungArt());
                alt.put("geltung_id", k.geltungId().toString());
                repo.protokoll(tenant, id, GEAENDERT, alsJson(alt), null, jetzt, false, null, wer);
            });
        } catch (DataIntegrityViolationException e) {
            // Das Rennen, das die Sperre nicht ausschließt: der Lauf hängt gerade den ersten Wert an, oder eine
            // Fassung einer anderen Kennzahl liest sie soeben — die Funktion lehnt ab, nichts ist gelöscht.
            String meldung = meldung(e);
            if (meldung.contains("traegt Werte und wird nicht geloescht") || meldung.contains("kennzahl_wert_")) {
                throw KennzahlAbgelehnt.hatWerte(vorher.kennzeichen(), repo.werteZahl(id));
            }
            if (meldung.contains("gelesen") || meldung.contains("kennzahl_eingang_kennzahl_fk")) {
                throw KennzahlAbgelehnt.wirdGelesen(vorher.kennzeichen(), repo.leser(id));
            }
            throw e;
        }
    }

    /** V1: die Berechnung ab einem Tag — Fassung n + 1 beendet n am Vortag, rückwirkend mit Abzeichen (K17). */
    public KennzahlDto.Fassungen fassungEintragen(UUID id, KennzahlDto.FassungAnfrage a, ProtokollAkteur wer) {
        LocalDate ab = tag(pflicht(a.gueltigAb(), "gueltig_ab"), "gueltig_ab");
        String begruendung = pflicht(a.begruendung(), "begruendung");
        if (begruendung.length() > TEXT_HOECHSTENS) {
            throw KennzahlAbgelehnt.anfrage("begruendung");
        }
        wunschPruefen(a.periodeArt());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = jetzt();
        transaktion.executeWithoutResult(s -> {
            repo.kundenbereichSperren(tenant);
            Zeile k = repo.sperre(id).orElseThrow(() -> KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            Geltung g = geltungVon(k, jetzt);
            darf(wer, g, jetzt);
            if (k.archiviertAm() != null) {
                throw KennzahlAbgelehnt.von(Ablehnung.ARCHIVIERT);
            }
            Katalog kat = katalog();
            Urteil u = berechnung(k.rechenform(), g, a.eingaenge(), a.komplement(), a.periodeArt(), k.kennzeichen(),
                    k.id(), ab, kat);
            List<FassungZeile> wirksam = kat.fassungen(id).stream().filter(FassungZeile::wirksam).toList();
            KennzahlRegeln.FassungsUrteil fu = KennzahlRegeln.fassung(wirksam.stream().map(FassungZeile::alsRegel).toList(),
                    ab, OffsetDateTime.ofInstant(jetzt, g.zone()), g.zone());
            if (fu.fehler() != null) {
                FassungZeile juengste = wirksam.get(wirksam.size() - 1);
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("fassung", juengste.nummer());
                fakten.put("gueltig_ab", juengste.gueltigAb() == null ? null : juengste.gueltigAb().toString());
                throw KennzahlAbgelehnt.regel(fu.fehler(), fu.kundensatz(), fakten);
            }
            Map<String, Object> alt = null;
            if (fu.beenden() != null) {
                FassungZeile beendet = wirksam.stream().filter(f -> f.nummer() == fu.beenden()).findFirst().orElseThrow();
                repo.fassungBeenden(beendet.id(), fu.beendenAm());
                alt = new LinkedHashMap<>();
                alt.put("fassung", beendet.nummer());
                alt.put("gueltig_bis", fu.beendenAm().toString());
            }
            // Die Nummer wird nie wiederverwendet — auch nicht die einer aufgehobenen Fassung.
            int nummer = Math.max(fu.nummer(), repo.hoechsteNummer(id) + 1);
            UUID fassung = repo.fassungAnlegen(tenant, id, nummer, k.rechenform(), ab, HERKUNFT_EINTRAG, fu.rueckwirkend(),
                    begruendung, jetzt, wer, u.komplement(), u.einheit());
            eingaengeAnlegen(tenant, id, fassung, u);
            Map<String, Object> neu = berechnungsSatz(nummer, ab, u);
            if (fu.abzeichen() != null) {
                neu.put("abzeichen", fu.abzeichen());
            }
            repo.protokoll(tenant, id, FASSUNG_EINGETRAGEN, alt == null ? null : alsJson(alt), alsJson(neu),
                    ab.atStartOfDay(g.zone()).toInstant(), fu.rueckwirkend(), begruendung, wer);
        });
        return fassungen(id);
    }

    // ================================================================================ Prüfung (mit der Vorschau geteilt)

    /** Der Geltungsbereich einer Anfrage oder einer Kennzahl — G1 mit Standort und Zeitzone. */
    record Geltung(String art, UUID id, String name, String rechteGeltung, UUID standort, String standortName,
            String kennung, ZoneId zone) {}

    /** Ein aufgelöster Eingang. {@code rechenform}/{@code einheit} bei einer Kennzahl die ihrer Fassung am Tag. */
    record Aufgeloest(String rolle, String art, UUID id, String kennzeichen, String name, String einheit, String groesse,
            String wertart, String periodeArt, String rechenform, BezugsgroesseZeile bezugsgroesse, Zeile kennzahl) {}

    /** Die geprüfte Berechnung. */
    record Urteil(String rechenform, boolean komplement, List<Aufgeloest> eingaenge, String einheit, String einheitAnzeige,
            String grundperiode, List<String> perioden) {}

    /** Die geprüften Stammdaten einer Anfrage. */
    record Entwurf(String kennzeichen, String name, String verantwortlichSub, String verantwortlichName, String zweck) {}

    /** Die Form der Anfrage (400): Name (beim Anlegen Pflicht), Kennzeichen-Form, Zweck, Wunsch-Periode. */
    Entwurf entwurf(KennzahlDto.Anfrage a, boolean nameNoetig, ProtokollAkteur wer) {
        String name = a.name() == null || a.name().isBlank() ? null : a.name().strip();
        if (name == null && nameNoetig) {
            throw KennzahlAbgelehnt.anfrage("name");
        }
        String kennzeichen = a.kennzeichen() == null || a.kennzeichen().isBlank() ? null : a.kennzeichen();
        if (kennzeichen != null && !KENNZEICHEN.matcher(kennzeichen).matches()) {
            throw KennzahlAbgelehnt.feld(Ablehnung.KENNZEICHEN_FORMAT, "kennzeichen");
        }
        wunschPruefen(a.periodeArt());
        boolean eigener = a.verantwortlichName() == null || a.verantwortlichName().isBlank();
        return new Entwurf(kennzeichen, name, eigener ? wer.sub() : null,
                eigener ? wer.name() : a.verantwortlichName().strip(), zweck(a.zweck()));
    }

    Geltung geltung(String art, String idText, Instant jetzt) {
        if (art == null || !KennzahlRegeln.GELTUNG_ARTEN.contains(art)) {
            throw KennzahlAbgelehnt.anfrage("geltung_art");
        }
        UUID id;
        try {
            id = UUID.fromString(pflicht(idText, "geltung_id"));
        } catch (IllegalArgumentException e) {
            throw KennzahlAbgelehnt.anfrage("geltung_id");
        }
        String name = repo.geltungName(art, id).orElseThrow(() -> geltungUnbekannt(art));
        return geltungMit(art, id, name, jetzt, true);
    }

    /** Der Geltungsbereich einer bestehenden Kennzahl (für das Recht an Fassung, Stammdaten, Archiv, Löschen). */
    Geltung geltungVon(Zeile k, Instant jetzt) {
        return geltungMit(k.geltungArt(), k.geltungId(), repo.geltungName(k.geltungArt(), k.geltungId()).orElse(null),
                jetzt, false);
    }

    private Geltung geltungMit(String art, UUID id, String name, Instant jetzt, boolean streng) {
        String rechte = KennzahlRegeln.RECHTE_GELTUNG.get(art);
        final UUID standort = KennzahlRegeln.STANDORT.equals(rechte)
                ? repo.standortVonGeltung(art, id, LocalDate.ofInstant(jetzt, ZoneId.of(repo.zeitzone(null)))).orElse(null)
                : null;
        KennzahlRegeln.GeltungUrteil u = KennzahlRegeln.geltung(art, standort == null ? null : standort.toString());
        if (u.fehler() != null && streng) {
            throw KennzahlAbgelehnt.regel(u.fehler(), u.kundensatz(), Map.of("feld", "geltung_id"));
        }
        String standortName = standort == null ? null : repo.standorte().stream()
                .filter(s -> s.id().equals(standort)).map(KennzahlRepository.Standort::name).findFirst().orElse(null);
        return new Geltung(art, id, name, rechte, standort, standortName, u.kennung(), ZoneId.of(repo.zeitzone(standort)));
    }

    private static KennzahlAbgelehnt geltungUnbekannt(String art) {
        return KennzahlAbgelehnt.regel(KennzahlRegeln.GELTUNG_UNBEKANNT,
                KennzahlRegeln.satz(KennzahlRegeln.GELTUNG_UNBEKANNT, Map.of("geltung_art", art)), Map.of("feld", "geltung_id"));
    }

    /** E10: das Recht zum Definieren am Rechte-Geltungsbereich — 403 {@code recht_fehlt} oder 404 aus der Ableitung. */
    void darf(ProtokollAkteur wer, Geltung g, Instant jetzt) {
        RechteAbleitung.Kundenbereich k = new RechteAbleitung.Kundenbereich("Kundenbereich",
                repo.standorte().stream().map(s -> new RechteAbleitung.Standort(s.id().toString(), s.name())).toList(),
                List.of());
        RechteAbleitung.DarfErgebnis d = KennzahlRechte.darf(aufrufer.benutzer(wer), k, g.kennung(),
                g.standort() == null ? null : g.standort().toString(), jetzt);
        if (!d.darf()) {
            throw KennzahlAbgelehnt.rechte(d);
        }
    }

    /**
     * Die Berechnung prüfen — Rechenform, Form der Eingänge, jeder Eingang da, Einheit (U1–U3), Periode (P1–P3), Kreis
     * am Tag (Q10), G3 am Tag. {@code tag} ist beim Anlegen heute, bei einer Fassung ihr erster Tag.
     */
    Urteil berechnung(String rechenform, Geltung g, List<KennzahlDto.Eingang> anfrage, Boolean komplement,
            String wunsch, String eigenesKennzeichen, UUID eigeneId, LocalDate tag, Katalog kat) {
        Urteil u = rechnung(rechenform, anfrage, komplement, wunsch, tag, kat);
        List<Aufgeloest> aufgeloest = u.eingaenge();

        // Q10: der Kreis über Kennzahl-Verweise, am Tag
        List<String> verweise = aufgeloest.stream().filter(x -> KennzahlRegeln.KENNZAHL.equals(x.art()))
                .map(Aufgeloest::kennzeichen).toList();
        if (!verweise.isEmpty()) {
            Map<String, List<String>> bestehende = new LinkedHashMap<>();
            for (Zeile andere : kat.kennzahlen()) {
                if (andere.id().equals(eigeneId)) {
                    continue;
                }
                kat.fassungAm(andere.id(), tag).ifPresent(f -> bestehende.put(andere.kennzeichen(), kat.eingaenge(f.id())
                        .stream().filter(x -> KennzahlRegeln.KENNZAHL.equals(x.art())).map(EingangZeile::kennzeichen)
                        .toList()));
            }
            KennzahlRegeln.KreisUrteil ku = KennzahlRegeln.zyklus(eigenesKennzeichen, verweise, bestehende);
            if (ku.zyklus()) {
                throw KennzahlAbgelehnt.regel(ku.fehler(), ku.kundensatz(), Map.of("kette", ku.kette()));
            }
        }

        // G3: Eingänge einer Standort-Kennzahl liegen an ihrem Standort
        if (KennzahlRegeln.STANDORT.equals(g.rechteGeltung()) && g.standort() != null) {
            KennzahlRegeln.KennzahlOrt ort = new KennzahlRegeln.KennzahlOrt(g.rechteGeltung(), g.standort().toString(),
                    g.standortName(), g.name());
            Map<UUID, String> namen = new HashMap<>();
            repo.standorte().forEach(s -> namen.put(s.id(), s.name()));
            for (Aufgeloest x : aufgeloest) {
                Optional<UUID> st = standortVon(x, tag);
                if (st.isEmpty()) {
                    continue;
                }
                KennzahlRegeln.GeltungHinweis h = KennzahlRegeln.eingangGeltung(ort,
                        new KennzahlRegeln.EingangOrt(x.kennzeichen(), st.get().toString(), namen.get(st.get()), true, null));
                if (h.fehler() != null) {
                    throw KennzahlAbgelehnt.regel(h.fehler(), h.kundensatz(), Map.of("eingang", x.kennzeichen()));
                }
            }
        }
        return u;
    }

    /**
     * Die Berechnung einer Fassung ohne die Prüfungen am Schreibweg: Form, Eingänge, Einheit (U1–U3) und Perioden
     * (P1–P3). Der Rechenlauf (IP-6) rechnet gespeicherte Fassungen damit — den Kreis ordnet er selbst (Q10), und ein
     * Eingang, der inzwischen außerhalb des Geltungsbereichs liegt, rechnet weiter (K22).
     */
    Urteil rechnung(String rechenform, List<KennzahlDto.Eingang> anfrage, Boolean komplement, String wunsch,
            LocalDate tag, Katalog kat) {
        if (rechenform == null || rechenform.isBlank()) {
            throw KennzahlAbgelehnt.anfrage("rechenform");
        }
        KennzahlRegeln.RechenformUrteil r = KennzahlRegeln.rechenform(rechenform);
        if (r.fehler() != null) {
            throw KennzahlAbgelehnt.regel(r.fehler(), r.kundensatz(), Map.of("feld", "rechenform"));
        }
        boolean zusammenfassung = KennzahlRegeln.ZUSAMMENFASSUNG.equals(rechenform);
        if (Boolean.TRUE.equals(komplement) && !KennzahlRegeln.ANTEIL.equals(rechenform)) {
            throw KennzahlAbgelehnt.anfrage("komplement");
        }
        List<KennzahlDto.Eingang> eingaenge = anfrage == null ? List.of() : anfrage;
        formPruefen(rechenform, eingaenge);

        List<Aufgeloest> aufgeloest = new ArrayList<>();
        for (KennzahlDto.Eingang e : eingaenge) {
            aufgeloest.add(aufloesen(e, tag, kat));
        }

        // U1–U3
        KennzahlRegeln.EinheitUrteil eu;
        if (zusammenfassung) {
            eu = KennzahlRegeln.einheit(rechenform, null, null, aufgeloest.stream()
                    .map(p -> new KennzahlRegeln.Paar(p.kennzeichen(), p.rechenform() == null ? "" : p.rechenform(),
                            p.einheit() == null ? "" : p.einheit()))
                    .toList());
        } else {
            eu = KennzahlRegeln.einheit(rechenform, seite(rolle(aufgeloest, "zaehler")), seite(rolle(aufgeloest, "nenner")),
                    null);
        }
        if (eu.fehler() != null) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            if (KennzahlRegeln.ANFRAGE_UNGUELTIG.equals(eu.fehler())) {
                fakten.put("feld", "eingaenge");
            } else if (KennzahlRegeln.GROESSE_UNBEKANNT.equals(eu.fehler())) {
                aufgeloest.stream().filter(x -> KennzahlRegeln.MESSSTELLE.equals(x.art()))
                        .filter(x -> x.groesse() == null || ErgebnisZustand.anzeigeEinheit(x.einheit()) == null)
                        .findFirst().ifPresent(x -> fakten.put("eingang", x.kennzeichen()));
            }
            throw KennzahlAbgelehnt.regel(eu.fehler(), eu.kundensatz(), fakten);
        }

        // P1–P3
        KennzahlRegeln.PeriodenUrteil pu = KennzahlRegeln.periode(wunsch, aufgeloest.stream()
                .map(x -> new KennzahlRegeln.PeriodenEingang(x.art(), x.kennzeichen(), x.name(), x.wertart(), x.periodeArt()))
                .toList());
        if (pu.fehler() != null) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            if (KennzahlRegeln.ANFRAGE_UNGUELTIG.equals(pu.fehler())) {
                fakten.put("feld", "eingaenge");
            } else {
                fakten.put("grundperiode", pu.grundperiode());
                fakten.put("perioden", pu.perioden());
            }
            throw KennzahlAbgelehnt.regel(pu.fehler(), pu.kundensatz(), fakten);
        }

        return new Urteil(rechenform, Boolean.TRUE.equals(komplement), List.copyOf(aufgeloest), eu.einheit(), eu.anzeige(),
                pu.grundperiode(), pu.perioden());
    }

    /** Die Form der Eingänge je Rechenform: Menge und Bezugsgröße (Teil und Ganzes) genau je einmal, sonst nur Paare. */
    private static void formPruefen(String rechenform, List<KennzahlDto.Eingang> eingaenge) {
        for (KennzahlDto.Eingang e : eingaenge) {
            if (e == null || e.rolle() == null || !KennzahlRegeln.EINGANG_ROLLEN.contains(e.rolle()) || e.art() == null
                    || !KennzahlRegeln.EINGANG_ARTEN.contains(e.art()) || e.kennzeichen() == null
                    || e.kennzeichen().isBlank()) {
                throw KennzahlAbgelehnt.anfrage("eingaenge");
            }
        }
        if (KennzahlRegeln.ZUSAMMENFASSUNG.equals(rechenform)) {
            if (eingaenge.stream().anyMatch(e -> !"paar".equals(e.rolle()) || !KennzahlRegeln.KENNZAHL.equals(e.art()))
                    || eingaenge.stream().map(KennzahlDto.Eingang::kennzeichen).distinct().count() != eingaenge.size()) {
                throw KennzahlAbgelehnt.anfrage("eingaenge");
            }
            return;
        }
        long zaehler = eingaenge.stream().filter(e -> "zaehler".equals(e.rolle())).count();
        long nenner = eingaenge.stream().filter(e -> "nenner".equals(e.rolle())).count();
        if (zaehler != 1 || nenner != 1 || eingaenge.size() != 2) {
            throw KennzahlAbgelehnt.anfrage("eingaenge");
        }
    }

    private Aufgeloest aufloesen(KennzahlDto.Eingang e, LocalDate tag, Katalog kat) {
        String kz = e.kennzeichen();
        switch (e.art()) {
            case KennzahlRegeln.MESSSTELLE -> {
                MessstelleZeile m = repo.messstelle(kz).orElseThrow(() -> eingangUnbekannt(e));
                return new Aufgeloest(e.rolle(), e.art(), m.id(), m.kennzeichen(), m.name(), m.einheit(), m.groesse(),
                        m.wertart(), "tag", null, null, null);
            }
            case KennzahlRegeln.BEZUGSGROESSE -> {
                BezugsgroesseZeile b = repo.bezugsgroesse(kz).orElseThrow(() -> eingangUnbekannt(e));
                return new Aufgeloest(e.rolle(), e.art(), b.id(), b.kennzeichen(), b.name(), b.einheit(), null, b.wertart(),
                        b.periodeArt(), null, b, null);
            }
            default -> {
                Zeile k = kat.nachKennzeichen(kz).orElseThrow(() -> eingangUnbekannt(e));
                Optional<FassungZeile> f = kat.fassungAm(k.id(), tag);
                String einheit = f.map(FassungZeile::einheit).orElse(null);
                return new Aufgeloest(e.rolle(), e.art(), k.id(), k.kennzeichen(), k.name(), einheit, null, null,
                        grundperiode(k.id(), tag, kat, 0), k.rechenform(), null, k);
            }
        }
    }

    private static KennzahlAbgelehnt eingangUnbekannt(KennzahlDto.Eingang e) {
        return KennzahlAbgelehnt.regel(KennzahlRegeln.EINGANG_UNBEKANNT, KennzahlRegeln.satz(KennzahlRegeln.EINGANG_UNBEKANNT,
                Map.of("art", e.art(), "objekt", e.kennzeichen())), Map.of("eingang", e.kennzeichen()));
    }

    private static Aufgeloest rolle(List<Aufgeloest> eingaenge, String rolle) {
        return eingaenge.stream().filter(x -> rolle.equals(x.rolle())).findFirst().orElseThrow();
    }

    private static KennzahlRegeln.EinheitSeite seite(Aufgeloest x) {
        return new KennzahlRegeln.EinheitSeite(x.art(), x.kennzeichen(), x.einheit() == null ? "" : x.einheit(),
                x.groesse(), x.wertart());
    }

    /** Der Standort eines Eingangs am Tag: Messstelle ihr Ort, Bezugsgröße ihr Geltungsobjekt, Kennzahl ihr Rechte-Standort. */
    Optional<UUID> standortVon(Aufgeloest x, LocalDate tag) {
        return switch (x.art()) {
            case KennzahlRegeln.MESSSTELLE -> repo.standortVonMessstelle(x.id(), tag);
            case KennzahlRegeln.BEZUGSGROESSE -> repo.standortVonGeltung(x.bezugsgroesse().geltungArt(),
                    x.bezugsgroesse().geltungId(), tag);
            default -> KennzahlRegeln.STANDORT.equals(KennzahlRegeln.RECHTE_GELTUNG.get(x.kennzahl().geltungArt()))
                    ? repo.standortVonGeltung(x.kennzahl().geltungArt(), x.kennzahl().geltungId(), tag)
                    : Optional.empty();
        };
    }

    /** Die Grundperiode einer bestehenden Kennzahl am Tag, aus ihren Eingängen (rekursiv, höchstens {@link #TIEFE}). */
    String grundperiode(UUID kennzahl, LocalDate tag, Katalog kat, int tiefe) {
        return perioden(kennzahl, tag, kat, tiefe).grundperiode();
    }

    private KennzahlRegeln.PeriodenUrteil perioden(UUID kennzahl, LocalDate tag, Katalog kat, int tiefe) {
        Optional<FassungZeile> f = kat.fassungAm(kennzahl, tag);
        if (f.isEmpty() || tiefe >= TIEFE) {
            return new KennzahlRegeln.PeriodenUrteil(null, List.of(), null, null);
        }
        List<KennzahlRegeln.PeriodenEingang> eingaenge = new ArrayList<>();
        for (EingangZeile e : kat.eingaenge(f.get().id())) {
            switch (e.art()) {
                case KennzahlRegeln.MESSSTELLE -> eingaenge.add(
                        new KennzahlRegeln.PeriodenEingang(e.art(), e.kennzeichen(), e.name(), null, "tag"));
                case KennzahlRegeln.BEZUGSGROESSE -> repo.bezugsgroesse(e.objektId()).ifPresent(b -> eingaenge.add(
                        new KennzahlRegeln.PeriodenEingang(e.art(), b.kennzeichen(), b.name(), b.wertart(), b.periodeArt())));
                default -> eingaenge.add(new KennzahlRegeln.PeriodenEingang(e.art(), e.kennzeichen(), e.name(), null,
                        grundperiode(e.objektId(), tag, kat, tiefe + 1)));
            }
        }
        KennzahlRegeln.PeriodenUrteil pu = KennzahlRegeln.periode(null, eingaenge);
        return pu.fehler() != null ? new KennzahlRegeln.PeriodenUrteil(null, List.of(), pu.fehler(), pu.kundensatz()) : pu;
    }

    // ================================================================================ Gerüst

    /** Alle Kennzahlen, Fassungen und Eingänge des Kundenbereichs — gelesen je Anfrage, gerechnet im Speicher. */
    record Katalog(List<Zeile> kennzahlen, Map<UUID, List<FassungZeile>> fassungenJeKennzahl,
            Map<UUID, List<EingangZeile>> eingaengeJeFassung) {

        Optional<Zeile> zeile(UUID id) {
            return kennzahlen.stream().filter(k -> k.id().equals(id)).findFirst();
        }

        Optional<Zeile> nachKennzeichen(String kennzeichen) {
            return kennzahlen.stream().filter(k -> k.kennzeichen().equals(kennzeichen)).findFirst();
        }

        List<FassungZeile> fassungen(UUID kennzahl) {
            return fassungenJeKennzahl.getOrDefault(kennzahl, List.of());
        }

        /** V2 am Tag: die wirksame Fassung, deren Tage ihn enthalten ({@link MessstelleFormelRegeln#fassungAm}). */
        Optional<FassungZeile> fassungAm(UUID kennzahl, LocalDate tag) {
            List<FassungZeile> wirksam = fassungen(kennzahl).stream().filter(FassungZeile::wirksam).toList();
            return MessstelleFormelRegeln.fassungAm(wirksam.stream().map(FassungZeile::alsRegel).toList(), tag)
                    .flatMap(r -> wirksam.stream().filter(f -> f.nummer() == r.nummer()).findFirst());
        }

        List<EingangZeile> eingaenge(UUID fassung) {
            return eingaengeJeFassung.getOrDefault(fassung, List.of());
        }
    }

    Katalog katalog() {
        Map<UUID, List<FassungZeile>> fassungen = new LinkedHashMap<>();
        repo.alleFassungen().forEach(f -> fassungen.computeIfAbsent(f.kennzahlId(), x -> new ArrayList<>()).add(f));
        Map<UUID, List<EingangZeile>> eingaenge = new LinkedHashMap<>();
        repo.alleEingaenge().forEach(e -> eingaenge.computeIfAbsent(e.fassungId(), x -> new ArrayList<>()).add(e));
        return new Katalog(repo.alle(), fassungen, eingaenge);
    }

    private KennzahlDto.Kennzahl darstellung(Zeile k, Katalog kat, Instant jetzt) {
        Geltung g = geltungVon(k, jetzt);
        LocalDate heute = LocalDate.ofInstant(jetzt, g.zone());
        Optional<FassungZeile> f = kat.fassungAm(k.id(), heute);
        KennzahlRegeln.PeriodenUrteil p = perioden(k.id(), heute, kat, 0);
        String einheit = f.map(FassungZeile::einheit).orElse(null);
        return new KennzahlDto.Kennzahl(k.id(), k.kennzeichen(), k.name(), k.rechenform(), k.geltungArt(), k.geltungId(),
                g.name(), g.rechteGeltung(), g.standort(), g.kennung(), k.verantwortlichName(), k.zweck(),
                f.map(FassungZeile::nummer).orElse(null), einheit, einheitAnzeige(einheit), p.grundperiode(), p.perioden(),
                repo.werteZahl(k.id()) > 0, zeit(k.archiviertAm(), g.zone()), zeit(k.angelegtAm(), g.zone()));
    }

    private KennzahlDto.Fassung fassungDarstellung(FassungZeile f, Katalog kat, ZoneId zone) {
        // Das Abzeichen spricht dieselbe Regel wie beim Eintragen (fassungEintrag → OrtsbaumAbleitung.rueckwirkung).
        String abzeichen = f.rueckwirkend() && f.gueltigAb() != null
                ? OrtsbaumAbleitung.rueckwirkung(new OrtsbaumAbleitung.RueckwirkungEingang(
                        OffsetDateTime.ofInstant(f.eingetragenAm(), zone), f.gueltigAb(), null, zone, null)).abzeichen()
                : null;
        return new KennzahlDto.Fassung(f.nummer(), f.gueltigAb(), f.gueltigBis(), zeit(f.aufgehobenAm(), zone), f.herkunft(),
                f.rueckwirkend(), abzeichen, f.begruendung(),
                new KennzahlDto.Person(f.actorName(), f.actorRolle(), f.actorArt()), zeit(f.eingetragenAm(), zone),
                f.rechenform(), f.einheit(), einheitAnzeige(f.einheit()), f.komplement(),
                kat.eingaenge(f.id()).stream().map(e -> new KennzahlDto.EingangAntwort(e.rolle(), e.art(), e.objektId(),
                        e.kennzeichen(), e.name())).toList());
    }

    static String einheitAnzeige(String einheit) {
        return einheit == null ? null : ErgebnisZustand.PROZENT.equals(einheit) ? einheit : KennzahlRegeln.einheitWort(einheit);
    }

    ZoneId zone(Zeile k, Instant jetzt) {
        return geltungVon(k, jetzt).zone();
    }

    private void eingaengeAnlegen(UUID tenant, UUID kennzahl, UUID fassung, Urteil u) {
        for (int i = 0; i < u.eingaenge().size(); i++) {
            Aufgeloest x = u.eingaenge().get(i);
            repo.eingangAnlegen(tenant, kennzahl, fassung, u.rechenform(), i, x.rolle(), x.art(), x.id());
        }
    }

    private static Map<String, Object> berechnungsSatz(int nummer, LocalDate ab, Urteil u) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("fassung", nummer);
        s.put("gueltig_ab", ab == null ? null : ab.toString());
        s.put("einheit", u.einheit());
        s.put("komplement", u.komplement());
        List<Map<String, Object>> eingaenge = new ArrayList<>();
        for (Aufgeloest x : u.eingaenge()) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("rolle", x.rolle());
            e.put("art", x.art());
            e.put("kennzeichen", x.kennzeichen());
            e.put("id", x.id().toString());
            eingaenge.add(e);
        }
        s.put("eingaenge", eingaenge);
        return s;
    }

    private static Map<String, Object> stammdaten(String kennzeichen, String name, String verantwortlich, String zweck) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("kennzeichen", kennzeichen);
        s.put("name", name);
        s.put("verantwortlich_name", verantwortlich);
        s.put("zweck", zweck);
        return s;
    }

    /** M2-Muster: ohne Kennzeichen die Nummer nach der HÖCHSTEN je belegten — ein Kennzeichen wird nie weitergegeben. */
    static String kennzeichenFuerNeue(String gewuenscht, List<String> jeBelegt) {
        if (gewuenscht != null) {
            if (jeBelegt.contains(gewuenscht)) {
                throw KennzahlAbgelehnt.feld(Ablehnung.KENNZEICHEN_BELEGT, "kennzeichen");
            }
            return gewuenscht;
        }
        long hoechste = 0;
        for (String k : jeBelegt) {
            var m = AUTOMATISCH.matcher(k);
            if (m.matches() && m.group(1).length() <= 12) {
                hoechste = Math.max(hoechste, Long.parseLong(m.group(1)));
            }
        }
        return String.format("KZ-%04d", hoechste + 1);
    }

    static void wunschPruefen(String periodeArt) {
        if (periodeArt != null && !KennzahlRegeln.PERIODEN.contains(periodeArt)) {
            throw KennzahlAbgelehnt.anfrage("periode_art");
        }
    }

    private static String zweck(String zweck) {
        if (zweck == null || zweck.isBlank()) {
            return null;
        }
        String z = zweck.strip();
        if (z.length() > TEXT_HOECHSTENS) {
            throw KennzahlAbgelehnt.anfrage("zweck");
        }
        return z;
    }

    private static String pflicht(String text, String feld) {
        if (text == null || text.isBlank()) {
            throw KennzahlAbgelehnt.anfrage(feld);
        }
        return text.strip();
    }

    private static LocalDate tag(String text, String feld) {
        try {
            return LocalDate.parse(text);
        } catch (java.time.format.DateTimeParseException e) {
            throw KennzahlAbgelehnt.anfrage(feld);
        }
    }

    private static OffsetDateTime zeit(Instant t, ZoneId zone) {
        return t == null ? null : OffsetDateTime.ofInstant(t, zone);
    }

    private String alsJson(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Schreibt und bildet die Wand der Datenbank im Rennen ab: das Kennzeichen ist soeben belegt worden. */
    private static <T> T schreibe(Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            String meldung = meldung(e);
            if (meldung.contains("\"kennzahl_kennzeichen_belegt\"") || meldung.contains("\"kennzahl_kennzeichen_eindeutig\"")) {
                throw KennzahlAbgelehnt.feld(Ablehnung.KENNZEICHEN_BELEGT, "kennzeichen");
            }
            throw e;
        }
    }

    private static String meldung(Throwable e) {
        StringBuilder s = new StringBuilder();
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException && t.getMessage() != null) {
                s.append(t.getMessage()).append('\n');
            }
        }
        return s.toString();
    }
}
