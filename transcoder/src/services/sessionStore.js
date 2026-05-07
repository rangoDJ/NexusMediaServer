// In-memory map of active transcode sessions.
// Each value: { ffmpegProcess, outputDir, status }
export const sessionStore = new Map()
