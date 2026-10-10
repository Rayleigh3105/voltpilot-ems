package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto;
import com.voltpilot.api.web.dto.InternesAuditDto;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * UEMS AP-19 IP-18: internes Audit (IA1–IA5, §5.4, §5.6) über der Datenhaltung von IP-16.
 *
 * <p>Geplant mit Titel, Termin, Auditorin oder Auditor (Personen, auch ohne Konto), Unabhängigkeit als Wortlaut, was
 * und woran geprüft wird, Verantwortlich (Konto) · durchgeführt an einem Tag, nie in der Zukunft · Hinweise mit
 * „festgestellt von“ (die Person, die prüft — sie braucht kein Schreibrecht, IA5) und „eingetragen von“ (das Konto) ·
 * abgeschlossen mit Bericht als Verweis oder Zusammenfassung und einer Kopie mit Prüfsumme (IA3), danach unveränderlich
 * · abgesagt mit Begründung. Das nächste interne Audit ist nie gespeichert: letzter Durchführungstag + Rhythmus beim
 * Abruf, ohne durchgeführtes Audit keine Frist (IA4, Operation {@code ueberpruefung} des Vertrags). Das Recht prüft der
 * Interceptor an der Route; die Übergänge hält die Datenbank zusätzlich einmalig.
 */
@Service
public class InternesAuditService {

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern MASSNAHME = Pattern.compile("^M-[0-9]{4}-[0-9]{4,9}$");
    private static final int WORTLAUT = EnergiemanagementRegeln.STARTWERTE.eintrag_zeichen_hoechstens();

    /** Ein Hinweis, wie ihn die Kopie des Abschlusses festhält (Referenzdatei 1.10 {@code audits[].hinweise[]}). */
    public record HinweisKopie(int nr, String am, String festgestelltVon, String eingetragenVon, String wortlaut,
            String massnahme) {}

    private final InternesAuditRepository repo;
    private final UnternehmenRepository unternehmen;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private volatile Clock uhr = Clock.systemUTC();

    public InternesAuditService(InternesAuditRepository repo, UnternehmenRepository unternehmen, ObjectMapper json,
            PlatformTransactionManager tm) {
        this.repo = repo;
        this.unternehmen = unternehmen;
        this.json = json;
        this.tx = new TransactionTemplate(tm);
    }

    /** Nur für Tests: die Uhr, an der „heute“, „nie in der Zukunft“ und das Jahr im Kennzeichen hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ Lesen

    /** Das Auditprogramm am {@code tag} (Vorgabe heute): alle sichtbaren Audits und das nächste fällige (IA4). */
    public InternesAuditDto.Auditprogramm programm(LocalDate tag) {
        LocalDate abruf = tag == null ? heute() : tag;
        var audits = repo.audits();
        var personen = personen(audits.stream().flatMap(a -> personenDes(a).stream()).distinct().toList());
        int monate = repo.rhythmusMonate().orElse(EnergiemanagementRegeln.STARTWERTE.audit_rhythmus_monate());
        List<String> tage = audits.stream().map(InternesAuditRepository.Audit::durchgefuehrtAm)
                .filter(Objects::nonNull).map(LocalDate::toString).toList();
        Map<String, Object> frist = EnergiemanagementRegeln.ueberpruefung(new EnergiemanagementRegeln.UeberpruefungEingang(
                "internes_audit", null, monate, null, null, tage, null, null, null, null, abruf.toString()));
        var naechstes = new InternesAuditDto.Naechstes(monate, tagOderNull(frist.get("faellig_am")),
                tagOderNull(frist.get("basis")), (Integer) frist.get("tage"), (String) frist.get("satz"),
                (String) frist.get("grund"));
        return new InternesAuditDto.Auditprogramm(abruf, audits.stream().map(a -> audit(a, personen)).toList(),
                naechstes);
    }

    /** Das Audit mit Hinweisen und Verlauf; eines, das die Anfrage nicht sieht, gibt es nicht (404). */
    public InternesAuditDto.AuditMitVerlauf audit(UUID id) {
        var a = repo.audit(id).orElseThrow(InternesAuditService::auditFehlt);
        var hinweise = repo.hinweise(id);
        var ids = new ArrayList<>(personenDes(a));
        hinweise.forEach(h -> ids.add(h.festgestelltVon()));
        var personen = personen(ids.stream().distinct().toList());
        return new InternesAuditDto.AuditMitVerlauf(audit(a, personen), hinweise.stream()
                .map(h -> new InternesAuditDto.Hinweis(h.nr(), h.am(), personen.get(h.festgestelltVon()), h.wortlaut(),
                        new EnergiemanagementPersonenDto.Eingetragen(h.akteur(), h.zeit())))
                .toList(), repo.verlauf(id).stream()
                .map(v -> new EnergiemanagementPersonenDto.Aenderung(v.id(), v.art(), baum(v.alt()), baum(v.neu()),
                        v.begruendung(), v.akteur(), v.zeit()))
                .toList());
    }

    // ------------------------------------------------------------------ Schreiben

    /** Planen (IA1): Protokoll {@code audit_geplant}; das Kennzeichen AU-JJJJ-nnnn trägt das Jahr des Anlegens. */
    public UUID planen(InternesAuditDto.AuditStand s, ProtokollAkteur wer) {
        return tx.execute(t -> {
            var stand = stand(s);
            return repo.anlegen(stand, uhr.instant(), wer);
        });
    }

    /** Ändern, solange geplant — der ganze Stand; ein anderer Termin braucht eine Begründung (§5.6). */
    public void aendern(UUID id, InternesAuditDto.AuditStand s, ProtokollAkteur wer) {
        tx.executeWithoutResult(t -> {
            var alt = repo.auditSperren(id).orElseThrow(InternesAuditService::auditFehlt);
            geplant(alt);
            var neu = stand(s);
            String begruendung = text(s.begruendung());
            if (!Objects.equals(alt.termin(), neu.termin()) || begruendung != null) {
                begruendung = begruendung(s.begruendung());
            }
            boolean gleich = alt.titel().equals(neu.titel()) && alt.termin().equals(neu.termin())
                    && alt.auditorIds().equals(neu.auditorIds()) && alt.unabhaengigkeit().equals(neu.unabhaengigkeit())
                    && alt.was().equals(neu.was()) && alt.woran().equals(neu.woran())
                    && alt.verantwortlichSub().equals(neu.verantwortlichSub())
                    && alt.standortIds().equals(neu.standortIds());
            if (!gleich) {
                repo.aendern(id, neu, begruendung, wer);
            }
        });
    }

    /** Durchgeführt melden: geplant → durchgefuehrt, der Tag nie in der Zukunft. */
    public void durchgefuehrt(UUID id, InternesAuditDto.Durchgefuehrt d, ProtokollAkteur wer) {
        tx.executeWithoutResult(t -> {
            var a = repo.auditSperren(id).orElseThrow(InternesAuditService::auditFehlt);
            geplant(a);
            if (d.am() == null) {
                throw fehlt("am");
            }
            nichtInZukunft(d.am(), "am");
            repo.durchgefuehrt(id, d.am(), wer);
        });
    }

    /**
     * Einen Hinweis festhalten (IA2, IA5): nur am durchgeführten Audit; festgestellt von einer Person, eingetragen von
     * dem Konto, das festhält; der Tag ist Vorgabe der Durchführungstag. Die Nummer vergibt die Datenbank lückenlos.
     */
    public int hinweis(UUID id, InternesAuditDto.HinweisFesthalten h, ProtokollAkteur wer) {
        return tx.execute(t -> {
            var a = repo.auditSperren(id).orElseThrow(InternesAuditService::auditFehlt);
            durchgefuehrt(a);
            String wortlaut = text(h.wortlaut());
            if (wortlaut == null) {
                throw fehlt("wortlaut");
            }
            laenge("wortlaut", wortlaut, WORTLAUT);
            if (h.festgestelltVon() == null) {
                throw fehlt("festgestellt_von");
            }
            person(h.festgestelltVon(), "festgestellt_von");
            LocalDate am = h.am() == null ? a.durchgefuehrtAm() : h.am();
            nichtVorDurchfuehrung(am, a, "am");
            nichtInZukunft(am, "am");
            return repo.hinweis(id, am, h.festgestelltVon(), wortlaut, wer);
        });
    }

    /**
     * Abschließen (IA3): entschieden von einer Person, Bericht als Verweis oder Zusammenfassung; die Kopie nennt das
     * Audit, seine Hinweise (mit der Maßnahme, die aus einem wurde), seine Feststellungen und den Bericht — mit
     * Prüfsumme. Danach ist das Audit unveränderlich.
     */
    public void abschliessen(UUID id, InternesAuditDto.Abschliessen b, ProtokollAkteur wer) {
        tx.executeWithoutResult(t -> {
            var a = repo.auditSperren(id).orElseThrow(InternesAuditService::auditFehlt);
            durchgefuehrt(a);
            if (b.entschiedenVon() == null) {
                throw EnergiemanagementAbgelehnt.fachlich("entschieden_von_fehlt",
                        "Bitte nennen Sie, wer den Abschluss entschieden hat.", Map.of("feld", "entschieden_von"));
            }
            person(b.entschiedenVon(), "entschieden_von");
            LocalDate am = b.am() == null ? heute() : b.am();
            nichtVorDurchfuehrung(am, a, "am");
            nichtInZukunft(am, "am");
            var bericht = bericht(b.bericht());
            String zusammenfassung = text(b.zusammenfassung());
            if (zusammenfassung != null) {
                laenge("zusammenfassung", zusammenfassung, WORTLAUT);
            }
            if (bericht == null && zusammenfassung == null) {
                throw EnergiemanagementAbgelehnt.fachlich("bericht_oder_zusammenfassung",
                        "Bitte halten Sie fest, wo der Bericht liegt, oder fassen Sie das Ergebnis zusammen.",
                        Map.of("feld", "bericht.ablage"));
            }
            var hinweise = repo.hinweise(id);
            Map<Integer, String> massnahmen = massnahmen(b.massnahmen(), hinweise, a.kennzeichen());
            var personen = personen(hinweise.stream().map(InternesAuditRepository.Hinweis::festgestelltVon)
                    .distinct().toList());
            Map<String, String> konten = new HashMap<>();
            List<HinweisKopie> kopien = hinweise.stream().map(h -> new HinweisKopie(h.nr(), h.am().toString(),
                    zeichen(personen.get(h.festgestelltVon())),
                    konten.computeIfAbsent(h.akteur().sub() + "|" + h.akteur().name(), k -> eingetragen(h.akteur())),
                    h.wortlaut(), massnahmen.get(h.nr()))).toList();
            JsonNode kopie = kopie(a.kennzeichen(), kopien, repo.feststellungen(id), bericht);
            Map<String, Object> summe = EnergiemanagementRegeln.pruefsumme(kopie);
            repo.abschliessen(id, new InternesAuditRepository.Abschluss(b.entschiedenVon(), am, zusammenfassung,
                    bericht == null ? null : bericht.bezeichnung(), bericht == null ? null : bericht.ablage(),
                    bericht == null ? null : bericht.kennung(), bericht == null ? null : bericht.adresse(),
                    bericht == null ? null : bericht.sha256(), (String) summe.get("kanonisch"),
                    (String) summe.get("pruefsumme"), uhr.instant()), wer);
        });
    }

    /** Absagen: geplant → abgesagt, Begründung Pflicht; endgültig. */
    public void absagen(UUID id, InternesAuditDto.Absagen b, ProtokollAkteur wer) {
        tx.executeWithoutResult(t -> {
            var a = repo.auditSperren(id).orElseThrow(InternesAuditService::auditFehlt);
            geplant(a);
            repo.absagen(id, begruendung(b.begruendung()), wer);
        });
    }

    // ------------------------------------------------------------------ Kopie (IA3)

    /**
     * Die Kopie des Abschlusses mit genau den Schlüsseln, die der Trigger {@code internes_audit_eingefroren} verlangt:
     * {@code kennzeichen}, {@code hinweise}, {@code feststellungen}, {@code bericht} ({@code null} ohne Ablage). Die
     * Prüfsumme bildet {@link EnergiemanagementRegeln#pruefsumme} in der kanonischen Form des Vertrags.
     */
    public static JsonNode kopie(String kennzeichen, List<HinweisKopie> hinweise, List<String> feststellungen,
            InternesAuditDto.Bericht bericht) {
        JsonNodeFactory f = JsonNodeFactory.instance;
        ObjectNode k = f.objectNode();
        k.put("kennzeichen", kennzeichen);
        ArrayNode h = k.putArray("hinweise");
        for (var x : hinweise) {
            ObjectNode e = h.addObject();
            e.put("nr", x.nr());
            e.put("am", x.am());
            e.put("festgestellt_von", x.festgestelltVon());
            e.put("eingetragen_von", x.eingetragenVon());
            e.put("wortlaut", x.wortlaut());
            e.put("massnahme", x.massnahme());
        }
        ArrayNode fs = k.putArray("feststellungen");
        feststellungen.stream().sorted().forEach(fs::add);
        if (bericht == null) {
            k.putNull("bericht");
        } else {
            ObjectNode b = k.putObject("bericht");
            b.put("bezeichnung", bericht.bezeichnung());
            b.put("ablage", bericht.ablage());
            b.put("kennung", bericht.kennung());
            b.put("adresse", bericht.adresse());
            b.put("sha256", bericht.sha256());
        }
        return k;
    }

    // ------------------------------------------------------------------ Prüfungen

    private InternesAuditRepository.Stand stand(InternesAuditDto.AuditStand s) {
        String titel = text(s.titel());
        if (titel == null) {
            throw fehlt("titel");
        }
        laenge("titel", titel, 200);
        if (s.termin() == null) {
            throw fehlt("termin");
        }
        List<UUID> auditoren = s.auditorIds() == null ? List.of() : s.auditorIds();
        if (auditoren.isEmpty() || auditoren.stream().anyMatch(Objects::isNull)) {
            throw EnergiemanagementAbgelehnt.fachlich("auditor_fehlt",
                    "Bitte nennen Sie, wer das Audit durchführt.", Map.of("feld", "auditor_ids"));
        }
        if (new HashSet<>(auditoren).size() != auditoren.size()) {
            throw ungueltig("auditor_ids", "Bitte nennen Sie jede Person nur einmal.");
        }
        var personen = repo.personen(auditoren);
        if (personen.size() != auditoren.size()) {
            throw unbekannt("auditor_ids");
        }
        for (var p : personen) {
            if (p.bis() != null && p.bis().isBefore(s.termin())) {
                throw EnergiemanagementAbgelehnt.fachlich("person_beendet",
                        "Diese Person ist am Termin nicht mehr im Energiemanagement.",
                        Map.of("feld", "auditor_ids", "bis", p.bis().toString()));
            }
        }
        String unabhaengigkeit = text(s.unabhaengigkeit());
        if (unabhaengigkeit == null) {
            throw EnergiemanagementAbgelehnt.fachlich("unabhaengigkeit_fehlt",
                    "Bitte halten Sie fest, warum die Auditorin oder der Auditor unabhängig prüft.",
                    Map.of("feld", "unabhaengigkeit"));
        }
        laenge("unabhaengigkeit", unabhaengigkeit, WORTLAUT);
        String was = text(s.was());
        if (was == null) {
            throw fehlt("was");
        }
        laenge("was", was, WORTLAUT);
        String woran = text(s.woran());
        if (woran == null) {
            throw fehlt("woran");
        }
        laenge("woran", woran, WORTLAUT);
        String sub = text(s.verantwortlich());
        if (sub == null) {
            throw EnergiemanagementAbgelehnt.fachlich("verantwortlich_fehlt",
                    "Bitte nennen Sie eine verantwortliche Person mit Konto.", Map.of("feld", "verantwortlich"));
        }
        var konto = repo.konto(sub).orElseThrow(() -> EnergiemanagementAbgelehnt.fachlich("konto_unbekannt",
                "Bitte wählen Sie ein Konto aus Ihrem Kundenbereich.", Map.of("feld", "verantwortlich")));
        List<UUID> standorte = s.standortIds() == null ? List.of() : s.standortIds();
        if (standorte.stream().anyMatch(Objects::isNull) || new HashSet<>(standorte).size() != standorte.size()
                || repo.standorte(standorte) != standorte.size()) {
            throw EnergiemanagementAbgelehnt.fachlich("standort_unbekannt",
                    "Bitte wählen Sie Standorte Ihres Kundenbereichs, jeden einmal.", Map.of("feld", "standort_ids"));
        }
        String name = konto.name() == null || konto.name().isBlank() ? konto.sub() : konto.name();
        return new InternesAuditRepository.Stand(titel, s.termin(), List.copyOf(auditoren), unabhaengigkeit, was, woran,
                konto.sub(), name, konto.konto(), List.copyOf(standorte));
    }

    /** Je Hinweis höchstens eine Maßnahme, und nur eine, die dieses Audit als Herkunft nennt (IA2, AP-18 W4). */
    private Map<Integer, String> massnahmen(List<InternesAuditDto.HinweisMassnahme> liste,
            List<InternesAuditRepository.Hinweis> hinweise, String kennzeichen) {
        Map<Integer, String> aus = new HashMap<>();
        if (liste == null) {
            return aus;
        }
        var nummern = hinweise.stream().map(InternesAuditRepository.Hinweis::nr).collect(Collectors.toSet());
        for (var m : liste) {
            if (m == null || m.hinweis() == null || !nummern.contains(m.hinweis())) {
                throw EnergiemanagementAbgelehnt.fachlich("hinweis_unbekannt",
                        "Diesen Hinweis gibt es an diesem Audit nicht.",
                        Map.of("feld", "massnahmen", "hinweis", m == null || m.hinweis() == null ? "" : m.hinweis()));
            }
            String massnahme = text(m.massnahme());
            String[] herkunft = massnahme == null || !MASSNAHME.matcher(massnahme).matches() ? null
                    : repo.massnahmeHerkunft(massnahme).orElse(null);
            if (herkunft == null || !"audit".equals(herkunft[0]) || !kennzeichen.equals(herkunft[1])) {
                throw EnergiemanagementAbgelehnt.fachlich("massnahme_unbekannt",
                        "Bitte nennen Sie eine Maßnahme, die aus diesem Audit hervorgegangen ist.",
                        Map.of("feld", "massnahmen", "massnahme", massnahme == null ? "" : massnahme));
            }
            if (aus.put(m.hinweis(), massnahme) != null) {
                throw ungueltig("massnahmen", "Bitte nennen Sie je Hinweis höchstens eine Maßnahme.");
            }
        }
        return aus;
    }

    private static InternesAuditDto.Bericht bericht(InternesAuditDto.Bericht b) {
        if (b == null) {
            return null;
        }
        var n = new InternesAuditDto.Bericht(text(b.bezeichnung()), text(b.ablage()), text(b.kennung()),
                text(b.adresse()), text(b.sha256()));
        if (n.ablage() == null) {
            if (n.bezeichnung() != null || n.kennung() != null || n.adresse() != null || n.sha256() != null) {
                throw EnergiemanagementAbgelehnt.fachlich("bericht_ungueltig",
                        "Bitte nennen Sie, wo der Bericht liegt (Ablage).", Map.of("feld", "bericht.ablage"));
            }
            return null;
        }
        laenge("bericht.ablage", n.ablage(), 200);
        if (n.bezeichnung() != null) laenge("bericht.bezeichnung", n.bezeichnung(), 200);
        if (n.kennung() != null) laenge("bericht.kennung", n.kennung(), 200);
        if (n.adresse() != null) laenge("bericht.adresse", n.adresse(), 2000);
        if (n.sha256() != null && !SHA256.matcher(n.sha256()).matches()) {
            throw EnergiemanagementAbgelehnt.fachlich("bericht_ungueltig",
                    "Die Prüfsumme ist 64 Zeichen 0–9 und a–f.", Map.of("feld", "bericht.sha256"));
        }
        return n;
    }

    private void person(UUID id, String feld) {
        if (repo.personen(List.of(id)).isEmpty()) {
            throw unbekannt(feld);
        }
    }

    private static void geplant(InternesAuditRepository.Audit a) {
        if (!"geplant".equals(a.zustand())) {
            throw EnergiemanagementAbgelehnt.konflikt("audit_nicht_geplant",
                    "Dieses Audit ist nicht mehr geplant; ändern und absagen geht nur vorher.",
                    Map.of("zustand", a.zustand()));
        }
    }

    private static void durchgefuehrt(InternesAuditRepository.Audit a) {
        if (!"durchgefuehrt".equals(a.zustand())) {
            throw EnergiemanagementAbgelehnt.konflikt("audit_nicht_durchgefuehrt",
                    "Ergebnisse und Abschluss gibt es nur am durchgeführten, noch nicht abgeschlossenen Audit.",
                    Map.of("zustand", a.zustand()));
        }
    }

    private void nichtInZukunft(LocalDate tag, String feld) {
        LocalDate heute = heute();
        if (tag.isAfter(heute)) {
            throw EnergiemanagementAbgelehnt.fachlich("tag_in_zukunft", "Bitte wählen Sie einen Tag bis heute.",
                    Map.of("feld", feld, "heute", heute.toString()));
        }
    }

    private static void nichtVorDurchfuehrung(LocalDate tag, InternesAuditRepository.Audit a, String feld) {
        if (tag.isBefore(a.durchgefuehrtAm())) {
            throw EnergiemanagementAbgelehnt.fachlich("tag_vor_durchfuehrung",
                    "Bitte wählen Sie einen Tag ab der Durchführung.",
                    Map.of("feld", feld, "durchgefuehrt_am", a.durchgefuehrtAm().toString()));
        }
    }

    // ------------------------------------------------------------------ Darstellung

    private InternesAuditDto.Audit audit(InternesAuditRepository.Audit a,
            Map<UUID, EnergiemanagementPersonenDto.PersonKurz> personen) {
        InternesAuditDto.Abschluss abschluss = null;
        if ("abgeschlossen".equals(a.zustand())) {
            var bericht = a.berichtAblage() == null ? null : new InternesAuditDto.Bericht(a.berichtBezeichnung(),
                    a.berichtAblage(), a.berichtKennung(), a.berichtAdresse(), a.berichtSha256());
            abschluss = new InternesAuditDto.Abschluss(a.abgeschlossenAm(), personen.get(a.entschiedenVon()),
                    a.zusammenfassung(), bericht, baum(a.kopie()), a.pruefsumme(),
                    new EnergiemanagementPersonenDto.Eingetragen(a.abschluss(), a.abschlussEingetragenAm()));
        }
        return new InternesAuditDto.Audit(a.id(), a.kennzeichen(), a.titel(), a.termin(),
                a.auditorIds().stream().map(personen::get).toList(), a.unabhaengigkeit(), a.was(), a.woran(),
                new EnergiemanagementVerantwortungDto.Person(a.verantwortlichSub(), a.verantwortlichName()),
                a.standortIds(), a.zustand(), a.durchgefuehrtAm(), a.abgesagtBegruendung(), a.hinweise(),
                repo.feststellungen(a.id()), abschluss,
                new EnergiemanagementPersonenDto.Eingetragen(a.akteur(), a.angelegtAm()));
    }

    private static List<UUID> personenDes(InternesAuditRepository.Audit a) {
        var ids = new ArrayList<>(a.auditorIds());
        if (a.entschiedenVon() != null) {
            ids.add(a.entschiedenVon());
        }
        return ids;
    }

    private Map<UUID, EnergiemanagementPersonenDto.PersonKurz> personen(List<UUID> ids) {
        return repo.personen(ids).stream().collect(Collectors.toMap(InternesAuditRepository.Person::id,
                p -> new EnergiemanagementPersonenDto.PersonKurz(p.id(), p.name(), p.funktion(), p.kuerzel(),
                        p.kontoSub() != null), (x, y) -> x, LinkedHashMap::new));
    }

    /** So nennt die Kopie eine Person: ihr Kürzel, ohne Kürzel ihr Name (Referenzdatei: „CB“, „IK“). */
    private static String zeichen(EnergiemanagementPersonenDto.PersonKurz p) {
        return p.kuerzel() != null ? p.kuerzel() : p.name();
    }

    /** „Eingetragen von“ in der Kopie: die Person dieses Kontos (ihr Kürzel), ohne Person der Name des Kontos. */
    private String eingetragen(ProtokollAkteur akteur) {
        return repo.personDesKontos(akteur.sub()).map(p -> p.kuerzel() != null ? p.kuerzel() : p.name())
                .orElse(akteur.name());
    }

    private LocalDate heute() {
        ZoneId zone = ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
        return LocalDate.ofInstant(uhr.instant(), zone);
    }

    private static LocalDate tagOderNull(Object tag) {
        return tag == null ? null : LocalDate.parse(tag.toString());
    }

    private JsonNode baum(String s) {
        try {
            return s == null ? null : json.readTree(s);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Ungültiger Schnappschuss", e);
        }
    }

    private static String begruendung(String text) {
        String b = text == null ? "" : text.strip();
        if (b.length() < 10 || b.length() > 500) {
            throw EnergiemanagementAbgelehnt.fachlich("begruendung_fehlt", "Bitte begründen Sie mit 10 bis 500 Zeichen.",
                    Map.of("min", 10, "max", 500));
        }
        return b;
    }

    private static void laenge(String feld, String wert, int max) {
        if (wert.length() > max) {
            throw ungueltig(feld, "Bitte kürzen Sie auf höchstens " + max + " Zeichen.");
        }
    }

    private static EnergiemanagementAbgelehnt fehlt(String feld) {
        return EnergiemanagementAbgelehnt.fachlich("angabe_fehlt", "Bitte füllen Sie dieses Feld aus.",
                Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt ungueltig(String feld, String satz) {
        return EnergiemanagementAbgelehnt.fachlich("angabe_ungueltig", satz, Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt unbekannt(String feld) {
        return EnergiemanagementAbgelehnt.fachlich("person_unbekannt",
                "Bitte wählen Sie eine Person im Energiemanagement Ihres Kundenbereichs.", Map.of("feld", feld));
    }

    static EnergiemanagementAbgelehnt auditFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Dieses Audit gibt es nicht.", null);
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
