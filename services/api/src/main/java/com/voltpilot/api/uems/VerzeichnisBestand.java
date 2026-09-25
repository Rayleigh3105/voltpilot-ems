package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisDto;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-8 (VZ1): die Verzeichnis-Quelle „Bestand“ — die Stände, Fassungen und Belege, die AP-11 bis AP-18
 * schon lenken, gelesen über die Leser ihrer Dienste, also mit deren Zaun und Rechten; was der Aufrufer dort nicht
 * sieht, steht hier nicht, und eine Quelle, die ihm gar nichts zeigt, trägt keine Zeile bei. Kopiert wird nichts.
 *
 * <p>Gruppen nach dem Konzept-Katalog (R3): Betrachtungsumfang in „grundlagen“; Kriterien- und Einstufungs-Fassungen,
 * Messbedarfe und die Stände der energetischen Bewertung in „bewertung_messplanung“; Kennzahl- und
 * Bezugsbasis-Fassungen und die Stände des Leistungsvergleichs in „kennzahlen_bezugsbasen“; Energieziel- und
 * Maßnahmen-Bewertungen und Abweichungs-Abschlüsse in „ziele_massnahmen_abweichungen“; die übrigen Berichtsstände in
 * „berichte“. Eine Entscheidung zählt, wenn sie gilt: freigegeben bzw. bewertet, nicht aufgehoben — auch abgelöste
 * Fassungen und ersetzte Stände. Beim Betrachtungsumfang und bei den Kriterien IST {@code aufgehoben_am} die Ablösung
 * (das Anlegen bzw. die Freigabe der nächsten Fassung setzt es): ihre Zeile bleibt und sagt ab dem Tag der Ablösung
 * „abgelöst am …“ (AP-19 IP-26, VZ1, DK4 — eine abgelöste Freigabe bleibt eine Entscheidung). „entschieden von“ steht
 * nur, wo eine zweite Person entschieden hat (Vier-Augen); sonst trägt „eingetragen von“ beides (G2). Was eine Quelle
 * nicht trägt — Prüfsumme, Nr. —, bleibt leer.
 *
 * <p>Messmittel-Angaben mit ihren Belegen (AP-16, R3 Schritt 2) in „bewertung_messplanung“, gelesen über
 * {@link MessmittelService#alle()} im Zaun des Geräts: der Beleg ist schon ein Verweis, seine Zeile sagt „Geführt in
 * Ihrem System: …“ mit der im Browser gebildeten Prüfsumme, Person und Tag seines Eintragens. Ohne Ablage nennt der
 * Ort die Bezeichnung des Belegs — mehr hat der Kunde über das Original nicht gesagt. Eine Angabe ohne Beleg nennt
 * kein Original und keine Person — sie ist kein Nachweis und trägt keine Zeile.
 */
@Component
@Order(30)
public class VerzeichnisBestand implements VerzeichnisQuelle {

    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    private final BewertungUmfangService umfang;
    private final BewertungKriterienService kriterien;
    private final EnergieeinsatzService einsaetze;
    private final EnergieeinsatzEinstufungService einstufungen;
    private final MessbedarfService messbedarfe;
    private final MessmittelService messmittel;
    private final KennzahlService kennzahlen;
    private final BezugsbasisService bezugsbasen;
    private final BerichtService berichte;
    private final EnergiezielService energieziele;
    private final MassnahmeService massnahmen;
    private final MassnahmeBewertung massnahmeBewertung;
    private final AbweichungService abweichungen;
    private final UnternehmenRepository unternehmen;

    public VerzeichnisBestand(BewertungUmfangService umfang, BewertungKriterienService kriterien,
            EnergieeinsatzService einsaetze, EnergieeinsatzEinstufungService einstufungen,
            MessbedarfService messbedarfe, MessmittelService messmittel, KennzahlService kennzahlen,
            BezugsbasisService bezugsbasen, BerichtService berichte, EnergiezielService energieziele,
            MassnahmeService massnahmen, MassnahmeBewertung massnahmeBewertung, AbweichungService abweichungen,
            UnternehmenRepository unternehmen) {
        this.umfang = umfang;
        this.kriterien = kriterien;
        this.einsaetze = einsaetze;
        this.einstufungen = einstufungen;
        this.messbedarfe = messbedarfe;
        this.messmittel = messmittel;
        this.kennzahlen = kennzahlen;
        this.bezugsbasen = bezugsbasen;
        this.berichte = berichte;
        this.energieziele = energieziele;
        this.massnahmen = massnahmen;
        this.massnahmeBewertung = massnahmeBewertung;
        this.abweichungen = abweichungen;
        this.unternehmen = unternehmen;
    }

    @Override
    public List<Map<String, Object>> zeilen(LocalDate stichtag) {
        ZoneId zone = ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
        var aus = new ArrayList<Map<String, Object>>();
        bewertung(aus, zone, stichtag);
        kennzahlen(aus, zone);
        berichte(aus, zone);
        verbesserung(aus, zone);
        return aus;
    }

    // ------------------------------------------------------------------ AP-16

    private void bewertung(List<Map<String, Object>> aus, ZoneId zone, LocalDate stichtag) {
        try {
            for (var f : umfang.historie().fassungen()) {
                if (f.fassung() == null) continue;
                aus.add(zeile("grundlagen", "betrachtungsumfang", "Betrachtungsumfang",
                        abgeloest("Betrachtungsumfang der energetischen Bewertung", f.aufgehobenAm(), zone, stichtag),
                        f.fassung(), null, name(f.akteur()), f.gueltigAb(), null));
            }
        } catch (BewertungUmfangAbgelehnt keinStandort) {
            // Kein sichtbarer Standort: der Umfang zeigt diesem Aufrufer nichts — also auch das Verzeichnis nicht.
        }
        try {
            for (var f : kriterien.historie().fassungen()) {
                // Die Vorgabe von VoltPilot (nie gespeichert, ohne createdAt) ist keine Entscheidung des Kunden.
                if (f.createdAt() == null || !"freigegeben".equals(f.freigabeStatus())) {
                    continue;
                }
                aus.add(zeile("bewertung_messplanung", "kriterien_fassung", "Kriterien",
                        abgeloest("Kriterien der energetischen Bewertung", f.aufgehobenAm(), zone, stichtag), f.fassung(),
                        zweite(f.akteur(), f.entschiedenVon()), name(f.akteur()), f.gueltigAb(), null));
            }
        } catch (BewertungKriterienAbgelehnt keinStandort) {
            // wie beim Umfang: nichts sichtbar, keine Zeile.
        }
        Map<java.util.UUID, String> einsatz = new HashMap<>();
        for (var e : einsaetze.liste(null).energieeinsaetze()) {
            einsatz.put(e.id(), e.kennzeichen());
            for (var f : einstufungen.historie(e.id()).fassungen()) {
                if (!"freigegeben".equals(f.freigabeStatus())) continue;
                aus.add(zeile("bewertung_messplanung", "einstufung_fassung", e.kennzeichen(),
                        "Einstufung " + e.kennzeichen() + " " + e.name() + ": " + f.einstufung(), f.fassung(),
                        zweite(f.akteur(), f.entschiedenVon()), name(f.akteur()), f.gueltigAb(), null));
            }
        }
        for (var b : messbedarfe.alle(null).messbedarfe()) {
            String ee = einsatz.get(b.energieeinsatzId());
            aus.add(zeile("bewertung_messplanung", "messbedarf", b.kennzeichen(), "Messbedarf " + b.kennzeichen()
                    + (ee == null ? "" : " (" + ee + ")") + ": " + b.zustand(), null, null, name(b.akteur()),
                    tag(b.angelegtAm(), zone), null));
        }
        for (var a : messmittel.alle()) {
            var b = a.beleg();
            if (b == null) continue;
            String einbau = a.einbauKennzeichen().equals(a.kennzeichen()) ? a.einbauKennzeichen()
                    : a.einbauKennzeichen() + " (" + a.kennzeichen() + ")";
            aus.add(zeile("bewertung_messplanung", "messmittel_angabe", a.einbauKennzeichen(),
                    "Messmittel " + einbau + ": " + b.bezeichnung(), null, null, name(b.person()),
                    tag(b.zeitpunkt(), zone), b.sha256(), "verweis", b.ablage() == null ? b.bezeichnung() : b.ablage()));
        }
    }

    // ------------------------------------------------------------------ AP-11, AP-17

    private void kennzahlen(List<Map<String, Object>> aus, ZoneId zone) {
        var basen = new ArrayList<Map<String, Object>>();
        for (var k : kennzahlen.liste().kennzahlen()) {
            for (var f : kennzahlen.fassungen(k.id()).fassungen()) {
                // Tag ist der Eintrag der Fassung — die erste gilt „von Anfang an“ und trägt kein gilt ab.
                if (f.aufgehobenAm() != null) continue;
                aus.add(zeile("kennzahlen_bezugsbasen", "kennzahl_fassung", k.kennzeichen(), k.name(), f.nummer(),
                        null, f.eingetragenVon() == null ? null : f.eingetragenVon().name(),
                        tag(f.eingetragenAm(), zone), null));
            }
            for (var b : bezugsbasen.liste(k.id()).bezugsbasen()) {
                for (var kurz : b.fassungen()) {
                    if (!"freigegeben".equals(kurz.freigabeStatus())) continue;
                    BezugsbasisDto.Fassung f = bezugsbasen.fassung(k.id(), b.id(), kurz.fassung());
                    String freigabe = f.freigabe() == null ? null : f.freigabe().name();
                    String entscheidung = f.vieraugen() && f.entscheidung() != null ? f.entscheidung().name() : null;
                    basen.add(zeile("kennzahlen_bezugsbasen", "bezugsbasis_fassung", b.kennzeichen(),
                            "Bezugsbasis " + b.kennzeichen() + " (" + k.kennzeichen() + ")", kurz.fassung(),
                            entscheidung != null && !entscheidung.equals(freigabe) ? entscheidung : null, freigabe,
                            tag(f.freigegebenAm(), zone), f.pruefsumme()));
                }
            }
        }
        aus.addAll(basen);
    }

    // ------------------------------------------------------------------ AP-12 (mit AP-16/AP-17-Vorlagen)

    private void berichte(List<Map<String, Object>> aus, ZoneId zone) {
        var wer = ProtokollAkteur.aus(SecurityContextHolder.getContext().getAuthentication()).orElse(null);
        if (wer == null) return;
        List<BerichtService.Uebersicht> liste;
        try {
            liste = berichte.liste(wer);
        } catch (BerichtAbgelehnt keinBericht) {
            return; // Der Aufrufer liest nirgends einen Bericht — das Verzeichnis zeigt ihm keinen.
        }
        for (var u : liste) {
            var kopf = u.kopf();
            if (BerichtRegeln.MANAGEMENTBEWERTUNG.equals(kopf.vorlage())) {
                continue; // AP-19 IP-23: mit „entschieden von“ der Leitung in ManagementbewertungVerzeichnis
            }
            String gruppe = switch (kopf.vorlage()) {
                case "energetische_bewertung" -> "bewertung_messplanung";
                case "leistungsvergleich" -> "kennzahlen_bezugsbasen";
                default -> "berichte";
            };
            for (var s : berichte.detail(kopf.kennung(), wer).staende()) {
                aus.add(zeile(gruppe, "berichtsstand", kopf.kennung(), kopf.geltungName() + " · " + kopf.schluessel(),
                        s.nr(), null, s.freigeberName(), tag(s.freigegebenAm(), zone), s.pruefsumme()));
            }
        }
    }

    // ------------------------------------------------------------------ AP-18

    private void verbesserung(List<Map<String, Object>> aus, ZoneId zone) {
        for (var z : energieziele.liste(List.of(), null, null).energieziele()) {
            var b = z.bewertung();
            if (b == null || !"bewertet".equals(b.status())) continue;
            String eingetragen = b.person() == null ? null : b.person().name();
            String entschieden = b.vieraugen() && b.entscheidung() != null ? b.entscheidung().name() : null;
            aus.add(zeile("ziele_massnahmen_abweichungen", "energieziel_bewertung", z.kennzeichen(), z.wortlaut(),
                    null, entschieden != null && !entschieden.equals(eingetragen) ? entschieden : null, eingetragen,
                    tag(entschieden != null && b.entschiedenAm() != null ? b.entschiedenAm() : b.am(), zone),
                    b.pruefsumme()));
        }
        for (var m : massnahmen.liste(List.of(), null, null, null, null).massnahmen()) {
            for (var b : massnahmeBewertung.liste(m.id()).bewertungen()) {
                if (!"bewertet".equals(b.status())) continue;
                String eingetragen = b.person() == null ? null : b.person().name();
                String entschieden = b.vieraugen() && b.entscheidung() != null ? b.entscheidung().name() : null;
                aus.add(zeile("ziele_massnahmen_abweichungen", "massnahme_bewertung", m.kennzeichen(), m.titel(),
                        b.standNr(), entschieden != null && !entschieden.equals(eingetragen) ? entschieden : null,
                        eingetragen, tag(entschieden != null && b.entschiedenAm() != null ? b.entschiedenAm() : b.am(),
                                zone), b.pruefsumme()));
            }
        }
        for (var a : abweichungen.liste(List.of(), null, null, null).abweichungen()) {
            var s = a.abschluss();
            if (s == null) continue;
            aus.add(zeile("ziele_massnahmen_abweichungen", "abweichung_abschluss", a.kennzeichen(),
                    "Abweichung " + a.kennzeichen() + " (" + a.kennzahl().kennzeichen() + ")", null, null, s.person(),
                    s.am(), null));
        }
    }

    // ------------------------------------------------------------------ Zeile

    /** Alles, was VoltPilot selbst lenkt, liegt „in VoltPilot“ — ohne Ablage (G1). */
    private static Map<String, Object> zeile(String gruppe, String art, String kennzeichen, String titel, Integer nr,
            String entschiedenVon, String eingetragenVon, LocalDate tag, String pruefsumme) {
        return zeile(gruppe, art, kennzeichen, titel, nr, entschiedenVon, eingetragenVon, tag, pruefsumme,
                "in_voltpilot", null);
    }

    /** G1 mit Ort: ein Verweis („Geführt in Ihrem System“) nennt seine Ablage. */
    private static Map<String, Object> zeile(String gruppe, String art, String kennzeichen, String titel, Integer nr,
            String entschiedenVon, String eingetragenVon, LocalDate tag, String pruefsumme, String ort, String ablage) {
        Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(new EnergiemanagementRegeln.VerzeichnisEingang(
                gruppe, art, kennzeichen, titel, nr, entschiedenVon, eingetragenVon, tag == null ? null : tag.toString(),
                pruefsumme, ort, ablage));
        if (zeile.containsKey("fehler")) {
            throw new IllegalStateException("Verzeichnis-Zeile von " + kennzeichen + ": " + zeile.get("fehler"));
        }
        return zeile;
    }

    /** DK4 sinngemäß: eine Fassung, die ihre Nachfolgerin am Stichtag schon abgelöst hat, sagt es im Titel. */
    private static String abgeloest(String titel, Instant aufgehobenAm, ZoneId zone, LocalDate stichtag) {
        LocalDate am = tag(aufgehobenAm, zone);
        return am == null || am.isAfter(stichtag) ? titel
                : titel + " — abgelöst am " + am.format(TAG);
    }

    /** G2: die zweite Person — nur, wo sie eine andere ist als die, die eingetragen hat. */
    private static String zweite(ProtokollAkteur eingetragen, ProtokollAkteur entschieden) {
        String e = name(entschieden);
        return e == null || e.equals(name(eingetragen)) ? null : e;
    }

    private static String name(ProtokollAkteur a) {
        return a == null ? null : a.name();
    }

    private static LocalDate tag(Instant am, ZoneId zone) {
        return am == null ? null : am.atZone(zone).toLocalDate();
    }

    private static LocalDate tag(OffsetDateTime am, ZoneId zone) {
        return am == null ? null : am.atZoneSameInstant(zone).toLocalDate();
    }
}
