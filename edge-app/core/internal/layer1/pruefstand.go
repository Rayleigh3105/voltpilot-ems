//go:build pruefstand

package layer1

// The bench build: `go build -tags pruefstand ./cmd/vp-edge-light`. It opens
// the Edge Light release for every family so the captain can run First-Light
// and the bench cases with the Go executor - on the bench device only. It is
// never released (edge-light/scripts/test.sh checks the release program).
func init() { pruefstandBuild.Store(true) }
