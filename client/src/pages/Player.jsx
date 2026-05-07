import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { api } from '../api/client.js'

export default function Player({ mediaItemId, episodeId }) {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const [sessionId, setSessionId] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function startStream() {
      try {
        const { data } = await api.post('/stream/start', {
          media_item_id: mediaItemId ?? undefined,
          episode_id: episodeId ?? undefined,
          codec: 'h264',
          resolution: '1080p'
        })
        if (cancelled) return
        setSessionId(data.session_id)

        const video = videoRef.current
        if (Hls.isSupported()) {
          const hls = new Hls()
          hlsRef.current = hls
          hls.loadSource(data.playlist_url)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play())
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = data.playlist_url
          video.play()
        }
      } catch (e) {
        setError(e.message)
      }
    }

    startStream()
    return () => {
      cancelled = true
      hlsRef.current?.destroy()
    }
  }, [mediaItemId, episodeId])

  // Clean up session on unmount
  useEffect(() => {
    return () => {
      if (sessionId) api.delete(`/stream/${sessionId}`).catch(() => {})
    }
  }, [sessionId])

  if (error) return <div>Error: {error}</div>

  return (
    <video
      ref={videoRef}
      controls
      style={{ width: '100%', backgroundColor: '#000' }}
    />
  )
}
