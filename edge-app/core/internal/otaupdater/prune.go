package otaupdater

// Das Aufraeumen abgeloester Abbilder - die WIRKUNG.
//
// Die REGEL steht rein und docker-frei in [otaapply.PlanPrune]; hier stehen
// nur die docker-Verben und das Einsammeln der Eingaben. Der Schritt haengt
// bewusst am ENDE eines BESTAETIGTEN Tausches (siehe [Engine.commit]) - nie
// vorher, nie mitten drin: solange ein Vorgang laeuft, ist jedes Abbild
// potenziell das Rueckfallziel.
//
// **Er ist NICHT-FATAL, in jedem einzelnen Schritt.** Ein Update darf nie an
// der Reinigung scheitern: die Reinigung ist die Kuer, der Tausch die Pflicht.
// Umgekehrt gilt: was nicht sicher entschieden werden kann, wird nicht
// entfernt - eine unvollstaendige Sicht auf die laufenden Container fuehrt zum
// Abbruch des Aufraeumens, nicht zu einem Rateschluss.

import (
	"context"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
)

// imagesFormat liefert je Zeile EINEN Namen eines lokalen Abbildes.
const imagesFormat = "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.CreatedAt}}"

// createdLayouts sind die Formate, in denen `docker images` seine Bau-Zeit
// meldet. Was keines davon trifft, gilt als „unbekannt" - und unbekannt gilt
// in der Regel als NEU, also als eher aufzuheben.
var createdLayouts = []string{
	"2006-01-02 15:04:05 -0700 MST",
	"2006-01-02 15:04:05 -0700",
	time.RFC3339,
}

// listImages liefert die lokalen Abbilder EINES Repositories.
func (d *docker) listImages(ctx context.Context, repo string) ([]otaapply.ImageRecord, error) {
	out, err := d.run.Run(ctx, "docker", "images", "--no-trunc", "--digests",
		"--format", imagesFormat, repo)
	if err != nil {
		return nil, err
	}
	var recs []otaapply.ImageRecord
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, "\t")
		for len(f) < 5 {
			f = append(f, "")
		}
		rec := otaapply.ImageRecord{
			ID:     strings.TrimSpace(f[0]),
			Repo:   dockerValue(f[1]),
			Tag:    dockerValue(f[2]),
			Digest: dockerValue(f[3]),
		}
		if rec.ID == "" {
			continue
		}
		rec.Created = parseDockerTime(f[4])
		recs = append(recs, rec)
	}
	return recs, nil
}

// containerImageIDs sind die Abbild-Kennungen JEDES Containers - laufend ODER
// gestoppt. Der gestoppte Halter des Rueckfall-Images ist damit abgedeckt,
// ohne dass es dafuer eine Sonderregel braucht.
//
// Ein Fehler ist hier bewusst KEIN „dann eben leer": eine luckenhafte Sicht
// koennte genau das Abbild uebersehen, das noch gebraucht wird.
func (d *docker) containerImageIDs(ctx context.Context) ([]string, error) {
	out, err := d.run.Run(ctx, "docker", "ps", "-aq", "--no-trunc")
	if err != nil {
		return nil, err
	}
	ids := nonEmptyLines(out)
	if len(ids) == 0 {
		return nil, nil
	}
	args := append([]string{"inspect", "--format", "{{.Image}}"}, ids...)
	out, err = d.run.Run(ctx, "docker", args...)
	if err != nil {
		return nil, err
	}
	return nonEmptyLines(out), nil
}

// removeImage haengt EINEN Namen ab. Bewusst ohne `-f`: docker verweigert die
// Loeschung, solange ein Container das Abbild haelt - eine dritte
// Sicherungsebene, die ein `-f` gerade aushebeln wuerde.
func (d *docker) removeImage(ctx context.Context, ref string) error {
	_, err := d.run.Run(ctx, "docker", "image", "rm", ref)
	return err
}

// pruneSuperseded entfernt die Abbilder abgeloester Releases.
//
// Aufgerufen wird sie AUSSCHLIESSLICH aus [Engine.commit], also nach einem
// bestandenen Selbsttest und nachdem das Rueckfallziel auf den neuen,
// bewiesenen Stand gehoben wurde. Sie gibt nichts zurueck: kein Ausgang dieses
// Schrittes darf einen bestaetigten Tausch nachtraeglich in Frage stellen.
func (e *Engine) pruneSuperseded(ctx context.Context, p *otaapply.PendingConfirm, lkg otaapply.LKG) {
	policy := otaapply.ResolvePrunePolicy(e.o.DataDir, e.o.Prune)
	if !policy.Enabled {
		e.o.Log.Info("OTA: abgeloeste Abbilder werden nicht aufgeraeumt", "quelle", policy.Source)
		return
	}

	repos := prunableRepos(p.Target, p.Previous, lkg)
	if len(repos) == 0 {
		return
	}
	var images []otaapply.ImageRecord
	for _, repo := range repos {
		recs, err := e.d.listImages(ctx, repo)
		if err != nil {
			e.o.Log.Warn("OTA: die Abbilder von '"+repo+"' sind nicht auflistbar - "+
				"es wird nichts aufgeraeumt", "err", err)
			return
		}
		images = append(images, recs...)
	}
	inUse, err := e.d.containerImageIDs(ctx)
	if err != nil {
		e.o.Log.Warn("OTA: die belegten Abbilder sind nicht feststellbar - "+
			"es wird nichts aufgeraeumt", "err", err)
		return
	}

	plan := otaapply.PlanPrune(otaapply.PruneInput{
		Policy:     policy,
		Images:     images,
		InUse:      inUse,
		Protected:  e.protectedImageIDs(ctx, p, lkg),
		Superseded: e.resolveIDs(ctx, previousRefs(p.Previous)),
	})
	if plan.Skipped != "" {
		e.o.Log.Info("OTA: " + plan.Skipped)
		return
	}
	if len(plan.Remove) == 0 {
		e.o.Log.Info("OTA: keine abgeloesten Abbilder zu entfernen",
			"aufgehoben_je_repository", policy.KeepReleases)
		return
	}

	removed, failed := 0, 0
	for _, r := range plan.Remove {
		if err := e.d.removeImage(ctx, r.Ref); err != nil {
			// Nicht-fatal und einzeln: ein Name, den docker nicht hergibt
			// (etwa weil doch ein Container daran haengt), haelt die uebrigen
			// nicht auf.
			failed++
			e.o.Log.Warn("OTA: ein abgeloestes Abbild konnte nicht entfernt werden",
				"abbild", r.Ref, "err", err)
			continue
		}
		removed++
	}
	e.o.Log.Info("OTA: abgeloeste Abbilder entfernt", "entfernt", removed,
		"fehlgeschlagen", failed, "aufgehoben", len(plan.Keep),
		"aufgehoben_je_repository", policy.KeepReleases, "quelle", policy.Source)
}

// protectedImageIDs sind die Kennungen, die ueber die Container-Bindung hinaus
// ausdruecklich geschuetzt werden.
//
// Drei Quellen, jede mit eigener Begruendung:
//
//   - das ZIEL des gerade bestaetigten Tausches (es laeuft, ist also ohnehin
//     gebunden - hier nur Guerteltier);
//   - das RUECKFALLZIEL mit seinem `:lkg`-Tag (der Halter deckt es ab, aber ein
//     fehlender Halter darf nicht zum Verlust der Rueckfallebene fuehren);
//   - die aktuell abgelegte ZUWEISUNG, falls sie sich waehrend des Tausches
//     geaendert hat und ihre Abbilder schon vorab geholt wurden. Genau dieses
//     vorab geholte naechste Ziel naehme ein pauschales `image prune -a` mit.
func (e *Engine) protectedImageIDs(ctx context.Context, p *otaapply.PendingConfirm,
	lkg otaapply.LKG) []string {
	var refs []string
	for _, ref := range p.Target {
		refs = append(refs, ref)
	}
	for _, img := range lkg.Images {
		refs = append(refs, img.Digest, img.Ref, img.Tag)
	}
	for _, img := range p.Previous.Images {
		// NUR der Tag: der Vorgaenger-DIGEST ist ausdruecklich Kandidat (er ist
		// die Kulanz-Rangfolge, nicht der Schutz), sein `:lkg`-Tag zeigt nach
		// dem Bestaetigen ohnehin auf den neuen Stand.
		refs = append(refs, img.Tag)
	}
	refs = append(refs, e.assignedTargetRefs()...)
	return e.resolveIDs(ctx, refs)
}

// assignedTargetRefs sind die Artefakte der AKTUELL abgelegten Zuweisung -
// aber nur, wenn ihre Signaturkette haelt.
//
// Die Reihenfolge des Hauses gilt auch hier: erst pruefen, dann parsen. Haelt
// die Kette nicht, gibt es nichts zu schuetzen (ein Release, das dieses Geraet
// nie anwenden wird, braucht seine Abbilder nicht).
func (e *Engine) assignedTargetRefs() []string {
	env, err := otaapply.LoadTarget(e.o.DataDir)
	if err != nil || env == nil {
		return nil
	}
	verdict := e.verify(env.Manifest, env.Signature, e.coreSignal(), e.o.Now())
	if verdict.Manifest == nil {
		return nil
	}
	var refs []string
	for _, ref := range otaapply.TargetRefs(verdict.Manifest) {
		refs = append(refs, ref)
	}
	return refs
}

// resolveIDs loest Referenzen zu lokalen Abbild-Kennungen auf. Was es nicht
// (mehr) gibt, wird uebergangen - ein fehlendes Abbild ist hier ein normaler
// Zustand, kein Fehler.
func (e *Engine) resolveIDs(ctx context.Context, refs []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" || seen[ref] {
			continue
		}
		seen[ref] = true
		id, err := e.d.imageID(ctx, ref)
		if err != nil || strings.TrimSpace(id) == "" {
			continue
		}
		out = append(out, strings.TrimSpace(id))
	}
	return out
}

// prunableRepos sind die Repositories, die dieses Geraet SELBST getauscht hat.
//
// Sie sind die ganze Kandidatenmenge - und damit die Zusage, dass ein von
// aussen abgelegtes Abbild (tools/pki, Pruefstand, ein fremder Container auf
// derselben Box) nie in die Naehe des Aufraeumers kommt. Der Sidecar selbst
// steht hier nicht: sein Repository taucht in keinem Tausch-Ziel auf, weil
// [otaapply.TargetRefs] ihn auslaesst - seine alten Abbilder bleiben also
// liegen. Das ist die vorsichtige Richtung.
func prunableRepos(target map[string]string, previous, lkg otaapply.LKG) []string {
	seen := map[string]bool{}
	var out []string
	add := func(ref string) {
		repo := imageRepo(ref)
		if repo == "" || strings.HasPrefix(repo, otaapply.LKGTagPrefix) || seen[repo] {
			return
		}
		seen[repo] = true
		out = append(out, repo)
	}
	for _, ref := range target {
		add(ref)
	}
	for _, set := range []otaapply.LKG{previous, lkg} {
		for _, img := range set.Images {
			add(img.Digest)
			add(img.Ref)
		}
	}
	return out
}

// previousRefs sind die Referenzen des zuletzt abgeloesten Standes.
func previousRefs(previous otaapply.LKG) []string {
	var out []string
	for _, img := range previous.Images {
		out = append(out, img.Digest, img.Ref)
	}
	return out
}

// imageRepo trennt das Repository von Tag oder Digest ab.
//
// Der Doppelpunkt einer Registry mit Port (`host:5000/pfad`) ist KEIN
// Tag-Trenner - deshalb wird nur getrennt, wenn hinter dem letzten
// Doppelpunkt kein `/` mehr steht.
func imageRepo(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	if i := strings.Index(ref, "@"); i > 0 {
		return ref[:i]
	}
	if i := strings.LastIndex(ref, ":"); i > 0 && !strings.Contains(ref[i+1:], "/") {
		return ref[:i]
	}
	return ref
}

func dockerValue(s string) string {
	s = strings.TrimSpace(s)
	if s == "<none>" || s == "<none>:<none>" {
		return ""
	}
	return s
}

func parseDockerTime(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	for _, layout := range createdLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if v := strings.TrimSpace(line); v != "" {
			out = append(out, v)
		}
	}
	return out
}
