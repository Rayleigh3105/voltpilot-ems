package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.BewertungUmfangDto;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto.Ausschluss;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto.StandortKurz;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.Eingetragen;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonKurz;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * UEMS AP-19 IP-7: Dokumente im Energiemanagement (DK1–DK8, W5, §5.6).
 *
 * <p>Ein Dokument D-nnnn hat Art (zwölf, geschlossen), Titel und Bezug — das Unternehmen, einen Standort, einen
 * Energieeinsatz, eine Person oder eine Aufgabe (IP-14); der Zaun folgt dem Standort des Bezugs, ohne Standort ist es das
 * Unternehmen (DK1). Der Standort eines Energieeinsatzes ist der eine Standort, an dem am Tag des Anlegens seine
 * Messstellen hängen — hängen sie an mehreren oder an keinem, gilt das Dokument am Unternehmen; Person und Aufgabe haben
 * keinen Standort. Eine Fassung ist Wortlaut ODER Verweis
 * (G3); freigegeben wird sie mit „entschieden von“ (eine Person, auch ohne Konto) — bei Energiepolitik,
 * Anwendungsbereich und Bestellung die Leitung des Unternehmens am Tag der Entscheidung (DK3/PA3, sonst 422
 * {@code leitung_fehlt}); mit Vier-Augen beantragt die erste Person, eine zweite (KA/EM, nie der Urheber) gibt frei
 * oder lehnt ab. Die Kopie der Fassung ist die kanonische Form des Vertrags (§6), ihre Prüfsumme hält die Datenbank.
 * Gültig ist die jüngste freigegebene Fassung, die früheren heißen „abgelöst“ (DK4). Die Überprüfung wird beim Abruf
 * abgeleitet (DK5, Vertrag {@code ueberpruefung}): Basis ist der Tag der Entscheidung bzw. das letzte „geprüft,
 * bleibt“. Bekanntmachung (DK6) und Aufheben (DK8) sind Einträge; nichts wird gelöscht, nichts verschickt.
 *
 * <p>Rechte: Schreiben {@code energiemanagement.verwalten} (anlegen, entwerfen, bekannt machen) bzw.
 * {@code energiemanagement.freigeben} (beantragen, freigeben, ablehnen, „geprüft, bleibt“, aufheben) am Standort des
 * Bezugs bzw. am Unternehmen — der Interceptor prüft vor ({@code RechtZiel.DIENST}), hier steht die genaue Prüfung.
 * Ein Dokument außerhalb des Zauns gibt es für die Anfrage nicht (404).
 */
@Service
public class EnergiemanagementDokumentService {

    static final String VERWALTEN = "energiemanagement.verwalten";
    static final String FREIGEBEN = "energiemanagement.freigeben";
    private static final Set<String> ZWEITE_ROLLEN = Set.of("kundenadministrator", "energiemanager");
    private static final Set<String> FREIGABE_ROLLEN = Set.of("kundenadministrator", "energiemanager",
            "voltpilot_betrieb");
    private static final Set<String> AUSSCHLUSS_ARTEN = Set.of("standort", "anlage", "prozess");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern BESCHLUSS = Pattern.compile("^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$");
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    private final EnergiemanagementDokumentRepository repo;
    private final EnergiemanagementPersonenRepository personen;
    private final EnergiemanagementPersonenService leitung;
    private final BewertungUmfangRepository umfang;
    private final UnternehmenRepository unternehmen;
    private final EnergieeinsatzService einsaetze;
    private final EnergieeinsatzRepository einsatzRepo;
    private final KennzahlRepository kennzahlen;
    private final RechtPruefung rechte;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private volatile Clock uhr = Clock.systemUTC();

    public EnergiemanagementDokumentService(EnergiemanagementDokumentRepository repo,
            EnergiemanagementPersonenRepository personen, EnergiemanagementPersonenService leitung,
            BewertungUmfangRepository umfang, UnternehmenRepository unternehmen, EnergieeinsatzService einsaetze,
            EnergieeinsatzRepository einsatzRepo, KennzahlRepository kennzahlen, RechtPruefung rechte,
            ObjectMapper json, PlatformTransactionManager tm) {
        this.repo = repo;
        this.personen = personen;
        this.leitung = leitung;
        this.umfang = umfang;
        this.unternehmen = unternehmen;
        this.einsaetze = einsaetze;
        this.einsatzRepo = einsatzRepo;
        this.kennzahlen = kennzahlen;
        this.rechte = rechte;
        this.json = json;
        this.tx = new TransactionTemplate(tm);
    }

    /** Für Tests: die Uhr, an der „heute“, die Überprüfung beim Abruf und „nie in der Zukunft“ hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ lesen

    public EnergiemanagementDokumentDto.Dokumente dokumente() {
        LocalDate heute = heute();
        var liste = repo.dokumente();
        Map<UUID, StandortKurz> orte = orte(liste.stream().map(EnergiemanagementDokumentRepository.Dokument::standortId)
                .filter(Objects::nonNull).distinct().toList());
        var bezuege = bezuege(liste, null);
        return new EnergiemanagementDokumentDto.Dokumente(liste.stream().map(d -> {
            var fassungen = repo.fassungen(d.id());
            var gilt = gueltige(fassungen);
            return new EnergiemanagementDokumentDto.DokumentKurz(d.id(), d.kennzeichen(), d.art(), artWort(d.art()),
                    klasse(d.art()), d.titel(), bezug(d, orte, bezuege), d.zustand(), gilt == null ? null : gilt.nr(),
                    ueberpruefung(d, fassungen, repo.eintraege(d.id()), heute),
                    new Eingetragen(d.akteur(), d.angelegtAm()));
        }).toList());
    }

    public EnergiemanagementDokumentDto.Dokument dokument(UUID id) {
        var d = repo.dokument(id).orElseThrow(EnergiemanagementAbgelehnt::dokumentFehlt);
        LocalDate heute = heute();
        var fassungen = repo.fassungen(id);
        var eintraege = repo.eintraege(id);
        var gilt = gueltige(fassungen);
        Map<UUID, EnergiemanagementPersonenRepository.Person> leute = personen.personen().stream()
                .collect(Collectors.toMap(EnergiemanagementPersonenRepository.Person::id, Function.identity()));
        Map<UUID, StandortKurz> orte = orte(ortIds(d, fassungen));
        var ueberpruefung = ueberpruefung(d, fassungen, eintraege, heute);

        String kopf = null;
        if (gilt != null) {
            var p = leute.get(gilt.entschiedenVon());
            kopf = satz("dokument_kopf", Map.of("art", artWort(d.art()), "kennzeichen", d.kennzeichen(),
                    "fassung", String.valueOf(gilt.nr()), "am", gilt.entschiedenTag().format(TAG),
                    "entschieden_von", p == null ? "—" : p.name() + " (" + p.funktion() + ")",
                    "eingetragen_von", gilt.freigabe().name()));
        }
        String faellig = ueberpruefung != null && ueberpruefung.tage() != null && ueberpruefung.tage() > 0
                ? satz("ueberpruefung", Map.of("tage", String.valueOf(ueberpruefung.tage()))) : null;
        String gesperrt = !"aufgehoben".equals(d.zustand()) && leitungsPflicht(d.art())
                && rechte.lesbar(RechtZiel.UNTERNEHMEN, null) && leitung.leitungAm(heute).isEmpty()
                ? satz("freigabe_ohne_leitung", Map.of()) : null;

        var beleg = d.belegAblage() == null ? null : new EnergiemanagementPersonenDto.Beleg(d.belegBezeichnung(),
                d.belegAblage(), d.belegKennung(), d.belegAdresse(), d.belegSha256());
        return new EnergiemanagementDokumentDto.Dokument(d.id(), d.kennzeichen(), d.art(), artWort(d.art()),
                klasse(d.art()), d.titel(), bezug(d, orte, bezuege(List.of(d), leute)), d.zustand(),
                d.ueberpruefungMonate(), beleg,
                gilt == null ? null : gilt.nr(),
                fassungen.stream().map(f -> fassung(f, gilt, leute, orte)).toList(),
                eintraege.stream().map(e -> eintrag(e, leute)).toList(), ueberpruefung,
                new EnergiemanagementDokumentDto.Saetze(kopf, faellig, gesperrt),
                new Eingetragen(d.akteur(), d.angelegtAm()),
                repo.verlauf(id).stream().map(a -> new EnergiemanagementPersonenDto.Aenderung(a.id(), a.art(),
                        baum(a.alt()), baum(a.neu()), a.begruendung(), a.akteur(), a.zeit())).toList());
    }

    /**
     * DK7, W5: die gültige Fassung des Anwendungsbereichs neben dem laufenden Betrachtungsumfang der energetischen
     * Bewertung (AP-16 U1, {@code bewertung_umfang}) — Mengen und Sätze ohne Urteil; der Vergleich ändert nichts.
     */
    public EnergiemanagementDokumentDto.Vergleich vergleich(UUID id) {
        var d = repo.dokument(id).orElseThrow(EnergiemanagementAbgelehnt::dokumentFehlt);
        if (!"anwendungsbereich".equals(d.art())) {
            throw new EnergiemanagementAbgelehnt(404, "nicht_gefunden",
                    "Einen Vergleich mit dem Betrachtungsumfang hat nur der Anwendungsbereich.", null);
        }
        LocalDate heute = heute();
        var gilt = "aufgehoben".equals(d.zustand()) ? null : gueltige(repo.fassungen(id));
        var bereich = gilt == null ? null : repo.bereich(gilt.id()).orElse(null);
        // Der Betrachtungsumfang gilt am Unternehmen: nur wer unternehmensweit liest, bekommt ihn daneben.
        var u = rechte.lesbar(RechtZiel.UNTERNEHMEN, null) ? unternehmen.desKundenbereichs().orElse(null) : null;
        var lauf = u == null ? null : umfang.fassungen(u.id()).stream()
                .filter(f -> !f.inhalt().gueltigAb().isAfter(heute)).findFirst().orElse(null);
        List<UUID> ids = new ArrayList<>();
        if (bereich != null) ids.addAll(bereich.standortIds());
        if (lauf != null) ids.addAll(lauf.inhalt().standortIds());
        Map<UUID, StandortKurz> orte = orte(ids.stream().distinct().toList());
        var ab = bereich == null ? null : anwendungsbereich(bereich, orte);
        var um = lauf == null ? null : new EnergiemanagementDokumentDto.Betrachtungsumfang(lauf.nummer(),
                lauf.inhalt().gueltigAb(), lauf.inhalt().standortIds().stream().map(s -> ort(s, orte)).toList(),
                lauf.inhalt().traeger(), lauf.inhalt().begruendung());
        if (ab == null || um == null) {
            return new EnergiemanagementDokumentDto.Vergleich(heute, gilt == null ? null : gilt.nr(), ab, um, null,
                    List.of());
        }
        Map<String, Object> v = EnergiemanagementRegeln.anwendungsbereichVergleich(
                new EnergiemanagementRegeln.VergleichEingang(
                        new EnergiemanagementRegeln.Menge(texte(bereich.standortIds()), bereich.traeger()),
                        new EnergiemanagementRegeln.Menge(texte(lauf.inhalt().standortIds()), lauf.inhalt().traeger())));
        var nurAb = orteAus(v.get("standorte_nur_im_anwendungsbereich"), orte);
        var nurUm = orteAus(v.get("standorte_nur_im_betrachtungsumfang"), orte);
        @SuppressWarnings("unchecked") List<String> trAb = (List<String>) v.get("traeger_nur_im_anwendungsbereich");
        @SuppressWarnings("unchecked") List<String> trUm = (List<String>) v.get("traeger_nur_im_betrachtungsumfang");
        boolean gleich = Boolean.TRUE.equals(v.get("deckungsgleich"));
        List<String> saetze = new ArrayList<>();
        if (gleich) {
            saetze.add(satz("anwendungsbereich_deckungsgleich", Map.of("fassung", String.valueOf(lauf.nummer()),
                    "ab", lauf.inhalt().gueltigAb().format(TAG))));
        } else {
            // §5.8 nennt nur die Richtung „gehört zum Anwendungsbereich, aber nicht zum Betrachtungsumfang“;
            // die Gegenrichtung steht in den Feldern (Vertrag §9).
            for (var s : nurAb) {
                saetze.add(satz("anwendungsbereich_unterschied", Map.of("was", s.name(),
                        "fassung", String.valueOf(lauf.nummer()))));
            }
            for (String t : trAb) {
                saetze.add(satz("anwendungsbereich_unterschied", Map.of("was", t,
                        "fassung", String.valueOf(lauf.nummer()))));
            }
        }
        return new EnergiemanagementDokumentDto.Vergleich(heute, gilt.nr(), ab, um,
                new EnergiemanagementDokumentDto.VergleichErgebnis(nurAb, nurUm, trAb, trUm, gleich), saetze);
    }

    // ------------------------------------------------------------------ anlegen, entwerfen

    /**
     * DK1: Dokument anlegen — Art, Titel, Bezug (Unternehmen, Standort, Energieeinsatz, Person oder Aufgabe, IP-14);
     * Protokoll {@code dokument_angelegt}.
     */
    public UUID anlegen(EnergiemanagementDokumentDto.DokumentAnlegen a, ProtokollAkteur wer) {
        String art = text(a.art());
        if (art == null || !EnergiemanagementRegeln.VOKABULARE.get("dokument_art").contains(art)) {
            throw EnergiemanagementAbgelehnt.fachlich("art_unbekannt", "Bitte wählen Sie eine Art aus der Liste.",
                    Map.of("arten", EnergiemanagementRegeln.VOKABULARE.get("dokument_art")));
        }
        String titel = text(a.titel());
        if (titel == null) {
            throw EnergiemanagementAbgelehnt.fachlich("titel_fehlt", "Bitte geben Sie einen Titel an.",
                    Map.of("feld", "titel"));
        }
        laenge("titel", titel, 200);
        var bezug = a.bezug();
        String bezugArt = bezug == null ? null : text(bezug.art());
        if (bezugArt == null || !EnergiemanagementRegeln.VOKABULARE.get("dokument_bezug").contains(bezugArt)) {
            throw EnergiemanagementAbgelehnt.fachlich("bezug_unbekannt",
                    "Bitte wählen Sie, woran das Dokument hängt: am Unternehmen, an einem Standort, an einem "
                            + "Energieeinsatz, an einer Person oder an einer Aufgabe.", Map.of("feld", "bezug.art"));
        }
        // G5: genau die Kennung der Art — der Standort eines Einsatzes kommt nie aus der Anfrage.
        Map<String, UUID> kennungen = new LinkedHashMap<>();
        kennungen.put("standort_id", bezug.standortId());
        kennungen.put("energieeinsatz_id", bezug.energieeinsatzId());
        kennungen.put("person_id", bezug.personId());
        kennungen.put("aufgabe_id", bezug.aufgabeId());
        String eigene = bezugArt.equals("unternehmen") ? null : bezugArt + "_id";
        for (var k : kennungen.entrySet()) {
            if (k.getValue() != null && !k.getKey().equals(eigene)) {
                throw ungueltig("bezug." + k.getKey(), bezugArt.equals("unternehmen")
                        ? "Ein Dokument am Unternehmen nennt keinen Standort."
                        : "Ein Bezug nennt nur die Kennung, woran das Dokument hängt.");
            }
        }
        UUID standort = bezug.standortId();
        switch (bezugArt) {
            case "standort" -> {
                if (standort == null) {
                    throw standortUnbekannt("bezug.standort_id");
                }
                rechte.pruefen(VERWALTEN, RechtZiel.STANDORT, standort, () -> standortUnbekannt("bezug.standort_id"));
                if (repo.standorte(List.of(standort)).isEmpty()) {
                    throw standortUnbekannt("bezug.standort_id");
                }
            }
            case "energieeinsatz" -> {
                standort = standortDesEinsatzes(bezug.energieeinsatzId());
                if (standort == null) {
                    rechte.pruefen(VERWALTEN, RechtZiel.UNTERNEHMEN, null, EnergiemanagementDokumentService::einsatzUnbekannt);
                } else {
                    rechte.pruefen(VERWALTEN, RechtZiel.STANDORT, standort, EnergiemanagementDokumentService::einsatzUnbekannt);
                }
            }
            case "person" -> {
                rechte.pruefen(VERWALTEN, RechtZiel.UNTERNEHMEN, null, EnergiemanagementAbgelehnt::dokumentFehlt);
                if (bezug.personId() == null || personen.person(bezug.personId()).isEmpty()) {
                    throw personUnbekannt("bezug.person_id");
                }
            }
            case "aufgabe" -> {
                rechte.pruefen(VERWALTEN, RechtZiel.UNTERNEHMEN, null, EnergiemanagementAbgelehnt::dokumentFehlt);
                if (bezug.aufgabeId() == null || personen.zuordnung(bezug.aufgabeId()).isEmpty()) {
                    throw EnergiemanagementAbgelehnt.fachlich("aufgabe_unbekannt", "Bitte wählen Sie eine Aufgabe "
                            + "im Energiemanagement Ihres Kundenbereichs.", Map.of("feld", "bezug.aufgabe_id"));
                }
            }
            default -> rechte.pruefen(VERWALTEN, RechtZiel.UNTERNEHMEN, null, EnergiemanagementAbgelehnt::dokumentFehlt);
        }
        Integer monate = a.ueberpruefungMonate();
        if (monate != null) {
            if ("nachweis".equals(klasse(art))) {
                throw ungueltig("ueberpruefung_monate", "Ein Nachweis hat keine Überprüfung.");
            }
            var s = EnergiemanagementRegeln.STARTWERTE;
            if (monate < s.ueberpruefung_monate_mindestens() || monate > s.ueberpruefung_monate_hoechstens()) {
                throw ungueltig("ueberpruefung_monate", "Bitte wählen Sie 1 bis 60 Monate.");
            }
        }
        var beleg = beleg(a.beleg());
        UUID zaun = standort;
        return tx.execute(s -> repo.anlegen(new EnergiemanagementDokumentRepository.NeuesDokument(art, titel, bezugArt,
                zaun, bezug.energieeinsatzId(), bezug.personId(), bezug.aufgabeId(), monate, beleg.bezeichnung(),
                beleg.ablage(), beleg.kennung(), beleg.adresse(), beleg.sha256()), wer));
    }

    /**
     * DK2: Fassung entwerfen — Wortlaut ODER Verweis, beim Anwendungsbereich Standorte und Träger (DK7), Begründung
     * ab Fassung 2. Ein offener Entwurf wird überschrieben (dieselbe Nr.), ein offener Antrag nicht (409).
     *
     * @return die Nr. und ob sie neu ist
     */
    public Entwurf entwerfen(UUID id, EnergiemanagementDokumentDto.FassungEntwerfen f, ProtokollAkteur wer) {
        var inhalt = inhalt(f);
        return tx.execute(s -> {
            var d = schreibbar(id, VERWALTEN);
            offen(d);
            var bereich = bereich(d, f.anwendungsbereich());
            var fassungen = repo.fassungen(id);
            var entwurf = fassungen.stream().filter(x -> "entwurf".equals(x.status())).findFirst().orElse(null);
            var antrag = fassungen.stream().filter(x -> "beantragt".equals(x.status())).findFirst().orElse(null);
            if (antrag != null) {
                throw EnergiemanagementAbgelehnt.konflikt("fassung_beantragt",
                        "Für Fassung " + antrag.nr() + " ist die Freigabe beantragt; erst danach entsteht ein neuer "
                                + "Entwurf.", Map.of("fassung", antrag.nr()));
            }
            int nr = entwurf != null ? entwurf.nr() : fassungen.size() + 1;
            String begruendung = inhalt.begruendung();
            if (nr > 1 && begruendung == null) {
                throw begruendungFehlt();
            }
            if (entwurf != null) {
                repo.entwurfUeberschreiben(id, entwurf, inhalt, bereich, wer);
                return new Entwurf(nr, false);
            }
            return new Entwurf(repo.entwerfen(id, inhalt, bereich, wer), true);
        });
    }

    public record Entwurf(int nr, boolean neu) {}

    // ------------------------------------------------------------------ Freigabe (DK3, DK4)

    /** Vier-Augen: die erste Person beantragt mit „entschieden von“ (ohne Vier-Augen 409 {@code vieraugen_aus}). */
    public void beantragen(UUID id, int nr, EnergiemanagementDokumentDto.Entscheid e, ProtokollAkteur wer) {
        var entscheid = entscheid(e);
        tx.executeWithoutResult(s -> {
            var d = schreibbar(id, FREIGEBEN);
            offen(d);
            var f = repo.fassungSperren(id, nr).orElseThrow(EnergiemanagementAbgelehnt::fassungFehlt);
            if (!"entwurf".equals(f.status())) {
                throw entschieden(f, "Beantragt wird nur ein Entwurf.");
            }
            if (!repo.vierAugen()) {
                throw EnergiemanagementAbgelehnt.konflikt("vieraugen_aus",
                        "Ohne Vier-Augen-Freigabe geben Sie die Fassung direkt frei.", Map.of("fassung", nr));
            }
            leitungPruefen(d, entscheid);
            String kopie = kopie(d, f);
            repo.beantragen(id, f, kopie, BerichtRegeln.pruefsumme(kopie), entscheid.von(), entscheid.tag(),
                    entscheid.begruendung(), freigabeRolle(wer), wer);
        });
    }

    /**
     * Ohne Vier-Augen gibt die Person mit {@code energiemanagement.freigeben} den Entwurf mit „entschieden von“ frei;
     * mit Vier-Augen bestätigt eine zweite Person (KA/EM, nie der Urheber: 422 {@code vieraugen_urheber}) den Antrag.
     * Die erste Freigabe macht das Dokument gültig, jede weitere löst die vorige Fassung ab (DK4).
     */
    public void freigeben(UUID id, int nr, EnergiemanagementDokumentDto.Entscheid e, ProtokollAkteur wer) {
        tx.executeWithoutResult(s -> {
            var d = schreibbar(id, FREIGEBEN);
            offen(d);
            var f = repo.fassungSperren(id, nr).orElseThrow(EnergiemanagementAbgelehnt::fassungFehlt);
            var vorige = gueltige(repo.fassungen(id));
            if ("entwurf".equals(f.status())) {
                if (repo.vierAugen()) {
                    throw EnergiemanagementAbgelehnt.konflikt("vieraugen_beantragen",
                            "Mit Vier-Augen-Freigabe beantragen Sie die Fassung; eine zweite Person gibt sie frei.",
                            Map.of("fassung", nr));
                }
                var entscheid = entscheid(e);
                leitungPruefen(d, entscheid);
                String kopie = kopie(d, f);
                repo.freigeben(id, f, kopie, BerichtRegeln.pruefsumme(kopie), entscheid.von(), entscheid.tag(),
                        entscheid.begruendung(), freigabeRolle(wer), wer);
            } else if ("beantragt".equals(f.status())) {
                zweitePerson(f, wer);
                if (e != null && (e.entschiedenVon() != null || e.entschiedenAm() != null)) {
                    throw ungueltig("entschieden_von", "„Entschieden von“ und der Tag stehen schon im Antrag.");
                }
                String begruendung = e == null || text(e.begruendung()) == null ? null : begruendung(e.begruendung());
                repo.bestaetigen(id, f, begruendung, wer);
            } else {
                throw entschieden(f, "Diese Fassung ist bereits entschieden.");
            }
            if ("entwurf".equals(d.zustand())) {
                repo.gueltig(id, wer);
            }
            if (vorige != null && vorige.nr() != nr) {
                repo.abgeloest(id, vorige.nr(), nr, wer);
            }
        });
    }

    /** Vier-Augen: die zweite Person lehnt den Antrag mit Begründung ab; danach ist ein neuer Entwurf möglich. */
    public void ablehnen(UUID id, int nr, EnergiemanagementDokumentDto.Ablehnen a, ProtokollAkteur wer) {
        String begruendung = begruendung(a == null ? null : a.begruendung());
        tx.executeWithoutResult(s -> {
            var d = schreibbar(id, FREIGEBEN);
            offen(d);
            var f = repo.fassungSperren(id, nr).orElseThrow(EnergiemanagementAbgelehnt::fassungFehlt);
            if (!"beantragt".equals(f.status())) {
                throw entschieden(f, "Abgelehnt wird nur eine beantragte Fassung.");
            }
            zweitePerson(f, wer);
            repo.ablehnen(id, f, begruendung, wer);
        });
    }

    // ------------------------------------------------------------------ Einträge (DK5, DK6, DK8)

    /** DK5: „geprüft, bleibt“ an der gültigen Fassung einer Vorgabe — verschiebt die Überprüfung. */
    public void geprueft(UUID id, EnergiemanagementDokumentDto.Geprueft g, ProtokollAkteur wer) {
        var entscheid = entscheid(new EnergiemanagementDokumentDto.Entscheid(g.entschiedenVon(), g.am(),
                g.begruendung()));
        String beschluss = beschluss(g.beschlussKennung());
        tx.executeWithoutResult(s -> {
            var d = schreibbar(id, FREIGEBEN);
            offen(d);
            var gilt = gueltigPflicht(d);
            if (!"vorgabe".equals(klasse(d.art()))) {
                throw EnergiemanagementAbgelehnt.fachlich("keine_ueberpruefung",
                        "Ein Nachweis hat keine Überprüfung.", Map.of("art", d.art()));
            }
            if (entscheid.tag().isBefore(gilt.entschiedenTag())) {
                throw ungueltig("am", "Geprüft wird die gültige Fassung — ab dem Tag ihrer Freigabe ("
                        + gilt.entschiedenTag().format(TAG) + ").");
            }
            repo.eintragMitProtokoll(id, new EnergiemanagementDokumentRepository.NeuerEintrag("geprueft_bleibt",
                    gilt.nr(), entscheid.tag(), repo.personDesKontos(wer.sub()).orElse(null), entscheid.von(), null,
                    null, null, entscheid.begruendung(), beschluss), wer);
        });
    }

    /** DK6: bekannt gemacht an einem Kreis über einen Weg — der Kommunikationsnachweis; VoltPilot verschickt nichts. */
    public void bekanntmachen(UUID id, EnergiemanagementDokumentDto.Bekanntmachen b, ProtokollAkteur wer) {
        String kreis = text(b.kreis());
        if (kreis == null) {
            throw EnergiemanagementAbgelehnt.fachlich("kreis_fehlt", "Bitte nennen Sie, wem das Dokument bekannt "
                    + "gemacht wurde.", Map.of("feld", "kreis"));
        }
        laenge("kreis", kreis, 200);
        String weg = text(b.weg());
        if (weg == null || !EnergiemanagementRegeln.VOKABULARE.get("bekanntmachung_weg").contains(weg)) {
            throw EnergiemanagementAbgelehnt.fachlich("weg_unbekannt", "Bitte wählen Sie einen Weg aus der Liste.",
                    Map.of("wege", EnergiemanagementRegeln.VOKABULARE.get("bekanntmachung_weg")));
        }
        String wegWortlaut = text(b.wegWortlaut());
        if ("weiterer".equals(weg)) {
            if (wegWortlaut == null) {
                throw EnergiemanagementAbgelehnt.fachlich("wortlaut_fehlt",
                        "Bitte beschreiben Sie den weiteren Weg in einem Wortlaut.", Map.of("feld", "weg_wortlaut"));
            }
            laenge("weg_wortlaut", wegWortlaut, 200);
        } else if (wegWortlaut != null) {
            throw ungueltig("weg_wortlaut", "Einen Wortlaut trägt nur ein weiterer Weg.");
        }
        LocalDate am = tag(b.am(), "am");
        tx.executeWithoutResult(s -> {
            var d = schreibbar(id, VERWALTEN);
            offen(d);
            var gilt = gueltigPflicht(d);
            UUID person = b.personId();
            if (person != null && personen.person(person).isEmpty()) {
                throw personUnbekannt("person_id");
            }
            if (person == null) {
                person = repo.personDesKontos(wer.sub()).orElseThrow(() -> EnergiemanagementAbgelehnt.fachlich(
                        "person_fehlt", "Bitte nennen Sie, wer das Dokument bekannt gemacht hat.",
                        Map.of("feld", "person_id")));
            }
            repo.eintragMitProtokoll(id, new EnergiemanagementDokumentRepository.NeuerEintrag("bekannt_gemacht",
                    gilt.nr(), am, person, null, kreis, weg, wegWortlaut, null, null), wer);
        });
    }

    /** DK8: aufheben mit Tag und Begründung — das Dokument bleibt mit allen Fassungen lesbar. */
    public void aufheben(UUID id, EnergiemanagementDokumentDto.Aufheben a, ProtokollAkteur wer) {
        var entscheid = entscheid(new EnergiemanagementDokumentDto.Entscheid(a.entschiedenVon(), a.am(),
                a.begruendung()));
        String beschluss = beschluss(a.beschlussKennung());
        tx.executeWithoutResult(s -> {
            var d = schreibbar(id, FREIGEBEN);
            offen(d);
            repo.aufheben(id, new EnergiemanagementDokumentRepository.NeuerEintrag("aufgehoben", null,
                    entscheid.tag(), repo.personDesKontos(wer.sub()).orElse(null), entscheid.von(), null, null, null,
                    entscheid.begruendung(), beschluss), wer);
        });
    }

    // ------------------------------------------------------------------ Prüfungen

    private record Entscheidung(UUID von, LocalDate tag, String begruendung) {}

    /** „entschieden von“ (eine Person im Energiemanagement), der Tag (nie in der Zukunft) und die Begründung. */
    private Entscheidung entscheid(EnergiemanagementDokumentDto.Entscheid e) {
        if (e == null || e.entschiedenVon() == null) {
            throw EnergiemanagementAbgelehnt.fachlich("entschieden_von_fehlt",
                    "Bitte nennen Sie, wer entschieden hat.", Map.of("feld", "entschieden_von"));
        }
        String begruendung = begruendung(e.begruendung());
        LocalDate tag = tag(e.entschiedenAm(), "entschieden_am");
        if (personen.person(e.entschiedenVon()).isEmpty()) {
            throw personUnbekannt("entschieden_von");
        }
        return new Entscheidung(e.entschiedenVon(), tag, begruendung);
    }

    /**
     * DK3/PA3: bei Energiepolitik, Anwendungsbereich und Bestellung entscheidet die Person mit der am Tag laufenden
     * Aufgabe „Leitung des Unternehmens“ — ohne Leitung der Satz des Vertrags; die Fläche erfindet keine (422
     * {@code leitung_fehlt}, bevor der Trigger es täte).
     */
    private void leitungPruefen(EnergiemanagementDokumentRepository.Dokument d, Entscheidung e) {
        if (!leitungsPflicht(d.art())) {
            return;
        }
        var am = leitung.leitungAm(e.tag());
        if (am.isEmpty()) {
            throw EnergiemanagementAbgelehnt.fachlich("leitung_fehlt", satz("freigabe_ohne_leitung", Map.of()),
                    Map.of("art", d.art(), "tag", e.tag().toString()));
        }
        if (!am.contains(e.von())) {
            throw EnergiemanagementAbgelehnt.fachlich("leitung_fehlt",
                    "Über " + artWort(d.art()) + " entscheidet die Leitung des Unternehmens.",
                    Map.of("art", d.art(), "tag", e.tag().toString(),
                            "leitung", am.stream().map(UUID::toString).toList()));
        }
    }

    /** Das Dokument im Zaun der Anfrage (sonst 404) und das Recht am Standort des Bezugs bzw. am Unternehmen. */
    private EnergiemanagementDokumentRepository.Dokument schreibbar(UUID id, String recht) {
        var d = repo.dokumentSperren(id).orElseThrow(EnergiemanagementAbgelehnt::dokumentFehlt);
        if (d.standortId() == null) {
            rechte.pruefen(recht, RechtZiel.UNTERNEHMEN, null, EnergiemanagementAbgelehnt::dokumentFehlt);
        } else {
            rechte.pruefen(recht, RechtZiel.STANDORT, d.standortId(), EnergiemanagementAbgelehnt::dokumentFehlt);
        }
        return d;
    }

    private static void offen(EnergiemanagementDokumentRepository.Dokument d) {
        if ("aufgehoben".equals(d.zustand())) {
            throw EnergiemanagementAbgelehnt.konflikt("dokument_aufgehoben",
                    "Dieses Dokument ist aufgehoben; es bleibt lesbar und ändert sich nicht mehr.",
                    Map.of("kennzeichen", d.kennzeichen()));
        }
    }

    private EnergiemanagementDokumentRepository.Fassung gueltigPflicht(EnergiemanagementDokumentRepository.Dokument d) {
        var gilt = "gueltig".equals(d.zustand()) ? gueltige(repo.fassungen(d.id())) : null;
        if (gilt == null) {
            throw EnergiemanagementAbgelehnt.konflikt("dokument_nicht_gueltig",
                    "Das Dokument hat noch keine freigegebene Fassung.", Map.of("kennzeichen", d.kennzeichen()));
        }
        return gilt;
    }

    /** Vier-Augen: die zweite Person hat die Fassung weder entworfen noch beantragt und hat Rolle KA/EM. */
    private static void zweitePerson(EnergiemanagementDokumentRepository.Fassung f, ProtokollAkteur wer) {
        if (Objects.equals(wer.sub(), f.akteur().sub()) || Objects.equals(wer.sub(), f.freigabe().sub())) {
            throw EnergiemanagementAbgelehnt.fachlich("vieraugen_urheber",
                    "Bei Vier-Augen-Freigabe entscheidet eine zweite Person — nicht, wer die Fassung entworfen oder "
                            + "beantragt hat.", Map.of("fassung", f.nr()));
        }
        if (wer.sub() == null || !ZWEITE_ROLLEN.contains(wer.rolle())) {
            throw new EnergiemanagementAbgelehnt(403, "vieraugen_rolle",
                    "Die zweite Person ist Kundenadministrator oder Energiemanager.", Map.of("fassung", f.nr()));
        }
    }

    private EnergiemanagementDokumentRepository.Inhalt inhalt(EnergiemanagementDokumentDto.FassungEntwerfen f) {
        if (f == null || text(f.form()) == null
                || !EnergiemanagementRegeln.VOKABULARE.get("fassung_form").contains(f.form())) {
            throw EnergiemanagementAbgelehnt.fachlich("form_unbekannt",
                    "Bitte wählen Sie: Wortlaut in VoltPilot oder Verweis auf das Original.", Map.of("feld", "form"));
        }
        String begruendung = text(f.begruendung()) == null ? null : begruendung(f.begruendung());
        String beschluss = beschluss(f.beschlussKennung());
        if ("wortlaut".equals(f.form())) {
            if (f.verweis() != null) {
                throw ungueltig("verweis", "Ein Wortlaut trägt keinen Verweis.");
            }
            String w = f.wortlaut() == null || f.wortlaut().isBlank() ? null : f.wortlaut();
            if (w == null) {
                throw EnergiemanagementAbgelehnt.fachlich("wortlaut_fehlt", "Bitte schreiben Sie den Wortlaut.",
                        Map.of("feld", "wortlaut"));
            }
            laenge("wortlaut", w, EnergiemanagementRegeln.STARTWERTE.wortlaut_zeichen_hoechstens());
            return new EnergiemanagementDokumentRepository.Inhalt("wortlaut", w, null, null, null, null, null, null,
                    null, begruendung, beschluss);
        }
        if (f.wortlaut() != null) {
            throw ungueltig("wortlaut", "Ein Verweis trägt keinen Wortlaut.");
        }
        var v = f.verweis();
        String ablage = v == null ? null : text(v.ablage());
        if (ablage == null) {
            throw EnergiemanagementAbgelehnt.fachlich("ablage_fehlt", "Bitte nennen Sie, wo das Original liegt "
                    + "(Ablage).", Map.of("feld", "verweis.ablage"));
        }
        laenge("verweis.ablage", ablage, 200);
        String bezeichnung = text(v.bezeichnung());
        String kennung = text(v.kennung());
        String adresse = text(v.adresse());
        String angabe = text(v.fassungsangabe());
        String sha = text(v.sha256());
        if (bezeichnung != null) laenge("verweis.bezeichnung", bezeichnung, 200);
        if (kennung != null) laenge("verweis.kennung", kennung, 200);
        if (adresse != null) laenge("verweis.adresse", adresse, 2000);
        if (angabe != null) laenge("verweis.fassungsangabe", angabe, 200);
        if (sha != null && !SHA256.matcher(sha).matches()) {
            throw ungueltig("verweis.sha256", "Die Prüfsumme ist 64 Zeichen 0–9 und a–f.");
        }
        return new EnergiemanagementDokumentRepository.Inhalt("verweis", null, bezeichnung, ablage, kennung, adresse,
                angabe, v.datum(), sha, begruendung, beschluss);
    }

    /** DK7: nur der Anwendungsbereich trägt Standorte (des Kundenbereichs, einmal), Träger und Ausschlüsse. */
    private EnergiemanagementDokumentRepository.Bereich bereich(EnergiemanagementDokumentRepository.Dokument d,
            EnergiemanagementDokumentDto.AnwendungsbereichEingang b) {
        if (!"anwendungsbereich".equals(d.art())) {
            if (b != null) {
                throw ungueltig("anwendungsbereich", "Standorte und Energieträger trägt nur der Anwendungsbereich.");
            }
            return null;
        }
        if (b == null || b.standortIds() == null || b.standortIds().isEmpty() || b.traeger() == null
                || b.traeger().isEmpty()) {
            throw EnergiemanagementAbgelehnt.fachlich("anwendungsbereich_fehlt",
                    "Bitte nennen Sie die Standorte und Energieträger des Anwendungsbereichs.",
                    Map.of("feld", "anwendungsbereich"));
        }
        var orte = new LinkedHashSet<>(b.standortIds());
        if (orte.contains(null) || orte.size() != b.standortIds().size()
                || repo.standorte(List.copyOf(orte)).size() != orte.size()) {
            throw standortUnbekannt("anwendungsbereich.standort_ids");
        }
        var traeger = new LinkedHashSet<>(b.traeger());
        if (traeger.size() != b.traeger().size() || !BewertungRegeln.TRAEGER.containsAll(traeger)) {
            throw EnergiemanagementAbgelehnt.fachlich("traeger_unbekannt",
                    "Bitte wählen Sie jeden Energieträger einmal aus der Liste.",
                    Map.of("feld", "anwendungsbereich.traeger", "traeger", BewertungRegeln.TRAEGER));
        }
        ArrayNode aus = json.createArrayNode();
        var u = unternehmen.desKundenbereichs().orElseThrow(EnergiemanagementAbgelehnt::dokumentFehlt);
        for (Ausschluss a : b.ausschluesse() == null ? List.<Ausschluss>of() : b.ausschluesse()) {
            String grund = a == null ? null : text(a.begruendung());
            if (a == null || !AUSSCHLUSS_ARTEN.contains(a.art()) || a.verweis() == null || grund == null
                    || grund.length() < 10 || grund.length() > 500
                    || !umfang.verweisVorhanden(new BewertungUmfangDto.Ausschluss(a.art(), a.verweis(), grund), u.id())) {
                throw EnergiemanagementAbgelehnt.fachlich("ausschluss_ungueltig",
                        "Bitte prüfen Sie den ausgeschlossenen Standort, die Anlage oder den Prozess und begründen "
                                + "Sie mit 10 bis 500 Zeichen.", Map.of("feld", "anwendungsbereich.ausschluesse"));
            }
            ObjectNode n = aus.addObject();
            n.put("art", a.art());
            n.put("verweis", a.verweis().toString());
            n.put("begruendung", grund);
        }
        return new EnergiemanagementDokumentRepository.Bereich(List.copyOf(orte), List.copyOf(traeger),
                aus.toString());
    }

    /**
     * Die Kopie der Fassung (Vertrag §6): {@code nr}, {@code form}, {@code wortlaut}, {@code verweis} (alle sieben
     * Teile), {@code anwendungsbereich} (Standorte als Kurzzeichen, Träger, Ausschlüsse) — kanonisch über
     * {@link BerichtRegeln#kanonisch}; die Datenbank prüft sie gegen die Spalten und hält die Prüfsumme.
     */
    private String kopie(EnergiemanagementDokumentRepository.Dokument d, EnergiemanagementDokumentRepository.Fassung f) {
        ObjectNode k = json.createObjectNode();
        k.put("nr", f.nr());
        k.put("form", f.form());
        k.put("wortlaut", f.wortlaut());
        if ("verweis".equals(f.form())) {
            ObjectNode v = k.putObject("verweis");
            v.put("bezeichnung", f.verweisBezeichnung());
            v.put("ablage", f.verweisAblage());
            v.put("kennung", f.verweisKennung());
            v.put("adresse", f.verweisAdresse());
            v.put("fassungsangabe", f.verweisFassungsangabe());
            v.put("datum", f.verweisDatum() == null ? null : f.verweisDatum().toString());
            v.put("sha256", f.verweisSha256());
        } else {
            k.putNull("verweis");
        }
        if ("anwendungsbereich".equals(d.art())) {
            var b = repo.bereich(f.id()).orElseThrow(() -> EnergiemanagementAbgelehnt.fachlich(
                    "anwendungsbereich_fehlt", "Bitte nennen Sie die Standorte und Energieträger des "
                            + "Anwendungsbereichs.", Map.of("feld", "anwendungsbereich")));
            Map<UUID, StandortKurz> orte = orte(b.standortIds());
            ObjectNode a = k.putObject("anwendungsbereich");
            ArrayNode st = a.putArray("standorte");
            b.standortIds().forEach(s -> st.add(ort(s, orte).kurzzeichen()));
            ArrayNode tr = a.putArray("traeger");
            b.traeger().forEach(tr::add);
            a.set("ausschluesse", baum(b.ausschluesse()));
        } else {
            k.putNull("anwendungsbereich");
        }
        return BerichtRegeln.kanonisch(k);
    }

    // ------------------------------------------------------------------ Darstellung

    private EnergiemanagementDokumentDto.Ueberpruefung ueberpruefung(EnergiemanagementDokumentRepository.Dokument d,
            List<EnergiemanagementDokumentRepository.Fassung> fassungen,
            List<EnergiemanagementDokumentRepository.Eintrag> eintraege, LocalDate heute) {
        if ("aufgehoben".equals(d.zustand())) {
            return null;
        }
        var ein = new EnergiemanagementRegeln.UeberpruefungEingang("dokument", d.art(), d.ueberpruefungMonate(),
                fassungen.stream().filter(f -> "freigegeben".equals(f.status()))
                        .map(f -> new EnergiemanagementRegeln.Fassung(f.nr(), f.entschiedenTag().toString())).toList(),
                eintraege.stream().filter(e -> "geprueft_bleibt".equals(e.art()))
                        .map(e -> new EnergiemanagementRegeln.Bleibt(e.fassung(), e.am().toString())).toList(),
                null, null, null, null, null, heute.toString());
        Map<String, Object> r = EnergiemanagementRegeln.ueberpruefung(ein);
        if (r.containsKey("fehler")) {
            throw new IllegalStateException("Überprüfung nicht berechenbar: " + r.get("fehler"));
        }
        return new EnergiemanagementDokumentDto.Ueberpruefung(heute, datum(r.get("faellig_am")), datum(r.get("basis")),
                (Integer) r.get("fassung"), (Integer) r.get("tage"), (String) r.get("satz"), (String) r.get("grund"));
    }

    private EnergiemanagementDokumentDto.Fassung fassung(EnergiemanagementDokumentRepository.Fassung f,
            EnergiemanagementDokumentRepository.Fassung gilt, Map<UUID, EnergiemanagementPersonenRepository.Person> leute,
            Map<UUID, StandortKurz> orte) {
        var verweis = "verweis".equals(f.form()) ? new EnergiemanagementDokumentDto.Verweis(f.verweisBezeichnung(),
                f.verweisAblage(), f.verweisKennung(), f.verweisAdresse(), f.verweisFassungsangabe(), f.verweisDatum(),
                f.verweisSha256()) : null;
        var bereich = repo.bereich(f.id()).map(b -> anwendungsbereich(b, orte)).orElse(null);
        String status = "freigegeben".equals(f.status()) && gilt != null && f.nr() != gilt.nr() ? "abgeloest"
                : f.status();
        return new EnergiemanagementDokumentDto.Fassung(f.nr(), f.form(), f.wortlaut(), verweis, bereich, status,
                f.begruendung(), f.beschlussKennung(), f.pruefsumme(), f.vieraugen(),
                kurz(leute.get(f.entschiedenVon())), f.entschiedenTag(), f.freigabeBegruendung(),
                f.freigabe() == null ? null : new Eingetragen(f.freigabe(), f.freigabeAm()),
                f.entscheidung() == null ? null : new Eingetragen(f.entscheidung(), f.entschiedenAm()),
                f.entscheidungsBegruendung(), f.freigegebenAm(), new Eingetragen(f.akteur(), f.angelegtAm()));
    }

    private EnergiemanagementDokumentDto.Eintrag eintrag(EnergiemanagementDokumentRepository.Eintrag e,
            Map<UUID, EnergiemanagementPersonenRepository.Person> leute) {
        var von = leute.get(e.entschiedenVon());
        String satz = "geprueft_bleibt".equals(e.art()) && von != null ? satz("geprueft_bleibt", Map.of(
                "person", von.name(), "am", e.am().format(TAG), "begruendung", e.begruendung())) : null;
        return new EnergiemanagementDokumentDto.Eintrag(e.id(), e.art(), e.fassung(), e.am(),
                kurz(leute.get(e.personId())), kurz(von), e.kreis(), e.weg(), e.wegWortlaut(), e.begruendung(),
                e.beschlussKennung(), e.kommentar(), satz, new Eingetragen(e.akteur(), e.angelegtAm()));
    }

    private EnergiemanagementDokumentDto.Anwendungsbereich anwendungsbereich(
            EnergiemanagementDokumentRepository.Bereich b, Map<UUID, StandortKurz> orte) {
        List<Ausschluss> aus = new ArrayList<>();
        baum(b.ausschluesse()).forEach(a -> aus.add(new Ausschluss(a.path("art").asText(),
                UUID.fromString(a.path("verweis").asText()), a.path("begruendung").asText())));
        return new EnergiemanagementDokumentDto.Anwendungsbereich(b.standortIds().stream().map(s -> ort(s, orte))
                .toList(), b.traeger(), aus);
    }

    /** Was die Bezüge einer Dokumentliste nennen: Energieeinsätze, Personen, Aufgaben (Zuordnungen). */
    private record Bezuege(Map<UUID, EnergiemanagementDokumentDto.EinsatzKurz> einsaetze,
            Map<UUID, EnergiemanagementPersonenRepository.Person> leute,
            Map<UUID, EnergiemanagementPersonenRepository.Zuordnung> aufgaben) {}

    /** Lädt nur, was die Bezüge nennen; {@code leute} ist schon geladen oder {@code null}. */
    private Bezuege bezuege(List<EnergiemanagementDokumentRepository.Dokument> liste,
            Map<UUID, EnergiemanagementPersonenRepository.Person> leute) {
        Map<UUID, EnergiemanagementDokumentDto.EinsatzKurz> ee = new LinkedHashMap<>();
        repo.einsaetze(liste.stream().map(EnergiemanagementDokumentRepository.Dokument::energieeinsatzId)
                .filter(Objects::nonNull).distinct().toList())
                .forEach(e -> ee.put(e.id(), new EnergiemanagementDokumentDto.EinsatzKurz(e.id(), e.kennzeichen(),
                        e.name())));
        boolean mitAufgabe = liste.stream().anyMatch(d -> d.aufgabeId() != null);
        if (leute == null) {
            leute = liste.stream().anyMatch(d -> d.personId() != null) || mitAufgabe ? personen.personen().stream()
                    .collect(Collectors.toMap(EnergiemanagementPersonenRepository.Person::id, Function.identity()))
                    : Map.of();
        }
        Map<UUID, EnergiemanagementPersonenRepository.Zuordnung> aufgaben = mitAufgabe ? personen.zuordnungen()
                .stream().collect(Collectors.toMap(EnergiemanagementPersonenRepository.Zuordnung::id,
                        Function.identity())) : Map.of();
        return new Bezuege(ee, leute, aufgaben);
    }

    private static EnergiemanagementDokumentDto.BezugAus bezug(EnergiemanagementDokumentRepository.Dokument d,
            Map<UUID, StandortKurz> orte, Bezuege b) {
        EnergiemanagementDokumentDto.AufgabeKurz aufgabe = null;
        if (d.aufgabeId() != null) {
            var z = b.aufgaben().get(d.aufgabeId());
            aufgabe = z == null ? new EnergiemanagementDokumentDto.AufgabeKurz(d.aufgabeId(), null, null, null)
                    : new EnergiemanagementDokumentDto.AufgabeKurz(z.id(), z.aufgabe(), "weitere".equals(z.aufgabe())
                            ? z.aufgabeWortlaut() : EnergiemanagementRegeln.WOERTER.get("aufgabe").get(z.aufgabe()),
                            kurz(b.leute().get(z.personId())));
        }
        return new EnergiemanagementDokumentDto.BezugAus(d.bezug(), d.standortId() == null ? null
                : ort(d.standortId(), orte), d.energieeinsatzId() == null ? null
                : b.einsaetze().getOrDefault(d.energieeinsatzId(), new EnergiemanagementDokumentDto.EinsatzKurz(
                        d.energieeinsatzId(), null, null)), d.personId() == null ? null
                : kurz(b.leute().get(d.personId())), aufgabe);
    }

    /**
     * IP-14: der Standort eines Energieeinsatzes (der Zaun seiner Dokumente) — der eine Standort, an dem am Tag des
     * Anlegens die Messstellen seines Prozesses hängen; mehrere oder keiner: {@code null} (am Unternehmen). Ein Einsatz,
     * den die Anfrage nicht sieht, ist 422 {@code energieeinsatz_unbekannt} wie einer, den es nicht gibt.
     */
    private UUID standortDesEinsatzes(UUID id) {
        if (id == null) {
            throw einsatzUnbekannt();
        }
        EnergieeinsatzRepository.Zeile e;
        try {
            e = einsaetze.sichtbareZeile(id);
        } catch (EnergieeinsatzAbgelehnt nichtDa) {
            throw einsatzUnbekannt();
        }
        LocalDate tag = heute();
        Set<UUID> st = new LinkedHashSet<>();
        einsatzRepo.messstellen(e.prozessId(), tag)
                .forEach(ms -> kennzahlen.standortVonMessstelle(ms, tag).ifPresent(st::add));
        return st.size() == 1 ? st.iterator().next() : null;
    }

    private static EnergiemanagementAbgelehnt einsatzUnbekannt() {
        return EnergiemanagementAbgelehnt.fachlich("energieeinsatz_unbekannt",
                "Bitte wählen Sie einen Energieeinsatz Ihres Unternehmens.", Map.of("feld", "bezug.energieeinsatz_id"));
    }

    /** Der Standort des Bezugs und die Standorte jeder Fassung des Anwendungsbereichs. */
    private List<UUID> ortIds(EnergiemanagementDokumentRepository.Dokument d,
            List<EnergiemanagementDokumentRepository.Fassung> fassungen) {
        Set<UUID> ids = new LinkedHashSet<>();
        if (d.standortId() != null) ids.add(d.standortId());
        if ("anwendungsbereich".equals(d.art())) {
            fassungen.forEach(f -> repo.bereich(f.id()).ifPresent(b -> ids.addAll(b.standortIds())));
        }
        return List.copyOf(ids);
    }

    /** Standorte mit Kurzzeichen und Namen; ein Standort außerhalb des Zauns bleibt ohne Namen (nur die ID). */
    private Map<UUID, StandortKurz> orte(List<UUID> ids) {
        Map<UUID, StandortKurz> m = new LinkedHashMap<>();
        repo.standorte(ids).forEach(s -> m.put(s.id(), new StandortKurz(s.id(), s.kurzzeichen(), s.name())));
        return m;
    }

    private static StandortKurz ort(UUID id, Map<UUID, StandortKurz> orte) {
        return orte.getOrDefault(id, new StandortKurz(id, null, null));
    }

    private static List<StandortKurz> orteAus(Object ids, Map<UUID, StandortKurz> orte) {
        List<StandortKurz> aus = new ArrayList<>();
        for (Object s : (List<?>) ids) {
            aus.add(ort(UUID.fromString((String) s), orte));
        }
        return aus;
    }

    private static List<String> texte(List<UUID> ids) {
        return ids.stream().map(UUID::toString).toList();
    }

    private static PersonKurz kurz(EnergiemanagementPersonenRepository.Person p) {
        return p == null ? null : new PersonKurz(p.id(), p.name(), p.funktion(), p.kuerzel(), p.kontoSub() != null);
    }

    /** DK4: gültig ist die freigegebene Fassung mit der höchsten Nr. */
    private static EnergiemanagementDokumentRepository.Fassung gueltige(
            List<EnergiemanagementDokumentRepository.Fassung> fassungen) {
        return fassungen.stream().filter(f -> "freigegeben".equals(f.status()))
                .max((a, b) -> Integer.compare(a.nr(), b.nr())).orElse(null);
    }

    private static String artWort(String art) {
        return EnergiemanagementRegeln.WOERTER.get("dokument_art").get(art);
    }

    private static String klasse(String art) {
        return EnergiemanagementRegeln.DOKUMENT_ART_KLASSE.get(art);
    }

    private static boolean leitungsPflicht(String art) {
        return EnergiemanagementRegeln.LEITUNGS_PFLICHT.contains(art);
    }

    private static String satz(String schluessel, Map<String, String> werte) {
        Map<String, Object> s = EnergiemanagementRegeln.satz(schluessel, werte);
        if (s.containsKey("fehler")) {
            throw new IllegalStateException("Satz " + schluessel + ": " + s.get("fehler"));
        }
        return (String) s.get("satz");
    }

    private static String freigabeRolle(ProtokollAkteur wer) {
        return FREIGABE_ROLLEN.contains(wer.rolle()) ? wer.rolle() : null;
    }

    private static EnergiemanagementAbgelehnt entschieden(EnergiemanagementDokumentRepository.Fassung f, String satz) {
        return EnergiemanagementAbgelehnt.konflikt("fassung_" + f.status(), satz,
                Map.of("fassung", f.nr(), "status", f.status()));
    }

    private static EnergiemanagementPersonenDto.Beleg beleg(EnergiemanagementPersonenDto.Beleg b) {
        if (b == null) {
            return new EnergiemanagementPersonenDto.Beleg(null, null, null, null, null);
        }
        var n = new EnergiemanagementPersonenDto.Beleg(text(b.bezeichnung()), text(b.ablage()), text(b.kennung()),
                text(b.adresse()), text(b.sha256()));
        boolean irgendwas = n.bezeichnung() != null || n.kennung() != null || n.adresse() != null
                || n.sha256() != null;
        if (n.ablage() == null && irgendwas) {
            throw EnergiemanagementAbgelehnt.fachlich("beleg_ungueltig",
                    "Bitte nennen Sie, wo das Original liegt (Ablage).", Map.of("feld", "beleg.ablage"));
        }
        if (n.ablage() != null) {
            laenge("beleg.ablage", n.ablage(), 200);
            if (n.bezeichnung() != null) laenge("beleg.bezeichnung", n.bezeichnung(), 200);
            if (n.kennung() != null) laenge("beleg.kennung", n.kennung(), 200);
            if (n.adresse() != null) laenge("beleg.adresse", n.adresse(), 2000);
            if (n.sha256() != null && !SHA256.matcher(n.sha256()).matches()) {
                throw EnergiemanagementAbgelehnt.fachlich("beleg_ungueltig",
                        "Die Prüfsumme ist 64 Zeichen 0–9 und a–f.", Map.of("feld", "beleg.sha256"));
            }
        }
        return n;
    }

    private static String beschluss(String kennung) {
        String b = text(kennung);
        if (b != null && !BESCHLUSS.matcher(b).matches()) {
            throw EnergiemanagementAbgelehnt.fachlich("beschluss_ungueltig",
                    "Bitte nennen Sie den Beschluss als BR-JJJJ-nnnn/Bn.", Map.of("feld", "beschluss_kennung"));
        }
        return b;
    }

    /** Ein Tag, der schon war (Vorgabe heute, Zeitzone des Unternehmens). */
    private LocalDate tag(LocalDate tag, String feld) {
        LocalDate heute = heute();
        if (tag == null) {
            return heute;
        }
        if (tag.isAfter(heute)) {
            throw EnergiemanagementAbgelehnt.fachlich("tag_in_der_zukunft",
                    "Festgehalten wird, was schon entschieden bzw. geschehen ist — bitte wählen Sie einen Tag bis "
                            + "heute.", Map.of("feld", feld, "heute", heute.toString()));
        }
        return tag;
    }

    private static String begruendung(String text) {
        String b = text == null ? "" : text.strip();
        if (b.length() < 10 || b.length() > 500) {
            throw begruendungFehlt();
        }
        return b;
    }

    private static EnergiemanagementAbgelehnt begruendungFehlt() {
        return EnergiemanagementAbgelehnt.fachlich("begruendung_fehlt", "Bitte begründen Sie mit 10 bis 500 Zeichen.",
                Map.of("min", 10, "max", 500));
    }

    private static void laenge(String feld, String wert, int max) {
        if (wert.length() > max) {
            throw ungueltig(feld, "Bitte kürzen Sie auf höchstens " + max + " Zeichen.");
        }
    }

    private static EnergiemanagementAbgelehnt ungueltig(String feld, String satz) {
        return EnergiemanagementAbgelehnt.fachlich("angabe_ungueltig", satz, Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt standortUnbekannt(String feld) {
        return EnergiemanagementAbgelehnt.fachlich("standort_unbekannt",
                "Bitte wählen Sie einen Standort Ihres Kundenbereichs.", Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt personUnbekannt(String feld) {
        return EnergiemanagementAbgelehnt.fachlich("person_unbekannt",
                "Bitte wählen Sie eine Person im Energiemanagement Ihres Kundenbereichs.", Map.of("feld", feld));
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static LocalDate datum(Object s) {
        return s == null ? null : LocalDate.parse((String) s);
    }

    /** „Heute“ in der Zeitzone des Unternehmens an der Uhr des Dienstes — auch der Abruf-Tag der Nachweise (IP-14). */
    LocalDate heute() {
        return LocalDate.ofInstant(uhr.instant(), ZoneId.of(unternehmen.desKundenbereichs()
                .map(UnternehmenRepository.Unternehmen::zeitzone).orElse("Europe/Berlin")));
    }

    private JsonNode baum(String s) {
        try {
            return s == null ? null : json.readTree(s);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Ungültiger Schnappschuss", e);
        }
    }
}
