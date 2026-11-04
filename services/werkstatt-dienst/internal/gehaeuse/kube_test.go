package gehaeuse

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// apiAttrappe spielt die Kubernetes-API für Jobs und Pods in einem Namespace.
type apiAttrappe struct {
	mu        sync.Mutex
	job       map[string]any
	geloescht []string
	abrufe    int
	token     string
	// was der Job nach dem wievielten Abruf meldet
	stand       func(abruf int) string // "", "Complete", "Failed"
	podGrund    string
	anlegen     int // HTTP-Status beim Anlegen
	beimAnlegen func(job map[string]any)
}

func (a *apiAttrappe) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+a.token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	const jobs = "/apis/batch/v1/namespaces/werkstatt-prod/jobs"
	switch {
	case r.Method == http.MethodPost && r.URL.Path == jobs:
		if a.anlegen != 0 {
			w.WriteHeader(a.anlegen)
			_, _ = w.Write([]byte(`{"kind":"Status","message":"jobs.batch is forbidden: User \"system:serviceaccount:werkstatt-prod:werkstatt-dienst\" cannot create resource"}`))
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&a.job)
		if a.beimAnlegen != nil {
			a.beimAnlegen(a.job)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{}`))
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, jobs+"/"):
		a.abrufe++
		s := a.stand(a.abrufe)
		cond := `[]`
		if s != "" {
			cond = `[{"type":"` + s + `","status":"True","reason":"BackoffLimitExceeded","message":"Job has reached the specified backoff limit"}]`
		}
		_, _ = w.Write([]byte(`{"status":{"conditions":` + cond + `}}`))
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/namespaces/werkstatt-prod/pods":
		if !strings.HasPrefix(r.URL.Query().Get("labelSelector"), "job-name=gehaeuse-") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		warten := `null`
		if a.podGrund != "" {
			warten = `{"reason":"` + a.podGrund + `","message":"pull access denied"}`
		}
		_, _ = w.Write([]byte(`{"items":[{"status":{"containerStatuses":[{"state":{"waiting":` + warten + `}}]}}]}`))
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, jobs+"/"):
		a.geloescht = append(a.geloescht, strings.TrimPrefix(r.URL.Path, jobs+"/"))
		_, _ = w.Write([]byte(`{}`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func kubeMit(t *testing.T, a *apiAttrappe, ablage string) *Kube {
	t.Helper()
	srv := httptest.NewTLSServer(a)
	t.Cleanup(srv.Close)
	a.token = "token-1"
	return &Kube{API: srv.URL, HTTP: srv.Client(), Token: func() (string, error) { return a.token, nil },
		Namespace: "werkstatt-prod", Image: "git.example.test/werkstatt-gehaeuse@sha256:" + strings.Repeat("ab", 32),
		PVC: "werkstatt-gehaeuse", Ablage: ablage, PullSecret: "forgejo-registry", Frist: 20 * time.Minute,
		Takt: 5 * time.Millisecond, Log: stumm}
}

func feld(t *testing.T, v any, pfad ...any) any {
	t.Helper()
	for _, p := range pfad {
		switch k := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				t.Fatalf("%v: kein Objekt bei %q", pfad, k)
			}
			v = m[k]
		case int:
			l, ok := v.([]any)
			if !ok || len(l) <= k {
				t.Fatalf("%v: keine Liste bei %d", pfad, k)
			}
			v = l[k]
		}
	}
	return v
}

func TestJobBautMitEingehaengtemUnterordnerUnterRestricted(t *testing.T) {
	ablage := t.TempDir()
	ziel := filepath.Join(ablage, refA, "bau")
	_ = os.MkdirAll(ziel, 0o770)
	a := &apiAttrappe{stand: func(n int) string {
		if n < 3 {
			return ""
		}
		return "Complete"
	}}
	// Der Pod schreibt in den eingehängten Unterordner der Ablage.
	a.beimAnlegen = func(map[string]any) { schreibeBau(t, ziel, refA) }
	k := kubeMit(t, a, ablage)
	var job string
	if err := k.Baue(context.Background(), refA, ziel, func(j string) { job = j }); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(job, "gehaeuse-edge-k7m2xq3-") || len(job) > 63 {
		t.Errorf("Job-Name %q", job)
	}
	j := a.job
	pod := feld(t, j, "spec", "template", "spec")
	c := feld(t, pod, "containers", 0)
	for _, f := range []struct {
		pfad []any
		want any
	}{
		{[]any{"spec", "backoffLimit"}, 0.0},
		{[]any{"spec", "activeDeadlineSeconds"}, 1200.0},
		{[]any{"metadata", "labels", "app.kubernetes.io/name"}, "werkstatt-gehaeuse"},
		{[]any{"spec", "template", "spec", "automountServiceAccountToken"}, false},
		{[]any{"spec", "template", "spec", "nodeSelector", "kubernetes.io/arch"}, "amd64"},
		{[]any{"spec", "template", "spec", "securityContext", "runAsNonRoot"}, true},
		{[]any{"spec", "template", "spec", "securityContext", "seccompProfile", "type"}, "RuntimeDefault"},
		{[]any{"spec", "template", "spec", "imagePullSecrets", 0, "name"}, "forgejo-registry"},
		{[]any{"spec", "template", "spec", "volumes", 0, "persistentVolumeClaim", "claimName"}, "werkstatt-gehaeuse"},
	} {
		if got := feld(t, j, f.pfad...); got != f.want {
			t.Errorf("%v = %v, want %v", f.pfad, got, f.want)
		}
	}
	for _, f := range []struct {
		pfad []any
		want any
	}{
		{[]any{"image"}, k.Image},
		{[]any{"args", 0}, refA},
		{[]any{"securityContext", "allowPrivilegeEscalation"}, false},
		{[]any{"securityContext", "readOnlyRootFilesystem"}, true},
		{[]any{"securityContext", "capabilities", "drop", 0}, "ALL"},
		{[]any{"volumeMounts", 0, "mountPath"}, ImBild},
		{[]any{"volumeMounts", 0, "subPath"}, refA + "/bau"},
		{[]any{"resources", "limits", "memory"}, "4Gi"},
	} {
		if got := feld(t, c, f.pfad...); got != f.want {
			t.Errorf("Container %v = %v, want %v", f.pfad, got, f.want)
		}
	}
	if len(a.geloescht) != 0 {
		t.Errorf("ein fertiger Job räumt sich selbst (ttlSecondsAfterFinished), gelöscht: %v", a.geloescht)
	}
}

func TestGescheiterterJobNenntDenGrund(t *testing.T) {
	ablage := t.TempDir()
	a := &apiAttrappe{stand: func(int) string { return "Failed" }}
	k := kubeMit(t, a, ablage)
	err := k.Baue(context.Background(), refA, filepath.Join(ablage, refA, "bau"), func(string) {})
	if err == nil || !strings.Contains(err.Error(), "Job gescheitert (BackoffLimitExceeded)") {
		t.Fatalf("err = %v", err)
	}
}

func TestBildNichtLadbarEndetSofortUndLoeschtDenJob(t *testing.T) {
	ablage := t.TempDir()
	a := &apiAttrappe{stand: func(int) string { return "" }, podGrund: "ErrImagePull"}
	k := kubeMit(t, a, ablage)
	var job string
	err := k.Baue(context.Background(), refA, filepath.Join(ablage, refA, "bau"), func(j string) { job = j })
	if err == nil || !strings.Contains(err.Error(), "Bau-Image: ErrImagePull: pull access denied") {
		t.Fatalf("err = %v", err)
	}
	if len(a.geloescht) != 1 || a.geloescht[0] != job {
		t.Errorf("gelöscht: %v, Job %s", a.geloescht, job)
	}
}

func TestAbbruchLoeschtDenJobDamitNieZweiBauen(t *testing.T) {
	ablage := t.TempDir()
	// Abbruch nach Ereignis statt nach Uhr: Der erste Umlauf (Job lesen, Pod
	// lesen) ist durch, beim zweiten Lesen des Jobs bricht der Aufrufer ab.
	// Eine feste Frist von wenigen ms lief unter -race schon im TLS-Handschlag
	// des Anlegens ab.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := &apiAttrappe{stand: func(abruf int) string {
		if abruf >= 2 {
			cancel()
		}
		return ""
	}, podGrund: "ContainerCreating"}
	k := kubeMit(t, a, ablage)
	err := k.Baue(ctx, refA, filepath.Join(ablage, refA, "bau"), func(string) {})
	if err == nil || !strings.Contains(err.Error(), "zuletzt: Pod wartet: ContainerCreating") {
		t.Fatalf("err = %v", err)
	}
	if len(a.geloescht) != 1 {
		t.Errorf("gelöscht: %v", a.geloescht)
	}
}

func TestOhneRechtSagtDerFehlerWelches(t *testing.T) {
	ablage := t.TempDir()
	a := &apiAttrappe{stand: func(int) string { return "" }, anlegen: http.StatusForbidden}
	k := kubeMit(t, a, ablage)
	err := k.Baue(context.Background(), refA, filepath.Join(ablage, refA, "bau"), func(string) {})
	if err == nil || !strings.Contains(err.Error(), "Role werkstatt-dienst-gehaeuse") || !strings.Contains(err.Error(), "cannot create resource") {
		t.Fatalf("err = %v", err)
	}
	if err := (&Kube{Ablage: ablage}).Baue(context.Background(), refA, t.TempDir(), func(string) {}); err == nil {
		t.Error("ein Ziel außerhalb der Ablage ließe sich nicht einhängen")
	}
}
