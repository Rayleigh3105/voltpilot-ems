package main

// maxRSSKB: darwin reports ru_maxrss in bytes.
func maxRSSKB[T int32 | int64](v T) int64 { return int64(v) / 1024 }
