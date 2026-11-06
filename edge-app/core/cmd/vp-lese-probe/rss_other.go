//go:build !darwin

package main

// maxRSSKB: Linux reports ru_maxrss in kilobytes.
func maxRSSKB[T int32 | int64](v T) int64 { return int64(v) }
