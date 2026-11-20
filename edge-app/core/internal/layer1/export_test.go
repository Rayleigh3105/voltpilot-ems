package layer1

// SetPruefstandForTest opens (true) or closes the Edge Light release like the
// bench build does - for the integration tests of package layer1_test only.
func SetPruefstandForTest(on bool) { pruefstandBuild.Store(on) }
