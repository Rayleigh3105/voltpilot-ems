package otaupdater

// Die docker-Verben, die der Sidecar kennt - jedes einzeln, jedes ueber den
// [Runner], keines mit versteckter Politik.

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

type docker struct {
	run         Runner
	projectDir  string
	composeArgs []string
}

func newDocker(run Runner, projectDir string, composeFiles []string) *docker {
	args := []string{"compose", "--project-directory", projectDir}
	for _, f := range composeFiles {
		// `-f` wird gegen das ARBEITSVERZEICHNIS des Aufrufers aufgeloest, NICHT
		// gegen --project-directory. Im Sidecar-Container ist das `/`, ein
		// relativ genannter Dateiname landete also bei `/docker-compose.yml` und
		// jeder compose-Aufruf scheiterte (in der Matrix aufgefallen). Der
		// Betreiber nennt die Dateien so, wie sie im Deploy-Verzeichnis heissen -
		// also werden sie genau dorthin aufgeloest.
		if !filepath.IsAbs(f) {
			f = filepath.Join(projectDir, f)
		}
		args = append(args, "-f", f)
	}
	return &docker{run: run, projectDir: projectDir, composeArgs: args}
}

// pull holt EIN digest-gepinntes Image.
func (d *docker) pull(ctx context.Context, ref string) error {
	_, err := d.run.Run(ctx, "docker", "pull", ref)
	return err
}

// repoDigests liefert die Registry-Digests EINES lokalen Images.
func (d *docker) repoDigests(ctx context.Context, ref string) ([]string, error) {
	out, err := d.run.Run(ctx, "docker", "image", "inspect",
		"--format", "{{json .RepoDigests}}", ref)
	if err != nil {
		return nil, err
	}
	var digests []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &digests); err != nil {
		return nil, fmt.Errorf("die Digest-Liste von '%s' ist nicht lesbar: %w", ref, err)
	}
	return digests, nil
}

// verifyPulled prueft, dass das lokal vorliegende Image WIRKLICH die Bytes des
// verlangten Digests sind.
//
// Das ist keine Formalitaet: die Signatur nagelt den Digest fest, aber sie
// sagt nichts darueber, was ein Pull tatsaechlich in den lokalen Speicher
// gelegt hat. Erst dieser Abgleich schliesst die Kette vom Manifest bis zu den
// Bytes, die gleich als Container starten.
func (d *docker) verifyPulled(ctx context.Context, ref string) error {
	digests, err := d.repoDigests(ctx, ref)
	if err != nil {
		return err
	}
	for _, d := range digests {
		if d == ref {
			return nil
		}
	}
	return fmt.Errorf("das geladene Image traegt nicht den verlangten Digest "+
		"(verlangt '%s', vorhanden %v) - es wird nichts getauscht", ref, digests)
}

// imageID liefert die lokale Image-Kennung einer Referenz.
func (d *docker) imageID(ctx context.Context, ref string) (string, error) {
	out, err := d.run.Run(ctx, "docker", "image", "inspect", "--format", "{{.Id}}", ref)
	return strings.TrimSpace(out), err
}

func (d *docker) tag(ctx context.Context, src, dst string) error {
	_, err := d.run.Run(ctx, "docker", "tag", src, dst)
	return err
}

func (d *docker) save(ctx context.Context, ref, path string) error {
	_, err := d.run.Run(ctx, "docker", "save", "-o", path, ref)
	return err
}

func (d *docker) load(ctx context.Context, path string) error {
	_, err := d.run.Run(ctx, "docker", "load", "-i", path)
	return err
}

// holdImage legt einen GESTOPPTEN Container an, der das uebergebene Image
// referenziert.
//
// **Das ist der Mechanismus, mit dem das Rueckfall-Image `docker system
// prune -a` ueberlebt.** `prune -a` raeumt jedes Image weg, auf das kein
// Container zeigt - ein blosser `:lkg`-Tag genuegt also nicht. Ein Container
// zaehlt, auch ein nie gestarteter. Er wird deshalb `create`d und NIE
// gestartet: er verbraucht kein RAM, keine CPU und keinen Port, er haelt nur
// eine Referenz.
func (d *docker) holdImage(ctx context.Context, name, image string) error {
	_, _ = d.run.Run(ctx, "docker", "rm", "-f", name)
	_, err := d.run.Run(ctx, "docker", "create", "--name", name, image)
	return err
}

// composeUp startet GENAU EINEN Dienst neu.
//
// `--pull never` ist tragend, nicht Geschmack: die Images wurden vorher
// ausdruecklich geholt UND gegen ihren Digest geprueft. Ein zweiter Pull
// waere bestenfalls doppelte Arbeit - und beim ZURUECKNEHMEN waere er ein
// Fehler, denn ein Rueckfall muss ohne Registry funktionieren (die Registry
// kann genau der Grund sein, aus dem gerade etwas schiefgeht).
func (d *docker) composeUp(ctx context.Context, service string) error {
	args := append(append([]string{}, d.composeArgs...),
		"up", "-d", "--pull", "never", "--no-deps", service)
	_, err := d.run.Run(ctx, "docker", args...)
	return err
}

// containerID liefert die Container-Kennung eines Dienstes ("" = keiner).
func (d *docker) containerID(ctx context.Context, service string) (string, error) {
	args := append(append([]string{}, d.composeArgs...), "ps", "-q", service)
	out, err := d.run.Run(ctx, "docker", args...)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if s := strings.TrimSpace(line); s != "" {
			return s, nil
		}
	}
	return "", nil
}

// containerState ist die Beobachtung ueber EINEN laufenden Container.
type containerState struct {
	ImageID  string
	Running  bool
	Restarts int
	// Health ist "" wenn das Image keinen Healthcheck hat. Das ist KEIN
	// Befund - nur keine Aussage, und es wird auch nicht wie einer behandelt.
	Health string
}

const inspectFormat = "{{.Image}}\t{{.State.Running}}\t{{.RestartCount}}\t" +
	"{{if .State.Health}}{{.State.Health.Status}}{{end}}"

func (d *docker) inspect(ctx context.Context, cid string) (containerState, error) {
	out, err := d.run.Run(ctx, "docker", "inspect", "--format", inspectFormat, cid)
	if err != nil {
		return containerState{}, err
	}
	parts := strings.Split(strings.TrimRight(out, "\n"), "\t")
	for len(parts) < 4 {
		parts = append(parts, "")
	}
	restarts, _ := strconv.Atoi(strings.TrimSpace(parts[2]))
	return containerState{
		ImageID:  strings.TrimSpace(parts[0]),
		Running:  strings.TrimSpace(parts[1]) == "true",
		Restarts: restarts,
		Health:   strings.TrimSpace(parts[3]),
	}, nil
}
