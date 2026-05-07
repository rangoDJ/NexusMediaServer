import { getSettings } from '../services/settingsCache.js'

// Mobile apps hit this first to discover server capabilities and configure themselves.
export default async function serverRoutes(app) {
  app.get('/info', async () => {
    const settings = await getSettings(app.db)
    const { rows: nodeRows } = await app.db.query(
      "SELECT COUNT(*) FROM transcoder_nodes WHERE is_enabled=true AND last_seen_at > now() - interval '2 minutes'"
    )

    return {
      name:                 settings['server.name'] ?? 'Nexus Media Server',
      version:              '1.0.0',
      api_version:          'v1',
      allow_registration:   settings['auth.allow_registration'] ?? true,
      transcoder_nodes_online: parseInt(nodeRows[0].count),
      capabilities: {
        // What this server can produce for streaming
        stream_protocols:   ['hls'],
        video_codecs:       ['h264', 'h265'],
        resolutions:        ['4k', '1080p', '720p', '480p', '360p'],
        // Client hints for direct-play decisions
        direct_play_formats: ['mp4', 'webm'],
        direct_play_codecs:  ['h264', 'aac', 'mp3'],
      },
    }
  })
}
