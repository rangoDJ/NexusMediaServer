import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { api } from '../api/client.js'

export default function Player({ mediaItemId, episodeId }) {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const [sessionId, setSessionId] = useState(null)
  const [error, setError] = useState(null)
  const lastSaveRef = useRef(0)

  const progressPath = episodeId
    ? `/media/episode/${episodeId}/progress`
    : `/media/${mediaItemId}/progress`

  useEffect(() => {
    let cancelled = false
    let savedPosition = 0

    async function startStream() {
      try {
        // Load saved progress before starting stream so we can seek on MANIFEST_PARSED
        try {
          const { data: prog } = await api.get(progressPath)
          savedPosition = prog.position_secs ?? 0
        } catch {} // non-fatal

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
          const token = localStorage.getItem('nexus_token')
          const hls = new Hls({
            xhrSetup: (xhr) => {
              if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
            }
          })
          hlsRef.current = hls
          hls.loadSource(data.playlist_url)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (savedPosition > 5) video.currentTime = savedPosition
            video.play()
          })
          hls.on(Hls.Events.ERROR, (_, d) => {
            if (d.fatal) setError(`Stream error: ${d.details}`)
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS — append token as query param since XHR headers aren't injectable
          const url = new URL(data.playlist_url, window.location.origin)
          url.searchParams.set('token', localStorage.getItem('nexus_token') ?? '')
          video.src = url.toString()
          video.addEventListener('loadedmetadata', () => {
            if (savedPosition > 5) video.currentTime = savedPosition
            video.play()
          }, { once: true })
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

  // Periodic progress save (every 15s) + final save on unmount
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    function saveProgress() {
      if (!video.duration || video.currentTime < 2) return
      const pos = Math.floor(video.currentTime)
      const dur = Math.floor(video.duration)
      const completed = dur > 0 && pos / dur > 0.9
      api.put(progressPath, { position_secs: pos, duration_secs: dur, completed }).catch(() => {})
    }

    function onTimeUpdate() {
      const now = Date.now()
      if (now - lastSaveRef.current > 15_000) {
        lastSaveRef.current = now
        saveProgress()
      }
    }

    video.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      saveProgress()
    }
  }, [progressPath])

  // Clean up stream session on unmount
  useEffect(() => {
    return () => {
      if (sessionId) api.delete(`/stream/${sessionId}`).catch(() => {})
    }
  }, [sessionId])

  if (error) return <div style={{ color: '#e05555', padding: 16 }}>Error: {error}</div>

  return (
    <video
      ref={videoRef}
      controls
      style={{ width: '100%', height: '100%', backgroundColor: '#000', display: 'block' }}
    />
  )
}
